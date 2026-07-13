/**
 * Singularity — self-hosted AI memory engine
 * https://github.com/cloudmantou/Singularity
 *
 * Inspired by second-brain-cloudflare; evolving as an independent product.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { createEmbedding, createEmbeddingFromResolved, createLLM, type EmbeddingProvider } from "./providers";
import {
  applyModelSettingsPatch,
  activeEmbeddingOf,
  cloneEmbeddingSettings,
  embeddingFingerprintOf,
  emptyModelSettings,
  isDevLocalProvider,
  pendingEmbeddingOf,
  isMaskedSecret,
  promoteEmbeddingFingerprint,
  toPublicModelSettings,
  type ModelSettingsPatchBody,
  type EmbeddingSettings,
  type ModelSettings,
} from "./settings/model-settings";
import type { EmbeddingProfileRole } from "./settings/store";
import {
  ensureSettingsTable,
  getEffectiveModelSettings,
  loadStoredModelSettings,
  overlayProviderEnvFromSettings,
  prepareStoredModelSettingsSave,
  saveStoredModelSettings,
  setStoredModelSettingsCache,
} from "./settings/store";
import { importEntries, parseImportPayload, type ImportMode } from "./import-entries";
import { isKnownWorkerRoute } from "./selfhost/request-routing";
import {
  bindTelemetryDb,
  aggregateTelemetryHour,
  ensureTelemetryTables,
  flushTelemetry,
  getTelemetryConfig,
  getTelemetryQueueStats,
  logMemoryEvent,
  logRequest,
  newTraceId,
  previewText,
  purgeOldTelemetry,
  percentile,
  normalizeTelemetryConfig,
  routeToOperation,
  runWithTelemetryAsync,
  shouldSuppressRequestBodyTelemetry,
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
import { hardenOAuthResponse, oauthMethodProbe } from "./oauth/harden";
import {
  checkOAuthRedirectOrigin,
  oauthFormActionSources,
} from "./oauth/redirect-policy";
import { readPublicUrl, siteConfigJson } from "./config/site";
import { planRecallRequest, type RecallRequestPlan } from "./query-intent";
import { ensureMemoryDataModel } from "./memory/schema";
import { activeMemoryClaimPredicate } from "./memory/claim-eligibility";
import {
  enqueueClaimVectorJob,
  enqueueMissingClaimVectorJobs,
  getClaimVectorQueueStatus,
  indexableClaimPredicate,
  listClaimVectorIdsForFingerprint,
  processClaimVectorJobs,
  retryFailedClaimVectorJobs,
} from "./memory/claim-vector-queue";
import {
  commitAtomicMutationWithProjection,
  mutationActorForSource,
} from "./memory/atomic-mutation";
import {
  linkPendingEntryConflictClaims,
  loadRecallConflictContext,
  type RecallClaimContext,
  type RecallConflictContext,
} from "./memory/recall-conflicts";
import {
  forgetMemoryGraph,
  type ForgetMemoryResult,
} from "./memory/forget";
import {
  createMemoryRelations,
  listMemoryRelations,
  prepareMemoryRelation,
  type MemoryRelationType,
} from "./memory/relations";
import {
  ASSOCIATION_EDGE_TYPES,
  AssociationEndpointUnavailableError,
  associationRecallExpansion,
  createAssociationEdge,
  deleteAssociationEdge,
  listAssociationConnections,
  ASSOCIATION_DIRECTIONS,
  type AssociationDirection,
  type AssociationEdgeType,
} from "./memory/associations";
import {
  INSUFFICIENT_VERIFIED_EVIDENCE,
  normalizeInsightContext,
  validateStructuredInsightResponse,
  type CitableInsightClaim,
  type InsightContextPackage,
  type InsightEvidenceRow,
  type VerifiedInsightResult,
} from "./memory/recall-context";
import {
  prepareMemoryRevision,
  type MemoryRevisionEvent,
} from "./memory/revisions";
import {
  buildAtomicExtractionPrompt,
  deprecateEntryAtomicMemory,
  linkObservationToAtomicMemory,
  parseAtomicExtraction,
  prepareAtomicMemoryInsert,
  prepareMemorySourceInsert,
  prepareObservationInsert,
  PromptAtomicExtractor,
  isValidEvidenceRevisionLink,
  replaceEntryAtomicMemory,
  ATOMIC_EXTRACTION_MAX_TOKENS,
  ATOMIC_EXTRACTION_VERSION,
  type AtomicFactDraft,
  type EvidenceRevisionInput,
  type ObservationExtractionStatus,
} from "./memory/atomic";
import {
  exportMemoryBackup,
  importMemoryBackup,
  isMemoryBackupPayload,
  MEMORY_BACKUP_SCHEMA_VERSION,
  memoryBackupRowCount,
} from "./memory/backup";
import {
  attachEntitiesToMemory,
  ensureEntityResolutionDataModel,
  getEntityGraph,
  listActiveEntityRelations,
  listEntities,
  normalizeEntityFactKey,
  normalizeEntityName,
} from "./memory/entities";
import {
  buildParentVersionMetadataSnapshot,
  prepareParentUnitInsert,
  prepareParentVersionActivation,
  prepareParentVersionClaimInsert,
  prepareParentVersionFailure,
  prepareParentVersionInsert,
  type EvidenceAuthorType,
} from "./memory/evidence-contract";
import { runMigrations, MIGRATIONS } from "./migrations";
import {
  CONFLICT_CASE_STATES,
  CONFLICT_RESOLUTIONS,
  MERGE_CANDIDATE_STATES,
  ensureConflictClaimSchema,
  prepareComplianceAuditEvent,
  prepareConflictCase,
  prepareMemoryMergeCandidate,
  recordComplianceAuditEvent,
  type ComplianceAuditEventInput,
  type ConflictCaseState,
  type ConflictResolution,
  type MergeCandidateState,
  type MergeSuggestedAction,
} from "./memory/quality";
import {
  ClaimRelationMismatchError,
  ConflictClaimsUnavailableError,
  D1ResolutionCoordinator,
  ManualResolutionOutcomeRequiredError,
} from "./memory/resolution-coordinator";
import {
  D1EntityMergeExecutor,
  ENTITY_MERGE_CANDIDATE_STATES,
  EntityMergeCandidateUnavailableError,
  EntityMergeEndpointUnavailableError,
  type EntityMergeCandidateState,
} from "./memory/entity-merge";
import {
  knowledgeSourceRegistry,
  normalizeDevelopmentSessionProvenance,
  normalizeObsidianProvenance,
  type EvidenceProvenance,
} from "./integrations";
import {
  developmentSessionMessagesMatchTranscript,
  normalizeDevelopmentSessionMessages,
  planDevelopmentSessionEvidence,
} from "./integrations/session-distiller";
import {
  isMcpToolsListRequest,
  sanitizeToolsListResponse,
} from "./mcp/tools-list-sanitize";
import {
  collectHealthMatrix,
  type ProviderHealthSummary,
} from "./operations/health";
import {
  cachedVectorSourceMetadataProbe,
  isVectorSourceMetadataIndexError,
} from "./operations/vector-health";
import {
  CLASSIFICATION_LEASE_MS as CLASSIFICATION_PROCESSING_LEASE_MS,
  CLASSIFICATION_MAX_ATTEMPTS,
  CURRENT_CLASSIFICATION_VERSION,
  EXTRACTION_LEASE_MS as ATOMIC_EXTRACTION_LEASE_MS,
  EXTRACTION_MAX_ATTEMPTS as ATOMIC_EXTRACTION_MAX_ATTEMPTS,
  classificationDueWhereSql,
  readClassificationQueueSnapshot,
  readExtractionQueueSnapshot,
} from "./operations/queue-health";

export { CURRENT_CLASSIFICATION_VERSION } from "./operations/queue-health";

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
  /** Cloudflare Vectorize index dimensions; Vectorize indexes cannot change dimension after creation. */
  VECTORIZE_DIMENSIONS?: string;
  /** Set on Node self-host (`1`). */
  SELFHOST?: string;
  /** Required with EMBEDDING_PROVIDER=local-hash-dev for smoke tests only. */
  ALLOW_DEV_EMBEDDING?: string;
  /**
   * Public site origin from .env (PUBLIC_URL / PUBLIC_BASE_URL / SITE_URL).
   * Example: https://your.domain — no trailing slash.
   * Required behind reverse proxies so OAuth issuer is https, not http://host:443.
   */
  PUBLIC_URL?: string;
  PUBLIC_BASE_URL?: string;
  SITE_URL?: string;
  /** Optional comma/newline-separated redirect origins allowed to authorize. */
  OAUTH_ALLOWED_REDIRECT_ORIGINS?: string;
  /** Optional comma/newline-separated browser origins allowed to call management APIs. */
  DASHBOARD_ALLOWED_ORIGINS?: string;
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
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

function configuredDashboardOrigins(env: Env): Set<string> {
  return new Set((env.DASHBOARD_ALLOWED_ORIGINS ?? "")
    .split(/[\n,]/)
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean));
}

function applyManagementCors(request: Request, response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.delete("Access-Control-Allow-Origin");
  const url = new URL(request.url);
  const requestOrigin = request.headers.get("Origin")?.trim().replace(/\/$/, "") ?? "";
  const publicCors = ["/config", "/config.json", "/health"].includes(url.pathname);
  if (publicCors) {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (
    requestOrigin &&
    (requestOrigin === url.origin || configuredDashboardOrigins(env).has(requestOrigin))
  ) {
    headers.set("Access-Control-Allow-Origin", requestOrigin);
    const vary = headers.get("Vary");
    headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
  }
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const AssociationEdgeTypeSchema = z.enum(
  [...ASSOCIATION_EDGE_TYPES] as [AssociationEdgeType, ...AssociationEdgeType[]]
);
const AssociationLinkBodySchema = z.object({
  sourceId: z.string().trim().min(1).max(512).optional(),
  targetId: z.string().trim().min(1).max(512).optional(),
  source_id: z.string().trim().min(1).max(512).optional(),
  target_id: z.string().trim().min(1).max(512).optional(),
  type: AssociationEdgeTypeSchema.default("related_to"),
  weight: z.number().min(0).max(1).optional(),
  validFrom: z.number().int().nonnegative().optional(),
  validTo: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  if (!(value.sourceId ?? value.source_id)) {
    context.addIssue({ code: "custom", message: "sourceId/source_id is required" });
  }
  if (!(value.targetId ?? value.target_id)) {
    context.addIssue({ code: "custom", message: "targetId/target_id is required" });
  }
});
const AssociationUnlinkBodySchema = z.object({
  sourceId: z.string().trim().min(1).max(512).optional(),
  targetId: z.string().trim().min(1).max(512).optional(),
  source_id: z.string().trim().min(1).max(512).optional(),
  target_id: z.string().trim().min(1).max(512).optional(),
  type: AssociationEdgeTypeSchema.optional(),
  effectiveAt: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, context) => {
  if (!(value.sourceId ?? value.source_id)) {
    context.addIssue({ code: "custom", message: "sourceId/source_id is required" });
  }
  if (!(value.targetId ?? value.target_id)) {
    context.addIssue({ code: "custom", message: "targetId/target_id is required" });
  }
});
const DevelopmentSessionCaptureSchema = z.object({
  client: z.enum(["claude-code", "codex"]),
  repository: z.string().trim().min(1).max(200),
  branch: z.string().trim().min(1).max(256),
  sessionId: z.string().trim().min(1).max(256),
  transcript: z.string().trim().min(1).max(200_000),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(50_000),
    messageId: z.string().trim().min(1).max(256).optional(),
  }).strict()).min(1).max(100).optional(),
  capturedAt: z.number().int().nonnegative().optional(),
  revision: z.number().int().min(1).optional(),
}).strict().superRefine((value, context) => {
  const totalMessageLength = (value.messages ?? []).reduce(
    (total, message) => total + message.content.length,
    0
  );
  if (totalMessageLength > 200_000) {
    context.addIssue({
      code: "custom",
      path: ["messages"],
      message: "structured message content exceeds 200000 characters",
    });
  }
});

function graceMs(env: Env): number {
  return parseInt(env.VECTORIZE_GRACE_MS ?? "300000", 10) || 300000;
}

function cloudflareVectorIndexDimensions(env: Env): number {
  return parseInt(env.VECTORIZE_DIMENSIONS ?? "384", 10) || 384;
}

function validateCloudflareVectorDimensions(
  env: Env,
  dimensions: number
): null | {
  ok: false;
  error: "vector_index_dimension_mismatch";
  indexDimensions: number;
  embeddingDimensions: number;
  next: string;
} {
  if (env.SELFHOST === "1") return null;
  const indexDimensions = cloudflareVectorIndexDimensions(env);
  const embeddingDimensions = Number(dimensions || 0);
  if (embeddingDimensions === indexDimensions) return null;
  return {
    ok: false,
    error: "vector_index_dimension_mismatch",
    indexDimensions,
    embeddingDimensions,
    next:
      "Cloudflare Vectorize 索引维度固定。请使用匹配当前索引维度的 embedding 模型，或创建并绑定对应维度的新 Vectorize 索引。",
  };
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

// Exact duplicates are blocked by content hash only — never by vector score.
// High semantic similarity always ADD-s a new row and links via typed relations.
// Per PR5 (stop-fact-loss): hard-block only on content fingerprints, never on vector score.
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
      AND (${p}contradiction_wins IS NULL OR ${p}contradiction_wins = 0)
      AND (${p}contradiction_losses IS NULL OR ${p}contradiction_losses = 0)`;
}

// ─── Chunking constants ───────────────────────────────────────────────────────

const CHUNK_MAX_CHARS = 1600;
const CHUNK_OVERLAP_CHARS = 200;

// ─── Token limits ─────────────────────────────────────────────────────────────

const CLASSIFY_MAX_TOKENS = 80;
const CONTRADICTION_MAX_TOKENS = 80;
const SMART_MERGE_MAX_TOKENS = 120;
const INSIGHT_MAX_TOKENS = 300;
const PATTERN_MAX_TOKENS = 100;
const DIGEST_MAX_TOKENS = 400;

// ─── Vectorize constants ──────────────────────────────────────────────────────

const VECTORIZE_TOP_K_MULTIPLIER = 3;
const EMBEDDING_INPUT_BATCH_SIZE = 64;
const VECTORIZE_INSERT_BATCH_SIZE = 100;
const VECTOR_CLEANUP_BATCH_SIZE = 100;
const VECTOR_CLEANUP_MAX_ATTEMPTS = 8;
// getByIds batch size for tag-scoped recall — Vectorize rejects more than 20 IDs
// per call (VECTOR_GET_ERROR, code 40007)
const VECTORIZE_GET_BY_IDS_BATCH = 20;
// D1 allows at most 100 bound parameters per query
const D1_MAX_BOUND_PARAMS = 100;

// ─── Hybrid recall (keyword + semantic fusion) ─────────────────────────────────
const RRF_K = 60;                    // Reciprocal Rank Fusion dampening constant
const KEYWORD_CANDIDATE_LIMIT = 100; // max rows the LIKE keyword query scans
const KEYWORD_MIN_TOKEN_LEN = 2;     // ignore 1-char tokens
const KEYWORD_MAX_TOKENS = 24;       // well below D1's 100 bound-parameter limit
const KEYWORD_MAX_LIKE_TOKEN_BYTES = 48; // + two '%' wildcards = D1's 50-byte limit
const KEYWORD_MAX_QUERY_CHARS = 2_048;
const D1_MAX_TAG_UTF8_BYTES = 46; // JSON tag LIKE pattern adds %" and "% (4 bytes)
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

/** Who last set status:* — distinguishes user intent from classifier auto-draft. */
export const STATUS_SOURCE_VALUES = ["user", "classifier", "relation"] as const;
export type StatusSource = (typeof STATUS_SOURCE_VALUES)[number];
const STATUS_SOURCE_PREFIX = "status_source:";

export function getStatusSource(tags: string[]): StatusSource | null {
  const tag = tags.find(t => t.startsWith(STATUS_SOURCE_PREFIX));
  if (!tag) return null;
  const value = tag.slice(STATUS_SOURCE_PREFIX.length) as StatusSource;
  return (STATUS_SOURCE_VALUES as readonly string[]).includes(value) ? value : null;
}

export function withStatusSource(tags: string[], source: StatusSource): string[] {
  const cleaned = tags.filter(t => !t.startsWith(STATUS_SOURCE_PREFIX));
  return [...cleaned, `${STATUS_SOURCE_PREFIX}${source}`];
}

export function clearStatusSource(tags: string[]): string[] {
  return tags.filter(t => !t.startsWith(STATUS_SOURCE_PREFIX));
}

/** Soft marker: model suggested canonical but confidence was below the auto-promote threshold. */
export const CANONICAL_CANDIDATE_TAG = "canonical-candidate";
/** Only auto-promote to status:canonical when classifier confidence is at least this. */
export const CANONICAL_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Apply lifecycle tags from a classification result.
 * High-confidence canonical → status:canonical (if no status, or classifier-owned draft).
 * Low-confidence canonical → status:draft + status_source:classifier + canonical-candidate.
 * Never demotes user-set status tags.
 */
export function applyClassificationLifecycleTags(
  tags: string[],
  canonical: boolean,
  confidence: number,
): string[] {
  let next = tags.filter(t => t !== CANONICAL_CANDIDATE_TAG);
  if (!canonical) return next;

  if (confidence >= CANONICAL_CONFIDENCE_THRESHOLD) {
    const status = getStatus(next);
    const source = getStatusSource(next);
    if (status === null || (status === "draft" && source === "classifier")) {
      next = withStatus(next, "canonical");
      next = clearStatusSource(next);
    }
    return next;
  }

  if (getStatus(next) === null) {
    next = withStatus(next, "draft");
    next = withStatusSource(next, "classifier");
  }
  if (!next.includes(CANONICAL_CANDIDATE_TAG)) next = [...next, CANONICAL_CANDIDATE_TAG];
  return next;
}

// ─── Memory kind layer (issue #12) ──────────────────────────────────────────────
// Kind lives as a reserved tag (e.g. "kind:episodic") on entries.tags — no schema
// change. Absent kind = unknown (unclassified). Orthogonal to status (#119).

export const KIND_VALUES = ["episodic", "semantic", "procedural"] as const;
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
  return request.headers.get("Authorization") === `Bearer ${env.AUTH_TOKEN}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// AuthPrincipal enforces that routes use the server-resolved vault_id
// rather than trusting the request body. Owner tokens bypass vault binding;
// scoped tokens always carry a vault_id.

interface AuthPrincipal {
  owner: boolean;          // true ⇒ AUTH_TOKEN hit; bypass vault binding
  tokenId: string | null;   // sb_access_tokens.id when scoped
  vaultId: string | null;   // null only when principal.owner === true
  scopes: string[];
}

type AuthResult =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; response: Response };

function requireAuth(request: Request, env: Env): AuthResult {
  if (isAuthorized(request, env)) {
    return { ok: true, principal: { owner: true, tokenId: null, vaultId: null, scopes: [] } };
  }
  return { ok: false, response: json({ ok: false, error: "Unauthorized" }, 401) };
}

function auditActorFromPrincipal(principal: AuthPrincipal): Pick<
  ComplianceAuditEventInput,
  "actorType" | "actorId" | "tokenId" | "vaultId"
> {
  if (principal.owner) {
    return { actorType: "owner", actorId: "owner", tokenId: null, vaultId: null };
  }
  return {
    actorType: "token",
    actorId: principal.tokenId,
    tokenId: principal.tokenId,
    vaultId: principal.vaultId,
  };
}

async function safeRecordComplianceAuditEvent(
  env: Env,
  input: ComplianceAuditEventInput
): Promise<void> {
  try {
    await recordComplianceAuditEvent(env.DB, input);
  } catch (error) {
    console.error("Compliance audit event write failed (non-fatal):", error);
  }
}

interface OAuthLoginDetails {
  clientName: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  cancelUrl: string;
}

function escapeOAuthHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeOAuthScope(rawScope: unknown): string[] {
  if (Array.isArray(rawScope)) {
    const values = rawScope.map(String).map((value) => value.trim()).filter(Boolean);
    return values.length ? values : ["mcp"];
  }
  if (typeof rawScope === "string" && rawScope.trim()) {
    return rawScope.split(/\s+/).filter(Boolean);
  }
  return ["mcp"];
}

function oauthCancelUrl(redirectUri: string, state: unknown): string {
  const cancel = new URL(redirectUri);
  cancel.searchParams.set("error", "access_denied");
  cancel.searchParams.set("error_description", "The owner denied this request");
  if (typeof state === "string" && state) cancel.searchParams.set("state", state);
  return cancel.toString();
}

// Hosted OAuth login page. All client-controlled metadata is escaped before
// rendering because dynamic client registration is intentionally unauthenticated.
function loginHtml(
  error?: string,
  actionUrl?: string,
  details?: OAuthLoginDetails
): string {
  const action = actionUrl ? escapeOAuthHtml(actionUrl) : "";
  const detailHtml = details
    ? `<dl class="client-details">
        <div><dt>请求访问的客户端</dt><dd>${escapeOAuthHtml(details.clientName)}</dd></div>
        <div><dt>客户端 ID</dt><dd class="mono">${escapeOAuthHtml(details.clientId)}</dd></div>
        <div><dt>回调地址</dt><dd class="mono">${escapeOAuthHtml(details.redirectUri)}</dd></div>
        <div><dt>权限</dt><dd>${details.scope.includes("mcp") ? "读取、写入和删除你的 Singularity 记忆" : escapeOAuthHtml(details.scope.join(", "))}</dd></div>
      </dl>`
    : "";
  const formHtml = action && details
    ? `<form method="POST" action="${action}">
      <input type="password" name="password" placeholder="AUTH_TOKEN" autofocus autocomplete="current-password" />
      <div class="actions">
        <a class="cancel" href="${escapeOAuthHtml(details.cancelUrl)}">取消</a>
        <button type="submit">授权连接</button>
      </div>
    </form>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="theme-color" content="#F4F1EA" />
  <title>授权 · Singularity</title>
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
    .client-details { width: 100%; background: var(--bg-card); border: 0.5px solid var(--border-input); border-radius: 14px; padding: 4px 16px; margin: -14px 0 20px; }
    .client-details > div { padding: 11px 0; border-bottom: 0.5px solid var(--border-input); }
    .client-details > div:last-child { border-bottom: 0; }
    dt { color: var(--text-tertiary); font-size: 11px; margin-bottom: 4px; }
    dd { font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .actions { display: grid; grid-template-columns: 0.75fr 1.25fr; gap: 10px; }
    .cancel { display: flex; align-items: center; justify-content: center; padding: 15px; border: 0.5px solid var(--border-input); border-radius: 13px; color: var(--text-secondary); text-decoration: none; font-size: 14px; }
    input { width: 100%; padding: 14px 16px; background: var(--bg-card); border: 0.5px solid var(--border-input); border-radius: 13px; font-family: var(--font-sans); font-size: 15px; color: var(--text-primary); outline: none; transition: border-color 0.18s, box-shadow 0.18s; }
    input::placeholder { color: var(--text-tertiary); }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button { width: 100%; padding: 15px; background: var(--accent); color: var(--on-accent); border: none; border-radius: 13px; font-family: var(--font-sans); font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.18s, transform 0.12s var(--ease); }
    button:hover { background: var(--accent-press); }
    button:active { transform: scale(0.985); }
    .auth-error { font-size: 13px; color: var(--danger); text-align: center; margin-top: 10px; min-height: 18px; }
    .hint { font-size: 12px; color: var(--text-tertiary); text-align: center; margin-top: 8px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="auth-card">
    <div class="brain-logo"><i class="ti ti-brain"></i></div>
    <h1>Singularity</h1>
    <p>这是个人 MCP 授权请求。确认客户端和回调地址后，再输入服务器 AUTH_TOKEN。</p>
    ${detailHtml}
    ${formHtml}
    <div class="auth-error">${error ? escapeOAuthHtml(error) : ""}</div>
    <p class="hint">仅个人实例使用。同意后将跳回客户端并完成 OAuth。</p>
  </div>
</body>
</html>`;
}

function oauthLoginResponse(
  html: string,
  status = 200,
  /**
   * form-action sources. Must include client redirect origins: Chrome/Safari
   * enforce form-action on the post-submit redirect chain (OAuth code callback).
   */
  formActionSources = "'self' https://chatgpt.com http://127.0.0.1:* http://localhost:*"
): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; " +
        "font-src https://cdn.jsdelivr.net; img-src data:; form-action " +
        formActionSources +
        "; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

async function embed(
  text: string,
  env: Env,
  purpose: "document" | "query" = "document"
): Promise<number[]> {
  return (await createEmbedding(env)).embed(text, { purpose });
}

interface ActiveEmbeddingSnapshot {
  fingerprint: string;
  settingsUpdatedAt: number;
  embedding: EmbeddingSettings;
  provider: EmbeddingProvider;
}

async function loadActiveEmbeddingSnapshot(env: Env): Promise<ActiveEmbeddingSnapshot> {
  const { effective } = await getEffectiveModelSettings(env);
  const embedding = activeEmbeddingOf(effective);
  const fingerprint = effective.embeddingFingerprint ?? embeddingFingerprintOf(embedding);
  const snapshotSettings: ModelSettings = {
    ...effective,
    embedding: cloneEmbeddingSettings(embedding),
    activeEmbedding: cloneEmbeddingSettings(embedding),
    embeddingFingerprint: fingerprint,
    pendingEmbedding: undefined,
    pendingEmbeddingFingerprint: undefined,
  };
  return {
    fingerprint,
    settingsUpdatedAt: effective.updatedAt ?? 0,
    embedding,
    provider: createEmbeddingFromResolved(
      overlayProviderEnvFromSettings(env, snapshotSettings)
    ),
  };
}

async function loadEmbeddingSnapshotForFingerprint(
  env: Env,
  fingerprint: string
): Promise<ActiveEmbeddingSnapshot> {
  const { effective } = await getEffectiveModelSettings(env);
  const activeEmbedding = activeEmbeddingOf(effective);
  const activeFingerprint = effective.embeddingFingerprint ?? embeddingFingerprintOf(activeEmbedding);
  const pendingFingerprint = effective.pendingEmbeddingFingerprint ?? null;
  const embedding = fingerprint === activeFingerprint
    ? activeEmbedding
    : fingerprint === pendingFingerprint
      ? pendingEmbeddingOf(effective)
      : null;
  if (!embedding) {
    throw new Error(`Unknown Claim vector embedding fingerprint: ${fingerprint}`);
  }
  const snapshotSettings: ModelSettings = {
    ...effective,
    embedding: cloneEmbeddingSettings(embedding),
    activeEmbedding: cloneEmbeddingSettings(embedding),
    embeddingFingerprint: fingerprint,
    pendingEmbedding: undefined,
    pendingEmbeddingFingerprint: undefined,
  };
  return {
    fingerprint,
    settingsUpdatedAt: effective.updatedAt ?? 0,
    embedding,
    provider: createEmbeddingFromResolved(
      overlayProviderEnvFromSettings(env, snapshotSettings)
    ),
  };
}

async function isActiveEmbeddingSnapshotCurrent(
  env: Env,
  snapshot: ActiveEmbeddingSnapshot
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE
              WHEN COALESCE(json_extract(value, '$.embeddingFingerprint'), '') = ?
              THEN 1 ELSE 0
            END) as matching
     FROM sb_app_settings
     WHERE key = 'model_settings'`
  ).bind(snapshot.fingerprint).first<Record<string, unknown>>();
  const total = Number(row?.total ?? 0);
  if (total === 0) return true;
  return Number(row?.matching ?? 0) > 0;
}

async function embedWithProvider(
  provider: EmbeddingProvider,
  text: string,
  purpose: "document" | "query" = "document"
): Promise<number[]> {
  return provider.embed(text, { purpose });
}

async function embedMany(
  texts: string[],
  env: Env,
  purpose: "document" | "query" = "document",
  embeddingRole: EmbeddingProfileRole = "active"
): Promise<number[][]> {
  if (!texts.length) return [];
  const provider = await createEmbedding(env, embeddingRole);
  return embedManyWithProvider(provider, texts, purpose);
}

async function embedManyWithProvider(
  provider: EmbeddingProvider,
  texts: string[],
  purpose: "document" | "query" = "document"
): Promise<number[][]> {
  if (!texts.length) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_INPUT_BATCH_SIZE) {
    const slice = texts.slice(i, i + EMBEDDING_INPUT_BATCH_SIZE);
    if (provider.embedMany) {
      out.push(...await provider.embedMany(slice, { purpose }));
    } else {
      out.push(...await Promise.all(slice.map((text) => provider.embed(text, { purpose }))));
    }
  }
  return out;
}

// ─── Database initialization ──────────────────────────────────────────────────

export async function initializeDatabase(env: Env): Promise<void> {
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'api', created_at INTEGER NOT NULL, vector_ids TEXT NOT NULL DEFAULT '[]')`);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC)`);
  await env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source)`);
  for (const alter of [
    `ALTER TABLE entries ADD COLUMN recall_count INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN importance_score INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN classification_confidence REAL`,
    `ALTER TABLE entries ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE entries ADD COLUMN classification_error TEXT`,
    `ALTER TABLE entries ADD COLUMN classification_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN classification_next_attempt_at INTEGER`,
    `ALTER TABLE entries ADD COLUMN classification_started_at INTEGER`,
    `ALTER TABLE entries ADD COLUMN classification_version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE entries ADD COLUMN classified_at INTEGER`,
    `ALTER TABLE entries ADD COLUMN contradiction_wins INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN contradiction_losses INTEGER DEFAULT 0`,
    `ALTER TABLE entries ADD COLUMN content_hash TEXT`,
    `ALTER TABLE entries ADD COLUMN embedding_fingerprint TEXT`,
    `ALTER TABLE entries ADD COLUMN pending_vector_ids TEXT`,
    `ALTER TABLE entries ADD COLUMN pending_embedding_fingerprint TEXT`,
    `ALTER TABLE entries ADD COLUMN pending_content_hash TEXT`,
    `ALTER TABLE entries ADD COLUMN pending_revision_id TEXT`,
    `ALTER TABLE entries ADD COLUMN metadata_hash TEXT`,
    `ALTER TABLE entries ADD COLUMN pending_metadata_hash TEXT`,
    `ALTER TABLE entries ADD COLUMN pending_rebuild_id TEXT`,
  ]) {
    try {
      await env.DB.exec(alter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_classification_queue
     ON entries(classification_status, classification_next_attempt_at, created_at)`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash)`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_pending_vectors
     ON entries(pending_embedding_fingerprint, pending_vector_ids, created_at)`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_pending_rebuild
     ON entries(pending_rebuild_id, pending_vector_ids, created_at)`
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS sb_external_links (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      external_path TEXT NOT NULL,
      external_block_id TEXT NOT NULL DEFAULT '',
      object_type TEXT NOT NULL DEFAULT 'memory',
      object_id TEXT,
      entry_id TEXT,
      external_file_id TEXT,
      content_hash TEXT,
      sync_etag TEXT,
      last_synced_content_hash TEXT,
      last_synced_revision_id TEXT,
      last_synced_sync_etag TEXT,
      last_status TEXT,
      sync_direction TEXT NOT NULL DEFAULT 'bidirectional',
      sync_status TEXT NOT NULL DEFAULT 'synced',
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (sync_direction IN ('bidirectional', 'obsidian_to_singularity', 'singularity_to_obsidian')),
      CHECK (sync_status IN ('synced', 'local_changed', 'remote_changed', 'conflict', 'deleted_local', 'deleted_remote', 'error')),
      CHECK (object_type IN ('observation', 'memory', 'aggregate', 'rule'))
    )`
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS sb_external_sources (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      external_path TEXT NOT NULL,
      external_block_id TEXT NOT NULL DEFAULT '',
      current_observation_id TEXT,
      last_content_hash TEXT,
      last_revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(provider, vault_id, external_path, external_block_id)
    )`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_external_sources_provider_vault
     ON sb_external_sources(provider, vault_id, updated_at DESC)`
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS sb_access_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL,
      vault_id TEXT,
      expires_at INTEGER,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_access_tokens_hash
     ON sb_access_tokens(token_hash)`
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS sb_automation_rules (
      id TEXT PRIMARY KEY,
      vault_id TEXT,
      name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      source_filter_json TEXT NOT NULL DEFAULT '{}',
      extractor_schema_json TEXT NOT NULL DEFAULT '{}',
      tag_rules_json TEXT NOT NULL DEFAULT '{}',
      aggregation_rule_json TEXT NOT NULL DEFAULT '{}',
      output_template TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger
     ON sb_automation_rules(trigger_type, enabled, updated_at DESC)`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_automation_rules_vault
     ON sb_automation_rules(vault_id, enabled, updated_at DESC)`
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS sb_knowledge_aggregates (
      id TEXT PRIMARY KEY,
      vault_id TEXT,
      aggregate_type TEXT NOT NULL,
      title TEXT NOT NULL,
      source_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      generation_rule_id TEXT,
      content TEXT NOT NULL,
      content_hash TEXT,
      generated_at INTEGER NOT NULL,
      stale_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_aggregates_stale
     ON sb_knowledge_aggregates(stale_at, updated_at DESC)`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_aggregates_vault
     ON sb_knowledge_aggregates(vault_id, updated_at DESC)`
  );
  // Centralised migration runner (replaces ensureExternalLinksSchema
  // and ensureObsidianP1Schema). Run only after the Obsidian base tables exist.
  await runMigrations(env, MIGRATIONS);
  await env.DB.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_external_links_identity
     ON sb_external_links(provider, vault_id, external_path, external_block_id, object_type, object_id)`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_external_links_entry
     ON sb_external_links(entry_id)`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_external_links_provider_vault
     ON sb_external_links(provider, vault_id, sync_status, updated_at DESC)`
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS sb_vector_rebuilds (
      id TEXT PRIMARY KEY,
      slot TEXT NOT NULL UNIQUE DEFAULT 'current',
      state TEXT NOT NULL,
      active_fingerprint TEXT NOT NULL,
      pending_fingerprint TEXT NOT NULL,
      expected_entries INTEGER NOT NULL DEFAULT 0,
      processed_entries INTEGER NOT NULL DEFAULT 0,
      failed_entries INTEGER NOT NULL DEFAULT 0,
      conflict_entries INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (slot = 'current'),
      CHECK (
        state IN (
          'queued',
          'building',
          'ready',
          'activating',
          'active',
          'cancelling',
          'cancelled',
          'failed'
        )
      )
    )`
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS sb_vector_cleanup_queue (
      id TEXT PRIMARY KEY,
      vector_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'ready',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      rebuild_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (state IN ('ready', 'blocked', 'failed', 'completed'))
    )`
  );
  for (const alter of [
    `ALTER TABLE sb_vector_cleanup_queue ADD COLUMN state TEXT NOT NULL DEFAULT 'ready'`,
    `ALTER TABLE sb_vector_cleanup_queue ADD COLUMN next_attempt_at INTEGER`,
    `ALTER TABLE sb_vector_cleanup_queue ADD COLUMN rebuild_id TEXT`,
  ]) {
    try {
      await env.DB.exec(alter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_sb_vector_cleanup_queue_created
     ON sb_vector_cleanup_queue(created_at)`
  );
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_vector_cleanup_due
     ON sb_vector_cleanup_queue(state, next_attempt_at, created_at)`
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS sb_vector_cleanup_batches (
      id TEXT PRIMARY KEY,
      rebuild_id TEXT NOT NULL,
      vector_ids_json TEXT NOT NULL,
      vector_ids_hash TEXT,
      state TEXT NOT NULL DEFAULT 'prepared',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (state IN ('prepared', 'ready', 'processing', 'failed', 'completed', 'blocked'))
    )`
  );
  try {
    await env.DB.exec(`ALTER TABLE sb_vector_cleanup_batches ADD COLUMN vector_ids_hash TEXT`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name|already exists/i.test(message)) throw error;
  }
  await env.DB.exec(
    `CREATE INDEX IF NOT EXISTS idx_vector_cleanup_batches_due
     ON sb_vector_cleanup_batches(state, next_attempt_at, created_at)`
  );
  await env.DB.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cleanup_batch_identity
     ON sb_vector_cleanup_batches(rebuild_id, vector_ids_hash)
     WHERE vector_ids_hash IS NOT NULL`
  );
  // Before durable classification fields existed, kind:* tags were the only
  // successful-classification marker. Preserve that work during upgrade with
  // a conservative confidence instead of re-spending the classifier on it.
  await env.DB.exec(
    `UPDATE entries
     SET classification_status = 'succeeded',
         classification_confidence = 0.5,
         classification_attempts = 1,
         classification_error = NULL,
         classification_next_attempt_at = NULL,
         classification_started_at = NULL,
         classification_version = 1,
         classified_at = created_at
     WHERE classification_status = 'pending'
       AND COALESCE(classification_attempts, 0) = 0
       AND classification_confidence IS NULL
       AND classified_at IS NULL
       AND (
         SELECT COUNT(*)
         FROM json_each(CASE WHEN json_valid(entries.tags) THEN entries.tags ELSE '[]' END)
         WHERE value LIKE 'kind:%'
       ) = 1
       AND EXISTS (
         SELECT 1
         FROM json_each(CASE WHEN json_valid(entries.tags) THEN entries.tags ELSE '[]' END)
         WHERE value IN ('kind:episodic', 'kind:semantic', 'kind:procedural')
       )`
  );
  await ensureMemoryDataModel(env.DB);
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

// ─── Exact-content fingerprint (hard dedup) ───────────────────────────────────
// Vector similarity never hard-blocks capture. Only a content fingerprint match
// (normalized whitespace) is treated as an exact duplicate.

export function normalizeContentForDedup(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

export async function contentFingerprint(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeContentForDedup(content));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeTagsForMetadata(tags: string[]): string[] {
  return [...new Set(tags.map(tag => String(tag).trim()).filter(Boolean))].sort();
}

async function entryMetadataFingerprint(input: {
  source: string;
  tags: string[];
}): Promise<string> {
  return contentFingerprint(JSON.stringify({
    source: input.source,
    tags: normalizeTagsForMetadata(input.tags),
  }));
}

const OBSIDIAN_PROVIDER = "obsidian";
const OBSIDIAN_SYNC_STATUSES = [
  "synced",
  "local_changed",
  "remote_changed",
  "conflict",
  "deleted_local",
  "deleted_remote",
  "error",
] as const;
const OBSIDIAN_SYNC_DIRECTIONS = [
  "bidirectional",
  "obsidian_to_singularity",
  "singularity_to_obsidian",
] as const;
const OBSIDIAN_OBJECT_TYPES = [
  "observation",
  "memory",
  "aggregate",
  "rule",
] as const;

type ObsidianSyncStatus = (typeof OBSIDIAN_SYNC_STATUSES)[number];
type ObsidianSyncDirection = (typeof OBSIDIAN_SYNC_DIRECTIONS)[number];
type ObsidianObjectType = (typeof OBSIDIAN_OBJECT_TYPES)[number];

interface ObsidianPushBody {
  vaultId?: unknown;
  path?: unknown;
  blockId?: unknown;
  content?: unknown;
  properties?: unknown;
  entryId?: unknown;
  baseRevisionId?: unknown;
  baseSyncEtag?: unknown;
  sourceId?: unknown;
  syncDirection?: unknown;
}

interface ObsidianResolveConflictBody {
  linkId?: unknown;
  vaultId?: unknown;
  path?: unknown;
  blockId?: unknown;
  resolution?: unknown;
  content?: unknown;
  properties?: unknown;
  baseRevisionId?: unknown;
  baseSyncEtag?: unknown;
}

interface ObsidianAckBody {
  linkId?: unknown;
  vaultId?: unknown;
  revisionId?: unknown;
  contentHash?: unknown;
  syncEtag?: unknown;
}

interface ObsidianTokenBody {
  name?: unknown;
  vaultId?: unknown;
  expiresAt?: unknown;
}

interface ObsidianRuleBody {
  id?: unknown;
  vaultId?: unknown;
  name?: unknown;
  triggerType?: unknown;
  sourceFilter?: unknown;
  extractorSchema?: unknown;
  tagRules?: unknown;
  aggregationRule?: unknown;
  outputTemplate?: unknown;
  enabled?: unknown;
}

interface ObsidianAggregateGenerateBody {
  id?: unknown;
  vaultId?: unknown;
  aggregateType?: unknown;
  title?: unknown;
  sourceMemoryIds?: unknown;
  generationRuleId?: unknown;
  outputPath?: unknown;
  syncDirection?: unknown;
}

interface ExternalSourceRow {
  id: string;
  provider: string;
  vault_id: string;
  external_path: string;
  external_block_id: string;
  current_observation_id: string | null;
  last_content_hash: string | null;
  last_revision: number;
  created_at: number;
  updated_at: number;
}

interface ObsidianLinkRow {
  id: string;
  provider: string;
  entry_id: string | null;
  vault_id: string;
  external_path: string;
  external_block_id: string;
  object_type: ObsidianObjectType;
  object_id: string | null;
  external_file_id: string | null;
  content_hash: string | null;
  sync_etag: string | null;
  last_synced_content_hash: string | null;
  last_synced_revision_id: string | null;
  last_synced_sync_etag: string | null;
  sync_direction: ObsidianSyncDirection;
  sync_status: ObsidianSyncStatus;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface ObsidianLinkedEntryRow extends ObsidianLinkRow {
  entry_id: string;
  object_id: string;
  object_type: "memory";
  content: string;
  tags: string;
  source: string;
  entry_created_at: number;
  content_hash: string | null;
  metadata_hash: string | null;
  classification_version: number | null;
  revision_id: string | null;
  memory_status: MemoryStatus | null;
  knowledge_entities: ObsidianKnowledgeEntity[];
  knowledge_facts: ObsidianKnowledgeFact[];
  knowledge_projection_hash: string | null;
}

interface ObsidianKnowledgeEntity {
  id: string;
  name: string;
  entityType: string | null;
}

interface ObsidianKnowledgeFact {
  relationId: string;
  statement: string;
  fromName: string;
  predicate: string;
  toName: string;
  scopeId: string | null;
  resolutionType: string;
  requiresReview: boolean;
}

interface AutomationRuleRow {
  id: string;
  vault_id: string | null;
  name: string;
  trigger_type: string;
  source_filter_json: string;
  extractor_schema_json: string;
  tag_rules_json: string;
  aggregation_rule_json: string;
  output_template: string | null;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
}

interface KnowledgeAggregateRow {
  id: string;
  vault_id: string | null;
  aggregate_type: string;
  title: string;
  source_memory_ids_json: string;
  generation_rule_id: string | null;
  content: string;
  content_hash: string | null;
  generated_at: number;
  stale_at: number | null;
  created_at: number;
  updated_at: number;
  link_id?: string | null;
  external_path?: string | null;
  sync_etag?: string | null;
  last_synced_sync_etag?: string | null;
  sync_status?: ObsidianSyncStatus | null;
  sync_direction?: ObsidianSyncDirection | null;
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function obsidianBlockIdFromBody(body: ObsidianPushBody | ObsidianResolveConflictBody): string {
  const direct = optionalTrimmedString("blockId" in body ? body.blockId : undefined);
  if (direct) return direct;
  const properties = parseObsidianProperties(body.properties);
  return optionalTrimmedString(properties.blockId) ?? optionalTrimmedString(properties.block_id) ?? "";
}

function stripLeadingYamlFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return (match ? normalized.slice(match[0].length) : normalized).replace(/^\s+/, "").trim();
}

function shouldStripObsidianFrontmatter(properties: Record<string, unknown>): boolean {
  return (
    properties.managed_by === "singularity" ||
    typeof properties.singularity_id === "string" ||
    typeof properties.singularity_type === "string"
  );
}

export const OBSIDIAN_KNOWLEDGE_BEGIN = "<!-- SINGULARITY:KNOWLEDGE:BEGIN -->";
export const OBSIDIAN_KNOWLEDGE_END = "<!-- SINGULARITY:KNOWLEDGE:END -->";

function stripObsidianKnowledgeProjection(content: string): string {
  const completeBlock = new RegExp(
    `${OBSIDIAN_KNOWLEDGE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${OBSIDIAN_KNOWLEDGE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "g"
  );
  let stripped = content.replace(completeBlock, "");
  const unmatchedBegin = stripped.indexOf(OBSIDIAN_KNOWLEDGE_BEGIN);
  if (unmatchedBegin >= 0) stripped = stripped.slice(0, unmatchedBegin);
  return stripped.replaceAll(OBSIDIAN_KNOWLEDGE_END, "").trim();
}

export function sanitizeObsidianContent(content: string, properties: Record<string, unknown>): string {
  const withoutFrontmatter = shouldStripObsidianFrontmatter(properties)
    ? stripLeadingYamlFrontmatter(content)
    : content.trim();
  return stripObsidianKnowledgeProjection(withoutFrontmatter);
}

function parseScopesJson(scopesJson: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(scopesJson ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function requireScopedAuth(
  request: Request,
  env: Env,
  scope: string,
  vaultId?: string | null
): Promise<AuthResult> {
  if (isAuthorized(request, env)) {
    return { ok: true, principal: { owner: true, tokenId: null, vaultId: null, scopes: [] } };
  }
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!token) return { ok: false, response: json({ ok: false, error: "Unauthorized" }, 401) };

  const tokenHash = await contentFingerprint(token);
  const row = await env.DB.prepare(
    `SELECT id, scopes_json, vault_id, expires_at, revoked_at
     FROM sb_access_tokens
     WHERE token_hash = ?
     LIMIT 1`
  ).bind(tokenHash).first<Record<string, any>>();
  const now = Date.now();
  if (!row || row.revoked_at != null || (row.expires_at != null && Number(row.expires_at) <= now)) {
    return { ok: false, response: json({ ok: false, error: "Unauthorized" }, 401) };
  }
  const scopes = parseScopesJson(row.scopes_json as string | null);
  if (!scopes.includes(scope)) {
    return { ok: false, response: json({ ok: false, error: "Forbidden" }, 403) };
  }
  const tokenVaultId = typeof row.vault_id === "string" && row.vault_id.trim()
    ? row.vault_id.trim()
    : null;
  // Obsidian-scoped tokens must always carry a vault_id; reject tokens without one.
  if (!tokenVaultId) {
    return { ok: false, response: json({ ok: false, error: "vault_id_missing_on_token" }, 403) };
  }
  // Require vaultId to be a non-empty trimmed string ≤128 chars.
  const suppliedVaultId = typeof vaultId === "string" && vaultId.trim()
    ? vaultId.trim()
    : null;
  if (!suppliedVaultId) {
    return { ok: false, response: json({ ok: false, error: "vaultId is required" }, 400) };
  }
  if (suppliedVaultId.length > 128) {
    return { ok: false, response: json({ ok: false, error: "vaultId is too long" }, 400) };
  }
  if (suppliedVaultId !== tokenVaultId) {
    return { ok: false, response: json({ ok: false, error: "Forbidden" }, 403) };
  }
  ctxWaitUntilNoop(env.DB.prepare(
    `UPDATE sb_access_tokens SET last_used_at = ? WHERE id = ?`
  ).bind(now, row.id as string).run());
  return {
    ok: true,
    principal: {
      owner: false,
      tokenId: row.id as string,
      vaultId: tokenVaultId,
      scopes,
    },
  };
}

function resolveObsidianVaultId(
  principal: AuthPrincipal,
  requestedVaultId?: string | null
): { ok: true; vaultId: string } | { ok: false; response: Response } {
  if (!principal.owner) {
    if (!principal.vaultId) {
      return { ok: false, response: json({ ok: false, error: "vault_id_missing_on_token" }, 403) };
    }
    if (requestedVaultId && requestedVaultId !== principal.vaultId) {
      return { ok: false, response: json({ ok: false, error: "Forbidden" }, 403) };
    }
    return { ok: true, vaultId: principal.vaultId };
  }

  const vaultId = requiredTrimmedString(requestedVaultId);
  if (!vaultId) return { ok: false, response: json({ ok: false, error: "vaultId is required" }, 400) };
  if (vaultId.length > 128) return { ok: false, response: json({ ok: false, error: "vaultId is too long" }, 400) };
  return { ok: true, vaultId };
}

function ctxWaitUntilNoop(promise: Promise<unknown>): void {
  void promise.catch((error) => console.error("Token last_used_at update failed (non-fatal):", error));
}

function randomTokenString(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sb_obs_${encoded}`;
}

const OBSIDIAN_TOKEN_SCOPES = [
  "obsidian:push",
  "obsidian:pull",
  "obsidian:status",
  "obsidian:resolve-conflict",
  "obsidian:ack",
  "obsidian:rules",
  "obsidian:aggregates",
  "recall:read",
] as const;

function parseObsidianProperties(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function parseObsidianSyncDirection(value: unknown): ObsidianSyncDirection {
  if (typeof value === "string" && (OBSIDIAN_SYNC_DIRECTIONS as readonly string[]).includes(value)) {
    return value as ObsidianSyncDirection;
  }
  return "bidirectional";
}

function parseObsidianTags(properties: Record<string, unknown>): string[] {
  const rawTags = properties.tags;
  const values = Array.isArray(rawTags)
    ? rawTags
    : typeof rawTags === "string"
      ? rawTags.split(/[,\s]+/)
      : [];
  return values
    .map((tag) => String(tag).trim().replace(/^#/, "").toLowerCase())
    .filter((tag) => tag.length > 0 && isD1SafeTag(tag));
}

function obsidianTagsForEntry(properties: Record<string, unknown>): string[] {
  const tags = new Set<string>(["obsidian"]);
  for (const tag of parseObsidianTags(properties)) tags.add(tag);
  const rawStatus = properties.status;
  if (typeof rawStatus === "string" && (STATUS_VALUES as readonly string[]).includes(rawStatus)) {
    tags.add(`status:${rawStatus}`);
  }
  return [...tags];
}

function mergeEntryTags(existing: string[], incoming: string[]): string[] {
  const incomingStatus = getStatus(incoming);
  const base = incomingStatus
    ? existing.filter((tag) => !tag.startsWith(STATUS_PREFIX))
    : existing;
  const next = new Set<string>(base.filter(isD1SafeTag));
  for (const tag of incoming) {
    const normalized = tag.toLowerCase();
    if (isD1SafeTag(normalized)) next.add(normalized);
  }
  return [...next];
}

function parseEntryTagsJson(tagsJson: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(tagsJson ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String).filter(isD1SafeTag) : [];
  } catch {
    return [];
  }
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

export function sanitizeObsidianGeneratedText(
  value: unknown,
  mode: "text" | "wikilink" = "text"
): string {
  const singleLine = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  if (mode === "wikilink") {
    return singleLine.replace(/[\[\]|#^]/g, "").replace(/[<>]/g, "").trim();
  }
  return singleLine
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|-])/g, "\\$1");
}

function obsidianFrontmatter(input: {
  type: string;
  entryId: string;
  revisionId: string | null;
  syncEtag?: string | null;
  status: MemoryStatus | null;
  source: string;
  syncedAt: string;
  tags: string[];
  path: string;
  sourceFile?: string | null;
  entities?: string[];
  factResolutions?: string[];
}): string {
  const lines = [
    "---",
    `singularity_type: ${yamlScalar(input.type)}`,
    `singularity_id: ${yamlScalar(input.entryId)}`,
    `singularity_revision: ${yamlScalar(input.revisionId ?? "")}`,
    `singularity_sync_etag: ${yamlScalar(input.syncEtag ?? "")}`,
    `singularity_status: ${yamlScalar(input.status ?? "draft")}`,
    "singularity_kind: semantic",
    `singularity_source: ${yamlScalar(input.source)}`,
    `singularity_synced_at: ${yamlScalar(input.syncedAt)}`,
    `singularity_path: ${yamlScalar(input.path)}`,
    `source_file: ${yamlScalar(input.sourceFile ?? input.path)}`,
    "managed_by: singularity",
    ...(input.entities?.length
      ? ["singularity_entities:", ...input.entities.map((entity) => `- ${yamlScalar(entity)}`)]
      : []),
    ...(input.factResolutions?.length
      ? [
          "singularity_fact_resolutions:",
          ...input.factResolutions.map((resolution) => `- ${yamlScalar(resolution)}`),
        ]
      : []),
    "tags:",
    ...input.tags.map((tag) => `- ${yamlScalar(tag)}`),
    "---",
    "",
  ];
  return lines.join("\n");
}

function obsidianSafeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/\s+/g, " ").trim() || "untitled";
}

async function buildObsidianSyncEtag(input: {
  objectType: ObsidianObjectType;
  objectId: string | null | undefined;
  revisionId?: string | number | null;
  contentHash?: string | null;
  metadataHash?: string | null;
  status?: MemoryStatus | null;
  classificationVersion?: number | null;
  knowledgeProjectionHash?: string | null;
}): Promise<string> {
  const payload = JSON.stringify({
    objectType: input.objectType,
    objectId: input.objectId ?? "",
    revisionId: input.revisionId == null ? "" : String(input.revisionId),
    contentHash: input.contentHash ?? "",
    metadataHash: input.metadataHash ?? "",
    status: input.status ?? "",
    classificationVersion: input.classificationVersion ?? "",
    knowledgeProjectionHash: input.knowledgeProjectionHash ?? "",
  });
  return `sync2_${await contentFingerprint(payload)}`;
}

function markdownForObsidian(row: ObsidianLinkedEntryRow, syncEtag?: string | null): string {
  const tags = parseEntryTagsJson(row.tags)
    .filter((tag) => tag !== "obsidian" && !tag.startsWith("status:"));
  const frontmatter = obsidianFrontmatter({
    type: "atomic-memory",
    entryId: row.entry_id,
    revisionId: row.revision_id,
    syncEtag: syncEtag ?? row.sync_etag,
    status: row.memory_status,
    source: row.source,
    syncedAt: new Date(row.updated_at).toISOString(),
    tags: ["singularity", ...tags],
    path: row.external_path,
    sourceFile: row.external_file_id,
    entities: row.knowledge_entities.map((entity) => entity.name),
    factResolutions: row.knowledge_facts.map(
      (fact) => `${fact.statement} [${fact.resolutionType}]`
    ),
  });
  const sections: string[] = [];
  if (row.knowledge_entities.length > 0) {
    sections.push(
      "## 关联实体",
      ...row.knowledge_entities.map((entity) =>
        `- [[${sanitizeObsidianGeneratedText(entity.name, "wikilink")}]]`
      )
    );
  }
  if (row.knowledge_facts.length > 0) {
    sections.push(
      "## 事实解析",
      ...row.knowledge_facts.map((fact) =>
        `- ${sanitizeObsidianGeneratedText(fact.statement)} [${sanitizeObsidianGeneratedText(fact.resolutionType)}]${fact.requiresReview ? " (待审核)" : ""}`
      )
    );
  }
  return sections.length > 0
    ? `${frontmatter}${row.content}\n\n${OBSIDIAN_KNOWLEDGE_BEGIN}\n${sections.join("\n")}\n${OBSIDIAN_KNOWLEDGE_END}`
    : `${frontmatter}${row.content}`;
}

async function latestMemoryRevisionId(
  env: Env,
  entryId: string,
  contentOnly = false
): Promise<string | null> {
  const eventFilter = contentOnly
    ? `AND event_type IN ('ADD', 'UPDATE', 'APPEND', 'DEPRECATE', 'ROLLUP', 'UNROLL')`
    : "";
  const row = await env.DB.prepare(
    `SELECT id FROM sb_memory_revisions
     WHERE memory_id = ?
       ${eventFilter}
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(entryId).first<{ id: string }>();
  return row?.id ?? null;
}

async function memorySyncEtagFromRow(row: {
  entry_id?: string | null;
  id?: string | null;
  content_hash?: string | null;
  metadata_hash?: string | null;
  revision_id?: string | number | null;
  memory_status?: MemoryStatus | null;
  status?: MemoryStatus | null;
  classification_version?: string | number | null;
  knowledge_projection_hash?: string | null;
}): Promise<string> {
  const classificationVersion =
    row.classification_version == null ? null : Number(row.classification_version);
  return buildObsidianSyncEtag({
    objectType: "memory",
    objectId: row.entry_id ?? row.id,
    revisionId: row.revision_id,
    contentHash: row.content_hash ?? null,
    metadataHash: row.metadata_hash ?? null,
    status: row.memory_status ?? row.status ?? null,
    classificationVersion: Number.isFinite(classificationVersion) ? classificationVersion : null,
    knowledgeProjectionHash: row.knowledge_projection_hash ?? null,
  });
}

async function loadObsidianLinkByVaultPath(
  env: Env,
  vaultId: string,
  externalPath: string,
  objectType: ObsidianObjectType = "memory",
  externalBlockId = ""
): Promise<ObsidianLinkRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM sb_external_links
     WHERE provider = ? AND vault_id = ? AND external_path = ?
       AND external_block_id = ? AND object_type = ?
     ORDER BY updated_at DESC
     LIMIT 1`
  ).bind(OBSIDIAN_PROVIDER, vaultId, externalPath, externalBlockId, objectType).first<ObsidianLinkRow>();
}

async function loadObsidianLinkById(env: Env, linkId: string): Promise<ObsidianLinkRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM sb_external_links
     WHERE id = ? AND provider = ?
     LIMIT 1`
  ).bind(linkId, OBSIDIAN_PROVIDER).first<ObsidianLinkRow>();
}

async function loadObsidianSource(
  env: Env,
  vaultId: string,
  externalPath: string,
  externalBlockId: string
): Promise<ExternalSourceRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM sb_external_sources
     WHERE provider = ? AND vault_id = ? AND external_path = ? AND external_block_id = ?
     LIMIT 1`
  ).bind(OBSIDIAN_PROVIDER, vaultId, externalPath, externalBlockId).first<ExternalSourceRow>();
}

async function loadObsidianSourceById(
  env: Env,
  vaultId: string,
  sourceId: string
): Promise<ExternalSourceRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM sb_external_sources
     WHERE provider = ? AND vault_id = ? AND id = ?
     LIMIT 1`
  ).bind(OBSIDIAN_PROVIDER, vaultId, sourceId).first<ExternalSourceRow>();
}

async function loadConflictingObsidianSourcePath(
  env: Env,
  input: {
    vaultId: string;
    externalPath: string;
    externalBlockId: string;
    sourceId: string;
  }
): Promise<ExternalSourceRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM sb_external_sources
     WHERE provider = ? AND vault_id = ? AND external_path = ?
       AND external_block_id = ? AND id <> ?
     LIMIT 1`
  ).bind(
    OBSIDIAN_PROVIDER,
    input.vaultId,
    input.externalPath,
    input.externalBlockId,
    input.sourceId
  ).first<ExternalSourceRow>();
}

async function upsertObsidianSource(
  env: Env,
  input: {
    sourceId?: string;
    existing?: ExternalSourceRow | null;
    vaultId: string;
    externalPath: string;
    externalBlockId: string;
    observationId: string;
    contentHash: string;
  }
): Promise<ExternalSourceRow> {
  const now = Date.now();
  const id = input.existing?.id ?? input.sourceId ?? crypto.randomUUID();
  const revision = input.existing ? Number(input.existing.last_revision ?? 0) + 1 : 1;
  if (input.existing) {
    await env.DB.prepare(
      `UPDATE sb_external_sources
       SET external_path = ?,
           external_block_id = ?,
           current_observation_id = ?,
           last_content_hash = ?,
           last_revision = ?,
           updated_at = ?
       WHERE id = ? AND provider = ? AND vault_id = ?`
    ).bind(
      input.externalPath,
      input.externalBlockId,
      input.observationId,
      input.contentHash,
      revision,
      now,
      id,
      OBSIDIAN_PROVIDER,
      input.vaultId
    ).run();
    const row = await loadObsidianSourceById(env, input.vaultId, id);
    if (!row) throw new Error("Obsidian source update failed");
    return row;
  }
  await env.DB.prepare(
    `INSERT INTO sb_external_sources (
       id, provider, vault_id, external_path, external_block_id,
       current_observation_id, last_content_hash, last_revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, vault_id, external_path, external_block_id) DO UPDATE SET
       current_observation_id = excluded.current_observation_id,
       last_content_hash = excluded.last_content_hash,
       last_revision = excluded.last_revision,
       updated_at = excluded.updated_at`
  ).bind(
    id,
    OBSIDIAN_PROVIDER,
    input.vaultId,
    input.externalPath,
    input.externalBlockId,
    input.observationId,
    input.contentHash,
    revision,
    now,
    now
  ).run();
  const row = await loadObsidianSource(env, input.vaultId, input.externalPath, input.externalBlockId);
  if (!row) throw new Error("Obsidian source upsert failed");
  return row;
}

async function memoryIdsForObservation(env: Env, observationId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT m.entry_id
     FROM sb_memory_sources s
     JOIN sb_memories m ON m.id = s.memory_id
     WHERE s.observation_id = ?
       AND m.entry_id IS NOT NULL
       AND m.invalid_at IS NULL
       AND m.expired_at IS NULL
     ORDER BY m.created_at ASC`
  ).bind(observationId).all<{ entry_id: string }>();
  return [...new Set((results ?? []).map((row) => row.entry_id).filter(Boolean))];
}

async function reconcileObsidianSourceMemories(
  env: Env,
  oldObservationId: string | null | undefined,
  newEntryIds: string[]
): Promise<void> {
  if (!oldObservationId) return;
  const oldEntryIds = await memoryIdsForObservation(env, oldObservationId);
  const current = new Set(newEntryIds);
  const removed = oldEntryIds.filter((entryId) => !current.has(entryId));
  for (const entryId of removed) {
    const { results: memoryRows } = await env.DB.prepare(
      `SELECT id FROM sb_memories
       WHERE entry_id = ?
         AND invalid_at IS NULL
         AND expired_at IS NULL`
    ).bind(entryId).all<{ id: string }>();
    for (const memory of memoryRows ?? []) {
      await env.DB.prepare(
        `DELETE FROM sb_memory_sources
         WHERE memory_id = ? AND observation_id = ?`
      ).bind(memory.id, oldObservationId).run();
    }
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM sb_memory_sources s
       JOIN sb_memories m ON m.id = s.memory_id
       WHERE m.entry_id = ?
         AND m.invalid_at IS NULL
         AND m.expired_at IS NULL`
    ).bind(entryId).first<{ count: number }>();
    if (Number(remaining?.count ?? 0) === 0) {
      await deprecateEntry(entryId, env, "No current Obsidian source remains for this fact", OBSIDIAN_PROVIDER);
    }
  }
}

async function markObsidianLinkStatus(
  env: Env,
  linkId: string,
  status: ObsidianSyncStatus,
  lastError: string | null = null
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sb_external_links
     SET sync_status = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND provider = ?`
  ).bind(status, lastError, Date.now(), linkId, OBSIDIAN_PROVIDER).run();
}

async function upsertObsidianLink(
  env: Env,
  input: {
    existingId?: string;
    objectType: ObsidianObjectType;
    objectId: string;
    entryId?: string | null;
    vaultId: string;
    externalPath: string;
    externalBlockId?: string;
    externalFileId?: string | null;
    syncDirection: ObsidianSyncDirection;
    contentHash: string;
    revisionId: string | null;
    syncEtag?: string | null;
    status?: ObsidianSyncStatus;
    lastError?: string | null;
  }
): Promise<ObsidianLinkRow> {
  const now = Date.now();
  const id = input.existingId ?? crypto.randomUUID();
  const syncEtag = input.syncEtag ?? await buildObsidianSyncEtag({
    objectType: input.objectType,
    objectId: input.objectId,
    revisionId: input.revisionId,
    contentHash: input.contentHash,
  });
  await env.DB.prepare(
    `INSERT INTO sb_external_links (
       id, provider, vault_id, external_path, external_block_id, object_type,
       object_id, entry_id, external_file_id, content_hash,
       sync_etag, last_synced_content_hash, last_synced_revision_id,
       last_synced_sync_etag, sync_direction,
       sync_status, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, vault_id, external_path, external_block_id, object_type, object_id) DO UPDATE SET
       entry_id = excluded.entry_id,
       external_file_id = excluded.external_file_id,
       content_hash = excluded.content_hash,
       sync_etag = excluded.sync_etag,
       last_synced_content_hash = excluded.last_synced_content_hash,
       last_synced_revision_id = excluded.last_synced_revision_id,
       last_synced_sync_etag = excluded.last_synced_sync_etag,
       sync_direction = excluded.sync_direction,
       sync_status = excluded.sync_status,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`
  ).bind(
    id,
    OBSIDIAN_PROVIDER,
    input.vaultId,
    input.externalPath,
    input.externalBlockId ?? "",
    input.objectType,
    input.objectId,
    input.entryId ?? (input.objectType === "memory" ? input.objectId : null),
    input.externalFileId ?? null,
    input.contentHash,
    syncEtag,
    input.contentHash,
    input.revisionId,
    syncEtag,
    input.syncDirection,
    input.status ?? "synced",
    input.lastError ?? null,
    now,
    now
  ).run();

  const row = await env.DB.prepare(
    `SELECT * FROM sb_external_links
     WHERE provider = ? AND vault_id = ? AND external_path = ?
       AND external_block_id = ? AND object_type = ? AND object_id = ?
     LIMIT 1`
  ).bind(
    OBSIDIAN_PROVIDER,
    input.vaultId,
    input.externalPath,
    input.externalBlockId ?? "",
    input.objectType,
    input.objectId
  ).first<ObsidianLinkRow>();
  if (!row) throw new Error("Obsidian link upsert failed");
  return row;
}

async function linkObsidianObservation(
  env: Env,
  input: {
    entryId: string;
    vaultId: string;
    externalPath: string;
    externalBlockId?: string;
    content: string;
    contentHash: string;
    properties: Record<string, unknown>;
    revisionNumber?: number;
    createdAt: number;
  }
): Promise<void> {
  const observationId = crypto.randomUUID();
  const provenance = normalizeObsidianProvenance({
    sourceId: obsidianEvidenceIdentity(
      input.vaultId,
      input.externalPath,
      input.externalBlockId ?? ""
    ),
    sourceRevision: Math.max(1, Math.trunc(input.revisionNumber ?? input.createdAt) || 1),
    sourceTimestamp: input.createdAt,
    metadata: {
      vaultId: input.vaultId,
      path: input.externalPath,
      blockId: input.externalBlockId ?? "",
    },
  });
  const parentRef: ObservationParentVersionRef = {
    parentId: `${OBSIDIAN_PROVIDER}:memory:${input.entryId}`,
    versionId: crypto.randomUUID(),
    versionNumber: provenance.revision,
    evidenceRootId: provenance.rootEvidenceId,
  };
  const metadata = {
    provider: OBSIDIAN_PROVIDER,
    vault_id: input.vaultId,
    external_path: input.externalPath,
    external_block_id: input.externalBlockId ?? "",
    properties: input.properties,
    needs_reprocess: true,
    review_proposal: input.properties.managed_by === "singularity",
    evidence_type: provenance.evidenceType,
    ...observationParentVersionMetadata(parentRef),
  };
  await env.DB.batch([
    prepareObservationInsert(env.DB, {
      id: observationId,
      content: input.content,
      source: OBSIDIAN_PROVIDER,
      metadata,
      contentHash: input.contentHash,
      sourceChannel: provenance.sourceChannel,
      sourceIdentity: provenance.sourceIdentity,
      authorType: provenance.authorType,
      sourceUri: provenance.sourceUri,
      sourceTimestamp: provenance.sourceTimestamp,
      revision: provenance.revision,
      rootEvidenceId: parentRef.evidenceRootId,
      extractionStatus: "fallback",
      processedAt: input.createdAt,
      needsReprocess: true,
      createdAt: input.createdAt,
    }),
    ...prepareObservationParentVersionStatements(env.DB, {
      ...parentRef,
      observationId,
      contentHash: input.contentHash,
      metadata,
      source: OBSIDIAN_PROVIDER,
      vault: input.vaultId,
      createdAt: input.createdAt,
    }),
  ]);
  await linkObservationToAtomicMemory(env.DB, {
    entryId: input.entryId,
    content: input.content,
    contentHash: input.contentHash,
    observationId,
    parentVersionId: parentRef.versionId,
    evidenceRootId: parentRef.evidenceRootId,
    createdAt: input.createdAt,
  });
  await activateObservationParentVersion(env, { metadata_json: JSON.stringify(metadata) }, {
    state: "active_degraded",
  });
}

function serializeObsidianLink(row: ObsidianLinkRow): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    entryId: row.entry_id,
    objectType: row.object_type,
    objectId: row.object_id,
    vaultId: row.vault_id,
    path: row.external_path,
    blockId: row.external_block_id || null,
    contentHash: row.content_hash,
    syncEtag: row.sync_etag,
    lastSyncedContentHash: row.last_synced_content_hash,
    lastSyncedRevisionId: row.last_synced_revision_id,
    lastSyncedSyncEtag: row.last_synced_sync_etag,
    syncDirection: row.sync_direction,
    syncStatus: row.sync_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function serializeObsidianPullRow(row: ObsidianLinkedEntryRow): Promise<Record<string, unknown>> {
  const entryTags = parseEntryTagsJson(row.tags);
  const currentSyncEtag = await memorySyncEtagFromRow(row);
  const remoteChanged =
    currentSyncEtag !== row.last_synced_sync_etag ||
    row.revision_id !== row.last_synced_revision_id ||
    row.content_hash !== row.last_synced_content_hash;
  const syncStatus = row.sync_status === "synced" && remoteChanged
    ? "remote_changed"
    : row.sync_status;
  const link = {
    ...serializeObsidianLink(row),
    syncEtag: currentSyncEtag,
  };
  return {
    link,
    entryId: row.entry_id,
    path: row.external_path,
    content: row.content,
    markdown: markdownForObsidian(row, currentSyncEtag),
    revisionId: row.revision_id,
    contentHash: row.content_hash,
    syncEtag: currentSyncEtag,
    lastSyncedRevisionId: row.last_synced_revision_id,
    lastSyncedContentHash: row.last_synced_content_hash,
    lastSyncedSyncEtag: row.last_synced_sync_etag,
    syncStatus,
    syncDirection: row.sync_direction,
    properties: {
      singularity_id: row.entry_id,
      singularity_revision: row.revision_id,
      singularity_sync_etag: currentSyncEtag,
      singularity_status: row.memory_status ?? "draft",
      singularity_kind: "semantic",
      singularity_source: row.source,
      singularity_synced_at: new Date(row.updated_at).toISOString(),
      singularity_entities: row.knowledge_entities.map((entity) => entity.name),
      singularity_fact_resolutions: row.knowledge_facts.map(
        (fact) => `${fact.statement} [${fact.resolutionType}]`
      ),
      tags: entryTags,
    },
  };
}

async function handleObsidianAck(env: Env, body: ObsidianAckBody): Promise<Response> {
  const linkId = requiredTrimmedString(body.linkId);
  const revisionId = requiredTrimmedString(body.revisionId);
  const contentHash = requiredTrimmedString(body.contentHash);
  const requestedSyncEtag = optionalTrimmedString(body.syncEtag);
  const vaultId = requiredTrimmedString(body.vaultId); // server-set by route handler
  if (!linkId) return json({ ok: false, error: "linkId is required" }, 400);
  if (!revisionId) return json({ ok: false, error: "revisionId is required" }, 400);
  if (!contentHash) return json({ ok: false, error: "contentHash is required" }, 400);
  if (!vaultId) return json({ ok: false, error: "vaultId is required" }, 400);

  const link = await loadObsidianLinkById(env, linkId);
  if (!link || link.object_type !== "memory") {
    return json({ ok: false, error: "Obsidian memory link not found" }, 404);
  }
  // Vault binding: the link must belong to the authenticated vault.
  if (link.vault_id !== vaultId) {
    return json({ ok: false, error: "Link not found in this vault" }, 404);
  }
  const linkedRow = requestedSyncEtag ? null : await loadObsidianLinkedEntryByLink(env, link);
  const syncEtag = requestedSyncEtag ?? (linkedRow
    ? await memorySyncEtagFromRow({
      ...linkedRow,
      revision_id: revisionId,
      content_hash: contentHash,
    })
    : await buildObsidianSyncEtag({
      objectType: "memory",
      objectId: link.entry_id ?? link.object_id,
      revisionId,
      contentHash,
    }));
  await env.DB.prepare(
    `UPDATE sb_external_links
     SET last_synced_revision_id = ?,
         last_synced_content_hash = ?,
         content_hash = ?,
         sync_etag = ?,
         last_synced_sync_etag = ?,
         sync_status = 'synced',
         last_error = NULL,
         updated_at = ?
     WHERE id = ? AND provider = ? AND object_type = 'memory' AND vault_id = ?`
  ).bind(revisionId, contentHash, contentHash, syncEtag, syncEtag, Date.now(), linkId, OBSIDIAN_PROVIDER, vaultId).run();
  const updated = await loadObsidianLinkById(env, linkId);
  return json({ ok: true, link: updated ? serializeObsidianLink(updated) : null });
}

async function handleCreateObsidianToken(env: Env, body: ObsidianTokenBody): Promise<Response> {
  const vaultId = requiredTrimmedString(body.vaultId);
  if (!vaultId) return json({ ok: false, error: "vaultId is required" }, 400);
  if (vaultId.length > 128) return json({ ok: false, error: "vaultId is too long" }, 400);
  const name = optionalTrimmedString(body.name) ?? `Obsidian ${vaultId}`;
  const expiresAt = typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
    ? Math.floor(body.expiresAt)
    : null;
  const token = randomTokenString();
  const tokenHash = await contentFingerprint(token);
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sb_access_tokens (
       id, name, token_hash, scopes_json, vault_id, expires_at,
       revoked_at, created_at, last_used_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
  ).bind(
    id,
    name,
    tokenHash,
    JSON.stringify([...OBSIDIAN_TOKEN_SCOPES]),
    vaultId,
    expiresAt,
    now
  ).run();
  return json({
    ok: true,
    id,
    name,
    token,
    scopes: [...OBSIDIAN_TOKEN_SCOPES],
    vaultId,
    expiresAt,
    warning: "Store this Obsidian-scoped token now. It is shown only once.",
  }, 201);
}

function captureResultMemoryIds(result: CaptureResult): string[] {
  if (result.status === "batch") {
    return [...new Set(result.results.flatMap((item) => {
      if ("id" in item && item.status !== "failed") return [item.id];
      if (item.status === "blocked") return [item.matchId];
      return [];
    }))];
  }
  if ("id" in result && result.status !== "failed") return [result.id];
  if (result.status === "blocked") return [result.matchId];
  return [];
}

function captureResultFailures(result: CaptureResult): Array<{ id: string; reason: string }> {
  if (result.status === "failed") return [{ id: result.id, reason: result.reason }];
  if (result.status !== "batch") return [];
  return result.results.flatMap((item) =>
    item.status === "failed" ? [{ id: item.id, reason: item.reason }] : []
  );
}

function obsidianAtomicMemoryPath(entryId: string, content: string): string {
  const title = content
    .replace(/\s+/g, " ")
    .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
    .trim()
    .slice(0, 48)
    .replace(/\s+$/g, "");
  const safeTitle = title || "memory";
  return `Singularity/10 提炼知识/${safeTitle}-${entryId.slice(0, 8)}.md`;
}

function obsidianEvidenceIdentity(vaultId: string, externalPath: string, externalBlockId = ""): string {
  return `${vaultId}:${externalPath}${externalBlockId ? `#${externalBlockId}` : ""}`;
}

function obsidianEvidenceUri(vaultId: string, externalPath: string, externalBlockId = ""): string {
  const file = encodeURIComponent(externalPath);
  const vault = encodeURIComponent(vaultId);
  const block = externalBlockId ? `#${encodeURIComponent(externalBlockId)}` : "";
  return `obsidian://open?vault=${vault}&file=${file}${block}`;
}

async function createObsidianObservation(
  env: Env,
  input: {
    sourceId: string;
    sourceRevision: number;
    vaultId: string;
    externalPath: string;
    externalBlockId: string;
    content: string;
    contentHash: string;
    tags: string[];
    properties: Record<string, unknown>;
    syncDirection: ObsidianSyncDirection;
    previousObservationId?: string | null;
    createdAt: number;
  }
): Promise<ObservationExtractionRow> {
  const observationId = crypto.randomUUID();
  const parentVersionId = crypto.randomUUID();
  const provenance = normalizeObsidianProvenance({
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    sourceTimestamp: input.createdAt,
    metadata: {
      vaultId: input.vaultId,
      path: input.externalPath,
      blockId: input.externalBlockId,
    },
  });
  const parentRef: ObservationParentVersionRef = {
    parentId: input.sourceId,
    versionId: parentVersionId,
    versionNumber: provenance.revision,
    evidenceRootId: provenance.rootEvidenceId,
  };
  const metadata = {
    provider: OBSIDIAN_PROVIDER,
    vault_id: input.vaultId,
    external_path: input.externalPath,
    external_block_id: input.externalBlockId || null,
    tags: input.tags,
    properties: input.properties,
    sync_direction: input.syncDirection,
    previous_observation_id: input.previousObservationId ?? null,
    evidence_type: provenance.evidenceType,
    ...observationParentVersionMetadata(parentRef),
  };
  await env.DB.batch([
    prepareObservationInsert(env.DB, {
      id: observationId,
      content: input.content,
      source: OBSIDIAN_PROVIDER,
      metadata,
      contentHash: input.contentHash,
      sourceChannel: provenance.sourceChannel,
      sourceIdentity: provenance.sourceIdentity,
      authorType: provenance.authorType,
      sourceUri: provenance.sourceUri,
      sourceTimestamp: provenance.sourceTimestamp,
      revision: provenance.revision,
      rootEvidenceId: parentRef.evidenceRootId,
      previousEvidenceId: input.previousObservationId ?? null,
      extractionStatus: "pending",
      createdAt: input.createdAt,
    }),
    ...prepareObservationParentVersionStatements(env.DB, {
      ...parentRef,
      observationId,
      contentHash: input.contentHash,
      metadata,
      source: OBSIDIAN_PROVIDER,
      vault: input.vaultId,
      createdAt: input.createdAt,
    }),
  ]);
  return {
    id: observationId,
    content: input.content,
    source: OBSIDIAN_PROVIDER,
    metadata_json: JSON.stringify(metadata),
    created_at: input.createdAt,
    content_hash: input.contentHash,
    extraction_status: "pending",
    extraction_version: ATOMIC_EXTRACTION_VERSION,
    extraction_attempts: 0,
    extraction_error: null,
    next_attempt_at: null,
    processing_started_at: null,
    processed_at: null,
    needs_reprocess: 0,
  };
}

function obsidianMetadataFromObservation(row: Pick<ObservationExtractionRow, "metadata_json">): {
  vaultId: string;
  externalPath: string;
  externalBlockId: string;
  syncDirection: ObsidianSyncDirection;
  previousObservationId: string | null;
} | null {
  try {
    const metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>;
    const vaultId = requiredTrimmedString(metadata.vault_id);
    const externalPath = requiredTrimmedString(metadata.external_path);
    if (!vaultId || !externalPath) return null;
    return {
      vaultId,
      externalPath,
      externalBlockId: optionalTrimmedString(metadata.external_block_id) ?? "",
      syncDirection: parseObsidianSyncDirection(metadata.sync_direction),
      previousObservationId: optionalTrimmedString(metadata.previous_observation_id) ?? null,
    };
  } catch {
    return null;
  }
}

async function finalizeObsidianObservationExtraction(
  env: Env,
  row: ObservationExtractionRow
): Promise<{ memoryIds: string[]; observationLink: ObsidianLinkRow; memoryLinks: ObsidianLinkRow[] } | null> {
  if (row.source !== OBSIDIAN_PROVIDER) return null;
  const metadata = obsidianMetadataFromObservation(row);
  if (!metadata) return null;
  const contentHash = row.content_hash ?? await contentFingerprint(row.content);
  const memoryIds = await memoryIdsForObservation(env, row.id);
  const links = await linkObsidianObservationAndMemories(env, {
    vaultId: metadata.vaultId,
    externalPath: metadata.externalPath,
    externalBlockId: metadata.externalBlockId,
    observationId: row.id,
    content: row.content,
    contentHash,
    memoryIds,
    syncDirection: metadata.syncDirection,
  });
  await reconcileObsidianSourceMemories(env, metadata.previousObservationId, memoryIds);
  return { memoryIds, ...links };
}

async function processQueuedObsidianObservation(
  env: Env,
  ctx: ExecutionContext,
  observationId: string
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT id, content, source, metadata_json, created_at, content_hash,
            previous_evidence_id, root_evidence_id, source_identity,
            source_channel, revision,
            extraction_status, extraction_version, extraction_attempts,
            extraction_error, next_attempt_at, processing_started_at,
            processed_at, needs_reprocess
     FROM sb_observations
     WHERE id = ?`
  ).bind(observationId).first<ObservationExtractionRow>();
  if (!row) return;
  const processed = await processObservationExtraction(row, env, ctx, {
    fallbackOnError: true,
  });
  if (processed.status === "succeeded" || processed.status === "fallback") {
    await finalizeObsidianObservationExtraction(env, row);
  }
}

async function linkObsidianObservationAndMemories(
  env: Env,
  input: {
    vaultId: string;
    externalPath: string;
    externalBlockId: string;
    observationId: string;
    content: string;
    contentHash: string;
    memoryIds: string[];
    syncDirection: ObsidianSyncDirection;
  }
): Promise<{ observationLink: ObsidianLinkRow; memoryLinks: ObsidianLinkRow[] }> {
  const primaryMemoryId = input.memoryIds[0] ?? null;
  const observationLink = await upsertObsidianLink(env, {
    objectType: "observation",
    objectId: input.observationId,
    entryId: primaryMemoryId,
    vaultId: input.vaultId,
    externalPath: input.externalPath,
    externalBlockId: input.externalBlockId,
    syncDirection: input.syncDirection,
    contentHash: input.contentHash,
    revisionId: null,
    status: "synced",
  });

  const memoryLinks: ObsidianLinkRow[] = [];
  for (const memoryId of input.memoryIds) {
    const row = await env.DB.prepare(
      `SELECT id, content, tags, content_hash, metadata_hash, classification_version
       FROM entries
       WHERE id = ?`
    ).bind(memoryId).first<{
      id: string;
      content: string;
      tags: string;
      content_hash: string | null;
      metadata_hash: string | null;
      classification_version: number | null;
    }>();
    if (!row) continue;
    const memoryContentHash = row.content_hash ?? await contentFingerprint(row.content);
    const revisionId = await latestMemoryRevisionId(env, memoryId, false);
    const syncEtag = await memorySyncEtagFromRow({
      entry_id: memoryId,
      content_hash: memoryContentHash,
      metadata_hash: row.metadata_hash,
      revision_id: revisionId,
      memory_status: getStatus(parseEntryTagsJson(row.tags)),
      classification_version: row.classification_version,
    });
    memoryLinks.push(await upsertObsidianLink(env, {
      objectType: "memory",
      objectId: memoryId,
      entryId: memoryId,
      vaultId: input.vaultId,
      externalPath: obsidianAtomicMemoryPath(memoryId, row.content),
      externalBlockId: "",
      externalFileId: input.externalPath,
      syncDirection: input.syncDirection,
      contentHash: memoryContentHash,
      revisionId,
      syncEtag,
      status: "synced",
    }));
  }

  return { observationLink, memoryLinks };
}

async function handleObsidianPush(
  env: Env,
  ctx: ExecutionContext,
  body: ObsidianPushBody,
  options: { force?: boolean } = {}
): Promise<Response> {
  const vaultId = requiredTrimmedString(body.vaultId);
  const externalPath = requiredTrimmedString(body.path);
  if (!vaultId) return json({ ok: false, error: "vaultId is required" }, 400);
  if (!externalPath) return json({ ok: false, error: "path is required" }, 400);
  if (vaultId.length > 128) return json({ ok: false, error: "vaultId is too long" }, 400);
  if (externalPath.length > 1024) return json({ ok: false, error: "path is too long" }, 400);

  const properties = parseObsidianProperties(body.properties);
  const rawContent = requiredTrimmedString(body.content);
  const content = rawContent ? sanitizeObsidianContent(rawContent, properties) : null;
  if (!content) return json({ ok: false, error: "content is required" }, 400);
  const externalBlockId = obsidianBlockIdFromBody(body);
  const syncDirection = parseObsidianSyncDirection(body.syncDirection);
  const requestedEntryId = optionalTrimmedString(body.entryId);
  const baseRevisionId = optionalTrimmedString(body.baseRevisionId);
  const baseSyncEtag = optionalTrimmedString(body.baseSyncEtag);
  const requestedSourceId = optionalTrimmedString(body.sourceId) ??
    optionalTrimmedString(properties.singularity_source_id);
  const incomingTags = obsidianTagsForEntry(properties);
  const existingLink = await loadObsidianLinkByVaultPath(env, vaultId, externalPath, "memory", externalBlockId);
  // Enforce stored sync_direction — server is authoritative.
  // The client-supplied direction is only used for new links.
  const effectiveDirection = existingLink?.sync_direction ?? syncDirection;
  if (existingLink) {
    if (existingLink.sync_direction === "singularity_to_obsidian") {
      return json({
        ok: false,
        error: "read_only_link",
        message: "This memory link is read-only (singularity → obsidian). Push is rejected.",
      }, 403);
    }
  }
  if (existingLink && requestedEntryId && requestedEntryId !== existingLink.entry_id) {
    return json({
      ok: false,
      error: "obsidian_path_already_linked",
      link: serializeObsidianLink(existingLink),
    }, 409);
  }

  const entryId = requestedEntryId ?? existingLink?.entry_id;
  // When a scoped token provides an entryId without an existing link for this
  // vault+path, the update must be anchored to an existing link in this vault.
  // Reject cross-vault entryId injection.
  if (requestedEntryId && !existingLink) {
    return json({
      ok: false,
      error: "entry_not_in_vault",
      message: "Entry must be first linked to this vault before it can be updated",
    }, 403);
  }
  if (!entryId) {
    const now = Date.now();
    const contentHash = await contentFingerprint(content);
    const sourceById = requestedSourceId
      ? await loadObsidianSourceById(env, vaultId, requestedSourceId)
      : null;
    if (requestedSourceId && !sourceById) {
      return json({
        ok: false,
        error: "source_not_found",
        message: "Obsidian source id is not linked to this vault",
      }, 404);
    }
    if (sourceById) {
      const conflict = await loadConflictingObsidianSourcePath(env, {
        vaultId,
        externalPath,
        externalBlockId,
        sourceId: sourceById.id,
      });
      if (conflict) {
        return json({
          ok: false,
          error: "source_path_conflict",
          message: "Another Obsidian source already owns this path",
          sourceId: sourceById.id,
          conflictingSourceId: conflict.id,
        }, 409);
      }
    }
    const existingSource = sourceById ?? await loadObsidianSource(env, vaultId, externalPath, externalBlockId);
    if (existingSource?.last_content_hash === contentHash && existingSource.current_observation_id) {
      const currentObservationId = existingSource.current_observation_id;
      const sourceMoved = Boolean(sourceById) &&
        (sourceById!.external_path !== externalPath || sourceById!.external_block_id !== externalBlockId);
      const source = sourceById && sourceMoved
        ? await upsertObsidianSource(env, {
          sourceId: sourceById.id,
          existing: sourceById,
          vaultId,
          externalPath,
          externalBlockId,
          observationId: currentObservationId,
          contentHash,
        })
        : existingSource;
      const memoryIds = await memoryIdsForObservation(env, currentObservationId);
      return json({
        ok: true,
        action: "unchanged",
        status: "unchanged",
        sourceId: source.id,
        sourceRevision: Number(source.last_revision ?? 0),
        sourceHash: source.last_content_hash,
        observationId: currentObservationId,
        entryId: memoryIds[0] ?? null,
        memoryIds,
      });
    }
    const sourceId = existingSource?.id ?? crypto.randomUUID();
    const sourceRevision = existingSource ? Number(existingSource.last_revision ?? 0) + 1 : 1;
    const observation = await createObsidianObservation(env, {
      sourceId,
      sourceRevision,
      vaultId,
      externalPath,
      externalBlockId,
      content,
      contentHash,
      tags: incomingTags,
      properties,
      syncDirection,
      previousObservationId: existingSource?.current_observation_id ?? null,
      createdAt: now,
    });
    const source = await upsertObsidianSource(env, {
      sourceId,
      existing: existingSource,
      vaultId,
      externalPath,
      externalBlockId,
      observationId: observation.id,
      contentHash,
    });
    const { observationLink } = await linkObsidianObservationAndMemories(env, {
      vaultId,
      externalPath,
      externalBlockId,
      observationId: observation.id,
      content,
      contentHash,
      memoryIds: [],
      syncDirection,
    });
    ctx.waitUntil(
      processQueuedObsidianObservation(env, ctx, observation.id)
        .catch((error) => console.error("Obsidian async extraction failed:", error))
    );
    return json({
      ok: true,
      action: "queued",
      status: "queued",
      sourceId: source.id,
      sourceRevision: Number(source.last_revision ?? 0),
      sourceHash: source.last_content_hash,
      observationId: observation.id,
      entryId: null,
      memoryIds: [],
      extractionStatus: "pending",
      revisionId: null,
      link: null,
      observationLink: serializeObsidianLink(observationLink),
      memoryLinks: [],
    }, 202);
  }

  const row = await env.DB.prepare(
    `SELECT e.id, e.content, e.tags, e.source, e.content_hash, e.metadata_hash, e.classification_version
     FROM entries e
     JOIN sb_external_links l ON l.entry_id = e.id
     WHERE e.id = ?
       AND l.provider = ?
       AND l.object_type = 'memory'
       AND l.vault_id = ?
       AND l.external_path = ?
       AND l.external_block_id = ?
     LIMIT 1`
  ).bind(entryId, OBSIDIAN_PROVIDER, vaultId, externalPath, externalBlockId).first<Record<string, any>>();
  if (!row) {
    if (existingLink) await markObsidianLinkStatus(env, existingLink.id, "deleted_remote", "linked memory is missing");
    return json({ ok: false, error: `Entry not found or not linked to this vault: ${entryId}` }, 403);
  }

  const oldContent = row.content as string;
  const oldTags = parseEntryTagsJson(row.tags as string | null);
  const newTags = mergeEntryTags(oldTags, incomingTags);
  const source = row.source as string;
  const latestRevisionId = await latestMemoryRevisionId(env, entryId, false);
  const effectiveBaseRevisionId = baseRevisionId ?? existingLink?.last_synced_revision_id ?? undefined;
  const tagsChanged = JSON.stringify(oldTags) !== JSON.stringify(newTags);
  const contentChanged = oldContent !== content;
  const memoryStatus = getStatus(oldTags);
  const currentSyncEtag = await memorySyncEtagFromRow({
    entry_id: entryId,
    content_hash: row.content_hash as string | null,
    metadata_hash: row.metadata_hash as string | null,
    revision_id: latestRevisionId,
    memory_status: memoryStatus,
    classification_version: row.classification_version as string | number | null,
  });
  const effectiveBaseSyncEtag = baseSyncEtag ?? existingLink?.last_synced_sync_etag ?? undefined;
  if (
    !options.force &&
    effectiveBaseSyncEtag &&
    currentSyncEtag !== effectiveBaseSyncEtag &&
    (contentChanged || tagsChanged)
  ) {
    if (existingLink) {
      await markObsidianLinkStatus(env, existingLink.id, "conflict", "remote memory changed since Obsidian sync etag");
    }
    return json({
      ok: false,
      error: "obsidian_sync_conflict",
      entryId,
      baseRevisionId: effectiveBaseRevisionId ?? null,
      currentRevisionId: latestRevisionId,
      baseSyncEtag: effectiveBaseSyncEtag,
      currentSyncEtag,
      link: existingLink ? serializeObsidianLink({
        ...existingLink,
        sync_status: "conflict",
        last_error: "remote memory changed since Obsidian sync etag",
        updated_at: Date.now(),
      }) : null,
    }, 409);
  }
  if (
    !options.force &&
    effectiveBaseRevisionId &&
    latestRevisionId &&
    effectiveBaseRevisionId !== latestRevisionId &&
    (contentChanged || tagsChanged)
  ) {
    if (existingLink) {
      await markObsidianLinkStatus(env, existingLink.id, "conflict", "remote memory changed since Obsidian base revision");
    } else {
      // This branch only fires for owner tokens or legacy links with no vault binding.
      await upsertObsidianLink(env, {
        objectType: "memory",
        objectId: entryId,
        entryId,
        vaultId,
        externalPath,
        externalBlockId,
        syncDirection: effectiveDirection, // use stored direction, not client-supplied
        contentHash: (row.content_hash as string | null) ?? await contentFingerprint(oldContent),
        revisionId: latestRevisionId,
        status: "conflict",
        lastError: "remote memory changed since Obsidian base revision",
      });
    }
    return json({
      ok: false,
      error: "obsidian_sync_conflict",
      entryId,
      baseRevisionId: effectiveBaseRevisionId,
      currentRevisionId: latestRevisionId,
      link: existingLink ? serializeObsidianLink({
        ...existingLink,
        sync_status: "conflict",
        last_error: "remote memory changed since Obsidian base revision",
        updated_at: Date.now(),
      }) : null,
    }, 409);
  }

  let finalRevisionId = latestRevisionId;
  let contentHash = (row.content_hash as string | null) ?? await contentFingerprint(oldContent);
  let vectors = 0;
  let atomicSyncWarning: string | undefined;
  let atomicWarnings: string[] = [];
  if (contentChanged || tagsChanged) {
    let newVectorIds: string[];
    try {
      newVectorIds = await commitEntryVersion(env, {
        id: entryId,
        oldContent,
        newContent: content,
        oldTags,
        newTags,
        source,
        eventType: "UPDATE",
        reason: `Obsidian push from ${vaultId}:${externalPath}`,
        actor: OBSIDIAN_PROVIDER,
      });
    } catch (error) {
      console.error("Obsidian update vector switch failed:", error);
      if (existingLink) await markObsidianLinkStatus(env, existingLink.id, "error", "vector switch failed");
      return json({
        ok: false,
        error: "Obsidian push could not be indexed. Previous content remains active; retry later.",
      }, 503);
    }
    vectors = newVectorIds.length;
    contentHash = await contentFingerprint(content);
    finalRevisionId = await latestMemoryRevisionId(env, entryId, false);
    const updateObservedAt = Date.now();
    try {
      const atomicMutation = await replaceEntryAtomicMemoryAndEnqueue(env, {
        entryId,
        content,
        contentHash,
        source: OBSIDIAN_PROVIDER,
        actor: mutationActorForSource(OBSIDIAN_PROVIDER),
        eventType: "update",
        createdAt: updateObservedAt,
      });
      atomicWarnings = atomicMutation.warnings;
    } catch (error) {
      console.error("Obsidian atomic memory update sync failed (non-fatal):", error);
      atomicSyncWarning = "atomic_sync_failed";
    }
    if (atomicSyncWarning === "atomic_sync_failed") {
      if (existingLink) await markObsidianLinkStatus(env, existingLink.id, "error", "atomic memory sync failed");
      return json({
        ok: false,
        error: "atomic_sync_failed",
        message: "Obsidian push changed the entry projection, but Evidence/Claim sync failed. The entry is excluded from strict recall until repair.",
      }, 503);
    }
    try {
      await linkObsidianObservation(env, {
        entryId,
        vaultId,
        externalPath,
        externalBlockId,
        content,
        contentHash,
        properties,
        revisionNumber: updateObservedAt,
        createdAt: updateObservedAt,
      });
    } catch (error) {
      console.error("Obsidian evidence revision link failed (non-fatal):", error);
      atomicSyncWarning = atomicSyncWarning ?? "evidence_link_failed";
    }
    scheduleClassifyAndTag(entryId, content, env, ctx);
  }

  const link = await upsertObsidianLink(env, {
    existingId: existingLink?.id,
    objectType: "memory",
    objectId: entryId,
    entryId,
    vaultId,
    externalPath,
    externalBlockId,
    syncDirection: effectiveDirection,
    contentHash,
    revisionId: finalRevisionId,
    syncEtag: await memorySyncEtagFromRow({
      entry_id: entryId,
      content_hash: contentHash,
      metadata_hash: contentChanged || tagsChanged
        ? await entryMetadataFingerprint({ source, tags: newTags })
        : row.metadata_hash as string | null,
      revision_id: finalRevisionId,
      memory_status: getStatus(newTags),
      classification_version: row.classification_version as string | number | null,
    }),
    status: "synced",
  });

  return json({
    ok: true,
    action: contentChanged || tagsChanged ? "updated" : "unchanged",
    entryId,
    revisionId: finalRevisionId,
    vectors,
    warning: atomicSyncWarning,
    warnings: atomicWarnings,
    link: serializeObsidianLink(link),
  });
}

type ObsidianKnowledgeProjection = {
  entities: ObsidianKnowledgeEntity[];
  facts: ObsidianKnowledgeFact[];
  hash: string | null;
};

async function loadObsidianKnowledgeProjections(
  env: Env,
  entryIds: string[]
): Promise<Map<string, ObsidianKnowledgeProjection>> {
  const ids = [...new Set(entryIds.filter(Boolean))];
  const projections = new Map<string, ObsidianKnowledgeProjection>();
  if (ids.length === 0) return projections;
  await ensureEntityResolutionDataModel(env.DB);
  const placeholders = ids.map(() => "?").join(",");
  const activeClaimPredicate = `
    m.content_hash IS NOT NULL
    AND en.content_hash = m.content_hash
    AND ${activeMemoryClaimPredicate("m", String(Date.now()), { requireActiveParentLink: true })}`;
  const entityRows = await env.DB.prepare(
    `SELECT DISTINCT en.id AS entry_id, e.id, e.name, e.entity_type
     FROM entries en
     JOIN sb_memories m ON m.entry_id = en.id
     JOIN sb_memory_entities me ON me.memory_id = m.id
     JOIN sb_entities e ON e.id = me.entity_id
     WHERE en.id IN (${placeholders})
       AND ${activeClaimPredicate}
     ORDER BY en.id ASC, lower(e.name) ASC, e.id ASC`
  ).bind(...ids).all<{ entry_id: string; id: string; name: string; entity_type: string | null }>();
  const factRows = await env.DB.prepare(
    `SELECT en.id AS entry_id, r.id, r.fact, r.relation_type, r.scope_id,
            r.resolution_type AS stored_resolution_type,
            fe.name AS from_name, te.name AS to_name,
            fr.resolution_type, fr.requires_review
     FROM entries en
     JOIN sb_memories m ON m.entry_id = en.id
     JOIN sb_fact_sources rfs ON rfs.memory_id = m.id
     JOIN sb_entity_relations r ON r.id = rfs.relation_id
     JOIN sb_entities fe ON fe.id = r.from_entity_id
     JOIN sb_entities te ON te.id = r.to_entity_id
     LEFT JOIN sb_fact_resolutions fr ON fr.id = (
       SELECT latest.id
       FROM sb_fact_resolutions latest
       WHERE latest.relation_id = r.id
       ORDER BY latest.created_at DESC, latest.id DESC
       LIMIT 1
     )
     WHERE en.id IN (${placeholders})
       AND r.invalid_at IS NULL
       AND r.expired_at IS NULL
       AND r.resolution_state = 'active'
       AND ${activeClaimPredicate}
     ORDER BY en.id ASC, r.created_at DESC, r.id ASC`
  ).bind(...ids).all<{
    entry_id: string;
    id: string;
    fact: string | null;
    relation_type: string;
    scope_id: string | null;
    stored_resolution_type: string | null;
    from_name: string;
    to_name: string;
    resolution_type: string | null;
    requires_review: number | null;
  }>();
  for (const entryId of ids) {
    const entities = (entityRows.results ?? [])
      .filter((entity) => entity.entry_id === entryId)
      .slice(0, 100)
      .map((entity) => ({
        id: entity.id,
        name: entity.name,
        entityType: entity.entity_type,
      }));
    const facts = (factRows.results ?? [])
      .filter((fact) => fact.entry_id === entryId)
      .slice(0, 100)
      .map((fact) => ({
        relationId: fact.id,
        statement: fact.fact?.trim() || `${fact.from_name} ${fact.relation_type} ${fact.to_name}`,
        fromName: fact.from_name,
        predicate: fact.relation_type,
        toName: fact.to_name,
        scopeId: fact.scope_id,
        resolutionType: fact.resolution_type ?? fact.stored_resolution_type ?? "coexists",
        requiresReview: Number(fact.requires_review ?? 0) === 1,
      }));
    const hash = entities.length || facts.length
      ? await contentFingerprint(JSON.stringify({ entities, facts }))
      : null;
    projections.set(entryId, { entities, facts, hash });
  }
  return projections;
}

async function loadObsidianKnowledgeProjection(
  env: Env,
  entryId: string
): Promise<ObsidianKnowledgeProjection> {
  const projections = await loadObsidianKnowledgeProjections(env, [entryId]);
  return projections.get(entryId) ?? { entities: [], facts: [], hash: null };
}

async function loadObsidianLinkedEntryByLink(
  env: Env,
  link: ObsidianLinkRow
): Promise<ObsidianLinkedEntryRow | null> {
  const row = await env.DB.prepare(
    `SELECT
       l.*,
       e.content,
       e.tags,
       e.source,
       e.created_at AS entry_created_at,
       e.content_hash,
       e.metadata_hash,
       e.classification_version,
       (
         SELECT id FROM sb_memory_revisions r
         WHERE r.memory_id = e.id
         ORDER BY r.created_at DESC
         LIMIT 1
       ) AS revision_id
     FROM sb_external_links l
     JOIN entries e ON e.id = l.entry_id
     WHERE l.id = ? AND l.provider = ?
       AND l.object_type = 'memory'
     LIMIT 1`
  ).bind(link.id, OBSIDIAN_PROVIDER).first<Record<string, any>>();
  if (!row) return null;
  const tags = parseEntryTagsJson(row.tags as string | null);
  const projection = await loadObsidianKnowledgeProjection(env, String(row.entry_id));
  return {
    ...(row as ObsidianLinkedEntryRow),
    memory_status: getStatus(tags),
    knowledge_entities: projection.entities,
    knowledge_facts: projection.facts,
    knowledge_projection_hash: projection.hash,
  };
}

async function handleObsidianResolveConflict(
  env: Env,
  ctx: ExecutionContext,
  body: ObsidianResolveConflictBody
): Promise<Response> {
  const linkId = optionalTrimmedString(body.linkId);
  const vaultId = requiredTrimmedString(body.vaultId); // server-set by route handler
  const externalPath = optionalTrimmedString(body.path);
  const resolution = optionalTrimmedString(body.resolution);
  if (!resolution) return json({ ok: false, error: "resolution is required" }, 400);
  if (!vaultId) return json({ ok: false, error: "vaultId is required" }, 400);

  const link = linkId
    ? await loadObsidianLinkById(env, linkId)
    : vaultId && externalPath
      ? await loadObsidianLinkByVaultPath(env, vaultId, externalPath)
      : null;
  if (!link) return json({ ok: false, error: "Obsidian link not found" }, 404);
  // Vault binding: the link must belong to the authenticated vault.
  if (link.vault_id !== vaultId) {
    return json({ ok: false, error: "Link not found in this vault" }, 404);
  }

  const normalizedResolution = resolution.toLowerCase();
  if (["use_singularity", "singularity", "remote"].includes(normalizedResolution)) {
    const row = await loadObsidianLinkedEntryByLink(env, link);
    if (!row) {
      await markObsidianLinkStatus(env, link.id, "deleted_remote", "linked memory is missing");
      return json({ ok: false, error: "Linked memory is missing" }, 404);
    }
    const contentHash = row.content_hash ?? await contentFingerprint(row.content);
    const revisionId = row.revision_id ?? await latestMemoryRevisionId(env, row.entry_id, false);
    const syncEtag = await memorySyncEtagFromRow({
      ...row,
      revision_id: revisionId,
      content_hash: contentHash,
    });
    const synced = await upsertObsidianLink(env, {
      existingId: link.id,
      objectType: "memory",
      objectId: row.entry_id,
      entryId: row.entry_id,
      vaultId: row.vault_id,
      externalPath: row.external_path,
      externalBlockId: row.external_block_id,
      externalFileId: row.external_file_id,
      syncDirection: row.sync_direction,
      contentHash,
      revisionId,
      syncEtag,
      status: "synced",
    });
    return json({
      ok: true,
      resolution: "use_singularity",
      entryId: row.entry_id,
      revisionId,
      markdown: markdownForObsidian({ ...row, revision_id: revisionId }, syncEtag),
      link: serializeObsidianLink(synced),
    });
  }

  if (["use_obsidian", "obsidian", "local"].includes(normalizedResolution)) {
    const content = requiredTrimmedString(body.content);
    if (!content) return json({ ok: false, error: "content is required when resolving with Obsidian" }, 400);
    return handleObsidianPush(env, ctx, {
      vaultId: link.vault_id,
      path: link.external_path,
      content,
      properties: body.properties,
      entryId: link.entry_id,
      baseRevisionId: body.baseRevisionId,
      baseSyncEtag: body.baseSyncEtag,
      syncDirection: link.sync_direction,
    }, { force: true });
  }

  return json({
    ok: false,
    error: "resolution must be one of: use_singularity, use_obsidian",
  }, 400);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function parseJsonArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function serializeJsonObject(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseBooleanFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "enabled"].includes(normalized)) return true;
    if (["0", "false", "no", "disabled"].includes(normalized)) return false;
  }
  return fallback;
}

function serializeAutomationRule(row: AutomationRuleRow): Record<string, unknown> {
  return {
    id: row.id,
    vaultId: row.vault_id,
    name: row.name,
    triggerType: row.trigger_type,
    sourceFilter: serializeJsonObject(row.source_filter_json),
    extractorSchema: serializeJsonObject(row.extractor_schema_json),
    tagRules: serializeJsonObject(row.tag_rules_json),
    aggregationRule: serializeJsonObject(row.aggregation_rule_json),
    outputTemplate: row.output_template,
    enabled: Number(row.enabled ?? 0) === 1,
    version: Number(row.version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleListObsidianRules(env: Env, vaultId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM sb_automation_rules
     WHERE vault_id IS NULL OR vault_id = ?
     ORDER BY enabled DESC, updated_at DESC
     LIMIT 200`
  ).bind(vaultId).all<AutomationRuleRow>();
  return json({
    ok: true,
    vaultId,
    count: (results ?? []).length,
    results: (results ?? []).map(serializeAutomationRule),
  });
}

async function handleUpsertObsidianRule(env: Env, body: ObsidianRuleBody): Promise<Response> {
  const vaultId = requiredTrimmedString(body.vaultId); // server-set by route handler
  const name = requiredTrimmedString(body.name);
  const triggerType = requiredTrimmedString(body.triggerType);
  if (!vaultId) return json({ ok: false, error: "vaultId is required" }, 400);
  if (!name) return json({ ok: false, error: "name is required" }, 400);
  if (!triggerType) return json({ ok: false, error: "triggerType is required" }, 400);
  if (vaultId.length > 128) return json({ ok: false, error: "vaultId is too long" }, 400);

  const id = optionalTrimmedString(body.id) ?? crypto.randomUUID();
  const existing = await env.DB.prepare(
    `SELECT * FROM sb_automation_rules WHERE id = ? AND vault_id = ?`
  ).bind(id, vaultId).first<AutomationRuleRow>();
  // If client supplied an id but no row exists for this vault, create fresh —
  // never allow a scoped token to take over a rule from another vault.
  if (optionalTrimmedString(body.id) && !existing) {
    return json({ ok: false, error: "Rule not found in this vault" }, 404);
  }
  const now = Date.now();
  const sourceFilter = { ...parseJsonObject(body.sourceFilter), vaultId };
  const version = existing ? Number(existing.version ?? 1) + 1 : 1;
  await env.DB.prepare(
    `INSERT INTO sb_automation_rules (
       id, vault_id, name, trigger_type, source_filter_json,
       extractor_schema_json, tag_rules_json, aggregation_rule_json,
       output_template, enabled, version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       vault_id = excluded.vault_id,
       name = excluded.name,
       trigger_type = excluded.trigger_type,
       source_filter_json = excluded.source_filter_json,
       extractor_schema_json = excluded.extractor_schema_json,
       tag_rules_json = excluded.tag_rules_json,
       aggregation_rule_json = excluded.aggregation_rule_json,
       output_template = excluded.output_template,
       enabled = excluded.enabled,
       version = excluded.version,
       updated_at = excluded.updated_at`
  ).bind(
    id,
    vaultId,
    name,
    triggerType,
    JSON.stringify(sourceFilter),
    JSON.stringify(parseJsonObject(body.extractorSchema)),
    JSON.stringify(parseJsonObject(body.tagRules)),
    JSON.stringify(parseJsonObject(body.aggregationRule)),
    optionalTrimmedString(body.outputTemplate) ?? null,
    parseBooleanFlag(body.enabled, existing ? Number(existing.enabled ?? 0) === 1 : true) ? 1 : 0,
    version,
    existing?.created_at ?? now,
    now
  ).run();
  const row = await env.DB.prepare(
    `SELECT * FROM sb_automation_rules WHERE id = ? AND vault_id = ?`
  ).bind(id, vaultId).first<AutomationRuleRow>();
  return json({ ok: true, rule: row ? serializeAutomationRule(row) : null }, existing ? 200 : 201);
}

function parseMemoryIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((id) => id.trim()).filter(Boolean))].slice(0, 200);
}

async function loadAggregateSourceMemories(
  env: Env,
  ids: string[],
  vaultId: string
): Promise<Array<{ id: string; content: string; tags: string; created_at: number }>> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, content, tags, created_at
     FROM entries
     WHERE id IN (${placeholders})
       AND tags NOT LIKE '%"status:deprecated"%'
       AND EXISTS (
         SELECT 1
         FROM sb_external_links l
         WHERE l.entry_id = entries.id
           AND l.provider = ?
           AND l.object_type = 'memory'
           AND l.vault_id = ?
       )
     ORDER BY created_at DESC`
  ).bind(...ids, OBSIDIAN_PROVIDER, vaultId).all<{ id: string; content: string; tags: string; created_at: number }>();
  const order = new Map(ids.map((id, index) => [id, index]));
  return [...(results ?? [])].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

function renderKnowledgeAggregateContent(input: {
  title: string;
  aggregateType: string;
  sourceMemories: Array<{ id: string; content: string; tags: string; created_at: number }>;
  rule: AutomationRuleRow | null;
}): string {
  const lines = [`# ${input.title}`, ""];
  lines.push(`类型: ${input.aggregateType}`);
  if (input.rule) lines.push(`规则: ${input.rule.name}`);
  lines.push("");
  lines.push("## 来源记忆");
  for (const memory of input.sourceMemories) {
    const tags = parseEntryTagsJson(memory.tags).filter((tag) => !tag.startsWith("status:"));
    const tagSuffix = tags.length ? ` (${tags.join(", ")})` : "";
    lines.push(`- ${memory.content}${tagSuffix}`);
  }
  return lines.join("\n").trim();
}

function aggregatePath(input: { id: string; title: string }): string {
  return `Singularity/20 知识聚合/${obsidianSafeFileName(input.title).slice(0, 64)}-${input.id.slice(0, 8)}.md`;
}

function aggregateFrontmatter(row: KnowledgeAggregateRow, link: ObsidianLinkRow | null, syncEtag?: string | null): string {
  const tags = ["singularity", "aggregate", `aggregate/${row.aggregate_type}`];
  return [
    "---",
    `singularity_type: ${yamlScalar("knowledge-aggregate")}`,
    `singularity_id: ${yamlScalar(row.id)}`,
    `singularity_revision: ${yamlScalar(String(row.generated_at))}`,
    `singularity_sync_etag: ${yamlScalar(syncEtag ?? link?.sync_etag ?? row.sync_etag ?? "")}`,
    `singularity_status: ${yamlScalar(row.stale_at ? "stale" : "canonical")}`,
    `singularity_source: ${yamlScalar("singularity")}`,
    `singularity_synced_at: ${yamlScalar(new Date(row.updated_at).toISOString())}`,
    `singularity_path: ${yamlScalar(link?.external_path ?? aggregatePath({ id: row.id, title: row.title }))}`,
    `generation_rule_id: ${yamlScalar(row.generation_rule_id ?? "")}`,
    "managed_by: singularity",
    "tags:",
    ...tags.map((tag) => `- ${yamlScalar(tag)}`),
    "---",
    "",
  ].join("\n");
}

function markdownForAggregate(row: KnowledgeAggregateRow, link: ObsidianLinkRow | null, syncEtag?: string | null): string {
  return `${aggregateFrontmatter(row, link, syncEtag)}${row.content}`;
}

async function aggregateSyncEtag(row: Pick<KnowledgeAggregateRow, "id" | "generated_at" | "content_hash" | "stale_at">): Promise<string> {
  return buildObsidianSyncEtag({
    objectType: "aggregate",
    objectId: row.id,
    revisionId: row.generated_at,
    contentHash: row.content_hash ?? "",
    status: row.stale_at ? "draft" : "canonical",
  });
}

async function serializeKnowledgeAggregate(row: KnowledgeAggregateRow): Promise<Record<string, unknown>> {
  const contentHash = row.content_hash ?? "";
  const syncEtag = await aggregateSyncEtag({ ...row, content_hash: contentHash });
  const link = row.link_id ? {
    id: row.link_id,
    path: row.external_path,
    syncEtag,
    lastSyncedSyncEtag: row.last_synced_sync_etag ?? null,
    syncStatus: row.sync_status ?? "synced",
    syncDirection: row.sync_direction ?? "singularity_to_obsidian",
  } : null;
  return {
    id: row.id,
    vaultId: row.vault_id,
    aggregateType: row.aggregate_type,
    title: row.title,
    sourceMemoryIds: parseJsonArray(row.source_memory_ids_json),
    generationRuleId: row.generation_rule_id,
    content: row.content,
    contentHash,
    syncEtag,
    generatedAt: row.generated_at,
    staleAt: row.stale_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    path: row.external_path ?? aggregatePath({ id: row.id, title: row.title }),
    markdown: markdownForAggregate(row, row.link_id ? {
      id: row.link_id,
      provider: OBSIDIAN_PROVIDER,
      entry_id: null,
      vault_id: row.vault_id ?? "",
      external_path: row.external_path ?? aggregatePath({ id: row.id, title: row.title }),
      external_block_id: "",
      object_type: "aggregate",
      object_id: row.id,
      external_file_id: null,
      content_hash: contentHash,
      sync_etag: syncEtag,
      last_synced_content_hash: contentHash,
      last_synced_revision_id: String(row.generated_at),
      last_synced_sync_etag: row.last_synced_sync_etag ?? null,
      sync_direction: row.sync_direction ?? "singularity_to_obsidian",
      sync_status: row.sync_status ?? "synced",
      last_error: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    } : null, syncEtag),
    link,
  };
}

async function handleListObsidianAggregates(env: Env, vaultId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT
       a.*,
       l.id AS link_id,
       l.external_path,
       l.sync_etag,
       l.last_synced_sync_etag,
       l.sync_status,
       l.sync_direction
     FROM sb_knowledge_aggregates a
     LEFT JOIN sb_external_links l
       ON l.provider = ?
      AND l.object_type = 'aggregate'
      AND l.object_id = a.id
      AND l.vault_id = ?
     WHERE a.vault_id IS NULL OR a.vault_id = ?
     ORDER BY COALESCE(a.stale_at, 0) DESC, a.updated_at DESC
     LIMIT 200`
  ).bind(OBSIDIAN_PROVIDER, vaultId, vaultId).all<KnowledgeAggregateRow>();
  const serialized = await Promise.all((results ?? []).map(serializeKnowledgeAggregate));
  return json({
    ok: true,
    vaultId,
    count: (results ?? []).length,
    results: serialized,
  });
}

async function handleGenerateObsidianAggregate(
  env: Env,
  body: ObsidianAggregateGenerateBody
): Promise<Response> {
  const vaultId = requiredTrimmedString(body.vaultId); // server-set by route handler
  const title = requiredTrimmedString(body.title);
  const aggregateType = requiredTrimmedString(body.aggregateType) ?? "topic";
  if (!vaultId) return json({ ok: false, error: "vaultId is required" }, 400);
  if (!title) return json({ ok: false, error: "title is required" }, 400);
  if (vaultId.length > 128) return json({ ok: false, error: "vaultId is too long" }, 400);

  const sourceMemoryIds = parseMemoryIdList(body.sourceMemoryIds);
  if (!sourceMemoryIds.length) {
    return json({ ok: false, error: "sourceMemoryIds must contain at least one memory id" }, 400);
  }
  const sourceMemories = await loadAggregateSourceMemories(env, sourceMemoryIds, vaultId);
  if (!sourceMemories.length) return json({ ok: false, error: "No active source memories found" }, 404);

  const generationRuleId = optionalTrimmedString(body.generationRuleId) ?? null;
  const rule = generationRuleId
    ? await env.DB.prepare(
      `SELECT * FROM sb_automation_rules WHERE id = ? AND (vault_id IS NULL OR vault_id = ?)`
    ).bind(generationRuleId, vaultId).first<AutomationRuleRow>()
    : null;
  const incomingId = optionalTrimmedString(body.id);
  // Vault binding: if client supplied an id, verify it belongs to this vault.
  if (incomingId) {
    const existing = await env.DB.prepare(
      `SELECT id FROM sb_knowledge_aggregates WHERE id = ? AND vault_id = ?`
    ).bind(incomingId, vaultId).first<{ id: string }>();
    if (!existing) {
      return json({ ok: false, error: "Aggregate not found in this vault" }, 404);
    }
  }
  const id = incomingId ?? crypto.randomUUID();
  const now = Date.now();
  const content = renderKnowledgeAggregateContent({
    title,
    aggregateType,
    sourceMemories,
    rule,
  });
  const contentHash = await contentFingerprint(content);
  await env.DB.prepare(
    `INSERT INTO sb_knowledge_aggregates (
       id, vault_id, aggregate_type, title, source_memory_ids_json,
       generation_rule_id, content, content_hash, generated_at,
       stale_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       vault_id = excluded.vault_id,
       aggregate_type = excluded.aggregate_type,
       title = excluded.title,
       source_memory_ids_json = excluded.source_memory_ids_json,
       generation_rule_id = excluded.generation_rule_id,
       content = excluded.content,
       content_hash = excluded.content_hash,
       generated_at = excluded.generated_at,
       stale_at = NULL,
       updated_at = excluded.updated_at`
  ).bind(
    id,
    vaultId,
    aggregateType,
    title,
    JSON.stringify(sourceMemories.map((memory) => memory.id)),
    generationRuleId,
    content,
    contentHash,
    now,
    now,
    now
  ).run();
  const path = optionalTrimmedString(body.outputPath) ?? aggregatePath({ id, title });
  const link = await upsertObsidianLink(env, {
    objectType: "aggregate",
    objectId: id,
    entryId: null,
    vaultId,
    externalPath: path,
    externalBlockId: "",
    syncDirection: parseObsidianSyncDirection(body.syncDirection ?? "singularity_to_obsidian"),
    contentHash,
    revisionId: String(now),
    syncEtag: await buildObsidianSyncEtag({
      objectType: "aggregate",
      objectId: id,
      revisionId: now,
      contentHash,
      status: "canonical",
    }),
    status: "synced",
  });
  const aggregate = await env.DB.prepare(
    `SELECT
       a.*,
       l.id AS link_id,
       l.external_path,
       l.sync_etag,
       l.last_synced_sync_etag,
       l.sync_status,
       l.sync_direction
     FROM sb_knowledge_aggregates a
     LEFT JOIN sb_external_links l
       ON l.provider = ?
      AND l.object_type = 'aggregate'
      AND l.object_id = a.id
      AND l.vault_id = ?
     WHERE a.id = ?`
  ).bind(OBSIDIAN_PROVIDER, vaultId, id).first<KnowledgeAggregateRow>();
  return json({
    ok: true,
    aggregate: aggregate ? await serializeKnowledgeAggregate(aggregate) : null,
    link: serializeObsidianLink(link),
  }, 201);
}

async function markKnowledgeAggregatesStaleForMemoryIds(
  env: Env,
  memoryIds: string[],
  staleAt = Date.now()
): Promise<void> {
  const uniqueIds = [...new Set(memoryIds.filter(Boolean))];
  for (const memoryId of uniqueIds) {
    await env.DB.prepare(
      `UPDATE sb_knowledge_aggregates
       SET stale_at = COALESCE(stale_at, ?),
           updated_at = ?
       WHERE source_memory_ids_json LIKE ?`
    ).bind(staleAt, staleAt, `%"${memoryId}"%`).run();
  }
}

async function notifyMemoryChanged(
  env: Env,
  entryId: string,
  changeType: "content" | "metadata" | "status" | "classification" | "deleted"
): Promise<void> {
  try {
    await markKnowledgeAggregatesStaleForMemoryIds(env, [entryId], Date.now());
  } catch (error) {
    console.error(`Knowledge aggregate stale notification failed (${changeType})`, error);
  }
}

async function findExactDuplicateId(
  env: Env,
  content: string,
  hash: string
): Promise<string | null> {
  const byHash = await env.DB.prepare(
    `SELECT id FROM entries
     WHERE content_hash = ?
       AND tags NOT LIKE '%"status:deprecated"%'
     LIMIT 1`
  ).bind(hash).first<{ id: string }>();
  if (byHash?.id) return byHash.id;

  // Legacy rows written before content_hash existed.
  const byContent = await env.DB.prepare(
    `SELECT id FROM entries
     WHERE content = ?
       AND tags NOT LIKE '%"status:deprecated"%'
     LIMIT 1`
  ).bind(content).first<{ id: string }>();
  return byContent?.id ?? null;
}

// ─── Duplicate / similarity detection ─────────────────────────────────────────

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
// Applies to the flagged band (≥0.85), including former hard-block scores (≥0.95).
// Combined prompt handles contradiction + merge/replace in one LLM call.

export type MergeAction =
  | { action: "keep_both" }
  | { action: "replace"; target_id: string }
  | { action: "merge"; target_id: string };

async function filterActiveVectorMatches(
  matches: VectorizeMatch[],
  env: Env
): Promise<VectorizeMatch[]> {
  if (!matches.length) return [];
  const parentIds = [...new Set(
    matches.map(match => ((match.metadata as any)?.parentId ?? match.id) as string)
  )];
  const activeByParent = new Map<string, Set<string>>();

  for (let i = 0; i < parentIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = parentIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = batch.map(() => "?").join(", ");
    const { results: rows } = await env.DB.prepare(
      `SELECT id, vector_ids, tags FROM entries WHERE id IN (${placeholders})`
    ).bind(...batch).all() as { results: Array<{ id: string; vector_ids: string; tags: string }> };
    for (const row of rows) {
      try {
        const tags = JSON.parse(row.tags ?? "[]");
        if (Array.isArray(tags) && (
          tags.includes("status:deprecated") || tags.includes("auto-pattern")
        )) {
          activeByParent.set(row.id, new Set());
          continue;
        }
        const ids = JSON.parse(row.vector_ids ?? "[]");
        activeByParent.set(
          row.id,
          new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [])
        );
      } catch {
        activeByParent.set(row.id, new Set());
      }
    }
  }

  return matches.filter((match) => {
    const parentId = ((match.metadata as any)?.parentId ?? match.id) as string;
    return activeByParent.get(parentId)?.has(match.id) === true;
  });
}

interface ActiveVectorQueryResult {
  matches: VectorizeMatch[];
  degraded: boolean;
  degradedReason?: "vector_metadata_filter_unavailable" | "vector_source_index_missing";
}

async function queryActiveVectors(
  env: Env,
  vector: number[],
  fingerprint: string,
  topK: number,
  queryText?: string
): Promise<ActiveVectorQueryResult> {
  const queryOptions = {
    topK,
    returnMetadata: "all" as const,
    filter: {
      embedding_fingerprint: fingerprint,
      source: { $ne: CLAIM_VECTOR_SOURCE },
    },
  };
  try {
    const result = env.SELFHOST === "1"
      ? await (env.VECTORIZE as any).query(vector, { ...queryOptions, queryText })
      : await env.VECTORIZE.query(vector, queryOptions);
    return {
      matches: result.matches as VectorizeMatch[],
      degraded: false,
    };
  } catch (error) {
    if (isVectorSourceMetadataIndexError(error)) {
      console.error("Vectorize source metadata index is unavailable; using lexical recall:", error);
      return {
        matches: [],
        degraded: true,
        degradedReason: "vector_source_index_missing",
      };
    }
    console.error("Active vector metadata filtering failed; using lexical recall:", error);
    return {
      matches: [],
      degraded: true,
      degradedReason: "vector_metadata_filter_unavailable",
    };
  }
}

// Semantic similarity, contradiction detection, and smart merge in one embed +
// Vectorize query. High similarity (≥0.85, including former "block" band) is
// always flagged — never hard-blocked — so ADD + relation can still run.
export async function checkDuplicateAndContradiction(content: string, env: Env): Promise<{
  duplicate: DuplicateResult;
  contradiction: ContradictionResult;
  mergeAction: MergeAction | null;
}> {
  const sample = getDuplicateCheckSample(content);
  const snapshot = await loadActiveEmbeddingSnapshot(env);
  const values = await embedWithProvider(snapshot.provider, sample, "query");
  const queried = await queryActiveVectors(env, values, snapshot.fingerprint, 50, sample);
  const matches = (await filterActiveVectorMatches(
    queried.matches as VectorizeMatch[],
    env
  )).slice(0, 5);

  // ── Similarity band: flag for relation planning; never block by score ───────
  // PR5 (stop-fact-loss): high vector similarity ADDs the new row and links via
  // typed relations, rather than hard-blocking (which silently drops new facts).
  let duplicate: DuplicateResult = { status: "unique" };
  if (matches.length) {
    const top = matches[0];
    const matchId = (top.metadata as any)?.parentId ?? top.id;
    if (top.score >= DUPLICATE_FLAG_THRESHOLD) {
      // Includes former hard-block band (≥0.95): still ADD, link as similar/etc.
      duplicate = { status: "flagged", matchId, score: top.score };
    }
  }

  let contradiction: ContradictionResult = { detected: false };
  let mergeAction: MergeAction | null = null;

  {
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
        const candidateRefs = rows.map((row, index) => ({
          ref: String(index + 1),
          id: row.id,
          content: row.content,
        }));
        const resolveCandidateId = (raw: unknown): string | null => {
          if (raw == null) return null;
          const value = String(raw).trim().replace(/^\[(\d+)\]$/, "$1");
          const byRef = candidateRefs.find(candidate => candidate.ref === value);
          if (byRef) return byRef.id;
          // Backward compatibility: older tests/models may still return a real ID.
          const byId = candidateRefs.find(candidate => candidate.id === value);
          return byId?.id ?? null;
        };
        const existingList = candidateRefs
          .map((candidate) => `[${candidate.ref}]\n${candidate.content}`)
          .join("\n\n");

        if (duplicate.status === "flagged") {
          // ── Combined prompt: contradiction + merge (flagged band, including ≥0.95) ──
          // Replaces the contradiction-only prompt — same 1 LLM call, richer result.
          const prompt = `You are deciding what to do with a new memory that is very similar to existing memories.

New memory: "${content}"

Similar existing memories:
${existingList}

Choose exactly one action. Prioritise in this order:
1. "contradiction" — new memory DIRECTLY CONFLICTS with an existing one (opposite location, reversed decision, changed fact). Include conflicting_id and reason.
2. "replace" — new memory clearly supersedes an existing one (updated version of the same fact, original is now stale). Include target_id.
3. "merge" — the new memory is complementary or continues an existing one. Include target_id. Do not rewrite either memory.
4. "keep_both" — memories are different enough to coexist, or you are uncertain. This is the safe default.

Use only the bracketed candidate number, not any database ID, for conflicting_id or target_id.
Respond with JSON only. No text outside the JSON.
{"action":"keep_both"} OR {"action":"contradiction","conflicting_id":"<number>","reason":"<10 words max>"} OR {"action":"replace","target_id":"<number>"} OR {"action":"merge","target_id":"<number>"}`;

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
                const validId = resolveCandidateId(parsed.conflicting_id);
                if (validId) contradiction = { detected: true, conflicting_id: validId, reason: parsed.reason };
                // mergeAction stays null — contradiction path handles cleanup
              } else if (action === "replace" && parsed.target_id) {
                const validId = resolveCandidateId(parsed.target_id);
                mergeAction = validId ? { action: "replace", target_id: validId } : { action: "keep_both" };
              } else if (action === "merge" && parsed.target_id) {
                const validId = resolveCandidateId(parsed.target_id);
                mergeAction = validId
                  ? { action: "merge", target_id: validId }
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

Use only the bracketed candidate number, not any database ID, for conflicting_id.
Respond with JSON only. No text outside the JSON object.
{"contradicts": false} OR {"contradicts": true, "conflicting_id": "<number>", "reason": "<10 words max>"}`;

          try {
            const text = await (await createLLM(env)).chat(
              [{ role: "user", content: prompt }],
              { max_tokens: CONTRADICTION_MAX_TOKENS }
            );
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.contradicts && parsed.conflicting_id) {
                const validId = resolveCandidateId(parsed.conflicting_id);
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
  const DAY = 24 * 60 * 60 * 1000;
  if (tags.includes("task")) return 7 * DAY;  // 7 days
  // Procedures/how-tos are durable knowledge — decay much slower than default episodic notes.
  if (tags.includes("kind:procedural") || tags.includes("procedural")) return 365 * DAY;
  if (tags.includes("context")) return 180 * DAY; // 6 months
  if (tags.includes("work")) return 90 * DAY; // 3 months
  return 30 * DAY; // 30 days default
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
  contradictionLosses: Map<string, number> = new Map(),
  confidenceScores: Map<string, number> = new Map(),
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
      const isShortAppend = meta?.isUpdate === true &&
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

      // Mild confidence tilt: low-confidence facts stay visible but rank slightly lower.
      // Missing confidence (unclassified) → neutral 1.0.
      const conf = confidenceScores.get(parentId);
      const confidenceMultiplier =
        conf == null || !(conf > 0)
          ? 1.0
          : 0.9 + Math.min(1, Math.max(0, conf)) * 0.1;
      const parentVersionMultiplier = meta?.parent_version_state === "active_degraded" ? 0.98 : 1.0;

      return {
        ...match,
        score: match.score
          * combinedMultiplier
          * appendPenalty
          * rolledUpPenalty
          * importanceMultiplier
          * tagBoost
          * confidenceMultiplier
          * parentVersionMultiplier,
      };
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
  if (["episodic", "episodic event", "event", "decision", "milestone", "occurrence"].includes(v)) return "episodic";
  if (["semantic", "fact", "preference", "knowledge", "belief"].includes(v)) return "semantic";
  if (["procedural", "procedure", "workflow", "how-to", "how to", "process"].includes(v)) return "procedural";
  return null;
}

// Parse the classifier's response. Tries strict JSON first, then falls back to
// tolerant per-field extraction so one malformed field (small models intermittently
// emit e.g. {"canonical":,}) doesn't discard the other valid fields.
export interface EntryClassification {
  importance: number;
  confidence: number;
  canonical: boolean;
  kind: MemoryKind;
}

const CLASSIFICATION_SAMPLE_MAX_CHARS = 6_000;
const CLASSIFICATION_SELFHOST_BATCH_LIMIT = 14;
const CLASSIFICATION_CLOUDFLARE_BATCH_LIMIT = 1;
const CLOUDFLARE_IMPORT_MAX_ROWS = 4;
const CLASSIFICATION_RETRY_BASE_MS = 60_000;

/** Convert a normalized rank score (0–1, top=1) into a human label — not a probability. */
export function formatRelevanceLabel(score: number): string {
  if (score >= 0.85) return "highly relevant";
  if (score >= 0.55) return "relevant";
  return "possibly relevant";
}

export function relevanceBand(score: number): "high" | "medium" | "low" {
  if (score >= 0.85) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

export function getClassificationSample(content: string): string {
  if (content.length <= CLASSIFICATION_SAMPLE_MAX_CHARS) return content;
  const head = content.slice(0, 2_500);
  const middleStart = Math.max(2_500, Math.floor(content.length / 2) - 500);
  const middle = content.slice(middleStart, middleStart + 1_000);
  const tail = content.slice(-2_500);
  return `${head}\n[...middle...]\n${middle}\n[...end...]\n${tail}`;
}

function normalizeConfidence(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) return null;
  return raw;
}

function parseClassification(text: string): EntryClassification {
  const obj = text.match(/\{[^{}]*\}/);
  if (obj) {
    try {
      const p = JSON.parse(obj[0]);
      const importance = Number.isInteger(p.importance) && p.importance >= 1 && p.importance <= 5
        ? p.importance
        : null;
      const confidence = normalizeConfidence(p.confidence);
      const kind = normalizeKind(p.kind);
      if (importance === null || confidence === null || typeof p.canonical !== "boolean" || kind === null) {
        throw new Error("invalid_response");
      }
      return {
        importance,
        confidence,
        canonical: p.canonical,
        kind,
      };
    } catch { /* fall through to tolerant extraction */ }
  }
  const imp = text.match(/"importance"\s*:\s*([1-5])(?=\s*[,}])/);
  const conf = text.match(/"confidence"\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?)(?=\s*[,}])/);
  const can = text.match(/"canonical"\s*:\s*(true|false)(?=\s*[,}])/i);
  const knd = text.match(/"kind"\s*:\s*"([^"]+)"/);
  const kind = knd ? normalizeKind(knd[1]) : null;
  const confidence = conf ? normalizeConfidence(Number(conf[1])) : null;
  if (!imp || confidence === null || !can || kind === null) throw new Error("invalid_response");
  return {
    importance: parseInt(imp[1], 10),
    confidence,
    canonical: can ? can[1].toLowerCase() === "true" : false,
    kind,
  };
}

export async function classifyEntry(content: string, env: Env): Promise<EntryClassification> {
  let text: string;
  try {
    text = await (await createLLM(env)).chat(
      [{
        role: "user",
        content:
          `Classify this memory. Respond with ONLY one JSON object and nothing else — no prose, no markdown, no code fences.\n` +
          `{"importance": <1-5>, "confidence": <0-1>, "canonical": <true|false>, "kind": "episodic"|"semantic"|"procedural"}\n` +
          `importance: 1=trivial, 3=useful context, 5=critical decision or goal.\n` +
          `confidence: how reliable and explicit this classification is; do not confuse it with importance.\n` +
          `canonical: true ONLY for a confirmed decision, durable fact, or stated permanent preference that should be authoritative (be conservative; false for anything tentative, one-off, or event-like).\n` +
          `kind: "episodic" for an event at a point in time; "semantic" for a stable fact or knowledge; "procedural" for a workflow, method, or how-to process.\n\n` +
          `Memory: ${getClassificationSample(content)}`,
      }],
      { max_tokens: CLASSIFY_MAX_TOKENS }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_response") throw error;
    throw new Error("provider_error");
  }
  return parseClassification(text);
}

// ─── Hashtag extraction ───────────────────────────────────────────────────────

export function extractHashtags(content: string): { cleanContent: string; hashtags: string[] } {
  const hashtagPattern = /(?<![\p{L}\p{N}_])#[\p{L}\p{N}_-]+/gu;
  const normalizeSafeTag = (tag: string): string | null => {
    const normalized = tag.toLowerCase();
    return isD1SafeTag(normalized) ? normalized : null;
  };
  const hashtags = (content.match(hashtagPattern) ?? [])
    .map(t => normalizeSafeTag(t.slice(1)))
    .filter((tag): tag is string => tag !== null);
  const cleanContent = content
    .replace(hashtagPattern, match => normalizeSafeTag(match.slice(1)) !== null ? '' : match)
    .replace(/\s+/g, ' ')
    .trim();
  return { cleanContent, hashtags };
}

function isD1SafeTag(tag: string): boolean {
  return new TextEncoder().encode(tag).byteLength <= D1_MAX_TAG_UTF8_BYTES;
}

// ─── Query tag inference ──────────────────────────────────────────────────────

export async function inferQueryTags(query: string, env: Env): Promise<string[]> {
  const { hashtags } = extractHashtags(query);
  if (hashtags.length) return hashtags;

  const { results: tagRows } = await env.DB.prepare(
    `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`
  ).all();
  const knownTags = (tagRows as { value: string }[]).map(r => r.value).filter(isD1SafeTag);

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
  vaultFilter?: string | null;
  strictEvidence?: boolean;
}): { sql: string; bindings: (string | number)[] } {
  const conds: string[] = [];
  const bindings: (string | number)[] = [];
  if (params.tag) {
    if (isD1SafeTag(params.tag)) {
      conds.push(`tags LIKE ?`);
      bindings.push(`%"${params.tag}"%`);
    } else {
      conds.push(`1 = 0`);
    }
  }
  if (params.after !== undefined) { conds.push(`created_at >= ?`); bindings.push(params.after); }
  if (params.before !== undefined) { conds.push(`created_at <= ?`); bindings.push(params.before); }
  if (params.vaultFilter) {
    conds.push(`EXISTS (SELECT 1 FROM sb_external_links l WHERE l.entry_id = entries.id AND l.provider = 'obsidian' AND l.object_type = 'memory' AND l.vault_id = ?)`);
    bindings.push(params.vaultFilter);
  }
  if (params.strictEvidence !== false) {
    conds.push(
      activeParentEntryPredicateAt(
        "entries.id",
        String(params.before ?? Date.now()),
        { requireEvidence: true }
      ).replace(/^AND\s+/, "")
    );
  }

  let sql = `SELECT id, content, tags, source, created_at, vector_ids,
                    recall_count, importance_score, classification_confidence,
                    classification_status, classified_at,
                    (SELECT kind FROM sb_memories
                     WHERE entry_id = entries.id
                       AND invalid_at IS NULL
                       AND expired_at IS NULL
                     ORDER BY created_at DESC
                     LIMIT 1) as atomic_kind,
                    (SELECT memory_class FROM sb_memories
                     WHERE entry_id = entries.id
                       AND invalid_at IS NULL
                       AND expired_at IS NULL
                     ORDER BY created_at DESC
                     LIMIT 1) as memory_class,
                    (SELECT COUNT(*) FROM sb_memory_sources
                     WHERE memory_id IN (
                       SELECT id FROM sb_memories
                       WHERE entry_id = entries.id
                         AND invalid_at IS NULL
                         AND expired_at IS NULL
                     )) as source_count,
                    (SELECT COUNT(DISTINCT entity_id) FROM sb_memory_entities
                     WHERE memory_id IN (
                       SELECT id FROM sb_memories
                       WHERE entry_id = entries.id
                         AND invalid_at IS NULL
                         AND expired_at IS NULL
                     )) as entity_count
             FROM entries`;
  if (conds.length) sql += ` WHERE ` + conds.join(` AND `);
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  bindings.push(params.n);

  return { sql, bindings };
}

const ACTIVITY_EXCLUDED_TAGS = new Set([
  "auto-pattern",
  "synthesized",
  "rolled-up",
  "status:deprecated",
]);

function parseStoredTags(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function listRecentActivity(
  plan: RecallRequestPlan,
  tag: string | undefined,
  env: Env,
  vaultFilter: string | null = null
): Promise<RecallMatch[]> {
  const fetchLimit = Math.min(plan.limit * 3, 100);
  const { sql, bindings } = buildEntryFilterQuery({
    n: fetchLimit,
    tag,
    after: plan.after,
    before: plan.before,
    vaultFilter,
    strictEvidence: true,
  });
  const { results } = await env.DB.prepare(sql).bind(...bindings).all();

  return (results as Record<string, unknown>[])
    .map((row) => ({ row, tags: parseStoredTags(row.tags) }))
    .filter(({ tags }) => !tags.some((item) => ACTIVITY_EXCLUDED_TAGS.has(item)))
    .slice(0, plan.limit)
    .map(({ row, tags }) => ({
      id: String(row.id),
      content: String(row.content ?? ""),
      score: 1,
      createdAt: Number(row.created_at),
      tags,
      source: String(row.source ?? ""),
      isUpdate: false,
    }));
}

interface PreparedEntryVectors {
  vectors: Array<{
    id: string;
    values: number[];
    metadata: Record<string, any>;
  }>;
  vectorIds: string[];
}

interface VectorizeQueueRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  content_hash?: string | null;
  pending_rebuild_id?: string | null;
}

interface PreparedEntryVectorBatchItem extends PreparedEntryVectors {
  row: VectorizeQueueRow;
  contentHash?: string;
  metadataHash?: string;
  pendingRevisionId?: string;
}

interface VectorizeBatchResult {
  processed: number;
  failed: number;
  skipped: number;
}

function createVectorGeneration(): string {
  return crypto.randomUUID();
}

/** Build all chunks and embeddings without changing D1 or Vectorize. */
async function prepareEntryVectors(
  env: Env,
  id: string,
  content: string,
  tags: string[],
  source: string,
  now: number,
  generation?: string,
  embeddingFingerprint?: string,
  embeddingRole: EmbeddingProfileRole = "active",
  pendingRevisionId?: string,
  embeddingProvider?: EmbeddingProvider
): Promise<PreparedEntryVectors> {
  const chunks = chunkText(content);
  const vectorBaseId = generation ? `g-${generation}` : id;
  const embeddings = embeddingProvider
    ? await embedManyWithProvider(embeddingProvider, chunks, "document")
    : await embedMany(chunks, env, "document", embeddingRole);

  const vectors = chunks.map((chunk, i) => {
    const metadata: Record<string, any> = {
      content: chunk,
      parentId: id,
      chunkIndex: i,
      totalChunks: chunks.length,
      tags,
      source,
      created_at: now,
    };
    if (embeddingFingerprint) metadata.embedding_fingerprint = embeddingFingerprint;
    if (pendingRevisionId) metadata.pending_revision_id = pendingRevisionId;

    tags.forEach(t => {
      metadata[`tag_${t}`] = true;
    });

    return {
      id: chunks.length === 1 ? vectorBaseId : `${vectorBaseId}-chunk-${i}`,
      values: embeddings[i],
      metadata,
    };
  });

  return { vectors, vectorIds: vectors.map((vector) => vector.id) };
}

async function insertPreparedVectors(
  env: Env,
  prepared: PreparedEntryVectors
): Promise<void> {
  await env.VECTORIZE.insert(prepared.vectors);
}

async function insertPreparedVectorBatch(
  env: Env,
  items: PreparedEntryVectorBatchItem[]
): Promise<void> {
  const vectors = items.flatMap((item) => item.vectors);
  for (let i = 0; i < vectors.length; i += VECTORIZE_INSERT_BATCH_SIZE) {
    await env.VECTORIZE.insert(vectors.slice(i, i + VECTORIZE_INSERT_BATCH_SIZE));
  }
}

async function cleanupPreparedVectors(
  env: Env,
  vectorIds: string[],
  context: string
): Promise<void> {
  if (!vectorIds.length) return;
  const result = await deleteVectorsOrQueue(
    env,
    vectorIds,
    `compensation:${context}`
  );
  if (result.queued > 0 || result.blocked > 0) {
    console.warn(
      `${context}: queued ${result.queued} vectors and blocked ${result.blocked} referenced vectors for durable cleanup`
    );
  }
}

function parseVectorIds(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

async function hasActiveEntryVectors(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM entries
     WHERE vector_ids IS NOT NULL
       AND vector_ids != '[]'
       AND tags NOT LIKE '%"status:deprecated"%'`
  ).first() as Record<string, any> | null;
  return Number(row?.count ?? 0) > 0;
}

async function prepareEntryVectorBatch(
  env: Env,
  rows: VectorizeQueueRow[],
  options: {
    embeddingFingerprint?: string;
    embeddingRole?: EmbeddingProfileRole;
    embeddingProvider?: EmbeddingProvider;
    includeContentHash?: boolean;
    includePendingRevisionId?: boolean;
  } = {}
): Promise<PreparedEntryVectorBatchItem[]> {
  if (!rows.length) return [];

  const plans = await Promise.all(rows.map(async (row) => {
    const tags = JSON.parse(row.tags) as string[];
    const chunks = chunkText(row.content);
    const generation = createVectorGeneration();
    const vectorBaseId = `g-${generation}`;
    const contentHash = options.includeContentHash
      ? row.content_hash ?? await contentFingerprint(row.content)
      : undefined;
    const metadataHash = options.includeContentHash
      ? await entryMetadataFingerprint({ source: row.source, tags })
      : undefined;
    const pendingRevisionId = options.includePendingRevisionId
      ? crypto.randomUUID()
      : undefined;
    return { row, tags, chunks, vectorBaseId, contentHash, metadataHash, pendingRevisionId };
  }));

  const texts = plans.flatMap((plan) => plan.chunks);
  const embeddings = options.embeddingProvider
    ? await embedManyWithProvider(options.embeddingProvider, texts, "document")
    : await embedMany(
        texts,
        env,
        "document",
        options.embeddingRole ?? "active"
      );
  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embedding batch size mismatch: expected ${texts.length}, got ${embeddings.length}`
    );
  }

  let offset = 0;
  return plans.map((plan) => {
    const vectors = plan.chunks.map((chunk, i) => {
      const metadata: Record<string, any> = {
        content: chunk,
        parentId: plan.row.id,
        chunkIndex: i,
        totalChunks: plan.chunks.length,
        tags: plan.tags,
        source: plan.row.source,
        created_at: plan.row.created_at,
      };
      if (options.embeddingFingerprint) {
        metadata.embedding_fingerprint = options.embeddingFingerprint;
      }
      if (plan.pendingRevisionId) {
        metadata.pending_revision_id = plan.pendingRevisionId;
      }
      plan.tags.forEach((tag) => {
        metadata[`tag_${tag}`] = true;
      });
      return {
        id: plan.chunks.length === 1 ? plan.vectorBaseId : `${plan.vectorBaseId}-chunk-${i}`,
        values: embeddings[offset + i],
        metadata,
      };
    });
    offset += plan.chunks.length;
    return {
      row: plan.row,
      contentHash: plan.contentHash,
      metadataHash: plan.metadataHash,
      pendingRevisionId: plan.pendingRevisionId,
      vectors,
      vectorIds: vectors.map((vector) => vector.id),
    };
  });
}

async function storePendingEntryVectors(
  env: Env,
  row: { id: string; content: string; tags: string; source: string; created_at: number; content_hash?: string | null },
  pendingFingerprint: string,
  rebuildId: string
): Promise<string[]> {
  const hash = row.content_hash ?? await contentFingerprint(row.content);
  const tags = JSON.parse(row.tags) as string[];
  const metadataHash = await entryMetadataFingerprint({ source: row.source, tags });
  const pendingRevisionId = crypto.randomUUID();
  const prepared = await prepareEntryVectors(
    env,
    row.id,
    row.content,
    tags,
    row.source,
    row.created_at,
    createVectorGeneration(),
    pendingFingerprint,
    "pending",
    pendingRevisionId
  );

  try {
    await insertPreparedVectors(env, prepared);
  } catch (error) {
    await cleanupPreparedVectors(env, prepared.vectorIds, "Pending vector insert");
    throw error;
  }

  try {
    const result = await env.DB.prepare(
      `UPDATE entries
       SET pending_vector_ids = ?,
           pending_embedding_fingerprint = ?,
           pending_content_hash = ?,
           pending_revision_id = ?,
           pending_metadata_hash = ?,
           content_hash = COALESCE(content_hash, ?),
           metadata_hash = ?
       WHERE id = ?
         AND pending_vector_ids = ?
         AND pending_embedding_fingerprint = ?
         AND pending_rebuild_id = ?
         AND content = ?
         AND tags = ?
         AND source = ?
         AND tags NOT LIKE '%"status:deprecated"%'`
    ).bind(
      JSON.stringify(prepared.vectorIds),
      pendingFingerprint,
      hash,
      pendingRevisionId,
      metadataHash,
      hash,
      metadataHash,
      row.id,
      "[]",
      pendingFingerprint,
      rebuildId,
      row.content,
      row.tags,
      row.source
    ).run();
    if (result.meta?.changes === 0) {
      await cleanupPreparedVectors(env, prepared.vectorIds, "Stale pending vector write");
      return [];
    }
  } catch (error) {
    await cleanupPreparedVectors(env, prepared.vectorIds, "Pending vector write");
    throw error;
  }

  return prepared.vectorIds;
}

async function storePendingEntryVectorBatch(
  env: Env,
  rows: VectorizeQueueRow[],
  pendingFingerprint: string,
  rebuildId: string
): Promise<VectorizeBatchResult> {
  const prepared = await prepareEntryVectorBatch(env, rows, {
    embeddingFingerprint: pendingFingerprint,
    embeddingRole: "pending",
    includeContentHash: true,
    includePendingRevisionId: true,
  });
  const allVectorIds = prepared.flatMap((item) => item.vectorIds);
  try {
    await insertPreparedVectorBatch(env, prepared);
  } catch (error) {
    await cleanupPreparedVectors(env, allVectorIds, "Pending vector batch insert");
    throw error;
  }

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of prepared) {
    const hash = item.contentHash ?? await contentFingerprint(item.row.content);
    const metadataHash = item.metadataHash ?? await entryMetadataFingerprint({
      source: item.row.source,
      tags: JSON.parse(item.row.tags) as string[],
    });
    try {
      const result = await env.DB.prepare(
        `UPDATE entries
         SET pending_vector_ids = ?,
             pending_embedding_fingerprint = ?,
             pending_content_hash = ?,
             pending_revision_id = ?,
             pending_metadata_hash = ?,
             content_hash = COALESCE(content_hash, ?),
             metadata_hash = ?
         WHERE id = ?
           AND pending_vector_ids = ?
           AND pending_embedding_fingerprint = ?
           AND pending_rebuild_id = ?
           AND content = ?
           AND tags = ?
           AND source = ?
           AND tags NOT LIKE '%"status:deprecated"%'`
      ).bind(
        JSON.stringify(item.vectorIds),
        pendingFingerprint,
        hash,
        item.pendingRevisionId ?? crypto.randomUUID(),
        metadataHash,
        hash,
        metadataHash,
        item.row.id,
        "[]",
        pendingFingerprint,
        rebuildId,
        item.row.content,
        item.row.tags,
        item.row.source
      ).run();
      if (result.meta?.changes === 0) {
        await cleanupPreparedVectors(env, item.vectorIds, "Stale pending vector batch write");
        skipped++;
      } else {
        processed++;
      }
    } catch (error) {
      await cleanupPreparedVectors(env, item.vectorIds, "Pending vector batch write");
      console.error("Pending vector batch write failed for entry", item.row.id, error);
      failed++;
    }
  }
  return { processed, failed, skipped };
}

async function countPendingActivationConflicts(
  env: Env,
  pendingFingerprint: string,
  rebuildId: string
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM entries
     WHERE pending_embedding_fingerprint = ?
       AND pending_rebuild_id = ?
       AND pending_vector_ids IS NOT NULL
       AND pending_vector_ids != '[]'
       AND (
         pending_content_hash IS NULL OR
         content_hash IS NULL OR
         pending_revision_id IS NULL OR
         metadata_hash IS NULL OR
         pending_metadata_hash IS NULL OR
         pending_content_hash != content_hash OR
         pending_metadata_hash != metadata_hash
       )`
  ).bind(pendingFingerprint, rebuildId).first() as Record<string, any> | null;
  return Number(row?.count ?? 0);
}

interface PendingActivationIntegrity {
  activatable: number;
  blocked: number;
}

interface PendingActivationRow {
  id: string;
  vector_ids: string;
  pending_vector_ids: string;
}

interface VectorRebuildRow {
  id: string;
  state: string;
  active_fingerprint: string;
  pending_fingerprint: string;
  expected_entries: number;
  processed_entries: number;
  failed_entries: number;
  conflict_entries: number;
}

interface OpenVectorRebuildContext {
  id: string;
  pendingFingerprint: string;
  state: "queued" | "building" | "ready";
}

interface VectorCleanupResult {
  deleted: number;
  queued: number;
  blocked: number;
}

interface CancelRebuildResult {
  cancelled: boolean;
  pendingFingerprint?: string;
  cleanupBatchesPrepared: number;
  cleanupVectorsPrepared: number;
  entriesCleared: number;
}

function prepareVectorCleanupQueueInsert(
  env: Env,
  input: {
    id: string;
    vectorId: string;
    reason: string;
    state: "ready" | "blocked" | "failed";
    rebuildId?: string | null;
    lastError?: string | null;
    now: number;
  }
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO sb_vector_cleanup_queue (
       id, vector_id, reason, state, attempts, next_attempt_at, rebuild_id, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)
     ON CONFLICT(vector_id) DO UPDATE SET
       reason = excluded.reason,
       state = excluded.state,
       rebuild_id = COALESCE(excluded.rebuild_id, sb_vector_cleanup_queue.rebuild_id),
       last_error = COALESCE(excluded.last_error, sb_vector_cleanup_queue.last_error),
       updated_at = excluded.updated_at`
  ).bind(
    input.id,
    input.vectorId,
    input.reason,
    input.state,
    input.rebuildId ?? null,
    input.lastError ?? null,
    input.now,
    input.now
  );
}

function preparePendingGenerationInvalidation(
  env: Env,
  input: {
    pendingVectorIds?: string | null;
    pendingRebuildId?: string | null;
    reason: string;
    now: number;
  }
): D1PreparedStatement[] {
  const pendingIds = parseVectorIds(input.pendingVectorIds);
  return pendingIds.map((vectorId) =>
    prepareVectorCleanupQueueInsert(env, {
      id: crypto.randomUUID(),
      vectorId,
      reason: input.reason,
      state: "ready",
      rebuildId: input.pendingRebuildId ?? null,
      now: input.now,
    })
  );
}

function pendingGenerationResetAssignments(): string {
  return `
    pending_vector_ids = CASE
      WHEN pending_rebuild_id IS NOT NULL THEN '[]'
      ELSE NULL
    END,
    pending_embedding_fingerprint = CASE
      WHEN pending_rebuild_id IS NOT NULL THEN pending_embedding_fingerprint
      ELSE NULL
    END,
    pending_content_hash = NULL,
    pending_revision_id = NULL,
    pending_metadata_hash = NULL
  `;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function cleanupRetryDelayMs(attempts: number): number {
  return Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.max(0, attempts));
}

function referencedVectorRetryDelayMs(attempts: number): number {
  return Math.min(24 * 60 * 60 * 1000, 5 * 60_000 * 2 ** Math.max(0, Math.min(attempts, 8)));
}

async function loadCurrentVectorRebuild(
  env: Env,
  pendingFingerprint?: string | null
): Promise<VectorRebuildRow | null> {
  const row = pendingFingerprint
    ? await env.DB.prepare(
        `SELECT id, state, active_fingerprint, pending_fingerprint,
                expected_entries, processed_entries, failed_entries, conflict_entries
         FROM sb_vector_rebuilds
         WHERE slot = 'current'
           AND pending_fingerprint = ?
           AND state NOT IN ('active', 'cancelled', 'failed')
         LIMIT 1`
      ).bind(pendingFingerprint).first()
    : await env.DB.prepare(
        `SELECT id, state, active_fingerprint, pending_fingerprint,
                expected_entries, processed_entries, failed_entries, conflict_entries
         FROM sb_vector_rebuilds
         WHERE slot = 'current'
           AND state NOT IN ('active', 'cancelled', 'failed')
         LIMIT 1`
      ).first();
  return row ? {
    id: String((row as Record<string, unknown>).id),
    state: String((row as Record<string, unknown>).state),
    active_fingerprint: String((row as Record<string, unknown>).active_fingerprint),
    pending_fingerprint: String((row as Record<string, unknown>).pending_fingerprint),
    expected_entries: Number((row as Record<string, unknown>).expected_entries ?? 0),
    processed_entries: Number((row as Record<string, unknown>).processed_entries ?? 0),
    failed_entries: Number((row as Record<string, unknown>).failed_entries ?? 0),
    conflict_entries: Number((row as Record<string, unknown>).conflict_entries ?? 0),
  } : null;
}

async function loadOpenVectorRebuild(env: Env): Promise<OpenVectorRebuildContext | null> {
  const row = await env.DB.prepare(
    `SELECT id,
            pending_fingerprint AS pendingFingerprint,
            state
     FROM sb_vector_rebuilds
     WHERE slot = 'current'
       AND state IN ('queued', 'building', 'ready')
     LIMIT 1`
  ).first<Record<string, unknown>>();
  if (!row?.id || !row.pendingFingerprint) return null;
  const state = String(row.state);
  if (state !== "queued" && state !== "building" && state !== "ready") return null;
  return {
    id: String(row.id),
    pendingFingerprint: String(row.pendingFingerprint),
    state,
  };
}

async function attachEntryToOpenVectorRebuild(
  env: Env,
  entryId: string,
  rebuild?: OpenVectorRebuildContext | null
): Promise<boolean> {
  const open = rebuild ?? await loadOpenVectorRebuild(env);
  if (!open) return false;
  const now = Date.now();
  const attach = await env.DB.prepare(
    `UPDATE entries
     SET pending_vector_ids = '[]',
         pending_embedding_fingerprint = ?,
         pending_content_hash = NULL,
         pending_revision_id = NULL,
         pending_metadata_hash = NULL,
         pending_rebuild_id = ?
     WHERE id = ?
       AND tags NOT LIKE '%"status:deprecated"%'
       AND (pending_rebuild_id IS NULL OR pending_rebuild_id != ?)
       AND EXISTS (
         SELECT 1
         FROM sb_vector_rebuilds
         WHERE id = ?
           AND state IN ('queued', 'building', 'ready')
       )`
  ).bind(
    open.pendingFingerprint,
    open.id,
    entryId,
    open.id,
    open.id
  ).run();
  if (Number(attach.meta?.changes ?? 0) !== 1) return false;
  await env.DB.prepare(
    `UPDATE sb_vector_rebuilds
     SET expected_entries = expected_entries + 1,
         updated_at = ?
     WHERE id = ?
       AND state IN ('queued', 'building', 'ready')`
  ).bind(now, open.id).run();
  return true;
}

async function reconcileOpenVectorRebuildEntries(
  env: Env,
  rebuild: OpenVectorRebuildContext
): Promise<number> {
  const now = Date.now();
  const { results: displacedRows } = await env.DB.prepare(
    `SELECT id, pending_vector_ids, pending_rebuild_id
     FROM entries
     WHERE tags NOT LIKE '%"status:deprecated"%'
       AND pending_vector_ids IS NOT NULL
       AND pending_vector_ids != '[]'
       AND (
         pending_rebuild_id IS NULL
         OR pending_rebuild_id != ?
       )`
  ).bind(rebuild.id).all<{
    id: string;
    pending_vector_ids: string | null;
    pending_rebuild_id: string | null;
  }>();
  const cleanupStatements = (displacedRows ?? []).flatMap((row) =>
    preparePendingGenerationInvalidation(env, {
      pendingVectorIds: row.pending_vector_ids,
      pendingRebuildId: row.pending_rebuild_id,
      reason: "rebuild_reconcile_displaced_pending",
      now,
    })
  );
  const updateStatement = env.DB.prepare(
    `UPDATE entries
      SET pending_vector_ids = '[]',
          pending_embedding_fingerprint = ?,
          pending_content_hash = NULL,
          pending_revision_id = NULL,
          pending_metadata_hash = NULL,
          pending_rebuild_id = ?
      WHERE tags NOT LIKE '%"status:deprecated"%'
        AND (
          pending_rebuild_id IS NULL
          OR pending_rebuild_id != ?
        )
        AND EXISTS (
          SELECT 1
          FROM sb_vector_rebuilds
          WHERE id = ?
            AND state IN ('queued', 'building', 'ready')
        )`
  ).bind(
    rebuild.pendingFingerprint,
    rebuild.id,
    rebuild.id,
    rebuild.id
  );
  const batchResults = cleanupStatements.length
    ? await env.DB.batch([...cleanupStatements, updateStatement])
    : [await updateStatement.run()];
  const result = batchResults[batchResults.length - 1];
  await env.DB.prepare(
    `UPDATE sb_vector_rebuilds
     SET expected_entries = (
           SELECT COUNT(*)
           FROM entries
           WHERE tags NOT LIKE '%"status:deprecated"%'
         ),
         updated_at = ?
     WHERE id = ?
       AND state IN ('queued', 'building', 'ready')`
  ).bind(now, rebuild.id).run();
  return Number(result.meta?.changes ?? 0);
}

async function repairStalePendingGenerations(
  env: Env,
  rebuild: OpenVectorRebuildContext,
  limit = 50
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, pending_vector_ids, pending_rebuild_id,
            pending_revision_id, pending_content_hash, pending_metadata_hash
     FROM entries
     WHERE pending_rebuild_id = ?
       AND pending_vector_ids IS NOT NULL
       AND pending_vector_ids != '[]'
       AND (
         pending_content_hash IS NULL
         OR content_hash IS NULL
         OR pending_revision_id IS NULL
         OR pending_metadata_hash IS NULL
         OR metadata_hash IS NULL
         OR pending_content_hash != content_hash
         OR pending_metadata_hash != metadata_hash
       )
       AND tags NOT LIKE '%"status:deprecated"%'
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(rebuild.id, Math.max(1, Math.min(limit, 200))).all<{
    id: string;
    pending_vector_ids: string | null;
    pending_rebuild_id: string | null;
    pending_revision_id: string | null;
    pending_content_hash: string | null;
    pending_metadata_hash: string | null;
  }>();
  const rows = results ?? [];
  if (!rows.length) return 0;

  const now = Date.now();
  const cleanupStatements = rows.flatMap((row) =>
    preparePendingGenerationInvalidation(env, {
      pendingVectorIds: row.pending_vector_ids,
      pendingRebuildId: row.pending_rebuild_id,
      reason: "pending_generation_stale",
      now,
    })
  );
  const resetStatements = rows.map((row) =>
    env.DB.prepare(
      `UPDATE entries
       SET pending_vector_ids = '[]',
           pending_embedding_fingerprint = ?,
           pending_content_hash = NULL,
           pending_revision_id = NULL,
           pending_metadata_hash = NULL,
           pending_rebuild_id = ?
       WHERE id = ?
         AND pending_rebuild_id = ?
         AND pending_vector_ids = ?
         AND pending_revision_id IS ?
         AND pending_content_hash IS ?
         AND pending_metadata_hash IS ?
         AND (
           pending_content_hash IS NULL
           OR content_hash IS NULL
           OR pending_revision_id IS NULL
           OR pending_metadata_hash IS NULL
           OR metadata_hash IS NULL
           OR pending_content_hash != content_hash
           OR pending_metadata_hash != metadata_hash
         )`
    ).bind(
      rebuild.pendingFingerprint,
      rebuild.id,
      row.id,
      rebuild.id,
      row.pending_vector_ids,
      row.pending_revision_id,
      row.pending_content_hash,
      row.pending_metadata_hash
    )
  );
  const batchResults = await env.DB.batch([...cleanupStatements, ...resetStatements]);
  return batchResults
    .slice(cleanupStatements.length)
    .reduce((total, result) => total + Number(result.meta?.changes ?? 0), 0);
}

async function countStalePendingGenerations(
  env: Env,
  rebuild: OpenVectorRebuildContext
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM entries
     WHERE pending_rebuild_id = ?
       AND pending_vector_ids IS NOT NULL
       AND pending_vector_ids != '[]'
       AND (
         pending_content_hash IS NULL
         OR content_hash IS NULL
         OR pending_revision_id IS NULL
         OR pending_metadata_hash IS NULL
         OR metadata_hash IS NULL
         OR pending_content_hash != content_hash
         OR pending_metadata_hash != metadata_hash
       )
       AND tags NOT LIKE '%"status:deprecated"%'`
  ).bind(rebuild.id).first() as Record<string, any> | null;
  return Number(row?.count ?? 0);
}

async function countUnjoinedVectorRebuildEntries(
  env: Env,
  rebuild: OpenVectorRebuildContext
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count
     FROM entries
     WHERE tags NOT LIKE '%"status:deprecated"%'
       AND (
         pending_rebuild_id IS NULL
         OR pending_rebuild_id != ?
       )`
  ).bind(rebuild.id).first() as Record<string, any> | null;
  return Number(row?.count ?? 0);
}

async function inspectPendingActivationIntegrity(
  env: Env,
  pendingFingerprint: string,
  rebuildId: string
): Promise<PendingActivationIntegrity> {
  const [activatableRow, blocked] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM entries
       WHERE pending_embedding_fingerprint = ?
         AND pending_rebuild_id = ?
         AND pending_vector_ids IS NOT NULL
         AND pending_vector_ids != '[]'
         AND pending_content_hash IS NOT NULL
         AND pending_revision_id IS NOT NULL
         AND pending_metadata_hash IS NOT NULL
         AND metadata_hash IS NOT NULL
         AND content_hash = pending_content_hash
         AND metadata_hash = pending_metadata_hash`
    ).bind(pendingFingerprint, rebuildId).first() as Promise<Record<string, any> | null>,
    countPendingActivationConflicts(env, pendingFingerprint, rebuildId),
  ]);
  return {
    activatable: Number(activatableRow?.count ?? 0),
    blocked,
  };
}

async function listPendingActivationRows(
  env: Env,
  pendingFingerprint: string,
  rebuildId: string
): Promise<PendingActivationRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, vector_ids, pending_vector_ids
     FROM entries
     WHERE pending_embedding_fingerprint = ?
       AND pending_rebuild_id = ?
       AND pending_vector_ids IS NOT NULL
       AND pending_vector_ids != '[]'
       AND pending_content_hash IS NOT NULL
       AND pending_revision_id IS NOT NULL
       AND pending_metadata_hash IS NOT NULL
       AND metadata_hash IS NOT NULL
       AND content_hash = pending_content_hash
       AND metadata_hash = pending_metadata_hash`
  ).bind(pendingFingerprint, rebuildId).all<PendingActivationRow>();
  return (results ?? []) as PendingActivationRow[];
}

function staleVectorIdsAfterActivation(rows: PendingActivationRow[]): string[] {
  const stale = new Set<string>();
  const next = new Set<string>();
  for (const row of rows) {
    for (const id of parseVectorIds(row.pending_vector_ids)) next.add(id);
  }
  for (const row of rows) {
    for (const id of parseVectorIds(row.vector_ids)) {
      if (!next.has(id)) stale.add(id);
    }
  }
  return [...stale];
}

async function enqueueVectorCleanup(
  env: Env,
  vectorIds: string[],
  reason: string,
  error?: unknown,
  options: { state?: "ready" | "blocked" | "failed"; rebuildId?: string | null } = {}
): Promise<number> {
  const ids = [...new Set(vectorIds)].filter(Boolean);
  if (!ids.length) return 0;
  const now = Date.now();
  const state = options.state ?? "ready";
  const lastError = error == null
    ? null
    : error instanceof Error
      ? error.message.slice(0, 500)
      : String(error).slice(0, 500);
  let queued = 0;
  for (const id of ids) {
    const result = await prepareVectorCleanupQueueInsert(env, {
      id: crypto.randomUUID(),
      vectorId: id,
      reason,
      state,
      rebuildId: options.rebuildId ?? null,
      lastError,
      now,
    }).run();
    queued += Number(result.meta?.changes ?? 0) > 0 ? 1 : 0;
  }
  return queued;
}

async function deleteVectorsOrQueue(
  env: Env,
  vectorIds: string[],
  reason: string
): Promise<VectorCleanupResult> {
  const ids = [...new Set(vectorIds)].filter(Boolean);
  if (!ids.length) return { deleted: 0, queued: 0, blocked: 0 };
  const referenced: string[] = [];
  const deletable: string[] = [];
  for (const id of ids) {
    if (await vectorStillReferenced(env, id)) referenced.push(id);
    else deletable.push(id);
  }
  const blocked = await enqueueVectorCleanup(
    env,
    referenced,
    reason,
    "vector_still_referenced",
    { state: "blocked" }
  );
  let deleted = 0;
  for (let i = 0; i < deletable.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = deletable.slice(i, i + D1_MAX_BOUND_PARAMS);
    try {
      await env.VECTORIZE.deleteByIds(batch);
      deleted += batch.length;
    } catch (error) {
      const queued = await enqueueVectorCleanup(env, deletable.slice(i), reason, error);
      return { deleted, queued, blocked };
    }
  }
  return { deleted, queued: 0, blocked };
}

async function vectorStillReferenced(env: Env, vectorId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 as referenced
     FROM entries e, json_each(CASE WHEN json_valid(e.vector_ids) THEN e.vector_ids ELSE '[]' END) active
     WHERE active.value = ?
     UNION ALL
     SELECT 1 as referenced
     FROM entries e, json_each(
       CASE
         WHEN json_valid(COALESCE(e.pending_vector_ids, '[]')) THEN COALESCE(e.pending_vector_ids, '[]')
         ELSE '[]'
       END
     ) pending
     WHERE pending.value = ?
     LIMIT 1`
  ).bind(vectorId, vectorId).first() as Record<string, any> | null;
  return Boolean(row?.referenced);
}

async function prepareVectorCleanupBatches(
  env: Env,
  rebuildId: string,
  vectorIds: string[],
  state: "prepared" | "ready" = "prepared"
): Promise<{ batches: number; vectors: number }> {
  const ids = [...new Set(vectorIds)].filter(Boolean);
  if (!ids.length) return { batches: 0, vectors: 0 };
  const now = Date.now();
  let batches = 0;
  for (const chunk of chunkArray(ids, VECTOR_CLEANUP_BATCH_SIZE)) {
    const normalized = [...new Set(chunk)].sort();
    const hash = await contentFingerprint(`${rebuildId}\n${normalized.join("\n")}`);
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO sb_vector_cleanup_batches (
         id, rebuild_id, vector_ids_json, vector_ids_hash, state, attempts, next_attempt_at, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`
    ).bind(
      `cleanup-${rebuildId}-${hash}`,
      rebuildId,
      JSON.stringify(normalized),
      hash,
      state,
      now,
      now
    ).run();
    batches += Number(result.meta?.changes ?? 0);
  }
  return { batches, vectors: ids.length };
}

async function processVectorCleanupBatches(
  env: Env,
  limit = 100
): Promise<{ attempted: number; deleted: number; failed: number; blocked: number }> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, vector_ids_json, attempts
     FROM sb_vector_cleanup_batches
     WHERE state = 'ready'
       AND COALESCE(next_attempt_at, 0) <= ?
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(now, Math.max(1, Math.min(limit, 500))).all<{
    id: string;
    vector_ids_json: string;
    attempts: number;
  }>();
  const rows = results ?? [];
  if (!rows.length) return { attempted: 0, deleted: 0, failed: 0, blocked: 0 };

  let attempted = 0;
  let deleted = 0;
  let failed = 0;
  let blocked = 0;
  for (const row of rows) {
    const ids = parseVectorIds(row.vector_ids_json);
    attempted += ids.length;
    const referenced: string[] = [];
    const deletable: string[] = [];
    for (const id of ids) {
      if (await vectorStillReferenced(env, id)) referenced.push(id);
      else deletable.push(id);
    }
    try {
      for (const chunk of chunkArray(deletable, D1_MAX_BOUND_PARAMS)) {
        await env.VECTORIZE.deleteByIds(chunk);
      }
      deleted += deletable.length;
      if (referenced.length) {
        blocked += referenced.length;
        const attempts = Number(row.attempts ?? 0);
        const updatedAt = Date.now();
        await env.DB.prepare(
          `UPDATE sb_vector_cleanup_batches
           SET vector_ids_json = ?,
               attempts = attempts + 1,
               state = 'ready',
               next_attempt_at = ?,
               last_error = ?,
               updated_at = ?
           WHERE id = ?`
        ).bind(
          JSON.stringify(referenced),
          updatedAt + referencedVectorRetryDelayMs(attempts),
          `vector_still_referenced:${referenced.length}`,
          updatedAt,
          row.id
        ).run();
      } else {
        await env.DB.prepare(
          `UPDATE sb_vector_cleanup_batches
           SET state = 'completed',
               updated_at = ?
           WHERE id = ?`
        ).bind(Date.now(), row.id).run();
      }
    } catch (error) {
      failed += deletable.length;
      const attempts = Number(row.attempts ?? 0);
      const terminal = attempts + 1 >= VECTOR_CLEANUP_MAX_ATTEMPTS;
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      await env.DB.prepare(
        `UPDATE sb_vector_cleanup_batches
         SET attempts = attempts + 1,
             state = ?,
             next_attempt_at = ?,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`
      ).bind(
        terminal ? "failed" : "ready",
        terminal ? null : Date.now() + cleanupRetryDelayMs(attempts),
        message,
        Date.now(),
        row.id
      ).run();
    }
  }

  return { attempted, deleted, failed, blocked };
}

async function processVectorCleanupQueue(
  env: Env,
  limit = 100
): Promise<{ attempted: number; deleted: number; failed: number; blocked: number }> {
  const now = Date.now();
  const batchResult = await processVectorCleanupBatches(env, limit);
  const { results } = await env.DB.prepare(
    `SELECT vector_id, attempts
     FROM sb_vector_cleanup_queue
     WHERE state IN ('ready', 'blocked')
       AND COALESCE(next_attempt_at, 0) <= ?
     ORDER BY created_at ASC
     LIMIT ?`
  ).bind(now, Math.max(1, Math.min(limit, 500))).all<{ vector_id: string; attempts: number }>();
  const rows = results ?? [];
  if (!rows.length) return batchResult;

  let deleted = batchResult.deleted;
  let failed = batchResult.failed;
  let blocked = batchResult.blocked;
  for (let i = 0; i < rows.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = rows.slice(i, i + D1_MAX_BOUND_PARAMS);
    const ids = batch.map(row => row.vector_id).filter(Boolean);
    const referenced: string[] = [];
    const deletable: string[] = [];
    for (const id of ids) {
      if (await vectorStillReferenced(env, id)) referenced.push(id);
      else deletable.push(id);
    }
    if (referenced.length) {
      blocked += referenced.length;
      const updatedAt = Date.now();
      const attemptsById = new Map(batch.map(row => [row.vector_id, Number(row.attempts ?? 0)]));
      await env.DB.batch(referenced.map(id => {
        const attempts = attemptsById.get(id) ?? 0;
        return env.DB.prepare(
          `UPDATE sb_vector_cleanup_queue
           SET state = 'blocked',
               attempts = attempts + 1,
               next_attempt_at = ?,
               last_error = ?,
               updated_at = ?
           WHERE vector_id = ?`
        ).bind(
          updatedAt + referencedVectorRetryDelayMs(attempts),
          "vector_still_referenced",
          updatedAt,
          id
        );
      }));
    }
    if (!deletable.length) continue;
    try {
      await env.VECTORIZE.deleteByIds(deletable);
      const placeholders = deletable.map(() => "?").join(", ");
      const result = await env.DB.prepare(
        `DELETE FROM sb_vector_cleanup_queue WHERE vector_id IN (${placeholders})`
      ).bind(...deletable).run();
      deleted += Number(result.meta?.changes ?? deletable.length);
    } catch (error) {
      failed += deletable.length;
      const message = error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500);
      const retryAt = Date.now();
      await env.DB.batch(batch.map(row => {
        const attempts = Number(row.attempts ?? 0);
        const terminal = attempts + 1 >= VECTOR_CLEANUP_MAX_ATTEMPTS;
        return env.DB.prepare(
          `UPDATE sb_vector_cleanup_queue
           SET attempts = attempts + 1,
               state = ?,
               next_attempt_at = ?,
               last_error = ?,
               updated_at = ?
           WHERE vector_id = ?`
        ).bind(
          terminal ? "failed" : "ready",
          terminal ? null : retryAt + cleanupRetryDelayMs(attempts),
          message,
          retryAt,
          row.vector_id
        );
      }));
    }
  }

  return {
    attempted: batchResult.attempted + rows.length,
    deleted,
    failed,
    blocked,
  };
}

async function activatePendingVectorsAndSettings(
  env: Env,
  rebuildId: string,
  promotedSettings: ReturnType<typeof promoteEmbeddingFingerprint>
): Promise<{
  ok: boolean;
  activated: number;
  cleanupBatchesReady: number;
  error?: string;
}> {
  await ensureSettingsTable(env.DB);
  const settingsToSave = {
    ...promotedSettings,
    updatedAt: promotedSettings.updatedAt ?? Date.now(),
  };
  const now = settingsToSave.updatedAt;
  const promotedFingerprint = settingsToSave.embeddingFingerprint ??
    embeddingFingerprintOf(activeEmbeddingOf(settingsToSave));
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE sb_vector_rebuilds
       SET state = 'activating',
           updated_at = ?,
           conflict_entries = 0,
           last_error = NULL
       WHERE id = ?
         AND state IN ('queued', 'building', 'ready')
         AND NOT EXISTS (
           SELECT 1
           FROM entries
           WHERE tags NOT LIKE '%"status:deprecated"%'
             AND (
               pending_rebuild_id IS NULL
               OR pending_rebuild_id != ?
               OR pending_vector_ids IS NULL
               OR pending_vector_ids = '[]'
               OR pending_content_hash IS NULL
               OR content_hash IS NULL
               OR pending_revision_id IS NULL
               OR metadata_hash IS NULL
               OR pending_metadata_hash IS NULL
               OR pending_content_hash != content_hash
               OR pending_metadata_hash != metadata_hash
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM sb_memories m_claim_activation
           WHERE ${indexableClaimPredicate("m_claim_activation")}
             AND NOT EXISTS (
               SELECT 1
               FROM sb_claim_vectors cv_claim_activation
               WHERE cv_claim_activation.claim_id = m_claim_activation.id
                 AND cv_claim_activation.embedding_fingerprint = ?
                 AND cv_claim_activation.content_hash = m_claim_activation.content_hash
             )
         )`
    ).bind(now, rebuildId, rebuildId, promotedFingerprint),
    env.DB.prepare(
      `UPDATE entries
       SET vector_ids = pending_vector_ids,
           embedding_fingerprint = pending_embedding_fingerprint,
           metadata_hash = pending_metadata_hash,
           pending_vector_ids = NULL,
           pending_embedding_fingerprint = NULL,
           pending_content_hash = NULL,
           pending_revision_id = NULL,
           pending_metadata_hash = NULL,
           pending_rebuild_id = NULL
       WHERE pending_rebuild_id = ?
         AND EXISTS (
           SELECT 1
           FROM sb_vector_rebuilds
           WHERE id = ?
             AND state = 'activating'
         )`
    ).bind(rebuildId, rebuildId),
    env.DB.prepare(
      `INSERT INTO sb_app_settings (key, value, updated_at)
       SELECT 'model_settings', ?, ?
       WHERE EXISTS (
         SELECT 1
         FROM sb_vector_rebuilds
         WHERE id = ?
           AND state = 'activating'
       )
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).bind(JSON.stringify(settingsToSave), now, rebuildId),
    env.DB.prepare(
      `DELETE FROM sb_claim_vectors
       WHERE embedding_fingerprint = (
         SELECT active_fingerprint
         FROM sb_vector_rebuilds
         WHERE id = ?
           AND state = 'activating'
           AND active_fingerprint != pending_fingerprint
       )`
    ).bind(rebuildId),
    env.DB.prepare(
      `DELETE FROM sb_claim_vector_jobs
       WHERE target_fingerprint = (
         SELECT active_fingerprint
         FROM sb_vector_rebuilds
         WHERE id = ?
           AND state = 'activating'
           AND active_fingerprint != pending_fingerprint
       )`
    ).bind(rebuildId),
    env.DB.prepare(
      `UPDATE sb_vector_cleanup_batches
       SET state = 'ready',
           updated_at = ?
       WHERE rebuild_id = ?
         AND state = 'prepared'
         AND EXISTS (
           SELECT 1
           FROM sb_vector_rebuilds
           WHERE id = ?
             AND state = 'activating'
         )`
    ).bind(now, rebuildId, rebuildId),
    env.DB.prepare(
      `UPDATE sb_vector_rebuilds
       SET state = 'active',
           updated_at = ?
       WHERE id = ?
         AND state = 'activating'`
    ).bind(now, rebuildId),
  ]);
  const casChanged = Number(results[0]?.meta?.changes ?? 0);
  const entryChanged = Number(results[1]?.meta?.changes ?? 0);
  const settingsChanged = Number(results[2]?.meta?.changes ?? 0);
  const cleanupBatchesReady = Number(results[5]?.meta?.changes ?? 0);
  const activeChanged = Number(results[6]?.meta?.changes ?? 0);
  if (casChanged !== 1) {
    return {
      ok: false,
      activated: 0,
      cleanupBatchesReady: 0,
      error: "vector_activation_conflict",
    };
  }
  if (settingsChanged !== 1 || activeChanged !== 1) {
    return {
      ok: false,
      activated: entryChanged,
      cleanupBatchesReady,
      error: "vector_activation_transaction_incomplete",
    };
  }
  setStoredModelSettingsCache(settingsToSave);
  return {
    ok: true,
    activated: entryChanged,
    cleanupBatchesReady,
  };
}

async function countPendingRebuildRows(
  env: Env,
  pendingFingerprint: string
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM entries
     WHERE pending_embedding_fingerprint = ?
       AND pending_vector_ids IS NOT NULL`
  ).bind(pendingFingerprint).first() as Record<string, any> | null;
  return Number(row?.count ?? 0);
}

async function listPendingRebuildVectorIds(
  env: Env,
  pendingFingerprint: string,
  rebuildId?: string | null
): Promise<string[]> {
  const sql = rebuildId
    ? `SELECT pending_vector_ids FROM entries
       WHERE pending_embedding_fingerprint = ?
         AND pending_rebuild_id = ?
         AND pending_vector_ids IS NOT NULL
         AND pending_vector_ids != '[]'`
    : `SELECT pending_vector_ids FROM entries
       WHERE pending_embedding_fingerprint = ?
         AND pending_vector_ids IS NOT NULL
         AND pending_vector_ids != '[]'`;
  const statement = env.DB.prepare(sql);
  const { results } = rebuildId
    ? await statement.bind(pendingFingerprint, rebuildId).all() as { results: Array<Record<string, unknown>> }
    : await statement.bind(pendingFingerprint).all() as { results: Array<Record<string, unknown>> };
  return [...new Set(
    (results ?? []).flatMap((row) => parseVectorIds(row.pending_vector_ids))
  )];
}

async function cancelVectorRebuild(
  env: Env,
  stored: ReturnType<typeof mergeFromEnvOnly>,
  reason: string
): Promise<CancelRebuildResult> {
  const pendingFingerprint = stored.pendingEmbeddingFingerprint;
  if (!pendingFingerprint) {
    return {
      cancelled: false,
      cleanupBatchesPrepared: 0,
      cleanupVectorsPrepared: 0,
      entriesCleared: 0,
    };
  }
  const rebuild = await loadCurrentVectorRebuild(env, pendingFingerprint);
  const rebuildId = rebuild?.id ?? `legacy-cancel-${crypto.randomUUID()}`;
  const pendingEntryVectorIds = await listPendingRebuildVectorIds(
    env,
    pendingFingerprint,
    rebuild?.id
  );
  const pendingClaimVectorIds = await listClaimVectorIdsForFingerprint(
    env.DB,
    pendingFingerprint
  );
  const pendingVectorIds = [...new Set([
    ...pendingEntryVectorIds,
    ...pendingClaimVectorIds,
  ])];
  const cleanup = await prepareVectorCleanupBatches(env, rebuildId, pendingVectorIds, "prepared");
  const activeEmbedding = activeEmbeddingOf(stored);
  const next = structuredClone(stored);
  next.activeEmbedding = cloneEmbeddingSettings(activeEmbedding);
  next.embedding = cloneEmbeddingSettings(activeEmbedding);
  next.embeddingFingerprint =
    stored.embeddingFingerprint ?? embeddingFingerprintOf(activeEmbedding);
  next.pendingEmbedding = undefined;
  next.pendingEmbeddingFingerprint = undefined;
  next.updatedAt = Date.now();

  const statements: D1PreparedStatement[] = [];
  if (rebuild) {
    statements.push(
      env.DB.prepare(
        `UPDATE sb_vector_rebuilds
         SET state = 'cancelling',
             updated_at = ?
         WHERE id = ?
           AND state NOT IN ('active', 'cancelled', 'failed')`
      ).bind(next.updatedAt, rebuild.id)
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE entries
       SET pending_vector_ids = NULL,
           pending_embedding_fingerprint = NULL,
           pending_content_hash = NULL,
           pending_revision_id = NULL,
           pending_metadata_hash = NULL,
           pending_rebuild_id = NULL
       WHERE pending_embedding_fingerprint = ?`
    ).bind(pendingFingerprint),
    env.DB.prepare(
      `DELETE FROM sb_claim_vectors WHERE embedding_fingerprint = ?`
    ).bind(pendingFingerprint),
    env.DB.prepare(
      `DELETE FROM sb_claim_vector_jobs WHERE target_fingerprint = ?`
    ).bind(pendingFingerprint),
    prepareStoredModelSettingsSave(env.DB, next),
    env.DB.prepare(
      `UPDATE sb_vector_cleanup_batches
       SET state = 'ready',
           updated_at = ?
       WHERE rebuild_id = ?
         AND state = 'prepared'`
    ).bind(next.updatedAt, rebuildId)
  );
  if (rebuild) {
    statements.push(
      env.DB.prepare(
        `UPDATE sb_vector_rebuilds
         SET state = 'cancelled',
             updated_at = ?
         WHERE id = ?
           AND state = 'cancelling'`
      ).bind(next.updatedAt, rebuild.id)
    );
  }

  const results = await env.DB.batch(statements);
  const entriesCleared = Number(results[rebuild ? 1 : 0]?.meta?.changes ?? 0);
  setStoredModelSettingsCache(next);
  return {
    cancelled: true,
    pendingFingerprint,
    cleanupBatchesPrepared: cleanup.batches,
    cleanupVectorsPrepared: cleanup.vectors,
    entriesCleared,
  };
}

function summarizeVectorRuntimeStates(
  rows: Record<string, unknown>[],
  states: string[]
): Record<string, number> {
  const summary: Record<string, number> = { total: 0 };
  for (const state of states) summary[state] = 0;
  for (const row of rows) {
    const state = String(row.state ?? "unknown");
    const count = Number(row.count ?? 0);
    summary[state] = (summary[state] ?? 0) + count;
    summary.total += count;
  }
  return summary;
}

async function loadVectorRuntimeSnapshot(env: Env, now = Date.now()) {
  const [
    vectorRebuild,
    vectorCleanupQueueRows,
    vectorCleanupBatchRows,
    vectorCleanupQueueDue,
    vectorCleanupBatchDue,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT r.id, r.state, r.active_fingerprint, r.pending_fingerprint,
              r.expected_entries, r.processed_entries, r.failed_entries,
              r.conflict_entries, r.last_error, r.created_at, r.updated_at,
              (SELECT COUNT(*) FROM entries e
               WHERE e.pending_rebuild_id = r.id
                 AND e.tags NOT LIKE '%"status:deprecated"%') as joined_entries,
              (SELECT COUNT(*) FROM entries e
               WHERE e.pending_rebuild_id = r.id
                 AND e.pending_vector_ids IS NOT NULL
                 AND e.pending_vector_ids != '[]'
                 AND e.pending_content_hash IS NOT NULL
                 AND e.pending_revision_id IS NOT NULL
                 AND e.pending_metadata_hash IS NOT NULL
                 AND e.content_hash = e.pending_content_hash
                 AND e.metadata_hash = e.pending_metadata_hash
                 AND e.tags NOT LIKE '%"status:deprecated"%') as ready_entries,
              (SELECT COUNT(*) FROM entries e
               WHERE e.pending_rebuild_id = r.id
                 AND (e.pending_vector_ids IS NULL OR e.pending_vector_ids = '[]')
                 AND e.tags NOT LIKE '%"status:deprecated"%') as missing_entries,
              (SELECT COUNT(*) FROM entries e
               WHERE e.pending_rebuild_id = r.id
                 AND e.pending_vector_ids IS NOT NULL
                 AND e.pending_vector_ids != '[]'
                 AND (
                   e.pending_content_hash IS NULL
                   OR e.pending_revision_id IS NULL
                   OR e.pending_metadata_hash IS NULL
                   OR e.content_hash IS NULL
                   OR e.metadata_hash IS NULL
                   OR e.content_hash != e.pending_content_hash
                   OR e.metadata_hash != e.pending_metadata_hash
                 )
                 AND e.tags NOT LIKE '%"status:deprecated"%') as live_conflict_entries
       FROM sb_vector_rebuilds r
       WHERE r.slot = 'current'
       LIMIT 1`
    ).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT state, COUNT(*) as count
       FROM sb_vector_cleanup_queue
       GROUP BY state`
    ).all(),
    env.DB.prepare(
      `SELECT state, COUNT(*) as count
       FROM sb_vector_cleanup_batches
       GROUP BY state`
    ).all(),
    env.DB.prepare(
      `SELECT COUNT(*) as count
       FROM sb_vector_cleanup_queue
       WHERE state = 'ready'
         AND COALESCE(next_attempt_at, 0) <= ?`
    ).bind(now).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as count
       FROM sb_vector_cleanup_batches
       WHERE state = 'ready'
         AND COALESCE(next_attempt_at, 0) <= ?`
    ).bind(now).first<{ count: number }>(),
  ]);

  const serializeVectorRebuild = (row: Record<string, unknown>) => ({
    id: String(row.id),
    state: String(row.state),
    active_fingerprint: String(row.active_fingerprint ?? ""),
    pending_fingerprint: String(row.pending_fingerprint ?? ""),
    expected_entries: Number(row.expected_entries ?? 0),
    processed_entries: Number(row.processed_entries ?? 0),
    failed_entries: Number(row.failed_entries ?? 0),
    conflict_entries: Number(row.conflict_entries ?? 0),
    live_conflict_entries: Number(row.live_conflict_entries ?? 0),
    joined_entries: Number(row.joined_entries ?? 0),
    ready_entries: Number(row.ready_entries ?? 0),
    missing_entries: Number(row.missing_entries ?? 0),
    last_error: row.last_error ? String(row.last_error) : null,
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  });
  const serializedVectorRebuild = vectorRebuild
    ? serializeVectorRebuild(vectorRebuild)
    : null;
  const activeVectorRebuild = serializedVectorRebuild &&
    !["active", "cancelled", "failed"].includes(serializedVectorRebuild.state)
    ? serializedVectorRebuild
    : null;
  const localIndexStatus = (env.VECTORIZE as any).indexStatus?.();

  return {
    rebuild: activeVectorRebuild,
    last_rebuild: serializedVectorRebuild,
    cleanup: {
      queue: {
        ...summarizeVectorRuntimeStates(
          (vectorCleanupQueueRows.results ?? []) as Record<string, unknown>[],
          ["ready", "blocked", "failed", "completed"]
        ),
        due: Number(vectorCleanupQueueDue?.count ?? 0),
      },
      batches: {
        ...summarizeVectorRuntimeStates(
          (vectorCleanupBatchRows.results ?? []) as Record<string, unknown>[],
          ["prepared", "ready", "processing", "blocked", "failed", "completed"]
        ),
        due: Number(vectorCleanupBatchDue?.count ?? 0),
      },
    },
    local_index: localIndexStatus ? {
      vectorCount: Number(localIndexStatus.vectorCount ?? 0),
      ftsAvailable: Boolean(localIndexStatus.ftsAvailable),
      ftsTokenizer: localIndexStatus.ftsTokenizer ?? null,
      ftsIndexed: Number(localIndexStatus.ftsIndexed ?? 0),
      vecAvailable: Boolean(localIndexStatus.vecAvailable),
      vecIndexed: Number(localIndexStatus.vecIndexed ?? 0),
      profileVectorCount: Number(localIndexStatus.profileVectorCount ?? 0),
      profileVecIndexed: Number(localIndexStatus.profileVecIndexed ?? 0),
      profileVecRemaining: Number(localIndexStatus.profileVecRemaining ?? 0),
      filteredVecAvailable: Boolean(localIndexStatus.filteredVecAvailable),
      filteredQueryBackend: String(localIndexStatus.filteredQueryBackend ?? "json-filter-scan"),
      remaining: Number(localIndexStatus.remaining ?? 0),
    } : null,
  };
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
  const snapshot = await loadActiveEmbeddingSnapshot(env);
  const prepared = await prepareEntryVectors(
    env,
    id,
    content,
    tags,
    source,
    now,
    createVectorGeneration(),
    snapshot.fingerprint,
    "active",
    undefined,
    snapshot.provider
  );
  try {
    await insertPreparedVectors(env, prepared);
  } catch (error) {
    await cleanupPreparedVectors(env, prepared.vectorIds, "Initial vector insert");
    throw error;
  }

  try {
    const metadataHash = await entryMetadataFingerprint({ source, tags });
    // Initial vectorization runs in waitUntil() and can finish after a manual
    // update has already activated a newer generation. Commit only while the
    // entry still points at the empty generation; a stale writer must never
    // move the pointer backwards.
    const result = await env.DB.prepare(
      `UPDATE entries
       SET vector_ids = ?,
           embedding_fingerprint = ?,
           metadata_hash = ?,
           pending_content_hash = NULL,
           pending_revision_id = NULL,
           pending_metadata_hash = NULL
       WHERE id = ? AND vector_ids = ? AND content = ?
         AND tags NOT LIKE '%"status:deprecated"%'
         AND (
           NOT EXISTS (SELECT 1 FROM sb_app_settings WHERE key = 'model_settings')
           OR EXISTS (
             SELECT 1 FROM sb_app_settings
             WHERE key = 'model_settings'
               AND COALESCE(json_extract(value, '$.embeddingFingerprint'), '') = ?
           )
         )`
    ).bind(
      JSON.stringify(prepared.vectorIds),
      snapshot.fingerprint,
      metadataHash,
      id,
      "[]",
      content,
      snapshot.fingerprint
    ).run();
    if (result.meta?.changes === 0) {
      await cleanupPreparedVectors(env, prepared.vectorIds, "Stale initial vector write");
      return [];
    }
  } catch (error) {
    await cleanupPreparedVectors(env, prepared.vectorIds, "Initial vector write");
    throw error;
  }

  await attachEntryToOpenVectorRebuild(env, id);
  return prepared.vectorIds;
}

async function storeEntryVectorBatch(
  env: Env,
  rows: VectorizeQueueRow[],
  _pendingFingerprint: string | null
): Promise<VectorizeBatchResult> {
  const snapshot = await loadActiveEmbeddingSnapshot(env);
  const prepared = await prepareEntryVectorBatch(env, rows, {
    embeddingRole: "active",
    embeddingFingerprint: snapshot.fingerprint,
    embeddingProvider: snapshot.provider,
  });
  const allVectorIds = prepared.flatMap((item) => item.vectorIds);
  try {
    await insertPreparedVectorBatch(env, prepared);
  } catch (error) {
    await cleanupPreparedVectors(env, allVectorIds, "Initial vector batch insert");
    throw error;
  }

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of prepared) {
    try {
      const metadataHash = await entryMetadataFingerprint({
        source: item.row.source,
        tags: JSON.parse(item.row.tags) as string[],
      });
      const result = await env.DB.prepare(
        `UPDATE entries
         SET vector_ids = ?,
             embedding_fingerprint = ?,
             metadata_hash = ?,
             pending_content_hash = NULL,
             pending_revision_id = NULL,
             pending_metadata_hash = NULL
         WHERE id = ? AND vector_ids = ? AND content = ?
           AND tags NOT LIKE '%"status:deprecated"%'
           AND (
             NOT EXISTS (SELECT 1 FROM sb_app_settings WHERE key = 'model_settings')
             OR EXISTS (
               SELECT 1 FROM sb_app_settings
               WHERE key = 'model_settings'
                 AND COALESCE(json_extract(value, '$.embeddingFingerprint'), '') = ?
             )
           )`
      ).bind(
        JSON.stringify(item.vectorIds),
        snapshot.fingerprint,
        metadataHash,
        item.row.id,
        "[]",
        item.row.content,
        snapshot.fingerprint
      ).run();
      if (result.meta?.changes === 0) {
        await cleanupPreparedVectors(env, item.vectorIds, "Stale initial vector batch write");
        skipped++;
      } else {
        processed++;
        await attachEntryToOpenVectorRebuild(env, item.row.id);
      }
    } catch (error) {
      await cleanupPreparedVectors(env, item.vectorIds, "Initial vector batch write");
      console.error("Initial vector batch write failed for entry", item.row.id, error);
      failed++;
    }
  }
  return { processed, failed, skipped };
}

// Delete vectors that are no longer referenced after a re-embed. Generations
// are unique, but retain the set difference so legacy/repaired rows remain safe.
async function deleteStaleVectors(env: Env, oldIds: string[], newIds: string[]): Promise<void> {
  const stale = oldIds.filter(v => !newIds.includes(v));
  if (stale.length) {
    await enqueueVectorCleanup(env, stale, "entry_version_switch", undefined, { state: "ready" });
  }
}

interface CommitEntryVersionInput {
  id: string;
  oldContent: string;
  newContent: string;
  oldTags: string[];
  newTags: string[];
  source: string;
  eventType: Extract<MemoryRevisionEvent, "UPDATE" | "APPEND">;
  actor: string;
  reason?: string;
}

/**
 * Compensating transaction across Vectorize and D1:
 * 1. build and insert a unique new vector generation;
 * 2. atomically switch D1 content/vector_ids and append its revision;
 * 3. clean the old generation only after the D1 switch succeeds.
 */
async function commitEntryVersion(
  env: Env,
  input: CommitEntryVersionInput,
  attempt = 0
): Promise<string[]> {
  const now = Date.now();
  const snapshot = await loadActiveEmbeddingSnapshot(env);
  const prepared = await prepareEntryVectors(
    env,
    input.id,
    input.newContent,
    input.newTags,
    input.source,
    now,
    createVectorGeneration(),
    snapshot.fingerprint,
    "active",
    undefined,
    snapshot.provider
  );

  try {
    await insertPreparedVectors(env, prepared);
  } catch (error) {
    await cleanupPreparedVectors(env, prepared.vectorIds, "Version vector insert");
    throw error;
  }

  let activeOldVectorIds: string[];
  let oldPendingVectorIds: string[] = [];
  let activeTagsJson: string;
  const openRebuild = await loadOpenVectorRebuild(env);
  let wasInOpenRebuild = false;
  try {
    // Embedding can take long enough for the background initial vectorization
    // to advance only the index pointer. Adopt that newer pointer when the
    // content is unchanged; reject an actual concurrent content write.
    const current = await env.DB.prepare(
      `SELECT content, tags, vector_ids, pending_vector_ids, pending_rebuild_id FROM entries WHERE id = ?`
    ).bind(input.id).first() as Record<string, any> | null;
    if (!current || current.content !== input.oldContent) {
      throw new Error("Entry content changed while vectors were being prepared");
    }
    const currentTags = JSON.parse(current.tags ?? "[]") as string[];
    if (JSON.stringify(currentTags) !== JSON.stringify(input.oldTags)) {
      throw new Error("Entry tags changed while vectors were being prepared");
    }
    activeTagsJson = current.tags ?? "[]";
    activeOldVectorIds = JSON.parse(current.vector_ids ?? "[]");
    oldPendingVectorIds = parseVectorIds(current.pending_vector_ids);
    wasInOpenRebuild = Boolean(openRebuild && current.pending_rebuild_id === openRebuild.id);
  } catch (error) {
    await cleanupPreparedVectors(env, prepared.vectorIds, "Version refresh");
    throw error;
  }

  const revision = prepareMemoryRevision(env.DB, {
    memoryId: input.id,
    eventType: input.eventType,
    oldContent: input.oldContent,
    newContent: input.newContent,
    oldMetadata: { tags: input.oldTags, source: input.source },
    newMetadata: { tags: input.newTags, source: input.source },
    reason: input.reason,
    actor: input.actor,
    createdAt: now,
  }, {
    activeVectorIdsJson: JSON.stringify(prepared.vectorIds),
  });

  let switchResult: D1Result;
  try {
    const newHash = await contentFingerprint(input.newContent);
    const oldHash = await contentFingerprint(input.oldContent);
    const metadataHash = await entryMetadataFingerprint({
      source: input.source,
      tags: input.newTags,
    });
    const staleIds = [...new Set([
      ...activeOldVectorIds.filter((id) => !prepared.vectorIds.includes(id)),
      ...oldPendingVectorIds,
    ])];
    const cleanupStatements = staleIds.map((vectorId) =>
      prepareVectorCleanupQueueInsert(env, {
        id: crypto.randomUUID(),
        vectorId,
        reason: "entry_version_switch",
        state: "ready",
        rebuildId: openRebuild?.id ?? null,
        now,
      })
    );
    const auditEvent = await prepareComplianceAuditEvent(env.DB, {
      actorType: input.actor === "system" ? "system" : "api",
      actorId: input.actor,
      action: input.eventType === "APPEND" ? "memory.append" : "memory.update",
      objectType: "memory",
      objectId: input.id,
      beforeHash: oldHash,
      afterHash: newHash,
      metadata: {
        source: input.source,
        reason: input.reason ?? null,
        event_type: input.eventType,
        old_tags: input.oldTags,
        new_tags: input.newTags,
      },
    });
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE entries
         SET content = ?, tags = ?, vector_ids = ?, embedding_fingerprint = ?, content_hash = ?
             , metadata_hash = ?
             , pending_vector_ids = ?, pending_embedding_fingerprint = ?
             , pending_content_hash = NULL
             , pending_revision_id = NULL
             , pending_metadata_hash = NULL
             , pending_rebuild_id = ?
             , classification_status = 'pending', classification_error = NULL
             , classification_attempts = 0, classification_next_attempt_at = NULL
             , classification_started_at = NULL, classification_confidence = NULL
             , classified_at = NULL
         WHERE id = ? AND content = ? AND tags = ? AND vector_ids = ?
           AND (
             NOT EXISTS (SELECT 1 FROM sb_app_settings WHERE key = 'model_settings')
             OR EXISTS (
               SELECT 1 FROM sb_app_settings
               WHERE key = 'model_settings'
                 AND COALESCE(json_extract(value, '$.embeddingFingerprint'), '') = ?
             )
           )`
      ).bind(
        input.newContent,
        JSON.stringify(input.newTags),
        JSON.stringify(prepared.vectorIds),
        snapshot.fingerprint,
        newHash,
        metadataHash,
        openRebuild ? "[]" : null,
        openRebuild?.pendingFingerprint ?? null,
        openRebuild?.id ?? null,
        input.id,
        input.oldContent,
        activeTagsJson,
        JSON.stringify(activeOldVectorIds),
        snapshot.fingerprint
      ),
      revision.statement,
      ...cleanupStatements,
      auditEvent.statement,
    ]);
    switchResult = results[0];
  } catch (error) {
    await cleanupPreparedVectors(env, prepared.vectorIds, "Version switch");
    throw error;
  }
  if (switchResult.meta?.changes === 0) {
    await cleanupPreparedVectors(env, prepared.vectorIds, "Stale version switch");
    if (attempt < 1 && !(await isActiveEmbeddingSnapshotCurrent(env, snapshot))) {
      return commitEntryVersion(env, input, attempt + 1);
    }
    throw new Error("Entry changed while the new vector generation was being prepared");
  }
  if (openRebuild && !wasInOpenRebuild) {
    await env.DB.prepare(
      `UPDATE sb_vector_rebuilds
       SET expected_entries = expected_entries + 1,
           updated_at = ?
       WHERE id = ?
         AND state IN ('queued', 'building', 'ready')`
    ).bind(Date.now(), openRebuild.id).run();
  }
  await notifyMemoryChanged(env, input.id, "content");

  return prepared.vectorIds;
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
  source: string,
  attempt = 0
): Promise<string> {
  if (getStatus(tags) === "deprecated") {
    throw new Error("Cannot append to a deprecated memory");
  }

  const timestamp = new Date().toLocaleDateString();
  const separator = `\n\n[Update ${timestamp}]: `;
  const newContent = existingContent + separator + addition;

  if (newContent.length > CHUNK_MAX_CHARS) {
    // ── Full re-embed path ───────────────────────────────────────────────────
    // Combined content is too large for a single vector. Build and insert a new
    // generation first; only then switch D1 and retire the old generation.
    await commitEntryVersion(env, {
      id,
      oldContent: existingContent,
      newContent,
      oldTags: tags,
      newTags: tags,
      source,
      eventType: "APPEND",
      actor: source,
      reason: "Large append required full re-embedding",
    });
    return newContent;
  }

  // ── Normal append-only path (combined content ≤ CHUNK_MAX_CHARS) ────────────
  const newChunkId = `u-${createVectorGeneration()}`;

  const snapshot = await loadActiveEmbeddingSnapshot(env);
  const values = await embedWithProvider(snapshot.provider, addition, "document");

  const metadata: Record<string, any> = {
    content: addition,
    parentId: id,
    isUpdate: true,
    tags,
    source,
    created_at: Date.now(),
    embedding_fingerprint: snapshot.fingerprint,
  };

  tags.forEach(t => {
    metadata[`tag_${t}`] = true;
  });

  try {
    await env.VECTORIZE.insert([{
      id: newChunkId,
      values,
      metadata,
    }]);
  } catch (error) {
    await cleanupPreparedVectors(env, [newChunkId], "Append vector insert");
    throw error;
  }

  let activeVectorIds: string[];
  let oldPendingVectorIds: string[] = [];
  let activeTagsJson: string;
  const openRebuild = await loadOpenVectorRebuild(env);
  let wasInOpenRebuild = false;
  try {
    const current = await env.DB.prepare(
      `SELECT content, tags, vector_ids, pending_vector_ids, pending_rebuild_id FROM entries WHERE id = ?`
    ).bind(id).first() as Record<string, any> | null;
    if (!current || current.content !== existingContent) {
      throw new Error("Entry content changed while the append vector was being prepared");
    }
    const currentTags = JSON.parse(current.tags ?? "[]") as string[];
    if (getStatus(currentTags) === "deprecated") {
      throw new Error("Cannot append to a deprecated memory");
    }
    activeTagsJson = current.tags ?? "[]";
    activeVectorIds = JSON.parse(current.vector_ids ?? "[]");
    oldPendingVectorIds = parseVectorIds(current.pending_vector_ids);
    wasInOpenRebuild = Boolean(openRebuild && current.pending_rebuild_id === openRebuild.id);
  } catch (error) {
    await cleanupPreparedVectors(env, [newChunkId], "Append refresh");
    throw error;
  }

  const appendRevision = prepareMemoryRevision(env.DB, {
    memoryId: id,
    eventType: "APPEND",
    oldContent: existingContent,
    newContent,
    oldMetadata: { tags, source },
    newMetadata: { tags, source },
    actor: source,
  }, {
    activeVectorIdsJson: JSON.stringify([...activeVectorIds, newChunkId]),
  });
  let switchResult: D1Result;
  try {
    const newHash = await contentFingerprint(newContent);
    const oldHash = await contentFingerprint(existingContent);
    const metadataHash = await entryMetadataFingerprint({ source, tags });
    const cleanupStatements = [...new Set(oldPendingVectorIds)].map((vectorId) =>
      prepareVectorCleanupQueueInsert(env, {
        id: crypto.randomUUID(),
        vectorId,
        reason: "entry_version_switch",
        state: "ready",
        rebuildId: openRebuild?.id ?? null,
        now: Date.now(),
      })
    );
    const auditEvent = await prepareComplianceAuditEvent(env.DB, {
      actorType: source === "system" ? "system" : "api",
      actorId: source,
      action: "memory.append",
      objectType: "memory",
      objectId: id,
      beforeHash: oldHash,
      afterHash: newHash,
      metadata: {
        source,
        append_mode: "single-vector",
        tags,
      },
    });
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE entries
         SET content = ?, vector_ids = ?, embedding_fingerprint = ?, content_hash = ?
             , metadata_hash = ?
             , pending_vector_ids = ?, pending_embedding_fingerprint = ?
             , pending_content_hash = NULL
             , pending_revision_id = NULL
             , pending_metadata_hash = NULL
             , pending_rebuild_id = ?
             , classification_status = 'pending', classification_error = NULL
             , classification_attempts = 0, classification_next_attempt_at = NULL
             , classification_started_at = NULL, classification_confidence = NULL
             , classified_at = NULL
         WHERE id = ? AND content = ? AND tags = ? AND vector_ids = ?
           AND (
             NOT EXISTS (SELECT 1 FROM sb_app_settings WHERE key = 'model_settings')
             OR EXISTS (
               SELECT 1 FROM sb_app_settings
               WHERE key = 'model_settings'
                 AND COALESCE(json_extract(value, '$.embeddingFingerprint'), '') = ?
             )
           )`
      ).bind(
        newContent,
        JSON.stringify([...activeVectorIds, newChunkId]),
        snapshot.fingerprint,
        newHash,
        metadataHash,
        openRebuild ? "[]" : null,
        openRebuild?.pendingFingerprint ?? null,
        openRebuild?.id ?? null,
        id,
        existingContent,
        activeTagsJson,
        JSON.stringify(activeVectorIds),
        snapshot.fingerprint
      ),
      appendRevision.statement,
      ...cleanupStatements,
      auditEvent.statement,
    ]);
    switchResult = results[0];
  } catch (error) {
    await cleanupPreparedVectors(env, [newChunkId], "Append");
    throw error;
  }
  if (switchResult.meta?.changes === 0) {
    await cleanupPreparedVectors(env, [newChunkId], "Stale append");
    if (attempt < 1 && !(await isActiveEmbeddingSnapshotCurrent(env, snapshot))) {
      return appendToEntry(env, id, existingContent, addition, tags, source, attempt + 1);
    }
    throw new Error("Entry changed while the append vector was being prepared");
  }
  if (openRebuild && !wasInOpenRebuild) {
    await env.DB.prepare(
      `UPDATE sb_vector_rebuilds
       SET expected_entries = expected_entries + 1,
           updated_at = ?
       WHERE id = ?
         AND state IN ('queued', 'building', 'ready')`
    ).bind(Date.now(), openRebuild.id).run();
  }
  await notifyMemoryChanged(env, id, "content");
  return newContent;
}

// ─── Synthesize insight from retrieved memories ───────────────────────────────

function buildCitableInsightClaims(
  context: InsightContextPackage<RecallClaimContext>,
  conflicts: readonly RecallConflictContext[] = []
): CitableInsightClaim[] {
  const claims: CitableInsightClaim[] = [];
  const claimsById = new Map<string, CitableInsightClaim>();
  for (const evidence of context.directEvidence) {
    for (const claim of evidence.claims ?? []) {
      if (!claim.id || claimsById.has(claim.id)) continue;
      const citable: CitableInsightClaim = {
        ref: `C${claims.length + 1}`,
        evidenceId: evidence.id,
        claimId: claim.id,
        statement: claim.statement,
        status: claim.status,
        conflictIds: [...claim.conflictIds],
        citationUse: "fact",
      };
      claims.push(citable);
      claimsById.set(claim.id, citable);
    }
  }
  for (const conflict of conflicts) {
    for (const claim of conflict.claims) {
      const existing = claimsById.get(claim.id);
      if (existing) {
        if (!existing.conflictIds.includes(conflict.id)) {
          const updated = {
            ...existing,
            conflictIds: [...existing.conflictIds, conflict.id],
          };
          const claimIndex = claims.findIndex((item) => item.claimId === claim.id);
          if (claimIndex >= 0) claims[claimIndex] = updated;
          claimsById.set(claim.id, updated);
        }
        continue;
      }
      const citable: CitableInsightClaim = {
        ref: `C${claims.length + 1}`,
        evidenceId: claim.entryId,
        claimId: claim.id,
        statement: claim.statement,
        status: claim.status,
        conflictIds: [conflict.id],
        citationUse: "conflict_only",
      };
      claims.push(citable);
      claimsById.set(claim.id, citable);
    }
  }
  return claims;
}

export async function resolveVerifiedRecallInsight(
  query: string,
  contextInput: InsightContextPackage<RecallClaimContext>,
  env: Env,
  conflicts: RecallConflictContext[] = [],
  options: { asOf?: number } = {}
): Promise<VerifiedInsightResult> {
  const context = normalizeInsightContext(contextInput);
  return synthesizeVerifiedInsight(query, context, env, conflicts, options);
}

export async function synthesizeVerifiedInsight(
  query: string,
  contextInput:
    | InsightContextPackage<RecallClaimContext>
    | InsightEvidenceRow<RecallClaimContext>[],
  env: Env,
  conflicts: RecallConflictContext[] = [],
  options: { asOf?: number } = {}
): Promise<VerifiedInsightResult> {
  const context = normalizeInsightContext(contextInput);
  if (!context.directEvidence.length && !context.relatedContext.length) {
    return { answer: "", verifiedClaims: [], unverifiedClaims: [] };
  }
  if (!context.directEvidence.length) {
    return {
      answer: INSUFFICIENT_VERIFIED_EVIDENCE,
      verifiedClaims: [],
      unverifiedClaims: [],
    };
  }

  const citableClaims = buildCitableInsightClaims(context, conflicts);
  if (!citableClaims.length) {
    return {
      answer: INSUFFICIENT_VERIFIED_EVIDENCE,
      verifiedClaims: [],
      unverifiedClaims: [],
    };
  }
  const memoriesList = context.directEvidence
    .map((r, i) => {
      const claimLines = citableClaims
        .filter((claim) => claim.evidenceId === r.id)
        .map((claim) =>
          `[${claim.ref}] claim=${claim.claimId ?? "legacy-entry"}; status=${claim.status}; ` +
          `conflicts=${claim.conflictIds.join(",") || "none"}; statement=${claim.statement}`
        );
      return `[E${i + 1}] evidence_id=${r.id}\n${claimLines.join("\n")}`;
    })
    .join("\n\n");
  const relatedContextList = context.relatedContext.length
    ? context.relatedContext.map((row, index) =>
      `[R${index + 1}] association=${row.associationType}; hop=${row.hop}; ` +
      "content=withheld because Association context is navigation-only"
    ).join("\n\n")
    : "None";
  const conflictOnlyClaims = citableClaims
    .filter((claim) => claim.citationUse === "conflict_only")
    .map((claim) =>
      `[${claim.ref}] claim=${claim.claimId}; conflicts=${claim.conflictIds.join(",")}; ` +
      `statement=${claim.statement}`
    ).join("\n") || "None";
  const conflictsList = conflicts.length
    ? conflicts.map((conflict) => {
      const refs = citableClaims
        .filter((claim) => claim.conflictIds.includes(conflict.id))
        .map((claim) => claim.ref);
      return (
      `[Conflict ${conflict.id}] state=${conflict.state}; reason=${conflict.reason ?? "unspecified"}; ` +
      `refs=${refs.join(",") || "none"}`
      );
    }).join("\n")
    : "None";

  const prompt = `You are a second brain assistant. Summarize what the user's stored memories below say in relation to their query. Base the insight ONLY on these memories.

Query: "${query}"

Direct Evidence:
${memoriesList}

Related Association Context (navigation only; not factual Evidence):
${relatedContextList}

Conflict-only Claims (may only be cited by kind="conflict"):
${conflictOnlyClaims}

Unresolved conflicts:
${conflictsList}

Rules:
- Return exactly one JSON object and no markdown: {"answer":"","claims":[{"text":"","refs":["C1"],"kind":"fact"}]}.
- C* references are the only citable Claims. E* labels identify Evidence containers and R* labels are navigation-only; never place E* or R* in refs.
- For kind="fact", copy text exactly from one referenced C* statement. Do not paraphrase, combine, infer, guess, or add facts.
- A contested Claim or a Claim with conflicts cannot be emitted as kind="fact".
- A Claim listed under Conflict-only Claims cannot support kind="fact".
- To disclose an unresolved conflict, use kind="conflict" and cite at least two C* refs that share the same conflict ID. The server will render the conflict text.
- The answer field is advisory and will not be trusted. Every factual unit must be represented in claims.
- If no Claim supports an answer, treat the verified evidence as insufficient and return {"answer":"","claims":[]}.
- These Claims are a retrieved subset, not the user's full memory store.`;

  let insight = "";
  try {
    insight = await (await createLLM(env)).chat(
      [{ role: "user", content: prompt }],
      { max_tokens: INSIGHT_MAX_TOKENS }
    );
  } catch (e) {
    console.error("synthesizeInsight LLM call failed (non-fatal):", e);
    return { answer: "", verifiedClaims: [], unverifiedClaims: [] };
  }

  let revalidatedClaims = citableClaims;
  if (options.asOf !== undefined && citableClaims.some((claim) => claim.claimId)) {
    const refreshed = await loadRecallConflictContext(
      env.DB,
      context.directEvidence.map((row) => row.id),
      options.asOf
    );
    const refreshedById = new Map<string, {
      statement: string;
      status: string;
      conflictIds: string[];
    }>(
      [...refreshed.claimsByEntry.values()].flat().map((claim) => [claim.id, claim])
    );
    for (const conflict of refreshed.conflicts) {
      for (const claim of conflict.claims) {
        const existing = refreshedById.get(claim.id);
        refreshedById.set(claim.id, {
          statement: claim.statement,
          status: claim.status,
          conflictIds: [...new Set([...(existing?.conflictIds ?? []), conflict.id])],
        });
      }
    }
    revalidatedClaims = citableClaims.flatMap((claim) => {
      if (!claim.claimId) return [];
      const current = refreshedById.get(claim.claimId);
      return current ? [{
        ...claim,
        statement: current.statement,
        status: current.status,
        conflictIds: [...current.conflictIds],
      }] : [];
    });
  }
  return validateStructuredInsightResponse(insight, revalidatedClaims);
}

export async function synthesizeInsight(
  query: string,
  contextInput:
    | InsightContextPackage<RecallClaimContext>
    | InsightEvidenceRow<RecallClaimContext>[],
  env: Env,
  conflicts: RecallConflictContext[] = []
): Promise<string> {
  return (await synthesizeVerifiedInsight(query, contextInput, env, conflicts)).answer;
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

    const result = await captureEntry(
      trimmed,
      ["auto-pattern", "kind:semantic", "status:draft"],
      "system",
      env,
      ctx,
      { skipExtract: true }
    );
    const patternId = captureResultEntryIds(result)[0];
    if (!patternId) return;

    await createMemoryRelations(
      env.DB,
      sample.map(row => ({
        fromMemoryId: patternId,
        toMemoryId: row.id,
        relationType: "derived_from",
        metadata: { automatic: true, derived_type: "pattern" },
      }))
    );
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
  if (!isD1SafeTag(tag) || tag.startsWith(STATUS_PREFIX) || tag.startsWith(KIND_PREFIX)) {
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
  const compressionAsOf = Date.now();
  const { results: rawEntries } = await env.DB.prepare(`
    SELECT id, content, tags, pending_vector_ids, pending_rebuild_id FROM entries
    WHERE tags LIKE ?
      AND tags NOT LIKE '%"synthesized"%'
      AND tags NOT LIKE '%"auto-pattern"%'
      AND tags NOT LIKE '%"rolled-up"%'
      AND ${compressionEligibilitySql()}
      ${activeParentEntryPredicateAt("entries.id", String(compressionAsOf), { requireEvidence: true })}
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(`%"${tag}"%`, Date.now() - COMPRESSION_MIN_AGE_MS).all();

  if (rawEntries.length < 10) {
    return { synthesizedId: null, entriesUsed: 0, text: "" };
  }

  const rows = rawEntries.map(r => ({
    id: r.id as string,
    content: r.content as string,
    tags: parseStoredTags(r.tags),
    pendingVectorIds: r.pending_vector_ids as string | null,
    pendingRebuildId: r.pending_rebuild_id as string | null,
  }));
  const text = await synthesizeDigest(tag, rows, env);
  if (!text) return { synthesizedId: null, entriesUsed: 0, text: "" };

  const content = `[Synthesized from ${rows.length} entries tagged "${tag}"]\n\n${text}`;
  const result = await captureEntry(content, ["synthesized", tag], "system", env, ctx, {
    skipExtract: true,
  });

  const digestId = captureResultEntryIds(result)[0];
  if (!digestId) {
    return { synthesizedId: null, entriesUsed: 0, text };
  }
  try {
    await replaceEntryAtomicMemoryAndEnqueue(env, {
      entryId: digestId,
      content,
      contentHash: await contentFingerprint(content),
      source: "system",
      actor: mutationActorForSource("system"),
      eventType: "update",
      createdAt: Date.now(),
    });
  } catch (error) {
    console.error(`Digest evidence sync failed for tag "${tag}" (non-fatal):`, error);
    return { synthesizedId: null, entriesUsed: 0, text };
  }

  const digestRelations = rows.map(row =>
    prepareMemoryRelation(env.DB, {
      fromMemoryId: digestId,
      toMemoryId: row.id,
      relationType: "digest_of",
      metadata: { automatic: true, derived_type: "digest", tag },
    })
  );

  const rollups = rows.map(row => ({
    row,
    nextTags: row.tags.includes("rolled-up") ? row.tags : [...row.tags, "rolled-up"],
  }));
  const now = Date.now();
  const pendingCleanupStatements = rollups.flatMap(({ row }) =>
    preparePendingGenerationInvalidation(env, {
      pendingVectorIds: row.pendingVectorIds,
      pendingRebuildId: row.pendingRebuildId,
      reason: "rollup_metadata_changed",
      now,
    })
  );
  const rollupRevisions = rollups.map(({ row, nextTags }) =>
    prepareMemoryRevision(env.DB, {
      memoryId: row.id,
      eventType: "ROLLUP",
      oldContent: row.content,
      newContent: row.content,
      oldMetadata: { tags: row.tags },
      newMetadata: { tags: nextTags, digestId },
      reason: `Included in digest for tag ${tag}`,
      actor: "system",
    })
  );
  await env.DB.batch([
    ...digestRelations.map(item => item.statement),
    ...rollups.map(({ row, nextTags }) =>
      env.DB.prepare(
        `UPDATE entries
         SET tags = ?,
             metadata_hash = NULL,
             ${pendingGenerationResetAssignments()}
         WHERE id = ?`
      )
        .bind(JSON.stringify(nextTags), row.id)
    ),
    ...pendingCleanupStatements,
    ...rollupRevisions.map(item => item.statement),
  ]);

  return { synthesizedId: digestId, entriesUsed: rows.length, text };
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
      ${activeParentEntryPredicateAt("entries.id", String(Date.now()), { requireEvidence: true })}
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

  try {
    await processVectorCleanupQueue(env);
  } catch (e) {
    console.error("Vector cleanup queue maintenance failed (non-fatal):", e);
  }

  try {
    const snapshot = await loadActiveEmbeddingSnapshot(env);
    await enqueueMissingClaimVectorJobs(env.DB, {
      targetFingerprint: snapshot.fingerprint,
      limit: env.SELFHOST === "1" ? 100 : 10,
    });
    await processClaimVectorQueue(env, {
      targetFingerprint: snapshot.fingerprint,
    });
  } catch (e) {
    console.error("Claim vector queue maintenance failed (non-fatal):", e);
  }

  try {
    await processExtractionQueue(env, ctx);
  } catch (e) {
    console.error("Extraction queue maintenance failed (non-fatal):", e);
  }

  // Drain due classification work (pending + retryable after backoff + stale version).
  // Without this, retryable_error rows only move if something calls POST /classify-pending.
  try {
    await processClassificationQueue(
      env,
      env.SELFHOST === "1"
        ? CLASSIFICATION_SELFHOST_BATCH_LIMIT
        : CLASSIFICATION_CLOUDFLARE_BATCH_LIMIT
    );
  } catch (e) {
    console.error("Classification queue maintenance failed (non-fatal):", e);
  }

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
  claimId?: string;
  parentVersionId?: string | null;
  snapshotAt?: number;
  content: string;
  score: number;
  createdAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
  scoreDetails?: RecallScoreDetails;
  matchedEntities?: string[];
  graphFacts?: string[];
  timeBasis?: TemporalEvidence;
  claims?: RecallClaimContext[];
  association?: {
    hop: number;
    viaType: AssociationEdgeType;
    viaWeight: number;
    seedParentId: string;
  };
}

export interface RecallSearchResult {
  matches: RecallMatch[];
  directEvidence?: RecallMatch[];
  relatedContext?: RecallMatch[];
  insight: string;
  retrievalMode?: "entry_projection" | "claim_snapshot";
  snapshotAt?: number;
  verifiedClaims?: VerifiedInsightResult["verifiedClaims"];
  unverifiedClaims?: VerifiedInsightResult["unverifiedClaims"];
  conflicts?: RecallConflictContext[];
  degraded?: boolean;
  degradedReason?: string;
}

// ─── Hybrid recall: keyword search + Reciprocal Rank Fusion ────────────────────

interface KeywordRow { id: string; content: string; tags: string; source: string; created_at: number; }

function activeParentEntryPredicate(entryRef: string): string {
  return activeParentEntryPredicateAt(entryRef, String(Date.now()));
}

function activeParentEntryPredicateAt(
  entryRef: string,
  asOfExpression: string,
  options: { requireEvidence?: boolean } = {}
): string {
  const compatEmptyEntry = options.requireEvidence
    ? ""
    : `NOT EXISTS (
      SELECT 1
      FROM sb_memories m_any
      WHERE m_any.entry_id = ${entryRef}
    )
    OR`;
  return `AND (
    ${compatEmptyEntry} EXISTS (
      SELECT 1
      FROM sb_memories m_active
      WHERE m_active.entry_id = ${entryRef}
        AND m_active.content_hash IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM entries e_active_projection
          WHERE e_active_projection.id = ${entryRef}
            AND e_active_projection.content_hash = m_active.content_hash
        )
        AND ${activeMemoryClaimPredicate("m_active", asOfExpression)}
    )
  )`;
}

export interface RecallScoreDetails {
  semantic?: number;
  keyword?: number;
  entity?: number;
  temporal?: number;
  relation?: number;
  importance?: number;
  confidence?: number;
  final?: number;
}

interface GraphRecallSignal {
  parentId: string;
  boost: number;
  createdAt: number;
  entity: number;
  temporal: number;
  temporalEvidence: TemporalEvidence;
  temporalAnchorsHistory: boolean;
  relation: number;
  entityNames: string[];
  facts: string[];
  signalKeys: Set<string>;
}

type TemporalEvidence =
  | "explicit_window"
  | "explicit_start"
  | "explicit_end"
  | "reference_time"
  | "inferred_current"
  | "none";

interface TemporalAssessment {
  score: number;
  evidence: TemporalEvidence;
  anchorsHistory: boolean;
}

const TEMPORAL_EVIDENCE_RANK: Record<TemporalEvidence, number> = {
  none: 0,
  inferred_current: 1,
  explicit_end: 2,
  reference_time: 3,
  explicit_start: 4,
  explicit_window: 5,
};

const GRAPH_ENTITY_MATCH_LIMIT = 8;
const GRAPH_ENTITY_MATCH_CANDIDATE_LIMIT = 80;
const GRAPH_DIRECT_MEMORY_LIMIT = 100;
const GRAPH_RELATION_MEMORY_LIMIT = 100;
const GRAPH_DIRECT_BASE_BOOST = 0.026;
const GRAPH_RELATION_BASE_BOOST = 0.014;
const GRAPH_TEMPORAL_BASE_BOOST = 0.008;
const GRAPH_TOTAL_BOOST_MAX = 0.08;

function clamp01(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function mergeScoreDetails(
  existing: unknown,
  patch: Partial<RecallScoreDetails>
): RecallScoreDetails {
  const base = existing && typeof existing === "object" ? existing as RecallScoreDetails : {};
  const next: RecallScoreDetails = { ...base };
  for (const [key, value] of Object.entries(patch) as [keyof RecallScoreDetails, number | undefined][]) {
    if (value == null || !Number.isFinite(value)) continue;
    next[key] = Math.max(Number(next[key] ?? 0), value);
  }
  return next;
}

function roundScoreDetails(details: RecallScoreDetails | undefined): RecallScoreDetails | undefined {
  if (!details) return undefined;
  const out: RecallScoreDetails = {};
  for (const [key, value] of Object.entries(details) as [keyof RecallScoreDetails, number | undefined][]) {
    if (value == null || !Number.isFinite(value)) continue;
    out[key] = Number(value.toFixed(4));
  }
  return Object.keys(out).length ? out : undefined;
}

function finiteTime(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function activeAt(row: { valid_from?: unknown; valid_to?: unknown; invalid_at?: unknown; expired_at?: unknown }, asOf: number): boolean {
  const invalidAt = finiteTime(row.invalid_at);
  const expiredAt = finiteTime(row.expired_at);
  if (invalidAt != null && invalidAt <= asOf) return false;
  if (expiredAt != null && expiredAt <= asOf) return false;
  const validFrom = finiteTime(row.valid_from);
  const validTo = finiteTime(row.valid_to);
  return (validFrom == null || validFrom <= asOf) && (validTo == null || validTo > asOf);
}

function temporalScoreAt(
  row: { valid_from?: unknown; valid_to?: unknown; invalid_at?: unknown; expired_at?: unknown; reference_time?: unknown },
  asOf: number
): number {
  return temporalAssessmentAt(row, asOf).score;
}

function temporalAssessmentAt(
  row: { valid_from?: unknown; valid_to?: unknown; invalid_at?: unknown; expired_at?: unknown; reference_time?: unknown },
  asOf: number
): TemporalAssessment {
  if (!activeAt(row, asOf)) {
    return { score: 0, evidence: "none", anchorsHistory: false };
  }
  const hasFrom = row.valid_from != null && Number.isFinite(Number(row.valid_from));
  const hasTo = row.valid_to != null && Number.isFinite(Number(row.valid_to));
  const referenceTime = row.reference_time == null ? null : Number(row.reference_time);
  const hasReference = referenceTime != null && Number.isFinite(referenceTime);
  if (hasFrom && hasTo) {
    return { score: 1, evidence: "explicit_window", anchorsHistory: true };
  }
  if (hasFrom) {
    return { score: 0.8, evidence: "explicit_start", anchorsHistory: true };
  }
  if (hasReference && referenceTime <= asOf) {
    return { score: 0.8, evidence: "reference_time", anchorsHistory: true };
  }
  if (hasTo) {
    return { score: 0.8, evidence: "explicit_end", anchorsHistory: false };
  }
  return { score: 0.6, evidence: "inferred_current", anchorsHistory: false };
}

function parseEntityAliases(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return String((item as any).name ?? (item as any).text ?? "");
        return "";
      })
      .map(normalizeEntityName)
      .filter((alias) => alias.length >= 2);
  } catch {
    return [];
  }
}

function hasHanScript(text: string): boolean {
  return /[\p{Script=Han}]/u.test(text);
}

function isAsciiWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_]/.test(char);
}

export function entityNameMatchesQuery(normalizedQuery: string, normalizedName: string): boolean {
  if (normalizedName.length < 2) return false;
  if (!normalizedQuery.includes(normalizedName)) return false;
  if (hasHanScript(normalizedName)) return true;

  let index = normalizedQuery.indexOf(normalizedName);
  while (index >= 0) {
    const before = normalizedQuery[index - 1];
    const after = normalizedQuery[index + normalizedName.length];
    if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) return true;
    index = normalizedQuery.indexOf(normalizedName, index + 1);
  }
  return false;
}

function graphFactSignalKey(row: Record<string, unknown>): string {
  return [
    "relation",
    String(row.entry_id ?? ""),
    String(row.from_entity_id ?? ""),
    String(row.to_entity_id ?? ""),
    String(row.relation_type ?? ""),
    normalizeEntityFactKey(typeof row.fact === "string" ? row.fact : null),
  ].join(":");
}

function addGraphSignal(
  signals: Map<string, GraphRecallSignal>,
  input: {
    parentId: string;
    signalKey: string;
    boost: number;
    createdAt: number;
    entity?: number;
    temporal?: number;
    temporalEvidence?: TemporalEvidence;
    temporalAnchorsHistory?: boolean;
    relation?: number;
    entityNames?: string[];
    fact?: string | null;
  }
): void {
  if (!input.parentId) return;
  const current = signals.get(input.parentId) ?? {
    parentId: input.parentId,
    boost: 0,
    createdAt: input.createdAt,
    entity: 0,
    temporal: 0,
    temporalEvidence: "none" as TemporalEvidence,
    temporalAnchorsHistory: false,
    relation: 0,
    entityNames: [],
    facts: [],
    signalKeys: new Set<string>(),
  };
  const isNewSignal = !current.signalKeys.has(input.signalKey);
  current.signalKeys.add(input.signalKey);
  if (isNewSignal) {
    current.boost = Math.min(
      GRAPH_TOTAL_BOOST_MAX,
      Math.max(current.boost, 0) + Math.max(0, input.boost)
    );
  }
  current.createdAt = Math.max(current.createdAt, input.createdAt || 0);
  current.entity = Math.max(current.entity, input.entity ?? 0);
  current.temporal = Math.max(current.temporal, input.temporal ?? 0);
  if (
    input.temporalEvidence &&
    TEMPORAL_EVIDENCE_RANK[input.temporalEvidence] >
      TEMPORAL_EVIDENCE_RANK[current.temporalEvidence]
  ) {
    current.temporalEvidence = input.temporalEvidence;
  }
  current.temporalAnchorsHistory =
    current.temporalAnchorsHistory || input.temporalAnchorsHistory === true;
  current.relation = Math.max(current.relation, input.relation ?? 0);
  for (const name of input.entityNames ?? []) {
    if (name && !current.entityNames.includes(name)) current.entityNames.push(name);
  }
  if (input.fact && !current.facts.includes(input.fact)) current.facts.push(input.fact);
  signals.set(input.parentId, current);
}

// Split a query into lexical search tokens: lowercase, strip surrounding punctuation,
// drop stopwords / 1-char tokens, and remove SQL LIKE wildcards so each token is a literal
// substring. Identifier-shaped tokens (e.g. "v1.9", "#149") are preserved intact.
export function tokenizeQuery(query: string): string[] {
  const tokens = new Set<string>();
  const segmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh-CN", { granularity: "word" })
    : null;
  const addToken = (raw: string): void => {
    const token = raw
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}#.]+|[^\p{L}\p{N}#.]+$/gu, "")
      .replace(/[%_]/g, "");
    const utf8Bytes = new TextEncoder().encode(token).byteLength;
    if (
      token.length >= KEYWORD_MIN_TOKEN_LEN &&
      utf8Bytes <= KEYWORD_MAX_LIKE_TOKEN_BYTES &&
      !KEYWORD_STOPWORDS.has(token)
    ) {
      tokens.add(token);
    }
  };

  for (const raw of query.slice(0, KEYWORD_MAX_QUERY_CHARS).split(/\s+/)) {
    if (tokens.size >= KEYWORD_MAX_TOKENS) break;
    addToken(raw);
    if (!/[\p{Script=Han}]/u.test(raw) || !segmenter) continue;
    for (const segment of segmenter.segment(raw)) {
      if (tokens.size >= KEYWORD_MAX_TOKENS) break;
      if (segment.isWordLike) addToken(segment.segment);
    }
  }
  return [...tokens];
}

// Keyword candidates: entries whose content contains any query token, bounded by
// KEYWORD_CANDIDATE_LIMIT. Relevance ranking happens in fuseDenseAndKeyword.
async function keywordSearch(tokens: string[], env: Env, asOf: number): Promise<KeywordRow[]> {
  if (!tokens.length) return [];
  const where = tokens.map(() => "content LIKE ?").join(" OR ");
  const { results } = await env.DB.prepare(
    `SELECT id, content, tags, source, created_at FROM entries
     WHERE (${where})
       AND tags NOT LIKE '%"status:deprecated"%'
       AND tags NOT LIKE '%"auto-pattern"%'
       ${activeParentEntryPredicateAt("entries.id", String(asOf), { requireEvidence: true })}
     ORDER BY created_at DESC LIMIT ?`
  ).bind(...tokens.map(t => `%${t}%`), KEYWORD_CANDIDATE_LIMIT).all();
  return results as unknown as KeywordRow[];
}

async function lexicalVectorRows(
  vectorIds: string[],
  env: Env,
  asOf: number
): Promise<KeywordRow[]> {
  if (!vectorIds.length) return [];
  const vectors: VectorizeVector[] = [];
  for (let i = 0; i < vectorIds.length; i += VECTORIZE_GET_BY_IDS_BATCH) {
    vectors.push(...await env.VECTORIZE.getByIds(vectorIds.slice(i, i + VECTORIZE_GET_BY_IDS_BATCH)));
  }
  const orderedPairs = vectors.map((vector) => ({
    vectorId: vector.id,
    parentId: String((vector.metadata as any)?.parentId ?? vector.id),
  })).filter((pair) => pair.vectorId && pair.parentId);
  const orderedParentIds = [...new Set(orderedPairs.map((pair) => pair.parentId))];
  if (!orderedParentIds.length) return [];
  const byId = new Map<string, KeywordRow & { vector_ids?: string }>();
  for (let i = 0; i < orderedParentIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = orderedParentIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, content, tags, source, created_at, vector_ids
       FROM entries
       WHERE id IN (${placeholders})
         AND tags NOT LIKE '%"status:deprecated"%'
         AND tags NOT LIKE '%"auto-pattern"%'
         ${activeParentEntryPredicateAt("entries.id", String(asOf), { requireEvidence: true })}`
    ).bind(...batch).all<KeywordRow & { vector_ids?: string }>();
    for (const row of results ?? []) byId.set(row.id, row);
  }
  const rows: KeywordRow[] = [];
  const seenParents = new Set<string>();
  for (const pair of orderedPairs) {
    if (seenParents.has(pair.parentId)) continue;
    const row = byId.get(pair.parentId);
    if (!row) continue;
    if (!parseVectorIds(row.vector_ids).includes(pair.vectorId)) continue;
    seenParents.add(pair.parentId);
    rows.push({
      id: row.id,
      content: row.content,
      tags: row.tags,
      source: row.source,
      created_at: row.created_at,
    });
  }
  return rows;
}

async function buildGraphRecallSignals(
  query: string,
  env: Env,
  asOf: number,
  options: { claimSnapshot?: boolean } = {}
): Promise<Map<string, GraphRecallSignal>> {
  const normalizedQuery = normalizeEntityName(query);
  if (normalizedQuery.length < 2) return new Map();

  const aliasTokens = [...new Set(
    [normalizedQuery, ...tokenizeQuery(query).map(normalizeEntityName)]
      .filter((token) => token.length >= 2)
      .slice(0, 12)
  )];
  const aliasWhere = aliasTokens.map(() => "aliases_json LIKE ?").join(" OR ");
  const { results: entityCandidateRows } = await env.DB.prepare(
    `SELECT id, name, name_normalized, entity_type, aliases_json, mention_count, updated_at
     FROM sb_entities
     WHERE length(name_normalized) >= 2
       AND (instr(?, name_normalized) > 0${aliasWhere ? ` OR ${aliasWhere}` : ""})
     ORDER BY length(name_normalized) DESC, mention_count DESC, updated_at DESC
     LIMIT ?`
  ).bind(
    normalizedQuery,
    ...aliasTokens.map((token) => `%${token}%`),
    GRAPH_ENTITY_MATCH_CANDIDATE_LIMIT
  ).all() as {
    results: Array<{
      id: string;
      name: string;
      name_normalized: string;
      entity_type: string | null;
      aliases_json?: string | null;
      mention_count: number;
      updated_at: number;
    }>;
  };

  const entityRows = (entityCandidateRows ?? [])
    .map((row) => {
      const names = [row.name_normalized, ...parseEntityAliases(row.aliases_json)];
      const matchedName = names.find((name) => entityNameMatchesQuery(normalizedQuery, name));
      return matchedName ? { ...row, matchedName } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) =>
      String(b.matchedName ?? "").length - String(a.matchedName ?? "").length ||
      Number(b.mention_count ?? 0) - Number(a.mention_count ?? 0) ||
      Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0)
    )
    .slice(0, GRAPH_ENTITY_MATCH_LIMIT);

  const entityIds = [...new Set((entityRows ?? []).map((row) => row.id).filter(Boolean))];
  if (!entityIds.length) return new Map();

  const signals = new Map<string, GraphRecallSignal>();
  const placeholders = entityIds.map(() => "?").join(", ");

  const { results: directRows } = await env.DB.prepare(
    `SELECT m.entry_id, m.id AS memory_id, m.created_at, m.valid_from, m.valid_to,
            m.reference_time,
            m.invalid_at, m.expired_at, m.importance, m.confidence,
            me.entity_id, me.score AS entity_score, e.name AS entity_name
     FROM sb_memory_entities me
     JOIN sb_memories m ON m.id = me.memory_id
     ${options.claimSnapshot ? "" : `JOIN entries en_graph
       ON en_graph.id = m.entry_id
      AND en_graph.content_hash = m.content_hash`}
     JOIN sb_entities e ON e.id = me.entity_id
     WHERE me.entity_id IN (${placeholders})
       AND m.entry_id IS NOT NULL
       AND m.content_hash IS NOT NULL
       AND (m.invalid_at IS NULL OR m.invalid_at > ?)
       AND (m.expired_at IS NULL OR m.expired_at > ?)
       AND (m.valid_from IS NULL OR m.valid_from <= ?)
       AND (m.valid_to IS NULL OR m.valid_to > ?)
       AND ${activeMemoryClaimPredicate("m", String(asOf), { requireActiveParentLink: true })}
     ORDER BY COALESCE(me.score, 0) DESC, m.created_at DESC
     LIMIT ?`
  ).bind(...entityIds, asOf, asOf, asOf, asOf, GRAPH_DIRECT_MEMORY_LIMIT).all() as {
    results: Array<Record<string, unknown>>;
  };

  for (const row of directRows ?? []) {
    if (!activeAt(row, asOf)) continue;
    const parentId = String(row.entry_id ?? "");
    if (!parentId) continue;
    const entityScore = clamp01(row.entity_score ?? 0.75);
    const temporal = temporalAssessmentAt(row, asOf);
    addGraphSignal(signals, {
      parentId,
      signalKey: ["entity", parentId, String(row.memory_id ?? ""), String(row.entity_id ?? "")].join(":"),
      boost: GRAPH_DIRECT_BASE_BOOST * Math.max(0.65, entityScore) + GRAPH_TEMPORAL_BASE_BOOST,
      createdAt: Number(row.created_at ?? 0),
      entity: entityScore || 0.75,
      temporal: temporal.score,
      temporalEvidence: temporal.evidence,
      temporalAnchorsHistory: temporal.anchorsHistory,
      entityNames: [String(row.entity_name ?? "")].filter(Boolean),
    });
  }

  const relationWhere = entityIds.map(() => "?").join(", ");
  const { results: relationRows } = await env.DB.prepare(
    `SELECT m.entry_id, m.created_at AS memory_created_at,
            r.memory_id, r.from_entity_id, r.to_entity_id, r.relation_type, r.fact, r.score,
            r.valid_from, r.valid_to, r.invalid_at, r.expired_at,
            COALESCE(r.reference_time, m.reference_time) AS reference_time,
            fe.name AS from_name, te.name AS to_name
     FROM sb_entity_relations r
     LEFT JOIN sb_fact_sources rfs ON rfs.relation_id = r.id
     JOIN sb_memories m ON m.id = COALESCE(rfs.memory_id, r.memory_id)
     ${options.claimSnapshot ? "" : `JOIN entries en_graph
       ON en_graph.id = m.entry_id
      AND en_graph.content_hash = m.content_hash`}
     JOIN sb_entities fe ON fe.id = r.from_entity_id
     JOIN sb_entities te ON te.id = r.to_entity_id
     WHERE (r.from_entity_id IN (${relationWhere}) OR r.to_entity_id IN (${relationWhere}))
       AND (r.invalid_at IS NULL OR r.invalid_at > ?)
       AND (r.expired_at IS NULL OR r.expired_at > ?)
       AND (r.valid_from IS NULL OR r.valid_from <= ?)
       AND (r.valid_to IS NULL OR r.valid_to > ?)
       AND COALESCE(r.resolution_state, 'active') = 'active'
       AND m.entry_id IS NOT NULL
       AND m.content_hash IS NOT NULL
       AND (m.invalid_at IS NULL OR m.invalid_at > ?)
       AND (m.expired_at IS NULL OR m.expired_at > ?)
       AND ${activeMemoryClaimPredicate("m", String(asOf), { requireActiveParentLink: true })}
     ORDER BY COALESCE(r.score, 0) DESC, r.created_at DESC
     LIMIT ?`
  ).bind(
    ...entityIds,
    ...entityIds,
    asOf,
    asOf,
    asOf,
    asOf,
    asOf,
    asOf,
    GRAPH_RELATION_MEMORY_LIMIT
  ).all() as {
    results: Array<Record<string, unknown>>;
  };

  for (const row of relationRows ?? []) {
    if (!activeAt(row, asOf)) continue;
    const parentId = String(row.entry_id ?? "");
    if (!parentId) continue;
    const relationScore = clamp01(row.score ?? 0.6);
    const temporal = temporalAssessmentAt(row, asOf);
    addGraphSignal(signals, {
      parentId,
      signalKey: graphFactSignalKey(row),
      boost: GRAPH_RELATION_BASE_BOOST * Math.max(0.5, relationScore) + GRAPH_TEMPORAL_BASE_BOOST,
      createdAt: Number(row.memory_created_at ?? 0),
      relation: relationScore || 0.6,
      temporal: temporal.score,
      temporalEvidence: temporal.evidence,
      temporalAnchorsHistory: temporal.anchorsHistory,
      entityNames: [String(row.from_name ?? ""), String(row.to_name ?? "")].filter(Boolean),
      fact: typeof row.fact === "string" ? row.fact.slice(0, 300) : null,
    });
  }

  return signals;
}

function applyGraphRecallSignals(
  matches: VectorizeMatch[],
  signals: Map<string, GraphRecallSignal>,
  allowGraphOnly: boolean
): VectorizeMatch[] {
  if (!signals.size) return matches;

  const out: VectorizeMatch[] = matches.map((match) => {
    const meta = match.metadata as Record<string, unknown> | undefined;
    const parentId = String(meta?.parentId ?? match.id);
    const signal = signals.get(parentId);
    if (!signal) return match;
    const nextMeta = {
      ...(meta ?? {}),
      parentId,
      score_details: mergeScoreDetails(meta?.score_details, {
        entity: signal.entity,
        temporal: signal.temporal,
        relation: signal.relation,
      }),
      graph_entities: signal.entityNames.slice(0, 8),
      graph_facts: signal.facts.slice(0, 5),
      graph_temporal_evidence: signal.temporalEvidence,
      graph_temporal_anchors_history: signal.temporalAnchorsHistory,
    };
    return {
      ...match,
      score: match.score + signal.boost,
      metadata: nextMeta,
    };
  });

  if (!allowGraphOnly) return out;

  const present = new Set(out.map((match) => String((match.metadata as any)?.parentId ?? match.id)));
  for (const signal of signals.values()) {
    if (present.has(signal.parentId)) continue;
    out.push({
      id: signal.parentId,
      score: signal.boost,
      metadata: {
        parentId: signal.parentId,
        created_at: signal.createdAt,
        tags: [],
        score_details: mergeScoreDetails(undefined, {
          semantic: 0,
          keyword: 0,
          entity: signal.entity,
          temporal: signal.temporal,
          relation: signal.relation,
        }),
        graph_entities: signal.entityNames.slice(0, 8),
        graph_facts: signal.facts.slice(0, 5),
        graph_temporal_evidence: signal.temporalEvidence,
        graph_temporal_anchors_history: signal.temporalAnchorsHistory,
      },
    });
  }

  return out;
}

// Reciprocal Rank Fusion. Dense candidates contribute 1/(k+rank); keyword candidates
// contribute weight/(k+rank), where weight = number of distinct query tokens the entry
// matched — so an exact multi-token/identifier hit outweighs entries that merely share a
// common word, and an entry present in BOTH lists accumulates from both.
export function rrfFuse(
  denseRanked: string[],
  keywordRanked: { id: string; weight: number }[],
  lexicalRanked: string[] = [],
  k = RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();
  denseRanked.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i)));
  keywordRanked.forEach((e, i) => scores.set(e.id, (scores.get(e.id) ?? 0) + e.weight / (k + i)));
  lexicalRanked.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i)));
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
  allowKeywordOnly: boolean,
  lexicalRows: KeywordRow[] = []
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
  const lexicalRanked = lexicalRows
    .filter(row => allowKeywordOnly || denseByParent.has(row.id))
    .map(row => row.id);

  const fused = rrfFuse(
    denseRanked,
    keywordRanked.map(x => ({ id: x.row.id, weight: x.weight })),
    lexicalRanked
  );
  const keywordRowById = new Map([...lexicalRows, ...keywordRows].map(r => [r.id, r]));
  const keywordWeightById = new Map(keywordRanked.map(x => [x.row.id, x.weight]));
  const lexicalSet = new Set(lexicalRanked);
  const keywordDenominator = Math.max(1, tokens.length);

  const out: VectorizeMatch[] = [];
  for (const [pid, score] of fused) {
    const dm = denseByParent.get(pid);
    const keywordScore = Math.min(
      1,
      ((keywordWeightById.get(pid) ?? 0) / keywordDenominator) +
        (lexicalSet.has(pid) ? 0.5 : 0)
    );
    if (dm) {
      const meta = (dm.metadata ?? {}) as Record<string, unknown>;
      out.push({
        id: dm.id,
        score,
        metadata: {
          ...meta,
          parentId: pid,
          score_details: mergeScoreDetails(meta.score_details, {
            semantic: clamp01(dm.score),
            keyword: keywordScore,
          }),
        },
      });
    } else {
      const r = keywordRowById.get(pid)!;
      out.push({
        id: pid,
        score,
        metadata: {
          parentId: pid,
          created_at: r.created_at,
          tags: JSON.parse(r.tags ?? "[]"),
          content: r.content,
          source: r.source,
          score_details: mergeScoreDetails(undefined, {
            semantic: 0,
            keyword: keywordScore,
          }),
        },
      });
    }
  }
  return out;
}

const CLAIM_VECTOR_SOURCE = "singularity-claim";

interface ClaimSnapshotRow {
  id: string;
  entry_id: string;
  parent_version_id: string | null;
  content: string;
  content_hash: string;
  kind: string | null;
  importance: number | null;
  confidence: number | null;
  claim_status: string;
  created_at: number;
  tags: string | null;
  source: string | null;
}

async function indexClaimSnapshotVector(
  env: Env,
  input: {
    claimId: string;
    entryId: string;
    parentVersionId: string | null;
    content: string;
    contentHash: string;
    createdAt: number;
  },
  snapshot?: ActiveEmbeddingSnapshot
): Promise<void> {
  const active = snapshot ?? await loadActiveEmbeddingSnapshot(env);
  const existing = await env.DB.prepare(
    `SELECT content_hash, vector_ids_json
     FROM sb_claim_vectors
     WHERE claim_id = ? AND embedding_fingerprint = ?`
  ).bind(input.claimId, active.fingerprint).first<{
    content_hash: string;
    vector_ids_json: string;
  }>();
  if (existing?.content_hash === input.contentHash) return;
  const replacedVectorIds = existing ? parseVectorIds(existing.vector_ids_json) : [];

  const prepared = await prepareEntryVectors(
    env,
    input.claimId,
    input.content,
    [],
    CLAIM_VECTOR_SOURCE,
    input.createdAt,
    crypto.randomUUID(),
    active.fingerprint,
    "active",
    undefined,
    active.provider
  );
  const claimVectors: PreparedEntryVectors = {
    vectorIds: [...prepared.vectorIds],
    vectors: prepared.vectors.map((vector) => ({
      ...vector,
      metadata: {
        ...vector.metadata,
        source: CLAIM_VECTOR_SOURCE,
        parentId: input.claimId,
        claimId: input.claimId,
        entryId: input.entryId,
        parentVersionId: input.parentVersionId,
        content_hash: input.contentHash,
      },
    })),
  };
  await insertPreparedVectors(env, claimVectors);
  try {
    const mappingWrite = await env.DB.prepare(
      `INSERT INTO sb_claim_vectors (
         claim_id, embedding_fingerprint, parent_version_id,
         content_hash, vector_ids_json, indexed_at
       )
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM sb_memories
         WHERE id = ? AND content_hash = ?
       )
       ON CONFLICT(claim_id, embedding_fingerprint) DO UPDATE SET
         parent_version_id = excluded.parent_version_id,
         content_hash = excluded.content_hash,
         vector_ids_json = excluded.vector_ids_json,
         indexed_at = excluded.indexed_at`
    ).bind(
      input.claimId,
      active.fingerprint,
      input.parentVersionId,
      input.contentHash,
      JSON.stringify(claimVectors.vectorIds),
      Date.now(),
      input.claimId,
      input.contentHash
    ).run();
    if (Number(mappingWrite.meta?.changes ?? 0) !== 1) {
      await cleanupPreparedVectors(env, claimVectors.vectorIds, "Stale Claim vector mapping");
    } else if (replacedVectorIds.length) {
      await cleanupPreparedVectors(env, replacedVectorIds, "Replaced Claim vector mapping");
    }
  } catch (error) {
    await cleanupPreparedVectors(env, claimVectors.vectorIds, "Claim vector mapping write");
    throw error;
  }
}

async function processClaimVectorQueue(
  env: Env,
  input: {
    targetFingerprint?: string;
    rebuildId?: string | null;
    limit?: number;
  } = {}
) {
  const snapshots = new Map<string, Promise<ActiveEmbeddingSnapshot>>();
  return processClaimVectorJobs(env.DB, {
    targetFingerprint: input.targetFingerprint,
    rebuildId: input.rebuildId,
    limit: input.limit ?? (env.SELFHOST === "1" ? 25 : 3),
    index: async (job) => {
      let snapshot = snapshots.get(job.targetFingerprint);
      if (!snapshot) {
        snapshot = loadEmbeddingSnapshotForFingerprint(env, job.targetFingerprint);
        snapshots.set(job.targetFingerprint, snapshot);
      }
      await indexClaimSnapshotVector(env, {
        claimId: job.claimId,
        entryId: job.entryId,
        parentVersionId: job.parentVersionId,
        content: job.content,
        contentHash: job.contentHash,
        createdAt: job.createdAt,
      }, await snapshot);
    },
  });
}

async function replaceEntryAtomicMemoryAndEnqueue(
  env: Env,
  input: Parameters<typeof replaceEntryAtomicMemory>[1]
): Promise<Awaited<ReturnType<typeof replaceEntryAtomicMemory>> & {
  claimVectorQueued: boolean;
  warnings: string[];
}> {
  return commitAtomicMutationWithProjection(
    () => replaceEntryAtomicMemory(env.DB, input),
    async (claimId) => {
      const snapshot = await loadActiveEmbeddingSnapshot(env);
      return enqueueClaimVectorJob(env.DB, {
        claimId,
        targetFingerprint: snapshot.fingerprint,
      });
    },
    (error) => console.error("Claim vector enqueue failed after committed Atomic mutation:", error)
  );
}

async function queryHistoricalClaimVectors(
  env: Env,
  vector: number[],
  fingerprint: string,
  queryText: string
): Promise<{
  scores: Map<string, number>;
  degraded: boolean;
  degradedReason?: "vector_metadata_filter_unavailable" | "vector_source_index_missing";
}> {
  let matches: VectorizeMatch[] = [];
  let degraded = false;
  try {
    const options = {
      topK: 50,
      returnMetadata: "all" as const,
      filter: { embedding_fingerprint: fingerprint, source: CLAIM_VECTOR_SOURCE },
    };
    const result = env.SELFHOST === "1"
      ? await (env.VECTORIZE as any).query(vector, { ...options, queryText })
      : await env.VECTORIZE.query(vector, options);
    matches = result.matches as VectorizeMatch[];
  } catch (error) {
    degraded = true;
    if (isVectorSourceMetadataIndexError(error)) {
      console.error("Claim vector source metadata index is unavailable; using keyword recall:", error);
      return {
        scores: new Map<string, number>(),
        degraded: true,
        degradedReason: "vector_source_index_missing",
      };
    }
    console.error("Claim vector metadata filtering failed; using keyword recall:", error);
    return {
      scores: new Map<string, number>(),
      degraded: true,
      degradedReason: "vector_metadata_filter_unavailable",
    };
  }
  const claimIds = [...new Set(matches.map((match) =>
    String((match.metadata as Record<string, unknown> | undefined)?.claimId ?? "")
  ).filter(Boolean))];
  const mappings = new Map<string, Set<string>>();
  for (let offset = 0; offset < claimIds.length; offset += D1_MAX_BOUND_PARAMS) {
    const batch = claimIds.slice(offset, offset + D1_MAX_BOUND_PARAMS);
    const placeholders = batch.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT claim_id, vector_ids_json
       FROM sb_claim_vectors
       WHERE embedding_fingerprint = ? AND claim_id IN (${placeholders})`
    ).bind(fingerprint, ...batch).all<{ claim_id: string; vector_ids_json: string }>();
    for (const row of results ?? []) mappings.set(row.claim_id, new Set(parseVectorIds(row.vector_ids_json)));
  }
  const scores = new Map<string, number>();
  for (const match of matches) {
    const claimId = String((match.metadata as Record<string, unknown> | undefined)?.claimId ?? "");
    if (!claimId || mappings.get(claimId)?.has(match.id) !== true) continue;
    scores.set(claimId, Math.max(scores.get(claimId) ?? 0, Number(match.score ?? 0)));
  }
  return {
    scores,
    degraded,
    degradedReason: degraded ? "vector_metadata_filter_unavailable" : undefined,
  };
}

async function recallHistoricalClaims(
  params: {
    query: string;
    topK: number;
    tag?: string;
    after?: number;
    before: number;
    kind?: MemoryKind;
  },
  env: Env,
  ctx: ExecutionContext,
  vaultFilter: string | null,
  runtimeOptions: { recordUsage?: boolean; allowClaimVectorBackfill?: boolean }
): Promise<RecallSearchResult> {
  const tokens = tokenizeQuery(params.query);
  const graphSignals = await buildGraphRecallSignals(
    params.query,
    env,
    params.before,
    { claimSnapshot: true }
  ).catch((error) => {
    console.error("Historical graph recall signals failed (non-fatal):", error);
    return new Map<string, GraphRecallSignal>();
  });
  const graphEntryIds = [...graphSignals.keys()];
  let snapshot: ActiveEmbeddingSnapshot | null = null;
  let semanticScores = new Map<string, number>();
  let degraded = false;
  let degradedReason: string | undefined;
  try {
    snapshot = await loadActiveEmbeddingSnapshot(env);
    const queryVector = await embedWithProvider(snapshot.provider, params.query, "query");
    const queried = await queryHistoricalClaimVectors(
      env,
      queryVector,
      snapshot.fingerprint,
      params.query
    );
    semanticScores = queried.scores;
    degraded = queried.degraded;
    degradedReason = queried.degradedReason;
  } catch (error) {
    degraded = true;
    degradedReason = "embedding_failed";
    console.error("Historical Claim vector recall failed; using immutable keyword recall:", error);
  }

  const semanticClaimIds = [...semanticScores.keys()];
  const lexicalClauses = tokens.map(() => "m.content LIKE ?");
  const candidateClauses = [...lexicalClauses];
  if (semanticClaimIds.length) {
    candidateClauses.push(`m.id IN (${semanticClaimIds.map(() => "?").join(", ")})`);
  }
  if (graphEntryIds.length) {
    candidateClauses.push(`m.entry_id IN (${graphEntryIds.map(() => "?").join(", ")})`);
  }
  if (!candidateClauses.length) return {
    matches: [],
    directEvidence: [],
    relatedContext: [],
    insight: "",
    conflicts: [],
    degraded,
    degradedReason,
  };
  const bindings: Array<string | number> = [
    ...tokens.map((token) => `%${token}%`),
    ...semanticClaimIds,
    ...graphEntryIds,
  ];
  const snapshotAsOf = String(Math.max(0, Math.trunc(params.before)));
  let sql = `SELECT
      m.id, m.entry_id,
      COALESCE(pv_snapshot.version_id, m.parent_version_id) AS parent_version_id,
      m.content, m.content_hash,
      m.kind, m.importance, m.confidence, m.claim_status,
      COALESCE(m.observed_at, m.created_at) AS created_at,
      CASE
        WHEN pv_snapshot.metadata_snapshot_hash IS NOT NULL THEN pv_snapshot.tags_snapshot_json
        ELSE e.tags
      END AS tags,
      CASE
        WHEN pv_snapshot.metadata_snapshot_hash IS NOT NULL THEN
          COALESCE(pv_snapshot.source_snapshot, o.source_channel, o.source, 'claim')
        ELSE COALESCE(e.source, o.source_channel, o.source, 'claim')
      END AS source
    FROM sb_memories m
    LEFT JOIN entries e ON e.id = m.entry_id
    LEFT JOIN sb_parent_versions pv_snapshot ON pv_snapshot.version_id = (
      SELECT pvc_snapshot.parent_version_id
      FROM sb_parent_version_claims pvc_snapshot
      JOIN sb_parent_versions pv_candidate
        ON pv_candidate.version_id = pvc_snapshot.parent_version_id
      WHERE pvc_snapshot.memory_id = m.id
        AND pvc_snapshot.relation = 'supports'
        AND COALESCE(pv_candidate.activated_at, pv_candidate.created_at) <= ${snapshotAsOf}
        AND (
          pv_candidate.superseded_at IS NULL
          OR pv_candidate.superseded_at > ${snapshotAsOf}
        )
        AND pv_candidate.state IN ('active', 'active_degraded', 'superseded')
      ORDER BY pv_candidate.version_number DESC, pv_candidate.version_id DESC
      LIMIT 1
    )
    LEFT JOIN sb_memory_sources ms ON ms.id = (
      SELECT ms_first.id FROM sb_memory_sources ms_first
      WHERE ms_first.memory_id = m.id
      ORDER BY ms_first.created_at ASC, ms_first.id ASC LIMIT 1
    )
    LEFT JOIN sb_observations o ON o.id = ms.observation_id
    WHERE m.entry_id IS NOT NULL
      AND m.content_hash IS NOT NULL
      AND (${candidateClauses.join(" OR ")})
      AND ${activeMemoryClaimPredicate("m", String(params.before))}`;
  if (params.after !== undefined) {
    sql += graphEntryIds.length
      ? ` AND (COALESCE(m.observed_at, m.created_at) >= ? OR m.entry_id IN (${graphEntryIds.map(() => "?").join(", ")}))`
      : ` AND COALESCE(m.observed_at, m.created_at) >= ?`;
    bindings.push(params.after);
    if (graphEntryIds.length) bindings.push(...graphEntryIds);
  }
  sql += ` AND COALESCE(m.observed_at, m.created_at) <= ?`;
  bindings.push(params.before);
  if (params.kind && (KIND_VALUES as readonly string[]).includes(params.kind)) {
    sql += ` AND m.kind = ?`;
    bindings.push(params.kind);
  }
  if (params.tag) {
    sql += ` AND CASE
      WHEN pv_snapshot.metadata_snapshot_hash IS NOT NULL
        THEN COALESCE(pv_snapshot.tags_snapshot_json, '[]')
      ELSE COALESCE(e.tags, '[]')
    END LIKE ?`;
    bindings.push(`%"${params.tag}"%`);
  }
  if (vaultFilter) {
    sql += ` AND (
      (
        pv_snapshot.metadata_snapshot_hash IS NOT NULL
        AND pv_snapshot.vault_snapshot = ?
      )
      OR (
        pv_snapshot.metadata_snapshot_hash IS NULL
        AND EXISTS (
          SELECT 1 FROM sb_external_links l
          WHERE l.entry_id = m.entry_id
            AND l.provider = 'obsidian'
            AND l.object_type = 'memory'
            AND l.vault_id = ?
        )
      )
    )`;
    bindings.push(vaultFilter, vaultFilter);
  }
  sql += ` ORDER BY COALESCE(m.observed_at, m.created_at) DESC LIMIT ?`;
  bindings.push(Math.max(params.topK * 10, 50));
  const { results } = await env.DB.prepare(sql).bind(...bindings).all<ClaimSnapshotRow>();

  const scored = (results ?? []).map((row) => {
    const lower = row.content.toLowerCase();
    const keywordHits = tokens.filter((token) => lower.includes(token.toLowerCase())).length;
    const keywordScore = tokens.length ? keywordHits / tokens.length : 0;
    const semantic = semanticScores.get(row.id) ?? 0;
    const evidence = Math.max(0, Math.min(1, Number(row.confidence ?? 0)));
    const graph = graphSignals.get(row.entry_id);
    return {
      row,
      score: semantic * 0.55 + keywordScore * 0.25 + evidence * 0.05 + (graph?.boost ?? 0),
      semantic,
      keywordScore,
      graph,
    };
  }).sort((left, right) => right.score - left.score || right.row.created_at - left.row.created_at)
    .slice(0, params.topK);
  const maxScore = Math.max(0, ...scored.map((candidate) => candidate.score));
  const matches: RecallMatch[] = scored.map(({ row, score, semantic, keywordScore, graph }) => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags || "[]");
      tags = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      tags = [];
    }
    if (row.kind && !tags.includes(`kind:${row.kind}`)) tags = [...tags, `kind:${row.kind}`];
    const normalizedScore = maxScore > 0 ? score / maxScore : 1;
    return {
      id: row.entry_id,
      claimId: row.id,
      parentVersionId: row.parent_version_id,
      content: row.content,
      score: normalizedScore,
      createdAt: Number(row.created_at),
      tags,
      source: row.source ?? "claim",
      isUpdate: row.claim_status === "superseded",
      scoreDetails: roundScoreDetails({
        semantic,
        keyword: keywordScore,
        entity: graph?.entity,
        temporal: graph?.temporal,
        relation: graph?.relation,
        confidence: Number(row.confidence ?? 0),
        importance: Math.max(0, Math.min(1, Number(row.importance ?? 0) / 5)),
        final: normalizedScore,
      }),
      matchedEntities: graph?.entityNames.slice(0, 8),
      graphFacts: graph?.facts.slice(0, 5),
      timeBasis: graph?.temporalEvidence,
    };
  });
  const conflictContext = await loadRecallConflictContext(
    env.DB,
    matches.map((match) => match.id),
    params.before
  );
  for (const match of matches) {
    match.claims = (conflictContext.claimsByEntry.get(match.id) ?? [])
      .filter((claim) => claim.id === match.claimId);
  }
  const insightRows = matches.map((match) => ({
    id: match.id,
    content: match.content,
    claims: match.claims,
  }));
  const synthesized = insightRows.length
    ? await resolveVerifiedRecallInsight(
      params.query,
      { directEvidence: insightRows, relatedContext: [] },
      env,
      conflictContext.conflicts,
      { asOf: params.before }
    )
    : { answer: "", verifiedClaims: [], unverifiedClaims: [] };
  if (runtimeOptions.recordUsage !== false) {
    ctx.waitUntil(Promise.all(matches.map((match) =>
      env.DB.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = ?`)
        .bind(match.id).run()
    )).catch((error) => console.error("historical recall_count update failed (non-fatal):", error)));
  }
  return {
    matches,
    directEvidence: [...matches],
    relatedContext: [],
    insight: synthesized.answer,
    verifiedClaims: synthesized.verifiedClaims,
    unverifiedClaims: synthesized.unverifiedClaims,
    conflicts: conflictContext.conflicts,
    retrievalMode: "claim_snapshot",
    snapshotAt: params.before,
    degraded,
    degradedReason,
  };
}

export async function recallEntries(
  params: {
    query: string;
    topK: number;
    tag?: string;
    after?: number;
    before?: number;
    kind?: MemoryKind;
    hops?: number;
    associationDirection?: AssociationDirection;
  },
  env: Env,
  ctx: ExecutionContext,
  vaultFilter: string | null = null,
  runtimeOptions: { recordUsage?: boolean; allowClaimVectorBackfill?: boolean } = {}
): Promise<RecallSearchResult> {
  const { query, topK } = params;
  const associationHops = Math.max(0, Math.min(2, Math.trunc(params.hops ?? 0)));
  const associationDirection = params.associationDirection ?? "outgoing";
  let { tag, after, before, kind } = params;
  if (tag && !isD1SafeTag(tag)) return { matches: [], insight: "" };
  const now = Date.now();

  let embedQuery = query;
  if (after === undefined && before === undefined) {
    const parsed = parseTimePhrase(query, now);
    after = parsed.after;
    before = parsed.before;
    embedQuery = parsed.cleanQuery;
  }

  if (before !== undefined && before < now) {
    return recallHistoricalClaims({
      query: embedQuery,
      topK,
      tag,
      after,
      before,
      kind,
    }, env, ctx, vaultFilter, runtimeOptions);
  }

  const tokens = tokenizeQuery(embedQuery);
  const recallAsOf = before ?? now;
  let embeddingFailed = false;
  let lexicalRows: KeywordRow[] = [];
  const [embeddingResult, queryTags, graphSignals] = await Promise.all([
    loadActiveEmbeddingSnapshot(env).then(async (snapshot) => {
      const values = await embedWithProvider(snapshot.provider, embedQuery, "query");
      return { values, fingerprint: snapshot.fingerprint };
    }).catch((error) => {
      embeddingFailed = true;
      console.error("Recall embedding failed; continuing with keyword/graph recall:", error);
      return null;
    }),
    inferQueryTags(embedQuery, env).catch((error) => {
      console.error("Recall tag inference failed (non-fatal):", error);
      return [];
    }),
    buildGraphRecallSignals(embedQuery, env, before ?? now).catch((error) => {
      console.error("Graph recall signals failed (non-fatal):", error);
      return new Map<string, GraphRecallSignal>();
    }),
  ]);
  const values = embeddingResult?.values ?? null;
  const activeFingerprint = embeddingResult?.fingerprint ?? null;
  let vectorQueryDegraded = false;
  let vectorQueryDegradedReason: RecallSearchResult["degradedReason"] | undefined;

  let keywordRows: KeywordRow[] = [];
  let results: { matches: VectorizeMatch[] };
  let denseLogicalLimit = 50;
  if (tag) {
    // Tag path: score the tag's own vectors directly. An unconstrained Vectorize
    // query caps at 50 candidates, silently dropping tagged entries whose global
    // semantic rank falls outside the top 50 (issue #141). D1 is the source of
    // truth for tags and already stores each entry's vector_ids.
    const { results: tagRows } = await env.DB.prepare(
      `SELECT id, vector_ids, content, tags, source, created_at FROM entries
       WHERE tags LIKE ?
         AND tags NOT LIKE '%"status:deprecated"%'
         AND tags NOT LIKE '%"auto-pattern"%'
         ${activeParentEntryPredicateAt("entries.id", String(recallAsOf), { requireEvidence: true })}`
    ).bind(`%"${tag}"%`).all();
    if (!tagRows.length) return {
      matches: [],
      insight: "",
      degraded: embeddingFailed,
      degradedReason: embeddingFailed ? "embedding_failed" : undefined,
    };
    keywordRows = tagRows as unknown as KeywordRow[];

    if (!values) {
      results = { matches: [] };
    } else {
      const vectorIds = [...new Set(
        (tagRows as any[]).flatMap(r => JSON.parse((r.vector_ids as string) ?? "[]") as string[])
      )];
      if (!vectorIds.length) return {
        matches: [],
        insight: "",
        degraded: embeddingFailed,
        degradedReason: embeddingFailed ? "embedding_failed" : undefined,
      };

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
    }
  } else {
    // Cloudflare Vectorize caps topK at 50 when returnMetadata="all" (error 40025).
    // Overfetch before validating active generations so stale cleanup debt cannot
    // consume the entire logical candidate window.
    denseLogicalLimit = Math.min(topK * VECTORIZE_TOP_K_MULTIPLIER, 50);
    const lexicalIdsPromise: Promise<string[]> =
      env.SELFHOST === "1" &&
      typeof (env.VECTORIZE as any).queryLexical === "function" &&
      tokens.length
        ? Promise.resolve((env.VECTORIZE as any).queryLexical(embedQuery, KEYWORD_CANDIDATE_LIMIT))
            .then((ids) => Array.isArray(ids) ? ids.map(String).filter(Boolean) : [])
            .catch((error) => {
              console.error("Self-host lexical recall failed (non-fatal):", error);
              return [];
            })
        : Promise.resolve([]);
    const [denseResults, kwRows, lexicalIds] = await Promise.all([
      values && activeFingerprint
        ? queryActiveVectors(env, values, activeFingerprint, 50, embedQuery)
        : Promise.resolve({
            matches: [] as VectorizeMatch[],
            degraded: false,
          } satisfies ActiveVectorQueryResult),
      keywordSearch(tokens, env, recallAsOf),
      lexicalIdsPromise,
    ]);
    if (denseResults.degraded) {
      vectorQueryDegraded = true;
      vectorQueryDegradedReason = denseResults.degradedReason;
    }
    results = denseResults;
    keywordRows = kwRows;
    lexicalRows = await lexicalVectorRows(lexicalIds, env, recallAsOf).catch((error) => {
      console.error("Self-host lexical row hydration failed (non-fatal):", error);
      return [];
    });
  }

  if (!tag && results.matches.length) {
    // Vector cleanup is compensating and can fail after D1 has already switched
    // to a newer generation. D1 vector_ids is therefore the authoritative
    // active-set pointer: stale/orphaned vectors must not influence fusion or
    // return unrelated current content for an old embedding.
    const activeMatches = await filterActiveVectorMatches(
      results.matches as VectorizeMatch[],
      env
    );
    const activeLimit = activeMatches.length && activeMatches[0].score < DUPLICATE_FLAG_THRESHOLD
      ? 50
      : denseLogicalLimit;
    results = { matches: activeMatches.slice(0, activeLimit) };
  }

  // Always-on hybrid retrieval: fuse dense + keyword candidates via RRF. On the tag path
  // keyword is a re-ranking signal only (allowKeywordOnly=false); on the default path it can
  // also surface exact-identifier matches the dense top-K missed entirely.
  let fusedMatches = fuseDenseAndKeyword(
    results.matches as VectorizeMatch[],
    keywordRows,
    tokens,
    !tag,
    lexicalRows
  );
  fusedMatches = applyGraphRecallSignals(fusedMatches, graphSignals, !tag);
  if (!fusedMatches.length) return {
    matches: [],
    insight: "",
    degraded: embeddingFailed || vectorQueryDegraded,
    degradedReason: embeddingFailed
      ? "embedding_failed"
      : vectorQueryDegradedReason,
  };

  // Fetch recall_count and importance_score for all candidates to use in scoring.
  // The tag path can produce far more than 100 candidates, so chunk the IN query
  // to stay under D1's bound-parameter limit.
  const candidateIds = [...new Set(fusedMatches.map(m => (m.metadata as any)?.parentId ?? m.id))] as string[];
  const rcRows: {
    id: string;
    tags: string;
    source: string;
    created_at: number;
    recall_count: number;
    importance_score: number;
    contradiction_wins: number;
    contradiction_losses: number;
    classification_confidence: number | null;
    evidence_score: number | null;
    parent_version_state: string | null;
  }[] = [];
  for (let i = 0; i < candidateIds.length; i += D1_MAX_BOUND_PARAMS) {
    const batch = candidateIds.slice(i, i + D1_MAX_BOUND_PARAMS);
    const rcPlaceholders = batch.map(() => "?").join(", ");
    const { results: rows } = await env.DB.prepare(
      `SELECT id, tags, source, created_at,
              recall_count, importance_score, contradiction_wins, contradiction_losses,
              classification_confidence,
              (SELECT MAX(COALESCE(ms.evidence_score, m.confidence, 0))
               FROM sb_memories m
               LEFT JOIN sb_memory_sources ms ON ms.memory_id = m.id
               WHERE m.entry_id = entries.id
                 AND ${activeMemoryClaimPredicate("m", String(recallAsOf))}) AS evidence_score,
              COALESCE(
                (SELECT pv.state
                 FROM sb_memories m
                 JOIN sb_parent_version_claims pvc ON pvc.memory_id = m.id
                 JOIN sb_parent_versions pv ON pv.version_id = pvc.parent_version_id
                 JOIN sb_parent_units pu
                   ON pu.active_version_id = pv.version_id
                  AND pu.parent_id = pv.parent_id
                 WHERE m.entry_id = entries.id
                   AND pv.state IN ('active', 'active_degraded')
                   AND m.claim_status IN ('supported', 'confirmed', 'contested')
                 ORDER BY CASE pv.state WHEN 'active' THEN 0 ELSE 1 END
                 LIMIT 1),
                (SELECT pv.state
                 FROM sb_memories m
                 JOIN sb_parent_versions pv ON pv.version_id = m.parent_version_id
                 JOIN sb_parent_units pu
                   ON pu.active_version_id = pv.version_id
                  AND pu.parent_id = pv.parent_id
                 WHERE m.entry_id = entries.id
                   AND NOT EXISTS (
                     SELECT 1
                     FROM sb_parent_version_claims pvc_any
                     WHERE pvc_any.memory_id = m.id
                   )
                   AND pv.state IN ('active', 'active_degraded')
                   AND m.claim_status IN ('supported', 'confirmed', 'contested')
                 ORDER BY CASE pv.state WHEN 'active' THEN 0 ELSE 1 END
                 LIMIT 1)
              ) AS parent_version_state
       FROM entries WHERE id IN (${rcPlaceholders})
       ${activeParentEntryPredicateAt("entries.id", String(recallAsOf), { requireEvidence: true })}`
    ).bind(...batch).all() as {
      results: {
        id: string;
        tags: string;
        source: string;
        created_at: number;
        recall_count: number;
        importance_score: number;
        contradiction_wins: number;
        contradiction_losses: number;
        classification_confidence: number | null;
        evidence_score: number | null;
        parent_version_state: string | null;
      }[];
    };
    rcRows.push(...rows);
  }
  const recallCounts = new Map(rcRows.map(r => [r.id, r.recall_count ?? 0]));
  const importanceScores = new Map(rcRows.map(r => [r.id, r.importance_score ?? 0]));
  const contradictionWins = new Map(rcRows.map(r => [r.id, r.contradiction_wins ?? 0]));
  const contradictionLosses = new Map(rcRows.map(r => [r.id, r.contradiction_losses ?? 0]));
  const confidenceScores = new Map(
    rcRows
      .map(r => {
        const classification = r.classification_confidence == null ? 0 : Number(r.classification_confidence);
        const evidence = r.evidence_score == null ? 0 : Number(r.evidence_score);
        return [r.id, Math.max(classification, evidence)] as const;
      })
      .filter(([, score]) => Number.isFinite(score) && score > 0)
  );
  const parentVersionStates = new Map(
    rcRows
      .filter(r => typeof r.parent_version_state === "string" && r.parent_version_state)
      .map(r => [r.id, String(r.parent_version_state)])
  );
  const currentEntryMetadata = new Map(rcRows.map((row) => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags ?? "[]");
      tags = Array.isArray(parsed)
        ? parsed.filter((tag): tag is string => typeof tag === "string")
        : [];
    } catch {
      tags = [];
    }
    return [row.id, {
      tags,
      source: row.source,
      created_at: Number(row.created_at ?? Date.now()),
    }];
  }));
  const eligibleCandidateIds = new Set(rcRows.map((row) => row.id));
  fusedMatches = fusedMatches.filter((match) => {
    const parentId = String(((match.metadata ?? {}) as Record<string, unknown>).parentId ?? match.id);
    return eligibleCandidateIds.has(parentId);
  });
  if (!fusedMatches.length) return {
    matches: [],
    insight: "",
    degraded: embeddingFailed || vectorQueryDegraded,
    degradedReason: embeddingFailed
      ? "embedding_failed"
      : vectorQueryDegradedReason,
  };

  const rerankInput = fusedMatches.map((match) => {
    const meta = (match.metadata ?? {}) as Record<string, unknown>;
    const parentId = String(meta.parentId ?? match.id);
    const current = currentEntryMetadata.get(parentId)!;
    return {
      ...match,
      metadata: {
        ...meta,
        parentId,
        tags: current.tags,
        source: current.source,
        created_at: current.created_at,
        parent_version_state: parentVersionStates.get(parentId) ?? null,
      },
    };
  });

  const reranked = rerankWithTimeDecay(
    rerankInput,
    recallCounts,
    importanceScores,
    queryTags,
    contradictionWins,
    contradictionLosses,
    confidenceScores,
  );

  const seen = new Set<string>();
  const deduped = reranked.filter((m) => {
    const parentId = (m.metadata as any)?.parentId ?? m.id;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    return true;
  }).slice(0, topK);

  if (!deduped.length) return {
    matches: [],
    insight: "",
    degraded: embeddingFailed || vectorQueryDegraded,
    degradedReason: embeddingFailed
      ? "embedding_failed"
      : vectorQueryDegradedReason,
  };

  // Fetch full content from D1 for all matched parent IDs. Entry-level time filters are
  // applied after hydration so graph-temporal facts can be judged by fact validity rather
  // than the original entry creation time.
  const parentIds = deduped.map((m) => (m.metadata as any)?.parentId ?? m.id);
  const placeholders = parentIds.map(() => "?").join(", ");
  const d1Bindings: (string | number)[] = [...parentIds];
  let d1Sql = `SELECT id, content, tags, source, created_at FROM entries WHERE id IN (${placeholders}) AND tags NOT LIKE '%"auto-pattern"%' AND tags NOT LIKE '%"status:deprecated"%' ${activeParentEntryPredicateAt("entries.id", String(recallAsOf), { requireEvidence: true })}`;
  if (vaultFilter) {
    d1Sql += ` AND EXISTS (SELECT 1 FROM sb_external_links l WHERE l.entry_id = entries.id AND l.provider = 'obsidian' AND l.object_type = 'memory' AND l.vault_id = ?)`;
    d1Bindings.push(vaultFilter);
  }
  if (kind && (KIND_VALUES as readonly string[]).includes(kind)) {
    // Safe to interpolate: `kind` is validated against the KIND_VALUES enum just above,
    // so only "episodic"/"semantic" can reach the string.
    d1Sql += ` AND tags LIKE '%"kind:${kind}"%'`;
  }
  const { results: d1Rows } = await env.DB.prepare(d1Sql).bind(...d1Bindings).all() as { results: Record<string, any>[] };

  const d1Map = new Map(d1Rows.map((r) => [r.id as string, r]));

  let matches: RecallMatch[] = deduped.flatMap((m) => {
    const meta = m.metadata as Record<string, any>;
    const parentId = (meta?.parentId ?? m.id) as string;
    const row = d1Map.get(parentId);
    const isUpdate = !!meta?.isUpdate;
    const scoreDetails = meta?.score_details as RecallScoreDetails | undefined;

    if (!row) {
      // D1 row not found — either filtered out (e.g. status:deprecated) or genuinely missing
      return [];
    }

    const createdAt = Number(row.created_at ?? 0);
    const hasGraphTemporalSignal = Number(scoreDetails?.temporal ?? 0) > 0;
    const historicalWindowRequested = after !== undefined || before !== undefined;
    const graphAnchorsHistoricalWindow =
      hasGraphTemporalSignal && meta?.graph_temporal_anchors_history === true;
    if (!hasGraphTemporalSignal || (historicalWindowRequested && !graphAnchorsHistoricalWindow)) {
      if (after !== undefined && createdAt < after) return [];
      if (before !== undefined && createdAt > before) return [];
    }

    return [{
      id: parentId,
      content: row.content as string,
      score: m.score,
      createdAt,
      tags: JSON.parse(row.tags ?? "[]"),
      source: row.source as string,
      isUpdate,
      scoreDetails: mergeScoreDetails(scoreDetails, {
        importance: clamp01((importanceScores.get(parentId) ?? 0) / 5),
        confidence: confidenceScores.get(parentId),
      }),
      matchedEntities: Array.isArray(meta?.graph_entities)
        ? meta.graph_entities.map(String).filter(Boolean).slice(0, 8)
        : undefined,
      graphFacts: Array.isArray(meta?.graph_facts)
        ? meta.graph_facts.map(String).filter(Boolean).slice(0, 5)
        : undefined,
      timeBasis: typeof meta?.graph_temporal_evidence === "string"
        ? meta.graph_temporal_evidence as TemporalEvidence
        : undefined,
    }];
  });

  // Increment recall_count for entries actually shown.
  if (runtimeOptions.recordUsage !== false) {
    ctx.waitUntil(
      Promise.all(
        matches.map(match =>
          env.DB.prepare(`UPDATE entries SET recall_count = recall_count + 1 WHERE id = ?`).bind(match.id).run()
        )
      ).catch(e => console.error("recall_count update failed (non-fatal):", e))
    );
  }

  // Normalize fused scores to 0–1 (top = 1.0) as a relative rank scale — not probability
  // or semantic similarity. Callers should label with formatRelevanceLabel(), not "% match".
  const maxScore = matches.reduce((mx, m) => Math.max(mx, m.score), 0);
  if (maxScore > 0) for (const m of matches) m.score = m.score / maxScore;
  for (const m of matches) {
    m.scoreDetails = roundScoreDetails(mergeScoreDetails(m.scoreDetails, { final: m.score }));
  }
  const directMatches = [...matches];

  if (associationHops > 0 && matches.length) {
    try {
      let associationRows = await associationRecallExpansion(
        env.DB,
        matches.map((match) => ({ entryId: match.id, score: match.score })),
        {
          hops: associationHops,
          direction: associationDirection,
          asOf: recallAsOf,
          limit: topK,
        }
      );
      associationRows = associationRows.filter((row) => {
        if (row.tags.includes("auto-pattern") || row.tags.includes("status:deprecated")) return false;
        if (kind && !row.tags.includes(`kind:${kind}`)) return false;
        if (tag && !row.tags.includes(tag)) return false;
        if (after !== undefined && row.createdAt < after) return false;
        if (before !== undefined && row.createdAt > before) return false;
        return true;
      });
      if (vaultFilter && associationRows.length) {
        const ids = associationRows.map((row) => row.entryId);
        const placeholders = ids.map(() => "?").join(", ");
        const { results } = await env.DB.prepare(
          `SELECT DISTINCT entry_id
           FROM sb_external_links
           WHERE provider = 'obsidian'
             AND object_type = 'memory'
             AND vault_id = ?
             AND entry_id IN (${placeholders})`
        ).bind(vaultFilter, ...ids).all<{ entry_id: string }>();
        const allowed = new Set(results.map((row) => row.entry_id));
        associationRows = associationRows.filter((row) => allowed.has(row.entryId));
      }
      matches = [
        ...matches,
        ...associationRows.map((row): RecallMatch => ({
          id: row.entryId,
          content: row.content,
          score: row.score,
          createdAt: row.createdAt,
          tags: row.tags,
          source: row.source,
          isUpdate: false,
          scoreDetails: roundScoreDetails({
            relation: row.score,
            final: row.score,
          }),
          association: {
            hop: row.hop,
            viaType: row.viaType,
            viaWeight: row.viaWeight,
            seedParentId: row.seedParentId,
          },
        })),
      ];
    } catch (error) {
      console.error("Association recall expansion failed (non-fatal):", error);
    }
  }

  // Observatory: memory.recalled events (sample top matches)
  for (let i = 0; i < Math.min(matches.length, 10); i++) {
    const m = matches[i];
    logMemoryEvent(m.id, "recalled", {
      query: query.slice(0, 200),
      score: m.score,
      rank: i + 1,
      graph: {
        entities: m.matchedEntities ?? [],
        facts: m.graphFacts ?? [],
        entity_score: m.scoreDetails?.entity ?? 0,
        temporal_score: m.scoreDetails?.temporal ?? 0,
        relation_score: m.scoreDetails?.relation ?? 0,
      },
    }, "recall");
  }

  const directInsightRows = directMatches.map((match) => ({
    id: match.id,
    content: match.content,
    claims: match.claims,
  }));
  const relatedInsightRows = matches.flatMap((match) => match.association ? [{
    id: match.id,
    content: match.content,
    associationType: match.association.viaType,
    hop: match.association.hop,
  }] : []);

  const conflictContext = await loadRecallConflictContext(
    env.DB,
    directMatches.map((match) => match.id),
    recallAsOf
  );
  for (const match of directMatches) {
    match.claims = conflictContext.claimsByEntry.get(match.id) ?? [];
  }
  for (const row of directInsightRows) {
    row.claims = conflictContext.claimsByEntry.get(row.id) ?? [];
  }

  const synthesized = directInsightRows.length
    ? await resolveVerifiedRecallInsight(embedQuery, {
        directEvidence: directInsightRows,
        relatedContext: relatedInsightRows,
      }, env, conflictContext.conflicts, { asOf: recallAsOf })
    : { answer: "", verifiedClaims: [], unverifiedClaims: [] };

  return {
    matches,
    directEvidence: directMatches,
    relatedContext: matches.filter((match) => Boolean(match.association)),
    insight: synthesized.answer,
    verifiedClaims: synthesized.verifiedClaims,
    unverifiedClaims: synthesized.unverifiedClaims,
    conflicts: conflictContext.conflicts,
    retrievalMode: "entry_projection",
    snapshotAt: recallAsOf,
    degraded: embeddingFailed || vectorQueryDegraded,
    degradedReason: embeddingFailed
      ? "embedding_failed"
      : vectorQueryDegradedReason,
  };
}

// ─── Shared write path ────────────────────────────────────────────────────────

function classificationErrorCode(error: unknown): string {
  if (error instanceof Error && error.message === "provider_error") return "provider_error";
  if (error instanceof Error && error.message === "invalid_response") return "invalid_response";
  if (error instanceof Error && error.message === "classification_conflict") return "classification_conflict";
  return "classification_failed";
}

interface ClassificationCandidate {
  id: string;
  content: string;
}

type ClassificationRunResult = "succeeded" | "failed" | "skipped";

async function claimClassification(
  candidate: ClassificationCandidate,
  startedAt: number,
  env: Env
): Promise<number | null> {
  const result = await env.DB.prepare(
    `UPDATE entries
     SET classification_status = 'processing', classification_error = NULL,
         classification_attempts = CASE
           WHEN classification_status = 'succeeded'
                AND COALESCE(classification_version, 0) < ?
             THEN 1
           ELSE COALESCE(classification_attempts, 0) + 1
         END,
         classification_started_at = ?, classification_next_attempt_at = NULL
     WHERE id = ? AND content = ?
       AND tags NOT LIKE '%"status:deprecated"%'
       AND (
         (
           COALESCE(classification_attempts, 0) < ?
           AND (
             classification_status IS NULL
             OR classification_status = 'pending'
             OR (classification_status = 'retryable_error'
                 AND COALESCE(classification_next_attempt_at, 0) <= ?)
             OR (classification_status = 'processing'
                 AND COALESCE(classification_started_at, 0) <= ?)
           )
         )
         OR (
           classification_status = 'succeeded'
           AND COALESCE(classification_version, 0) < ?
         )
       )`
  ).bind(
    CURRENT_CLASSIFICATION_VERSION,
    startedAt,
    candidate.id,
    candidate.content,
    CLASSIFICATION_MAX_ATTEMPTS,
    startedAt,
    startedAt - CLASSIFICATION_PROCESSING_LEASE_MS,
    CURRENT_CLASSIFICATION_VERSION,
  ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return null;
  const claimed = await env.DB.prepare(
    `SELECT classification_attempts FROM entries
     WHERE id = ? AND content = ?
       AND classification_status = 'processing'
       AND classification_started_at = ?`
  ).bind(candidate.id, candidate.content, startedAt).first<{ classification_attempts: number }>();
  return claimed ? Number(claimed.classification_attempts ?? 0) : null;
}

async function classifyAndPersistEntry(
  candidate: ClassificationCandidate,
  env: Env
): Promise<ClassificationRunResult> {
  const startedAt = Date.now();
  const currentAttempt = await claimClassification(candidate, startedAt, env);
  if (currentAttempt === null) return "skipped";
  try {
    const { importance, confidence, canonical, kind } = await classifyEntry(candidate.content, env);
    for (let tagCommitAttempt = 0; tagCommitAttempt < 2; tagCommitAttempt++) {
      const current = await env.DB.prepare(
        `SELECT tags, source, pending_vector_ids, pending_rebuild_id FROM entries
         WHERE id = ? AND content = ?
           AND classification_status = 'processing'
           AND classification_started_at = ?`
      ).bind(candidate.id, candidate.content, startedAt).first<{
        tags: string;
        source: string;
        pending_vector_ids: string | null;
        pending_rebuild_id: string | null;
      }>();
      if (!current) return "skipped";
      const currentTagsJson = current.tags || "[]";
      const previousTags: string[] = JSON.parse(currentTagsJson);
      let tags: string[] = [...previousTags];
      tags = withKind(tags, kind);
      tags = applyClassificationLifecycleTags(tags, canonical, confidence);
      const classifiedAt = Date.now();
      const nextTagsJson = JSON.stringify(tags);
      const metadataHash = await entryMetadataFingerprint({
        source: current.source,
        tags,
      });
      const cleanupStatements = preparePendingGenerationInvalidation(env, {
        pendingVectorIds: current.pending_vector_ids,
        pendingRebuildId: current.pending_rebuild_id,
        reason: "classification_metadata_changed",
        now: classifiedAt,
      });
      const classifyRevision = prepareMemoryRevision(env.DB, {
        memoryId: candidate.id,
        eventType: "CLASSIFY",
        oldContent: candidate.content,
        newContent: candidate.content,
        oldMetadata: {
          tags: previousTags,
        },
        newMetadata: {
          tags,
          importance,
          confidence,
          canonical,
          kind,
          classification_version: CURRENT_CLASSIFICATION_VERSION,
        },
        reason: "Automatic classification",
        actor: "classifier",
        createdAt: classifiedAt,
      });
      const updateStatement = env.DB.prepare(
        `UPDATE entries
         SET tags = ?, metadata_hash = ?, importance_score = ?, classification_confidence = ?,
             classification_status = 'succeeded', classification_error = NULL,
             classification_next_attempt_at = NULL, classification_started_at = NULL,
             classification_version = ?, classified_at = ?,
             ${pendingGenerationResetAssignments()}
         WHERE id = ? AND content = ? AND tags = ?
           AND classification_status = 'processing'
           AND classification_started_at = ?`
      ).bind(
        nextTagsJson,
        metadataHash,
        importance,
        confidence,
        CURRENT_CLASSIFICATION_VERSION,
        classifiedAt,
        candidate.id,
        candidate.content,
        currentTagsJson,
        startedAt
      );
      const [updateResult] = await env.DB.batch([
        updateStatement,
        ...cleanupStatements,
      ]);
      if (Number(updateResult.meta?.changes ?? 0) !== 1) continue;
      try {
        await classifyRevision.statement.run();
      } catch (e) {
        console.error("CLASSIFY revision write failed (non-fatal):", e);
      }
      await notifyMemoryChanged(env, candidate.id, "classification");
      return "succeeded";
    }
    throw new Error("classification_conflict");
  } catch (error) {
    const terminal = currentAttempt >= CLASSIFICATION_MAX_ATTEMPTS;
    const nextAttemptAt = terminal
      ? null
      : Date.now() + CLASSIFICATION_RETRY_BASE_MS * 2 ** Math.max(0, currentAttempt - 1);
    const result = await env.DB.prepare(
      `UPDATE entries
       SET classification_status = ?, classification_error = ?,
           classification_next_attempt_at = ?, classification_started_at = NULL
       WHERE id = ? AND content = ?
         AND classification_status = 'processing'
         AND classification_started_at = ?`
    ).bind(
      terminal ? "terminal_error" : "retryable_error",
      classificationErrorCode(error),
      nextAttemptAt,
      candidate.id,
      candidate.content,
      startedAt
    ).run();
    return Number(result.meta?.changes ?? 0) === 1 ? "failed" : "skipped";
  }
}

export interface ClassificationQueueResult {
  processed: number;
  failed: number;
  skipped: number;
  remaining: number;
  deferred: number;
  exhausted: number;
}

/** Process due classification queue rows (pending, retryable, lease-expired, stale version). */
export async function processClassificationQueue(
  env: Env,
  batchLimit: number,
): Promise<ClassificationQueueResult> {
  const now = Date.now();
  const leaseCutoff = now - CLASSIFICATION_PROCESSING_LEASE_MS;
  const DUE_WHERE = classificationDueWhereSql(now, leaseCutoff);

  const { results: toProcess } = await env.DB.prepare(
    `SELECT id, content
     FROM entries
     WHERE ${DUE_WHERE}
     ORDER BY CASE
                WHEN classification_status IS NULL OR classification_status = 'pending' THEN 0
                WHEN classification_status = 'succeeded' THEN 2
                ELSE 1
              END,
              created_at ASC
     LIMIT ${batchLimit}`
  ).all();

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of toProcess as Record<string, any>[]) {
    try {
      const outcome = await classifyAndPersistEntry({
        id: row.id as string,
        content: row.content as string,
      }, env);
      if (outcome === "succeeded") processed++;
      else if (outcome === "failed") failed++;
      else skipped++;
    } catch (e) {
      console.error("Classification queue failed for entry", row.id, e);
      failed++;
    }
  }

  const queue = await readClassificationQueueSnapshot(env.DB, now);

  return {
    processed,
    failed,
    skipped,
    remaining: queue.due,
    deferred: queue.deferred,
    exhausted: queue.exhausted,
  };
}

// Classify an entry's content and persist durable success/failure state,
// asynchronously. Used for both newly-inserted entries and smart-merge targets.
function scheduleClassifyAndTag(
  entryId: string,
  content: string,
  env: Env,
  ctx: ExecutionContext
): void {
  ctx.waitUntil(
    classifyAndPersistEntry({
      id: entryId,
      content,
    }, env)
      .catch(e => console.error("Classification failed (non-fatal):", e))
  );
}

export type CaptureSingleResult =
  | { status: "blocked"; matchId: string; score: number }
  | { status: "failed"; id: string; reason: string }
  | { status: "sourced"; id: string; observationId: string; memoryId: string }
  | { status: "stored"; id: string }
  | { status: "flagged"; id: string; matchId: string; score: number }
  | { status: "linked"; id: string; linkedId: string; relation: MemoryRelationType; score: number }
  | { status: "contradiction"; id: string; conflictId: string; reason?: string }
  | { status: "contradiction_protected"; id: string; canonicalId: string; reason?: string };

export type CaptureResult =
  | CaptureSingleResult
  | {
      status: "batch";
      observationId: string;
      results: CaptureSingleResult[];
    };

export interface CaptureOptions {
  /** Skip LLM atomic fact extraction (already a single fact or system write). */
  skipExtract?: boolean;
  /** Dual-write sb_memories/sb_memory_sources against this observation. */
  observationId?: string;
  /** Immutable parent version that owns atomic claims derived from the observation. */
  parentVersionId?: string | null;
  /** Stable evidence root/source id used for provenance dedupe. */
  evidenceRootId?: string | null;
  /** Fields produced by the atomic extractor. */
  atomic?: AtomicFactDraft;
  /** Server-validated source adapter provenance for the immutable Observation. */
  evidenceContext?: EvidenceProvenance & {
    metadata?: Record<string, unknown>;
  };
}

function evidenceAuthorTypeForSource(source: string, tags: string[] = []): EvidenceAuthorType {
  const normalized = source.trim().toLowerCase();
  if (
    normalized === "system" ||
    tags.includes("synthesized") ||
    tags.includes("auto-pattern")
  ) {
    return "system";
  }
  if (
    normalized.includes("claude") ||
    normalized.includes("chatgpt") ||
    normalized.includes("openai") ||
    normalized.includes("assistant") ||
    normalized === "ai"
  ) {
    return "assistant";
  }
  if (normalized.includes("import")) return "import";
  if (normalized.includes("tool") || normalized.includes("mcp") || normalized.includes("browser")) {
    return "tool";
  }
  return "user";
}

export function captureResultEntryIds(result: CaptureResult): string[] {
  if (result.status === "batch") {
    return [...new Set(result.results.flatMap((item) =>
      "id" in item && item.status !== "failed" ? [item.id] : []
    ))];
  }
  if ("id" in result && result.status !== "failed") return [result.id];
  return [];
}

export function formatCaptureResultMessage(result: CaptureResult): string {
  if (result.status === "blocked") {
    return `Duplicate detected — not stored. Existing entry ID: ${result.matchId}`;
  }
  if (result.status === "failed") {
    return `Capture failed after creating an audit-only entry ${result.id}: ${result.reason}`;
  }
  if (result.status === "batch") {
    const ids = captureResultEntryIds(result);
    if (!ids.length) {
      return `Observation ${result.observationId} produced no new memories (all exact duplicates).`;
    }
    const sourced = result.results.filter((item) => item.status === "sourced").length;
    const created = result.results.filter(
      (item) => item.status !== "blocked" && item.status !== "sourced" && item.status !== "failed"
    ).length;
    if (sourced && !created) {
      return `Observation ${result.observationId} linked ${sourced} duplicate facts as new sources.`;
    }
    if (sourced) {
      return `Stored ${created} atomic memories and linked ${sourced} duplicate facts as new sources from observation ${result.observationId}.`;
    }
    return (
      `Stored ${ids.length} atomic memories from observation ${result.observationId}.\n` +
      ids.map((id, i) => `${i + 1}. ${id}`).join("\n")
    );
  }
  if (result.status === "sourced") {
    return `Exact duplicate observed again — linked observation ${result.observationId} as a new source for memory ${result.id}.`;
  }
  if (result.status === "contradiction") {
    return `Stored as a new memory. ID: ${result.id} — linked as contradicting entry ${result.conflictId}; both original observations were preserved${result.reason ? `: ${result.reason}` : ""}.`;
  }
  if (result.status === "contradiction_protected") {
    return `Stored as draft (ID: ${result.id}) — linked as contradicting canonical memory ${result.canonicalId}; both observations were preserved${result.reason ? `: ${result.reason}` : ""}.`;
  }
  if (result.status === "linked") {
    return `Stored as a new memory (ID: ${result.id}) and linked to ${result.linkedId} with relation ${result.relation}. The existing memory was preserved.`;
  }
  if (result.status === "flagged") {
    return `Stored with ID: ${result.id} — note: similar entry exists (ID: ${result.matchId}). Tagged as duplicate-candidate.`;
  }
  if (result.status === "stored") {
    return `Stored. ID: ${result.id}`;
  }
  return "Stored.";
}

interface CaptureRelationPlan {
  toMemoryId: string;
  relationType: MemoryRelationType;
  score: number;
  metadata: Record<string, unknown>;
  forceDraft: boolean;
}

async function planCaptureRelation(
  duplicate: DuplicateResult,
  contradiction: ContradictionResult,
  mergeAction: MergeAction | null,
  env: Env
): Promise<CaptureRelationPlan | null> {
  if (contradiction.detected && contradiction.conflicting_id) {
    return {
      toMemoryId: contradiction.conflicting_id,
      relationType: "contradicts",
      score: duplicate.status === "flagged" ? duplicate.score : 0.5,
      metadata: {
        automatic: true,
        reason: contradiction.reason ?? null,
      },
      forceDraft: false,
    };
  }
  if (duplicate.status !== "flagged") return null;

  const decision = mergeAction?.action ?? "keep_both";
  const targetId =
    mergeAction && mergeAction.action !== "keep_both"
      ? mergeAction.target_id
      : duplicate.matchId;
  const target = await env.DB.prepare(
    `SELECT tags, importance_score FROM entries WHERE id = ?`
  ).bind(targetId).first() as Record<string, unknown> | null;
  if (!target) return null;

  const targetTags = parseStoredTags(target.tags);
  const targetProtected =
    Number(target.importance_score ?? 0) >= 4 ||
    getStatus(targetTags) === "canonical";
  const relationType: MemoryRelationType =
    decision === "replace" && !targetProtected
      ? "supersedes"
      : decision === "merge"
        ? "continuation_of"
        : "similar";

  return {
    toMemoryId: targetId,
    relationType,
    score: duplicate.score,
    metadata: {
      automatic: true,
      decision,
      target_protected: targetProtected,
      suggested_relation:
        decision === "replace" && targetProtected ? "supersedes" : null,
    },
    forceDraft: decision === "replace" && targetProtected,
  };
}

function mergeSuggestedActionFromRelation(
  relationPlan: CaptureRelationPlan | null
): MergeSuggestedAction | null {
  if (!relationPlan || relationPlan.relationType === "contradicts") return null;
  const decision = typeof relationPlan.metadata.decision === "string"
    ? relationPlan.metadata.decision
    : null;
  if (decision === "replace") return "replace";
  if (decision === "merge") return "merge";
  return "keep_both";
}

function relationPlanReason(relationPlan: CaptureRelationPlan): string {
  const decision = typeof relationPlan.metadata.decision === "string"
    ? relationPlan.metadata.decision
    : "keep_both";
  if (relationPlan.relationType === "supersedes") {
    return "High semantic similarity; new memory may replace the target.";
  }
  if (relationPlan.relationType === "continuation_of") {
    return "High semantic similarity; new memory may merge with the target.";
  }
  if (decision === "replace" && relationPlan.metadata.target_protected === true) {
    return "Replace was suggested but target is protected; review required.";
  }
  return "High semantic similarity; memories should be reviewed together.";
}

function boundedQualityLimit(value: unknown, fallback = 50): number {
  const raw = Number(value ?? fallback);
  return Number.isFinite(raw) ? Math.max(1, Math.min(Math.trunc(raw), 100)) : fallback;
}

function parseQualityState<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return (allowed as readonly string[]).includes(value.trim())
    ? value.trim() as T
    : null;
}

function parseReviewId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const EntityMergeReviewSchema = z.object({
  id: z.string().trim().min(1).max(256),
  decision: z.enum(["accept", "reject"]),
  reviewedBy: z.string().trim().min(1).max(256).optional(),
  reason: z.string().max(1000).optional(),
}).strict();

async function listMemoryMergeCandidates(
  env: Env,
  input: { state: MergeCandidateState | null; limit: number }
): Promise<Record<string, unknown>[]> {
  const stateClause = input.state ? "WHERE c.state = ?" : "";
  const bindings: unknown[] = [];
  if (input.state) bindings.push(input.state);
  bindings.push(input.limit);
  const { results } = await env.DB.prepare(
    `SELECT
       c.*,
       source.content AS source_content,
       source.tags AS source_tags,
       target.content AS target_content,
       target.tags AS target_tags
     FROM sb_memory_merge_candidates c
     LEFT JOIN entries source ON source.id = c.source_memory_id
     LEFT JOIN entries target ON target.id = c.target_memory_id
     ${stateClause}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ?`
  ).bind(...bindings).all<Record<string, any>>();

  return (results ?? []).map((row) => ({
    id: row.id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    similarity: row.similarity == null ? null : Number(row.similarity),
    suggestedAction: row.suggested_action,
    reason: row.reason,
    state: row.state,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    source: {
      id: row.source_memory_id,
      content: row.source_content ?? null,
      tags: parseStoredTags(row.source_tags),
    },
    target: {
      id: row.target_memory_id,
      content: row.target_content ?? null,
      tags: parseStoredTags(row.target_tags),
    },
  }));
}

async function resolveMemoryMergeCandidate(
  env: Env,
  input: {
    id: string;
    state: MergeCandidateState;
    reviewedBy: string;
    principal: AuthPrincipal;
  }
): Promise<boolean> {
  const now = Date.now();
  const auditEvent = await prepareComplianceAuditEvent(env.DB, {
    ...auditActorFromPrincipal(input.principal),
    action: "quality.merge_candidate.resolve",
    objectType: "memory_merge_candidate",
    objectId: input.id,
    metadata: {
      state: input.state,
      reviewed_by: input.reviewedBy,
    },
  });
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE sb_memory_merge_candidates
       SET state = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ?`
    ).bind(input.state, input.reviewedBy, now, input.id),
    auditEvent.statement,
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}

async function listEntityMergeCandidates(
  env: Env,
  input: { state: EntityMergeCandidateState | null; limit: number }
): Promise<Record<string, unknown>[]> {
  await ensureEntityResolutionDataModel(env.DB);
  const stateClause = input.state ? "WHERE c.state = ?" : "";
  const bindings: unknown[] = [];
  if (input.state) bindings.push(input.state);
  bindings.push(input.limit);
  const { results } = await env.DB.prepare(
    `SELECT c.*,
            source.name AS source_name,
            source.entity_type AS source_type,
            source.lifecycle_state AS source_lifecycle_state,
            target.name AS target_name,
            target.entity_type AS target_type,
            target.lifecycle_state AS target_lifecycle_state
     FROM sb_entity_merge_candidates c
     LEFT JOIN sb_entities source ON source.id = c.source_entity_id
     LEFT JOIN sb_entities target ON target.id = c.target_entity_id
     ${stateClause}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ?`
  ).bind(...bindings).all<Record<string, any>>();
  return (results ?? []).map((row) => ({
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    matchedBy: row.matched_by,
    score: row.score == null ? null : Number(row.score),
    reasons: parseJsonArray(row.reason_json),
    state: row.state,
    sourceObservationId: row.source_observation_id,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    source: {
      id: row.source_entity_id,
      name: row.source_name ?? null,
      type: row.source_type ?? null,
      lifecycleState: row.source_lifecycle_state ?? null,
    },
    target: {
      id: row.target_entity_id,
      name: row.target_name ?? null,
      type: row.target_type ?? null,
      lifecycleState: row.target_lifecycle_state ?? null,
    },
  }));
}

async function listConflictCases(
  env: Env,
  input: { state: ConflictCaseState | null; limit: number }
): Promise<Record<string, unknown>[]> {
  await ensureConflictClaimSchema(env.DB);
  const stateClause = input.state ? "WHERE c.state = ?" : "";
  const bindings: unknown[] = [];
  if (input.state) bindings.push(input.state);
  bindings.push(input.limit);
  const { results } = await env.DB.prepare(
    `SELECT
       c.*,
       old_claim.content AS old_claim_content,
       new_claim.content AS new_claim_content,
       old_entry.content AS old_content,
       old_entry.tags AS old_tags,
       new_entry.content AS new_content,
       new_entry.tags AS new_tags
     FROM sb_conflict_cases c
     LEFT JOIN sb_memories old_claim ON old_claim.id = c.old_claim_id
     LEFT JOIN sb_memories new_claim ON new_claim.id = c.new_claim_id
     LEFT JOIN entries old_entry ON old_entry.id = COALESCE(old_claim.entry_id, c.old_memory_id)
     LEFT JOIN entries new_entry ON new_entry.id = COALESCE(new_claim.entry_id, c.new_memory_id)
     ${stateClause}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ?`
  ).bind(...bindings).all<Record<string, any>>();

  return (results ?? []).map((row) => ({
    id: row.id,
    oldMemoryId: row.old_memory_id,
    newMemoryId: row.new_memory_id,
    oldClaimId: row.old_claim_id ?? null,
    newClaimId: row.new_claim_id ?? null,
    conflictType: row.conflict_type,
    reason: row.reason,
    confidence: row.confidence == null ? null : Number(row.confidence),
    state: row.state,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    oldMemory: {
      id: row.old_memory_id,
      content: row.old_content ?? null,
      tags: parseStoredTags(row.old_tags),
    },
    oldClaim: row.old_claim_id ? {
      id: row.old_claim_id,
      content: row.old_claim_content ?? null,
    } : null,
    newMemory: {
      id: row.new_memory_id,
      content: row.new_content ?? null,
      tags: parseStoredTags(row.new_tags),
    },
    newClaim: row.new_claim_id ? {
      id: row.new_claim_id,
      content: row.new_claim_content ?? null,
    } : null,
  }));
}

async function resolveConflictCase(
  env: Env,
  input: {
    id: string;
    state: ConflictCaseState;
    resolution: ConflictResolution;
    resolvedBy: string;
    principal: AuthPrincipal;
  }
): Promise<boolean> {
  const now = Date.now();
  const actor = auditActorFromPrincipal(input.principal);
  return await new D1ResolutionCoordinator(env.DB).applyConflictResolution({
    conflictId: input.id,
    state: input.state,
    resolution: input.resolution,
    resolvedBy: input.resolvedBy,
    effectiveAt: now,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
}

async function listAuditEvents(
  env: Env,
  input: {
    limit: number;
    action?: string | null;
    objectType?: string | null;
    objectId?: string | null;
    vaultId?: string | null;
    traceId?: string | null;
  }
): Promise<Record<string, unknown>[]> {
  const conditions = ["1 = 1"];
  const bindings: unknown[] = [];
  const add = (column: string, value: string | null | undefined) => {
    if (!value) return;
    conditions.push(`${column} = ?`);
    bindings.push(value);
  };
  add("action", input.action);
  add("object_type", input.objectType);
  add("object_id", input.objectId);
  add("vault_id", input.vaultId);
  add("trace_id", input.traceId);
  bindings.push(input.limit);
  const { results } = await env.DB.prepare(
    `SELECT id, occurred_at, trace_id, actor_type, actor_id, token_id,
            action, object_type, object_id, vault_id, before_hash, after_hash,
            success, error_code, metadata_json, previous_event_hash, event_hash
     FROM sb_audit_events
     WHERE ${conditions.join(" AND ")}
     ORDER BY occurred_at DESC, id DESC
     LIMIT ?`
  ).bind(...bindings).all<Record<string, any>>();
  return (results ?? []).map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    traceId: row.trace_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    tokenId: row.token_id,
    action: row.action,
    objectType: row.object_type,
    objectId: row.object_id,
    vaultId: row.vault_id,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    success: Boolean(row.success),
    errorCode: row.error_code,
    metadata: parseJsonObject(row.metadata_json),
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
  }));
}

export async function extractAtomicFacts(
  content: string,
  env: Env,
  input: { evidenceId?: string; previousEvidence?: EvidenceRevisionInput[] } = {}
): Promise<AtomicFactDraft[]> {
  const extractor = new PromptAtomicExtractor(async (prompt, maxTokens) => {
    let text: string;
    try {
      text = await (await createLLM(env)).chat(
        [{ role: "user", content: prompt }],
        { max_tokens: maxTokens }
      );
    } catch {
      throw new Error("provider_error");
    }
    return text;
  });
  try {
    return await extractor.extract({
      id: input.evidenceId ?? "unbound-evidence",
      content,
      previousEvidence: input.previousEvidence ?? [],
    });
  } catch (error) {
    if (error instanceof Error && error.message === "provider_error") throw error;
    throw error;
  }
}

const ATOMIC_EXTRACTION_BASE_BACKOFF_MS = 60_000;
const ATOMIC_EXTRACTION_DEFAULT_LIMIT = 10;
const ATOMIC_EXTRACTION_SELFHOST_LIMIT = 50;
const ATOMIC_EXTRACTION_CLOUDFLARE_LIMIT = 3;

interface ObservationExtractionRow {
  id: string;
  content: string;
  source: string;
  metadata_json: string;
  created_at: number;
  content_hash: string | null;
  extraction_status: ObservationExtractionStatus;
  extraction_version: number;
  extraction_attempts: number;
  extraction_error: string | null;
  next_attempt_at: number | null;
  processing_started_at: number | null;
  processed_at: number | null;
  needs_reprocess: number;
  previous_evidence_id?: string | null;
  root_evidence_id?: string | null;
  source_identity?: string | null;
  source_channel?: string | null;
  revision?: number | null;
}

type ObservationExtractionProcessResult =
  | { status: "succeeded"; observationId: string; result: CaptureResult }
  | { status: "fallback"; observationId: string; result: CaptureResult; error: string }
  | { status: "failed"; observationId: string; error: string; final: boolean; result?: CaptureResult }
  | { status: "skipped"; observationId: string };

type AtomicWriteResult =
  | { ok: true; memoryId: string }
  | { ok: false; error: string };

export interface ExtractionQueueDryRunResult {
  dryRun: true;
  limit: number;
  due: number;
  deferred: number;
  exhausted: number;
  orphanPending: number;
  fallbackReprocess: number;
  partialError: number;
  retryableDue: number;
  staleProcessing: number;
}

function atomicExtractionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function atomicExtractionBackoffMs(attempts: number): number {
  const power = Math.max(0, attempts - 1);
  return Math.min(15 * 60_000, ATOMIC_EXTRACTION_BASE_BACKOFF_MS * 2 ** power);
}

function tagsFromObservationMetadata(metadataJson: string | null | undefined): string[] {
  try {
    const metadata = JSON.parse(metadataJson || "{}") as Record<string, unknown>;
    if (!Array.isArray(metadata.tags)) return [];
    return [...new Set(
      metadata.tags
        .map((tag) => String(tag).toLowerCase())
        .filter(isD1SafeTag)
    )];
  } catch {
    return [];
  }
}

function fallbackAtomicDraft(content: string, observedAt: number): AtomicFactDraft {
  return {
    content,
    subject: null,
    predicate: null,
    object: null,
    scopeId: null,
    polarity: "positive",
    modality: "asserted",
    status: "supported",
    kind: null,
    memoryClass: null,
    importance: null,
    confidence: null,
    observedAt,
    validFrom: null,
    validTo: null,
    referenceTime: null,
    entities: [],
    relations: [],
  };
}

interface ObservationParentVersionRef {
  parentId: string;
  versionId: string;
  versionNumber: number;
  evidenceRootId: string;
}

function observationParentVersionMetadata(input: ObservationParentVersionRef): Record<string, unknown> {
  return {
    parent_id: input.parentId,
    parent_version_id: input.versionId,
    parent_version_number: input.versionNumber,
    evidence_root_id: input.evidenceRootId,
  };
}

function parentVersionFromObservationMetadata(metadataJson: string | null | undefined): ObservationParentVersionRef | null {
  try {
    const metadata = JSON.parse(metadataJson || "{}") as Record<string, unknown>;
    const parentId = optionalTrimmedString(metadata.parent_id);
    const versionId = optionalTrimmedString(metadata.parent_version_id);
    if (!parentId || !versionId) return null;
    const versionNumber = Math.max(1, Math.trunc(Number(metadata.parent_version_number ?? 1)) || 1);
    return {
      parentId,
      versionId,
      versionNumber,
      evidenceRootId: optionalTrimmedString(metadata.evidence_root_id) ?? parentId,
    };
  } catch {
    return null;
  }
}

function observationMetadataWithParentVersion(
  metadataJson: string | null | undefined,
  parent: ObservationParentVersionRef,
  previousParentVersionId?: string | null
): string {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(metadataJson || "{}") as Record<string, unknown>;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) metadata = {};
  } catch {
    metadata = {};
  }
  return JSON.stringify({
    ...metadata,
    previous_parent_version_id: previousParentVersionId ?? metadata.previous_parent_version_id ?? null,
    ...observationParentVersionMetadata(parent),
  });
}

function prepareObservationParentVersionStatements(
  db: D1Database,
  input: ObservationParentVersionRef & {
    observationId: string;
    contentHash: string | null;
    metadata?: unknown;
    tags?: unknown;
    source?: unknown;
    vault?: unknown;
    createdAt: number;
  }
): D1PreparedStatement[] {
  const metadataSnapshot = buildParentVersionMetadataSnapshot({
    metadata: input.metadata,
    tags: input.tags,
    source: input.source,
    vault: input.vault,
  });
  return [
    prepareParentUnitInsert(db, {
      parentId: input.parentId,
      createdAt: input.createdAt,
    }),
    prepareParentVersionInsert(db, {
      versionId: input.versionId,
      parentId: input.parentId,
      versionNumber: input.versionNumber,
      sourceObservationId: input.observationId,
      sourceSnapshotHash: input.contentHash,
      metadataSnapshot,
      state: "building",
      createdAt: input.createdAt,
    }),
  ];
}

function shouldBuildReplacementParentVersion(
  row: ObservationExtractionRow,
  statusBeforeLease: ObservationExtractionStatus
): boolean {
  return (
    statusBeforeLease === "fallback" ||
    statusBeforeLease === "partial_error" ||
    statusBeforeLease === "succeeded" ||
    Number(row.extraction_version ?? 0) < ATOMIC_EXTRACTION_VERSION
  );
}

async function prepareObservationParentVersionForProcessing(
  env: Env,
  row: ObservationExtractionRow,
  statusBeforeLease: ObservationExtractionStatus
): Promise<ObservationExtractionRow> {
  const parent = parentVersionFromObservationMetadata(row.metadata_json);
  if (!parent || !shouldBuildReplacementParentVersion(row, statusBeforeLease)) return row;
  const nextParent: ObservationParentVersionRef = {
    parentId: parent.parentId,
    versionId: crypto.randomUUID(),
    versionNumber: parent.versionNumber + 1,
    evidenceRootId: parent.evidenceRootId,
  };
  const metadataJson = observationMetadataWithParentVersion(
    row.metadata_json,
    nextParent,
    parent.versionId
  );
  await env.DB.batch([
    ...prepareObservationParentVersionStatements(env.DB, {
      ...nextParent,
      observationId: row.id,
      contentHash: row.content_hash,
      metadata: metadataJson,
      source: row.source,
      createdAt: Date.now(),
    }),
    env.DB.prepare(
      `UPDATE sb_observations
       SET metadata_json = ?
       WHERE id = ?`
    ).bind(metadataJson, row.id),
  ]);
  return { ...row, metadata_json: metadataJson };
}

async function assertParentVersionReadyForActivation(
  env: Env,
  versionId: string,
  requireComplete: boolean
): Promise<void> {
  if (!requireComplete) return;
  const counts = await env.DB.prepare(
     `SELECT
       COUNT(DISTINCT m.id) AS memory_count,
       COUNT(DISTINCT CASE WHEN EXISTS (
         SELECT 1
         FROM sb_memory_sources s
         WHERE s.memory_id = m.id
       ) THEN m.id ELSE NULL END) AS sourced_memory_count
     FROM sb_parent_version_claims pvc
     JOIN sb_memories m ON m.id = pvc.memory_id
     WHERE pvc.parent_version_id = ?
       AND pvc.relation IN ('supports', 'derived_from')
       AND m.claim_status IN ('supported', 'confirmed', 'contested')
       AND m.invalid_at IS NULL
       AND m.expired_at IS NULL`
  ).bind(versionId).first<{ memory_count: number; sourced_memory_count: number | null }>();
  const memoryCount = Number(counts?.memory_count ?? 0);
  const sourcedMemoryCount = Number(counts?.sourced_memory_count ?? 0);
  if (memoryCount <= 0) {
    throw new Error(`parent_version_activation_empty:${versionId}`);
  }
  if (sourcedMemoryCount !== memoryCount) {
    throw new Error(`parent_version_activation_missing_provenance:${versionId}`);
  }
}

async function activateObservationParentVersion(
  env: Env,
  row: Pick<ObservationExtractionRow, "metadata_json">,
  options: { state?: "active" | "active_degraded"; requireComplete?: boolean } = {}
): Promise<void> {
  const parent = parentVersionFromObservationMetadata(row.metadata_json);
  if (!parent) return;
  await assertParentVersionReadyForActivation(env, parent.versionId, options.requireComplete !== false);
  const results = await env.DB.batch(prepareParentVersionActivation(env.DB, {
    parentId: parent.parentId,
    versionId: parent.versionId,
    state: options.state ?? "active",
    updatedAt: Date.now(),
  }));
  const activated = Number(results[0]?.meta?.changes ?? 0);
  const parentUnitUpdated = Number(results[1]?.meta?.changes ?? 0);
  if (activated !== 1 || parentUnitUpdated !== 1) {
    throw new Error(`parent_version_activation_failed:${parent.versionId}`);
  }
}

async function failObservationParentVersion(env: Env, row: Pick<ObservationExtractionRow, "metadata_json">): Promise<void> {
  const parent = parentVersionFromObservationMetadata(row.metadata_json);
  if (!parent) return;
  await prepareParentVersionFailure(env.DB, {
    versionId: parent.versionId,
    updatedAt: Date.now(),
  }).run();
}

async function leaseObservationForExtraction(
  env: Env,
  row: Pick<ObservationExtractionRow, "id">,
  now: number
): Promise<boolean> {
  const leaseCutoff = now - ATOMIC_EXTRACTION_LEASE_MS;
  const result = await env.DB.prepare(
    `UPDATE sb_observations
     SET extraction_status = 'processing',
         extraction_attempts = CASE
           WHEN COALESCE(extraction_version, 0) < ? THEN 1
           ELSE COALESCE(extraction_attempts, 0) + 1
         END,
         extraction_error = NULL,
         next_attempt_at = NULL,
         processing_started_at = ?,
         extraction_version = ?
     WHERE id = ?
       AND COALESCE(extraction_attempts, 0) < ?
       AND (
         extraction_status = 'pending'
         OR (extraction_status = 'retryable_error' AND COALESCE(next_attempt_at, 0) <= ?)
         OR (extraction_status = 'processing' AND COALESCE(processing_started_at, 0) <= ?)
         OR (extraction_status = 'fallback' AND COALESCE(needs_reprocess, 0) = 1)
         OR (extraction_status = 'partial_error' AND COALESCE(needs_reprocess, 0) = 1)
         OR COALESCE(extraction_version, 0) < ?
       )`
  )
    .bind(
      ATOMIC_EXTRACTION_VERSION,
      now,
      ATOMIC_EXTRACTION_VERSION,
      row.id,
      ATOMIC_EXTRACTION_MAX_ATTEMPTS,
      now,
      leaseCutoff,
      ATOMIC_EXTRACTION_VERSION
    )
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

async function readObservationLease(
  env: Env,
  id: string
): Promise<{ attempts: number; startedAt: number | null } | null> {
  const row = await env.DB.prepare(
    `SELECT extraction_attempts, processing_started_at
     FROM sb_observations
     WHERE id = ?`
  )
    .bind(id)
    .first<{ extraction_attempts: number; processing_started_at: number | null }>();
  if (!row) return null;
  return {
    attempts: Number(row.extraction_attempts ?? 0),
    startedAt: row.processing_started_at == null ? null : Number(row.processing_started_at),
  };
}

async function markObservationExtractionSucceeded(
  env: Env,
  input: { id: string; startedAt: number | null; processedAt: number }
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sb_observations
     SET extraction_status = 'succeeded',
         extraction_error = NULL,
         next_attempt_at = NULL,
         processing_started_at = NULL,
         processed_at = ?,
         needs_reprocess = 0,
         extraction_version = ?
     WHERE id = ?
       AND (processing_started_at = ? OR ? IS NULL)`
  )
    .bind(
      input.processedAt,
      ATOMIC_EXTRACTION_VERSION,
      input.id,
      input.startedAt,
      input.startedAt
    )
    .run();
}

async function markObservationExtractionFailure(
  env: Env,
  input: {
    id: string;
    startedAt: number | null;
    status: Exclude<ObservationExtractionStatus, "pending" | "processing" | "succeeded">;
    error: string;
    nextAttemptAt: number | null;
    processedAt: number | null;
    needsReprocess: boolean;
  }
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sb_observations
     SET extraction_status = ?,
         extraction_error = ?,
         next_attempt_at = ?,
         processing_started_at = NULL,
         processed_at = ?,
         needs_reprocess = ?,
         extraction_version = ?
     WHERE id = ?
       AND (processing_started_at = ? OR ? IS NULL)`
  )
    .bind(
      input.status,
      input.error,
      input.nextAttemptAt,
      input.processedAt,
      input.needsReprocess ? 1 : 0,
      ATOMIC_EXTRACTION_VERSION,
      input.id,
      input.startedAt,
      input.startedAt
    )
    .run();
}

async function markObservationAtomicPartialError(
  env: Env,
  input: { id: string; error: string; processedAt: number }
): Promise<void> {
  await markObservationExtractionFailure(env, {
    id: input.id,
    startedAt: null,
    status: "partial_error",
    error: input.error,
    nextAttemptAt: null,
    processedAt: input.processedAt,
    needsReprocess: true,
  });
}

async function captureExtractedFactsFromObservation(
  row: Pick<ObservationExtractionRow, "id" | "content" | "source" | "metadata_json" | "created_at">,
  facts: AtomicFactDraft[],
  env: Env,
  ctx: ExecutionContext
): Promise<CaptureResult> {
  const baseTags = tagsFromObservationMetadata(row.metadata_json);
  const parentVersion = parentVersionFromObservationMetadata(row.metadata_json);
  if (facts.length <= 1) {
    const draft = facts[0] ?? fallbackAtomicDraft(row.content, row.created_at);
    return captureSingleFact(draft.content || row.content, baseTags, row.source, env, ctx, {
      skipExtract: true,
      observationId: row.id,
      parentVersionId: parentVersion?.versionId ?? null,
      evidenceRootId: parentVersion?.evidenceRootId ?? row.id,
      atomic: draft,
    });
  }

  const results: CaptureSingleResult[] = [];
  for (const draft of facts) {
    const result = await captureSingleFact(draft.content, baseTags, row.source, env, ctx, {
      skipExtract: true,
      observationId: row.id,
      parentVersionId: parentVersion?.versionId ?? null,
      evidenceRootId: parentVersion?.evidenceRootId ?? row.id,
      atomic: draft,
    });
    results.push(result);
  }

  if (results.length && results.every((result) => result.status === "blocked")) {
    const first = results[0];
    if (first.status === "blocked") return first;
  }

  return { status: "batch", observationId: row.id, results };
}

async function loadPreviousEvidenceRevisions(
  env: Env,
  current: ObservationExtractionRow,
  limit = 5
): Promise<EvidenceRevisionInput[]> {
  const revisions: EvidenceRevisionInput[] = [];
  const seen = new Set<string>();
  let cursor = current.previous_evidence_id ?? null;
  const vaultIdFromMetadata = (metadataJson: string | null | undefined): string | null => {
    try {
      const value = JSON.parse(metadataJson || "{}") as Record<string, unknown>;
      return typeof value.vault_id === "string" ? value.vault_id : null;
    } catch {
      return null;
    }
  };
  let currentLink: EvidenceRevisionInput = {
    id: current.id,
    content: current.content,
    rootEvidenceId: current.root_evidence_id ?? current.id,
    sourceIdentity: current.source_identity ?? null,
    sourceChannel: current.source_channel ?? current.source,
    revision: current.revision ?? null,
    vaultId: vaultIdFromMetadata(current.metadata_json),
  };
  while (cursor && revisions.length < limit && !seen.has(cursor)) {
    seen.add(cursor);
    const row = await env.DB.prepare(
      `SELECT id, content, content_hash, source_timestamp, previous_evidence_id,
              root_evidence_id, source_identity, source_channel, revision, metadata_json
       FROM sb_observations
       WHERE id = ?
       LIMIT 1`
    ).bind(cursor).first<{
      id: string;
      content: string;
      source_timestamp: number | null;
      previous_evidence_id: string | null;
      content_hash: string | null;
      root_evidence_id: string | null;
      source_identity: string | null;
      source_channel: string | null;
      revision: number | null;
      metadata_json: string;
    }>();
    if (!row) break;
    const previousLink: EvidenceRevisionInput = {
      id: row.id,
      content: row.content,
      sourceTimestamp: row.source_timestamp,
      rootEvidenceId: row.root_evidence_id,
      sourceIdentity: row.source_identity,
      sourceChannel: row.source_channel,
      revision: row.revision,
      vaultId: vaultIdFromMetadata(row.metadata_json),
    };
    if (!isValidEvidenceRevisionLink(currentLink, previousLink)) {
      console.warn("Evidence revision lineage mismatch; previous context ignored", {
        currentEvidenceId: currentLink.id,
        previousEvidenceId: row.id,
      });
      break;
    }
    if (row.content_hash && await contentFingerprint(row.content) !== row.content_hash) {
      console.warn("Evidence revision content hash mismatch; previous context ignored", {
        previousEvidenceId: row.id,
      });
      break;
    }
    revisions.push(previousLink);
    currentLink = previousLink;
    cursor = row.previous_evidence_id;
  }
  return revisions;
}

async function processObservationExtraction(
  row: ObservationExtractionRow,
  env: Env,
  ctx: ExecutionContext,
  options: { fallbackOnError?: boolean } = {}
): Promise<ObservationExtractionProcessResult> {
  const startedAt = Date.now();
  const statusBeforeLease = row.extraction_status;
  const leased = await leaseObservationForExtraction(env, row, startedAt);
  if (!leased) return { status: "skipped", observationId: row.id };

  const lease = await readObservationLease(env, row.id);
  const attempts = lease?.attempts ?? Number(row.extraction_attempts ?? 0) + 1;
  const processingStartedAt = lease?.startedAt ?? startedAt;
  const processingRow = await prepareObservationParentVersionForProcessing(env, row, statusBeforeLease);

  let facts: AtomicFactDraft[];
  try {
    facts = await extractAtomicFacts(processingRow.content, env, {
      evidenceId: processingRow.id,
      previousEvidence: await loadPreviousEvidenceRevisions(env, processingRow),
    });
  } catch (error) {
    const message = atomicExtractionErrorMessage(error);
    const now = Date.now();
    if (options.fallbackOnError) {
      const result = await captureExtractedFactsFromObservation(
        processingRow,
        [fallbackAtomicDraft(processingRow.content, processingRow.created_at)],
        env,
        ctx
      );
      const failures = captureResultFailures(result);
      if (failures.length) {
        await failObservationParentVersion(env, processingRow);
        return {
          status: "failed",
          observationId: row.id,
          error: failures[0].reason,
          final: false,
          result,
        };
      }
      await markObservationExtractionFailure(env, {
        id: row.id,
        startedAt: processingStartedAt,
        status: "fallback",
        error: message,
        nextAttemptAt: null,
        processedAt: now,
        needsReprocess: true,
      });
      await activateObservationParentVersion(env, processingRow, { state: "active_degraded" });
      return { status: "fallback", observationId: row.id, result, error: message };
    }

    const final = attempts >= ATOMIC_EXTRACTION_MAX_ATTEMPTS;
    await markObservationExtractionFailure(env, {
      id: row.id,
      startedAt: processingStartedAt,
      status: final ? "terminal_error" : "retryable_error",
      error: message,
      nextAttemptAt: final ? null : now + atomicExtractionBackoffMs(attempts),
      processedAt: final ? now : null,
      needsReprocess: Boolean(row.needs_reprocess),
    });
    if (final) await failObservationParentVersion(env, processingRow);
    return { status: "failed", observationId: row.id, error: message, final };
  }

  const result = await captureExtractedFactsFromObservation(processingRow, facts, env, ctx);
  const failures = captureResultFailures(result);
  if (failures.length) {
    await failObservationParentVersion(env, processingRow);
    return {
      status: "failed",
      observationId: row.id,
      error: failures[0].reason,
      final: false,
      result,
    };
  }
  await markObservationExtractionSucceeded(env, {
    id: row.id,
    startedAt: processingStartedAt,
    processedAt: Date.now(),
  });
  await activateObservationParentVersion(env, processingRow);
  return { status: "succeeded", observationId: row.id, result };
}

export async function processExtractionQueue(
  env: Env,
  ctx: ExecutionContext,
  limit = ATOMIC_EXTRACTION_DEFAULT_LIMIT
): Promise<{
  processed: number;
  failed: number;
  skipped: number;
  fallback: number;
  remaining: number;
  deferred: number;
  exhausted: number;
}> {
  const now = Date.now();
  const leaseCutoff = now - ATOMIC_EXTRACTION_LEASE_MS;
  const boundedLimit = boundedExtractionLimit(env, limit);

  const { results } = await env.DB.prepare(
    `SELECT id, content, source, metadata_json, created_at, content_hash,
            previous_evidence_id, root_evidence_id, source_identity,
            source_channel, revision,
            extraction_status, extraction_version, extraction_attempts,
            extraction_error, next_attempt_at, processing_started_at,
            processed_at, needs_reprocess
     FROM sb_observations
     WHERE COALESCE(extraction_attempts, 0) < ?
       AND (
         extraction_status = 'pending'
         OR (extraction_status = 'retryable_error' AND COALESCE(next_attempt_at, 0) <= ?)
         OR (extraction_status = 'processing' AND COALESCE(processing_started_at, 0) <= ?)
         OR (extraction_status = 'fallback' AND COALESCE(needs_reprocess, 0) = 1)
         OR (extraction_status = 'partial_error' AND COALESCE(needs_reprocess, 0) = 1)
         OR COALESCE(extraction_version, 0) < ?
       )
     ORDER BY created_at ASC
     LIMIT ?`
  )
    .bind(
      ATOMIC_EXTRACTION_MAX_ATTEMPTS,
      now,
      leaseCutoff,
      ATOMIC_EXTRACTION_VERSION,
      boundedLimit
    )
    .all<ObservationExtractionRow>();

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let fallback = 0;

  for (const row of results) {
    const result = await processObservationExtraction(row, env, ctx);
    if (result.status === "succeeded") {
      await finalizeObsidianObservationExtraction(env, row);
      processed += 1;
    } else if (result.status === "failed") {
      failed += 1;
    } else if (result.status === "fallback") {
      await finalizeObsidianObservationExtraction(env, row);
      fallback += 1;
    } else {
      skipped += 1;
    }
  }

  const queue = await readExtractionQueueSnapshot(env.DB, now);

  return {
    processed,
    failed,
    skipped,
    fallback,
    remaining: queue.due,
    deferred: queue.deferred,
    exhausted: queue.exhausted,
  };
}

function boundedExtractionLimit(env: Env, limit: unknown): number {
  return Math.min(
    Math.max(Number(limit) || ATOMIC_EXTRACTION_DEFAULT_LIMIT, 1),
    env.SELFHOST === "1" ? ATOMIC_EXTRACTION_SELFHOST_LIMIT : ATOMIC_EXTRACTION_CLOUDFLARE_LIMIT
  );
}

export async function inspectExtractionQueue(
  env: Env,
  limit = ATOMIC_EXTRACTION_DEFAULT_LIMIT
): Promise<ExtractionQueueDryRunResult> {
  const now = Date.now();
  const leaseCutoff = now - ATOMIC_EXTRACTION_LEASE_MS;
  const boundedLimit = boundedExtractionLimit(env, limit);

  const queue = await readExtractionQueueSnapshot(env.DB, now);

  const orphanPending = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM sb_observations
     WHERE extraction_status = 'pending'
       AND COALESCE(extraction_attempts, 0) = 0
       AND NOT EXISTS (
         SELECT 1 FROM sb_memory_sources
         WHERE sb_memory_sources.observation_id = sb_observations.id
       )`
  )
    .first<{ count: number }>();

  const fallbackReprocess = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM sb_observations
     WHERE extraction_status = 'fallback'
       AND COALESCE(needs_reprocess, 0) = 1
       AND COALESCE(extraction_attempts, 0) < ?`
  )
    .bind(ATOMIC_EXTRACTION_MAX_ATTEMPTS)
    .first<{ count: number }>();

  const partialError = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM sb_observations
     WHERE extraction_status = 'partial_error'
       AND COALESCE(needs_reprocess, 0) = 1
       AND COALESCE(extraction_attempts, 0) < ?`
  )
    .bind(ATOMIC_EXTRACTION_MAX_ATTEMPTS)
    .first<{ count: number }>();

  const retryableDue = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM sb_observations
     WHERE extraction_status = 'retryable_error'
       AND COALESCE(extraction_attempts, 0) < ?
       AND COALESCE(next_attempt_at, 0) <= ?`
  )
    .bind(ATOMIC_EXTRACTION_MAX_ATTEMPTS, now)
    .first<{ count: number }>();

  const staleProcessing = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM sb_observations
     WHERE extraction_status = 'processing'
       AND COALESCE(extraction_attempts, 0) < ?
       AND COALESCE(processing_started_at, 0) <= ?`
  )
    .bind(ATOMIC_EXTRACTION_MAX_ATTEMPTS, leaseCutoff)
    .first<{ count: number }>();

  return {
    dryRun: true,
    limit: boundedLimit,
    due: queue.due,
    deferred: queue.deferred,
    exhausted: queue.exhausted,
    orphanPending: Number(orphanPending?.count ?? 0),
    fallbackReprocess: Number(fallbackReprocess?.count ?? 0),
    partialError: Number(partialError?.count ?? 0),
    retryableDue: Number(retryableDue?.count ?? 0),
    staleProcessing: Number(staleProcessing?.count ?? 0),
  };
}

function atomicTagsFromDraft(baseTags: string[], draft: AtomicFactDraft | undefined): string[] {
  let tags = [...baseTags];
  if (draft?.kind) tags = withKind(tags, draft.kind);
  if (draft?.memoryClass) {
    const classTag = `class:${draft.memoryClass}`;
    if (!tags.includes(classTag) && isD1SafeTag(classTag)) tags = [...tags, classTag];
  }
  return tags;
}

async function dualWriteAtomicMemory(
  env: Env,
  input: {
    entryId: string;
    content: string;
    contentHash: string;
    observationId: string;
    parentVersionId?: string | null;
    evidenceRootId?: string | null;
    atomic?: AtomicFactDraft;
    createdAt: number;
  }
): Promise<AtomicWriteResult> {
  const memoryId = crypto.randomUUID();
  try {
    const statements = [
      prepareAtomicMemoryInsert(env.DB, {
        id: memoryId,
        content: input.content,
        kind: input.atomic?.kind ?? null,
        memoryClass: input.atomic?.memoryClass ?? null,
        importance: input.atomic?.importance ?? null,
        confidence: input.atomic?.confidence ?? null,
        entryId: input.entryId,
        parentVersionId: input.parentVersionId ?? null,
        claimSubject: input.atomic?.subject ?? null,
        claimPredicate: input.atomic?.predicate ?? null,
        claimObject: input.atomic?.object ?? null,
        scopeId: input.atomic?.scopeId ?? null,
        polarity: input.atomic?.polarity ?? "positive",
        modality: input.atomic?.modality ?? "asserted",
        claimStatus: input.atomic?.status ?? "supported",
        contentHash: input.contentHash,
        observedAt: input.atomic?.observedAt ?? input.createdAt,
        validFrom: input.atomic?.validFrom ?? null,
        validTo: input.atomic?.validTo ?? null,
        referenceTime: input.atomic?.referenceTime ?? null,
        invalidAt: null,
        entitiesJson: JSON.stringify(input.atomic?.entities ?? []),
        createdAt: input.createdAt,
      }),
      prepareMemorySourceInsert(env.DB, {
        id: crypto.randomUUID(),
        memoryId,
        observationId: input.observationId,
        role: "derived_from",
        relation: "supports",
        score: input.atomic?.confidence ?? null,
        evidenceScore: input.atomic?.confidence ?? null,
        derivationConfidence: input.atomic?.confidence ?? null,
        evidenceRootId: input.evidenceRootId ?? input.observationId,
        createdAt: input.createdAt,
      }),
    ];
    if (input.parentVersionId) {
      statements.push(
        prepareParentVersionClaimInsert(env.DB, {
          parentVersionId: input.parentVersionId,
          memoryId,
          relation: "supports",
          createdAt: input.createdAt,
        })
      );
    }
    await env.DB.batch(statements);

    // Entity graph dual-write (mentions + optional temporal fact edges).
    if (input.atomic?.entities?.length || input.atomic?.relations?.length) {
      let entityEmbeddingSnapshot: Promise<ActiveEmbeddingSnapshot> | null = null;
      await attachEntitiesToMemory(env.DB, {
        memoryId,
        observationId: input.observationId,
        entities: input.atomic.entities ?? [],
        relations: input.atomic.relations ?? [],
        score: input.atomic.confidence ?? null,
        validFrom: input.atomic.validFrom ?? null,
        validTo: input.atomic.validTo ?? null,
        referenceTime: input.atomic.referenceTime ?? null,
        scopeId: input.atomic.scopeId ?? null,
        polarity: input.atomic.polarity ?? "positive",
        modality: input.atomic.modality ?? "asserted",
        resolveEntityEmbeddings: async (names) => {
          entityEmbeddingSnapshot ??= loadActiveEmbeddingSnapshot(env);
          const snapshot = await entityEmbeddingSnapshot;
          const vectors = await embedManyWithProvider(snapshot.provider, names, "document");
          if (vectors.length !== names.length) {
            throw new Error("Entity embedding batch size mismatch");
          }
          return {
            embeddings: new Map(names.map((name, index) => [name, vectors[index]])),
            fingerprint: snapshot.fingerprint,
          };
        },
        createdAt: input.createdAt,
      });
    }
    return { ok: true, memoryId };
  } catch (e) {
    console.error("Atomic memory dual-write failed (non-fatal):", e);
    return { ok: false, error: atomicExtractionErrorMessage(e) };
  }
}

/** Persist one atomic fact into legacy entries (+ optional sb_memories dual-write). */
async function captureSingleFact(
  rawContent: string,
  tags: string[],
  source: string,
  env: Env,
  ctx: ExecutionContext,
  options: CaptureOptions = {}
): Promise<CaptureSingleResult> {
  const raw = rawContent.trim();
  const { cleanContent, hashtags } = extractHashtags(raw);
  const c = cleanContent || raw;
  let t = [...new Set([
    ...tags.map(tag => tag.toLowerCase()).filter(isD1SafeTag),
    ...hashtags,
  ])];
  t = atomicTagsFromDraft(t, options.atomic);

  const contentHash = await contentFingerprint(c);
  const exactId = await findExactDuplicateId(env, c, contentHash);
  if (exactId) {
    if (options.observationId) {
      try {
        const linked = await linkObservationToAtomicMemory(env.DB, {
          entryId: exactId,
          content: c,
          contentHash,
          observationId: options.observationId,
          parentVersionId: options.parentVersionId ?? null,
          evidenceRootId: options.evidenceRootId ?? options.observationId,
          atomic: options.atomic,
          createdAt: Date.now(),
        });
        return {
          status: "sourced",
          id: exactId,
          observationId: options.observationId,
          memoryId: linked.memoryId,
        };
      } catch (e) {
        console.error("Duplicate source link failed; preserving legacy duplicate block:", e);
        await markObservationAtomicPartialError(env, {
          id: options.observationId,
          error: atomicExtractionErrorMessage(e),
          processedAt: Date.now(),
        });
      }
    }
    return { status: "blocked", matchId: exactId, score: 1 };
  }

  const { duplicate: dup, contradiction, mergeAction } = await checkDuplicateAndContradiction(c, env);

  if (dup.status === "blocked") {
    return { status: "blocked", matchId: dup.matchId, score: dup.score };
  }

  const relationPlan = await planCaptureRelation(dup, contradiction, mergeAction, env);

  const id = crypto.randomUUID();
  const now = Date.now();
  const baseTags = contradiction.detected ? [...t, "contradiction-resolved"] : t;
  let finalTags = dup.status === "flagged" ? [...baseTags, "duplicate-candidate"] : baseTags;
  if (relationPlan?.forceDraft) {
    finalTags = withStatus(finalTags, "draft");
    finalTags = withStatusSource(finalTags, "relation");
  }

  // Prefer extractor scores when present so scheduleClassify can still refine later.
  const importanceSeed = options.atomic?.importance ?? 0;
  const openRebuild = await loadOpenVectorRebuild(env);
  const metadataHash = await entryMetadataFingerprint({ source, tags: finalTags });

  const insertStatement = env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash, metadata_hash, importance_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, c, JSON.stringify(finalTags), source, now, "[]", contentHash, metadataHash, importanceSeed);
  const revision = prepareMemoryRevision(env.DB, {
    memoryId: id,
    eventType: "ADD",
    newContent: c,
    newMetadata: {
      tags: finalTags,
      source,
      memory_class: options.atomic?.memoryClass ?? null,
      observation_id: options.observationId ?? null,
    },
    actor: source,
    createdAt: now,
  });
  const statements = [insertStatement, revision.statement];
  if (relationPlan) {
    statements.push(prepareMemoryRelation(env.DB, {
      fromMemoryId: id,
      toMemoryId: relationPlan.toMemoryId,
      relationType: relationPlan.relationType,
      score: relationPlan.score,
      metadata: relationPlan.metadata,
      createdAt: now,
    }).statement);
  }
  if (openRebuild) {
    statements.push(
      env.DB.prepare(
        `UPDATE entries
         SET pending_vector_ids = '[]',
             pending_embedding_fingerprint = ?,
             pending_content_hash = NULL,
             pending_revision_id = NULL,
             pending_metadata_hash = NULL,
             pending_rebuild_id = ?
         WHERE id = ?
           AND tags NOT LIKE '%"status:deprecated"%'
           AND EXISTS (
             SELECT 1
             FROM sb_vector_rebuilds
             WHERE id = ?
               AND state IN ('queued', 'building', 'ready')
           )`
      ).bind(openRebuild.pendingFingerprint, openRebuild.id, id, openRebuild.id),
      env.DB.prepare(
        `UPDATE sb_vector_rebuilds
         SET expected_entries = expected_entries + 1,
             updated_at = ?
         WHERE id = ?
           AND state IN ('queued', 'building', 'ready')
           AND EXISTS (
             SELECT 1
             FROM entries
             WHERE id = ?
               AND pending_rebuild_id = ?
           )`
      ).bind(now, openRebuild.id, id, openRebuild.id)
    );
  }
  const mergeSuggestedAction = mergeSuggestedActionFromRelation(relationPlan);
  if (mergeSuggestedAction && relationPlan) {
    statements.push(
      prepareMemoryMergeCandidate(env.DB, {
        sourceMemoryId: id,
        targetMemoryId: relationPlan.toMemoryId,
        similarity: relationPlan.score,
        suggestedAction: mergeSuggestedAction,
        reason: relationPlanReason(relationPlan),
        createdAt: now,
      }).statement
    );
  }
  if (contradiction.detected && contradiction.conflicting_id) {
    statements.push(
      prepareConflictCase(env.DB, {
        oldMemoryId: contradiction.conflicting_id,
        newMemoryId: id,
        conflictType: "contradiction",
        reason: contradiction.reason ?? null,
        confidence: relationPlan?.score ?? (dup.status === "flagged" ? dup.score : 0.5),
        createdAt: now,
      }).statement
    );
  }
  statements.push((await prepareComplianceAuditEvent(env.DB, {
    actorType: source === "system" ? "system" : "api",
    actorId: source,
    action: "memory.create",
    objectType: "memory",
    objectId: id,
    afterHash: contentHash,
    metadata: {
      source,
      tags: finalTags,
      observation_id: options.observationId ?? null,
      duplicate_status: dup.status,
      relation_type: relationPlan?.relationType ?? null,
      conflict: contradiction.detected,
    },
  })).statement);
  await env.DB.batch(statements);

  let atomicMemoryId: string | null = null;
  if (options.observationId) {
    const atomicWrite = await dualWriteAtomicMemory(env, {
      entryId: id,
      content: c,
      contentHash,
      observationId: options.observationId,
      parentVersionId: options.parentVersionId ?? null,
      evidenceRootId: options.evidenceRootId ?? options.observationId,
      atomic: options.atomic,
      createdAt: now,
    });
    if (!atomicWrite.ok) {
      await markObservationAtomicPartialError(env, {
        id: options.observationId,
        error: atomicWrite.error,
        processedAt: Date.now(),
      });
      await deprecateEntry(
        id,
        env,
        `Atomic memory write failed for observation ${options.observationId}: ${atomicWrite.error}`,
        "system"
      );
      return {
        status: "failed",
        id,
        reason: atomicWrite.error,
      };
    }
    atomicMemoryId = atomicWrite.memoryId;
    if (contradiction.detected && contradiction.conflicting_id) {
      try {
        await linkPendingEntryConflictClaims(env.DB, {
          oldEntryId: contradiction.conflicting_id,
          newEntryId: id,
          asOf: now,
        });
      } catch (error) {
        console.error("Entry conflict Claim linking failed (non-fatal):", error);
      }
    }
  }

  logMemoryEvent(id, "created", {
    source,
    tags: finalTags,
    observation_id: options.observationId ?? null,
    memory_class: options.atomic?.memoryClass ?? null,
  }, source);
  if (relationPlan) {
    logMemoryEvent(id, "linked", {
      to_memory_id: relationPlan.toMemoryId,
      relation_type: relationPlan.relationType,
      score: relationPlan.score,
    }, source);
  }

  const entryVectorTask = storeEntry(env, id, c, finalTags, source, now);
  ctx.waitUntil(entryVectorTask
    .then(() => logMemoryEvent(id, "vectorized", {}, source))
    .catch(e => console.error("Vectorize insert failed (non-fatal):", e)));
  if (atomicMemoryId) {
    ctx.waitUntil((async () => {
      const snapshot = await loadActiveEmbeddingSnapshot(env);
      await enqueueClaimVectorJob(env.DB, {
        claimId: atomicMemoryId,
        targetFingerprint: snapshot.fingerprint,
      });
      await processClaimVectorQueue(env, {
        targetFingerprint: snapshot.fingerprint,
        limit: 1,
      });
    })()
      .catch(error => console.error(
        "Claim vector queue failed; historical keyword recall remains available:",
        error
      )));
  }

  // Skip async classify when extractor already provided kind + scores.
  if (!options.atomic?.kind) {
    scheduleClassifyAndTag(id, c, env, ctx);
  } else if (options.atomic.kind) {
    // Persist extractor kind immediately already in tags; still queue classify for confidence refresh
    // only when confidence missing.
    if (options.atomic.confidence == null) {
      scheduleClassifyAndTag(id, c, env, ctx);
    } else {
      // Mark classification succeeded with extractor fields (no extra LLM).
      try {
        await env.DB.prepare(
          `UPDATE entries
           SET importance_score = ?, classification_confidence = ?,
               classification_status = 'succeeded', classification_error = NULL,
               classification_attempts = 1, classification_next_attempt_at = NULL,
               classification_started_at = NULL, classification_version = ?,
               classified_at = ?
           WHERE id = ?`
        ).bind(
          options.atomic.importance ?? 3,
          options.atomic.confidence,
          CURRENT_CLASSIFICATION_VERSION,
          now,
          id
        ).run();
        const classifyRevision = prepareMemoryRevision(env.DB, {
          memoryId: id,
          eventType: "CLASSIFY",
          oldContent: c,
          newContent: c,
          oldMetadata: { tags: finalTags },
          newMetadata: {
            tags: finalTags,
            importance: options.atomic.importance,
            confidence: options.atomic.confidence,
            kind: options.atomic.kind,
            memory_class: options.atomic.memoryClass,
            classification_version: CURRENT_CLASSIFICATION_VERSION,
            source: "atomic_extractor",
          },
          reason: "Atomic extraction classification",
          actor: "extractor",
          createdAt: now,
        });
        await classifyRevision.statement.run();
      } catch (e) {
        console.error("Extractor classification persist failed (non-fatal):", e);
        scheduleClassifyAndTag(id, c, env, ctx);
      }
    }
  }

  if (contradiction.detected && contradiction.conflicting_id) {
    const conflictId = contradiction.conflicting_id;
    const conflictRow = await env.DB.prepare(
      `SELECT tags FROM entries WHERE id = ?`
    ).bind(conflictId).first() as Record<string, any> | null;
    const conflictStatus = conflictRow ? getStatus(JSON.parse(conflictRow.tags ?? "[]")) : null;

    if (conflictStatus === "canonical") {
      const draftTags = finalTags.filter(t => t !== "contradiction-resolved");
      let nextTags = withStatus(draftTags, "draft");
      nextTags = withStatusSource(nextTags, "relation");
      const statusRevision = prepareMemoryRevision(env.DB, {
        memoryId: id,
        eventType: "STATUS",
        oldContent: c,
        newContent: c,
        oldMetadata: { tags: finalTags, source },
        newMetadata: { tags: nextTags, source },
        reason: `Conflicts with canonical memory ${conflictId}`,
        actor: "system",
      });
      const metadataHash = await entryMetadataFingerprint({ source, tags: nextTags });
      const auditEvent = await prepareComplianceAuditEvent(env.DB, {
        actorType: "system",
        actorId: "contradiction-protection",
        action: "memory.status",
        objectType: "memory",
        objectId: id,
        beforeHash: contentHash,
        afterHash: contentHash,
        metadata: {
          from_status: getStatus(finalTags),
          to_status: "draft",
          reason: `Conflicts with canonical memory ${conflictId}`,
          conflict_id: conflictId,
        },
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE entries
           SET tags = ?,
               metadata_hash = ?,
               ${pendingGenerationResetAssignments()}
           WHERE id = ?`
        )
          .bind(JSON.stringify(nextTags), metadataHash, id),
        statusRevision.statement,
        auditEvent.statement,
      ]);
      try {
        await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(conflictId).run();
        await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(id).run();
      } catch (e) {
        console.error("Contradiction count update failed (non-fatal):", e);
      }
      return { status: "contradiction_protected", id, canonicalId: conflictId, reason: contradiction.reason };
    }

    try {
      await env.DB.prepare(`UPDATE entries SET contradiction_wins = contradiction_wins + 1 WHERE id = ?`).bind(id).run();
      await env.DB.prepare(`UPDATE entries SET contradiction_losses = contradiction_losses + 1 WHERE id = ?`).bind(conflictId).run();
    } catch (e) {
      console.error("Contradiction count update failed (non-fatal):", e);
    }
    return { status: "contradiction", id, conflictId, reason: contradiction.reason };
  }

  if (relationPlan) {
    return {
      status: "linked",
      id,
      linkedId: relationPlan.toMemoryId,
      relation: relationPlan.relationType,
      score: relationPlan.score,
    };
  }

  if (dup.status === "flagged") {
    return { status: "flagged", id, matchId: dup.matchId, score: dup.score };
  }

  return { status: "stored", id };
}

/**
 * Capture entry with Observation → Atomic Memory dual-write.
 * Multi-claim inputs are split via one LLM call; each fact becomes its own entry.
 */
export async function captureEntry(
  rawContent: string,
  tags: string[],
  source: string,
  env: Env,
  ctx: ExecutionContext,
  options: CaptureOptions = {}
): Promise<CaptureResult> {
  const raw = rawContent.trim();
  const evidenceContext = options.evidenceContext;
  const { cleanContent, hashtags } = extractHashtags(raw);
  const c = cleanContent || raw;
  const baseTags = [...new Set([
    ...tags.map(tag => tag.toLowerCase()).filter(isD1SafeTag),
    ...hashtags,
  ])];

  const systemLike =
    source === "system" ||
    baseTags.includes("synthesized") ||
    baseTags.includes("auto-pattern");
  const shouldExtract = !options.skipExtract && !systemLike && c.length >= 8;
  let wholeHash: string | null = null;

  // Exact whole-input duplicates do not need LLM extraction, but they are still
  // observations. Preserve the new source evidence against the existing atomic
  // memory instead of dropping the capture before the four-layer path sees it.
  if (!options.skipExtract) {
    wholeHash = await contentFingerprint(c);
    const exactId = await findExactDuplicateId(env, c, wholeHash);
    if (exactId) {
      if (shouldExtract) {
        const observationId = crypto.randomUUID();
        const parentVersionId = crypto.randomUUID();
        const observedAt = Date.now();
        const parentRef: ObservationParentVersionRef = {
          parentId: evidenceContext?.rootEvidenceId ?? observationId,
          versionId: parentVersionId,
          versionNumber: evidenceContext?.revision ?? 1,
          evidenceRootId: evidenceContext?.rootEvidenceId ?? observationId,
        };
        const metadata = {
          ...(evidenceContext?.metadata ?? {}),
          tags: baseTags,
          duplicate_of: exactId,
          ...observationParentVersionMetadata(parentRef),
        };
        try {
          await env.DB.batch([
            prepareObservationInsert(env.DB, {
              id: observationId,
              content: c,
              source,
              metadata,
              contentHash: wholeHash,
              sourceChannel: evidenceContext?.sourceChannel ?? source,
              sourceIdentity: evidenceContext?.sourceIdentity ?? `${source}:${observationId}`,
              authorType: evidenceContext?.authorType ?? evidenceAuthorTypeForSource(source, baseTags),
              sourceUri: evidenceContext?.sourceUri ?? null,
              sourceTimestamp: evidenceContext?.sourceTimestamp ?? observedAt,
              revision: evidenceContext?.revision ?? 1,
              rootEvidenceId: parentRef.evidenceRootId,
              previousEvidenceId: evidenceContext?.previousEvidenceId ?? null,
              extractionStatus: "succeeded",
              processedAt: observedAt,
              createdAt: observedAt,
            }),
            ...prepareObservationParentVersionStatements(env.DB, {
              ...parentRef,
              observationId,
              contentHash: wholeHash,
              metadata,
              tags: baseTags,
              source,
              createdAt: observedAt,
            }),
          ]);
          const linked = await linkObservationToAtomicMemory(env.DB, {
            entryId: exactId,
            content: c,
            contentHash: wholeHash,
            observationId,
            parentVersionId,
            evidenceRootId: parentRef.evidenceRootId,
            createdAt: observedAt,
          });
          await activateObservationParentVersion(env, { metadata_json: JSON.stringify(metadata) }, {
            state: "active_degraded",
          });
          return {
            status: "sourced",
            id: exactId,
            observationId,
            memoryId: linked.memoryId,
          };
        } catch (e) {
          console.error("Duplicate observation source link failed; preserving legacy duplicate block:", e);
          await markObservationAtomicPartialError(env, {
            id: observationId,
            error: atomicExtractionErrorMessage(e),
            processedAt: Date.now(),
          });
        }
      }
      return { status: "blocked", matchId: exactId, score: 1 };
    }
  }

  if (!shouldExtract) {
    return captureSingleFact(c, baseTags, source, env, ctx, {
      ...options,
      skipExtract: true,
    });
  }

  const observationId = crypto.randomUUID();
  const parentVersionId = crypto.randomUUID();
  const observedAt = Date.now();
  const observationHash = wholeHash ?? await contentFingerprint(c);
  const parentRef: ObservationParentVersionRef = {
    parentId: evidenceContext?.rootEvidenceId ?? observationId,
    versionId: parentVersionId,
    versionNumber: evidenceContext?.revision ?? 1,
    evidenceRootId: evidenceContext?.rootEvidenceId ?? observationId,
  };
  const observationMetadata = {
    ...(evidenceContext?.metadata ?? {}),
    tags: baseTags,
    ...observationParentVersionMetadata(parentRef),
  };
  try {
    await env.DB.batch([
      prepareObservationInsert(env.DB, {
        id: observationId,
        content: c,
        source,
        metadata: observationMetadata,
        contentHash: observationHash,
        sourceChannel: evidenceContext?.sourceChannel ?? source,
        sourceIdentity: evidenceContext?.sourceIdentity ?? `${source}:${observationId}`,
        authorType: evidenceContext?.authorType ?? evidenceAuthorTypeForSource(source, baseTags),
        sourceUri: evidenceContext?.sourceUri ?? null,
        sourceTimestamp: evidenceContext?.sourceTimestamp ?? observedAt,
        revision: evidenceContext?.revision ?? 1,
        rootEvidenceId: parentRef.evidenceRootId,
        previousEvidenceId: evidenceContext?.previousEvidenceId ?? null,
        extractionStatus: "pending",
        createdAt: observedAt,
      }),
      ...prepareObservationParentVersionStatements(env.DB, {
        ...parentRef,
        observationId,
        contentHash: observationHash,
        metadata: observationMetadata,
        tags: baseTags,
        source,
        createdAt: observedAt,
      }),
    ]);
  } catch (e) {
    console.error("Observation insert failed; refusing evidence-less capture:", e);
    throw new Error("observation_insert_failed");
  }

  const processed = await processObservationExtraction(
    {
      id: observationId,
      content: c,
      source,
      metadata_json: JSON.stringify(observationMetadata),
      created_at: observedAt,
      content_hash: observationHash,
      extraction_status: "pending",
      extraction_version: ATOMIC_EXTRACTION_VERSION,
      extraction_attempts: 0,
      extraction_error: null,
      next_attempt_at: null,
      processing_started_at: null,
      processed_at: null,
      needs_reprocess: 0,
    },
    env,
    ctx,
    { fallbackOnError: true }
  );
  if (processed.status === "succeeded" || processed.status === "fallback") {
    return processed.result;
  }
  if (processed.status === "failed") {
    if (processed.result) return processed.result;
    throw new Error(processed.error || "atomic_extraction_failed");
  }

  return captureSingleFact(c, baseTags, source, env, ctx, {
    skipExtract: true,
    observationId,
    parentVersionId,
    evidenceRootId: parentRef.evidenceRootId,
  });
}

// ─── Shared delete path ───────────────────────────────────────────────────────
// Used by both the `forget` MCP tool and POST /forget so the cleanup logic
// (D1 row + tracked Vectorize IDs) lives in exactly one place.

export type ForgetResult = ForgetMemoryResult;

export async function forgetEntry(id: string, env: Env): Promise<ForgetResult> {
  return forgetMemoryGraph(id, env.DB, env.VECTORIZE, {
    prepareVectorCleanup: (vectorIds, reason) => {
      const now = Date.now();
      return [...new Set(vectorIds)].filter(Boolean).map((vectorId) =>
        prepareVectorCleanupQueueInsert(env, {
          id: crypto.randomUUID(),
          vectorId,
          reason,
          state: "ready",
          now,
        })
      );
    },
  });
}

// Deprecate (issue #119): keep the D1 row for audit but make the entry
// unrecallable by deleting its vectors and tagging it status:deprecated.
export async function deprecateEntry(
  id: string,
  env: Env,
  reason = "Memory explicitly deprecated",
  actor = "system"
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT content, tags, source, vector_ids, pending_vector_ids, pending_rebuild_id FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;
  if (!row) return false;

  const tags: string[] = JSON.parse(row.tags ?? "[]");
  const nextTags = withStatus(tags, "deprecated");
  const vectorIds: string[] = JSON.parse(row.vector_ids ?? "[]");
  const pendingVectorIds = parseVectorIds(row.pending_vector_ids);
  const pendingRebuildId = typeof row.pending_rebuild_id === "string"
    ? row.pending_rebuild_id
    : null;
  const now = Date.now();
  const idsToDelete = [...new Set([...vectorIds, ...pendingVectorIds])];
  const cleanupStatements = idsToDelete.map((vectorId) =>
    prepareVectorCleanupQueueInsert(env, {
      id: crypto.randomUUID(),
      vectorId,
      reason: "entry_deprecated",
      state: "ready",
      rebuildId: pendingRebuildId,
      now,
    })
  );

  const deprecateRevision = prepareMemoryRevision(env.DB, {
    memoryId: id,
    eventType: "DEPRECATE",
    oldContent: row.content as string,
    newContent: row.content as string,
    oldMetadata: { tags, source: row.source, vectorIds },
    newMetadata: { tags: nextTags, source: row.source, vectorIds: [] },
    reason,
    actor,
    createdAt: now,
  });
  const contentHash = await contentFingerprint(row.content as string);
  const auditEvent = await prepareComplianceAuditEvent(env.DB, {
    actorType: actor === "system" ? "system" : "api",
    actorId: actor,
    action: "memory.deprecate",
    objectType: "memory",
    objectId: id,
    beforeHash: contentHash,
    afterHash: contentHash,
    metadata: {
      reason,
      old_status: getStatus(tags),
      new_status: "deprecated",
      vector_count: vectorIds.length,
      pending_vector_count: pendingVectorIds.length,
    },
  });
  await env.DB.batch([
    ...cleanupStatements,
    env.DB.prepare(
      `UPDATE entries
       SET tags = ?,
           vector_ids = ?,
           pending_vector_ids = NULL,
           pending_embedding_fingerprint = NULL,
           pending_content_hash = NULL,
           pending_revision_id = NULL,
           pending_metadata_hash = NULL,
           pending_rebuild_id = NULL
       WHERE id = ?`
    ).bind(JSON.stringify(nextTags), "[]", id),
    deprecateRevision.statement,
    auditEvent.statement,
    ...(pendingRebuildId
      ? [
          env.DB.prepare(
            `UPDATE sb_vector_rebuilds
             SET expected_entries = MAX(0, expected_entries - 1),
                 updated_at = ?
             WHERE id = ?
               AND state IN ('queued', 'building', 'ready')`
          ).bind(now, pendingRebuildId),
        ]
      : []),
  ]);
  await deprecateEntryAtomicMemory(env.DB, { entryId: id, invalidAt: now });
  await notifyMemoryChanged(env, id, "status");
  return true;
}

// Apply a lifecycle status to an entry (issue #119). 'deprecated' deletes vectors
// (via deprecateEntry); others swap the status:* tag in place. Returns ok=false if no such entry.
export async function applyStatus(id: string, status: MemoryStatus, env: Env): Promise<boolean> {
  if (status === "deprecated") {
    return deprecateEntry(id, env, "Status set to deprecated", "system");
  }
  const row = await env.DB.prepare(
    `SELECT content, tags, source, pending_vector_ids, pending_rebuild_id FROM entries WHERE id = ?`
  ).bind(id).first() as Record<string, any> | null;
  if (!row) return false;
  const tags: string[] = JSON.parse(row.tags ?? "[]");
  let nextTags = withStatus(tags, status);
  nextTags = withStatusSource(nextTags, "user");
  nextTags = nextTags.filter(t => t !== CANONICAL_CANDIDATE_TAG);
  const metadataHash = await entryMetadataFingerprint({
    source: String(row.source ?? "api"),
    tags: nextTags,
  });
  const now = Date.now();
  const cleanupStatements = preparePendingGenerationInvalidation(env, {
    pendingVectorIds: row.pending_vector_ids,
    pendingRebuildId: row.pending_rebuild_id,
    reason: "status_metadata_changed",
    now,
  });
  const statusRevision = prepareMemoryRevision(env.DB, {
    memoryId: id,
    eventType: "STATUS",
    oldContent: row.content as string,
    newContent: row.content as string,
    oldMetadata: { tags, source: row.source },
    newMetadata: { tags: nextTags, source: row.source },
    reason: `Status set to ${status}`,
    actor: "system",
  });
  const contentHash = await contentFingerprint(row.content as string);
  const auditEvent = await prepareComplianceAuditEvent(env.DB, {
    actorType: "system",
    actorId: "status-api",
    action: "memory.status",
    objectType: "memory",
    objectId: id,
    beforeHash: contentHash,
    afterHash: contentHash,
    metadata: {
      from_status: getStatus(tags),
      to_status: status,
      source: row.source,
    },
  });
  const { results: claimRows } = await env.DB.prepare(
    `SELECT id, claim_status, scores_json
     FROM sb_memories
     WHERE entry_id = ?
       AND invalid_at IS NULL
       AND expired_at IS NULL`
  ).bind(id).all<{ id: string; claim_status: string | null; scores_json: string | null }>();
  const claimStatements = (claimRows ?? []).flatMap((claim) => {
    let scores: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(claim.scores_json || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        scores = parsed as Record<string, unknown>;
      }
    } catch {
      scores = {};
    }
    if (status === "canonical") {
      const maturity = typeof scores.maturity === "number" ? scores.maturity : 0;
      return [
        env.DB.prepare(
          `UPDATE sb_memories
           SET claim_status = 'confirmed',
               scores_json = ?
           WHERE id = ?`
        ).bind(JSON.stringify({
          ...scores,
          humanConfirmation: 1,
          maturity: Math.max(maturity, 0.9),
        }), claim.id),
      ];
    }
    if (status === "draft" && claim.claim_status === "confirmed") {
      return [
        env.DB.prepare(
          `UPDATE sb_memories
           SET claim_status = 'supported',
               scores_json = ?
           WHERE id = ?`
        ).bind(JSON.stringify({
          ...scores,
          humanConfirmation: 0,
        }), claim.id),
      ];
    }
    return [];
  });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE entries
       SET tags = ?,
           metadata_hash = ?,
           ${pendingGenerationResetAssignments()}
       WHERE id = ?`
    ).bind(JSON.stringify(nextTags), metadataHash, id),
    ...cleanupStatements,
    ...claimStatements,
    statusRevision.statement,
    auditEvent.statement,
  ]);
  await notifyMemoryChanged(env, id, "status");
  return true;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function buildMcpServer(env: Env, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: "singularity", version: "0.1.0" });

  // ── remember ────────────────────────────────────────────────────────────
  server.registerTool(
    "remember",
    {
      description: "Store an idea, task, or note in your second brain. Call this automatically whenever the user shares context, goals, decisions, or preferences.",
      inputSchema: {
        content: z.string().describe("The idea, task, or note to store"),
        tags: z.array(z.string()).optional().describe("Optional tags for filtering"),
        source: z.string().optional().describe("Ignored compatibility field; server records MCP writes as source=mcp"),
      },
    },
    async ({ content, tags }) => {
      const result = await captureEntry(content, tags ?? [], "mcp", env, ctx);
      return { content: [{ type: "text", text: formatCaptureResultMessage(result) }] };
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

      let appendedContent: string;
      try {
        appendedContent = await appendToEntry(env, id, existingContent, a, tags, source);
      } catch (e) {
        console.error("Append failed:", e);
        return {
          content: [{ type: "text", text: "Append failed. No complete update was recorded; retry later." }],
          isError: true,
        };
      }
      let atomicWarnings: string[] = [];
      try {
        const atomicMutation = await replaceEntryAtomicMemoryAndEnqueue(env, {
          entryId: id,
          content: appendedContent,
          contentHash: await contentFingerprint(appendedContent),
          source: "mcp",
          actor: mutationActorForSource("mcp"),
          eventType: "append",
          createdAt: Date.now(),
        });
        atomicWarnings = atomicMutation.warnings;
      } catch (e) {
        console.error("MCP atomic memory append sync failed (non-fatal):", e);
        return {
          content: [{
            type: "text",
            text: `Append changed entry ${id}, but Evidence/Claim sync failed. Strict recall will exclude it until extraction repair succeeds.`,
          }],
          isError: true,
        };
      }
      scheduleClassifyAndTag(id, appendedContent, env, ctx);

      return {
        content: [{
          type: "text",
          text: `Appended to entry ${id}. The original content is preserved and your update has been added with today's date.${atomicWarnings.length ? " Claim vector indexing is queued for maintenance repair." : ""}`,
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

      // Read the semantic version upfront; vector_ids are refreshed immediately
      // before the guarded switch because background indexing may advance them.
      const row = await env.DB.prepare(
        `SELECT content, tags, source FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) {
        return { content: [{ type: "text", text: `No entry found with ID: ${id}` }] };
      }

      const oldContent = row.content as string;
      const oldTags: string[] = JSON.parse(row.tags ?? "[]");
      const tags = oldTags.filter((t: string) => t !== "rolled-up");
      const source = row.source as string;

      let newVectorIds: string[];
      try {
        newVectorIds = await commitEntryVersion(env, {
          id,
          oldContent,
          newContent,
          oldTags,
          newTags: tags,
          source,
          eventType: "UPDATE",
          reason: "Full content replaced through MCP",
          actor: "mcp",
        });
      } catch (error) {
        console.error("Update vector switch failed:", error);
        return {
          content: [{
            type: "text",
            text: `Update failed for entry ${id}. The previous content and search index remain active.`,
          }],
          isError: true,
        };
      }
      let atomicWarnings: string[] = [];
      try {
        const atomicMutation = await replaceEntryAtomicMemoryAndEnqueue(env, {
          entryId: id,
          content: newContent,
          contentHash: await contentFingerprint(newContent),
          source: "mcp",
          actor: mutationActorForSource("mcp"),
          eventType: "update",
          createdAt: Date.now(),
        });
        atomicWarnings = atomicMutation.warnings;
      } catch (e) {
        console.error("MCP atomic memory update sync failed (non-fatal):", e);
        return {
          content: [{
            type: "text",
            text: `Update changed entry ${id}, but Evidence/Claim sync failed. Strict recall will exclude it until extraction repair succeeds.`,
          }],
          isError: true,
        };
      }
      scheduleClassifyAndTag(id, newContent, env, ctx);

      return {
        content: [{
          type: "text",
          text: `Updated entry ${id}. Re-embedded as ${newVectorIds.length} vector(s).${atomicWarnings.length ? " Claim vector indexing is queued for maintenance repair." : ""}`,
        }],
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
        kind: z.enum([...KIND_VALUES] as [string, ...string[]]).optional().describe("Filter to episodic (events), semantic (facts/knowledge), or procedural (workflows/how-to)"),
        hops: z.number().int().min(0).max(2).default(0).describe("Association expansion depth. Related context is always ranked below direct evidence."),
        associationDirection: z.enum([...ASSOCIATION_DIRECTIONS] as [AssociationDirection, ...AssociationDirection[]])
          .default("outgoing")
          .describe("Traverse directed associations as outgoing, incoming, or both."),
      },
    },
    async ({ query, topK, tag, after, before, kind, hops, associationDirection }) => {
      const {
        matches,
        directEvidence = matches.filter((match) => !match.association),
        relatedContext = matches.filter((match) => Boolean(match.association)),
        insight,
        verifiedClaims = [],
        unverifiedClaims = [],
        conflicts = [],
        retrievalMode = "entry_projection",
        snapshotAt,
        degraded,
        degradedReason,
      } = await recallEntries({
        query,
        topK,
        tag,
        after,
        before,
        kind: kind as MemoryKind | undefined,
        hops,
        associationDirection: associationDirection as AssociationDirection,
      }, env, ctx);

      if (!matches.length) {
        const degradedText = degraded ? ` (${degradedReason ?? "degraded"})` : "";
        return { content: [{ type: "text", text: `Nothing found matching that query.${degradedText}` }] };
      }

      const formatMatch = (m: RecallMatch, ref: string) => {
        const date = new Date(m.createdAt).toLocaleDateString();
        const tagList = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
        const src = m.source ? ` · ${m.source}` : "";
        const relevance = formatRelevanceLabel(m.score);
        const updateLabel = m.isUpdate ? " [updated]" : "";
        const associationLabel = m.association
          ? ` [association:${m.association.viaType}, ${m.association.hop} hop${m.association.hop === 1 ? "" : "s"}]`
          : "";
        const claimState = (m.claims ?? []).length
          ? `\nClaims: ${(m.claims ?? []).map((claim) =>
            `${claim.id}=${claim.verificationStatus}${claim.conflictIds.length ? ` conflicts:${claim.conflictIds.join(",")}` : ""}`
          ).join("; ")}`
          : "";
        return `[${ref}] [${date}${src}${tagList}] (${relevance})${updateLabel}${associationLabel}\n${m.content}${claimState}`;
      };
      const directText = directEvidence
        .map((match, index) => formatMatch(match, `E${index + 1}`))
        .join("\n\n");
      const relatedText = relatedContext
        .map((match, index) => formatMatch(match, `R${index + 1}`))
        .join("\n\n");
      const text = relatedText
        ? `**Direct Evidence:**\n${directText}\n\n**Related Context (not Evidence):**\n${relatedText}`
        : directText;

      const degradedText = degraded ? `**Recall degraded:** ${degradedReason ?? "partial recall"}\n\n---\n\n` : "";
      const conflictText = conflicts.length
        ? `**Unresolved conflicts:**\n${conflicts.map((conflict) =>
          `- ${conflict.id}: ${conflict.claimIds.join(" vs ")}${conflict.reason ? ` (${conflict.reason})` : ""}`
        ).join("\n")}\n\n---\n\n`
        : "";
      const rejectedText = unverifiedClaims.length
        ? `**Rejected unsupported claims:** ${unverifiedClaims.length}\n\n---\n\n`
        : "";
      const verifiedText = verifiedClaims.length
        ? `**Verified answer claims:** ${verifiedClaims.length}\n\n`
        : "";
      const finalText = degradedText + conflictText + rejectedText + verifiedText +
        (insight ? `**Insight:** ${insight}\n\n---\n\n${text}` : text);
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
    "relations",
    {
      description: "Inspect incoming and outgoing evidence links for a memory, including digests, patterns, contradictions, continuations, and superseding facts.",
      inputSchema: {
        id: z.string().min(1).describe("Memory ID from recall or list_recent"),
        limit: z.number().int().min(1).max(100).default(50).describe("Maximum relations to return"),
      },
    },
    async ({ id, limit }) => {
      const relations = await listMemoryRelations(env.DB, id, limit);
      if (!relations.length) {
        return { content: [{ type: "text", text: `No relations found for entry ${id}.` }] };
      }
      const text = relations.map((relation, index) => {
        const endpoint = relation.direction === "outgoing" ? "to" : "from";
        const score = relation.score == null ? "" : ` · score ${(relation.score * 100).toFixed(0)}%`;
        const content = relation.other.content ? `\n${relation.other.content}` : "";
        return `${index + 1}. ${relation.direction} ${relation.relation} ${endpoint} ${relation.other.id}${score}${content}`;
      }).join("\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "link",
    {
      description: "Create a non-authoritative navigation association between two recalled memories. Association links expand context but never become factual evidence.",
      inputSchema: {
        source_id: z.string().min(1).max(512).describe("Source entry ID from recall or list_recent"),
        target_id: z.string().min(1).max(512).describe("Target entry ID from recall or list_recent"),
        type: AssociationEdgeTypeSchema.default("related_to").describe("Association type"),
        valid_from: z.number().int().nonnegative().optional().describe("Association validity start in Unix ms"),
        valid_to: z.number().int().nonnegative().optional().describe("Association validity end in Unix ms"),
      },
    },
    async ({ source_id, target_id, type, valid_from, valid_to }) => {
      try {
        const edge = await createAssociationEdge(env.DB, {
          source: source_id,
          target: target_id,
          edgeType: type,
          weight: 1,
          provenance: "manual",
          validFrom: valid_from,
          validTo: valid_to,
        });
        await safeRecordComplianceAuditEvent(env, {
          actorType: "mcp",
          actorId: "mcp",
          action: "association.linked",
          objectType: "association_edge",
          objectId: edge.id,
          success: true,
          metadata: {
            sourceParentId: edge.sourceParentId,
            targetParentId: edge.targetParentId,
            edgeType: edge.edgeType,
          },
        });
        return {
          content: [{
            type: "text",
            text: `Associated ${source_id} with ${target_id} (${edge.edgeType}). This is navigation context, not Fact evidence.`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Association link failed." }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "unlink",
    {
      description: "Remove a navigation association between two memories without changing Claims or Fact edges.",
      inputSchema: {
        source_id: z.string().min(1).max(512),
        target_id: z.string().min(1).max(512),
        type: AssociationEdgeTypeSchema.optional(),
        effective_at: z.number().int().nonnegative().optional(),
      },
    },
    async ({ source_id, target_id, type, effective_at }) => {
      try {
        const deleted = await deleteAssociationEdge(env.DB, {
          source: source_id,
          target: target_id,
          edgeType: type,
          asOf: effective_at,
        });
        await safeRecordComplianceAuditEvent(env, {
          actorType: "mcp",
          actorId: "mcp",
          action: "association.unlinked",
          objectType: "association_edge",
          objectId: `${source_id}:${target_id}:${type ?? "*"}`,
          success: true,
          metadata: { deleted, edgeType: type ?? null },
        });
        return {
          content: [{
            type: "text",
            text: deleted
              ? `Removed ${deleted} association(s).`
              : "No matching association was present.",
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Association unlink failed." }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "connections",
    {
      description: "List one-hop navigation associations for a recalled memory. Use relations when you need evidence or lifecycle links.",
      inputSchema: {
        id: z.string().min(1).max(512).describe("Entry ID from recall or list_recent"),
        type: AssociationEdgeTypeSchema.optional(),
        direction: z.enum([...ASSOCIATION_DIRECTIONS] as [AssociationDirection, ...AssociationDirection[]])
          .default("both"),
        limit: z.number().int().min(1).max(100).default(50),
        as_of: z.number().int().nonnegative().optional().describe("Historical query time in Unix ms"),
      },
    },
    async ({ id, type, direction, limit, as_of }) => {
      try {
        const connections = await listAssociationConnections(env.DB, id, {
          edgeType: type,
          direction: direction as AssociationDirection,
          limit,
          asOf: as_of,
        });
        if (!connections.length) {
          return { content: [{ type: "text", text: `No associations found for ${id}.` }] };
        }
        const text = connections.map((connection) =>
          `- (${connection.edgeType}, weight ${connection.weight.toFixed(2)}) ${connection.entryId}: ${connection.content.slice(0, 160)}`
        ).join("\n");
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Connections lookup failed." }],
          isError: true,
        };
      }
    }
  );

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
      if (result.status === "delete_failed") {
        return {
          content: [{
            type: "text",
            text: `Deletion of entry ${id} was not completed. Database tracking was preserved; retry later.`,
          }],
          isError: true,
        };
      }
      logMemoryEvent(id, "deleted", {
        vector_count: result.vectorCount,
        derived_count: result.derivedCount,
      }, "forget");
      return { content: [{
        type: "text",
        text: `Deleted entry ${id}, ${result.derivedCount} derived memory/memories, and ${result.vectorCount} vector(s).`,
      }] };
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
      const isToolsList = await isMcpToolsListRequest(request);
      // Prefer a complete JSON-RPC response for POST requests. This is still
      // MCP Streamable HTTP, but avoids reverse proxies buffering or dropping
      // the first short-lived SSE frame during initialize/tools/list.
      const response = await createMcpHandler(server, { enableJsonResponse: true })(
        request,
        env,
        ctx
      );
      return isToolsList ? sanitizeToolsListResponse(response) : response;
    });
  },
};

async function providerHealthSummaries(env: Env): Promise<ProviderHealthSummary[]> {
  return Promise.all(knowledgeSourceRegistry.list().map(async (provider) => {
    try {
      const row = provider.id === "development-session"
        ? await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM sb_observations
           WHERE source_channel IN ('claude-code', 'codex')`
        ).first<{ count: number }>()
        : await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM sb_external_links WHERE provider = ?`
        ).bind(provider.id).first<{ count: number }>();
      return {
        id: provider.id,
        configured: Number(row?.count ?? 0) > 0,
        status: "healthy" as const,
      };
    } catch {
      return {
        id: provider.id,
        configured: false,
        status: "degraded" as const,
        error: "provider_state_unavailable",
      };
    }
  }));
}

async function detailedHealth(env: Env) {
  const { effective } = await getEffectiveModelSettings(env);
  const devEmbeddingAllowed = isDevLocalProvider(effective.embedding.provider) &&
    (env.ALLOW_DEV_EMBEDDING === "1" || env.ALLOW_DEV_EMBEDDING === "true");
  return collectHealthMatrix({
    db: env.DB,
    vectorize: {
      describe: (env.VECTORIZE as unknown as { describe?: () => Promise<unknown> }).describe?.bind(env.VECTORIZE),
      ...(env.SELFHOST === "1" ? {} : {
        probeSourceMetadataFilter: async () => {
          const dimensions = Math.max(1, Math.trunc(effective.embedding.dimensions));
          const probe = Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0);
          await cachedVectorSourceMetadataProbe(
            env.VECTORIZE as unknown as object,
            String(dimensions),
            async () => {
              await env.VECTORIZE.query(probe, {
                topK: 1,
                returnMetadata: "none",
                filter: { source: { $ne: CLAIM_VECTOR_SOURCE } },
              });
            }
          );
        },
      }),
    },
    mode: env.SELFHOST === "1" ? "selfhost" : "cloudflare",
    llmConfigured: Boolean(
      (effective.llm.baseURL && effective.llm.apiKey) ||
      (env.AI && env.SELFHOST !== "1")
    ),
    embeddingConfigured: Boolean(
      (effective.embedding.baseURL && effective.embedding.apiKey) ||
      devEmbeddingAllowed ||
      (env.AI && env.SELFHOST !== "1")
    ),
    providers: await providerHealthSummaries(env),
  });
}

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
  const declaredLength = Number(request.headers.get("content-length"));
  let requestBytes = Number.isFinite(declaredLength) && declaredLength > 0
    ? declaredLength
    : 0;
  const mayReadBody =
    config.contentLogging === "preview" || config.contentLogging === "full";
  if (!shouldSuppressRequestBodyTelemetry(url.pathname) && mayReadBody) {
    try {
      const clone = request.clone();
      const text = await clone.text().catch(() => "");
      if (!requestBytes) requestBytes = new TextEncoder().encode(text).length;
      const p = previewText(text, config.contentLogging, config.previewMaxChars);
      reqPreview = p.preview;
      reqHash = p.hash;
    } catch {
      /* ignore */
    }
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
    if (request.method === "OPTIONS") {
      return applyManagementCors(request, new Response(null, { status: 200 }), env);
    }
    const response = await withRequestTelemetry(request, env, ctx, async () => {
    const url = new URL(request.url);

    // OAuth authorize endpoint — hosted login page for browser-based MCP clients.
    if (url.pathname === "/oauth/authorize") {
      // Preserve full public URL (incl. query) so POST keeps PKCE / redirect_uri / state
      const formAction = url.pathname + url.search;
      let oauthReq: any;
      try {
        // workers-oauth-provider mis-parses POST bodies; pass a URL-only GET clone
        // so parseAuthRequest reads the query params cleanly.
        const parseReq = request.method === "POST" ? new Request(request.url, { method: "GET" }) : request;
        oauthReq = await (env as any).OAUTH_PROVIDER.parseAuthRequest(parseReq);
      } catch {
        return new Response(
          "Invalid authorization request — open this page via ChatGPT/MCP OAuth (must include client_id, redirect_uri, response_type=code, code_challenge).",
          { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
      if (!oauthReq.codeChallenge || oauthReq.codeChallengeMethod !== "S256") {
        return new Response("OAuth authorization requires PKCE with code_challenge_method=S256.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      const scope = normalizeOAuthScope(oauthReq.scope);
      if (oauthReq.responseType !== "code") {
        return new Response("OAuth authorization requires response_type=code.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      if (scope.length !== 1 || scope[0] !== "mcp") {
        return new Response("OAuth authorization supports only scope=mcp.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const clientInfo = await (env as any).OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
      const details: OAuthLoginDetails = {
        clientName: clientInfo?.clientName || oauthReq.clientId,
        clientId: oauthReq.clientId,
        redirectUri: oauthReq.redirectUri,
        scope,
        cancelUrl: oauthCancelUrl(oauthReq.redirectUri, oauthReq.state),
      };
      const redirectPolicy = checkOAuthRedirectOrigin(
        oauthReq.redirectUri,
        env.OAUTH_ALLOWED_REDIRECT_ORIGINS
      );
      // Allow listed OAuth callback hosts in form-action so Chrome does not block
      // the 302 to redirect_uri after AUTH_TOKEN form POST (CSP form-action chain).
      const formActionCsp = oauthFormActionSources(env.OAUTH_ALLOWED_REDIRECT_ORIGINS);
      if (!redirectPolicy.allowed) {
        return oauthLoginResponse(
          loginHtml(
            `已拒绝未列入 OAUTH_ALLOWED_REDIRECT_ORIGINS 的回调域名：${redirectPolicy.redirectOrigin || oauthReq.redirectUri}`,
            undefined,
            details
          ),
          403,
          formActionCsp
        );
      }
      if (request.method === "POST") {
        const form = await request.formData();
        if (form.get("password") !== env.AUTH_TOKEN) {
          return oauthLoginResponse(
            loginHtml("令牌无效 / Invalid token", formAction, details),
            401,
            formActionCsp
          );
        }
        const { redirectTo } = await (env as any).OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: "owner",
          scope,
          props: { userId: "owner" },
        });
        return Response.redirect(redirectTo, 302);
      }
      return oauthLoginResponse(
        loginHtml(undefined, formAction, details),
        200,
        formActionCsp
      );
    }

    await ensureDatabase(env);

    // GET /config — public site URLs for UI / deployers (no secrets)
    if (
      (url.pathname === "/config" || url.pathname === "/config.json") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      const origin =
        readPublicUrl(env) ||
        resolvePublicOrigin(request, env);
      const cfg = siteConfigJson(origin);
      return json({
        ok: true,
        ...cfg,
        // hint for operators
        envKeys: ["PUBLIC_URL", "PUBLIC_BASE_URL", "SITE_URL"],
      });
    }

    // GET /health — public liveness only; operational internals stay protected.
    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        status: "healthy",
        mode: env.SELFHOST === "1" ? "selfhost" : "cloudflare",
      });
    }

    // GET /health/details — owner-only dependency and queue matrix.
    if (url.pathname === "/health/details" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      return json(await detailedHealth(env));
    }

    // GET /integrations/providers — public provider capabilities without secrets.
    if (url.pathname === "/integrations/providers" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      return json({ ok: true, providers: knowledgeSourceRegistry.list() });
    }

    // POST /integrations/development-session/capture — append-only raw session Evidence.
    if (url.pathname === "/integrations/development-session/capture" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }
      const parsed = DevelopmentSessionCaptureSchema.safeParse(rawBody);
      if (!parsed.success) {
        return json({
          ok: false,
          error: "invalid_development_session",
          details: parsed.error.issues,
        }, 400);
      }
      const body = parsed.data;
      const sessionMessages = normalizeDevelopmentSessionMessages(
        body.messages,
        body.transcript
      );
      if (
        body.messages &&
        !developmentSessionMessagesMatchTranscript(sessionMessages, body.transcript)
      ) {
        return json({
          ok: false,
          error: "development_session_transcript_mismatch",
        }, 400);
      }
      const sourceIdentity = `${body.client}:${body.repository}:${body.branch}:${body.sessionId}`;
      const contentHash = await contentFingerprint(body.transcript);
      const structuredMessagesHash = sessionMessages.length
        ? await contentFingerprint(JSON.stringify(sessionMessages.map((message) => ({
          role: message.role,
          content: message.content,
        }))))
        : null;
      const auditAfterHash = structuredMessagesHash
        ? await contentFingerprint(JSON.stringify({ contentHash, structuredMessagesHash }))
        : contentHash;
      const previous = await env.DB.prepare(
        `SELECT id, content_hash, revision, metadata_json
         FROM sb_observations
         WHERE source_channel = ? AND source_identity = ?
         ORDER BY revision DESC, created_at DESC
         LIMIT 1`
      ).bind(body.client, sourceIdentity).first<{
        id: string;
        content_hash: string | null;
        revision: number;
        metadata_json: string | null;
      }>();
      let previousMetadata: Record<string, unknown> = {};
      try {
        previousMetadata = JSON.parse(previous?.metadata_json || "{}");
      } catch {
        previousMetadata = {};
      }
      const previousStructuredMessagesHash = typeof previousMetadata.structured_messages_hash === "string"
        ? previousMetadata.structured_messages_hash
        : null;
      const supplementsStructuredMessages = Boolean(
        previous?.content_hash === contentHash &&
        structuredMessagesHash &&
        !previousStructuredMessagesHash &&
        structuredMessagesHash !== previousStructuredMessagesHash
      );
      if (
        previous?.content_hash === contentHash &&
        previousStructuredMessagesHash &&
        structuredMessagesHash &&
        previousStructuredMessagesHash !== structuredMessagesHash
      ) {
        return json({
          ok: false,
          error: "development_session_structured_messages_conflict",
          currentRevision: Number(previous.revision),
        }, 409);
      }
      if (previous?.content_hash === contentHash && !supplementsStructuredMessages) {
        return json({
          ok: true,
          source: body.client,
          status: "already_captured",
          observationId: previous.id,
        });
      }
      const revision = supplementsStructuredMessages
        ? Number(previous?.revision ?? 1)
        : body.revision ?? Math.max(1, Number(previous?.revision ?? 0) + 1);
      if (previous && !supplementsStructuredMessages && revision <= Number(previous.revision)) {
        return json({
          ok: false,
          error: "stale_development_session_revision",
          currentRevision: Number(previous.revision),
        }, 409);
      }
      const provenance = normalizeDevelopmentSessionProvenance({
        sourceId: sourceIdentity,
        sourceRevision: revision,
        sourceTimestamp: body.capturedAt ?? Date.now(),
        metadata: {
          client: body.client,
          repository: body.repository,
          branch: body.branch,
          sessionId: body.sessionId,
        },
      });
      const observationId = supplementsStructuredMessages && previous
        ? previous.id
        : crypto.randomUUID();
      const createdAt = Date.now();
      const messagePlans = planDevelopmentSessionEvidence(sessionMessages, {
        sourceIdentity,
        revision,
        capturedAt: provenance.sourceTimestamp ?? createdAt,
      });
      const metadata = {
        ...previousMetadata,
        content_stage: "raw_evidence",
        evidence_type: provenance.evidenceType,
        extraction_skipped_reason: messagePlans.length
          ? "structured_messages_distilled"
          : "mixed_author_transcript",
        structured_message_count: messagePlans.length,
        structured_messages_hash: structuredMessagesHash,
        repository: body.repository,
        branch: body.branch,
        session_id: body.sessionId,
        client: body.client,
      };
      const auditEvent = await prepareComplianceAuditEvent(env.DB, {
        ...auditActorFromPrincipal(auth.principal),
        action: supplementsStructuredMessages
          ? "evidence.development_session_structured_messages_supplemented"
          : "evidence.development_session_captured",
        objectType: "observation",
        objectId: observationId,
        afterHash: auditAfterHash,
        success: true,
        metadata: {
          sourceChannel: provenance.sourceChannel,
          sourceIdentity: provenance.sourceIdentity,
          revision,
          transcriptContentHash: contentHash,
          structuredMessagesHash,
        },
      });
      const plannedMessages = await Promise.all(messagePlans.map(async (plan) => {
        const id = crypto.randomUUID();
        const contentHash = await contentFingerprint(plan.content);
        const previousMessage = await env.DB.prepare(
          `SELECT id
           FROM sb_observations
           WHERE source_channel = ? AND source_identity = ?
           ORDER BY revision DESC, created_at DESC
           LIMIT 1`
        ).bind(body.client, plan.sourceIdentity).first<{ id: string }>();
        const parent = plan.extractionStatus === "pending" ? {
          parentId: `development:${plan.sourceIdentity}`,
          versionId: crypto.randomUUID(),
          versionNumber: revision,
          evidenceRootId: plan.rootEvidenceId,
        } : null;
        const messageMetadata = {
          content_stage: plan.role === "user" ? "message_evidence" : "ai_projection",
          evidence_type: plan.evidenceType,
          message_role: plan.role,
          message_intent: plan.messageIntent,
          message_id: plan.messageId ?? null,
          message_index: plan.messageIndex,
          session_observation_id: observationId,
          repository: body.repository,
          branch: body.branch,
          session_id: body.sessionId,
          client: body.client,
          extraction_skipped_reason: plan.extractionSkippedReason,
          tags: ["development-session", `session-role:${plan.role}`],
          ...(parent ? observationParentVersionMetadata(parent) : {}),
        };
        return {
          plan,
          id,
          contentHash,
          previousEvidenceId: previousMessage?.id ?? null,
          parent,
          metadataJson: JSON.stringify(messageMetadata),
          metadata: messageMetadata,
        };
      }));
      const messageStatements = plannedMessages.flatMap((message) => [
        ...(message.parent ? prepareObservationParentVersionStatements(env.DB, {
          ...message.parent,
          observationId: message.id,
          contentHash: message.contentHash,
          metadata: message.metadata,
          source: body.client,
          createdAt,
        }) : []),
        prepareObservationInsert(env.DB, {
          id: message.id,
          content: message.plan.content,
          source: body.client,
          metadata: message.metadata,
          contentHash: message.contentHash,
          sourceChannel: body.client,
          sourceIdentity: message.plan.sourceIdentity,
          authorType: message.plan.authorType,
          sourceUri: null,
          sourceTimestamp: message.plan.capturedAt,
          revision,
          rootEvidenceId: message.plan.rootEvidenceId,
          previousEvidenceId: message.previousEvidenceId,
          extractionStatus: message.plan.extractionStatus,
          processedAt: message.plan.extractionStatus === "succeeded" ? createdAt : null,
          createdAt,
        }),
      ]);
      const transcriptStatement = supplementsStructuredMessages
        ? env.DB.prepare(
          `UPDATE sb_observations
           SET metadata_json = ?
           WHERE id = ? AND content_hash = ?`
        ).bind(JSON.stringify(metadata), observationId, contentHash)
        : prepareObservationInsert(env.DB, {
          id: observationId,
          content: body.transcript,
          source: body.client,
          metadata,
          contentHash,
          sourceChannel: provenance.sourceChannel,
          sourceIdentity: provenance.sourceIdentity,
          authorType: provenance.authorType,
          sourceUri: provenance.sourceUri,
          sourceTimestamp: provenance.sourceTimestamp,
          revision,
          rootEvidenceId: provenance.rootEvidenceId,
          previousEvidenceId: previous?.id ?? null,
          extractionStatus: "succeeded",
          processedAt: createdAt,
          createdAt,
        });
      await env.DB.batch([
        transcriptStatement,
        ...messageStatements,
        auditEvent.statement,
      ]);
      const queuedUserMessages = plannedMessages.filter(
        (message) => message.plan.role === "user" && message.plan.extractionStatus === "pending"
      );
      const archivedUserMessages = plannedMessages.filter(
        (message) => message.plan.role === "user" && message.plan.extractionStatus !== "pending"
      );
      const assistantMessages = plannedMessages.filter((message) => message.plan.role === "assistant");
      return json({
        ok: true,
        source: body.client,
        status: supplementsStructuredMessages
          ? "structured_messages_supplemented"
          : "stored_raw_evidence",
        observationId,
        revision,
        distillation: {
          userMessagesQueued: queuedUserMessages.length,
          userMessagesArchived: archivedUserMessages.length,
          assistantMessagesArchived: assistantMessages.length,
        },
      });
    }

    // POST /capture
    if (url.pathname === "/capture" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

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
          message: "Exact duplicate detected — not stored",
        });
      }
      if (result.status === "failed") {
        return json({
          ok: false,
          id: result.id,
          error: result.reason,
          message: formatCaptureResultMessage(result),
        }, 500);
      }
      if (result.status === "batch") {
        const ids = captureResultEntryIds(result);
        return json({
          ok: true,
          observation_id: result.observationId,
          ids,
          id: ids[0] ?? null,
          count: ids.length,
          results: result.results.map((item) => ({
            status: item.status,
            id: "id" in item ? item.id : undefined,
            matchId: "matchId" in item ? item.matchId : undefined,
          })),
          message: formatCaptureResultMessage(result),
        });
      }
      if (result.status === "sourced") {
        return json({
          ok: true,
          id: result.id,
          duplicate: true,
          action: "source_linked",
          observation_id: result.observationId,
          memory_id: result.memoryId,
          message: formatCaptureResultMessage(result),
        });
      }
      if (result.status === "contradiction") {
        return json({
          ok: true,
          id: result.id,
          conflict_id: result.conflictId,
          relation: "contradicts",
          preserved: true,
          reason: result.reason,
        });
      }
      if (result.status === "contradiction_protected") {
        return json({
          ok: true,
          id: result.id,
          status: "draft",
          kept_canonical: result.canonicalId,
          relation: "contradicts",
          preserved: true,
          reason: result.reason,
        });
      }
      if (result.status === "linked") {
        return json({
          ok: true,
          id: result.id,
          action: "linked",
          relation: result.relation,
          linked_id: result.linkedId,
          score: parseFloat((result.score * 100).toFixed(1)),
          preserved: true,
          message: "Stored as a new memory and linked without rewriting the existing memory",
        });
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
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

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

      let appendedContent: string;
      try {
        appendedContent = await appendToEntry(env, id, existingContent, addition, tags, source);
      } catch (e) {
        console.error("Append failed:", e);
        return json({ ok: false, error: "Append failed. Retry later." }, 500);
      }
      let atomicWarnings: string[] = [];
      try {
        const atomicMutation = await replaceEntryAtomicMemoryAndEnqueue(env, {
          entryId: id,
          content: appendedContent,
          contentHash: await contentFingerprint(appendedContent),
          source: "api",
          actor: mutationActorForSource("api"),
          eventType: "append",
          createdAt: Date.now(),
        });
        atomicWarnings = atomicMutation.warnings;
      } catch (e) {
        console.error("Atomic memory append sync failed (non-fatal):", e);
        return json({
          ok: false,
          id,
          error: "atomic_sync_failed",
          message: "Append changed the entry projection, but Evidence/Claim sync failed. The entry is excluded from strict recall until repair.",
        }, 503);
      }
      scheduleClassifyAndTag(id, appendedContent, env, ctx);

      return json({
        ok: true,
        id,
        warnings: atomicWarnings,
        message: "Update appended successfully with timestamp",
      });
    }

    // POST /update
    if (url.pathname === "/update" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      let body: { id?: string; content?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
      if (!body.content?.trim()) return json({ ok: false, error: "content is required" }, 400);

      const id = body.id.trim();
      const newContent = body.content.trim();

      const row = await env.DB.prepare(
        `SELECT content, tags, source FROM entries WHERE id = ?`
      ).bind(id).first() as Record<string, any> | null;

      if (!row) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);

      const oldContent = row.content as string;
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      const { cleanContent, hashtags: newHashtags } = extractHashtags(newContent);
      const mergedTags = [...new Set([...tags, ...newHashtags])];
      const source = row.source as string;
      const finalContent = cleanContent || newContent;

      let newVectorIds: string[];
      try {
        newVectorIds = await commitEntryVersion(env, {
          id,
          oldContent,
          newContent: finalContent,
          oldTags: tags,
          newTags: mergedTags,
          source,
          eventType: "UPDATE",
          reason: "Full content replaced through HTTP API",
          actor: "api",
        });
      } catch (error) {
        console.error("Update vector switch failed:", error);
        return json({
          ok: false,
          error: "Update could not be indexed. Previous content remains active; retry later.",
        }, 503);
      }
      let atomicWarnings: string[] = [];
      try {
        const atomicMutation = await replaceEntryAtomicMemoryAndEnqueue(env, {
          entryId: id,
          content: finalContent,
          contentHash: await contentFingerprint(finalContent),
          source: "api",
          actor: mutationActorForSource("api"),
          eventType: "update",
          createdAt: Date.now(),
        });
        atomicWarnings = atomicMutation.warnings;
      } catch (e) {
        console.error("Atomic memory update sync failed (non-fatal):", e);
        return json({
          ok: false,
          id,
          error: "atomic_sync_failed",
          message: "Update changed the entry projection, but Evidence/Claim sync failed. The entry is excluded from strict recall until repair.",
        }, 503);
      }
      scheduleClassifyAndTag(id, finalContent, env, ctx);

      return json({
        ok: true,
        id,
        vectors: newVectorIds.length,
        warnings: atomicWarnings,
      });
    }

    // POST /integrations/obsidian/push
    if (url.pathname === "/integrations/obsidian/push" && request.method === "POST") {
      let body: ObsidianPushBody;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const requestedVaultId = optionalTrimmedString(body.vaultId);
      const auth = await requireScopedAuth(request, env, "obsidian:push", requestedVaultId);
      if (!auth.ok) return auth.response;
      const vault = resolveObsidianVaultId(auth.principal, requestedVaultId);
      if (!vault.ok) return vault.response;
      body.vaultId = vault.vaultId;
      return handleObsidianPush(env, ctx, body);
    }

    // GET /integrations/obsidian/pull
    if (url.pathname === "/integrations/obsidian/pull" && request.method === "GET") {
      const urlVaultId = requiredTrimmedString(url.searchParams.get("vaultId"));
      if (!urlVaultId) return json({ ok: false, error: "vaultId is required" }, 400);
      const auth = await requireScopedAuth(request, env, "obsidian:pull", urlVaultId);
      if (!auth.ok) return auth.response;
      const vault = resolveObsidianVaultId(auth.principal, urlVaultId);
      if (!vault.ok) return vault.response;
      const vaultId = vault.vaultId;
      const status = optionalTrimmedString(url.searchParams.get("status"));
      if (status && !(OBSIDIAN_SYNC_STATUSES as readonly string[]).includes(status)) {
        return json({ ok: false, error: `status must be one of: ${OBSIDIAN_SYNC_STATUSES.join(", ")}` }, 400);
      }
      const rawLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(100, Math.max(1, Math.floor(rawLimit)))
        : 50;
      const cursor = optionalTrimmedString(url.searchParams.get("cursor"));
      let cursorUpdatedAt: number | null = null;
      let cursorId: string | null = null;
      if (cursor) {
        const [updatedAtRaw, ...idParts] = cursor.split(":");
        cursorUpdatedAt = Number(updatedAtRaw);
        cursorId = idParts.join(":");
        if (!Number.isFinite(cursorUpdatedAt) || !cursorId) {
          return json({ ok: false, error: "Invalid cursor" }, 400);
        }
      }
      const statusClause = status ? "AND l.sync_status = ?" : "";
      const cursorClause = cursor
        ? "AND (l.updated_at < ? OR (l.updated_at = ? AND l.id < ?))"
        : "";
      const bindings: unknown[] = [OBSIDIAN_PROVIDER, vaultId];
      if (status) bindings.push(status);
      if (cursor) bindings.push(cursorUpdatedAt, cursorUpdatedAt, cursorId);
      bindings.push(limit + 1);
      const { results } = await env.DB.prepare(
        `SELECT
           l.*,
           e.content,
           e.tags,
           e.source,
           e.created_at AS entry_created_at,
           e.content_hash,
           e.metadata_hash,
           e.classification_version,
           (
             SELECT id FROM sb_memory_revisions r
             WHERE r.memory_id = e.id
             ORDER BY r.created_at DESC
             LIMIT 1
           ) AS revision_id
         FROM sb_external_links l
         JOIN entries e ON e.id = l.entry_id
         WHERE l.provider = ? AND l.vault_id = ?
           AND l.object_type = 'memory'
           AND l.sync_direction != 'obsidian_to_singularity'
           ${statusClause}
           ${cursorClause}
         ORDER BY l.updated_at DESC, l.id DESC
         LIMIT ?`
      ).bind(...bindings).all();
      const pageRows = ((results ?? []) as Record<string, any>[]).slice(0, limit);
      const knowledgeByEntry = await loadObsidianKnowledgeProjections(
        env,
        pageRows.map((row) => String(row.entry_id ?? "")).filter(Boolean)
      );
      const items = await Promise.all(pageRows.map((row) => {
        const tags = parseEntryTagsJson(row.tags as string | null);
        const projection = knowledgeByEntry.get(String(row.entry_id)) ?? {
          entities: [],
          facts: [],
          hash: null,
        };
        return serializeObsidianPullRow({
          ...(row as ObsidianLinkedEntryRow),
          memory_status: getStatus(tags),
          knowledge_entities: projection.entities,
          knowledge_facts: projection.facts,
          knowledge_projection_hash: projection.hash,
        });
      }));
      const hasMore = (results ?? []).length > limit;
      const last = pageRows[pageRows.length - 1];
      return json({
        ok: true,
        vaultId,
        count: items.length,
        results: items,
        hasMore,
        nextCursor: hasMore && last ? `${last.updated_at}:${last.id}` : null,
      });
    }

    // GET /integrations/obsidian/status
    if (url.pathname === "/integrations/obsidian/status" && request.method === "GET") {
      const urlVaultId = requiredTrimmedString(url.searchParams.get("vaultId"));
      if (!urlVaultId) return json({ ok: false, error: "vaultId is required" }, 400);
      const auth = await requireScopedAuth(request, env, "obsidian:status", urlVaultId);
      if (!auth.ok) return auth.response;
      const vault = resolveObsidianVaultId(auth.principal, urlVaultId);
      if (!vault.ok) return vault.response;
      const vaultId = vault.vaultId;
      const [totalRow, statusRows, errorRows, sourceRows, ruleRows, aggregateRows, migrationRows] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM sb_external_links
           WHERE provider = ? AND vault_id = ?`
        ).bind(OBSIDIAN_PROVIDER, vaultId).first<Record<string, any>>(),
        env.DB.prepare(
          `SELECT sync_status, COUNT(*) AS count FROM sb_external_links
           WHERE provider = ? AND vault_id = ?
           GROUP BY sync_status`
        ).bind(OBSIDIAN_PROVIDER, vaultId).all(),
        env.DB.prepare(
          `SELECT id, entry_id, external_path, sync_status, last_error, updated_at
           FROM sb_external_links
           WHERE provider = ? AND vault_id = ?
             AND last_error IS NOT NULL
           ORDER BY updated_at DESC
           LIMIT 10`
        ).bind(OBSIDIAN_PROVIDER, vaultId).all(),
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM sb_external_sources
           WHERE provider = ? AND vault_id = ?`
        ).bind(OBSIDIAN_PROVIDER, vaultId).first<Record<string, any>>(),
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM sb_automation_rules
           WHERE vault_id IS NULL OR vault_id = ?`
        ).bind(vaultId).first<Record<string, any>>(),
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM sb_knowledge_aggregates
           WHERE vault_id IS NULL OR vault_id = ?`
        ).bind(vaultId).first<Record<string, any>>(),
        env.DB.prepare(
          `SELECT id, name, checksum, applied_at
           FROM sb_schema_migrations
           WHERE id LIKE '%obsidian%'
              OR id LIKE '%external_links%'
           ORDER BY applied_at DESC`
        ).all(),
      ]);
      const byStatus: Record<string, number> = {};
      for (const row of (statusRows.results ?? []) as Record<string, any>[]) {
        byStatus[String(row.sync_status)] = Number(row.count ?? 0);
      }
      return json({
        ok: true,
        vaultId,
        total: Number(totalRow?.count ?? 0),
        byStatus,
        sources: Number(sourceRows?.count ?? 0),
        rules: Number(ruleRows?.count ?? 0),
        aggregates: Number(aggregateRows?.count ?? 0),
        migrations: ((migrationRows.results ?? []) as Record<string, any>[]).map((row) => ({
          id: row.id,
          name: row.name,
          checksum: row.checksum,
          appliedAt: row.applied_at,
        })),
        errors: ((errorRows.results ?? []) as Record<string, any>[]).map((row) => ({
          id: row.id,
          entryId: row.entry_id,
          path: row.external_path,
          syncStatus: row.sync_status,
          lastError: row.last_error,
          updatedAt: row.updated_at,
        })),
      });
    }

    // POST /integrations/obsidian/resolve-conflict
    if (url.pathname === "/integrations/obsidian/resolve-conflict" && request.method === "POST") {
      let body: ObsidianResolveConflictBody;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const requestedVaultId = optionalTrimmedString(body.vaultId);
      const auth = await requireScopedAuth(request, env, "obsidian:resolve-conflict", requestedVaultId);
      if (!auth.ok) return auth.response;
      const vault = resolveObsidianVaultId(auth.principal, requestedVaultId);
      if (!vault.ok) return vault.response;
      body.vaultId = vault.vaultId;
      return handleObsidianResolveConflict(env, ctx, body);
    }

    // POST /integrations/obsidian/ack
    if (url.pathname === "/integrations/obsidian/ack" && request.method === "POST") {
      let body: ObsidianAckBody;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const requestedVaultId = optionalTrimmedString(body.vaultId);
      const auth = await requireScopedAuth(request, env, "obsidian:ack", requestedVaultId);
      if (!auth.ok) return auth.response;
      const vault = resolveObsidianVaultId(auth.principal, requestedVaultId);
      if (!vault.ok) return vault.response;
      body.vaultId = vault.vaultId;
      return handleObsidianAck(env, body);
    }

    // GET/POST /integrations/obsidian/rules
    if (url.pathname === "/integrations/obsidian/rules" && request.method === "GET") {
      const urlVaultId = requiredTrimmedString(url.searchParams.get("vaultId"));
      if (!urlVaultId) return json({ ok: false, error: "vaultId is required" }, 400);
      const auth = await requireScopedAuth(request, env, "obsidian:rules", urlVaultId);
      if (!auth.ok) return auth.response;
      const vault = resolveObsidianVaultId(auth.principal, urlVaultId);
      if (!vault.ok) return vault.response;
      return handleListObsidianRules(env, vault.vaultId);
    }
    if (url.pathname === "/integrations/obsidian/rules" && request.method === "POST") {
      let body: ObsidianRuleBody;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const requestedVaultId = optionalTrimmedString(body.vaultId);
      const auth = await requireScopedAuth(request, env, "obsidian:rules", requestedVaultId);
      if (!auth.ok) return auth.response;
      const vault = resolveObsidianVaultId(auth.principal, requestedVaultId);
      if (!vault.ok) return vault.response;
      body.vaultId = vault.vaultId;
      return handleUpsertObsidianRule(env, body);
    }

    // GET /integrations/obsidian/aggregates
    if (url.pathname === "/integrations/obsidian/aggregates" && request.method === "GET") {
      const urlVaultId = requiredTrimmedString(url.searchParams.get("vaultId"));
      if (!urlVaultId) return json({ ok: false, error: "vaultId is required" }, 400);
      const auth = await requireScopedAuth(request, env, "obsidian:aggregates", urlVaultId);
      if (!auth.ok) return auth.response;
      const vault = resolveObsidianVaultId(auth.principal, urlVaultId);
      if (!vault.ok) return vault.response;
      return handleListObsidianAggregates(env, vault.vaultId);
    }

    // POST /integrations/obsidian/aggregates/generate
    if (url.pathname === "/integrations/obsidian/aggregates/generate" && request.method === "POST") {
      let body: ObsidianAggregateGenerateBody;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const requestedVaultId = optionalTrimmedString(body.vaultId);
      const auth = await requireScopedAuth(request, env, "obsidian:aggregates", requestedVaultId);
      if (!auth.ok) return auth.response;
      const vault = resolveObsidianVaultId(auth.principal, requestedVaultId);
      if (!vault.ok) return vault.response;
      body.vaultId = vault.vaultId;
      return handleGenerateObsidianAggregate(env, body);
    }

    // POST /integrations/obsidian/tokens
    if (url.pathname === "/integrations/obsidian/tokens" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      let body: ObsidianTokenBody;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      return handleCreateObsidianToken(env, body);
    }

    // GET /count
    if (url.pathname === "/count" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const row = await env.DB.prepare(`SELECT COUNT(*) as count FROM entries`).first() as Record<string, any> | null;
      return json({ count: (row?.count as number) ?? 0 });
    }

    // GET /tags
    if (url.pathname === "/tags" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`
      ).all();
      return json((results as any[]).map(r => r.value as string));
    }

    // GET /stats
    if (url.pathname === "/stats" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const graceCutoff = Date.now() - graceMs(env);
      const [summary, tagRows, candidateRows] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) as count, AVG(importance_score) as avg_importance,
           SUM(CASE WHEN vector_ids = '[]'
                     AND tags NOT LIKE '%"status:deprecated"%'
                     AND created_at < ? THEN 1 ELSE 0 END) as unvectorized,
           SUM(CASE WHEN classification_status IS NULL OR classification_status <> 'succeeded' THEN 1 ELSE 0 END) as unclassified
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
        if (!isD1SafeTag(String(row.tag ?? ""))) continue;
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
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
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
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      const requestedSchemaVersion = Number(url.searchParams.get("schemaVersion"));
      const fullExport =
        url.searchParams.get("full") === "1" ||
        url.searchParams.get("full") === "true" ||
        (Number.isInteger(requestedSchemaVersion) &&
          requestedSchemaVersion >= 4 &&
          requestedSchemaVersion <= MEMORY_BACKUP_SCHEMA_VERSION);
      if (fullExport) {
        return json(await exportMemoryBackup(env.DB, {
          source: env.SELFHOST === "1" ? "selfhost" : "cloudflare",
        }));
      }

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
                  recall_count, importance_score, classification_confidence,
                  classification_status, classification_error, classification_attempts,
                  classification_next_attempt_at, classification_started_at,
                  classification_version, classified_at,
                  contradiction_wins, contradiction_losses
           FROM entries
           WHERE created_at < ? OR (created_at = ? AND id < ?)
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        ).bind(cAt, cAt, cId, limit).all();
        results = (q.results || []) as Record<string, any>[];
      } else {
        const q = await env.DB.prepare(
          `SELECT id, content, tags, source, created_at, vector_ids,
                  recall_count, importance_score, classification_confidence,
                  classification_status, classification_error, classification_attempts,
                  classification_next_attempt_at, classification_started_at,
                  classification_version, classified_at,
                  contradiction_wins, contradiction_losses
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
        schemaVersion: 3,
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
      const auth = await requireScopedAuth(
        request,
        env,
        "recall:read",
        optionalTrimmedString(url.searchParams.get("vaultId"))
      );
      if (!auth.ok) return auth.response;
      const requestedVaultId = optionalTrimmedString(url.searchParams.get("vaultId"));
      const vaultId = auth.principal.owner ? (requestedVaultId ?? null) : auth.principal.vaultId;

      const query = url.searchParams.get("query")?.trim();
      if (!query) return json({ ok: false, error: "query is required" }, 400);

      const tag = url.searchParams.get("tag")?.trim() || undefined;
      const after = url.searchParams.has("after") ? parseInt(url.searchParams.get("after")!, 10) : undefined;
      const before = url.searchParams.has("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined;
      const kindParam = url.searchParams.get("kind")?.trim();
      const kind = kindParam && (KIND_VALUES as readonly string[]).includes(kindParam) ? kindParam as MemoryKind : undefined;

      const requestPlan = planRecallRequest(query);
      if (requestPlan.mode === "recent_activity") {
        const activityPlan: RecallRequestPlan = {
          ...requestPlan,
          after: after ?? requestPlan.after,
          before: before ?? requestPlan.before,
        };
        const matches = await listRecentActivity(activityPlan, tag, env, vaultId);

        if (!matches.length) {
          return json({
            ok: true,
            mode: activityPlan.mode,
            window: { after: activityPlan.after, before: activityPlan.before },
            results: [],
            message: "No recent activity found in that time window.",
          });
        }

        return json({
          ok: true,
          mode: activityPlan.mode,
          window: { after: activityPlan.after, before: activityPlan.before },
          results: matches.map((match) => ({
            id: match.id,
            content: match.content,
            score: null,
            tags: match.tags,
            source: match.source,
            created_at: match.createdAt,
            updated: false,
          })),
          insight: null,
        });
      }

      const topK = Math.min(Math.max(parseInt(url.searchParams.get("topK") ?? "5", 10), 1), 20);
      const hops = Math.min(Math.max(parseInt(url.searchParams.get("hops") ?? "0", 10), 0), 2);
      const directionParam = url.searchParams.get("associationDirection") ?? "outgoing";
      if (!(ASSOCIATION_DIRECTIONS as readonly string[]).includes(directionParam)) {
        return json({ ok: false, error: "invalid_association_direction" }, 400);
      }
      const associationDirection = directionParam as AssociationDirection;

      const {
        matches,
        directEvidence = matches.filter((match) => !match.association),
        relatedContext = matches.filter((match) => Boolean(match.association)),
        insight,
        verifiedClaims = [],
        unverifiedClaims = [],
        conflicts = [],
        retrievalMode = "entry_projection",
        snapshotAt,
        degraded,
        degradedReason,
      } = await recallEntries({
        query,
        topK,
        tag,
        after,
        before,
        kind,
        hops,
        associationDirection,
      }, env, ctx, vaultId, {
        recordUsage: false,
        allowClaimVectorBackfill: false,
      });

      if (!matches.length) {
        return json({
          ok: true,
          results: [],
          message: "Nothing found matching that query.",
          degraded_mode: Boolean(degraded),
          degraded_reason: degradedReason ?? null,
        });
      }

      return json({
        ok: true,
        mode: "semantic",
        retrieval_mode: retrievalMode,
        snapshot_at: snapshotAt ?? null,
        degraded_mode: Boolean(degraded),
        degraded_reason: degradedReason ?? null,
        results: matches.map(m => ({
          id: m.id,
          claim_id: m.claimId ?? null,
          parent_version_id: m.parentVersionId ?? null,
          snapshot_at: m.snapshotAt ?? null,
          content: m.content,
          // Relative rank score 0–100 (top=100). Not probability or cosine accuracy.
          score: parseFloat((m.score * 100).toFixed(1)),
          relevance: formatRelevanceLabel(m.score),
          tags: m.tags,
          source: m.source,
          created_at: m.createdAt,
          updated: m.isUpdate,
          score_details: m.scoreDetails,
          matched_entities: m.matchedEntities ?? [],
          graph_facts: m.graphFacts ?? [],
          time_basis: m.timeBasis ?? null,
          claims: m.claims ?? [],
          association: m.association ?? null,
        })),
        directEvidence: directEvidence.map((match, index) => ({
          ref: `E${index + 1}`,
          id: match.id,
          content: match.content,
          claims: match.claims ?? [],
        })),
        claim_context: buildCitableInsightClaims({
          directEvidence: directEvidence.map((match) => ({
            id: match.id,
            content: match.content,
            claims: match.claims,
          })),
          relatedContext: [],
        }, conflicts),
        relatedContext: relatedContext.map((match, index) => ({
          ref: `R${index + 1}`,
          id: match.id,
          content: match.content,
          association: match.association,
        })),
        conflicts,
        insight: insight || null,
        verified_claims: verifiedClaims,
        unverified_claims: unverifiedClaims,
      });
    }

    // POST /link — explicit, non-authoritative Parent association.
    if ((url.pathname === "/link" || url.pathname === "/associations/link") && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }
      const parsed = AssociationLinkBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return json({ ok: false, error: "invalid_association_link", details: parsed.error.issues }, 400);
      }
      const source = parsed.data.sourceId ?? parsed.data.source_id!;
      const target = parsed.data.targetId ?? parsed.data.target_id!;
      try {
        const association = await createAssociationEdge(env.DB, {
          source,
          target,
          edgeType: parsed.data.type,
          weight: parsed.data.weight ?? 1,
          provenance: "manual",
          metadata: parsed.data.metadata,
          validFrom: parsed.data.validFrom,
          validTo: parsed.data.validTo,
        });
        await safeRecordComplianceAuditEvent(env, {
          ...auditActorFromPrincipal(auth.principal),
          action: "association.linked",
          objectType: "association_edge",
          objectId: association.id,
          success: true,
          metadata: {
            sourceParentId: association.sourceParentId,
            targetParentId: association.targetParentId,
            edgeType: association.edgeType,
          },
        });
        return json({ ok: true, association });
      } catch (error) {
        if (error instanceof AssociationEndpointUnavailableError) {
          return json({ ok: false, error: "association_endpoint_unavailable", message: error.message }, 409);
        }
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: "association_link_failed", message }, 400);
      }
    }

    // POST /unlink — idempotent removal from the Association Graph only.
    if ((url.pathname === "/unlink" || url.pathname === "/associations/unlink") && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }
      const parsed = AssociationUnlinkBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return json({ ok: false, error: "invalid_association_unlink", details: parsed.error.issues }, 400);
      }
      const source = parsed.data.sourceId ?? parsed.data.source_id!;
      const target = parsed.data.targetId ?? parsed.data.target_id!;
      try {
        const deleted = await deleteAssociationEdge(env.DB, {
          source,
          target,
          edgeType: parsed.data.type,
          asOf: parsed.data.effectiveAt,
        });
        await safeRecordComplianceAuditEvent(env, {
          ...auditActorFromPrincipal(auth.principal),
          action: "association.unlinked",
          objectType: "association_edge",
          objectId: `${source}:${target}:${parsed.data.type ?? "*"}`,
          success: true,
          metadata: { deleted, edgeType: parsed.data.type ?? null },
        });
        return json({ ok: true, deleted });
      } catch (error) {
        if (error instanceof AssociationEndpointUnavailableError) {
          return json({ ok: false, error: "association_endpoint_unavailable", message: error.message }, 409);
        }
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: "association_unlink_failed", message }, 400);
      }
    }

    // GET /connections — active Parent associations; never Fact support.
    if ((url.pathname === "/connections" || url.pathname === "/associations/connections") && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const id = url.searchParams.get("id")?.trim();
      if (!id) return json({ ok: false, error: "id is required" }, 400);
      const rawType = url.searchParams.get("type")?.trim();
      const parsedType = rawType ? AssociationEdgeTypeSchema.safeParse(rawType) : null;
      if (parsedType && !parsedType.success) {
        return json({ ok: false, error: "invalid_association_type" }, 400);
      }
      const rawDirection = url.searchParams.get("direction")?.trim() ?? "both";
      if (!(ASSOCIATION_DIRECTIONS as readonly string[]).includes(rawDirection)) {
        return json({ ok: false, error: "invalid_association_direction" }, 400);
      }
      const rawAsOf = url.searchParams.get("asOf");
      const asOf = rawAsOf == null ? undefined : Number(rawAsOf);
      if (asOf != null && (!Number.isFinite(asOf) || asOf < 0)) {
        return json({ ok: false, error: "invalid_association_as_of" }, 400);
      }
      try {
        const connections = await listAssociationConnections(env.DB, id, {
          edgeType: parsedType?.success ? parsedType.data : undefined,
          direction: rawDirection as AssociationDirection,
          limit: Number.parseInt(url.searchParams.get("limit") ?? "50", 10),
          asOf,
        });
        return json({ ok: true, id, connections });
      } catch (error) {
        if (error instanceof AssociationEndpointUnavailableError) {
          return json({ ok: false, error: "association_endpoint_unavailable", message: error.message }, 409);
        }
        throw error;
      }
    }

    // GET /relations — inspect evidence and evolution links for one memory
    if (url.pathname === "/relations" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const id = url.searchParams.get("id")?.trim();
      if (!id) return json({ ok: false, error: "id is required" }, 400);
      const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 100))
        : 50;
      const relations = await listMemoryRelations(env.DB, id, limit);
      return json({ ok: true, id, relations });
    }

    // GET /quality/entity-merge-candidates — entity identity review queue
    if (url.pathname === "/quality/entity-merge-candidates" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const state = parseQualityState(url.searchParams.get("state"), ENTITY_MERGE_CANDIDATE_STATES);
      if (url.searchParams.has("state") && !state) {
        return json({
          ok: false,
          error: `state must be one of: ${ENTITY_MERGE_CANDIDATE_STATES.join(", ")}`,
        }, 400);
      }
      const limit = boundedQualityLimit(url.searchParams.get("limit"));
      const candidates = await listEntityMergeCandidates(env, { state, limit });
      return json({ ok: true, count: candidates.length, candidates });
    }

    // POST /quality/entity-merge-candidates/resolve — execute or reject an entity merge
    if (url.pathname === "/quality/entity-merge-candidates/resolve" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let rawBody: unknown;
      try { rawBody = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const parsed = EntityMergeReviewSchema.safeParse(rawBody);
      if (!parsed.success) {
        return json({ ok: false, error: "invalid_entity_merge_review" }, 400);
      }
      const { id, decision, reviewedBy: requestedReviewer, reason } = parsed.data;
      const principalActor = auditActorFromPrincipal(auth.principal);
      const reviewedBy = requestedReviewer ?? principalActor.actorId ?? "owner";
      try {
        const result = await new D1EntityMergeExecutor(env.DB).resolve({
          candidateId: id,
          decision,
          actorType: principalActor.actorType,
          actorId: principalActor.actorId ?? "owner",
          reviewedBy,
          tokenId: principalActor.tokenId,
          vaultId: principalActor.vaultId,
          reason: reason ?? null,
        });
        return json({ ok: true, ...result, reviewedBy });
      } catch (error) {
        if (error instanceof EntityMergeCandidateUnavailableError) {
          return json({ ok: false, error: "entity_merge_candidate_unavailable", message: error.message }, 409);
        }
        if (error instanceof EntityMergeEndpointUnavailableError) {
          return json({ ok: false, error: "entity_merge_endpoint_unavailable", message: error.message }, 409);
        }
        throw error;
      }
    }

    // GET /quality/merge-candidates — human review queue for high-similarity memories
    if (url.pathname === "/quality/merge-candidates" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const state = parseQualityState(url.searchParams.get("state"), MERGE_CANDIDATE_STATES);
      if (url.searchParams.has("state") && !state) {
        return json({ ok: false, error: `state must be one of: ${MERGE_CANDIDATE_STATES.join(", ")}` }, 400);
      }
      const limit = boundedQualityLimit(url.searchParams.get("limit"));
      const candidates = await listMemoryMergeCandidates(env, { state, limit });
      return json({ ok: true, count: candidates.length, candidates });
    }

    // POST /quality/merge-candidates/resolve — mark a merge candidate reviewed
    if (url.pathname === "/quality/merge-candidates/resolve" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let body: { id?: string; state?: string; reviewedBy?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const id = parseReviewId(body.id);
      if (!id) return json({ ok: false, error: "id is required" }, 400);
      const state = parseQualityState(body.state, MERGE_CANDIDATE_STATES);
      if (!state || state === "pending") {
        return json({ ok: false, error: "state must be accepted, rejected, or resolved" }, 400);
      }
      const reviewedBy = parseReviewId(body.reviewedBy) ?? "owner";
      const ok = await resolveMemoryMergeCandidate(env, {
        id,
        state,
        reviewedBy,
        principal: auth.principal,
      });
      if (!ok) return json({ ok: false, error: `No merge candidate found with ID: ${id}` }, 404);
      return json({ ok: true, id, state, reviewedBy });
    }

    // GET /quality/conflict-cases — human review queue for contradictory memories
    if (url.pathname === "/quality/conflict-cases" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const state = parseQualityState(url.searchParams.get("state"), CONFLICT_CASE_STATES);
      if (url.searchParams.has("state") && !state) {
        return json({ ok: false, error: `state must be one of: ${CONFLICT_CASE_STATES.join(", ")}` }, 400);
      }
      const limit = boundedQualityLimit(url.searchParams.get("limit"));
      const conflicts = await listConflictCases(env, { state, limit });
      return json({ ok: true, count: conflicts.length, conflicts });
    }

    // POST /quality/conflict-cases/resolve — record a human conflict decision
    if (url.pathname === "/quality/conflict-cases/resolve" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let body: { id?: string; state?: string; resolution?: string; resolvedBy?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      const id = parseReviewId(body.id);
      if (!id) return json({ ok: false, error: "id is required" }, 400);
      const state = parseQualityState(body.state, CONFLICT_CASE_STATES);
      if (!state || state === "pending") {
        return json({ ok: false, error: "state must be resolved or dismissed" }, 400);
      }
      const resolution = parseQualityState(body.resolution, CONFLICT_RESOLUTIONS);
      if (!resolution) {
        return json({ ok: false, error: `resolution must be one of: ${CONFLICT_RESOLUTIONS.join(", ")}` }, 400);
      }
      if (
        (state === "dismissed" && resolution !== "dismissed") ||
        (state === "resolved" && resolution === "dismissed")
      ) {
        return json({ ok: false, error: "dismissed state requires dismissed resolution, and resolved state cannot use it" }, 400);
      }
      if (resolution === "manual") {
        return json({
          ok: false,
          error: "manual_resolution_requires_outcome",
          message: "manual resolution cannot close a conflict without explicit final Claim and Fact outcomes",
        }, 400);
      }
      const resolvedBy = parseReviewId(body.resolvedBy) ?? "owner";
      let ok: boolean;
      try {
        ok = await resolveConflictCase(env, {
          id,
          state,
          resolution,
          resolvedBy,
          principal: auth.principal,
        });
      } catch (error) {
        if (error instanceof ConflictClaimsUnavailableError) {
          return json({ ok: false, error: "conflict_claims_unavailable", message: error.message }, 409);
        }
        if (error instanceof ManualResolutionOutcomeRequiredError) {
          return json({ ok: false, error: "manual_resolution_requires_outcome", message: error.message }, 400);
        }
        if (error instanceof ClaimRelationMismatchError) {
          return json({ ok: false, error: "claim_relation_mismatch", message: error.message }, 409);
        }
        throw error;
      }
      if (!ok) return json({ ok: false, error: `No conflict case found with ID: ${id}` }, 404);
      return json({ ok: true, id, state, resolution, resolvedBy });
    }

    // GET /audit/events — compliance audit trail (hash-chained, content hashes only)
    if (url.pathname === "/audit/events" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const limit = boundedQualityLimit(url.searchParams.get("limit"));
      const events = await listAuditEvents(env, {
        limit,
        action: optionalTrimmedString(url.searchParams.get("action")),
        objectType: optionalTrimmedString(url.searchParams.get("objectType")),
        objectId: optionalTrimmedString(url.searchParams.get("objectId")),
        vaultId: optionalTrimmedString(url.searchParams.get("vaultId")),
        traceId: optionalTrimmedString(url.searchParams.get("traceId")),
      });
      return json({ ok: true, count: events.length, events });
    }

    // GET /entities — list / search knowledge entities
    if (url.pathname === "/entities" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const q = url.searchParams.get("q")?.trim() || undefined;
      const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 200))
        : 50;
      const entities = await listEntities(env.DB, { q, limit });
      return json({ ok: true, entities, count: entities.length });
    }

    // GET /entities/:id — entity detail + one-hop fact edges + linked atomic memories
    {
      const entityMatch = url.pathname.match(/^\/entities\/([^/]+)$/);
      if (entityMatch && request.method === "GET") {
        const auth = requireAuth(request, env);
        if (!auth.ok) return auth.response;
        const entityId = decodeURIComponent(entityMatch[1]);
        const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(requestedLimit, 100))
          : 50;
        const graph = await getEntityGraph(env.DB, entityId, limit);
        if (!graph.entity) {
          return json({ ok: false, error: `No entity found with ID: ${entityId}` }, 404);
        }
        return json({ ok: true, ...graph });
      }
    }

    // GET /graph/entity/:id — alias for Memory Universe clients
    {
      const graphEntityMatch = url.pathname.match(/^\/graph\/entity\/([^/]+)$/);
      if (graphEntityMatch && request.method === "GET") {
        const auth = requireAuth(request, env);
        if (!auth.ok) return auth.response;
        const entityId = decodeURIComponent(graphEntityMatch[1]);
        const graph = await getEntityGraph(env.DB, entityId, 50);
        if (!graph.entity) {
          return json({ ok: false, error: `No entity found with ID: ${entityId}` }, 404);
        }
        return json({ ok: true, ...graph });
      }
    }

    // GET /graph/facts — currently valid entity fact edges (time slice)
    if (url.pathname === "/graph/facts" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const entityId = url.searchParams.get("entity")?.trim() || undefined;
      const asOfRaw = url.searchParams.get("asOf");
      const asOf = asOfRaw ? Number(asOfRaw) : Date.now();
      const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, 200))
        : 50;
      const facts = await listActiveEntityRelations(env.DB, {
        entityId,
        asOf: Number.isFinite(asOf) ? asOf : Date.now(),
        limit,
      });
      return json({
        ok: true,
        asOf: Number.isFinite(asOf) ? asOf : Date.now(),
        facts,
        count: facts.length,
      });
    }

    // POST /forget — delete-by-id, mirrors the MCP `forget` tool
    if (url.pathname === "/forget" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      let body: { id?: string };
      try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);

      const id = body.id.trim();
      const result = await forgetEntry(id, env);

      if (result.status === "not_found") {
        return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);
      }
      if (result.status === "delete_failed") {
        return json({
          ok: false,
          error: "Memory deletion was not completed. Database tracking was preserved; retry later.",
        }, 503);
      }

      logMemoryEvent(id, "deleted", {
        vector_count: result.vectorCount,
        derived_count: result.derivedCount,
      }, "forget");
      await safeRecordComplianceAuditEvent(env, {
        ...auditActorFromPrincipal(auth.principal),
        action: "memory.delete",
        objectType: "memory",
        objectId: id,
        metadata: {
          vector_count: result.vectorCount,
          derived_count: result.derivedCount,
        },
      });
      await notifyMemoryChanged(env, id, "deleted");
      return json({
        ok: true,
        id,
        deletedVectors: result.vectorCount,
        deletedDerived: result.derivedCount,
      });
    }

    // POST /status — set lifecycle status, mirrors the MCP `set_status` tool
    if (url.pathname === "/status" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

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

    // GET /digest/preview — inspect digest eligibility without creating data.
    if (url.pathname === "/digest/preview" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const tag = url.searchParams.get("tag")?.trim();
      if (!tag) return json({ ok: false, error: "tag parameter is required" }, 400);
      if (!isD1SafeTag(tag)) return json({ ok: false, error: "invalid tag" }, 400);
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM entries
         WHERE tags LIKE ?
           AND tags NOT LIKE '%"status:deprecated"%'
           AND tags NOT LIKE '%"auto-pattern"%'`
      ).bind(`%"${tag}"%`).first<{ count: number }>();
      const sourceCount = Number(row?.count ?? 0);
      return json({
        ok: true,
        tag,
        source_count: sourceCount,
        eligible: sourceCount >= 20,
      });
    }

    // POST /digest — explicitly create a digest projection.
    if (url.pathname === "/digest" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let body: { tag?: string } = {};
      try {
        body = await request.json();
      } catch {
        /* empty body may use the query parameter */
      }
      const tag = body.tag?.trim() || url.searchParams.get("tag")?.trim();
      if (!tag) return json({ ok: false, error: "tag is required" }, 400);
      if (!isD1SafeTag(tag)) return json({ ok: false, error: "invalid tag" }, 400);

      const result = await compressTag(tag, env, ctx);

      if (!result.synthesizedId) {
        return json({ tag, error: "Could not create digest — tag may have fewer than 20 entries or was recently compressed", source_count: result.entriesUsed });
      }

      return json({ tag, synthesis: result.text, entry_id: result.synthesizedId, source_count: result.entriesUsed });
    }

    // GET/POST /extract-pending
    // GET is always read-only queue inspection. POST performs a bounded drain.
    if (
      url.pathname === "/extract-pending" &&
      (request.method === "POST" || request.method === "GET")
    ) {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      let body: { limit?: number; dryRun?: boolean } = {};
      if (request.method === "POST") {
        try {
          body = await request.json();
        } catch {
          /* empty body OK */
        }
      }
      const queryLimit = Number(url.searchParams.get("limit"));
      const limit = body.limit ?? (Number.isFinite(queryLimit) && queryLimit > 0 ? queryLimit : undefined);
      if (request.method === "GET" || body.dryRun === true) {
        return json(await inspectExtractionQueue(env, limit));
      }
      return json(await processExtractionQueue(env, ctx, limit));
    }

    // GET /maintenance/vector-index/status — self-host SQLite vector index progress.
    if (url.pathname === "/maintenance/vector-index/status" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const status = (env.VECTORIZE as any).indexStatus?.();
      if (!status) {
        return json({
          ok: false,
          error: "vector_index_status_unavailable",
        }, 400);
      }
      return json({ ok: true, status });
    }

    // POST /maintenance/vector-index/backfill — bounded self-host SQLite index backfill.
    if (url.pathname === "/maintenance/vector-index/backfill" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let body: { limit?: number } = {};
      try {
        body = await request.json();
      } catch {
        /* empty body OK */
      }
      const backfill = (env.VECTORIZE as any).backfillIndexBatch?.bind(env.VECTORIZE);
      if (!backfill) {
        return json({
          ok: false,
          error: "vector_index_backfill_unavailable",
        }, 400);
      }
      const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 1000);
      return json({
        ok: true,
        ...backfill(limit),
      });
    }

    if (url.pathname === "/maintenance/claim-vectors/status" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const { effective } = await getEffectiveModelSettings(env);
      const activeFingerprint = effective.embeddingFingerprint ??
        embeddingFingerprintOf(activeEmbeddingOf(effective));
      const pendingFingerprint = effective.pendingEmbeddingFingerprint ?? null;
      const requested = url.searchParams.get("fingerprint")?.trim() || activeFingerprint;
      if (requested !== activeFingerprint && requested !== pendingFingerprint) {
        return json({ ok: false, error: "unknown_embedding_fingerprint" }, 400);
      }
      return json({
        ok: true,
        activeFingerprint,
        pendingFingerprint,
        queue: await getClaimVectorQueueStatus(env.DB, requested),
      });
    }

    if (url.pathname === "/maintenance/claim-vectors/backfill" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let body: { limit?: number; fingerprint?: string } = {};
      try {
        body = await request.json();
      } catch {
        /* empty body OK */
      }
      const { effective } = await getEffectiveModelSettings(env);
      const activeFingerprint = effective.embeddingFingerprint ??
        embeddingFingerprintOf(activeEmbeddingOf(effective));
      const pendingFingerprint = effective.pendingEmbeddingFingerprint ?? null;
      const targetFingerprint = body.fingerprint?.trim() || activeFingerprint;
      if (targetFingerprint !== activeFingerprint && targetFingerprint !== pendingFingerprint) {
        return json({ ok: false, error: "unknown_embedding_fingerprint" }, 400);
      }
      const limit = Math.min(Math.max(Math.trunc(Number(body.limit)) || 25, 1), 200);
      const rebuild = targetFingerprint === pendingFingerprint
        ? await loadCurrentVectorRebuild(env, targetFingerprint)
        : null;
      const enqueued = await enqueueMissingClaimVectorJobs(env.DB, {
        targetFingerprint,
        rebuildId: rebuild?.id ?? null,
        limit,
      });
      const processed = await processClaimVectorQueue(env, {
        targetFingerprint,
        rebuildId: rebuild?.id ?? null,
        limit,
      });
      return json({
        ok: true,
        targetFingerprint,
        enqueued,
        processed,
        queue: await getClaimVectorQueueStatus(env.DB, targetFingerprint),
      });
    }

    if (url.pathname === "/maintenance/claim-vectors/retry-failed" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let body: { limit?: number; fingerprint?: string; claimId?: string } = {};
      try {
        body = await request.json();
      } catch {
        /* empty body OK */
      }
      const { effective } = await getEffectiveModelSettings(env);
      const activeFingerprint = effective.embeddingFingerprint ??
        embeddingFingerprintOf(activeEmbeddingOf(effective));
      const pendingFingerprint = effective.pendingEmbeddingFingerprint ?? null;
      const targetFingerprint = body.fingerprint?.trim() || activeFingerprint;
      if (targetFingerprint !== activeFingerprint && targetFingerprint !== pendingFingerprint) {
        return json({ ok: false, error: "unknown_embedding_fingerprint" }, 400);
      }
      const claimId = body.claimId?.trim() || null;
      const limit = Math.min(Math.max(Math.trunc(Number(body.limit)) || 25, 1), 200);
      const retried = await retryFailedClaimVectorJobs(env.DB, {
        targetFingerprint,
        claimId,
        limit,
      });
      return json({
        ok: true,
        targetFingerprint,
        claimId,
        retried,
        queue: await getClaimVectorQueueStatus(env.DB, targetFingerprint),
      });
    }

    // POST /vectorize-pending
    if (url.pathname === "/vectorize-pending" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

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

      const storedSettings = await loadStoredModelSettings(env.DB).catch(() => null);
      const pendingFingerprint = storedSettings?.pendingEmbeddingFingerprint ?? null;
      const vectorSettings = storedSettings ?? mergeFromEnvOnly(env);
      if (vectorSettings) {
        const vectorEmbedding = pendingFingerprint
          ? pendingEmbeddingOf(vectorSettings)
          : activeEmbeddingOf(vectorSettings);
        const dimensionMismatch = validateCloudflareVectorDimensions(
          env,
          vectorEmbedding.dimensions
        );
        if (dimensionMismatch) {
          return json({
            ...dimensionMismatch,
            processed: 0,
            failed: 0,
            skipped: 0,
            remaining: 0,
            limit,
            retryable: false,
          }, 400);
        }
      }
      const activeRebuild = pendingFingerprint
        ? await loadCurrentVectorRebuild(env, pendingFingerprint)
        : null;
      if (pendingFingerprint && !activeRebuild) {
        return json({
          processed: 0,
          failed: 0,
          skipped: 0,
          remaining: 0,
          limit,
          mode: "blue_green",
          pendingFingerprint,
          activated: 0,
          activationState: "failed",
          activationError: "vector_rebuild_state_missing",
          retryable: false,
        }, 409);
      }
      const openRebuildContext: OpenVectorRebuildContext | null =
        pendingFingerprint &&
        activeRebuild &&
        (activeRebuild.state === "queued" ||
          activeRebuild.state === "building" ||
          activeRebuild.state === "ready")
          ? {
              id: activeRebuild.id,
              pendingFingerprint,
              state: activeRebuild.state,
            }
          : null;
      const usePendingProfile = Boolean(openRebuildContext);
      let reconciledEntries = 0;
      let repairedPendingGenerations = 0;
      if (openRebuildContext) {
        reconciledEntries = await reconcileOpenVectorRebuildEntries(env, openRebuildContext);
        repairedPendingGenerations = await repairStalePendingGenerations(env, openRebuildContext, 50);
      }
      const pendingQueue =
        usePendingProfile && pendingFingerprint && openRebuildContext
          ? await env.DB.prepare(
              `SELECT id, content, tags, source, created_at, content_hash, pending_rebuild_id FROM entries
               WHERE pending_vector_ids = '[]'
                 AND pending_embedding_fingerprint = ?
                 AND pending_rebuild_id = ?
                 AND tags NOT LIKE '%"status:deprecated"%'
                 AND created_at < ?
               ORDER BY created_at DESC LIMIT ?`
            ).bind(pendingFingerprint, openRebuildContext.id, graceCutoff, limit).all()
          : { results: [] };
      const { results: toProcess } = usePendingProfile
        ? pendingQueue
        : await env.DB.prepare(
            `SELECT id, content, tags, source, created_at FROM entries
             WHERE vector_ids = '[]'
               AND tags NOT LIKE '%"status:deprecated"%'
               AND created_at < ?
             ORDER BY created_at DESC LIMIT ?`
          ).bind(graceCutoff, limit).all();

      let processed = 0;
      let failed = 0;
      let skipped = 0;
      const queueRows = (toProcess as Record<string, any>[]).map((row) => ({
        id: row.id as string,
        content: row.content as string,
        tags: row.tags as string,
        source: row.source as string,
        created_at: row.created_at as number,
        content_hash: row.content_hash as string | null | undefined,
        pending_rebuild_id: row.pending_rebuild_id as string | null | undefined,
      }));

      if (queueRows.length) {
        try {
          const batchResult = usePendingProfile && pendingFingerprint
            ? await storePendingEntryVectorBatch(env, queueRows, pendingFingerprint, openRebuildContext!.id)
            : await storeEntryVectorBatch(env, queueRows, pendingFingerprint);
          processed += batchResult.processed;
          failed += batchResult.failed;
          skipped += batchResult.skipped;
        } catch (batchError) {
          console.error("Batch vectorize failed; falling back to per-entry mode:", batchError);
          for (const row of queueRows) {
            try {
              const ids = usePendingProfile && pendingFingerprint
                ? await storePendingEntryVectors(env, row, pendingFingerprint, openRebuildContext!.id)
                : await storeEntry(
                    env,
                    row.id,
                    row.content,
                    JSON.parse(row.tags),
                    row.source,
                    row.created_at
                  );
              if (ids.length) processed++;
              else skipped++;
            } catch (e) {
              console.error("Re-embed failed for entry", row.id, e);
              failed++;
            }
          }
        }
      }

      const claimTargetFingerprint = pendingFingerprint ?? (
        vectorSettings.embeddingFingerprint ??
        embeddingFingerprintOf(activeEmbeddingOf(vectorSettings))
      );
      const claimVectorsEnqueued = await enqueueMissingClaimVectorJobs(env.DB, {
        targetFingerprint: claimTargetFingerprint,
        rebuildId: openRebuildContext?.id ?? null,
        limit: Math.max(limit, 25),
      });
      const claimVectorProcessing = await processClaimVectorQueue(env, {
        targetFingerprint: claimTargetFingerprint,
        rebuildId: openRebuildContext?.id ?? null,
        limit: env.SELFHOST === "1" ? limit : Math.min(limit, 3),
      });
      failed += claimVectorProcessing.failed;
      const claimVectorStatus = await getClaimVectorQueueStatus(
        env.DB,
        claimTargetFingerprint
      );
      const claimVectorsRemaining = claimVectorStatus.missing;

      const pendingQueueRemainingRow = usePendingProfile && pendingFingerprint
        ? await env.DB.prepare(
            `SELECT COUNT(*) as count FROM entries
             WHERE pending_vector_ids = '[]'
               AND pending_embedding_fingerprint = ?
               AND pending_rebuild_id = ?
               AND tags NOT LIKE '%"status:deprecated"%'`
          ).bind(pendingFingerprint, openRebuildContext!.id).first() as Record<string, any> | null
        : await env.DB.prepare(
            `SELECT COUNT(*) as count FROM entries
             WHERE vector_ids = '[]'
               AND tags NOT LIKE '%"status:deprecated"%'
               AND created_at < ?`
          ).bind(graceCutoff).first() as Record<string, any> | null;
      const pendingQueueRemaining = Number(pendingQueueRemainingRow?.count ?? 0);
      const stalePendingRemaining = openRebuildContext
        ? await countStalePendingGenerations(env, openRebuildContext)
        : 0;
      const unjoinedRemaining = openRebuildContext
        ? await countUnjoinedVectorRebuildEntries(env, openRebuildContext)
        : 0;
      const remainingN = usePendingProfile
        ? pendingQueueRemaining + stalePendingRemaining + unjoinedRemaining + claimVectorsRemaining
        : pendingQueueRemaining;
      let activated = 0;
      let activationBlocked = 0;
      let activationIntegrity: PendingActivationIntegrity | null = null;
      let staleVectorsDeleted = 0;
      let staleVectorsQueued = 0;
      let staleVectorsBlocked = 0;
      let cleanupBatchesPrepared = 0;
      let cleanupBatchesReady = 0;
      let activationState = activeRebuild?.state ?? (usePendingProfile ? "failed" : "idle");
      let activationError: string | undefined;
      let retryable = true;

      if (openRebuildContext) {
        await env.DB.prepare(
          `UPDATE sb_vector_rebuilds
           SET state = ?,
               processed_entries = (
                 SELECT COUNT(*)
                 FROM entries
                 WHERE pending_rebuild_id = ?
                   AND pending_vector_ids IS NOT NULL
                   AND pending_vector_ids != '[]'
               ),
               updated_at = ?
           WHERE id = ?
             AND state IN ('queued', 'building', 'ready')`
        ).bind(
          remainingN === 0 && failed === 0 ? "ready" : "building",
          openRebuildContext.id,
          Date.now(),
          openRebuildContext.id
        ).run();
        activationState = remainingN === 0 && failed === 0 ? "ready" : "building";
      }

      // Promote pending embedding fingerprint when full reindex completes cleanly
      if (remainingN === 0 && failed === 0) {
        try {
          const stored = storedSettings ?? await loadStoredModelSettings(env.DB);
          if (stored?.pendingEmbeddingFingerprint && openRebuildContext) {
            activationIntegrity = await inspectPendingActivationIntegrity(
              env,
              stored.pendingEmbeddingFingerprint,
              openRebuildContext.id
            );
            activationBlocked = activationIntegrity.blocked;
            if (activationBlocked === 0) {
              const activationRows = await listPendingActivationRows(
                env,
                stored.pendingEmbeddingFingerprint,
                openRebuildContext.id
              );
              const oldActiveFingerprint = stored.embeddingFingerprint ??
                embeddingFingerprintOf(activeEmbeddingOf(stored));
              const oldClaimVectorIds = oldActiveFingerprint === stored.pendingEmbeddingFingerprint
                ? []
                : await listClaimVectorIdsForFingerprint(env.DB, oldActiveFingerprint);
              const staleVectorIds = [...new Set([
                ...staleVectorIdsAfterActivation(activationRows),
                ...oldClaimVectorIds,
              ])];
              const preparedCleanup = await prepareVectorCleanupBatches(
                env,
                openRebuildContext.id,
                staleVectorIds,
                "prepared"
              );
              cleanupBatchesPrepared = preparedCleanup.batches;
              const activation = await activatePendingVectorsAndSettings(
                env,
                openRebuildContext.id,
                promoteEmbeddingFingerprint(stored)
              );
              if (activation.ok) {
                activated = activation.activated;
                cleanupBatchesReady = activation.cleanupBatchesReady;
                activationState = "active";
              } else {
                activationState = "blocked";
                activationError = activation.error;
              }
            } else {
              activationState = "blocked";
              activationError = "pending_activation_integrity_conflict";
            }
          }
        } catch (e) {
          console.error("Fingerprint promote failed:", e);
          activationState = "failed";
          activationError = e instanceof Error ? e.message : String(e);
        }
      }

      return json({
        processed,
        failed,
        skipped,
        remaining: remainingN,
        pendingQueueRemaining,
        stalePendingRemaining,
        unjoinedRemaining,
        limit,
        mode: usePendingProfile ? "blue_green" : "legacy",
        pendingFingerprint: pendingFingerprint ?? undefined,
        activated,
        activationBlocked,
        activationIntegrity: activationIntegrity ?? undefined,
        staleVectorsDeleted,
        staleVectorsQueued,
        staleVectorsBlocked,
        cleanupBatchesPrepared,
        cleanupBatchesReady,
        activationState,
        activationError,
        retryable,
        reconciledEntries,
        repairedPendingGenerations,
        claimVectorsEnqueued,
        claimVectorProcessing,
        claimVectorStatus,
        claimVectorsRemaining,
      });
    }

    // POST /classify-pending
    // Bounded, resumable classification worker. It handles legacy pending rows and
    // retries failed rows up to CLASSIFICATION_MAX_ATTEMPTS without looping forever.
    // The same queue also runs from scheduled maintenance.
    if (url.pathname === "/classify-pending" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      // Cloudflare's first invocation may also run schema initialization. Keep
      // enough headroom under D1 Free's 50-query invocation cap; self-hosted
      // SQLite does not have that subrequest limit.
      const batchLimit = env.SELFHOST === "1"
        ? CLASSIFICATION_SELFHOST_BATCH_LIMIT
        : CLASSIFICATION_CLOUDFLARE_BATCH_LIMIT;
      return json(await processClassificationQueue(env, batchLimit));
    }

    // POST /import — Cloudflare / dashboard JSON export → entries (vector_ids cleared)
    if (url.pathname === "/import" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const openRebuild = await loadOpenVectorRebuild(env);
      if (openRebuild) {
        return json({
          ok: false,
          error: "import_blocked_during_vector_rebuild",
          rebuildId: openRebuild.id,
          next: "等待向量重建完成或取消重建后再导入。",
        }, 409);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      let entries: unknown[];
      try {
        if (isMemoryBackupPayload(body)) {
          const totalRows = memoryBackupRowCount(body);
          if (env.SELFHOST !== "1" && totalRows > CLOUDFLARE_IMPORT_MAX_ROWS) {
            return json({
              ok: false,
              error: "Full graph backup import is too large for one Cloudflare D1 invocation. Import on self-host or split to an entries-only batch.",
              maxRows: CLOUDFLARE_IMPORT_MAX_ROWS,
              totalRows,
            }, 413);
          }
          const opts = (body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : {}) as {
            mode?: ImportMode;
            extraTags?: string[];
          };
          const result = await importMemoryBackup(env.DB, body as Record<string, unknown>, {
            mode: opts.mode === "overwrite" ? "overwrite" : "skip",
            extraTags: Array.isArray(opts.extraTags)
              ? opts.extraTags.map(String)
              : [],
          });
          return json({
            ...result,
            pendingVectorize: result.pendingVectorizeSample,
            next:
              result.pendingVectorizeCount > 0
                ? "Run POST /vectorize-pending with { limit, includeRecent: true } in a loop until remaining=0."
                : undefined,
          });
        }
        if (
          body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          Number((body as Record<string, unknown>).schemaVersion) >= 5
        ) {
          return json({
            ok: false,
            error: "Invalid memory backup: schemaVersion 5+ requires backupFormat=singularity-memory-backup",
          }, 400);
        }

        // Body may be raw array, { entries }, or { entries, mode, extraTags }
        if (body && typeof body === "object" && !Array.isArray(body) && "entries" in (body as object)) {
          entries = parseImportPayload(body);
        } else {
          entries = parseImportPayload(body);
        }
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
      }

      if (env.SELFHOST !== "1" && entries.length > CLOUDFLARE_IMPORT_MAX_ROWS) {
        return json({
          ok: false,
          error: `Cloudflare import accepts at most ${CLOUDFLARE_IMPORT_MAX_ROWS} rows per request. Split the export into smaller batches.`,
          maxRows: CLOUDFLARE_IMPORT_MAX_ROWS,
        }, 413);
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

    // ── Control plane: personal OAuth clients ───────────────────────────────
    if (url.pathname === "/settings/oauth/clients" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const cursor = url.searchParams.get("cursor") || undefined;
      const result = await (env as any).OAUTH_PROVIDER.listClients({
        limit: 100,
        cursor,
      });
      return json({
        ok: true,
        clients: (result.items ?? []).map((client: any) => ({
          clientId: client.clientId,
          clientName: client.clientName || client.clientId,
          redirectUris: Array.isArray(client.redirectUris) ? client.redirectUris : [],
          grantTypes: Array.isArray(client.grantTypes) ? client.grantTypes : [],
          registrationDate: client.registrationDate ?? null,
        })),
        cursor: result.cursor,
      });
    }

    const oauthClientSettingsPrefix = "/settings/oauth/clients/";
    if (
      url.pathname.startsWith(oauthClientSettingsPrefix) &&
      request.method === "DELETE"
    ) {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      let clientId = "";
      try {
        clientId = decodeURIComponent(
          url.pathname.slice(oauthClientSettingsPrefix.length)
        ).trim();
      } catch {
        return json({ ok: false, error: "Invalid OAuth client ID" }, 400);
      }
      if (!clientId || clientId.includes("/")) {
        return json({ ok: false, error: "Invalid OAuth client ID" }, 400);
      }
      await (env as any).OAUTH_PROVIDER.deleteClient(clientId);
      return json({ ok: true, deleted: clientId });
    }

    // ── Control plane: model settings ───────────────────────────────────────
    if (url.pathname === "/settings/models" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

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
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

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

      if (body.embedding) {
        const dimensionMismatch = validateCloudflareVectorDimensions(
          env,
          next.embedding.dimensions
        );
        if (dimensionMismatch) return json(dimensionMismatch, 400);

        const nextFp = embeddingFingerprintOf(next.embedding);
        const previousActiveEmbedding = activeEmbeddingOf(previous);
        const previousActiveFp =
          previous.embeddingFingerprint ?? embeddingFingerprintOf(previousActiveEmbedding);
        const hasExistingActiveVectors = await hasActiveEntryVectors(env);

        if (!previous.embeddingFingerprint && !previous.activeEmbedding && !hasExistingActiveVectors) {
          // First-time embed config: no old active generation exists, so activate directly.
          next.activeEmbedding = cloneEmbeddingSettings(next.embedding);
          next.embeddingFingerprint = nextFp;
          next.pendingEmbedding = undefined;
          next.pendingEmbeddingFingerprint = undefined;
        } else if (nextFp !== previousActiveFp) {
          next.activeEmbedding = cloneEmbeddingSettings(previousActiveEmbedding);
          next.embeddingFingerprint = previousActiveFp;
          next.pendingEmbedding = cloneEmbeddingSettings(next.embedding);
          next.pendingEmbeddingFingerprint = nextFp;
        } else {
          next.activeEmbedding = cloneEmbeddingSettings(next.embedding);
          next.embeddingFingerprint = nextFp;
          next.pendingEmbedding = undefined;
          next.pendingEmbeddingFingerprint = undefined;
        }
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
          ? "向量配置已变更。请点击「开始重建」或 POST /settings/models/reindex，再循环调用 vectorize-pending；重建期间旧向量继续作为活跃集。"
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
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

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

    // POST /settings/models/reindex/cancel — abandon a pending blue/green rebuild.
    if (url.pathname === "/settings/models/reindex/cancel" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      const stored = await loadStoredModelSettings(env.DB);
      const pendingFingerprint = stored?.pendingEmbeddingFingerprint;
      if (!stored || !pendingFingerprint) {
        return json({
          ok: true,
          cancelled: false,
          message: "No pending vector rebuild is active.",
        });
      }

      const cancelled = await cancelVectorRebuild(env, stored, "manual_cancel_rebuild");

      return json({
        ok: true,
        cancelled: cancelled.cancelled,
        pendingFingerprint,
        pendingVectorsDeleted: 0,
        pendingVectorsQueued: cancelled.cleanupVectorsPrepared,
        cleanupBatchesPrepared: cancelled.cleanupBatchesPrepared,
        entriesCleared: cancelled.entriesCleared,
        reindexRequired: false,
      });
    }

    // POST /settings/models/reindex — blue/green vector rebuild.
    // Existing vector_ids stay active; vectorize-pending writes pending_vector_ids
    // and promotes them only after the whole pending profile finishes cleanly.
    if (url.pathname === "/settings/models/reindex" && request.method === "POST") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      let body: { cancelExisting?: boolean } = {};
      try {
        body = await request.json();
      } catch {
        /* empty body OK */
      }
      const { effective, stored } = await getEffectiveModelSettings(env);
      let cancelledExisting = false;
      let cancelledEntriesCleared = 0;
      let cancelledPendingVectorsDeleted = 0;
      let cancelledPendingVectorsQueued = 0;
      let cancelledCleanupBatchesPrepared = 0;

      if (stored?.pendingEmbeddingFingerprint) {
        const existingPendingFingerprint = stored.pendingEmbeddingFingerprint;
        if (body.cancelExisting !== true) {
          const pendingRows = await countPendingRebuildRows(env, existingPendingFingerprint);
          return json({
            ok: false,
            error: "rebuild_already_running",
            pendingFingerprint: existingPendingFingerprint,
            pendingRows,
            next: "POST /settings/models/reindex with {\"cancelExisting\":true} to discard the pending rebuild and start a new one.",
          }, 409);
        }

        const cancelled = await cancelVectorRebuild(env, stored, "cancel_existing_rebuild");
        cancelledEntriesCleared = cancelled.entriesCleared;
        cancelledPendingVectorsQueued = cancelled.cleanupVectorsPrepared;
        cancelledCleanupBatchesPrepared = cancelled.cleanupBatchesPrepared;
        cancelledExisting = cancelled.cancelled;
      }

      const activeEmbedding = activeEmbeddingOf(effective);
      const pendingEmbedding = pendingEmbeddingOf(effective);
      const dimensionMismatch = validateCloudflareVectorDimensions(
        env,
        pendingEmbedding.dimensions
      );
      if (dimensionMismatch) return json(dimensionMismatch, 400);
      const pending = embeddingFingerprintOf(pendingEmbedding);
      const settingsForQueue = structuredClone(stored ?? mergeFromEnvOnly(env));
      const now = Date.now();
      const rebuildId = crypto.randomUUID();
      const activeFingerprint =
        effective.embeddingFingerprint ?? embeddingFingerprintOf(activeEmbedding);
      settingsForQueue.activeEmbedding = cloneEmbeddingSettings(activeEmbedding);
      settingsForQueue.embeddingFingerprint = activeFingerprint;
      settingsForQueue.embedding = cloneEmbeddingSettings(pendingEmbedding);
      settingsForQueue.pendingEmbedding = cloneEmbeddingSettings(pendingEmbedding);
      settingsForQueue.pendingEmbeddingFingerprint = pending;
      settingsForQueue.updatedAt = now;
      // Do NOT promote active fingerprint here — wait until remaining=0.
      const batch = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO sb_vector_rebuilds (
             id,
             slot,
             state,
             active_fingerprint,
             pending_fingerprint,
             expected_entries,
             processed_entries,
             failed_entries,
             conflict_entries,
             last_error,
             created_at,
             updated_at
           )
           SELECT ?, 'current', 'queued', ?, ?, COUNT(*), 0, 0, 0, NULL, ?, ?
           FROM entries
           WHERE tags NOT LIKE '%"status:deprecated"%'
           ON CONFLICT(slot) DO UPDATE SET
             id = excluded.id,
             state = excluded.state,
             active_fingerprint = excluded.active_fingerprint,
             pending_fingerprint = excluded.pending_fingerprint,
             expected_entries = excluded.expected_entries,
             processed_entries = 0,
             failed_entries = 0,
             conflict_entries = 0,
             last_error = NULL,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at`
        ).bind(rebuildId, activeFingerprint, pending, now, now),
        prepareStoredModelSettingsSave(env.DB, settingsForQueue),
        env.DB.prepare(
          `UPDATE entries
           SET pending_vector_ids = '[]',
               pending_embedding_fingerprint = ?,
               pending_content_hash = NULL,
               pending_revision_id = NULL,
               pending_metadata_hash = NULL,
               pending_rebuild_id = ?
           WHERE tags NOT LIKE '%"status:deprecated"%'`
        ).bind(pending, rebuildId),
      ]);
      setStoredModelSettingsCache(settingsForQueue);
      const rows = Number(batch[2]?.meta?.changes ?? 0);
      const claimJobsQueued = await enqueueMissingClaimVectorJobs(env.DB, {
        targetFingerprint: pending,
        rebuildId,
        limit: 200,
      });

      return json({
        ok: true,
        mode: "blue_green",
        rebuildId,
        clearedVectors: 0,
        entriesReset: 0,
        entriesQueued: rows,
        claimJobsQueued,
        cancelledExisting,
        cancelledEntriesCleared,
        cancelledPendingVectorsDeleted,
        cancelledPendingVectorsQueued,
        cancelledCleanupBatchesPrepared,
        reindexRequired: true,
        pendingFingerprint: pending,
        next: "Loop POST /vectorize-pending {\"limit\":100,\"includeRecent\":true} until remaining=0. Active fingerprint promotes only when finished with failed=0.",
      });
    }

    // GET /settings/telemetry — privacy and retention controls
    if (url.pathname === "/settings/telemetry" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      return json({ ok: true, telemetry: await loadTelemetryConfig(env) });
    }

    // PUT /settings/telemetry — validate before persisting user-controlled values
    if (url.pathname === "/settings/telemetry" && request.method === "PUT") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
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

    // GET /analytics/vector-runtime — lightweight vector rebuild / cleanup / local index status.
    if (url.pathname === "/analytics/vector-runtime" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      return json({
        ok: true,
        generated_at: Date.now(),
        vector_runtime: await loadVectorRuntimeSnapshot(env),
      });
    }

    // GET /analytics/memory-overview — four-layer memory health and composition.
    if (url.pathname === "/analytics/memory-overview" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      const now = Date.now();
      const graceCutoff = now - graceMs(env);
      const [
        totals,
        queue,
        unclassified,
        unvectorized,
        classificationTerminalErrors,
        orphanAtomicMemories,
        unlinkedEntityMemories,
        kindRows,
        classRows,
        topEntities,
        relationTypes,
        observationRows,
        sourceRows,
        revisionRows,
        vectorRebuild,
        vectorCleanupQueueRows,
        vectorCleanupBatchRows,
        vectorCleanupQueueDue,
        vectorCleanupBatchDue,
      ] = await Promise.all([
        env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM sb_observations) as observations,
             (SELECT COUNT(*) FROM sb_memories
              WHERE invalid_at IS NULL AND expired_at IS NULL) as atomic_memories,
             (SELECT COUNT(*) FROM sb_entities) as entities,
             (SELECT COUNT(*) FROM sb_entity_relations
              WHERE invalid_at IS NULL
                AND expired_at IS NULL
                AND (valid_to IS NULL OR valid_to > ?)) as active_facts`
        ).bind(now).first<Record<string, unknown>>(),
        inspectExtractionQueue(env, 50),
        env.DB.prepare(
          `SELECT COUNT(*) as count FROM entries
           WHERE tags NOT LIKE '%"status:deprecated"%'
             AND (classification_status IS NULL OR classification_status <> 'succeeded')`
        ).first<{ count: number }>(),
        env.DB.prepare(
          `SELECT COUNT(*) as count FROM entries
           WHERE vector_ids = '[]'
             AND tags NOT LIKE '%"status:deprecated"%'
             AND created_at < ?`
        ).bind(graceCutoff).first<{ count: number }>(),
        env.DB.prepare(
          `SELECT COUNT(*) as count FROM entries
           WHERE classification_status = 'terminal_error'`
        ).first<{ count: number }>(),
        env.DB.prepare(
          `SELECT COUNT(*) as count FROM sb_memories
           WHERE invalid_at IS NULL
             AND expired_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM sb_memory_sources
               WHERE sb_memory_sources.memory_id = sb_memories.id
             )`
        ).first<{ count: number }>(),
        env.DB.prepare(
          `SELECT COUNT(*) as count FROM sb_memories
           WHERE invalid_at IS NULL
             AND expired_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM sb_memory_entities
               WHERE sb_memory_entities.memory_id = sb_memories.id
             )`
        ).first<{ count: number }>(),
        env.DB.prepare(
          `SELECT COALESCE(kind, 'unknown') as name, COUNT(*) as count
           FROM sb_memories
           WHERE invalid_at IS NULL AND expired_at IS NULL
           GROUP BY COALESCE(kind, 'unknown')
           ORDER BY count DESC, name ASC`
        ).all(),
        env.DB.prepare(
          `SELECT COALESCE(memory_class, 'unknown') as name, COUNT(*) as count
           FROM sb_memories
           WHERE invalid_at IS NULL AND expired_at IS NULL
           GROUP BY COALESCE(memory_class, 'unknown')
           ORDER BY count DESC, name ASC`
        ).all(),
        env.DB.prepare(
          `SELECT id, name, entity_type, mention_count
           FROM sb_entities
           ORDER BY mention_count DESC, updated_at DESC
           LIMIT 12`
        ).all(),
        env.DB.prepare(
          `SELECT relation_type as name, COUNT(*) as count
           FROM sb_entity_relations
           WHERE invalid_at IS NULL
             AND expired_at IS NULL
             AND (valid_to IS NULL OR valid_to > ?)
           GROUP BY relation_type
           ORDER BY count DESC, name ASC
           LIMIT 12`
        ).bind(now).all(),
        env.DB.prepare(
          `SELECT id, source, extraction_status, needs_reprocess,
                  created_at, processed_at, substr(content, 1, 180) as preview
           FROM sb_observations
           ORDER BY created_at DESC
           LIMIT 10`
        ).all(),
        env.DB.prepare(
          `SELECT s.memory_id, s.observation_id, s.role, s.created_at,
                  o.source, substr(o.content, 1, 180) as preview
           FROM sb_memory_sources s
           LEFT JOIN sb_observations o ON o.id = s.observation_id
           ORDER BY s.created_at DESC
           LIMIT 10`
        ).all(),
        env.DB.prepare(
          `SELECT id, memory_id, event_type, actor, reason, created_at
           FROM sb_memory_revisions
           ORDER BY created_at DESC
           LIMIT 10`
        ).all(),
        env.DB.prepare(
          `SELECT r.id, r.state, r.active_fingerprint, r.pending_fingerprint,
                  r.expected_entries, r.processed_entries, r.failed_entries,
                  r.conflict_entries, r.last_error, r.created_at, r.updated_at,
                  (SELECT COUNT(*) FROM entries e
                   WHERE e.pending_rebuild_id = r.id
                     AND e.tags NOT LIKE '%"status:deprecated"%') as joined_entries,
                  (SELECT COUNT(*) FROM entries e
                   WHERE e.pending_rebuild_id = r.id
                     AND e.pending_vector_ids IS NOT NULL
                     AND e.pending_vector_ids != '[]'
                     AND e.pending_content_hash IS NOT NULL
                     AND e.pending_revision_id IS NOT NULL
                     AND e.pending_metadata_hash IS NOT NULL
                     AND e.content_hash = e.pending_content_hash
                     AND e.metadata_hash = e.pending_metadata_hash
                     AND e.tags NOT LIKE '%"status:deprecated"%') as ready_entries,
                  (SELECT COUNT(*) FROM entries e
                   WHERE e.pending_rebuild_id = r.id
                     AND (e.pending_vector_ids IS NULL OR e.pending_vector_ids = '[]')
                     AND e.tags NOT LIKE '%"status:deprecated"%') as missing_entries,
                  (SELECT COUNT(*) FROM entries e
                   WHERE e.pending_rebuild_id = r.id
                     AND e.pending_vector_ids IS NOT NULL
                     AND e.pending_vector_ids != '[]'
                     AND (
                       e.pending_content_hash IS NULL
                       OR e.pending_revision_id IS NULL
                       OR e.pending_metadata_hash IS NULL
                       OR e.content_hash IS NULL
                       OR e.metadata_hash IS NULL
                       OR e.content_hash != e.pending_content_hash
                       OR e.metadata_hash != e.pending_metadata_hash
                     )
                     AND e.tags NOT LIKE '%"status:deprecated"%') as live_conflict_entries
           FROM sb_vector_rebuilds r
           WHERE r.slot = 'current'
           LIMIT 1`
        ).first<Record<string, unknown>>(),
        env.DB.prepare(
          `SELECT state, COUNT(*) as count
           FROM sb_vector_cleanup_queue
           GROUP BY state`
        ).all(),
        env.DB.prepare(
          `SELECT state, COUNT(*) as count
           FROM sb_vector_cleanup_batches
           GROUP BY state`
        ).all(),
        env.DB.prepare(
          `SELECT COUNT(*) as count
           FROM sb_vector_cleanup_queue
           WHERE state = 'ready'
             AND COALESCE(next_attempt_at, 0) <= ?`
        ).bind(now).first<{ count: number }>(),
        env.DB.prepare(
          `SELECT COUNT(*) as count
           FROM sb_vector_cleanup_batches
           WHERE state = 'ready'
             AND COALESCE(next_attempt_at, 0) <= ?`
        ).bind(now).first<{ count: number }>(),
      ]);

      const summarizeStates = (
        rows: Record<string, unknown>[],
        states: string[]
      ): Record<string, number> => {
        const summary: Record<string, number> = { total: 0 };
        for (const state of states) summary[state] = 0;
        for (const row of rows) {
          const state = String(row.state ?? "unknown");
          const count = Number(row.count ?? 0);
          summary[state] = (summary[state] ?? 0) + count;
          summary.total += count;
        }
        return summary;
      };
      const localIndexStatus = (env.VECTORIZE as any).indexStatus?.();
      const recentChanges = [
        ...((observationRows.results ?? []) as Record<string, unknown>[]).map((row) => ({
          type: "observation",
          id: row.id,
          label: row.extraction_status,
          source: row.source,
          preview: row.preview,
          created_at: row.created_at,
          needs_reprocess: Number(row.needs_reprocess ?? 0) === 1,
        })),
        ...((sourceRows.results ?? []) as Record<string, unknown>[]).map((row) => ({
          type: "source_linked",
          id: row.observation_id,
          memory_id: row.memory_id,
          source: row.source,
          preview: row.preview,
          created_at: row.created_at,
        })),
        ...((revisionRows.results ?? []) as Record<string, unknown>[]).map((row) => ({
          type: "revision",
          id: row.id,
          memory_id: row.memory_id,
          label: row.event_type,
          source: row.actor,
          preview: row.reason,
          created_at: row.created_at,
        })),
      ]
        .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
        .slice(0, 12);

      const serializeVectorRebuild = (row: Record<string, unknown>) => ({
        id: String(row.id),
        state: String(row.state),
        active_fingerprint: String(row.active_fingerprint ?? ""),
        pending_fingerprint: String(row.pending_fingerprint ?? ""),
        expected_entries: Number(row.expected_entries ?? 0),
        processed_entries: Number(row.processed_entries ?? 0),
        failed_entries: Number(row.failed_entries ?? 0),
        conflict_entries: Number(row.conflict_entries ?? 0),
        live_conflict_entries: Number(row.live_conflict_entries ?? 0),
        joined_entries: Number(row.joined_entries ?? 0),
        ready_entries: Number(row.ready_entries ?? 0),
        missing_entries: Number(row.missing_entries ?? 0),
        last_error: row.last_error ? String(row.last_error) : null,
        created_at: Number(row.created_at ?? 0),
        updated_at: Number(row.updated_at ?? 0),
      });
      const serializedVectorRebuild = vectorRebuild
        ? serializeVectorRebuild(vectorRebuild)
        : null;
      const activeVectorRebuild = serializedVectorRebuild &&
        !["active", "cancelled", "failed"].includes(serializedVectorRebuild.state)
        ? serializedVectorRebuild
        : null;

      return json({
        ok: true,
        generated_at: now,
        totals: {
          observations: Number(totals?.observations ?? 0),
          atomic_memories: Number(totals?.atomic_memories ?? 0),
          entities: Number(totals?.entities ?? 0),
          active_facts: Number(totals?.active_facts ?? 0),
        },
        health: {
          extraction_due: queue.due,
          fallback_reprocess: queue.fallbackReprocess,
          partial_error: queue.partialError,
          orphan_pending: queue.orphanPending,
          retryable_due: queue.retryableDue,
          stale_processing: queue.staleProcessing,
          terminal_errors: queue.exhausted,
          unclassified: Number(unclassified?.count ?? 0),
          unvectorized: Number(unvectorized?.count ?? 0),
          classification_terminal_errors: Number(classificationTerminalErrors?.count ?? 0),
          orphan_atomic_memories: Number(orphanAtomicMemories?.count ?? 0),
          unlinked_entity_memories: Number(unlinkedEntityMemories?.count ?? 0),
        },
        kinds: (kindRows.results ?? []).map((row: any) => ({
          name: String(row.name ?? "unknown"),
          count: Number(row.count ?? 0),
        })),
        classes: (classRows.results ?? []).map((row: any) => ({
          name: String(row.name ?? "unknown"),
          count: Number(row.count ?? 0),
        })),
        top_entities: (topEntities.results ?? []).map((row: any) => ({
          id: row.id,
          name: row.name,
          type: row.entity_type,
          mention_count: Number(row.mention_count ?? 0),
        })),
        relation_types: (relationTypes.results ?? []).map((row: any) => ({
          name: String(row.name ?? "unknown"),
          count: Number(row.count ?? 0),
        })),
        vector_runtime: {
          rebuild: activeVectorRebuild,
          last_rebuild: serializedVectorRebuild,
          cleanup: {
            queue: {
              ...summarizeStates(
                (vectorCleanupQueueRows.results ?? []) as Record<string, unknown>[],
                ["ready", "blocked", "failed", "completed"]
              ),
              due: Number(vectorCleanupQueueDue?.count ?? 0),
            },
            batches: {
              ...summarizeStates(
                (vectorCleanupBatchRows.results ?? []) as Record<string, unknown>[],
                ["prepared", "ready", "processing", "blocked", "failed", "completed"]
              ),
              due: Number(vectorCleanupBatchDue?.count ?? 0),
            },
          },
          local_index: localIndexStatus ? {
            vectorCount: Number(localIndexStatus.vectorCount ?? 0),
            ftsAvailable: Boolean(localIndexStatus.ftsAvailable),
            ftsTokenizer: localIndexStatus.ftsTokenizer ?? null,
            ftsIndexed: Number(localIndexStatus.ftsIndexed ?? 0),
            vecAvailable: Boolean(localIndexStatus.vecAvailable),
            vecIndexed: Number(localIndexStatus.vecIndexed ?? 0),
            profileVectorCount: Number(localIndexStatus.profileVectorCount ?? 0),
            profileVecIndexed: Number(localIndexStatus.profileVecIndexed ?? 0),
            profileVecRemaining: Number(localIndexStatus.profileVecRemaining ?? 0),
            filteredVecAvailable: Boolean(localIndexStatus.filteredVecAvailable),
            filteredQueryBackend: String(localIndexStatus.filteredQueryBackend ?? "json-filter-scan"),
            remaining: Number(localIndexStatus.remaining ?? 0),
          } : null,
        },
        recent_changes: recentChanges,
      });
    }

    // GET /analytics/overview — Observatory KPIs (last 24h by default)
    if (url.pathname === "/analytics/overview" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
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
        telemetry_queue: getTelemetryQueueStats(),
      });
    }

    // GET /analytics/timeseries — one point per hour for charts.
    if (url.pathname === "/analytics/timeseries" && request.method === "GET") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
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
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
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
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
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
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;
      const cfg = await loadTelemetryConfig(env);
      const result = await purgeOldTelemetry(env.DB, cfg.retentionDays);
      return json({ ok: true, ...result, retentionDays: cfg.retentionDays });
    }

    return new Response("Not found", { status: 404 });
    }); // withRequestTelemetry
    return applyManagementCors(request, response, env);
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
    base.activeEmbedding = cloneEmbeddingSettings(base.embedding);
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
    base.embeddingFingerprint = embeddingFingerprintOf(base.embedding);
    base.activeEmbedding = cloneEmbeddingSettings(base.embedding);
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
  scopesSupported: ["mcp"],
  // ChatGPT / modern MCP clients use S256 PKCE
  allowPlainPKCE: false,
  // Public clients (token_endpoint_auth_method=none) are allowed for PKCE
  accessTokenTTL: 3600,
  // Accept the static AUTH_TOKEN for Claude Desktop + mcp-remote (no browser flow).
  resolveExternalToken: async ({ token, env, request }) => {
    if (token === (env as Env).AUTH_TOKEN) {
      return {
        props: { userId: "owner" },
        audience: `${new URL(request.url).origin}/mcp`,
      };
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

async function rejectUnsupportedOAuthTokenScope(
  request: Request,
  pathname: string
): Promise<Response | null> {
  if (pathname !== "/oauth/token" || request.method !== "POST") return null;
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await request.clone().text());
  } catch {
    return null;
  }
  if (!params.has("scope")) return null;
  const requested = (params.get("scope") || "").split(/\s+/).filter(Boolean);
  if (requested.length === 1 && requested[0] === "mcp") return null;
  return new Response(
    JSON.stringify({
      error: "invalid_scope",
      error_description: "This personal MCP supports only scope=mcp.",
    }),
    {
      status: 400,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    // 1) Discovery must work before OAuthProvider / static routing
    const discovery = await handleOAuthDiscovery(req, env);
    if (discovery) return discovery;

    const url = new URL(req.url);

    // 2) Friendly GET/HEAD probes for token/register (diagnostics / curl -I)
    const probe = oauthMethodProbe(req, url.pathname);
    if (probe) return probe;

    // The provider downscopes unknown values to an empty scope but does not
    // enforce that scope at the MCP route. Reject misleading token scopes here.
    const tokenScopeError = await rejectUnsupportedOAuthTokenScope(req, url.pathname);
    if (tokenScopeError) return tokenScopeError;

    // Reject scanner traffic before OAuthProvider, telemetry, or schema setup.
    // The self-host server uses the same policy before forwarding to this Worker.
    if (!isKnownWorkerRoute(req.method, url.pathname)) {
      return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // 3) Normalize origin so token WWW-Authenticate + redirects use public HTTPS
    const normalized = rewriteRequestPublicOrigin(
      req,
      env as Env & { PUBLIC_URL?: string }
    );
    const response = await oauthProvider.fetch(normalized, env as any, ctx);

    // 4) Absolute registration_client_uri + CORS for ChatGPT
    return hardenOAuthResponse(
      normalized,
      response,
      env as Env & { PUBLIC_URL?: string }
    );
  },
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduledMaintenance(env, ctx));
  },
};
