import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { D1EntityResolver } from "../../src/memory/entity-resolution";
import { resolveAndInsertEntityRelation } from "../../src/memory/fact-resolution-store";
import { deprecateEntryAtomicMemory } from "../../src/memory/atomic";

describe("resolution persistence", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    await ensureMemoryDataModel(db);
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
});
