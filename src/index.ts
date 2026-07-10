/**
 * Second Brain — Cloudflare Worker
 * https://github.com/rahilp/second-brain-cloudflare
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { createEmbedding, createLLM } from "./providers";
import {
  applyModelSettingsPatch,
  embeddingFingerprintOf,
  emptyModelSettings,
  isDevLocalProvider,
  isMaskedSecret,
  promoteEmbeddingFingerprint,
  toPublicModelSettings,
  type ModelSettingsPatchBody,
} from "./settings/model-settings";
import {
  ensureSettingsTable,
  getEffectiveModelSettings,
  loadStoredModelSettings,
  overlayProviderEnvFromSettings,
  saveStoredModelSettings,
} from "./settings/store";
import { importEntries, parseImportPayload, type ImportMode } from "./import-entries";
import {
  bindTelemetryDb,
  aggregateTelemetryHour,
  ensureTelemetryTables,
  flushTelemetry,
  getTelemetryConfig,
  logMemoryEvent,
  logRequest,
  newTraceId,
  previewText,
  purgeOldTelemetry,
  percentile,
  normalizeTelemetryConfig,
  routeToOperation,
  runWithTelemetryAsync,
  DEFAULT_TELEMETRY_CONFIG,
  type TelemetryConfig,
} from "./telemetry";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  isOAuthAuthorizationServerWellKnown,
  isOAuthProtectedResourceWellKnown,
  jsonResponse as oauthJson,
  resourcePathFromProtectedWellKnown,
} from "./oauth/metadata";
import {
  resolvePublicOrigin,
  rewriteRequestPublicOrigin,
} from "./oauth/public-origin";

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  /**
   * Workers AI binding — used when external LLM/embedding env vars are not set.
   * Self-host provides a stub when only OpenAI-compatible APIs are configured.
   */
  AI: Ai;
  AUTH_TOKEN: string;
  OAUTH_KV: KVNamespace;
  VECTORIZE_GRACE_MS?: string;
  /** Set on Node self-host (`1`). */
  SELFHOST?: string;
  /** Required with EMBEDDING_PROVIDER=local-hash-dev for smoke tests only. */
  ALLOW_DEV_EMBEDDING?: string;
  /**
   * Public site origin for OAuth metadata (e.g. https://agent.mtzs.cloud).
   * Required behind reverse proxies so ChatGPT sees https issuer, not http://host:443.
   */
  PUBLIC_URL?: string;
  PUBLIC_BASE_URL?: string;
  /** OpenAI-compatible chat API (DeepSeek / MiniMax / MiMo / OpenAI). */
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_EXTRA_BODY?: string;
  /** OpenAI-compatible embeddings API (or TEI). Independent of LLM. */
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_PROVIDER?: string;
  EMBEDDING_DIM?: string;
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

function graceMs(env: Env): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const DUPLICATE_BLOCK_THRESHOLD = 0.95;
const DUPLICATE_FLAG_THRESHOLD = 0.85;
const CANDIDATE_SCORE_THRESHOLD = 0.45;
const TAG_BOOST_STEP = 0.15;
const TAG_BOOST_MAX = 1.5;
// Each net contradiction (win or loss) shifts a memory's effective importance by
// log1p(|net|) * this step, clamped to the [1,5] importance band. Tunable.
const CONTRADICTION_IMPORTANCE_STEP = 1.0;

// ─── Compression eligibility ──────────────────────────────────────────────────
// An entry is eligible for nightly digest compression only if it's low-importance,
// not proven-useful by recall, and not a contradiction survivor. Strictly more
// protective than the old `importance_score < 4` filter — it can only exempt MORE.
export const COMPRESSION_IMPORTANCE_THRESHOLD = 4;   // importance >= this → protected
export const COMPRESSION_MIN_RECALL = 2;             // recalled >= this many times → protected
export const COMPRESSION_MIN_AGE_MS = 60 * 86400000; // entries with fewer than COMPRESSION_MIN_RECALL recalls protected until this old (60 days)

// Returns a SQL boolean fragment for "this entry is eligible for compression".
// Contains exactly one `?` placeholder — bind `Date.now() - COMPRESSION_MIN_AGE_MS`.
// columnPrefix: "" for bare columns (compressTag), "entries." for json_each-joined queries.
export function compressionEligibilitySql(columnPrefix = ""): string {
  const p = columnPrefix;
  return `(${p}importance_score IS NULL OR ${p}importance_score < ${COMPRESSION_IMPORTANCE_THRESHOLD})
      AND (${p}recall_count = 0 OR (${p}recall_count < ${COMPRESSION_MIN_RECALL} AND ${p}created_at < ?))
      AND (${p}contradiction_wins IS NULL OR ${p}contradiction_wins = 0)`;
}

// ─── Chunking constants ───────────────────────────────────────────────────────

const CHUNK_MAX_CHARS = 1600;
const CHUNK_OVERLAP_CHARS = 200;

// ─── Token limits ─────────────────────────────────────────────────────────────

const CLASSIFY_MAX_TOKENS = 80;
const CONTRADICTION_MAX_TOKENS = 80;
const SMART_MERGE_MAX_TOKENS = 250;
const INSIGHT_MAX_TOKENS = 300;
const PATTERN_MAX_TOKENS = 100;
const DIGEST_MAX_TOKENS = 400;

// ─── Vectorize constants ──────────────────────────────────────────────────────

const VECTORIZE_TOP_K_MULTIPLIER = 3;
// getByIds batch size for tag-scoped recall — Vectorize rejects more than 20 IDs
// per call (VECTOR_GET_ERROR, code 40007)
const VECTORIZE_GET_BY_IDS_BATCH = 20;
// D1 allows at most 100 bound parameters per query
const D1_MAX_BOUND_PARAMS = 100;

// ─── Hybrid recall (keyword + semantic fusion) ─────────────────────────────────
const RRF_K = 60;                    // Reciprocal Rank Fusion dampening constant
const KEYWORD_CANDIDATE_LIMIT = 100; // max rows the LIKE keyword query scans
const KEYWORD_MIN_TOKEN_LEN = 2;     // ignore 1-char tokens
const KEYWORD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "been",
  "i", "me", "my", "we", "you", "it", "this", "that", "these", "those", "with", "about", "from", "at", "as", "by",
  "do", "did", "does", "what", "when", "where", "who", "whom", "how", "why", "which",
]);

// ─── Memory status layer (issue #119) ──────────────────────────────────────────
// Status lives as a reserved tag (e.g. "status:canonical") on entries.tags — no
// schema change. Absent status = unspecified = default behavior.

export const STATUS_VALUES = ["canonical", "draft", "deprecated"] as const;
export type MemoryStatus = (typeof STATUS_VALUES)[number];
const STATUS_PREFIX = "status:";

export function getStatus(tags: string[]): MemoryStatus | null {
  const tag = tags.find(t => t.startsWith(STATUS_PREFIX));
  if (!tag) return null;
  const value = tag.slice(STATUS_PREFIX.length) as MemoryStatus;
  return (STATUS_VALUES as readonly string[]).includes(value) ? value : null;
}

export function withStatus(tags: string[], status: MemoryStatus): string[] {
  const cleaned = tags.filter(t => !t.startsWith(STATUS_PREFIX));
  return [...cleaned, `${STATUS_PREFIX}${status}`];
}

// ─── Memory kind layer (issue #12) ──────────────────────────────────────────────
// Kind lives as a reserved tag (e.g. "kind:episodic") on entries.tags — no schema
// change. Absent kind = unknown (unclassified). Orthogonal to status (#119).

export const KIND_VALUES = ["episodic", "semantic"] as const;
export type MemoryKind = (typeof KIND_VALUES)[number];
const KIND_PREFIX = "kind:";

export function getKind(tags: string[]): MemoryKind | null {
  const tag = tags.find(t => t.startsWith(KIND_PREFIX));
  if (!tag) return null;
  const value = tag.slice(KIND_PREFIX.length) as MemoryKind;
  return (KIND_VALUES as readonly string[]).includes(value) ? value : null;
}

export function withKind(tags: string[], kind: MemoryKind): string[] {
  const cleaned = tags.filter(t => !t.startsWith(KIND_PREFIX));
  return [...cleaned, `${KIND_PREFIX}${kind}`];
}

// ─── Runtime state ────────────────────────────────────────────────────────────

/** Single-flight DB init — concurrent first requests share one Promise. */
let dbInitPromise: Promise<void> | null = null;

export function ensureDatabase(env: Env): Promise<void> {
  return (dbInitPromise ??= initializeDatabase(env).catch((err) => {
    dbInitPromise = null;
    throw err;
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAuthorized(request: Request, env: Env): boolean {
  if (request.headers.get("Authorization") === `Bearer ${env.AUTH_TOKEN}`) return true;
  return new URL(request.url).searchParams.get("token") === env.AUTH_TOKEN;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Returns a 401 Response if the request lacks a valid token, otherwise null —
// lets routes early-return with `const authErr = requireAuth(...); if (authErr) return authErr;`
function requireAuth(request: Request, env: Env): Response | null {
  if (isAuthorized(request, env)) return null;
  return json({ ok: false, error: "Unauthorized" }, 401);
}

// Hosted OAuth login page. Styled to match the dashboard's token-entry card
// (#auth-overlay in public/index.html) — same fonts, palette, and layout.
function loginHtml(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="theme-color" content="#F4F1EA" />
  <title>Second Brain</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.44.0/tabler-icons.min.css" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f4f1ea; --bg-card: #fcfbf7;
      --accent: #b26641; --accent-press: #9c522f; --accent-soft: rgba(178, 102, 65, 0.1); --on-accent: #fcfbf7;
      --text-primary: #26241f; --text-secondary: #6e6b62; --text-tertiary: #a8a498;
      --border-input: rgba(38, 36, 31, 0.11); --danger: #b3261e;
      --font-serif: 'Lora', Georgia, serif; --font-sans: 'DM Sans', system-ui, sans-serif;
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
    }
    body { background: var(--bg); font-family: var(--font-sans); color: var(--text-primary); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .auth-card { width: 100%; max-width: 400px; padding: 40px 32px; display: flex; flex-direction: column; align-items: center; animation: fade-in 0.5s var(--ease); }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
    .brain-logo { width: 70px; height: 70px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; margin-bottom: 24px; position: relative; }
    .brain-logo i { font-size: 33px; }
    .brain-logo::after { content: ''; position: absolute; inset: -7px; border-radius: 50%; border: 1px solid var(--accent-soft); }
    h1 { font-family: var(--font-serif); font-size: 29px; font-weight: 500; margin-bottom: 9px; letter-spacing: -0.015em; }
    p { font-size: 14px; color: var(--text-secondary); margin-bottom: 34px; text-align: center; line-height: 1.6; max-width: 300px; }
    form { width: 100%; display: flex; flex-direction: column; gap: 11px; margin-bottom: 14px; }
    input { width: 100%; padding: 14px 16px; background: var(--bg-card); border: 0.5px solid var(--border-input); border-radius: 13px; font-family: var(--font-sans); font-size: 15px; color: var(--text-primary); outline: none; transition: border-color 0.18s, box-shadow 0.18s; }
    input::placeholder { color: var(--text-tertiary); }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button { width: 100%; padding: 15px; background: var(--accent); color: var(--on-accent); border: none; border-radius: 13px; font-family: var(--font-sans); font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.18s, transform 0.12s var(--ease); }
    button:hover { background: var(--accent-press); }
    button:active { transform: scale(0.985); }
    .auth-error { font-size: 13px; color: var(--danger); text-align: center; margin-top: 10px; min-height: 18px; }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="brain-logo"><i class="ti ti-brain"></i></div>
    <h1>Second Brain</h1>
    <p>Enter your Bearer token to connect to your personal memory layer.</p>
    <form method="POST">
      <input type="password" name="password" placeholder="Bearer token" autofocus autocomplete="current-password" />
      <button type="submit">Connect</button>
    </form>
    <div class="auth-error">${error ? error : ""}</div>
  </div>
</body>
</html>`;
}

async function embed(
  text: string,
  env: Env,
  purpose: "document" | "query" = "document"
): Promise<number[]> {
  return (await createEmbedding(env)).embed(text, { purpose });
}

// ─── Database initialization ──────────────────────────────────────────────────

export async function initializeDatabase(env: Env): Promise<void> {
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)`);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)`);
  for (const alter of [
    `ALTER TABLE entries ADD COLUMN recall_count INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN importance_score INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN contradiction_wins INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN contradiction_losses INTEGER DEFAULT 0`,
  ]) {
    try { await env.DB.exec(alter); } catch { /* column already exists — no-op */ }
  }
  await ensureSettingsTable(env.DB);
  await ensureTelemetryTables(env.DB);
  bindTelemetryDb(env.DB);
}

async function loadTelemetryConfig(env: Env): Promise<TelemetryConfig> {
  try {
    await ensureSettingsTable(env.DB);
    const row = await env.DB.prepare(
      `SELECT value FROM sb_app_settings WHERE key = ?`
    )
      .bind("telemetry_config")
      .first<{ value: string }>();
    if (!row?.value) return { ...DEFAULT_TELEMETRY_CONFIG };
    return normalizeTelemetryConfig(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_TELEMETRY_CONFIG };
  }
}

async function saveTelemetryConfig(env: Env, config: TelemetryConfig): Promise<void> {
  await ensureSettingsTable(env.DB);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sb_app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind("telemetry_config", JSON.stringify(config), now)
    .run();
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

type DuplicateResult =
  | { status: "unique" }
  | { status: "blocked"; matchId: string; score: number }
  | { status: "flagged"; matchId: string; score: number };

export function getDuplicateCheckSample(content: string): string {
  if (content.length <= 1500) return content;

  const start = content.slice(0, 500);
  const midIndex = Math.floor(content.length / 2);
  const middle = content.slice(midIndex - 250, midIndex + 250);
  const end = content.slice(-500);

  return `${start}\n...\n${middle}\n...\n${end}`;
}

// ─── Contradiction Detection ──────────────────────────────────────────────────

interface ContradictionResult {
  detected: boolean;
  conflicting_id?: string;
  reason?: string;
}

// ─── Smart Merge ──────────────────────────────────────────────────────────────
// Only applies to the flagged band (0.85–0.95). The combined prompt handles
// both contradiction detection and merge/replace decisions in a single LLM call,
// keeping total LLM calls the same as before.

export type MergeAction =
  | { action: "keep_both" }
  | { action: "replace"; target_id: string }
  | { action: "merge"; target_id: string; merged_content: string };

// Merges duplicate detection, contradiction detection, and smart merge into a
// single embed + Vectorize query. For flagged entries (0.85–0.95) the combined
// prompt replaces the contradiction-only prompt — same number of LLM calls.
export async function checkDuplicateAndContradiction(content: string, env: Env): Promise<{
  duplicate: DuplicateResult;
  contradiction: ContradictionResult;
  mergeAction: MergeAction | null;
}> {
  const sample = getDuplicateCheckSample(content);
  const values = await embed(sample, env);
  const { matches } = await env.VECTORIZE.query(values, { topK: 5, returnMetadata: "all" });

  // ── Duplicate: derived from top match ───────────────────────────────────────
  let duplicate: DuplicateResult = { status: "unique" };
  if (matches.length) {
    const top = matches[0];
    const matchId = (top.metadata as any)?.parentId ?? top.id;
    if (top.score >= DUPLICATE_BLOCK_THRESHOLD) duplicate = { status: "blocked", matchId, score: top.score };
    else if (top.score >= DUPLICATE_FLAG_THRESHOLD) duplicate = { status: "flagged", matchId, score: top.score };
  }

  // ── Skip all LLM work if blocked ─────────────────────────────────────────────
  let contradiction: ContradictionResult = { detected: false };
  let mergeAction: MergeAction | null = null;

  if (duplicate.status !== "blocked") {
    const candidates = matches.filter(m => m.score >= CANDIDATE_SCORE_THRESHOLD);
    if (candidates.length) {
      const parentIds = [...new Set(
        candidates.map(m => (m.metadata as any)?.parentId ?? m.id)
      )] as string[];

      const placeholders = parentIds.map(() => "?").join(", ");
      const { results: rows } = await env.DB.prepare(
        `SELECT id, content FROM entries WHERE id IN (${placeholders})`
      ).bind(...parentIds).all() as { results: { id: string; content: string }[] };

      if (rows.length) {
        const existingList = rows
          .map((r, i) => `[${i + 1}] ID: ${r.id}\n${r.content}`)
          .join("\n\n");

        if (duplicate.status === "flagged") {
          // ── Combined prompt: contradiction + merge decision (flagged band only) ──
          // Replaces the contradiction-only prompt — same 1 LLM call, richer result.
          const prompt = `You are deciding what to do with a new memory that is very similar to existing memories.

New memory: "${content}"

Similar existing memories:
${existingList}

Choose exactly one action. Prioritise in this order:
1. "contradiction" — new memory DIRECTLY CONFLICTS with an existing one (opposite location, reversed decision, changed fact). Include conflicting_id and reason.
2. "replace" — new memory clearly supersedes an existing one (updated version of the same fact, original is now stale). Include target_id.
3. "merge" — both memories are complementary and better as one combined entry. Include target_id and merged_content (max 400 chars).
4. "keep_both" — memories are different enough to coexist, or you are uncertain. This is the safe default.

Respond with JSON only. No text outside the JSON.
{"action":"keep_both"} OR {"action":"contradiction","conflicting_id":"<id>","reason":"<10 words max>"} OR {"action":"replace","target_id":"<id>"} OR {"action":"merge","target_id":"<id>","merged_content":"<text>"}`;

          try {
            const text = await (await createLLM(env)).chat(
              [{ role: "user", content: prompt }],
              { max_tokens: SMART_MERGE_MAX_TOKENS }
            );
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              const action = parsed.action as string;

              if (action === "contradiction" && parsed.conflicting_id) {
                const validId = parentIds.find(id => id === parsed.conflicting_id);
                if (validId) contradiction = { detected: true, conflicting_id: validId, reason: parsed.reason };
                // mergeAction stays null — contradiction path handles cleanup
              } else if (action === "replace" && parsed.target_id) {
                const validId = parentIds.find(id => id === parsed.target_id);
                mergeAction = validId ? { action: "replace", target_id: validId } : { action: "keep_both" };
              } else if (action === "merge" && parsed.target_id && parsed.merged_content?.trim()) {
                const validId = parentIds.find(id => id === parsed.target_id);
                mergeAction = validId
                  ? { action: "merge", target_id: validId, merged_content: parsed.merged_content.trim() }
                  : { action: "keep_both" };
              } else {
                mergeAction = { action: "keep_both" };
              }
            } else {
              mergeAction = { action: "keep_both" };
            }
          } catch {
            // non-fatal — default to keep_both (current behaviour)
            mergeAction = { action: "keep_both" };
          }
        } else {
          // ── Contradiction only (0.45–0.85 range — unchanged) ─────────────────
          const prompt = `You are checking if a new memory contradicts existing memories.

New memory: "${content}"

Existing memories:
${existingList}

A contradiction means the new memory states something that DIRECTLY CONFLICTS with an existing memory — a different current location, reversed preference, changed decision, or updated fact. Partial overlaps, additions, or elaborations are NOT contradictions.

Respond with JSON only. No text outside the JSON object.
{"contradicts": false} OR {"contradicts": true, "conflicting_id": "<exact_id>", "reason": "<10 words max>"}`;

          try {
            const text = await (await createLLM(env)).chat(
              [{ role: "user", content: prompt }],
              { max_tokens: CONTRADICTION_MAX_TOKENS }
            );
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.contradicts && parsed.conflicting_id) {
                const validId = parentIds.find(id => id === parsed.conflicting_id);
                if (validId) contradiction = { detected: true, conflicting_id: validId, reason: parsed.reason };
              }
            }
          } catch {
            // non-fatal — contradiction stays { detected: false }
          }
        }
      }
    }
  }

  return { duplicate, contradiction, mergeAction };
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

export function chunkText(text: string, maxChars = CHUNK_MAX_CHARS, overlapChars = CHUNK_OVERLAP_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxChars / 2) end = breakPoint + 1;
    }
    chunks.push(text.slice(start, Math.min(end, text.length)).trim());
    start = end - overlapChars;
  }

  return chunks.filter((c) => c.length > 0);
}

// ─── Time-decay reranking ─────────────────────────────────────────────────────

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export function getHalfLifeMs(tags: string[]): number {
  if (tags.includes("task")) return 7 * 24 * 60 * 60 * 1000;  // 7 days
  if (tags.includes("context")) return 180 * 24 * 60 * 60 * 1000; // 6 months
  if (tags.includes("work")) return 90 * 24 * 60 * 60 * 1000; // 3 months
  return 30 * 24 * 60 * 60 * 1000; // 30 days default
}

// Cosine similarity between two vectors. BGE embeddings are not normalized,
// so the denominator matters — this keeps tag-path scores on the same scale
// as Vectorize's cosine query scores.
export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  // Guard on the raw norms, not the sqrt product — the product can underflow to 0
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export function rerankWithTimeDecay(
  matches: VectorizeMatch[],
  recallCounts: Map<string, number> = new Map(),
  importanceScores: Map<string, number> = new Map(),
  queryTags: string[] = [],
  contradictionWins: Map<string, number> = new Map(),
  contradictionLosses: Map<string, number> = new Map()
): VectorizeMatch[] {
  const now = Date.now();

  return matches
    .map(match => {
      const meta = match.metadata as any;
      const createdAt = meta?.created_at ?? now;
      const tags: string[] = Array.isArray(meta?.tags) ? meta.tags : [];
      const ageMs = now - createdAt;
      const parentId = (meta?.parentId ?? match.id) as string;
      const rc = recallCounts.get(parentId) ?? 0;

      const halfLifeMs = getHalfLifeMs(tags);
      const recencyMultiplier = Math.exp(-ageMs / halfLifeMs);
      // Frequency can compensate for recency loss but never push above a fresh entry (cap at 1.0).
      // Without the cap, high recall counts overwhelm recency and bury newly-stored memories.
      const frequencyMultiplier = 1 + Math.log1p(rc);
      const combinedMultiplier = Math.min(1.0, recencyMultiplier * frequencyMultiplier);
      const isShortAppend = match.id.includes("-update-") &&
        typeof meta?.content === "string" && meta.content.length < CHUNK_OVERLAP_CHARS;
      const appendPenalty = isShortAppend ? 0.2 : 1.0;
      const rolledUpPenalty = tags.includes("rolled-up") ? 0.4 : 1.0;

      // Effective importance = classifier score adjusted by net contradiction history.
      // Survivors (net wins) rise toward 5; repeatedly-contradicted memories (net losses)
      // fall toward 1. log1p gives diminishing returns; clamp keeps the effect inside the
      // existing 0.88–1.20 importance band. The stored importance_score is never mutated.
      const imp = importanceScores.get(parentId) ?? 0;
      const wins = contradictionWins.get(parentId) ?? 0;
      const losses = contradictionLosses.get(parentId) ?? 0;
      const net = wins - losses;
      let importanceMultiplier: number;
      if (imp === 0 && net === 0) {
        importanceMultiplier = 1.0; // unscored and never contested — unchanged baseline
      } else {
        const base = imp === 0 ? 3 : imp; // unscored-but-contested → neutral midpoint
        const adj = Math.sign(net) * Math.log1p(Math.abs(net)) * CONTRADICTION_IMPORTANCE_STEP;
        const effectiveImp = Math.max(1, Math.min(5, base + adj));
        importanceMultiplier = 0.8 + (effectiveImp / 5) * 0.4;
      }

      // Tag boost: applied outside the recency ≤1.0 cap so a tag-relevant memory can
      // surface above a marginally-closer but irrelevant one.
      const overlap = queryTags.length ? tags.filter(t => queryTags.includes(t)).length : 0;
      const tagBoost = overlap ? Math.min(TAG_BOOST_MAX, 1 + overlap * TAG_BOOST_STEP) : 1.0;

      return { ...match, score: match.score * combinedMultiplier * appendPenalty * rolledUpPenalty * importanceMultiplier * tagBoost };
    })
    .sort((a, b) => b.score - a.score);
}

// ─── Temporal phrase parsing ──────────────────────────────────────────────────
export function parseTimePhrase(query: string, now: number): { after?: number; before?: number; cleanQuery: string } {
  const MS_DAY = 86400000;
  const MS_WEEK = 7 * MS_DAY;
  const d = new Date(now);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const startOfWeek = (date: Date) => {
    const dow = date.getDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    return startOfDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff));
  };

  type TimeResult = { after?: number; before?: number };
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => TimeResult]> = [
    [/\blast\s+(\d+)\s+days?\b/i, m => ({ after: now - parseInt(m[1]) * MS_DAY })],
    [/\blast\s+(\d+)\s+weeks?\b/i, m => ({ after: now - parseInt(m[1]) * MS_WEEK })],
    [/\blast\s+week\b/i, () => ({ after: now - MS_WEEK })],
    [/\bthis\s+week\b/i, () => ({ after: startOfWeek(d) })],
    [/\blast\s+month\b/i, () => ({
      after: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(),
      before: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    })],
    [/\bthis\s+month\b/i, () => ({ after: new Date(d.getFullYear(), d.getMonth(), 1).getTime() })],
    [/\byesterday\b/i, () => {
      const s = startOfDay(d) - MS_DAY;
      return { after: s, before: s + MS_DAY };
    }],
    [/\btoday\b/i, () => ({ after: startOfDay(d) })],
    [/\baround\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/i, m => {
      const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
      const center = new Date(d.getFullYear(), month, parseInt(m[2])).getTime();
      return { after: center - 3 * MS_DAY, before: center + 3 * MS_DAY };
    }],
  ];

  for (const [pattern, handler] of patterns) {
    const match = query.match(pattern);
    if (match) {
      const { after, before } = handler(match);
      const cleanQuery = query.replace(pattern, '').replace(/\s+/g, ' ').trim() || query;
      return { after, before, cleanQuery };
    }
  }

  return { cleanQuery: query };
}

// ─── AI classification (importance + canonical) ───────────────────────────────

// Map the model's free-text kind to our enum — tolerant of case, whitespace, and
// common synonyms a small model emits (e.g. "event" → episodic, "fact" → semantic).
function normalizeKind(raw: unknown): MemoryKind | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (/episod|event|decision|milestone|occurrence/.test(v)) return "episodic";
  if (/semantic|fact|preference|knowledge|belief/.test(v)) return "semantic";
  return null;
}

// Parse the classifier's response. Tries strict JSON first, then falls back to
// tolerant per-field extraction so one malformed field (small models intermittently
// emit e.g. {"canonical":,}) doesn't discard the other valid fields.
function parseClassification(text: string): { importance: number; canonical: boolean; kind: MemoryKind | null } {
  const obj = text.match(/\{[^{}]*\}/);
  if (obj) {
    try {
      const p = JSON.parse(obj[0]);
      return {
        importance: p.importance >= 1 && p.importance <= 5 ? p.importance : 3,
        canonical: p.canonical === true,
        kind: normalizeKind(p.kind),
      };
    } catch { /* fall through to tolerant extraction */ }
  }
  const imp = text.match(/"importance"\s*:\s*([1-5])/);
  const can = text.match(/"canonical"\s*:\s*(true|false)/i);
  const knd = text.match(/"kind"\s*:\s*"?([a-zA-Z]+)/);
  return {
    importance: imp ? parseInt(imp[1], 10) : 3,
    canonical: can ? can[1].toLowerCase() === "true" : false,
    kind: knd ? normalizeKind(knd[1]) : null,
  };
}

export async function classifyEntry(content: string, env: Env): Promise<{ importance: number; canonical: boolean; kind: MemoryKind | null }> {
  let text: string;
  try {
    text = await (await createLLM(env)).chat(
      [{
        role: "user",
        content:
          `Classify this memory. Respond with ONLY one JSON object and nothing else — no prose, no markdown, no code fences.\n` +
          `{"importance": <1-5>, "canonical": <true|false>, "kind": "episodic"|"semantic"}\n` +
          `importance: 1=trivial, 3=useful context, 5=critical decision or goal.\n` +
          `canonical: true ONLY for a confirmed decision, durable fact, or stated permanent preference that should be authoritative (be conservative; false for anything tentative, one-off, or event-like).\n` +
          `kind: "episodic" for a specific event/decision/milestone that happened at a point in time; "semantic" for a general fact, preference, or piece of knowledge.\n\n` +
          `Memory: ${content.slice(0, 500)}`,
      }],
      { max_tokens: CLASSIFY_MAX_TOKENS }
    );
  } catch {
    return { importance: 0, canonical: false, kind: null };
  }
  return parseClassification(text);
}

// ─── Hashtag extraction ───────────────────────────────────────────────────────

export function extractHashtags(content: string): { cleanContent: string; hashtags: string[] } {
  const hashtags = (content.match(/#\w+/g) ?? []).map(t => t.slice(1).toLowerCase());
  const cleanContent = content.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();
  return { cleanContent, hashtags };
}

// ─── Query tag inference ──────────────────────────────────────────────────────

export async function inferQueryTags(query: string, env: Env): Promise<string[]> {
  const { hashtags } = extractHashtags(query);
  if (hashtags.length) return hashtags;

  const { results: tagRows } = await env.DB.prepare(
    `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`
  ).all();
  const knownTags = (tagRows as { value: string }[]).map(r => r.value);

  const lowerQuery = query.toLowerCase();
  const keywordMatches = knownTags.filter(t =>
    new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(lowerQuery)
  );

  if (keywordMatches.length) return keywordMatches;

  if (!knownTags.length) return [];

  try {
    const text = await (await createLLM(env)).chat(
      [{
        role: "user",
        content: `From this list of tags: ${knownTags.slice(0, 50).join(", ")}\n\nWhich tags best match this query? Reply with only a comma-separated list of matching tag names from the list, or nothing if none apply.\n\nQuery: ${query.slice(0, 300)}`,
      }],
      { max_tokens: 100 }
    );
    const knownSet = new Set(knownTags);
    return text.split(",").map(t => t.trim().toLowerCase()).filter(t => t && knownSet.has(t));
  } catch {
    return [];
  }
}

// ─── Shared entry-listing filter builder ─────────────────────────────────────
// Builds the WHERE/ORDER/LIMIT clause shared by list_recent and GET /list so
// both stay in sync on which filters (tag, after, before) are supported.

export function buildEntryFilterQuery(params: {
  n: number;
  tag?: string;
  after?: number;
  before?: number;
}): { sql: string; bindings: (string | number)[] } {
  const conds: string[] = [];
  const bindings: (string | number)[] = [];
  if (params.tag) { conds.push(`tags LIKE ?`); bindings.push(`%"${params.tag}"%`); }
  if (params.after !== undefined) { conds.push(`created_at >= ?`); bindings.push(params.after); }
  if (params.before !== undefined) { conds.push(`created_at <= ?`); bindings.push(params.before); }

  let sql = `SELECT id, content, tags, source, created_at, vector_ids FROM entries`;
  if (conds.length) sql += ` WHERE ` + conds.join(` AND `);
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  bindings.push(params.n);

  return { sql, bindings };
}

// ─── Store entry (full embed + chunk) ────────────────────────────────────────
// Returns the list of vector IDs inserted so forget() can clean up exactly.

async function storeEntry(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number
): Promise<string[]> {
  const chunks = chunkText(content);

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const metadata: Record<string, any> = {
        content: chunk,
        parentId: id,
        chunkIndex: i,
        totalChunks: chunks.length,
        tags,
        source,
        created_at: now,
      };

      tags.forEach(t => {
        metadata[`tag_${t}`] = true;
      });

      return {
        id: chunks.length === 1 ? id : `${id}-chunk-${i}`,
        values: await embed(chunk, env),
        metadata,
      };
    })
  );

  await env.VECTORIZE.insert(vectors);

  const vectorIds = vectors.map(v => v.id);

  // Persist exact vector IDs so forget() can clean up without guessing
  await env.DB.prepare(
    `UPDATE entries SET vector_ids = ? WHERE id = ?`
  ).bind(JSON.stringify(vectorIds), id).run();

  return vectorIds;
}

// Delete vectors that are no longer referenced after a re-embed. Ids reused by
// the new embedding must survive: single-chunk entries are keyed by the entry
// id, so the re-embedded vector reuses the old id. Deleting the full old set
// would remove the vector we just inserted, leaving the entry unsearchable.
async function deleteStaleVectors(env: Env, oldIds: string[], newIds: string[]): Promise<void> {
  const stale = oldIds.filter(v => !newIds.includes(v));
  if (stale.length) await env.VECTORIZE.deleteByIds(stale);
}

// ─── Append to existing entry ─────────────────────────────────────────────────
// For short appends (combined content ≤ CHUNK_MAX_CHARS): adds only the new
// addition as a single new Vectorize vector pointing to the parent ID.
// For large appends (combined content > CHUNK_MAX_CHARS): falls back to a full
// re-embed of the combined content using the same safe 3-step pattern as update
// (insert new → delete old), so Vectorize always holds properly chunked vectors.

async function appendToEntry(
  env: Env,
  id: string,
  existingContent: string,
  addition: string,
  tags: string[],
  source: string
): Promise<void> {
  // Read existing vector_ids upfront — needed by both paths
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  const existingVectorIds: string[] = JSON.parse(row?.vector_ids ?? "[]");

  const timestamp = new Date().toLocaleDateString();
  const separator = `\n\n[Update ${timestamp}]: `;
  const newContent = existingContent + separator + addition;

  if (newContent.length > CHUNK_MAX_CHARS) {
    // ── Full re-embed path ───────────────────────────────────────────────────
    // Combined content is too large for a single vector — re-chunk everything.
    // Same safe ordering as update/merge/replace: insert new → delete old.

    // Step 1: Persist full combined content to D1
    await env.DB.prepare(`UPDATE entries SET content = ? WHERE id = ?`)
      .bind(newContent, id).run();

    // Step 2: Re-chunk + re-embed full content (also updates vector_ids in D1)
    let newVectorIds: string[] = [];
    try {
      newVectorIds = await storeEntry(env, id, newContent, tags, source, Date.now());
    } catch (e) {
      console.error("Vectorize re-embed failed (non-fatal):", e);
    }

    // Step 3: Delete only stale vectors — ids reused by the re-embed must survive
    try {
      await deleteStaleVectors(env, existingVectorIds, newVectorIds);
    } catch (e) {
      console.error("Old vector cleanup failed (non-fatal):", e);
    }

    return;
  }

  // ── Normal append-only path (combined content ≤ CHUNK_MAX_CHARS) ────────────
  // Timestamp-based suffix guarantees uniqueness across concurrent appends
  const newChunkId = `${id}-update-${Date.now()}`;

  const values = await embed(addition, env);

  const metadata: Record<string, any> = {
    content: addition,
    parentId: id,
    isUpdate: true,
    tags,
    source,
    created_at: Date.now(),
  };

  tags.forEach(t => {
    metadata[`tag_${t}`] = true;
  });

  await env.VECTORIZE.insert([{
    id: newChunkId,
    values,
    metadata,
  }]);

  // Single UPDATE for both content and vector_ids — saves one D1 round trip
  await env.DB.prepare(
    `UPDATE entries SET content = ?, vector_ids = ? WHERE id = ?`
  ).bind(newContent, JSON.stringify([...existingVectorIds, newChunkId]), id).run();
}

// ─── Synthesize insight from retrieved memories ───────────────────────────────

export async function synthesizeInsight(
  query: string,
  rows: { id: string; content: string }[],
  env: Env
): Promise<string> {
  if (!rows.length) return "";

  const memoriesList = rows
    .map((r, i) => `[${i + 1}] ID: ${r.id}\n${r.content}`)
    .join("\n\n");

  const prompt = `You are a second brain assistant. Summarize what the user's stored memories below say in relation to their query. Base the insight ONLY on these memories.

Query: "${query}"

Memories:
${memoriesList}

Rules:
- Use ONLY the information in the memories above. Do not add, infer, guess, or speculate, and do not use hedging language like "might" or "it seems".
- These memories are a retrieved subset, not the user's full memory store. Never say that information is missing, unavailable, or does not exist.
- If the memories don't address the query, briefly state only what they do contain.

Write a brief insight (2-4 sentences).`;

  let insight = "";
  try {
    insight = await (await createLLM(env)).chat(
      [{ role: "user", content: prompt }],
      { max_tokens: INSIGHT_MAX_TOKENS }
    );
  } catch (e) {
    console.error("synthesizeInsight LLM call failed (non-fatal):", e);
  }

  return insight.trim();
}

// ─── Async pattern derivation ─────────────────────────────────────────────────

export async function derivePattern(
  rows: { id: string; content: string }[],
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  if (rows.length < 10) return;

  // At most one auto-pattern per 48h to prevent spam across repeated recalls
  const recentPattern = await env.DB.prepare(
    `SELECT id FROM entries WHERE tags LIKE '%"auto-pattern"%' AND created_at > ? LIMIT 1`
  ).bind(Date.now() - 172800000).first();
  if (recentPattern) return;

  const sample = rows.slice(0, 20);
  const memoriesList = sample
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 300)}`)
    .join("\n\n");

  const prompt = `You are analyzing stored memories to find genuine recurring themes.

Memories:
${memoriesList}

Find a pattern that appears across 3 or more of these memories — a real tendency, preference, or recurring theme about this person. Do NOT summarize individual memories. Do NOT describe any single event.

If you find a genuine cross-memory pattern, respond with exactly ONE sentence starting with exactly one of: "You tend to", "There's a recurring", or "Across your memories".

If no genuine pattern exists across 3+ memories, respond with exactly: NONE`;

  try {
    const trimmed = (
      await (await createLLM(env)).chat(
        [{ role: "user", content: prompt }],
        { max_tokens: PATTERN_MAX_TOKENS }
      )
    ).trim();

    if (!trimmed || trimmed === "NONE") return;

    const validStarters = ["You tend to", "There's a recurring", "Across your memories"];
    if (!validStarters.some(s => trimmed.startsWith(s))) return;

    await captureEntry(trimmed, ["auto-pattern"], "system", env, ctx);
  } catch (e) {
    console.error("derivePattern failed (non-fatal):", String(e));
  }
}

// ─── Semantic compression ─────────────────────────────────────────────────────

export async function synthesizeDigest(
  tag: string,
  rows: { id: string; content: string }[],
  env: Env
): Promise<string> {
  if (!rows.length) return "";

  const memoriesList = rows
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 400)}`)
    .join("\n\n");

  const prompt = `You are a second brain assistant. Based on these stored memories tagged "${tag}", write a single cohesive paragraph describing the current state of this area — what has been done, decided, and is being worked toward. Write as one flowing paragraph, not a list.

Memories:
${memoriesList}

State of "${tag}":`;

  let digest = "";
  try {
    digest = await (await createLLM(env)).chat(
      [{ role: "user", content: prompt }],
      { max_tokens: DIGEST_MAX_TOKENS }
    );
  } catch (e) {
    console.error("synthesizeDigest LLM call failed (non-fatal):", e);
  }

  return digest.trim();
}

export async function compressTag(
  tag: string,
  env: Env,
  ctx: ExecutionContext
): Promise<{ synthesizedId: string | null; entriesUsed: number; text: string }> {
  // Reserved/namespaced tags (kind:*, status:*) describe a memory's type/lifecycle,
  // not a topic — digesting them would blend unrelated memories (and could compress
  // protected/canonical ones). Never compress by them. This also guards /digest and
  // the web UI Compress button, not just the nightly cron.
  if (tag.startsWith(STATUS_PREFIX) || tag.startsWith(KIND_PREFIX)) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  const recentSynth = await env.DB.prepare(`
    SELECT id FROM entries
    WHERE tags LIKE '%"synthesized"%'
      AND tags LIKE ?
      AND created_at > ?
    LIMIT 1
  `).bind(`%"${tag}"%`, Date.now() - 86400000).first();

  if (recentSynth) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  // Fetch compressible entries: tagged with this tag, not system-tagged, not high-importance
  const { results: rawEntries } = await env.DB.prepare(`
    SELECT id, content FROM entries
    WHERE tags LIKE ?
      AND tags NOT LIKE '%"synthesized"%'
      AND tags NOT LIKE '%"auto-pattern"%'
      AND tags NOT LIKE '%"rolled-up"%'
      AND ${compressionEligibilitySql()}
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(`%"${tag}"%`, Date.now() - COMPRESSION_MIN_AGE_MS).all();

  if (rawEntries.length < 10) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  const rows = rawEntries.map(r => ({ id: r.id as string, content: r.content as string }));
  const text = await synthesizeDigest(tag, rows, env);
  if (!text) return { synthesizedId: null, entriesUsed: 0, text: "" };

  const content = `[Synthesized from ${rows.length} entries tagged "${tag}"]\n\n${text}`;
  const result = await captureEntry(content, ["synthesized", tag], "system", env, ctx);

  if (result.status !== "stored") {
    return { synthesizedId: null, entriesUsed: 0, text };
  }

  for (const id of rows.map(r => r.id)) {
    try {
      await env.DB.prepare(
        `UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content || ? WHERE id = ?`
      ).bind(`\n\n[Digest: ${result.id}]`, id).run();
    } catch (e) {
      console.error(`Failed to update source entry ${id} (non-fatal):`, e);
    }
  }

  return { synthesizedId: result.id, entriesUsed: rows.length, text };
}

async function runNightlyCompression(env: Env, ctx: ExecutionContext): Promise<void> {
  await ensureDatabase(env);

  const { results } = await env.DB.prepare(`
    SELECT value as tag, COUNT(*) as count
    FROM entries, json_each(entries.tags)
    WHERE value NOT IN ('synthesized', 'auto-pattern', 'duplicate-candidate', 'contradiction-resolved', 'rolled-up')
      AND value NOT LIKE 'status:%'
      AND value NOT LIKE 'kind:%'
      AND entries.tags NOT LIKE '%"rolled-up"%'
      AND entries.tags NOT LIKE '%"synthesized"%'
      AND entries.tags NOT LIKE '%"auto-pattern"%'
      AND ${compressionEligibilitySql("entries.")}
    GROUP BY value
    HAVING count > 10
    ORDER BY count DESC
  `).bind(Date.now() - COMPRESSION_MIN_AGE_MS).all();

  for (const row of results) {
    const tag = row.tag as string;
    try {
      await compressTag(tag, env, ctx);
    } catch (e) {
      console.error(`Compression failed for tag "${tag}" (non-fatal):`, e);
    }
  }
}

async function runScheduledMaintenance(env: Env, ctx: ExecutionContext): Promise<void> {
  await ensureDatabase(env);
  await flushTelemetry(env.DB);
  await aggregateTelemetryHour(env.DB);

  // Keep raw rows bounded while retaining the hourly series. Compression is
  // intentionally still once per day because it calls the configured LLM.
  if (new Date().getUTCHours() === 1) {
    const config = await loadTelemetryConfig(env);
    await purgeOldTelemetry(env.DB, config.retentionDays);
    await runNightlyCompression(env, ctx);
  }
}

// ─── Shared search path ───────────────────────────────────────────────────────
// Used by both the `recall` MCP tool and GET /recall — the full semantic
// search pipeline (embed → vector query → time-decay rerank → dedupe → D1
// hydration → insight synthesis) lives here once; callers format the result.

export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  createdAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
}

export interface RecallSearchResult {
  matches: RecallMatch[];
  insight: string;
}

// ─── Hybrid recall: keyword search + Reciprocal Rank Fusion ────────────────────

interface KeywordRow { id: string; content: string; tags: string; source: string; created_at: number; }

// Split a query into lexical search tokens: lowercase, strip surrounding punctuation,
// drop stopwords / 1-char tokens, and remove SQL LIKE wildcards so each token is a literal
// substring. Identifier-shaped tokens (e.g. "v1.9", "#149") are preserved intact.
export function tokenizeQuery(query: string): string[] {
  return [...new Set(
    query.toLowerCase().split(/\s+/)
      .map(t => t.replace(/^[^\w#.]+|[^\w#.]+$/g, "").replace(/[%_]/g, ""))
      .filter(t => t.length >= KEYWORD_MIN_TOKEN_LEN && !KEYWORD_STOPWORDS.has(t))
  )];
}

// Keyword candidates: entries whose content contains any query token, bounded by
// KEYWORD_CANDIDATE_LIMIT. Relevance ranking happens in fuseDenseAndKeyword.
async function keywordSearch(tokens: string[], env: Env): Promise<KeywordRow[]> {
  if (!tokens.length) return [];
  const where = tokens.map(() => "content LIKE ?").join(" OR ");
  const { results } = await env.DB.prepare(
    `SELECT id, content, tags, source, created_at FROM entries WHERE ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...tokens.map(t => `%${t}%`), KEYWORD_CANDIDATE_LIMIT).all();
  return results as unknown as KeywordRow[];
}

// Reciprocal Rank Fusion. Dense candidates contribute 1/(k+rank); keyword candidates
// contribute weight/(k+rank), where weight = number of distinct query tokens the entry
// matched — so an exact multi-token/identifier hit outweighs entries that merely share a
// common word, and an entry present in BOTH lists accumulates from both.
export function rrfFuse(
  denseRanked: string[],
  keywordRanked: { id: string; weight: number }[],
  k = RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();
  denseRanked.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i)));
  keywordRanked.forEach((e, i) => scores.set(e.id, (scores.get(e.id) ?? 0) + e.weight / (k + i)));
  return scores;
}

// Fuse a dense match list (Vectorize chunks, or tag-path cosine scores) with keyword rows
// into one per-parent candidate list scored by RRF, ready for rerankWithTimeDecay. With
// allowKeywordOnly=false (tag path) keyword is a re-ranking signal only — it never
// introduces an entry the dense pass didn't already surface.
function fuseDenseAndKeyword(
  denseMatches: VectorizeMatch[],
  keywordRows: KeywordRow[],
  tokens: string[],
  allowKeywordOnly: boolean
): VectorizeMatch[] {
  const denseByParent = new Map<string, VectorizeMatch>();
  for (const m of [...denseMatches].sort((a, b) => b.score - a.score)) {
    const pid = ((m.metadata as any)?.parentId ?? m.id) as string;
    if (!denseByParent.has(pid)) denseByParent.set(pid, m);
  }
  const denseRanked = [...denseByParent.keys()];

  const keywordRanked = keywordRows
    .map(r => ({ row: r, weight: tokens.reduce((n, t) => n + (r.content.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter(x => x.weight > 0 && (allowKeywordOnly || denseByParent.has(x.row.id)))
    .sort((a, b) => b.weight - a.weight || b.row.created_at - a.row.created_at || (a.row.id < b.row.id ? -1 : 1));

  const fused = rrfFuse(denseRanked, keywordRanked.map(x => ({ id: x.row.id, weight: x.weight })));
  const keywordRowById = new Map(keywordRows.map(r => [r.id, r]));

  const out: VectorizeMatch[] = [];
  for (const [pid, score] of fused) {
    const dm = denseByParent.get(pid);
    if (dm) {
      out.push({ id: dm.id, score, metadata: dm.metadata });
    } else {
      const r = keywordRowById.get(pid)!;
      out.push({ id: pid, score, metadata: { parentId: pid, created_at: r.created_at, tags: JSON.parse(r.tags ?? "[]"), content: r.content, source: r.source } });
    }
  }
  return out;
}

export async function recallEntries(
  params: { query: string; topK: number; tag?: string; after?: number; before?: number; kind?: MemoryKind },
  env: Env,
  ctx: ExecutionContext
): Promise<RecallSearchResult> {
  const { query, topK } = params;
  let { tag, after, before, kind } = params;
  const now = Date.now();

  let embedQuery = query;
  if (after === undefined && before === undefined) {
    const parsed = parseTimePhrase(query, now);
    after = parsed.after;
    before = parsed.before;
    embedQuery = parsed.cleanQuery;
  }

  const tokens = tokenizeQuery(embedQuery);
  const [values, queryTags] = await Promise.all([
    embed(embedQuery, env, "query"),
    inferQueryTags(embedQuery, env),
  ]);

  let keywordRows: KeywordRow[] = [];
  let results: { matches: VectorizeMatch[] };
  if (tag) {
    // Tag path: score the tag's own vectors directly. An unconstrained Vectorize
    // query caps at 50 candidates, silently dropping tagged entries whose global
    // semantic rank falls outside the top 50 (issue #141). D1 is the source of
    // truth for tags and already stores each entry's vector_ids.
    const { results: tagRows } = await env.DB.prepare(
      `SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ?`
    ).bind(`%"${tag}"%`).all();
    if (!tagRows.length) return { matches: [], insight: "" };
    keywordRows = tagRows as unknown as KeywordRow[];

    const vectorIds = [...new Set(
      (tagRows as any[]).flatMap(r => JSON.parse((r.vector_ids as string) ?? "[]") as string[])
    )];
    if (!vectorIds.length) return { matches: [], insight: "" };

    const vectors: VectorizeVector[] = [];
    for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
      vectors.push(...await env.VECTORIZE.getByIds(vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH)));
    }

    results = {
      matches: vectors.map(v => ({
        id: v.id,
        score: cosineSim(values, v.values as number[]),
        metadata: v.metadata,
      })) as VectorizeMatch[],
    };
  } else {
    // Cloudflare Vectorize caps topK at 50 when returnMetadata="all" (error 40025).
    // Run the keyword search in parallel with the dense query.
    const vectorizeTopK = Math.min(topK * VECTORIZE_TOP_K_MULTIPLIER, 50);
    const [denseResults, kwRows] = await Promise.all([
      env.VECTORIZE.query(values, { topK: vectorizeTopK, returnMetadata: "all" }),
      keywordSearch(tokens, env),
    ]);
    results = denseResults;
    keywordRows = kwRows;

    if (results.matches.length && results.matches[0].score < DUPLICATE_FLAG_THRESHOLD) {
      results = await env.VECTORIZE.query(values, {
        topK: 50,
        returnMetadata: "all",
      });
    }
  }

  // Always-on hybrid retrieval: fuse dense + keyword candidates via RRF. On the tag path
  // keyword is a re-ranking signal only (allowKeywordOnly=false); on the default path it can
  // also surface exact-identifier matches the dense top-K missed entirely.
  const fusedMatches = fuseDenseAndKeyword(results.matches as VectorizeMatch[], keywordRows, tokens, !tag);
  if (!fusedMatches.length) return { matches: [], insight: "" };

  // Fetch recall_count and importance_score for all candidates to use in scoring.
  // The tag path can produce far more than 100 candidates, so chunk the IN query
  // to stay under D1's bound-parameter limit.
  const candidateIds = [...new Set(fusedMatches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  const rcRows: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number }[] = [];
  for (let i = 0; i < candidateIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = candidateIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const rcPlaceholders = batch.map(() => "?").join(", ");
    const { results: rows } = await env.DB.prepare(
      `SELECT id, recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries WHERE id IN (${rcPlaceholders})`
    ).bind(...batch).all() as { results: { id: string; recall_count: number; importance_score: number; contradiction_wins: number; contradiction_losses: number }[] };
    rcRows.push(...rows);
  }
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));
  const contradictionWins = new Map(rcRows.map(r => [r.id, r.contradiction_wins ?? 0]));
  const contradictionLosses = new Map(rcRows.map(r => [r.id, r.contradiction_losses ?? 0]));

  const reranked = rerankWithTimeDecay(fusedMatches, recallCounts, importanceScores, queryTags, contradictionWins, contradictionLosses);

  const seen = new Set<string>();
  const deduped = reranked.filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  }).slice(0, topK);

  if (!deduped.length) return { matches: [], insight: "" };

  // Fetch full content from D1 for all matched parent IDs, applying filters: auto-pattern
  // exclusion, status:deprecated exclusion, optional kind match, and optional after/before range
  const parentIds = deduped.map((m) => (m.metadata as any)?.parentId ?? m.id);
  const placeholders = parentIds.map(() => "?").join(", ");
  const d1Bindings: (string | number)[] = [...parentIds];
  let d1Sql = `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${placeholders}) AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"status:deprecated"%'`;
  if (kind && (KIND_VALUES as readonly string[]).includes(kind)) {
    // Safe to interpolate: `kind` is validated against the KIND_VALUES enum just above,
    // so only "episodic"/"semantic" can reach the string. Kept as a literal (not a bound
    // param) so it doesn't shift the positional after/before bindings below.
    d1Sql += ` AND tags LIKE '%"kind:${kind}"%'`;
  }
  if (after !== undefined) { d1Sql += ` AND created_at >= ?`; d1Bindings.push(after); }
  if (before !== undefined) { d1Sql += ` AND created_at <= ?`; d1Bindings.push(before); }
  const { results: d1Rows } = await env.DB.prepare(d1Sql).bind(...d1Bindings).all() as { results: Record<string, any>[] };

  const d1Map = new Map(d1Rows.map((r) => [r.id as string, r]));

  // Increment recall_count for entries actually shown
  ctx.waitUntil(
    Promise.all(
      [...d1Map.keys()].map(id =>
        env.DB.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = ?`).bind(id).run()
      )
    ).catch(e => console.error("recall_count update failed (non-fatal):", e))
  );

  const matches: RecallMatch[] = deduped.flatMap((m) => {
    const meta = m.metadata as Record<string, any>;
    const parentId = (meta?.parentId ?? m.id) as string;
    const row = d1Map.get(parentId);
    const isUpdate = !!meta?.isUpdate;

    if (!row) {
      // D1 row not found — either filtered out (e.g. status:deprecated) or genuinely missing
      return [];
    }

    return [{
      id: parentId,
      content: row.content as string,
      score: m.score,
      createdAt: row.created_at as number,
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate,
    }];
  });

  // Normalize fused scores to 0–1 (top match = 1.0) so the displayed match % is a clean,
  // monotonically-decreasing scale rather than raw RRF values.
  const maxScore = matches.reduce((mx, m) => Math.max(mx, m.score), 0);
  if (maxScore > 0) for (const m of matches) m.score = m.score / maxScore;

  // Observatory: memory.recalled events (sample top matches)
  for (let i = 0; i < Math.min(matches.length, 10); i++) {
    const m = matches[i];
    logMemoryEvent(m.id, "recalled", {
      query: query.slice(0, 200),
      score: m.score,
      rank: i + 1,
    }, "recall");
  }

  const insight = d1Rows.length > 1
    ? await synthesizeInsight(embedQuery, d1Rows as { id: string; content: string }[], env)
    : "";

  if (d1Rows.length >= 5) {
    ctx.waitUntil(
      derivePattern(d1Rows as { id: string; content: string }[], env, ctx)
        .catch(e => console.error("derivePattern failed (non-fatal):", e))
    );
  }

  return { matches, insight };
}

// ─── Shared write path ────────────────────────────────────────────────────────

// Classify an entry's content (importance + canonical + kind) and apply the tags,
// asynchronously. Used for both newly-inserted entries and smart-merge targets.
function scheduleClassifyAndTag(entryId: string, content: string, env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(
    classifyEntry(content, env)
      .then(async ({ importance, canonical, kind }) => {
        await env.DB.prepare(`UPDATE entries SET importance_score = ? WHERE id = ?`).bind(importance, entryId).run();
        if (!kind && !canonical) return;
        const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(entryId).first() as Record<string, any> | null;
        if (!row) return;
        let tags: string[] = JSON.parse(row.tags ?? "[]");
        if (kind) tags = withKind(tags, kind);
        if (canonical && getStatus(tags) === null) tags = withStatus(tags, "canonical");
        await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(tags), entryId).run();
      })
      .catch(e => console.error("Classification failed (non-fatal):", e))
  );
}

export type CaptureResult =
  | { status: "blocked"; matchId: string; score: number }
  | { status: "stored"; id: string }
  | { status: "flagged"; id: string; matchId: string; score: number }
  | { status: "contradiction"; id: string; resolvedConflict: string; reason?: string }
  | { status: "contradiction_protected"; id: string; canonicalId: string; reason?: string }
  | { status: "merged"; id: string }
  | { status: "replaced"; id: string };

export async function captureEntry(
  rawContent: string,
  tags: string[],
  source: string,
  env: Env,
  ctx: ExecutionContext
): Promise<CaptureResult> {
  const raw = rawContent.trim();
  const { cleanContent, hashtags } = extractHashtags(raw);
  const c = cleanContent || raw;
  const t = [...new Set([...tags.map(tag => tag.toLowerCase()), ...hashtags])];

  const { duplicate: dup, contradiction, mergeAction } = await checkDuplicateAndContradiction(c, env);

  if (dup.status === "blocked") {
    return { status: "blocked", matchId: dup.matchId, score: dup.score };
  }

  // ── Smart merge: replace/merge existing entry — no new entry inserted ────────
  if (dup.status === "flagged" && mergeAction && mergeAction.action !== "keep_both") {
    const targetId = mergeAction.target_id;
    const newContent = mergeAction.action === "merge" ? mergeAction.merged_content : c;

    const targetRow = await env.DB.prepare(
      `SELECT tags, source, vector_ids, importance_score FROM entries WHERE id = ?`
    ).bind(targetId).first() as Record<string, any> | null;

    if (targetRow) {
      const existingTags: string[] = JSON.parse(targetRow.tags ?? "[]");
      const existingSource = targetRow.source as string;
      const oldVectorIds: string[] = JSON.parse(targetRow.vector_ids ?? "[]");

      // Protect high-importance or canonical memories from being silently overwritten.
      // Score ≥ 4 means the existing entry is critical; canonical = confirmed authoritative.
      const targetStatus = getStatus(existingTags);
      if ((targetRow.importance_score as number) >= 4 || targetStatus === "canonical") {
        return { status: "flagged", id: crypto.randomUUID(), matchId: targetId, score: dup.score };
      }

      // Step 1: Update D1 content
      await env.DB.prepare(`UPDATE entries SET content = ? WHERE id = ?`).bind(newContent, targetId).run();

      // Step 2: Re-embed new content — inserts new vectors, updates vector_ids in D1
      let newVectorIds: string[] = [];
      try {
        newVectorIds = await storeEntry(env, targetId, newContent, existingTags, existingSource, Date.now());
      } catch (e) { console.error("Vectorize re-embed failed (non-fatal):", e); }

      // Step 3: Delete only stale vectors — ids reused by the re-embed must survive
      try {
        await deleteStaleVectors(env, oldVectorIds, newVectorIds);
      } catch (e) { console.error("Old vector cleanup failed (non-fatal):", e); }

      // Re-classify the merged/replaced content — updates importance_score + kind (and canonical if warranted) on the target.
      scheduleClassifyAndTag(targetId, newContent, env, ctx);

      return mergeAction.action === "merge"
        ? { status: "merged", id: targetId }
        : { status: "replaced", id: targetId };
    }
    // target not found in DB — fall through to normal insert
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const baseTags = contradiction.detected ? [...t, "contradiction-resolved"] : t;
  const finalTags = dup.status === "flagged" ? [...baseTags, "duplicate-candidate"] : baseTags;

  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, c, JSON.stringify(finalTags), source, now, "[]").run();

  logMemoryEvent(id, "created", { source, tags: finalTags }, source);

  ctx.waitUntil(
    storeEntry(env, id, c, finalTags, source, now)
      .then(() => logMemoryEvent(id, "vectorized", {}, source))
      .catch(e => console.error("Vectorize insert failed (non-fatal):", e))
  );

  scheduleClassifyAndTag(id, c, env, ctx);

  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictId = contradiction.conflicting_id;
    const conflictRow = await env.DB.prepare(
      `SELECT tags FROM entries WHERE id = ?`
    ).bind(conflictId).first() as Record<string, any> | null;
    const conflictStatus = conflictRow ? getStatus(JSON.parse(conflictRow.tags ?? "[]")) : null;

    if (conflictStatus === "canonical") {
      // Don't overwrite a canonical memory — keep it, demote the new entry to draft.
      // Strip "contradiction-resolved" — that tag marks entries that WON a contradiction;
      // this entry lost, so it must not carry that tag.
      const draftTags = finalTags.filter(t => t !== "contradiction-resolved");
      await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`)
        .bind(JSON.stringify(withStatus(draftTags, "draft")), id).run();
      // Record the outcome: canonical incumbent survived (win), new draft lost (loss).
      // Non-fatal — a failed count update must not abort capture.
      try {
        await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(conflictId).run();
        await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(id).run();
      } catch (e) {
        console.error("Contradiction count update failed (non-fatal):", e);
      }
      return { status: "contradiction_protected", id, canonicalId: conflictId, reason: contradiction.reason };
    }

    // Non-canonical loser: the new entry wins; the incumbent loses and is deprecated
    // (row kept for audit). Record the outcome before deprecating. Non-fatal.
    try {
      await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(id).run();
      await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(conflictId).run();
    } catch (e) {
      console.error("Contradiction count update failed (non-fatal):", e);
    }
    try {
      await deprecateEntry(conflictId, env);
    } catch (e) {
      console.error("Contradiction deprecation failed (non-fatal):", e);
    }
    return { status: "contradiction", id, resolvedConflict: conflictId, reason: contradiction.reason };
  }

  if (dup.status === "flagged") {
    return { status: "flagged", id, matchId: dup.matchId, score: dup.score };
  }

  return { status: "stored", id };
}

// ─── Shared delete path ───────────────────────────────────────────────────────
// Used by both the `forget` MCP tool and POST /forget so the cleanup logic
// (D1 row + tracked Vectorize IDs) lives in exactly one place.

export type ForgetResult =
  | { status: "not_found" }
  | { status: "deleted"; vectorCount: number };

export async function forgetEntry(id: string, env: Env): Promise<ForgetResult> {
  const row = await env.DB.prepare(
    `SELECT vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;

  if (!row) return { status: "not_found" };

  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  await env.DB.prepare(`DELETE FROM entries WHERE id = ?`).bind(id).run();

  try {
    if (vectorIds.length) {
      // Delete exact IDs — no guessing, no leaks
      await env.VECTORIZE.deleteByIds(vectorIds);
    }
  } catch (e) {
    console.error("Vectorize delete failed (non-fatal):", e);
  }

  return { status: "deleted", vectorCount: vectorIds.length };
}

// Deprecate (issue #119): keep the D1 row for audit but make the entry
// unrecallable by deleting its vectors and tagging it status:deprecated.
export async function deprecateEntry(id: string, env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT tags, vector_ids FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;
  if (!row) return false;

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

  await env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?`)
    .bind(JSON.stringify(withStatus(tags, "deprecated")), "[]", id).run();

  try {
    if (vectorIds.length) await env.VECTORIZE.deleteByIds(vectorIds);
  } catch (e) {
    console.error("Vectorize deleteByIds failed during deprecate (non-fatal):", e);
  }
  return true;
}

// Apply a lifecycle status to an entry (issue #119). 'deprecated' deletes vectors
// (via deprecateEntry); others swap the status:* tag in place. Returns ok=false if no such entry.
export async function applyStatus(id: string, status: MemoryStatus, env: Env): Promise<boolean> {
  if (status === "deprecated") return deprecateEntry(id, env);
  const row = await env.DB.prepare(`SELECT tags FROM entries WHERE id = ?`).bind(id).first() as Record<string, any> | null;
  if (!row) return false;
  const tags: string[] = JSON.parse(row.tags ?? "[]");
  await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(withStatus(tags, status)), id).run();
  return true;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMcpServer(env: Env, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: "second-brain", version: "1.0.0" });

  // ── remember ────────────────────────────────────────────────────────────
  server.registerTool(
    "remember",
    {
      description: "Store an idea, task, or note in your second brain. Call this automatically whenever the user shares context, goals, decisions, or preferences.",
      inputSchema: {
        content: z.string().describe("The idea, task, or note to store"),
        tags: z.array(z.string()).optional().describe("Optional tags for filtering"),
        source: z.string().optional().describe("Origin: phone, browser, voice, claude"),
      },
    },
    async ({ content, tags, source }) => {
      const result = await captureEntry(content, tags ?? [], source ?? "claude", env, ctx);
      if (result.status === "blocked") {
        return { content: [{ type: "text", text: `Duplicate detected (${(result.score * 100).toFixed(0)}% match) — not stored. Existing entry ID: ${result.matchId}` }] };
      }
      if (result.status === "contradiction") {
        return { content: [{ type: "text", text: `Stored. ID: ${result.id} — resolved contradiction with entry ${result.resolvedConflict}${result.reason ? `: ${result.reason}` : ""}.` }] };
      }
      if (result.status === "contradiction_protected") {
        return { content: [{ type: "text", text: `Stored as draft (ID: ${result.id}) — conflicts with a canonical memory (${result.canonicalId}), which was kept${result.reason ? `: ${result.reason}` : ""}.` }] };
      }
      if (result.status === "replaced") {
        return { content: [{ type: "text", text: `Memory updated — new content replaced outdated entry (ID: ${result.id}).` }] };
      }
      if (result.status === "merged") {
        return { content: [{ type: "text", text: `Memories merged — combined into existing entry (ID: ${result.id}).` }] };
      }
      if (result.status === "flagged") {
        return { content: [{ type: "text", text: `Stored with ID: ${result.id} — note: similar entry exists (${(result.score * 100).toFixed(0)}% match, ID: ${result.matchId}). Tagged as duplicate-candidate.` }] };
      }
      return { content: [{ type: "text", text: `Stored. ID: ${result.id}` }] };
    }
  );

  // ── append ───────────────────────────────────────────────────────────────
  server.registerTool(
    "append",
    {
      description: "Append new information to an existing entry in your second brain. Use when something has changed or been updated — preserves the original and adds the update with a timestamp. Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID to append to — from recall or list_recent"),
        addition: z.string().describe("The new information to add to the existing entry"),
      },
    },
    async ({ id, addition }) => {
      const row = await env.DB.prepare(
        `SELECT id, content, tags, source FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return {
          content: [{ type: "text", text: `No entry found with ID: ${id}` }],
        };
      }

      const existingContent = row.content as string;
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const source = row.source as string;
      const a = addition.trim();

      if (!a) {
        return {
          content: [{ type: "text", text: "Addition cannot be empty." }],
        };
      }

      try {
        await appendToEntry(env, id, existingContent, a, tags, source);
      } catch (e) {
        console.error("Append failed:", e);
        return {
          content: [{ type: "text", text: `Append failed: ${(e as Error).message}` }],
        };
      }

      return {
        content: [{
          type: "text",
          text: `Appended to entry ${id}. The original content is preserved and your update has been added with today's date.`,
        }],
      };
    }
  );

  // ── update ───────────────────────────────────────────────────────────────
  server.registerTool(
    "update",
    {
      description: "Replace the full content of an existing memory. Use when information has changed entirely — a preference reversed, a decision overturned, or content is outdated. Use append instead if you're adding new information rather than replacing. Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID to update — from recall or list_recent"),
        content: z.string().describe("The new content to replace the existing entry with"),
      },
    },
    async ({ id, content }) => {
      const newContent = content.trim();
      if (!newContent) {
        return { content: [{ type: "text", text: "Content cannot be empty." }] };
      }

      // Read current row upfront — need tags, source, AND old vector_ids before any mutation
      const row = await env.DB.prepare(
        `SELECT tags, source, vector_ids FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }

      const tags: string[] = JSON.parse(row.tags ?? "[]").filter((t: string) => t !== "rolled-up");
      const source = row.source as string;
      const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");

      // Step 1: Update D1 content and tags (strip rolled-up so updated entry ranks normally)
      await env.DB.prepare(`UPDATE entries SET content = ?, tags = ? WHERE id = ?`)
        .bind(newContent, JSON.stringify(tags), id).run();

      // Step 2: Re-embed new content → inserts new vectors + updates vector_ids in D1
      let newVectorIds: string[] = [];
      try {
        newVectorIds = await storeEntry(env, id, newContent, tags, source, Date.now());
      } catch (e) {
        console.error("Vectorize re-embed failed (non-fatal):", e);
      }
      const newVectorCount = newVectorIds.length;

      // Step 3: Delete only stale vectors — ids reused by the re-embed must survive
      try {
        await deleteStaleVectors(env, oldVectorIds, newVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }

      return {
        content: [{ type: "text", text: `Updated entry ${id}. Re-embedded as ${newVectorCount} vector(s).` }],
      };
    }
  );

  // ── set_status ─────────────────────────────────────────────────────────────
  server.registerTool(
    "set_status",
    {
      description: "Set a memory's lifecycle status. 'canonical' = confirmed/authoritative (protected from auto-overwrite), 'draft' = tentative, 'deprecated' = no longer accurate (removed from recall, kept for audit). Get the entry ID from recall or list_recent first.",
      inputSchema: {
        id: z.string().describe("Entry ID — from recall or list_recent"),
        status: z.enum([...STATUS_VALUES] as [string, ...string[]]).describe("canonical | draft | deprecated"),
      },
    },
    async ({ id, status }) => {
      const ok = await applyStatus(id, status as MemoryStatus, env);
      if (!ok) return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      return { content: [{ type: "text", text: status === "deprecated" ? `Entry ${id} deprecated — removed from recall, kept for audit.` : `Entry ${id} marked ${status}.` }] };
    }
  );

  // ── recall ───────────────────────────────────────────────────────────────
  server.registerTool(
    "recall",
    {
      description: "Recall: semantically search your second brain for relevant notes and context. Call recall automatically at the start of every conversation and every 3-4 messages.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        topK: z.number().int().min(1).max(20).default(5).describe("Number of results"),
        tag: z.string().optional().describe("Filter by a specific tag"),
        after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp"),
        before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp"),
        kind: z.enum([...KIND_VALUES] as [string, ...string[]]).optional().describe("Filter to episodic (events) or semantic (facts/knowledge)"),
      },
    },
    async ({ query, topK, tag, after, before, kind }) => {
      const { matches, insight } = await recallEntries({ query, topK, tag, after, before, kind: kind as MemoryKind | undefined }, env, ctx);

      if (!matches.length) {
        return { content: [{ type: "text", text: "Nothing found matching that query." }] };
      }

      const text = matches.map((m, i) => {
        const date = new Date(m.createdAt).toLocaleDateString();
        const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        const src = m.source ? ` · ${m.source}` : "";
        const score = (m.score * 100).toFixed(0);
        const updateLabel = m.isUpdate ? " [updated]" : "";
        return `${i + 1}. [${date}${src}${tagList}] (${score}% match)${updateLabel}\n${m.content}`;
      }).join("\n\n");

      const finalText = insight ? `**Insight:** ${insight}\n\n---\n\n${text}` : text;
      return { content: [{ type: "text", text: finalText }] };
    }
  );

  // ── list_recent ──────────────────────────────────────────────────────────
  server.registerTool(
    "list_recent",
    {
      description: "list_recent: List the most recent entries by date from your second brain. Use when you need to browse recent entries or find an entry ID. Not the same as recall — returns entries by time, not by meaning.",
      inputSchema: {
        n: z.number().int().min(1).max(50).default(10),
        tag: z.string().optional(),
        after: z.number().int().optional().describe("Only return entries after this Unix ms timestamp"),
        before: z.number().int().optional().describe("Only return entries before this Unix ms timestamp"),
      },
    },
    async ({ n, tag, after, before }) => {
      const { sql, bindings } = buildEntryFilterQuery({ n, tag, after, before });
      const { results } = await env.DB.prepare(sql).bind(...bindings).all();

      if (!results.length) {
        return { content: [{ type: "text", text: "No entries found." }] };
      }

      const text = (results as Record<string, any>[]).map((row, i) => {
        const date = new Date(row.created_at as number).toLocaleDateString();
        const tags: string[] = JSON.parse(row.tags ?? "[]");
        const tagStr = tags.length ? ` · ${tags.join(", ")}` : "";
        return `${i + 1}. [${date} · ${row.source}${tagStr}]\nID: ${row.id as string}\n${row.content}`;
      }).join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ── forget ───────────────────────────────────────────────────────────────
  server.registerTool(
    "forget",
    {
      description: "Permanently delete an entry from your second brain by ID. Only call when the user explicitly asks to delete something. Confirm the entry ID using recall or list_recent first. This action cannot be undone.",
      inputSchema: {
        id: z.string().describe("Entry ID from recall or list_recent"),
      },
    },
    async ({ id }) => {
      const result = await forgetEntry(id, env);
      if (result.status === "not_found") {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }
      return { content: [{ type: "text", text: `Deleted entry ${id} and ${result.vectorCount} vector(s)` }] };
    }
  );

  return server;
}

// ─── OAuth API handler — /mcp only ────────────────────────────────────────────
// OAuthProvider validates the token (OAuth grant, or the static AUTH_TOKEN via
// resolveExternalToken) before delegating to this handler.

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withRequestTelemetry(request, env, ctx, async () => {
      await ensureDatabase(env);
      const server = buildMcpServer(env, ctx);
      return createMcpHandler(server)(request, env, ctx);
    });
  },
};

// ─── Default handler — all non-MCP routes ────────────────────────────────────

async function withRequestTelemetry(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  handler: () => Promise<Response>
): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const traceId = request.headers.get("x-trace-id") || newTraceId();
  const config = await loadTelemetryConfig(env);
  bindTelemetryDb(env.DB);

  let reqPreview: string | null = null;
  let reqHash: string | null = null;
  let requestBytes = 0;
  try {
    const clone = request.clone();
    const text = await clone.text().catch(() => "");
    requestBytes = new TextEncoder().encode(text).length;
    const p = previewText(text, config.contentLogging, config.previewMaxChars);
    reqPreview = p.preview;
    reqHash = p.hash;
  } catch {
    /* ignore */
  }

  const source =
    request.headers.get("x-sb-source") ||
    request.headers.get("user-agent")?.slice(0, 80) ||
    "api";

  return runWithTelemetryAsync(
    { traceId, config, db: env.DB, source },
    async () => {
      let response: Response;
      try {
        response = await handler();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logRequest({
          trace_id: traceId,
          method: request.method,
          route: url.pathname,
          operation: routeToOperation(request.method, url.pathname),
          source,
          status_code: 500,
          success: 0,
          started_at: started,
          duration_ms: Date.now() - started,
          request_bytes: requestBytes,
          response_bytes: 0,
          content_preview: reqPreview,
          content_hash: reqHash,
          error_code: "handler_error",
          error_message: msg.slice(0, 500),
        });
        ctx.waitUntil(flushTelemetry(env.DB));
        throw e;
      }

      const duration = Date.now() - started;
      const success = response.status < 400 ? 1 : 0;
      let responseBytes = 0;
      try {
        const cl = response.headers.get("content-length");
        if (cl) responseBytes = parseInt(cl, 10) || 0;
      } catch {
        /* ignore */
      }

      logRequest({
        trace_id: traceId,
        method: request.method,
        route: url.pathname,
        operation: routeToOperation(request.method, url.pathname),
        source,
        status_code: response.status,
        success,
        started_at: started,
        duration_ms: duration,
        request_bytes: requestBytes,
        response_bytes: responseBytes,
        content_preview: reqPreview,
        content_hash: reqHash,
        error_code: success ? null : `http_${response.status}`,
        error_message: success ? null : response.statusText || null,
      });

      // Non-blocking flush
      ctx.waitUntil(flushTelemetry(env.DB));

      // Expose trace id to clients
      const headers = new Headers(response.headers);
      headers.set("x-trace-id", traceId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  );
}

const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withRequestTelemetry(request, env, ctx, async () => {
    const url = new URL(request.url);

    // OAuth authorize endpoint — hosted login page for browser-based MCP clients.
    if (url.pathname === "/oauth/authorize") {
      let oauthReq: any;
      try {
        // workers-oauth-provider mis-parses POST bodies; pass a URL-only GET clone
        // so parseAuthRequest reads the query params cleanly.
        const parseReq = request.method === "POST" ? new Request(request.url, { method: "GET" }) : request;
        oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(parseReq);
      } catch {
        return new Response("Invalid authorization request — this page must be opened by an MCP client.", {
          status: 400, headers: { "Content-Type": "text/plain" },
        });
      }
      if (request.method === "POST") {
        const form = await request.formData();
        if (form.get("password") !== env.AUTH_TOKEN) {
          return new Response(loginHtml("Invalid token"), {
            status: 401, headers: { "Content-Type": "text/html" },
          });
        }
        const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: "owner",
          scope: oauthReq.scope,
          props: { userId: "owner" },
        });
        return Response.redirect(redirectTo, 302);
      }
      return new Response(loginHtml(), { headers: { "Content-Type": "text/html" } });
    }

    await ensureDatabase(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // POST /capture
    if (url.pathname === "/capture" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { content?: string; tags?: string[]; source?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);

      const result = await captureEntry(body.content, body.tags ?? [], body.source ?? "api", env, ctx);

      if (result.status === "blocked") {
        return json({
          ok: false,
          duplicate: true,
          matchId: result.matchId,
          score: parseFloat((result.score * 100).toFixed(1)),
          message: "Near-exact duplicate detected — not stored",
        });
      }
      if (result.status === "contradiction") {
        return json({ ok: true, id: result.id, resolved_conflict: result.resolvedConflict, reason: result.reason });
      }
      if (result.status === "contradiction_protected") {
        return json({ ok: true, id: result.id, status: "draft", kept_canonical: result.canonicalId, reason: result.reason });
      }
      if (result.status === "replaced") {
        return json({ ok: true, id: result.id, action: "replaced", message: "New memory replaced an outdated existing entry" });
      }
      if (result.status === "merged") {
        return json({ ok: true, id: result.id, action: "merged", message: "Memories merged into a single combined entry" });
      }
      if (result.status === "flagged") {
        return json({
          ok: true,
          id: result.id,
          warning: "similar",
          matchId: result.matchId,
          score: parseFloat((result.score * 100).toFixed(1)),
          message: "Stored but similar entry exists — tagged as duplicate-candidate",
        });
      }
      return json({ ok: true, id: result.id });
    }

    // POST /append
    if (url.pathname === "/append" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { id?: string; addition?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
      if (!body.addition?.trim()) return json({ ok: false, error: "addition is required" }, 400);

      const id = body.id.trim();
      const addition = body.addition.trim();

      const row = await env.DB.prepare(
        `SELECT id, content, tags, source FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
      }

      const existingContent = row.content as string;
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const source = row.source as string;

      try {
        await appendToEntry(env, id, existingContent, addition, tags, source);
      } catch (e) {
        return json({ ok: false, error: `Append failed: ${(e as Error).message}` }, 500);
      }

      return json({
        ok: true,
        id,
        message: "Update appended successfully with timestamp",
      });
    }

    // POST /update
    if (url.pathname === "/update" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { id?: string; content?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
      if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);

      const id = body.id.trim();
      const newContent = body.content.trim();

      const row = await env.DB.prepare(
        `SELECT tags, source, vector_ids FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);

      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const { cleanContent, hashtags: newHashtags } = extractHashtags(newContent);
      const mergedTags = [...new Set([...tags, ...newHashtags])];
      const source = row.source as string;
      const oldVectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
      const finalContent = cleanContent || newContent;

      await env.DB.prepare(`UPDATE entries SET content = ?, tags = ? WHERE id = ?`)
        .bind(finalContent, JSON.stringify(mergedTags), id).run();

      let newVectorIds: string[] = [];
      try {
        newVectorIds = await storeEntry(env, id, finalContent, mergedTags, source, Date.now());
      } catch (e) {
        console.error("Vectorize re-embed failed (non-fatal):", e);
      }
      const newVectorCount = newVectorIds.length;

      try {
        await deleteStaleVectors(env, oldVectorIds, newVectorIds);
      } catch (e) {
        console.error("Old vector cleanup failed (non-fatal):", e);
      }

      return json({ ok: true, id, vectors: newVectorCount });
    }

    // GET /count
    if (url.pathname === "/count" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const row = await env.DB.prepare(`SELECT COUNT(*) as count FROM entries`).first() as Record<string, any> | null;
      return json({ count: (row?.count as number) ?? 0 });
    }

    // GET /tags
    if (url.pathname === "/tags" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`
      ).all();
      return json((results as any[]).map(r => r.value as string));
    }

    // GET /stats
    if (url.pathname === "/stats" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const graceCutoff = Date.now() - graceMs(env);
      const [summary, tagRows, candidateRows] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) as count, AVG(importance_score) as avg_importance,
           SUM(CASE WHEN vector_ids = '[]' AND created_at < ? THEN 1 ELSE 0 END) as unvectorized,
           SUM(CASE WHEN tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%' THEN 1 ELSE 0 END) as unclassified
           FROM entries`
        ).bind(graceCutoff).first() as Promise<Record<string, any> | null>,
        env.DB.prepare(`SELECT value, COUNT(*) as n FROM entries, json_each(entries.tags) GROUP BY value ORDER BY n DESC LIMIT 5`).all(),
        env.DB.prepare(`
          SELECT value as tag, COUNT(*) as count
          FROM entries, json_each(entries.tags)
          WHERE value NOT IN ('synthesized', 'auto-pattern', 'duplicate-candidate', 'contradiction-resolved', 'rolled-up')
            AND value NOT LIKE 'status:%'
            AND value NOT LIKE 'kind:%'
            AND entries.tags NOT LIKE '%"rolled-up"%'
            AND entries.tags NOT LIKE '%"synthesized"%'
            AND entries.tags NOT LIKE '%"auto-pattern"%'
            AND ${compressionEligibilitySql("entries.")}
          GROUP BY value
          HAVING count > 10
          ORDER BY count DESC
          LIMIT 10
        `).bind(Date.now() - COMPRESSION_MIN_AGE_MS).all(),
      ]);

      const cutoff = Date.now() - 86400000;
      const digestCandidates: { tag: string; count: number }[] = [];
      for (const row of candidateRows.results as any[]) {
        const existing = await env.DB.prepare(
          `SELECT id FROM entries WHERE tags LIKE '%"synthesized"%' AND tags LIKE ? AND created_at > ? LIMIT 1`
        ).bind(`%"${row.tag}"%`, cutoff).first();
        if (!existing) digestCandidates.push({ tag: row.tag as string, count: row.count as number });
      }

      return json({
        count: (summary?.count as number) ?? 0,
        avg_importance: summary?.avg_importance != null ? Math.round((summary.avg_importance as number) * 10) / 10 : null,
        top_tags: (tagRows.results as any[]).map(r => r.value as string),
        digest_candidates: digestCandidates,
        unvectorized: (summary?.unvectorized as number) ?? 0,
        vectorize_grace_ms: graceMs(env),
        unclassified: (summary?.unclassified as number) ?? 0,
      });
    }

    // GET /list
    if (url.pathname === "/list" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const n = Math.min(parseInt(url.searchParams.get("n") ?? "20", 10), 100);
      const tag = url.searchParams.get("tag")?.trim() || undefined;
      const after = url.searchParams.has("after") ? parseInt(url.searchParams.get("after")!, 10) : undefined;
      const before = url.searchParams.has("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined;

      const { sql, bindings } = buildEntryFilterQuery({ n, tag, after, before });
      const { results } = await env.DB.prepare(sql).bind(...bindings).all();
      return json(results);
    }

    // GET /export — paginated full backup (not capped at list's 100)
    // Query: limit (1–500, default 200), cursor = `${created_at}:${id}` of last row
    if (url.pathname === "/export" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      const limit = Math.min(
        Math.max(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1),
        500
      );
      const cursor = url.searchParams.get("cursor")?.trim() || "";

      const countRow = await env.DB.prepare(`SELECT COUNT(*) as count FROM entries`).first() as {
        count: number;
      } | null;
      const total = Number(countRow?.count ?? 0);

      let results: Record<string, any>[];
      if (cursor) {
        const [cAtRaw, ...idParts] = cursor.split(":");
        const cAt = parseInt(cAtRaw, 10);
        const cId = idParts.join(":");
        if (!Number.isFinite(cAt) || !cId) {
          return json({ ok: false, error: "Invalid cursor" }, 400);
        }
        const q = await env.DB.prepare(
          `SELECT id, content, tags, source, created_at, vector_ids,
                  recall_count, importance_score, contradiction_wins, contradiction_losses
           FROM entries
           WHERE created_at < ? OR (created_at = ? AND id < ?)
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        ).bind(cAt, cAt, cId, limit).all();
        results = (q.results || []) as Record<string, any>[];
      } else {
        const q = await env.DB.prepare(
          `SELECT id, content, tags, source, created_at, vector_ids,
                  recall_count, importance_score, contradiction_wins, contradiction_losses
           FROM entries
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        ).bind(limit).all();
        results = (q.results || []) as Record<string, any>[];
      }

      const last = results[results.length - 1];
      const nextCursor =
        results.length === limit && last
          ? `${last.created_at}:${last.id}`
          : null;

      return json({
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        source: env.SELFHOST === "1" ? "selfhost" : "cloudflare",
        total,
        count: results.length,
        nextCursor,
        entries: results,
      });
    }

    // GET /recall — semantic search, mirrors the MCP `recall` tool
    if (url.pathname === "/recall" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      const query = url.searchParams.get("query")?.trim();
      if (!query) return json({ ok: false, error: "query is required" }, 400);

      const topK = Math.min(Math.max(parseInt(url.searchParams.get("topK") ?? "5", 10), 1), 20);
      const tag = url.searchParams.get("tag")?.trim() || undefined;
      const after = url.searchParams.has("after") ? parseInt(url.searchParams.get("after")!, 10) : undefined;
      const before = url.searchParams.has("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined;
      const kindParam = url.searchParams.get("kind")?.trim();
      const kind = kindParam && (KIND_VALUES as readonly string[]).includes(kindParam) ? kindParam as MemoryKind : undefined;

      const { matches, insight } = await recallEntries({ query, topK, tag, after, before, kind }, env, ctx);

      if (!matches.length) {
        return json({ ok: true, results: [], message: "Nothing found matching that query." });
      }

      return json({
        ok: true,
        results: matches.map(m => ({
          id: m.id,
          content: m.content,
          score: parseFloat((m.score * 100).toFixed(1)),
          tags: m.tags,
          source: m.source,
          created_at: m.createdAt,
          updated: m.isUpdate,
        })),
        insight: insight || null,
      });
    }

    // POST /forget — delete-by-id, mirrors the MCP `forget` tool
    if (url.pathname === "/forget" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { id?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

      const id = body.id.trim();
      const result = await forgetEntry(id, env);

      if (result.status === "not_found") {
        return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
      }

      return json({ ok: true, id, deletedVectors: result.vectorCount });
    }

    // POST /status — set lifecycle status, mirrors the MCP `set_status` tool
    if (url.pathname === "/status" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { id?: string; status?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
      if (!(STATUS_VALUES as readonly string[]).includes(body.status ?? "")) {
        return json({ ok: false, error: `status must be one of: ${STATUS_VALUES.join(", ")}` }, 400);
      }

      const id = body.id.trim();
      const status = body.status as MemoryStatus;
      const ok = await applyStatus(id, status, env);

      if (!ok) {
        return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
      }

      return json({ ok: true, id, status });
    }

    // POST /chat
    if (url.pathname === "/chat" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { query?: string; memories?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.query?.trim()) return json({ ok: false, error: "query is required" }, 400);

      const systemPrompt = `You are a personal memory assistant. Answer the user's question using ONLY the memories provided. Even if the match scores are low, extract any relevant facts and answer directly. Never say you don't have enough information if the answer exists anywhere in the memories. Be concise.`;

      const userMessage = `Question: ${body.query}\n\nRelevant memories:\n${body.memories}`;

      // CF-compatible SSE (`data: {"response":...}`) so the existing dashboard parser works
      // for both Workers AI and OpenAI-compatible providers.
      const stream = await (await createLLM(env)).chatAsCfSse([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ]);

      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", ...CORS_HEADERS },
      });
    }

    // GET /digest
    if (url.pathname === "/digest" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const tag = url.searchParams.get("tag")?.trim();
      if (!tag) return json({ ok: false, error: "tag parameter is required" }, 400);

      const result = await compressTag(tag, env, ctx);

      if (!result.synthesizedId) {
        return json({ tag, error: "Could not create digest — tag may have fewer than 20 entries or was recently compressed", source_count: result.entriesUsed });
      }

      return json({ tag, synthesis: result.text, entry_id: result.synthesizedId, source_count: result.entriesUsed });
    }

    // POST /vectorize-pending
    if (url.pathname === "/vectorize-pending" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: { limit?: number; includeRecent?: boolean } = {};
      try {
        body = await request.json();
      } catch {
        /* empty body OK */
      }
      const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 200);
      // includeRecent: skip grace window (imports / full reindex)
      const graceCutoff = body.includeRecent
        ? Date.now() + 86_400_000
        : Date.now() - graceMs(env);

      const { results: toProcess } = await env.DB.prepare(
        `SELECT id, content, tags, source, created_at FROM entries
         WHERE vector_ids = '[]' AND created_at < ?
         ORDER BY created_at DESC LIMIT ?`
      ).bind(graceCutoff, limit).all();

      let processed = 0;
      let failed = 0;

      for (const row of toProcess as Record<string, any>[]) {
        try {
          await storeEntry(
            env,
            row.id as string,
            row.content as string,
            JSON.parse(row.tags as string),
            row.source as string,
            row.created_at as number
          );
          processed++;
        } catch (e) {
          console.error("Re-embed failed for entry", row.id, e);
          failed++;
        }
      }

      const remaining = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM entries WHERE vector_ids = '[]' AND created_at < ?`
      ).bind(graceCutoff).first() as Record<string, any> | null;
      const remainingN = (remaining?.count as number) ?? 0;

      // Promote pending embedding fingerprint when full reindex completes cleanly
      if (remainingN === 0 && failed === 0) {
        try {
          const stored = await loadStoredModelSettings(env.DB);
          if (stored?.pendingEmbeddingFingerprint) {
            await saveStoredModelSettings(env.DB, promoteEmbeddingFingerprint(stored));
          }
        } catch (e) {
          console.error("Fingerprint promote failed:", e);
        }
      }

      return json({
        processed,
        failed,
        remaining: remainingN,
        limit,
      });
    }

    // POST /classify-pending
    // One-time, opt-in backfill: runs classifyEntry over entries that predate the
    // status (#119) and kind (#12) features and writes status:/kind: tags. Bounded
    // batch per call, idempotent (skips entries that already carry either tag), and
    // resumable (safe to stop/restart). No schema migration — only writes tags.
    if (url.pathname === "/classify-pending" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      const UNCLASSIFIED_WHERE = `tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%'`;

      const { results: toProcess } = await env.DB.prepare(
        `SELECT id, content, tags FROM entries
         WHERE ${UNCLASSIFIED_WHERE}
         ORDER BY created_at ASC LIMIT 25`
      ).all();

      let processed = 0;
      let failed = 0;

      for (const row of toProcess as Record<string, any>[]) {
        try {
          const { canonical, kind } = await classifyEntry(row.content as string, env);
          let tags: string[] = JSON.parse(row.tags as string);
          if (kind) tags = withKind(tags, kind);
          if (canonical && getStatus(tags) === null) tags = withStatus(tags, "canonical");
          await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(tags), row.id).run();
          processed++;
        } catch (e) {
          console.error("Classification backfill failed for entry", row.id, e);
          failed++;
        }
      }

      const remaining = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM entries WHERE ${UNCLASSIFIED_WHERE}`
      ).first() as Record<string, any> | null;

      return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
    }

    // POST /import — Cloudflare / dashboard JSON export → entries (vector_ids cleared)
    if (url.pathname === "/import" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      let entries: unknown[];
      try {
        // Body may be raw array, { entries }, or { entries, mode, extraTags }
        if (body && typeof body === "object" && !Array.isArray(body) && "entries" in (body as object)) {
          entries = parseImportPayload(body);
        } else {
          entries = parseImportPayload(body);
        }
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
      }

      const opts = (body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {}) as {
        mode?: ImportMode;
        extraTags?: string[];
      };

      const result = await importEntries(env.DB, entries, {
        mode: opts.mode === "overwrite" ? "overwrite" : "skip",
        extraTags: Array.isArray(opts.extraTags)
          ? opts.extraTags.map(String)
          : ["cf-import"],
      });

      return json({
        ...result,
        // Back-compat for older UI that expected pendingVectorize[]
        pendingVectorize: result.pendingVectorizeSample,
        next:
          result.pendingVectorizeCount > 0
            ? "Run POST /vectorize-pending with { limit, includeRecent: true } in a loop until remaining=0."
            : undefined,
      });
    }

    // ── Control plane: model settings ───────────────────────────────────────
    if (url.pathname === "/settings/models" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      await ensureSettingsTable(env.DB);
      const { effective, stored } = await getEffectiveModelSettings(env);
      return json(
        toPublicModelSettings(effective, {
          hasStored: Boolean(stored),
          hasEnvLlm: Boolean(env.LLM_BASE_URL && env.LLM_API_KEY),
          hasEnvEmbed: Boolean(env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY),
          allowDevEmbedding:
            env.ALLOW_DEV_EMBEDDING === "1" || env.ALLOW_DEV_EMBEDDING === "true",
        })
      );
    }

    // PUT /settings/models — save control-plane config (runtime, no restart)
    if (url.pathname === "/settings/models" && request.method === "PUT") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: ModelSettingsPatchBody & { force?: boolean };
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      const previous =
        (await loadStoredModelSettings(env.DB)) ?? mergeFromEnvOnly(env);

      // Switching provider without a new key is not allowed (prevents wrong-key reuse)
      if (
        body.llm?.provider &&
        body.llm.provider !== previous.llm.provider &&
        body.llm.provider !== "none" &&
        !body.llm.clearApiKey
      ) {
        const k = body.llm.apiKey != null ? String(body.llm.apiKey) : "";
        if (!k || isMaskedSecret(k)) {
          return json(
            {
              ok: false,
              error: "切换对话供应商后必须填写新的 API Key",
            },
            400
          );
        }
      }
      if (
        body.embedding?.provider &&
        body.embedding.provider !== previous.embedding.provider &&
        body.embedding.provider !== "none" &&
        !isDevLocalProvider(String(body.embedding.provider)) &&
        !body.embedding.clearApiKey
      ) {
        const k = body.embedding.apiKey != null ? String(body.embedding.apiKey) : "";
        if (!k || isMaskedSecret(k)) {
          return json(
            {
              ok: false,
              error: "切换向量供应商后必须填写新的 API Key",
            },
            400
          );
        }
      }

      const next = applyModelSettingsPatch(previous, body);

      if (
        isDevLocalProvider(next.embedding.provider) &&
        env.ALLOW_DEV_EMBEDDING !== "1" &&
        env.ALLOW_DEV_EMBEDDING !== "true"
      ) {
        return json(
          {
            ok: false,
            error:
              "local-hash-dev requires ALLOW_DEV_EMBEDDING=true. Do not use for production memory.",
          },
          400
        );
      }

      const nextFp = embeddingFingerprintOf(next.embedding);
      const activeFp = previous.embeddingFingerprint;
      const embConfigChanged =
        nextFp !== embeddingFingerprintOf(previous.embedding) ||
        nextFp !== activeFp;

      // Never stamp active fingerprint on ordinary save — only pending when changed
      if (!activeFp && !isDevLocalProvider(next.embedding.provider)) {
        // First-time embed config: mark as pending until first reindex/vectorize completes
        next.pendingEmbeddingFingerprint = nextFp;
        if (!next.embeddingFingerprint) {
          // No existing vectors assumed — activate immediately
          next.embeddingFingerprint = nextFp;
          next.pendingEmbeddingFingerprint = undefined;
        }
      } else if (embConfigChanged) {
        next.pendingEmbeddingFingerprint = nextFp;
        // keep previous embeddingFingerprint (active) until reindex finishes
        next.embeddingFingerprint = previous.embeddingFingerprint;
      }

      await saveStoredModelSettings(env.DB, next);

      const { effective, stored } = await getEffectiveModelSettings(env);
      const reindexRequired = Boolean(
        effective.pendingEmbeddingFingerprint &&
          effective.pendingEmbeddingFingerprint !== effective.embeddingFingerprint
      );
      return json({
        ok: true,
        embeddingFingerprintChanged: reindexRequired,
        reindexRequired,
        warning: reindexRequired
          ? "向量配置已变更。请点击「开始重建」或 POST /settings/models/reindex，再循环调用 vectorize-pending，完成前语义检索可能不准确。"
          : undefined,
        settings: toPublicModelSettings(effective, {
          hasStored: Boolean(stored),
          hasEnvLlm: Boolean(env.LLM_BASE_URL && env.LLM_API_KEY),
          hasEnvEmbed: Boolean(env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY),
          allowDevEmbedding:
            env.ALLOW_DEV_EMBEDDING === "1" || env.ALLOW_DEV_EMBEDDING === "true",
        }),
      });
    }

    // POST /settings/models/test — probe candidate config WITHOUT saving
    if (url.pathname === "/settings/models/test" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      let body: ModelSettingsPatchBody & { target?: string };
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const target = body.target === "embedding" ? "embedding" : "llm";

      let probeMeta: {
        provider: string;
        baseURL: string;
        model: string;
        hasApiKey: boolean;
        apiKeyLen: number;
      } | null = null;
      try {
        const previous =
          (await loadStoredModelSettings(env.DB)) ?? mergeFromEnvOnly(env);
        const candidate = applyModelSettingsPatch(previous, body);
        // Empty candidate keys fall back to previous via patch; overlay for probe
        const probeEnv = overlayProviderEnvFromSettings(env, candidate);
        // Don't require DB resolve for candidate probe (avoid clobbering with stored)
        const { DB: _db, ...probeWithoutDb } = probeEnv as Env & { DB?: D1Database };

        // Safe diagnostics for UI (never include raw secrets)
        probeMeta =
          target === "embedding"
            ? {
                provider: candidate.embedding.provider || "",
                baseURL: candidate.embedding.baseURL || "",
                model: candidate.embedding.model || "",
                hasApiKey: Boolean(candidate.embedding.apiKey),
                apiKeyLen: candidate.embedding.apiKey
                  ? candidate.embedding.apiKey.length
                  : 0,
              }
            : {
                provider: candidate.llm.provider || "",
                baseURL: candidate.llm.baseURL || "",
                model: candidate.llm.model || "",
                hasApiKey: Boolean(candidate.llm.apiKey),
                apiKeyLen: candidate.llm.apiKey ? candidate.llm.apiKey.length : 0,
              };

        if (target === "embedding") {
          if (
            isDevLocalProvider(candidate.embedding.provider) &&
            env.ALLOW_DEV_EMBEDDING !== "1" &&
            env.ALLOW_DEV_EMBEDDING !== "true"
          ) {
            throw new Error("local-hash-dev requires ALLOW_DEV_EMBEDDING=true");
          }
          if (
            !isDevLocalProvider(candidate.embedding.provider) &&
            (!candidate.embedding.baseURL || !candidate.embedding.apiKey)
          ) {
            throw new Error(
              `向量未配置完整：baseURL=${candidate.embedding.baseURL || "(空)"} hasKey=${Boolean(candidate.embedding.apiKey)}。请填写 Base URL 并粘贴 API Key 后再测。`
            );
          }
          const emb = await createEmbedding(probeWithoutDb as Env);
          const vector = await emb.embed("second brain settings probe");
          return json({
            ok: true,
            target,
            dimensions: vector.length,
            sample: vector.slice(0, 3),
            saved: false,
            probe: probeMeta,
          });
        }
        if (!candidate.llm.baseURL || !candidate.llm.apiKey) {
          throw new Error(
            `对话未配置完整：baseURL=${candidate.llm.baseURL || "(空)"} hasKey=${Boolean(candidate.llm.apiKey)} keyLen=${probeMeta.apiKeyLen}。切换供应商后必须重新粘贴 API Key，再点测试。`
          );
        }
        const llm = await createLLM(probeWithoutDb as Env);
        // max_tokens 略大：部分模型默认 thinking 会占额度；temperature 用 1 兼容 MiniMax 推荐区间
        const reply = await llm.chat(
          [{ role: "user", content: "Reply with exactly the word: ok" }],
          { max_tokens: 64, temperature: 1 }
        );
        return json({
          ok: true,
          target,
          reply: reply.trim().slice(0, 200),
          saved: false,
          probe: probeMeta,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json(
          {
            ok: false,
            target,
            error: msg,
            saved: false,
            probe: probeMeta || undefined,
            // help UI distinguish "our 400" vs auth / empty body
            hint:
              msg.includes("2049") || msg.includes("无效的 API")
                ? "MiniMax 拒钥：检查 Key 是否来自同一区域（国内 minimaxi.com / 国际 minimax.io），并确认是开放平台「接口密钥」而非过期/错误复制。"
                : msg.includes("No LLM configured")
                  ? "未读到 LLM_BASE_URL+LLM_API_KEY：请在表单填写 Base URL 与 Key 后再测。"
                  : undefined,
          },
          400
        );
      }
    }

    // POST /settings/models/reindex — clear vectors + reset vector_ids; fingerprint stays pending until vectorize completes
    if (url.pathname === "/settings/models/reindex" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;

      const { effective, stored } = await getEffectiveModelSettings(env);
      if (stored) {
        const pending = embeddingFingerprintOf(effective.embedding);
        stored.pendingEmbeddingFingerprint = pending;
        // Do NOT promote active fingerprint here — wait until remaining=0
        await saveStoredModelSettings(env.DB, stored);
      }

      let clearedVectors = 0;
      try {
        const clear = (env.VECTORIZE as any).clearAll;
        if (typeof clear === "function") {
          clearedVectors = await clear.call(env.VECTORIZE);
        }
      } catch (e) {
        console.error("Vector clear failed:", e);
      }

      const update = await env.DB.prepare(
        `UPDATE entries SET vector_ids = '[]'`
      ).run();
      const rows = (update as any)?.meta?.changes ?? 0;

      return json({
        ok: true,
        clearedVectors,
        entriesReset: rows,
        reindexRequired: true,
        pendingFingerprint:
          stored?.pendingEmbeddingFingerprint ?? embeddingFingerprintOf(effective.embedding),
        next: "Loop POST /vectorize-pending {\"limit\":100,\"includeRecent\":true} until remaining=0. Active fingerprint promotes only when finished with failed=0.",
      });
    }

    // GET /settings/telemetry — privacy and retention controls
    if (url.pathname === "/settings/telemetry" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      return json({ ok: true, telemetry: await loadTelemetryConfig(env) });
    }

    // PUT /settings/telemetry — validate before persisting user-controlled values
    if (url.pathname === "/settings/telemetry" && request.method === "PUT") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ ok: false, error: "telemetry config must be an object" }, 400);
      }
      const current = await loadTelemetryConfig(env);
      const config = normalizeTelemetryConfig({
        ...current,
        ...(body as Partial<TelemetryConfig>),
      });
      await saveTelemetryConfig(env, config);
      return json({ ok: true, telemetry: config });
    }

    // GET /analytics/overview — Observatory KPIs (last 24h by default)
    if (url.pathname === "/analytics/overview" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      await ensureTelemetryTables(env.DB);
      const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") ?? "24", 10) || 24, 1), 168);
      const since = Date.now() - hours * 3_600_000;

      const [reqStats, modelStats, memStats, latencyRows, topOps] = await Promise.all([
        env.DB.prepare(
        `SELECT COUNT(*) as n,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors,
                AVG(duration_ms) as avg_ms,
                MAX(duration_ms) as max_ms
         FROM sb_request_logs WHERE started_at >= ?`
        ).bind(since).first<Record<string, unknown>>(),
        env.DB.prepare(
          `SELECT COUNT(*) as n,
                  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
                  SUM(COALESCE(input_tokens, 0)) as input_tokens,
                  SUM(COALESCE(output_tokens, 0)) as output_tokens,
                  SUM(COALESCE(total_tokens, 0)) as tokens,
                  SUM(estimated_cost_usd) as cost_usd,
                  AVG(duration_ms) as avg_ms
           FROM sb_model_calls WHERE created_at >= ?`
        ).bind(since).first<Record<string, unknown>>(),
        env.DB.prepare(
          `SELECT
             SUM(CASE WHEN event_type = 'created' THEN 1 ELSE 0 END) as created,
             SUM(CASE WHEN event_type = 'recalled' THEN 1 ELSE 0 END) as recalled
           FROM sb_memory_events WHERE created_at >= ?`
        ).bind(since).first<Record<string, unknown>>(),
        env.DB.prepare(
          `SELECT duration_ms FROM sb_request_logs WHERE started_at >= ? AND success = 1`
        ).bind(since).all<{ duration_ms: number }>(),
        env.DB.prepare(
          `SELECT operation, COUNT(*) as n, AVG(duration_ms) as avg_ms
           FROM sb_request_logs WHERE started_at >= ?
           GROUP BY operation ORDER BY n DESC LIMIT 10`
        ).bind(since).all(),
      ]);

      const n = Number(reqStats?.n ?? 0);
      const errors = Number(reqStats?.errors ?? 0);
      const durations = (latencyRows.results ?? []).map((row) => Number(row.duration_ms));

      return json({
        ok: true,
        hours,
        requests: {
          count: n,
          errors,
          success_rate: n ? (n - errors) / n : 1,
          avg_ms: reqStats?.avg_ms ?? null,
          max_ms: reqStats?.max_ms ?? null,
          p95_ms: percentile(durations, 0.95),
        },
        models: {
          count: Number(modelStats?.n ?? 0),
          errors: Number(modelStats?.errors ?? 0),
          tokens: Number(modelStats?.tokens ?? 0),
          input_tokens: Number(modelStats?.input_tokens ?? 0),
          output_tokens: Number(modelStats?.output_tokens ?? 0),
          cost_usd: modelStats?.cost_usd == null ? null : Number(modelStats.cost_usd),
          avg_ms: modelStats?.avg_ms ?? null,
        },
        memories: {
          created: Number(memStats?.created ?? 0),
          recalled: Number(memStats?.recalled ?? 0),
        },
        top_operations: topOps.results ?? [],
        telemetry: await loadTelemetryConfig(env),
      });
    }

    // GET /analytics/timeseries — one point per hour for charts.
    if (url.pathname === "/analytics/timeseries" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      await ensureTelemetryTables(env.DB);
      const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") ?? "24", 10) || 24, 1), 168);
      const since = Date.now() - hours * 3_600_000;
      const [requests, models, memories, requestDurations] = await Promise.all([
        env.DB.prepare(
          `SELECT CAST(started_at / 3600000 AS INTEGER) * 3600000 AS bucket_at,
                  COUNT(*) AS requests,
                  SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors,
                  AVG(duration_ms) AS avg_ms
           FROM sb_request_logs WHERE started_at >= ?
           GROUP BY bucket_at ORDER BY bucket_at`
        ).bind(since).all(),
        env.DB.prepare(
          `SELECT CAST(created_at / 3600000 AS INTEGER) * 3600000 AS bucket_at,
                  SUM(CASE WHEN call_type = 'chat' THEN 1 ELSE 0 END) AS calls,
                  SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                  SUM(COALESCE(output_tokens, 0)) AS output_tokens,
                  SUM(estimated_cost_usd) AS cost_usd
           FROM sb_model_calls WHERE created_at >= ?
           GROUP BY bucket_at ORDER BY bucket_at`
        ).bind(since).all(),
        env.DB.prepare(
          `SELECT CAST(created_at / 3600000 AS INTEGER) * 3600000 AS bucket_at,
                  SUM(CASE WHEN event_type = 'created' THEN 1 ELSE 0 END) AS created,
                  SUM(CASE WHEN event_type = 'recalled' THEN 1 ELSE 0 END) AS recalled
           FROM sb_memory_events WHERE created_at >= ?
           GROUP BY bucket_at ORDER BY bucket_at`
        ).bind(since).all(),
        env.DB.prepare(
          `SELECT CAST(started_at / 3600000 AS INTEGER) * 3600000 AS bucket_at,
                  duration_ms
           FROM sb_request_logs WHERE started_at >= ? AND success = 1`
        ).bind(since).all(),
      ]);
      const points = new Map<number, Record<string, number>>();
      const point = (bucketAt: unknown) => {
        const bucket = Number(bucketAt);
        const current = points.get(bucket) ?? { bucket_at: bucket };
        points.set(bucket, current);
        return current;
      };
      for (const row of requests.results ?? []) {
        Object.assign(point(row.bucket_at), {
          requests: Number(row.requests ?? 0),
          errors: Number(row.errors ?? 0),
          avg_ms: Number(row.avg_ms ?? 0),
        });
      }
      for (const row of models.results ?? []) {
        Object.assign(point(row.bucket_at), {
          model_calls: Number(row.calls ?? 0),
          input_tokens: Number(row.input_tokens ?? 0),
          output_tokens: Number(row.output_tokens ?? 0),
          cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
        });
      }
      for (const row of memories.results ?? []) {
        Object.assign(point(row.bucket_at), {
          memories_created: Number(row.created ?? 0),
          memories_recalled: Number(row.recalled ?? 0),
        });
      }
      const durationsByBucket = new Map<number, number[]>();
      for (const row of requestDurations.results ?? []) {
        const bucket = Number(row.bucket_at);
        const durations = durationsByBucket.get(bucket) ?? [];
        durations.push(Number(row.duration_ms));
        durationsByBucket.set(bucket, durations);
      }
      for (const [bucket, durations] of durationsByBucket) {
        Object.assign(point(bucket), {
          p50_ms: percentile(durations, 0.5),
          p95_ms: percentile(durations, 0.95),
        });
      }
      return json({
        ok: true,
        hours,
        points: [...points.values()].sort((a, b) => a.bucket_at - b.bucket_at),
      });
    }

    // GET /analytics/logs — recent request logs
    if (url.pathname === "/analytics/logs" && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      await ensureTelemetryTables(env.DB);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
      const conditions = ["1 = 1"];
      const bindings: Array<string | number> = [];
      const op = url.searchParams.get("operation")?.trim();
      const source = url.searchParams.get("source")?.trim();
      const success = url.searchParams.get("success");
      const query = url.searchParams.get("q")?.trim();
      const traceId = url.searchParams.get("trace_id")?.trim();
      if (op) { conditions.push("operation = ?"); bindings.push(op); }
      if (source) { conditions.push("source = ?"); bindings.push(source); }
      if (success === "true" || success === "false") {
        conditions.push("success = ?");
        bindings.push(success === "true" ? 1 : 0);
      }
      if (query) { conditions.push("content_preview LIKE ?"); bindings.push(`%${query.slice(0, 100)}%`); }
      if (traceId) { conditions.push("trace_id = ?"); bindings.push(traceId.slice(0, 100)); }
      bindings.push(limit);
      const q = await env.DB.prepare(
        `SELECT * FROM sb_request_logs WHERE ${conditions.join(" AND ")}
         ORDER BY started_at DESC LIMIT ?`
      ).bind(...bindings).all();
      return json({ ok: true, logs: q.results ?? [] });
    }

    // GET /analytics/traces/:id
    if (url.pathname.startsWith("/analytics/traces/") && request.method === "GET") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      await ensureTelemetryTables(env.DB);
      const traceId = url.pathname.slice("/analytics/traces/".length);
      if (!traceId) return json({ ok: false, error: "trace id required" }, 400);
      const reqs = await env.DB.prepare(
        `SELECT * FROM sb_request_logs WHERE trace_id = ? ORDER BY started_at`
      ).bind(traceId).all();
      const models = await env.DB.prepare(
        `SELECT * FROM sb_model_calls WHERE trace_id = ? ORDER BY created_at`
      ).bind(traceId).all();
      const events = await env.DB.prepare(
        `SELECT * FROM sb_memory_events WHERE trace_id = ? ORDER BY created_at`
      ).bind(traceId).all();
      return json({
        ok: true,
        trace_id: traceId,
        requests: reqs.results ?? [],
        model_calls: models.results ?? [],
        memory_events: events.results ?? [],
      });
    }

    // POST /analytics/purge — drop old telemetry rows
    if (url.pathname === "/analytics/purge" && request.method === "POST") {
      const authErr = requireAuth(request, env);
      if (authErr) return authErr;
      const cfg = await loadTelemetryConfig(env);
      const result = await purgeOldTelemetry(env.DB, cfg.retentionDays);
      return json({ ok: true, ...result, retentionDays: cfg.retentionDays });
    }

    return new Response("Not found", { status: 404 });
    }); // withRequestTelemetry
  },
};

/** Seed stored-settings shape from env when first saving from control plane. */
function mergeFromEnvOnly(env: Env) {
  const base = emptyModelSettings();
  if (env.LLM_BASE_URL || env.LLM_API_KEY || env.LLM_MODEL) {
    base.llm = {
      provider: "custom",
      baseURL: env.LLM_BASE_URL || "",
      apiKey: env.LLM_API_KEY || "",
      model: env.LLM_MODEL || "",
    };
  }
  if (env.EMBEDDING_BASE_URL || env.EMBEDDING_API_KEY) {
    base.embedding = {
      provider: "custom",
      baseURL: env.EMBEDDING_BASE_URL || "",
      apiKey: env.EMBEDDING_API_KEY || "",
      model: env.EMBEDDING_MODEL || "",
      dimensions: parseInt(env.EMBEDDING_DIM || "384", 10) || 384,
    };
    base.embeddingFingerprint = embeddingFingerprintOf(base.embedding);
  } else if (
    isDevLocalProvider(env.EMBEDDING_PROVIDER) &&
    (env.ALLOW_DEV_EMBEDDING === "1" || env.ALLOW_DEV_EMBEDDING === "true")
  ) {
    base.embedding = {
      provider: "local-hash-dev",
      baseURL: "",
      apiKey: "",
      model: "local-hash",
      dimensions: parseInt(env.EMBEDDING_DIM || "384", 10) || 384,
    };
  }
  return base;
}

// ─── Export ───────────────────────────────────────────────────────────────────
// Wrap both handlers in OAuthProvider. It auto-serves the OAuth metadata,
// /oauth/token, and /oauth/register (RFC 7591) endpoints, and gates /mcp.
// The scheduled handler runs the nightly compression cron alongside the fetch handler.
//
// We intercept OAuth discovery ourselves so ChatGPT / MCP clients always get a
// correct HTTPS issuer even when the reverse proxy mangles request.url
// (common: http://host:443). Endpoints stay at the site root:
//   GET /.well-known/oauth-authorization-server
//   GET /.well-known/oauth-protected-resource[/mcp]

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // Accept the static AUTH_TOKEN for Claude Desktop + mcp-remote (no browser flow).
  resolveExternalToken: async ({ token, env }) => {
    if (token === (env as Env).AUTH_TOKEN) {
      return { props: { userId: "owner" } };
    }
    return null;
  },
});

async function handleOAuthDiscovery(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    if (
      isOAuthAuthorizationServerWellKnown(path) ||
      isOAuthProtectedResourceWellKnown(path)
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, *",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const origin = resolvePublicOrigin(request, env as Env & { PUBLIC_URL?: string });

  if (isOAuthAuthorizationServerWellKnown(path)) {
    return oauthJson(buildAuthorizationServerMetadata(origin));
  }
  if (isOAuthProtectedResourceWellKnown(path)) {
    const resourcePath = resourcePathFromProtectedWellKnown(path);
    return oauthJson(buildProtectedResourceMetadata(origin, resourcePath));
  }
  return null;
}

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    // 1) Discovery must work before OAuthProvider / static routing
    const discovery = await handleOAuthDiscovery(req, env);
    if (discovery) return discovery;

    // 2) Normalize origin so token WWW-Authenticate + redirects use public HTTPS
    const normalized = rewriteRequestPublicOrigin(req, env as Env & { PUBLIC_URL?: string });
    return oauthProvider.fetch(normalized, env as any, ctx);
  },
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduledMaintenance(env, ctx));
  },
};
