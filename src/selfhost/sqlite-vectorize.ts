/**
 * Vectorize-compatible local store using SQLite + in-process cosine similarity.
 * Fine for personal-scale corpora; swap for sqlite-vec later without changing callers.
 */

import type Database from "better-sqlite3";

/** Strict cosine — refuses dimension mismatch (no silent truncation). */
function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: query ${a.length} vs stored ${b.length}. Reindex after changing embedding config.`
    );
  }
  const n = a.length;
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface StoredVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

interface SqliteVectorizeQueryOptions {
  topK?: number;
  returnMetadata?: boolean | "none" | "indexed" | "all";
  returnValues?: boolean;
  filter?: Record<string, unknown>;
  /** Self-host extension: lexical candidate prefilter before cosine ranking. */
  queryText?: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function ftsContent(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return "";
  const parts = [
    metadata.content,
    metadata.source,
    Array.isArray(metadata.tags) ? metadata.tags.join(" ") : undefined,
  ];
  return parts
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join("\n");
}

function buildFtsQuery(raw: string | undefined): string | null {
  const tokens = (raw ?? "")
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)
    ?.filter((token) => token.length >= 2)
    .slice(0, 12);
  if (!tokens?.length) return null;
  return tokens
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" OR ");
}

export class SqliteVectorizeIndex {
  private ftsAvailable = false;

  constructor(private db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sb_vectors (
        id TEXT PRIMARY KEY,
        values_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS sb_vector_fts
        USING fts5(id UNINDEXED, content, tokenize='unicode61');
      `);
      this.ftsAvailable = true;
    } catch (error) {
      this.ftsAvailable = false;
      console.warn("SQLite FTS5 unavailable; vector queries will scan all rows:", error);
    }
  }

  async insert(
    vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]
  ): Promise<{ mutationId: string }> {
    const upsert = this.db.prepare(`
      INSERT INTO sb_vectors (id, values_json, metadata_json)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        values_json = excluded.values_json,
        metadata_json = excluded.metadata_json
    `);
    const deleteFts = this.ftsAvailable
      ? this.db.prepare(`DELETE FROM sb_vector_fts WHERE id = ?`)
      : null;
    const insertFts = this.ftsAvailable
      ? this.db.prepare(`INSERT INTO sb_vector_fts (id, content) VALUES (?, ?)`)
      : null;
    const tx = this.db.transaction((rows: typeof vectors) => {
      for (const v of rows) {
        const metadata = v.metadata ?? {};
        upsert.run(v.id, JSON.stringify(v.values), JSON.stringify(metadata));
        deleteFts?.run(v.id);
        insertFts?.run(v.id, ftsContent(metadata));
      }
    });
    tx(vectors);
    return { mutationId: `ins-${Date.now()}` };
  }

  async upsert(
    vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]
  ): Promise<{ mutationId: string }> {
    return this.insert(vectors);
  }

  async deleteByIds(ids: string[]): Promise<{ mutationId: string }> {
    if (!ids.length) return { mutationId: `del-${Date.now()}` };
    const del = this.db.prepare(`DELETE FROM sb_vectors WHERE id = ?`);
    const deleteFts = this.ftsAvailable
      ? this.db.prepare(`DELETE FROM sb_vector_fts WHERE id = ?`)
      : null;
    const tx = this.db.transaction((rowIds: string[]) => {
      for (const id of rowIds) {
        del.run(id);
        deleteFts?.run(id);
      }
    });
    tx(ids);
    return { mutationId: `del-${Date.now()}` };
  }

  async getByIds(ids: string[]): Promise<VectorizeVector[]> {
    if (!ids.length) return [];
    const get = this.db.prepare(
      `SELECT id, values_json, metadata_json FROM sb_vectors WHERE id = ?`
    );
    const out: VectorizeVector[] = [];
    for (const id of ids) {
      const row = get.get(id) as
        | { id: string; values_json: string; metadata_json: string }
        | undefined;
      if (!row) continue;
      out.push({
        id: row.id,
        values: parseJson<number[]>(row.values_json, []),
        metadata: parseJson(row.metadata_json, {}),
      } as VectorizeVector);
    }
    return out;
  }

  async query(
    vector: number[],
    options: SqliteVectorizeQueryOptions = {}
  ): Promise<VectorizeMatches> {
    const topK = options.topK ?? 10;
    const candidateIds = this.ftsCandidateIds(options.queryText, Math.max(topK * 20, 50));
    const rows = candidateIds.length > 0
      ? this.selectRowsByIds(candidateIds)
      : this.db
          .prepare(`SELECT id, values_json, metadata_json FROM sb_vectors`)
          .all() as { id: string; values_json: string; metadata_json: string }[];

    const scored = rows.flatMap((row) => {
      const values = parseJson<number[]>(row.values_json, []);
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
      try {
        return [{
          id: row.id,
          score: cosineSim(vector, values),
          metadata,
          values: options.returnValues ? values : undefined,
        }];
      } catch (error) {
        console.warn("Skipping incompatible vector row during query:", error);
        return [];
      }
    });

    scored.sort((a, b) => b.score - a.score);
    const matches = scored.slice(0, topK).map((m) => {
      const match: VectorizeMatch = {
        id: m.id,
        score: m.score,
      } as VectorizeMatch;
      if (options.returnMetadata && options.returnMetadata !== "none") {
        (match as any).metadata = m.metadata;
      }
      if (m.values) (match as any).values = m.values;
      return match;
    });

    return { matches, count: matches.length } as VectorizeMatches;
  }

  private ftsCandidateIds(queryText: string | undefined, limit: number): string[] {
    if (!this.ftsAvailable) return [];
    const query = buildFtsQuery(queryText);
    if (!query) return [];
    try {
      const rows = this.db.prepare(
        `SELECT id FROM sb_vector_fts WHERE sb_vector_fts MATCH ? LIMIT ?`
      ).all(query, limit) as { id: string }[];
      return rows.map((row) => row.id);
    } catch (error) {
      console.warn("SQLite FTS prefilter failed; falling back to full vector scan:", error);
      return [];
    }
  }

  private selectRowsByIds(ids: string[]): { id: string; values_json: string; metadata_json: string }[] {
    if (!ids.length) return [];
    const get = this.db.prepare(
      `SELECT id, values_json, metadata_json FROM sb_vectors WHERE id = ?`
    );
    const rows: { id: string; values_json: string; metadata_json: string }[] = [];
    for (const id of ids) {
      const row = get.get(id) as
        | { id: string; values_json: string; metadata_json: string }
        | undefined;
      if (row) rows.push(row);
    }
    return rows;
  }

  async describe(): Promise<VectorizeIndexDetails> {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM sb_vectors`).get() as { n: number };
    const sample = this.db
      .prepare(`SELECT values_json FROM sb_vectors LIMIT 1`)
      .get() as { values_json: string } | undefined;
    let dimensions = 0;
    if (sample?.values_json) {
      try {
        dimensions = (JSON.parse(sample.values_json) as number[]).length;
      } catch {
        dimensions = 0;
      }
    }
    return {
      id: "local",
      name: "singularity-vectors",
      config: { dimensions, metric: "cosine" },
      vectorsCount: row.n,
      dimensions,
      vectorCount: row.n,
      processedUpToDatetime: new Date().toISOString(),
      processedUpToMutation: 0,
    } as unknown as VectorizeIndexDetails;
  }

  /** Drop all vectors (used when embedding fingerprint changes). */
  async clearAll(): Promise<number> {
    const info = this.db.prepare(`DELETE FROM sb_vectors`).run();
    if (this.ftsAvailable) this.db.prepare(`DELETE FROM sb_vector_fts`).run();
    return info.changes;
  }
}
