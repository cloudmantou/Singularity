/**
 * Vectorize-compatible local store.
 *
 * The durable source of truth stays in sb_vectors so existing self-host
 * databases keep working. When the sqlite-vec extension is available we mirror
 * rows into per-dimension vec0 tables for native KNN search; otherwise queries
 * fall back to the JSON cosine scan.
 */

import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

type VectorRow = {
  id: string;
  values_json: string;
  metadata_json: string;
  vec_rowid?: number | null;
  vector_dim?: number | null;
};

type ScoredVector = {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
  values?: number[];
};

/** Strict cosine - refuses dimension mismatch (no silent truncation). */
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
  /** Deprecated self-host extension. Lexical recall is exposed through queryLexical(). */
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

function lexicalTokens(raw: string | undefined, minLength = 2): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .toLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)
        ?.filter((token) => token.length >= minLength)
        .slice(0, 12) ?? []
    ),
  ];
}

function buildFtsMatchQuery(raw: string | undefined): string | null {
  const tokens = lexicalTokens(raw);
  if (!tokens.length) return null;
  return tokens
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" OR ");
}

function vectorDimension(values: number[]): number | null {
  if (!Array.isArray(values) || values.length <= 0) return null;
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }
  return values.length;
}

function vecTableName(dim: number): string {
  if (!Number.isInteger(dim) || dim <= 0 || dim > 16_384) {
    throw new Error(`Invalid sqlite-vec dimension: ${dim}`);
  }
  return `sb_vectors_vec_${dim}`;
}

function similarityFromCosineDistance(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(-1, Math.min(1, 1 - distance));
}

export class SqliteVectorizeIndex {
  private ftsAvailable = false;
  private ftsTokenizer: "trigram" | "unicode61" | null = null;
  private vecAvailable = false;
  private readonly vecTables = new Set<number>();

  constructor(private db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sb_vectors (
        id TEXT PRIMARY KEY,
        values_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
    this.ensureMainColumns();
    this.initializeSqliteVec();
    this.initializeFts();
  }

  async insert(
    vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]
  ): Promise<{ mutationId: string }> {
    const upsert = this.db.prepare(`
      INSERT INTO sb_vectors (id, values_json, metadata_json, vec_rowid, vector_dim)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        values_json = excluded.values_json,
        metadata_json = excluded.metadata_json,
        vec_rowid = excluded.vec_rowid,
        vector_dim = excluded.vector_dim
    `);
    const existingStmt = this.db.prepare(
      `SELECT vec_rowid, vector_dim FROM sb_vectors WHERE id = ?`
    );
    const deleteFts = this.ftsAvailable
      ? this.db.prepare(`DELETE FROM sb_vector_fts WHERE id = ?`)
      : null;
    const insertFts = this.ftsAvailable
      ? this.db.prepare(`INSERT INTO sb_vector_fts (id, content) VALUES (?, ?)`)
      : null;

    const tx = this.db.transaction((rows: typeof vectors) => {
      for (const v of rows) {
        const existing = existingStmt.get(v.id) as
          | { vec_rowid: number | null; vector_dim: number | null }
          | undefined;
        this.deleteVecRow(existing?.vector_dim ?? null, existing?.vec_rowid ?? null);

        const metadata = v.metadata ?? {};
        const dim = vectorDimension(v.values);
        const vecRowid = dim == null ? null : this.insertVecRow(dim, v.values);
        upsert.run(
          v.id,
          JSON.stringify(v.values),
          JSON.stringify(metadata),
          vecRowid,
          dim
        );
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
    const get = this.db.prepare(
      `SELECT vec_rowid, vector_dim FROM sb_vectors WHERE id = ?`
    );
    const del = this.db.prepare(`DELETE FROM sb_vectors WHERE id = ?`);
    const deleteFts = this.ftsAvailable
      ? this.db.prepare(`DELETE FROM sb_vector_fts WHERE id = ?`)
      : null;
    const tx = this.db.transaction((rowIds: string[]) => {
      for (const id of rowIds) {
        const row = get.get(id) as
          | { vec_rowid: number | null; vector_dim: number | null }
          | undefined;
        this.deleteVecRow(row?.vector_dim ?? null, row?.vec_rowid ?? null);
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
      const row = get.get(id) as VectorRow | undefined;
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
    const scored =
      options.filter
        ? this.scoreRows(this.selectRowsForFilter(options.filter), vector, options.returnValues)
        : (
            this.queryVec0(vector, Math.max(topK, 50), Boolean(options.returnValues)) ??
            this.scoreRows(this.selectAllRows(), vector, options.returnValues)
          )
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.max(topK, 50));

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

  queryLexical(queryText: string, topK = 10): string[] {
    return this.ftsCandidateIds(queryText, Math.max(1, Math.min(topK, 500)));
  }

  backfillIndexBatch(limit = 200): {
    ftsProcessed: number;
    vecProcessed: number;
    remaining: number;
  } {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 200, 1000));
    let ftsProcessed = 0;
    let vecProcessed = 0;

    if (this.ftsAvailable) {
      const rows = this.db
        .prepare(
          `SELECT v.id, v.metadata_json
           FROM sb_vectors v
           LEFT JOIN sb_vector_fts f ON f.id = v.id
           WHERE f.id IS NULL
           ORDER BY v.id
           LIMIT ?`
        )
        .all(safeLimit) as Array<{ id: string; metadata_json: string }>;
      if (rows.length) {
        const insertFts = this.db.prepare(
          `INSERT INTO sb_vector_fts (id, content) VALUES (?, ?)`
        );
        const tx = this.db.transaction((items: typeof rows) => {
          for (const row of items) {
            insertFts.run(row.id, ftsContent(parseJson(row.metadata_json, {})));
          }
        });
        tx(rows);
        ftsProcessed = rows.length;
      }
    }

    if (this.vecAvailable) {
      const rows = this.db
        .prepare(
          `SELECT id, values_json
           FROM sb_vectors
           WHERE vec_rowid IS NULL OR vector_dim IS NULL
           ORDER BY id
           LIMIT ?`
        )
        .all(safeLimit) as Array<{ id: string; values_json: string }>;
      if (rows.length) {
        const update = this.db.prepare(
          `UPDATE sb_vectors SET vec_rowid = ?, vector_dim = ? WHERE id = ?`
        );
        const tx = this.db.transaction((items: typeof rows) => {
          for (const row of items) {
            const values = parseJson<number[]>(row.values_json, []);
            const dim = vectorDimension(values);
            if (dim == null) continue;
            const vecRowid = this.insertVecRow(dim, values);
            update.run(vecRowid, dim, row.id);
            vecProcessed++;
          }
        });
        tx(rows);
      }
    }

    return {
      ftsProcessed,
      vecProcessed,
      remaining: this.indexStatus().remaining,
    };
  }

  indexStatus(): {
    vectorCount: number;
    ftsAvailable: boolean;
    ftsTokenizer: "trigram" | "unicode61" | null;
    ftsIndexed: number;
    vecAvailable: boolean;
    vecIndexed: number;
    remaining: number;
  } {
    const vectorCount = Number((this.db
      .prepare(`SELECT COUNT(*) as count FROM sb_vectors`)
      .get() as { count: number }).count ?? 0);
    const ftsIndexed = this.ftsAvailable
      ? Number((this.db
          .prepare(`SELECT COUNT(DISTINCT id) as count FROM sb_vector_fts`)
          .get() as { count: number }).count ?? 0)
      : vectorCount;
    const vecIndexed = this.vecAvailable
      ? Number((this.db
          .prepare(
            `SELECT COUNT(*) as count
             FROM sb_vectors
             WHERE vec_rowid IS NOT NULL
               AND vector_dim IS NOT NULL`
          )
          .get() as { count: number }).count ?? 0)
      : vectorCount;
    const ftsRemaining = this.ftsAvailable
      ? Math.max(0, vectorCount - ftsIndexed)
      : 0;
    const vecRemaining = this.vecAvailable
      ? Math.max(0, vectorCount - vecIndexed)
      : 0;
    return {
      vectorCount,
      ftsAvailable: this.ftsAvailable,
      ftsTokenizer: this.ftsTokenizer,
      ftsIndexed,
      vecAvailable: this.vecAvailable,
      vecIndexed,
      remaining: ftsRemaining + vecRemaining,
    };
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
      config: {
        dimensions,
        metric: "cosine",
        backend: this.vecAvailable ? "sqlite-vec" : "json-cosine",
        fts: this.ftsTokenizer,
      },
      vectorsCount: row.n,
      dimensions,
      vectorCount: row.n,
      processedUpToDatetime: new Date().toISOString(),
      processedUpToMutation: 0,
    } as unknown as VectorizeIndexDetails;
  }

  /** Drop all vectors (used when embedding fingerprint changes). */
  async clearAll(): Promise<number> {
    const dims = this.db
      .prepare(`SELECT DISTINCT vector_dim FROM sb_vectors WHERE vector_dim IS NOT NULL`)
      .all() as Array<{ vector_dim: number }>;
    const info = this.db.prepare(`DELETE FROM sb_vectors`).run();
    if (this.ftsAvailable) this.db.prepare(`DELETE FROM sb_vector_fts`).run();
    for (const row of dims) {
      this.deleteAllVecRows(row.vector_dim);
    }
    return info.changes;
  }

  private ensureMainColumns(): void {
    for (const alter of [
      `ALTER TABLE sb_vectors ADD COLUMN vec_rowid INTEGER`,
      `ALTER TABLE sb_vectors ADD COLUMN vector_dim INTEGER`,
    ]) {
      try {
        this.db.exec(alter);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column name|already exists/i.test(message)) throw error;
      }
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_vectors_vec_rowid_dim
      ON sb_vectors(vector_dim, vec_rowid)
      WHERE vec_rowid IS NOT NULL
    `);
  }

  private initializeSqliteVec(): void {
    try {
      sqliteVec.load(this.db);
      const row = this.db.prepare(`SELECT vec_version() as version`).get() as
        | { version: string }
        | undefined;
      this.vecAvailable = Boolean(row?.version);
    } catch (error) {
      this.vecAvailable = false;
      console.warn("sqlite-vec unavailable; vector queries will use JSON cosine scan:", error);
    }
  }

  private initializeFts(): void {
    try {
      const existing = this.db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sb_vector_fts'`)
        .get() as { sql: string } | undefined;
      if (existing?.sql && !/tokenize\s*=\s*'?trigram'?/i.test(existing.sql)) {
        this.db.exec(`DROP TABLE IF EXISTS sb_vector_fts`);
      }
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS sb_vector_fts
        USING fts5(id UNINDEXED, content, tokenize='trigram');
      `);
      this.ftsAvailable = true;
      this.ftsTokenizer = "trigram";
    } catch (trigramError) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS sb_vector_fts
          USING fts5(id UNINDEXED, content, tokenize='unicode61');
        `);
        this.ftsAvailable = true;
        this.ftsTokenizer = "unicode61";
      } catch (unicodeError) {
        this.ftsAvailable = false;
        this.ftsTokenizer = null;
        console.warn(
          "SQLite FTS5 unavailable; vector queries will scan all rows:",
          unicodeError || trigramError
        );
      }
    }
  }

  private ensureVecTable(dim: number): void {
    if (!this.vecAvailable || this.vecTables.has(dim)) return;
    const table = vecTableName(dim);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${table}
      USING vec0(embedding float[${dim}] distance_metric=cosine)
    `);
    this.vecTables.add(dim);
  }

  private insertVecRow(dim: number, values: number[]): number | null {
    if (!this.vecAvailable) return null;
    try {
      this.ensureVecTable(dim);
      const result = this.db
        .prepare(`INSERT INTO ${vecTableName(dim)} (embedding) VALUES (vec_f32(?))`)
        .run(JSON.stringify(values));
      return Number(result.lastInsertRowid);
    } catch (error) {
      console.warn("sqlite-vec insert failed; row remains JSON-searchable:", error);
      return null;
    }
  }

  private deleteVecRow(dim: number | null, rowid: number | null): void {
    if (!this.vecAvailable || dim == null || rowid == null) return;
    try {
      this.ensureVecTable(dim);
      this.db.prepare(`DELETE FROM ${vecTableName(dim)} WHERE rowid = ?`).run(rowid);
    } catch (error) {
      console.warn("sqlite-vec delete failed; stale vec0 row may remain:", error);
    }
  }

  private deleteAllVecRows(dim: number | null): void {
    if (!this.vecAvailable || dim == null) return;
    try {
      this.ensureVecTable(dim);
      this.db.prepare(`DELETE FROM ${vecTableName(dim)}`).run();
    } catch (error) {
      console.warn("sqlite-vec clear failed:", error);
    }
  }

  private queryVec0(
    vector: number[],
    topK: number,
    returnValues: boolean
  ): ScoredVector[] | null {
    const dim = vectorDimension(vector);
    if (!this.vecAvailable || dim == null) return null;
    try {
      const coverage = this.db.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN vec_rowid IS NOT NULL THEN 1 ELSE 0 END) as indexed
         FROM sb_vectors
         WHERE vector_dim = ?`
      ).get(dim) as { total: number; indexed: number | null };
      if (coverage.total !== Number(coverage.indexed ?? 0)) {
        return null;
      }
      this.ensureVecTable(dim);
      const missing = this.db.prepare(
        `SELECT COUNT(*) as count
         FROM sb_vectors m
         LEFT JOIN ${vecTableName(dim)} v ON v.rowid = m.vec_rowid
         WHERE m.vector_dim = ?
           AND (m.vec_rowid IS NULL OR v.rowid IS NULL)`
      ).get(dim) as { count: number };
      if (Number(missing.count ?? 0) > 0) {
        return null;
      }
      const rows = this.db
        .prepare(
          `SELECT m.id, m.values_json, m.metadata_json, v.distance
           FROM ${vecTableName(dim)} v
           JOIN sb_vectors m ON m.vector_dim = ? AND m.vec_rowid = v.rowid
           WHERE v.embedding MATCH vec_f32(?) AND k = ?
           ORDER BY v.distance`
        )
        .all(dim, JSON.stringify(vector), topK) as Array<VectorRow & { distance: number }>;
      return rows.map((row) => {
        const values = parseJson<number[]>(row.values_json, []);
        return {
          id: row.id,
          score: similarityFromCosineDistance(row.distance),
          metadata: parseJson(row.metadata_json, {}),
          values: returnValues ? values : undefined,
        };
      });
    } catch (error) {
      console.warn("sqlite-vec KNN failed; falling back to JSON cosine scan:", error);
      return null;
    }
  }

  private scoreRows(
    rows: VectorRow[],
    vector: number[],
    returnValues?: boolean
  ): ScoredVector[] {
    return rows.flatMap((row) => {
      const values = parseJson<number[]>(row.values_json, []);
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
      try {
        return [{
          id: row.id,
          score: cosineSim(vector, values),
          metadata,
          values: returnValues ? values : undefined,
        }];
      } catch (error) {
        console.warn("Skipping incompatible vector row during query:", error);
        return [];
      }
    });
  }

  private ftsCandidateIds(queryText: string | undefined, limit: number): string[] {
    if (!this.ftsAvailable) return [];
    if (this.ftsTokenizer === "trigram") {
      const tokens = lexicalTokens(queryText, 3);
      if (!tokens.length) return [];
      const where = tokens.map(() => `content LIKE ?`).join(" OR ");
      try {
        const rows = this.db.prepare(
          `SELECT id FROM sb_vector_fts WHERE ${where} LIMIT ?`
        ).all(...tokens.map((token) => `%${token}%`), limit) as { id: string }[];
        return rows.map((row) => row.id);
      } catch (error) {
        console.warn("SQLite trigram FTS prefilter failed; falling back to vector KNN:", error);
        return [];
      }
    }

    const query = buildFtsMatchQuery(queryText);
    if (!query) return [];
    try {
      const rows = this.db.prepare(
        `SELECT id FROM sb_vector_fts WHERE sb_vector_fts MATCH ? LIMIT ?`
      ).all(query, limit) as { id: string }[];
      return rows.map((row) => row.id);
    } catch (error) {
      console.warn("SQLite FTS prefilter failed; falling back to vector KNN:", error);
      return [];
    }
  }

  private selectRowsByIds(ids: string[]): VectorRow[] {
    if (!ids.length) return [];
    const get = this.db.prepare(
      `SELECT id, values_json, metadata_json, vec_rowid, vector_dim
       FROM sb_vectors WHERE id = ?`
    );
    const rows: VectorRow[] = [];
    for (const id of ids) {
      const row = get.get(id) as VectorRow | undefined;
      if (row) rows.push(row);
    }
    return rows;
  }

  private selectRowsForFilter(filter: Record<string, unknown> | undefined): VectorRow[] {
    if (!filter || Object.keys(filter).length === 0) return this.selectAllRows();
    const supported = new Set(["parentId", "source", "embedding_fingerprint", "tag"]);
    for (const key of Object.keys(filter)) {
      if (!supported.has(key)) throw new Error(`Unsupported local vector filter: ${key}`);
    }
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (typeof filter.parentId === "string") {
      clauses.push(`json_extract(metadata_json, '$.parentId') = ?`);
      params.push(filter.parentId);
    }
    if (typeof filter.source === "string") {
      clauses.push(`json_extract(metadata_json, '$.source') = ?`);
      params.push(filter.source);
    }
    if (typeof filter.embedding_fingerprint === "string") {
      clauses.push(`json_extract(metadata_json, '$.embedding_fingerprint') = ?`);
      params.push(filter.embedding_fingerprint);
    }
    if (typeof filter.tag === "string") {
      clauses.push(
        `EXISTS (
          SELECT 1
          FROM json_each(json_extract(metadata_json, '$.tags'))
          WHERE value = ?
        )`
      );
      params.push(filter.tag);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT id, values_json, metadata_json, vec_rowid, vector_dim
         FROM sb_vectors ${where}`
      )
      .all(...params) as VectorRow[];
  }

  private selectAllRows(): VectorRow[] {
    return this.db
      .prepare(`SELECT id, values_json, metadata_json, vec_rowid, vector_dim FROM sb_vectors`)
      .all() as VectorRow[];
  }
}
