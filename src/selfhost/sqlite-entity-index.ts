import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type {
  EntityEmbeddingIndex,
  EntityEmbeddingMatch,
} from "../memory/entity-embedding-index";

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function validVector(vector: number[]): boolean {
  return Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite);
}

function cosine(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length === 0) return null;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    a += left[index] ** 2;
    b += right[index] ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : null;
}

export class SqliteEntityEmbeddingIndex implements EntityEmbeddingIndex {
  private vecAvailable = false;

  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sb_entity_vector_rows (
        entity_id TEXT NOT NULL,
        embedding_fingerprint TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vec_rowid INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(entity_id, embedding_fingerprint)
      )
    `);
    try {
      sqliteVec.load(this.db);
      this.vecAvailable = true;
    } catch {
      this.vecAvailable = false;
    }
  }

  backend(): "sqlite-vec" | "json-cosine" {
    return this.vecAvailable ? "sqlite-vec" : "json-cosine";
  }

  async upsert(input: {
    entityId: string;
    vector: number[];
    fingerprint: string;
    updatedAt: number;
  }): Promise<void> {
    if (!validVector(input.vector) || !input.entityId.trim() || !input.fingerprint.trim()) return;
    this.db.prepare(
      `INSERT INTO sb_entity_embeddings (
         entity_id, embedding_fingerprint, embedding_json, dimensions, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, embedding_fingerprint) DO UPDATE SET
         embedding_json = excluded.embedding_json,
         dimensions = excluded.dimensions,
         updated_at = excluded.updated_at`
    ).run(input.entityId, input.fingerprint, JSON.stringify(input.vector), input.vector.length, input.updatedAt);
    if (this.vecAvailable) this.mirror(input);
  }

  async delete(entityId: string): Promise<void> {
    const id = entityId.trim();
    if (!id) return;
    const rows = this.db.prepare(
      `SELECT embedding_fingerprint, dimensions, vec_rowid
       FROM sb_entity_vector_rows WHERE entity_id = ?`
    ).all(id) as Array<{
      embedding_fingerprint: string;
      dimensions: number;
      vec_rowid: number | null;
    }>;
    this.db.transaction(() => {
      for (const row of rows) {
        if (this.vecAvailable && row.vec_rowid != null) {
          const table = this.ensureTable(row.dimensions, row.embedding_fingerprint);
          this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(row.vec_rowid));
        }
      }
      this.db.prepare("DELETE FROM sb_entity_vector_rows WHERE entity_id = ?").run(id);
    })();
  }

  async search(input: {
    vector: number[];
    fingerprint: string;
    topK: number;
  }): Promise<EntityEmbeddingMatch[]> {
    if (!validVector(input.vector) || !input.fingerprint.trim()) return [];
    const topK = Math.max(1, Math.min(50, Math.trunc(input.topK || 10)));
    if (!this.vecAvailable) return this.jsonSearch(input.vector, input.fingerprint, topK);
    try {
      this.purgeInactive(input.fingerprint, input.vector.length);
      this.mirrorMissing(input.fingerprint, input.vector.length);
      const table = this.tableName(input.vector.length, input.fingerprint);
      const rows = this.db.prepare(
        `SELECT m.entity_id, v.distance
         FROM ${table} v
         JOIN sb_entity_vector_rows m ON m.vec_rowid = v.rowid
         JOIN sb_entities e ON e.id = m.entity_id
         WHERE v.embedding MATCH vec_f32(?) AND k = ?
           AND m.embedding_fingerprint = ?
           AND e.lifecycle_state = 'active'
         ORDER BY v.distance`
      ).all(JSON.stringify(input.vector), topK, input.fingerprint) as Array<{
        entity_id: string;
        distance: number;
      }>;
      return rows.map((row) => ({
        entityId: row.entity_id,
        score: Math.max(-1, Math.min(1, 1 - Number(row.distance))),
      }));
    } catch {
      this.vecAvailable = false;
      return this.jsonSearch(input.vector, input.fingerprint, topK);
    }
  }

  private tableName(dimensions: number, fingerprint: string): string {
    if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 16_384) {
      throw new Error("invalid_entity_vector_dimensions");
    }
    return `sb_entity_vec_${dimensions}_${fnv1a64(fingerprint)}`;
  }

  private ensureTable(dimensions: number, fingerprint: string): string {
    const table = this.tableName(dimensions, fingerprint);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${table}
       USING vec0(embedding float[${dimensions}] distance_metric=cosine)`
    );
    return table;
  }

  private mirror(input: {
    entityId: string;
    vector: number[];
    fingerprint: string;
    updatedAt: number;
  }): void {
    const table = this.ensureTable(input.vector.length, input.fingerprint);
    this.db.prepare(
      `INSERT INTO sb_entity_vector_rows (
         entity_id, embedding_fingerprint, dimensions, vec_rowid, updated_at
       ) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(entity_id, embedding_fingerprint) DO UPDATE SET
         dimensions = excluded.dimensions,
         updated_at = excluded.updated_at`
    ).run(input.entityId, input.fingerprint, input.vector.length, input.updatedAt);
    const row = this.db.prepare(
      `SELECT vec_rowid FROM sb_entity_vector_rows
       WHERE entity_id = ? AND embedding_fingerprint = ?`
    ).get(input.entityId, input.fingerprint) as { vec_rowid: number | null };
    if (row.vec_rowid != null) {
      this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(row.vec_rowid));
    }
    const inserted = this.db.prepare(`INSERT INTO ${table} (embedding) VALUES (vec_f32(?))`)
      .run(JSON.stringify(input.vector));
    this.db.prepare(
      `UPDATE sb_entity_vector_rows SET vec_rowid = ?
       WHERE entity_id = ? AND embedding_fingerprint = ?`
    ).run(Number(inserted.lastInsertRowid), input.entityId, input.fingerprint);
  }

  private mirrorMissing(fingerprint: string, dimensions: number): void {
    const rows = this.db.prepare(
      `SELECT x.entity_id, x.embedding_json, x.updated_at
       FROM sb_entity_embeddings x
       JOIN sb_entities e ON e.id = x.entity_id
       LEFT JOIN sb_entity_vector_rows m
         ON m.entity_id = x.entity_id
         AND m.embedding_fingerprint = x.embedding_fingerprint
       WHERE x.embedding_fingerprint = ?
         AND x.dimensions = ?
         AND e.lifecycle_state = 'active'
         AND (
           m.entity_id IS NULL OR m.vec_rowid IS NULL OR
           m.updated_at <> x.updated_at OR m.dimensions <> x.dimensions
         )`
    ).all(fingerprint, dimensions) as Array<{
      entity_id: string;
      embedding_json: string;
      updated_at: number;
    }>;
    for (const row of rows) {
      let vector: number[] = [];
      try { vector = JSON.parse(row.embedding_json); } catch { vector = []; }
      if (validVector(vector)) {
        this.mirror({ entityId: row.entity_id, vector, fingerprint, updatedAt: row.updated_at });
      }
    }
  }

  private purgeInactive(fingerprint: string, dimensions: number): void {
    const rows = this.db.prepare(
      `SELECT m.entity_id, m.vec_rowid
       FROM sb_entity_vector_rows m
       LEFT JOIN sb_entities e ON e.id = m.entity_id
       WHERE m.embedding_fingerprint = ?
         AND m.dimensions = ?
         AND (e.id IS NULL OR e.lifecycle_state <> 'active')`
    ).all(fingerprint, dimensions) as Array<{
      entity_id: string;
      vec_rowid: number | null;
    }>;
    if (!rows.length) return;
    const table = this.ensureTable(dimensions, fingerprint);
    this.db.transaction(() => {
      const deleteVector = this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
      const deleteMapping = this.db.prepare(
        `DELETE FROM sb_entity_vector_rows
         WHERE entity_id = ? AND embedding_fingerprint = ?`
      );
      for (const row of rows) {
        if (row.vec_rowid != null) deleteVector.run(BigInt(row.vec_rowid));
        deleteMapping.run(row.entity_id, fingerprint);
      }
    })();
  }

  private jsonSearch(vector: number[], fingerprint: string, topK: number): EntityEmbeddingMatch[] {
    const rows = this.db.prepare(
      `SELECT x.entity_id, x.embedding_json
       FROM sb_entity_embeddings x
       JOIN sb_entities e ON e.id = x.entity_id
       WHERE x.embedding_fingerprint = ? AND e.lifecycle_state = 'active'`
    ).all(fingerprint) as Array<{ entity_id: string; embedding_json: string }>;
    return rows.flatMap((row) => {
      let stored: number[] = [];
      try { stored = JSON.parse(row.embedding_json); } catch { stored = []; }
      const score = validVector(stored) ? cosine(vector, stored) : null;
      return score == null ? [] : [{ entityId: row.entity_id, score }];
    }).sort((left, right) => right.score - left.score).slice(0, topK);
  }
}
