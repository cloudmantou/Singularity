import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import {
  buildMemoryRelation,
  createMemoryRelations,
  listMemoryRelations,
} from "../../src/memory/relations";
import { forgetMemoryGraph } from "../../src/memory/forget";
import { prepareMemoryRevision } from "../../src/memory/revisions";

describe("memory data model", () => {
  let raw: Database.Database;

  beforeEach(() => {
    raw = new Database(":memory:");
  });

  afterEach(() => {
    raw.close();
  });

  it("creates permanent relation and revision tables idempotently", async () => {
    const db = new SqliteD1Database(raw) as unknown as D1Database;

    await ensureMemoryDataModel(db);
    await ensureMemoryDataModel(db);

    const tables = raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('sb_memory_relations', 'sb_memory_revisions')
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(table => table.name)).toEqual([
      "sb_memory_relations",
      "sb_memory_revisions",
    ]);

    const relationIndexes = raw
      .prepare(`PRAGMA index_list('sb_memory_relations')`)
      .all() as Array<{ name: string }>;
    expect(relationIndexes.map(index => index.name)).toEqual(
      expect.arrayContaining([
        "idx_sb_memory_relations_from",
        "idx_sb_memory_relations_to",
      ])
    );
  });

  it("migrates legacy observations to the extraction queue schema", async () => {
    const db = new SqliteD1Database(raw) as unknown as D1Database;
    await db.exec(`
      CREATE TABLE sb_observations (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'api',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      )
    `);
    await db.batch([
      db.prepare(
        `INSERT INTO sb_observations (id, content, source, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind("obs-pending", "legacy observation", "api", "{}", 1),
      db.prepare(
        `INSERT INTO sb_observations (id, content, source, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind("obs-reprocess", "legacy fallback", "api", '{"needs_reprocess":true}', 2),
    ]);

    await ensureMemoryDataModel(db);

    const columns = raw
      .prepare(`PRAGMA table_info('sb_observations')`)
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "content_hash",
        "extraction_status",
        "extraction_version",
        "extraction_attempts",
        "extraction_error",
        "next_attempt_at",
        "processing_started_at",
        "processed_at",
        "needs_reprocess",
      ])
    );

    const rows = raw
      .prepare(
        `SELECT id, extraction_status, extraction_attempts, needs_reprocess
         FROM sb_observations
         ORDER BY id`
      )
      .all() as Array<{
        id: string;
        extraction_status: string;
        extraction_attempts: number;
        needs_reprocess: number;
      }>;
    expect(rows).toEqual([
      {
        id: "obs-pending",
        extraction_status: "pending",
        extraction_attempts: 0,
        needs_reprocess: 0,
      },
      {
        id: "obs-reprocess",
        extraction_status: "fallback",
        extraction_attempts: 0,
        needs_reprocess: 1,
      },
    ]);
  });

  it("migrates legacy atomic memories and fact edges with expired_at", async () => {
    const db = new SqliteD1Database(raw) as unknown as D1Database;
    await db.exec(`
      CREATE TABLE sb_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        kind TEXT,
        memory_class TEXT,
        importance REAL,
        confidence REAL,
        entry_id TEXT,
        content_hash TEXT,
        observed_at INTEGER,
        valid_from INTEGER,
        valid_to INTEGER,
        reference_time INTEGER,
        invalid_at INTEGER,
        entities_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE sb_entity_relations (
        id TEXT PRIMARY KEY,
        from_entity_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        fact TEXT,
        memory_id TEXT,
        observation_id TEXT,
        score REAL,
        valid_from INTEGER,
        valid_to INTEGER,
        invalid_at INTEGER,
        reference_time INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      )
    `);

    await ensureMemoryDataModel(db);

    const memoryColumns = raw
      .prepare(`PRAGMA table_info('sb_memories')`)
      .all() as Array<{ name: string }>;
    expect(memoryColumns.map((column) => column.name)).toContain("expired_at");

    const relationColumns = raw
      .prepare(`PRAGMA table_info('sb_entity_relations')`)
      .all() as Array<{ name: string }>;
    expect(relationColumns.map((column) => column.name)).toContain("expired_at");
    expect(relationColumns.map((column) => column.name)).toContain("fact_hash");
    expect(relationColumns.map((column) => column.name)).toContain("evidence_count");
    const factSources = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sb_fact_sources'`)
      .get();
    expect(factSources).toBeTruthy();
  });

  it("deduplicates NULL fact sources before adding the identity index", async () => {
    const db = new SqliteD1Database(raw) as unknown as D1Database;
    raw.exec(`
      CREATE TABLE sb_fact_sources (
        id TEXT PRIMARY KEY,
        relation_id TEXT NOT NULL,
        memory_id TEXT,
        observation_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(relation_id, memory_id, observation_id)
      )
    `);
    raw
      .prepare(
        `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("source-a", "relation-1", "memory-1", null, 1);
    raw
      .prepare(
        `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("source-b", "relation-1", "memory-1", null, 2);

    await ensureMemoryDataModel(db);

    const rows = raw
      .prepare(`SELECT id FROM sb_fact_sources ORDER BY created_at`)
      .all() as Array<{ id: string }>;
    expect(rows).toEqual([{ id: "source-a" }]);
    const indexes = raw
      .prepare(`PRAGMA index_list('sb_fact_sources')`)
      .all() as Array<{ name: string; unique: number }>;
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "idx_fact_sources_identity", unique: 1 }),
      ])
    );
    expect(() =>
      raw
        .prepare(
          `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run("source-c", "relation-1", "memory-1", null, 3)
    ).toThrow();
  });

  it("rejects invalid relation endpoints, types, and scores before SQL", () => {
    expect(() => buildMemoryRelation({
      fromMemoryId: "same",
      toMemoryId: "same",
      relationType: "similar",
    })).toThrow(/itself/);
    expect(() => buildMemoryRelation({
      fromMemoryId: "a",
      toMemoryId: "b",
      relationType: "invalid" as any,
    })).toThrow(/Unsupported/);
    expect(() => buildMemoryRelation({
      fromMemoryId: "a",
      toMemoryId: "b",
      relationType: "similar",
      score: 1.1,
    })).toThrow(/between 0 and 1/);
  });

  it("reads evidence links and securely erases derived memories on real SQLite", async () => {
    const db = new SqliteD1Database(raw) as unknown as D1Database;
    await db.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        vector_ids TEXT NOT NULL
      )
    `);
    await ensureMemoryDataModel(db);
    await db.batch([
      db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("source", "private fact", '["work"]', "api", 1, '["source-vector"]'),
      db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("digest", "digest of private fact", '["synthesized"]', "system", 2, '["digest-vector"]'),
      db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("other", "other fact", '["work","rolled-up"]', "api", 3, '["other-vector"]'),
    ]);
    await db.exec(`ALTER TABLE entries ADD COLUMN metadata_hash TEXT`);
    await db.exec(`ALTER TABLE entries ADD COLUMN pending_metadata_hash TEXT`);
    await createMemoryRelations(db, [
      {
        fromMemoryId: "digest",
        toMemoryId: "source",
        relationType: "digest_of",
      },
      {
        fromMemoryId: "digest",
        toMemoryId: "other",
        relationType: "digest_of",
      },
    ]);
    await db.batch([
      db.prepare(
        `INSERT INTO sb_observations (id, content, source, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind("obs-deleted", "private fact", "api", "{}", 1),
      db.prepare(
        `INSERT INTO sb_observations (id, content, source, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind("obs-surviving", "other fact", "api", "{}", 3),
      db.prepare(
        `INSERT INTO sb_memories (
           id, content, kind, memory_class, importance, confidence,
           entry_id, content_hash, observed_at, valid_from, valid_to,
           reference_time, invalid_at, entities_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind("atomic-source", "private fact", null, null, null, null, "source", "hash-source", 1, null, null, 1, null, "[]", 1),
      db.prepare(
        `INSERT INTO sb_memories (
           id, content, kind, memory_class, importance, confidence,
           entry_id, content_hash, observed_at, valid_from, valid_to,
           reference_time, invalid_at, entities_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind("atomic-digest", "digest of private fact", null, null, null, null, "digest", "hash-digest", 2, null, null, 2, null, "[]", 2),
      db.prepare(
        `INSERT INTO sb_memories (
           id, content, kind, memory_class, importance, confidence,
           entry_id, content_hash, observed_at, valid_from, valid_to,
           reference_time, invalid_at, entities_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind("atomic-other", "other fact", null, null, null, null, "other", "hash-other", 3, null, null, 3, null, "[]", 3),
      db.prepare(
        `INSERT INTO sb_memory_sources (id, memory_id, observation_id, role, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind("src-source", "atomic-source", "obs-deleted", "derived_from", null, 1),
      db.prepare(
        `INSERT INTO sb_memory_sources (id, memory_id, observation_id, role, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind("src-digest", "atomic-digest", "obs-deleted", "derived_from", null, 2),
      db.prepare(
        `INSERT INTO sb_memory_sources (id, memory_id, observation_id, role, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind("src-other", "atomic-other", "obs-surviving", "derived_from", null, 3),
      db.prepare(
        `INSERT INTO sb_memory_entities (id, memory_id, entity_id, role, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind("mention-source", "atomic-source", "entity-source", "mentions", null, 1),
      db.prepare(
        `INSERT INTO sb_memory_entities (id, memory_id, entity_id, role, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind("mention-other", "atomic-other", "entity-other", "mentions", null, 3),
      db.prepare(
        `INSERT INTO sb_entity_relations (
           id, from_entity_id, to_entity_id, relation_type, fact,
           memory_id, observation_id, score,
           valid_from, valid_to, invalid_at, reference_time,
           metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind("fact-source", "entity-source", "entity-other", "related_to", null, "atomic-source", "obs-deleted", null, null, null, null, 1, "{}", 1),
      db.prepare(
        `INSERT INTO sb_entity_relations (
           id, from_entity_id, to_entity_id, relation_type, fact,
           memory_id, observation_id, score,
           valid_from, valid_to, invalid_at, reference_time,
           metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind("fact-other", "entity-other", "entity-source", "related_to", null, "atomic-other", "obs-surviving", null, null, null, null, 3, "{}", 3),
    ]);

    const relations = await listMemoryRelations(db, "source");
    expect(relations).toEqual([
      expect.objectContaining({
        direction: "incoming",
        relation: "digest_of",
        other: expect.objectContaining({ id: "digest" }),
      }),
    ]);

    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "deleted" });
    const result = await forgetMemoryGraph(
      "source",
      db,
      { deleteByIds } as unknown as VectorizeIndex
    );

    expect(result).toMatchObject({ status: "deleted", derivedCount: 1, vectorCount: 2 });
    expect(deleteByIds).toHaveBeenCalledWith(
      expect.arrayContaining(["source-vector", "digest-vector"])
    );
    const { results: remaining } = await db
      .prepare(`SELECT id, tags FROM entries ORDER BY id`)
      .all<{ id: string; tags: string }>();
    expect(remaining).toEqual([{ id: "other", tags: '["work"]' }]);
    const unroll = await db
      .prepare(`SELECT event_type FROM sb_memory_revisions WHERE memory_id = ?`)
      .bind("other")
      .first<{ event_type: string }>();
    expect(unroll?.event_type).toBe("UNROLL");
    const { results: atomicMemories } = await db
      .prepare(`SELECT id FROM sb_memories ORDER BY id`)
      .all<{ id: string }>();
    expect(atomicMemories.map(row => row.id)).toEqual(["atomic-other"]);
    const { results: observations } = await db
      .prepare(`SELECT id FROM sb_observations ORDER BY id`)
      .all<{ id: string }>();
    expect(observations.map(row => row.id)).toEqual(["obs-surviving"]);
    const { results: memoryEntities } = await db
      .prepare(`SELECT memory_id FROM sb_memory_entities ORDER BY memory_id`)
      .all<{ memory_id: string }>();
    expect(memoryEntities.map(row => row.memory_id)).toEqual(["atomic-other"]);
    const { results: factEdges } = await db
      .prepare(`SELECT memory_id FROM sb_entity_relations ORDER BY memory_id`)
      .all<{ memory_id: string }>();
    expect(factEdges.map(row => row.memory_id)).toEqual(["atomic-other"]);
  });

  it("removes only the forgotten source from aggregated fact relations on real SQLite", async () => {
    const db = new SqliteD1Database(raw) as unknown as D1Database;
    await db.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        vector_ids TEXT NOT NULL
      )
    `);
    await ensureMemoryDataModel(db);
    await db.batch([
      db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("primary", "shared fact source one", '["work"]', "api", 1, '["primary-vector"]'),
      db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("secondary", "shared fact source two", '["work"]', "api", 2, '["secondary-vector"]'),
      db.prepare(
        `INSERT INTO sb_observations (id, content, source, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind("obs-primary", "shared fact source one", "api", "{}", 1),
      db.prepare(
        `INSERT INTO sb_observations (id, content, source, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind("obs-secondary", "shared fact source two", "api", "{}", 2),
      db.prepare(
        `INSERT INTO sb_memories (
           id, content, kind, memory_class, importance, confidence,
           entry_id, content_hash, observed_at, valid_from, valid_to,
           reference_time, invalid_at, entities_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind("atomic-primary", "shared fact source one", "semantic", null, null, null, "primary", "hash-primary", 1, null, null, 1, null, "[]", 1),
      db.prepare(
        `INSERT INTO sb_memories (
           id, content, kind, memory_class, importance, confidence,
           entry_id, content_hash, observed_at, valid_from, valid_to,
           reference_time, invalid_at, entities_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind("atomic-secondary", "shared fact source two", "semantic", null, null, null, "secondary", "hash-secondary", 2, null, null, 2, null, "[]", 2),
      db.prepare(
        `INSERT INTO sb_memory_sources (id, memory_id, observation_id, role, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind("src-primary", "atomic-primary", "obs-primary", "derived_from", null, 1),
      db.prepare(
        `INSERT INTO sb_memory_sources (id, memory_id, observation_id, role, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind("src-secondary", "atomic-secondary", "obs-secondary", "derived_from", null, 2),
      db.prepare(
        `INSERT INTO sb_entity_relations (
           id, from_entity_id, to_entity_id, relation_type, fact,
           fact_hash, evidence_count, memory_id, observation_id, score,
           valid_from, valid_to, invalid_at, expired_at, reference_time,
           metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind("fact-shared", "entity-a", "entity-b", "uses", "A uses B", "hash-shared", 2, "atomic-primary", "obs-primary", 0.9, null, null, null, null, 1, "{}", 1),
      db.prepare(
        `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind("fact-source-primary", "fact-shared", "atomic-primary", "obs-primary", 1),
      db.prepare(
        `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind("fact-source-secondary", "fact-shared", "atomic-secondary", "obs-secondary", 2),
    ]);

    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "deleted" });
    const result = await forgetMemoryGraph(
      "secondary",
      db,
      { deleteByIds } as unknown as VectorizeIndex
    );

    expect(result).toMatchObject({ status: "deleted", derivedCount: 0, vectorCount: 1 });
    expect(deleteByIds).toHaveBeenCalledWith(["secondary-vector"]);
    const relation = await db
      .prepare(
        `SELECT memory_id, observation_id, evidence_count
         FROM sb_entity_relations
         WHERE id = ?`
      )
      .bind("fact-shared")
      .first<{ memory_id: string; observation_id: string; evidence_count: number }>();
    expect(relation).toEqual({
      memory_id: "atomic-primary",
      observation_id: "obs-primary",
      evidence_count: 1,
    });
    const { results: sources } = await db
      .prepare(`SELECT memory_id FROM sb_fact_sources ORDER BY memory_id`)
      .all<{ memory_id: string }>();
    expect(sources.map(row => row.memory_id)).toEqual(["atomic-primary"]);
  });

  it("records a revision only when the guarded vector generation becomes active", async () => {
    const db = new SqliteD1Database(raw) as unknown as D1Database;
    await db.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        vector_ids TEXT NOT NULL
      )
    `);
    await ensureMemoryDataModel(db);
    await db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)`).bind(
      "memory-1",
      "Original",
      "[]",
      "api",
      1,
      '["old-vector"]'
    ).run();

    const committedRevision = prepareMemoryRevision(db, {
      memoryId: "memory-1",
      eventType: "UPDATE",
      oldContent: "Original",
      newContent: "Committed",
      actor: "test",
    }, {
      activeVectorIdsJson: '["new-vector"]',
    });
    const committed = await db.batch([
      db.prepare(
        `UPDATE entries SET content = ?, vector_ids = ?
         WHERE id = ? AND content = ? AND vector_ids = ?`
      ).bind("Committed", '["new-vector"]', "memory-1", "Original", '["old-vector"]'),
      committedRevision.statement,
    ]);
    expect(committed.map(result => result.meta.changes)).toEqual([1, 1]);

    const staleRevision = prepareMemoryRevision(db, {
      memoryId: "memory-1",
      eventType: "UPDATE",
      oldContent: "Original",
      newContent: "Stale",
      actor: "test",
    }, {
      activeVectorIdsJson: '["stale-vector"]',
    });
    const stale = await db.batch([
      db.prepare(
        `UPDATE entries SET content = ?, vector_ids = ?
         WHERE id = ? AND content = ? AND vector_ids = ?`
      ).bind("Stale", '["stale-vector"]', "memory-1", "Original", '["old-vector"]'),
      staleRevision.statement,
    ]);
    expect(stale.map(result => result.meta.changes)).toEqual([0, 0]);

    expect(raw.prepare(`SELECT content, vector_ids FROM entries WHERE id = ?`)
      .get("memory-1")).toEqual({ content: "Committed", vector_ids: '["new-vector"]' });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_memory_revisions`)
      .get()).toEqual({ count: 1 });
  });
});
