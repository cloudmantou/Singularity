import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  D1EntityEmbeddingIndex,
  VectorizeEntityEmbeddingIndex,
} from "../../src/memory/entity-embedding-index";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import { SqliteEntityEmbeddingIndex } from "../../src/selfhost/sqlite-entity-index";

function createEntityTables(raw: Database.Database) {
  raw.exec(`
    CREATE TABLE sb_entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE sb_entity_embeddings (
      entity_id TEXT NOT NULL,
      embedding_fingerprint TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(entity_id, embedding_fingerprint)
    );
  `);
}

describe("EntityEmbeddingIndex", () => {
  it("finds candidates beyond the old 1000-row resolver cap", async () => {
    const raw = new Database(":memory:");
    createEntityTables(raw);
    const insertEntity = raw.prepare("INSERT INTO sb_entities (id, name) VALUES (?, ?)");
    const insertEmbedding = raw.prepare(
      "INSERT INTO sb_entity_embeddings VALUES (?, 'fp-1', ?, 2, ?)"
    );
    const transaction = raw.transaction(() => {
      for (let index = 0; index < 1005; index += 1) {
        const id = `entity-${String(index).padStart(4, "0")}`;
        insertEntity.run(id, id);
        insertEmbedding.run(id, JSON.stringify(index === 1004 ? [1, 0] : [0, 1]), index);
      }
    });
    transaction();

    const index = new D1EntityEmbeddingIndex(
      new SqliteD1Database(raw) as unknown as D1Database
    );
    const result = await index.search({ vector: [1, 0], fingerprint: "fp-1", topK: 5 });

    expect(result[0]).toMatchObject({ entityId: "entity-1004", score: 1 });
    raw.close();
  });

  it("uses a dedicated Vectorize namespace with source and fingerprint filters", async () => {
    const query = vi.fn().mockResolvedValue({
      matches: [{ id: "entity:target", score: 0.94, metadata: { entity_id: "target" } }],
    });
    const upsert = vi.fn().mockResolvedValue({ mutationId: "mutation-1" });
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "mutation-2" });
    const index = new VectorizeEntityEmbeddingIndex({ query, upsert, deleteByIds } as unknown as VectorizeIndex);

    await index.upsert({ entityId: "target", vector: [1, 0], fingerprint: "fp-1", updatedAt: 1 });
    await index.delete("stale");
    const matches = await index.search({ vector: [1, 0], fingerprint: "fp-1", topK: 10 });

    expect(upsert).toHaveBeenCalledWith([expect.objectContaining({
      id: "entity:target",
      metadata: expect.objectContaining({ source: "singularity-entity", entity_id: "target" }),
    })]);
    expect(query).toHaveBeenCalledWith([1, 0], expect.objectContaining({
      topK: 10,
      filter: { source: "singularity-entity", embedding_fingerprint: "fp-1" },
    }));
    expect(deleteByIds).toHaveBeenCalledWith(["entity:stale"]);
    expect(matches).toEqual([{ entityId: "target", score: 0.94 }]);
  });

  it("uses sqlite-vec for self-hosted Top-K entity lookup", async () => {
    const raw = new Database(":memory:");
    createEntityTables(raw);
    raw.exec("INSERT INTO sb_entities (id, name) VALUES ('left', 'Left'), ('right', 'Right')");
    const index = new SqliteEntityEmbeddingIndex(raw);
    await index.upsert({ entityId: "left", vector: [1, 0], fingerprint: "fp-1", updatedAt: 1 });
    await index.upsert({ entityId: "right", vector: [0, 1], fingerprint: "fp-1", updatedAt: 1 });

    const result = await index.search({ vector: [0.99, 0.01], fingerprint: "fp-1", topK: 1 });

    expect(index.backend()).toBe("sqlite-vec");
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe("left");
    raw.close();
  });

  it("does not let merged entity projections exhaust sqlite-vec Top-K", async () => {
    const raw = new Database(":memory:");
    createEntityTables(raw);
    raw.exec(`
      INSERT INTO sb_entities (id, name, lifecycle_state) VALUES
        ('merged', 'Merged', 'active'),
        ('active', 'Active', 'active')
    `);
    const index = new SqliteEntityEmbeddingIndex(raw);
    await index.upsert({ entityId: "merged", vector: [1, 0], fingerprint: "fp-1", updatedAt: 1 });
    await index.upsert({ entityId: "active", vector: [0.99, 0.01], fingerprint: "fp-1", updatedAt: 1 });
    raw.prepare("UPDATE sb_entities SET lifecycle_state = 'merged' WHERE id = 'merged'").run();

    const result = await index.search({ vector: [1, 0], fingerprint: "fp-1", topK: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe("active");
    raw.close();
  });
});
