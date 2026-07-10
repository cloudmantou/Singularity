/**
 * Import Cloudflare / dashboard JSON exports into the entries table.
 *
 * - Preserves id, content, source, created_at, tags when present
 * - Always clears vector_ids (re-embed with current embedding provider)
 * - tags may be a JSON string or string[]
 */

export type ImportMode = "skip" | "overwrite";

export interface ImportOptions {
  mode?: ImportMode;
  /** Extra tags appended to every imported row (e.g. cf-import). */
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
  /** IDs that need re-embedding (inserted + overwritten). */
  pendingVectorize: string[];
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

function asCreatedAt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
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

/**
 * Insert/overwrite rows from an export. Does not call embedding/Vectorize.
 * Caller should run POST /vectorize-pending after import when ready.
 */
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
    pendingVectorize: [],
  };

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
      const vectorIds = "[]"; // never reuse Cloudflare Vectorize IDs

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
            `UPDATE entries SET content = ?, tags = ?, source = ?, created_at = ?, vector_ids = ? WHERE id = ?`
          )
          .bind(content, tagsJson, source, created_at, vectorIds, id)
          .run();
        result.updated++;
        result.pendingVectorize.push(id);
      } else {
        await db
          .prepare(
            `INSERT INTO entries (id, content, tags, source, created_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(id, content, tagsJson, source, created_at, vectorIds)
          .run();
        result.inserted++;
        result.pendingVectorize.push(id);
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

  return result;
}
