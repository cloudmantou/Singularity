import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AssociationEndpointUnavailableError,
  createAssociationEdge,
  deleteAssociationEdge,
  ensureAssociationDataModel,
  expandAssociationGraph,
  listAssociationConnections,
} from "../../src/memory/associations";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("Association Graph", () => {
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
    seedActiveParent("entry-a", "parent-a", "A", 100);
    seedActiveParent("entry-b", "parent-b", "B", 110);
    seedActiveParent("entry-c", "parent-c", "C", 120);
  });

  afterEach(() => raw.close());

  function seedActiveParent(entryId: string, parentId: string, content: string, createdAt: number) {
    const versionId = `${parentId}:v1`;
    const observationId = `${parentId}:obs`;
    const memoryId = `${parentId}:claim`;
    const hash = `${parentId}:hash`;
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
       VALUES (?, ?, '[]', 'test', ?, '[]', ?)`
    ).run(entryId, content, createdAt, hash);
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, content_hash, extraction_status, created_at
       ) VALUES (?, ?, 'test', ?, 'succeeded', ?)`
    ).run(observationId, content, hash, createdAt);
    raw.prepare(
      `INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    ).run(parentId, versionId, createdAt, createdAt);
    raw.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, state, summary_vector_ids,
         activated_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'active', '[]', ?, ?, ?)`
    ).run(versionId, parentId, createdAt, createdAt, createdAt);
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, parent_version_id, claim_status,
         content_hash, created_at
       ) VALUES (?, ?, ?, ?, 'confirmed', ?, ?)`
    ).run(memoryId, content, entryId, versionId, hash, createdAt);
    raw.prepare(
      `INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
       VALUES (?, ?, 'supports', ?)`
    ).run(versionId, memoryId, createdAt);
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, created_at
       ) VALUES (?, ?, ?, 'supports', 'supports', ?)`
    ).run(`${memoryId}:source`, memoryId, observationId, createdAt);
  }

  it("keeps associations separate from facts and traverses only bounded active parents", async () => {
    await createAssociationEdge(db, {
      source: "entry-a",
      target: "entry-b",
      edgeType: "related_to",
      weight: 0.8,
      provenance: "manual",
      createdAt: 200,
    });
    await createAssociationEdge(db, {
      source: "parent-b",
      target: "parent-c",
      edgeType: "references",
      weight: 0.7,
      provenance: "manual",
      createdAt: 210,
    });

    const expanded = await expandAssociationGraph(db, ["parent-a"], {
      hops: 2,
      fanoutCap: 4,
      maxNodes: 10,
      asOf: 300,
    });
    expect(expanded.map((row) => [row.parentId, row.hop, row.viaType])).toEqual([
      ["parent-b", 1, "related_to"],
      ["parent-c", 2, "references"],
    ]);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_entity_relations`).get()).toEqual({ count: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_fact_sources`).get()).toEqual({ count: 0 });
  });

  it("normalizes symmetric links, keeps the strongest weight, and deletes idempotently", async () => {
    await createAssociationEdge(db, {
      source: "entry-a",
      target: "entry-b",
      edgeType: "related_to",
      weight: 0.4,
      provenance: "inferred",
      createdAt: 200,
    });
    await createAssociationEdge(db, {
      source: "entry-b",
      target: "entry-a",
      edgeType: "related_to",
      weight: 0.9,
      provenance: "manual",
      createdAt: 210,
    });

    const rows = raw.prepare(
      `SELECT source_parent_id, target_parent_id, weight, provenance
       FROM sb_association_edges`
    ).all();
    expect(rows).toEqual([{
      source_parent_id: "parent-a",
      target_parent_id: "parent-b",
      weight: 0.9,
      provenance: "manual",
    }]);

    const connections = await listAssociationConnections(db, "entry-a", { asOf: 300 });
    expect(connections).toMatchObject([{
      parentId: "parent-b",
      entryId: "entry-b",
      edgeType: "related_to",
      direction: "outgoing",
    }]);
    expect(await deleteAssociationEdge(db, {
      source: "entry-b",
      target: "entry-a",
      edgeType: "related_to",
      asOf: 300,
    })).toBe(1);
    expect(await deleteAssociationEdge(db, {
      source: "entry-b",
      target: "entry-a",
      edgeType: "related_to",
      asOf: 300,
    })).toBe(0);
  });

  it("preserves closed validity intervals when an association is linked again", async () => {
    await createAssociationEdge(db, {
      source: "entry-a",
      target: "entry-b",
      edgeType: "references",
      provenance: "manual",
      createdAt: 200,
    });
    expect(await deleteAssociationEdge(db, {
      source: "entry-a",
      target: "entry-b",
      edgeType: "references",
      asOf: 500,
    })).toBe(1);
    await createAssociationEdge(db, {
      source: "entry-a",
      target: "entry-b",
      edgeType: "references",
      provenance: "manual",
      createdAt: 700,
    });

    expect(await listAssociationConnections(db, "entry-b", {
      direction: "incoming",
      asOf: 499,
    })).toMatchObject([{ entryId: "entry-a" }]);
    expect(await listAssociationConnections(db, "entry-b", {
      direction: "incoming",
      asOf: 600,
    })).toEqual([]);
    expect(await listAssociationConnections(db, "entry-b", {
      direction: "incoming",
      asOf: 700,
    })).toMatchObject([{ entryId: "entry-a" }]);
  });

  it("rejects missing, inactive, and self endpoints", async () => {
    raw.prepare(`UPDATE sb_parent_units SET active_version_id = NULL WHERE parent_id = 'parent-c'`).run();

    await expect(createAssociationEdge(db, {
      source: "entry-a",
      target: "entry-c",
      edgeType: "related_to",
      provenance: "manual",
    })).rejects.toBeInstanceOf(AssociationEndpointUnavailableError);
    await expect(createAssociationEdge(db, {
      source: "entry-a",
      target: "missing",
      edgeType: "related_to",
      provenance: "manual",
    })).rejects.toBeInstanceOf(AssociationEndpointUnavailableError);
    await expect(createAssociationEdge(db, {
      source: "entry-a",
      target: "parent-a",
      edgeType: "related_to",
      provenance: "manual",
    })).rejects.toThrow("cannot link to itself");
  });

  it("resolves the parent version that was active at the requested time", async () => {
    await createAssociationEdge(db, {
      source: "entry-a",
      target: "entry-b",
      edgeType: "related_to",
      provenance: "manual",
      createdAt: 150,
    });
    raw.prepare(
      `UPDATE sb_parent_versions
       SET state = 'superseded', activated_at = 100, superseded_at = 200
       WHERE version_id = 'parent-a:v1'`
    ).run();
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
       VALUES ('entry-a-v2', 'A v2', '[]', 'test', 200, '[]', 'parent-a:hash:v2')`
    ).run();
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, content_hash, extraction_status, created_at
       ) VALUES ('parent-a:obs:v2', 'A v2', 'test', 'parent-a:hash:v2', 'succeeded', 200)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, state, summary_vector_ids,
         activated_at, created_at, updated_at
       ) VALUES ('parent-a:v2', 'parent-a', 2, 'active', '[]', 200, 200, 200)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, parent_version_id, claim_status, content_hash, created_at
       ) VALUES ('parent-a:claim:v2', 'A v2', 'entry-a-v2', 'parent-a:v2',
                 'confirmed', 'parent-a:hash:v2', 200)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
       VALUES ('parent-a:v2', 'parent-a:claim:v2', 'supports', 200)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, created_at
       ) VALUES ('parent-a:claim:v2:source', 'parent-a:claim:v2', 'parent-a:obs:v2',
                 'supports', 'supports', 200)`
    ).run();
    raw.prepare(
      `UPDATE sb_parent_units SET active_version_id = 'parent-a:v2', updated_at = 200
       WHERE parent_id = 'parent-a'`
    ).run();

    const historical = await listAssociationConnections(db, "entry-a", { asOf: 150 });
    expect(historical).toMatchObject([{ parentId: "parent-b", entryId: "entry-b" }]);
    await expect(listAssociationConnections(db, "entry-a", { asOf: 250 }))
      .rejects.toBeInstanceOf(AssociationEndpointUnavailableError);
    await expect(listAssociationConnections(db, "parent-a", { asOf: 250 }))
      .resolves.toMatchObject([{ parentId: "parent-b", entryId: "entry-b" }]);
  });

  it("respects directed traversal and edge validity windows", async () => {
    await createAssociationEdge(db, {
      source: "entry-a",
      target: "entry-b",
      edgeType: "references",
      provenance: "manual",
      createdAt: 200,
    });

    expect(await expandAssociationGraph(db, ["parent-b"], {
      hops: 1,
      direction: "outgoing",
      asOf: 250,
    })).toEqual([]);
    await expect(expandAssociationGraph(db, ["parent-b"], {
      hops: 1,
      direction: "incoming",
      asOf: 250,
    })).resolves.toMatchObject([{ parentId: "parent-a", viaType: "references" }]);
    expect(await expandAssociationGraph(db, ["parent-a"], {
      hops: 1,
      direction: "outgoing",
      asOf: 199,
    })).toEqual([]);

    expect(await deleteAssociationEdge(db, {
      source: "entry-a",
      target: "entry-b",
      edgeType: "references",
      asOf: 300,
    })).toBe(1);
    await expect(expandAssociationGraph(db, ["parent-a"], {
      hops: 1,
      direction: "outgoing",
      asOf: 250,
    })).resolves.toHaveLength(1);
    expect(await expandAssociationGraph(db, ["parent-a"], {
      hops: 1,
      direction: "outgoing",
      asOf: 300,
    })).toEqual([]);
    expect(raw.prepare(
      `SELECT directed, valid_from, deleted_at FROM sb_association_edges WHERE edge_type = 'references'`
    ).get()).toEqual({ directed: 1, valid_from: 200, deleted_at: 300 });
  });
});
