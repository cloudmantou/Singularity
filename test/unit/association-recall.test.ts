import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  associationRecallExpansion,
  createAssociationEdge,
  ensureAssociationDataModel,
} from "../../src/memory/associations";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("Association-aware recall expansion", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    raw.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'api',
        created_at INTEGER NOT NULL,
        vector_ids TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT
      );
    `);
    await ensureMemoryDataModel(db);
    await ensureAssociationDataModel(db);
    for (const [entryId, parentId, content, createdAt] of [
      ["direct", "parent-direct", "Direct evidence", 100],
      ["hop-1", "parent-hop-1", "One hop context", 110],
      ["hop-2", "parent-hop-2", "Two hop context", 120],
    ] as const) {
      seed(entryId, parentId, content, createdAt);
    }
    await createAssociationEdge(db, {
      source: "direct",
      target: "hop-1",
      edgeType: "related_to",
      weight: 1,
      provenance: "manual",
      createdAt: 200,
    });
    await createAssociationEdge(db, {
      source: "hop-1",
      target: "hop-2",
      edgeType: "continuation_of",
      weight: 1,
      provenance: "manual",
      createdAt: 210,
    });
  });

  afterEach(() => raw.close());

  function seed(entryId: string, parentId: string, content: string, createdAt: number) {
    const versionId = `${parentId}:v1`;
    const observationId = `${parentId}:obs`;
    const memoryId = `${parentId}:claim`;
    const hash = `${parentId}:hash`;
    raw.prepare(
      `INSERT INTO entries VALUES (?, ?, '[]', 'test', ?, '[]', ?)`
    ).run(entryId, content, createdAt, hash);
    raw.prepare(
      `INSERT INTO sb_observations (id, content, source, content_hash, extraction_status, created_at)
       VALUES (?, ?, 'test', ?, 'succeeded', ?)`
    ).run(observationId, content, hash, createdAt);
    raw.prepare(
      `INSERT INTO sb_parent_units VALUES (?, ?, NULL, ?, ?)`
    ).run(parentId, versionId, createdAt, createdAt);
    raw.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, state, summary_vector_ids,
         activated_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'active', '[]', ?, ?, ?)`
    ).run(versionId, parentId, createdAt, createdAt, createdAt);
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, parent_version_id, claim_status, content_hash, created_at
       ) VALUES (?, ?, ?, ?, 'confirmed', ?, ?)`
    ).run(memoryId, content, entryId, versionId, hash, createdAt);
    raw.prepare(
      `INSERT INTO sb_parent_version_claims VALUES (?, ?, 'supports', ?)`
    ).run(versionId, memoryId, createdAt);
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, created_at
       ) VALUES (?, ?, ?, 'supports', 'supports', ?)`
    ).run(`${memoryId}:source`, memoryId, observationId, createdAt);
  }

  it("adds bounded context below the weakest direct result", async () => {
    const expanded = await associationRecallExpansion(db, [
      { entryId: "direct", score: 0.8 },
    ], { hops: 2, asOf: 300, limit: 10 });

    expect(expanded.map((row) => [row.entryId, row.hop, row.score])).toEqual([
      ["hop-1", 1, 0.44],
      ["hop-2", 2, 0.24],
    ]);
    expect(expanded.every((row) => row.score < 0.8)).toBe(true);
  });

  it("returns no graph context when hops is zero", async () => {
    expect(await associationRecallExpansion(db, [
      { entryId: "direct", score: 0.8 },
    ], { hops: 0, asOf: 300 })).toEqual([]);
  });
});
