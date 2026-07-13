import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { D1EntityResolver } from "../../src/memory/entity-resolution";
import { resolveAndInsertEntityRelation } from "../../src/memory/fact-resolution-store";
import { deprecateEntryAtomicMemory } from "../../src/memory/atomic";
import { MEMORY_QUALITY_SCHEMA_STATEMENTS } from "../../src/memory/quality";

describe("resolution persistence", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    await ensureMemoryDataModel(db);
    for (const statement of MEMORY_QUALITY_SCHEMA_STATEMENTS) await db.exec(statement);
  });

  afterEach(() => raw.close());

  it("persists aliases, stable ids, embeddings, and review-only merge candidates", async () => {
    const resolver = new D1EntityResolver(db);
    const first = await resolver.resolve(
      {
        name: "馒头助手",
        entityType: "product",
        aliases: ["mtzs"],
        externalIds: [{ provider: "github", value: "cloudmantou/mtzs" }],
      },
      {
        now: 1_000,
        observationId: "obs-1",
        embedding: [1, 0],
        embeddingFingerprint: "test-v1",
      }
    );
    const alias = await resolver.resolve(
      { name: "mtzs", entityType: "product" },
      { now: 2_000, observationId: "obs-2" }
    );
    await resolver.resolve(
      { name: "馒头助手", entityType: "product", aliases: ["mtzs"] },
      { now: 2_500, observationId: "obs-3" }
    );
    const semanticReview = await resolver.resolve(
      { name: "馒头助手 App", entityType: "product" },
      {
        now: 3_000,
        observationId: "obs-3",
        embedding: [0.99, 0.01],
        embeddingFingerprint: "test-v1",
      }
    );

    expect(alias.entityId).toBe(first.entityId);
    expect(alias.created).toBe(false);
    expect(semanticReview.created).toBe(true);
    expect(semanticReview.decision.action).toBe("review");
    expect(semanticReview.entityId).not.toBe(first.entityId);

    expect(raw.prepare("SELECT COUNT(*) AS count FROM sb_entity_aliases").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sb_entity_alias_sources").get()).toEqual({ count: 2 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sb_entity_external_ids").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sb_entity_external_id_sources").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sb_entity_embeddings").get()).toEqual({ count: 2 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sb_entity_merge_candidates WHERE state = 'pending'").get()).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sb_entity_merge_history").get()).toEqual({ count: 0 });
  });

  it("keeps same-name entities with incompatible types distinct", async () => {
    const resolver = new D1EntityResolver(db);
    const place = await resolver.resolve({ name: "Java", entityType: "place" }, { now: 1 });
    const product = await resolver.resolve({ name: "Java", entityType: "product" }, { now: 2 });
    const repeatedProduct = await resolver.resolve({ name: "Java", entityType: "product" }, { now: 3 });

    expect(product.entityId).not.toBe(place.entityId);
    expect(repeatedProduct.entityId).toBe(product.entityId);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM sb_entities WHERE name = 'Java'").get()).toEqual({ count: 2 });
  });

  it("does not expose review-only aliases to later resolutions in the same batch", async () => {
    const resolver = new D1EntityResolver(db);
    await resolver.resolve(
      { name: "馒头助手", entityType: "product" },
      { now: 1_000, embedding: [1, 0], embeddingFingerprint: "test-v1" }
    );
    const review = await resolver.resolve(
      { name: "馒头助手 App", entityType: "product", aliases: ["mtzs-review-only"] },
      { now: 2_000, embedding: [0.99, 0.01], embeddingFingerprint: "test-v1" }
    );
    const alias = await resolver.resolve(
      { name: "mtzs-review-only", entityType: "product" },
      { now: 3_000 }
    );

    expect(review.decision.action).toBe("review");
    expect(alias.entityId).not.toBe(review.entityId);
  });

  it("persists fact decisions and only invalidates explicit same-scope replacements", async () => {
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, claim_status, invalid_at, expired_at, entities_json, created_at
       ) VALUES ('memory-old', 'old installer', 'supported', NULL, NULL, '[]', 1),
                ('memory-test', 'test installer', 'supported', NULL, NULL, '[]', 2),
                ('memory-new', 'new installer', 'supported', NULL, NULL, '[]', 3)`
    ).run();
    const resolver = new D1EntityResolver(db);
    const mtzs = await resolver.resolve({ name: "mtzs", entityType: "project" }, { now: 1 });
    const oldInstaller = await resolver.resolve({ name: "installation_proxy", entityType: "product" }, { now: 2 });
    const testInstaller = await resolver.resolve({ name: "test_installer", entityType: "product" }, { now: 3 });
    const newInstaller = await resolver.resolve({ name: "new_installer", entityType: "product" }, { now: 4 });

    const old = await resolveAndInsertEntityRelation(db, {
      fromEntityId: mtzs.entityId,
      toEntityId: oldInstaller.entityId,
      relationType: "uses",
      fact: "mtzs uses installation_proxy",
      memoryId: "memory-old",
      observationId: "obs-old",
      scopeId: "mtzs/ios/production",
      polarity: "positive",
      modality: "confirmed",
      validFrom: 1_000,
      referenceTime: 1_000,
      createdAt: 1_000,
    });
    const coexisting = await resolveAndInsertEntityRelation(db, {
      fromEntityId: mtzs.entityId,
      toEntityId: testInstaller.entityId,
      relationType: "uses",
      fact: "mtzs test uses test_installer",
      memoryId: "memory-test",
      observationId: "obs-test",
      scopeId: "mtzs/ios/test",
      polarity: "positive",
      modality: "confirmed",
      validFrom: 1_500,
      referenceTime: 1_500,
      createdAt: 1_500,
    });
    const replacement = await resolveAndInsertEntityRelation(db, {
      fromEntityId: mtzs.entityId,
      toEntityId: newInstaller.entityId,
      relationType: "uses",
      fact: "mtzs production now replaces installation_proxy with new_installer",
      memoryId: "memory-new",
      observationId: "obs-new",
      scopeId: "mtzs/ios/production",
      polarity: "positive",
      modality: "confirmed",
      validFrom: 2_000,
      referenceTime: 2_000,
      trustedEvidence: true,
      createdAt: 2_000,
    });

    expect(coexisting.resolution.type).toBe("coexists");
    expect(replacement.resolution.type).toBe("supersedes");
    expect(raw.prepare("SELECT invalid_at, expired_at FROM sb_entity_relations WHERE id = ?").get(old.relationId)).toEqual({
      invalid_at: 2_000,
      expired_at: 2_000,
    });
    expect(raw.prepare("SELECT invalid_at FROM sb_entity_relations WHERE id = ?").get(coexisting.relationId)).toEqual({
      invalid_at: null,
    });
    expect(raw.prepare("SELECT resolution_type, target_relation_id FROM sb_fact_resolutions WHERE relation_id = ?").get(replacement.relationId)).toEqual({
      resolution_type: "supersedes",
      target_relation_id: old.relationId,
    });
    expect(raw.prepare("SELECT claim_status, invalid_at, expired_at FROM sb_memories WHERE id = 'memory-old'").get()).toEqual({
      claim_status: "superseded",
      invalid_at: 2_000,
      expired_at: 2_000,
    });
    expect(raw.prepare("SELECT claim_status FROM sb_memories WHERE id = 'memory-new'").get()).toEqual({
      claim_status: "confirmed",
    });
  });

  it("keeps a shared fact active until its final supporting memory is deprecated", async () => {
    raw.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL)`);
    raw.prepare(`INSERT INTO entries (id, content) VALUES ('entry-1', 'one'), ('entry-2', 'two')`).run();
    raw.prepare(
      `INSERT INTO sb_memories (id, content, entry_id, entities_json, created_at)
       VALUES (?, ?, ?, '[]', ?)`
    ).run("memory-1", "shared", "entry-1", 1);
    raw.prepare(
      `INSERT INTO sb_memories (id, content, entry_id, entities_json, created_at)
       VALUES (?, ?, ?, '[]', ?)`
    ).run("memory-2", "shared", "entry-2", 2);
    const resolver = new D1EntityResolver(db);
    const source = await resolver.resolve({ name: "mtzs", entityType: "project" }, { now: 1 });
    const target = await resolver.resolve({ name: "SQLite", entityType: "product" }, { now: 2 });
    const first = await resolveAndInsertEntityRelation(db, {
      fromEntityId: source.entityId,
      toEntityId: target.entityId,
      relationType: "uses",
      fact: "mtzs uses SQLite",
      memoryId: "memory-1",
      observationId: "obs-1",
      createdAt: 1,
    });
    const duplicate = await resolveAndInsertEntityRelation(db, {
      fromEntityId: source.entityId,
      toEntityId: target.entityId,
      relationType: "uses",
      fact: "mtzs uses SQLite",
      memoryId: "memory-2",
      observationId: "obs-2",
      createdAt: 2,
    });
    expect(duplicate.relationId).toBe(first.relationId);

    await deprecateEntryAtomicMemory(db, { entryId: "entry-1", invalidAt: 10 });
    expect(raw.prepare(`SELECT invalid_at FROM sb_entity_relations WHERE id = ?`).get(first.relationId))
      .toEqual({ invalid_at: null });

    await deprecateEntryAtomicMemory(db, { entryId: "entry-2", invalidAt: 20 });
    expect(raw.prepare(`SELECT invalid_at FROM sb_entity_relations WHERE id = ?`).get(first.relationId))
      .toEqual({ invalid_at: 20 });
  });

  it("attaches supporting and elaborating Claims to one canonical Fact edge", async () => {
    const resolver = new D1EntityResolver(db);
    const project = await resolver.resolve({ name: "mtzs", entityType: "project" }, { now: 1 });
    const database = await resolver.resolve({ name: "SQLite", entityType: "product" }, { now: 2 });
    const first = await resolveAndInsertEntityRelation(db, {
      fromEntityId: project.entityId,
      toEntityId: database.entityId,
      relationType: "uses",
      fact: "mtzs uses SQLite",
      memoryId: "claim-support-1",
      createdAt: 1,
    });
    const elaboration = await resolveAndInsertEntityRelation(db, {
      fromEntityId: project.entityId,
      toEntityId: database.entityId,
      relationType: "uses",
      fact: "mtzs uses SQLite as its durable store",
      memoryId: "claim-support-2",
      createdAt: 2,
    });

    expect(elaboration.resolution.type).toBe("elaborates");
    expect(elaboration.relationId).toBe(first.relationId);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_entity_relations WHERE relation_type = 'uses'`).get())
      .toEqual({ count: 1 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_fact_sources WHERE relation_id = ?`).get(first.relationId))
      .toEqual({ count: 2 });
    expect(raw.prepare(
      `SELECT relation_id, target_relation_id
       FROM sb_fact_resolutions
       WHERE source_memory_id = 'claim-support-2'`
    ).get()).toEqual({
      relation_id: first.relationId,
      target_relation_id: null,
    });
  });

  it("counts revisions of one Evidence root as one independent Fact source", async () => {
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, content_hash, root_evidence_id, revision, created_at
       ) VALUES
         ('obs-root-a-v1', 'first revision', 'obsidian', 'hash-a1', 'root-a', 1, 1),
         ('obs-root-a-v2', 'second revision', 'obsidian', 'hash-a2', 'root-a', 2, 2),
         ('obs-root-b-v1', 'independent source', 'mcp', 'hash-b1', 'root-b', 1, 3)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memories (id, content, claim_status, entities_json, created_at)
       VALUES ('claim-a1', 'mtzs uses SQLite', 'supported', '[]', 1),
              ('claim-a2', 'mtzs uses SQLite', 'supported', '[]', 2),
              ('claim-b1', 'mtzs uses SQLite', 'supported', '[]', 3)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, evidence_root_id, created_at
       ) VALUES
         ('ms-a1', 'claim-a1', 'obs-root-a-v1', 'supports', 'supports', 'root-a', 1),
         ('ms-a2', 'claim-a2', 'obs-root-a-v2', 'supports', 'supports', 'root-a', 2),
         ('ms-b1', 'claim-b1', 'obs-root-b-v1', 'supports', 'supports', 'root-b', 3)`
    ).run();
    const resolver = new D1EntityResolver(db);
    const project = await resolver.resolve({ name: "mtzs", entityType: "project" }, { now: 1 });
    const database = await resolver.resolve({ name: "SQLite", entityType: "product" }, { now: 2 });

    let relationId = "";
    for (const [memoryId, observationId, createdAt] of [
      ["claim-a1", "obs-root-a-v1", 1],
      ["claim-a2", "obs-root-a-v2", 2],
      ["claim-b1", "obs-root-b-v1", 3],
    ] as const) {
      const result = await resolveAndInsertEntityRelation(db, {
        fromEntityId: project.entityId,
        toEntityId: database.entityId,
        relationType: "uses",
        fact: "mtzs uses SQLite",
        memoryId,
        observationId,
        createdAt,
      });
      relationId = result.relationId;
    }

    expect(raw.prepare(`SELECT evidence_count FROM sb_entity_relations WHERE id = ?`).get(relationId))
      .toEqual({ evidence_count: 2 });
  });

  it("stores Fact conflicts with Entry compatibility IDs and authoritative Claim IDs", async () => {
    raw.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT NOT NULL)`);
    raw.prepare(`INSERT INTO entries (id, content) VALUES ('entry-old', 'old'), ('entry-new', 'new')`).run();
    raw.prepare(
      `INSERT INTO sb_memories (id, content, entry_id, claim_status, entities_json, created_at)
       VALUES ('claim-old', 'mtzs uses old_db', 'entry-old', 'supported', '[]', 1),
              ('claim-new', 'mtzs uses new_db', 'entry-new', 'supported', '[]', 2)`
    ).run();
    const resolver = new D1EntityResolver(db);
    const project = await resolver.resolve({ name: "mtzs", entityType: "project" }, { now: 1 });
    const oldDb = await resolver.resolve({ name: "old_db", entityType: "product" }, { now: 2 });
    const newDb = await resolver.resolve({ name: "new_db", entityType: "product" }, { now: 3 });
    await resolveAndInsertEntityRelation(db, {
      fromEntityId: project.entityId,
      toEntityId: oldDb.entityId,
      relationType: "uses",
      fact: "mtzs uses old_db",
      memoryId: "claim-old",
      scopeId: "mtzs/production",
      createdAt: 1,
    });
    await resolveAndInsertEntityRelation(db, {
      fromEntityId: project.entityId,
      toEntityId: newDb.entityId,
      relationType: "uses",
      fact: "mtzs uses new_db",
      memoryId: "claim-new",
      scopeId: "mtzs/production",
      createdAt: 2,
    });

    expect(raw.prepare(
      `SELECT old_memory_id, new_memory_id, old_claim_id, new_claim_id
       FROM sb_conflict_cases WHERE conflict_type = 'fact_resolution'`
    ).get()).toEqual({
      old_memory_id: "entry-old",
      new_memory_id: "entry-new",
      old_claim_id: "claim-old",
      new_claim_id: "claim-new",
    });
    expect(raw.prepare(`SELECT id, claim_status FROM sb_memories ORDER BY id`).all()).toEqual([
      { id: "claim-new", claim_status: "contested" },
      { id: "claim-old", claim_status: "contested" },
    ]);
  });

  it("does not auto-invalidate from an ordinary high-confidence user-written note", async () => {
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, metadata_json, content_hash, author_type,
         extraction_status, extraction_version, extraction_attempts,
         needs_reprocess, created_at
       ) VALUES ('obs-old-note', 'old', 'obsidian', '{}', 'old-hash', 'user', 'succeeded', 1, 1, 0, 1),
                ('obs-new-note', 'new', 'obsidian', '{"properties":{"status":"canonical"}}', 'new-hash', 'user', 'succeeded', 1, 1, 0, 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, claim_status, scores_json, invalid_at, expired_at, entities_json, created_at
       ) VALUES ('claim-note-old', 'old', 'supported', '{"humanConfirmation":0}', NULL, NULL, '[]', 1),
                ('claim-note-new', 'new', 'supported', '{"humanConfirmation":0}', NULL, NULL, '[]', 2)`
    ).run();
    const resolver = new D1EntityResolver(db);
    const project = await resolver.resolve({ name: "mtzs", entityType: "project" }, { now: 1 });
    const oldDb = await resolver.resolve({ name: "old_db", entityType: "product" }, { now: 2 });
    const newDb = await resolver.resolve({ name: "new_db", entityType: "product" }, { now: 3 });
    const old = await resolveAndInsertEntityRelation(db, {
      fromEntityId: project.entityId,
      toEntityId: oldDb.entityId,
      relationType: "uses",
      fact: "mtzs uses old_db",
      memoryId: "claim-note-old",
      observationId: "obs-old-note",
      score: 0.95,
      scopeId: "mtzs/production",
      createdAt: 1,
    });
    const proposed = await resolveAndInsertEntityRelation(db, {
      fromEntityId: project.entityId,
      toEntityId: newDb.entityId,
      relationType: "uses",
      fact: "mtzs production now replaces old_db with new_db",
      memoryId: "claim-note-new",
      observationId: "obs-new-note",
      score: 0.99,
      scopeId: "mtzs/production",
      createdAt: 2,
    });

    expect(proposed.resolution).toMatchObject({
      type: "supersedes",
      applyInvalidation: false,
      requiresReview: true,
    });
    expect(raw.prepare(`SELECT invalid_at, resolution_state FROM sb_entity_relations WHERE id = ?`).get(old.relationId))
      .toEqual({ invalid_at: null, resolution_state: "active" });
    expect(raw.prepare(`SELECT claim_status FROM sb_memories WHERE id = 'claim-note-old'`).get())
      .toEqual({ claim_status: "supported" });
  });
});
