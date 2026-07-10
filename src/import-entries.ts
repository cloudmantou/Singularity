/**
 * Import Cloudflare / dashboard JSON exports into the entries table.
 */

export type ImportMode = "skip" | "overwrite";

export interface ImportOptions {
  mode?: ImportMode;
  extraTags?: string[];
}

export interface ImportResult {
  ok: true;
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: { index: number; id?: string; error: string }[];
  /** Sample of IDs needing re-embed (not full list when huge). */
  pendingVectorizeSample: string[];
  pendingVectorizeCount: number;
}

function normalizeTags(raw: unknown, extra: string[]): string[] {
  let tags: string[] = [];
  if (Array.isArray(raw)) {
    tags = raw.map(String).map((t) => t.trim()).filter(Boolean);
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        tags = parsed.map(String).map((t) => t.trim()).filter(Boolean);
      } else {
        tags = raw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
      }
    } catch {
      tags = raw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    }
  }
  for (const t of extra) {
    if (t && !tags.includes(t)) tags.push(t);
  }
  return tags;
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s || null;
}

function asSafeInt(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return fallback;
}

/** Unix seconds → ms; already-ms values left alone. */
export function normalizeTimestamp(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return Date.now();
  // Real unix-seconds for modern dates: ~1e9–2e10; ms stamps are >= 1e12.
  // Do not multiply small fixture values (e.g. created_at: 99 in tests).
  if (value >= 1_000_000_000 && value < 1_000_000_000_000) return Math.floor(value * 1000);
  return Math.floor(value);
}

function asCreatedAt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return normalizeTimestamp(v);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return normalizeTimestamp(n);
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return d;
  }
  return Date.now();
}

export function parseImportPayload(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.entries)) return o.entries;
    if (Array.isArray(o.memories)) return o.memories;
    if (Array.isArray(o.data)) return o.data;
  }
  throw new Error("Import body must be a JSON array or { entries: [...] }");
}

export async function importEntries(
  db: D1Database,
  rawEntries: unknown[],
  options: ImportOptions = {}
): Promise<ImportResult> {
  const mode: ImportMode = options.mode === "overwrite" ? "overwrite" : "skip";
  const extraTags = options.extraTags ?? ["cf-import"];

  const result: ImportResult = {
    ok: true,
    total: rawEntries.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    pendingVectorizeSample: [],
    pendingVectorizeCount: 0,
  };

  const pendingIds: string[] = [];

  for (let i = 0; i < rawEntries.length; i++) {
    const row = rawEntries[i];
    try {
      if (!row || typeof row !== "object") {
        throw new Error("entry must be an object");
      }
      const r = row as Record<string, unknown>;
      const content = asNonEmptyString(r.content);
      if (!content) throw new Error("content is required");

      const id =
        asNonEmptyString(r.id) ||
        (typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `import-${Date.now()}-${i}`);

      const tags = normalizeTags(r.tags, extraTags);
      const source = asNonEmptyString(r.source) || "import";
      const created_at = asCreatedAt(r.created_at);
      const tagsJson = JSON.stringify(tags);
      const vectorIds = "[]";
      const recall_count = asSafeInt(r.recall_count, 0);
      const importance_score = asSafeInt(r.importance_score, 0);
      const contradiction_wins = asSafeInt(r.contradiction_wins, 0);
      const contradiction_losses = asSafeInt(r.contradiction_losses, 0);

      const existing = await db
        .prepare(`SELECT id FROM entries WHERE id = ?`)
        .bind(id)
        .first<{ id: string }>();

      if (existing) {
        if (mode === "skip") {
          result.skipped++;
          continue;
        }
        await db
          .prepare(
            `UPDATE entries SET content = ?, tags = ?, source = ?, created_at = ?, vector_ids = ?,
             recall_count = ?, importance_score = ?, contradiction_wins = ?, contradiction_losses = ?
             WHERE id = ?`
          )
          .bind(
            content,
            tagsJson,
            source,
            created_at,
            vectorIds,
            recall_count,
            importance_score,
            contradiction_wins,
            contradiction_losses,
            id
          )
          .run();
        result.updated++;
        pendingIds.push(id);
      } else {
        await db
          .prepare(
            `INSERT INTO entries (id, content, tags, source, created_at, vector_ids,
             recall_count, importance_score, contradiction_wins, contradiction_losses)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            content,
            tagsJson,
            source,
            created_at,
            vectorIds,
            recall_count,
            importance_score,
            contradiction_wins,
            contradiction_losses
          )
          .run();
        result.inserted++;
        pendingIds.push(id);
      }
    } catch (e) {
      result.failed++;
      result.errors.push({
        index: i,
        id:
          row && typeof row === "object"
            ? asNonEmptyString((row as any).id) || undefined
            : undefined,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  result.pendingVectorizeCount = pendingIds.length;
  result.pendingVectorizeSample = pendingIds.slice(0, 5);
  return result;
}
