import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  D1EntityMergeExecutor,
  EntityMergeCandidateUnavailableError,
  EntityMergeEndpointUnavailableError,
} from "../../src/memory/entity-merge";
import { MEMORY_QUALITY_SCHEMA_STATEMENTS } from "../../src/memory/quality";
import { ensureEntityResolutionDataModel } from "../../src/memory/entities";
import { D1EntityResolver } from "../../src/memory/entity-resolution";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("Entity Merge Executor", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    await ensureMemoryDataModel(db);
    await ensureEntityResolutionDataModel(db);
    await db.exec(MEMORY_QUALITY_SCHEMA_STATEMENTS.join(";\n"));

    raw.prepare(
      `INSERT INTO sb_entities (
         id, name, name_normalized, entity_type, aliases_json, metadata_json,
         mention_count, lifecycle_state, created_at, updated_at
       ) VALUES
         ('entity-source', '馒头助手 App', '馒头助手 app', 'project', '["mtzs client","mtzs legacy"]', '{}', 2, 'active', 1, 1),
         ('entity-target', 'mtzs', 'mtzs', 'project', '["馒头助手"]', '{}', 3, 'active', 1, 1),
         ('entity-sqlite', 'SQLite', 'sqlite', 'product', '[]', '{}', 1, 'active', 1, 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_entity_aliases (
         id, entity_id, alias, alias_normalized, source_observation_id,
         confidence, created_at, updated_at
       ) VALUES
         ('alias-source', 'entity-source', 'mtzs client', 'mtzs client', 'obs-1', 0.9, 1, 1),
         ('alias-target', 'entity-target', '馒头助手', '馒头助手', 'obs-2', 1, 1, 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_entity_alias_sources (id, alias_id, observation_id, relation, created_at)
       VALUES ('alias-source-proof', 'alias-source', 'obs-1', 'supports', 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_entity_external_ids (
         id, entity_id, provider, external_id, source_observation_id, created_at, updated_at
       ) VALUES ('external-source', 'entity-source', 'github', 'cloudmantou/mtzs', 'obs-1', 1, 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_entity_external_id_sources (
         id, external_id_id, observation_id, relation, created_at
       ) VALUES ('external-source-proof', 'external-source', 'obs-1', 'supports', 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_entity_embeddings (
         entity_id, embedding_fingerprint, embedding_json, dimensions, updated_at
       ) VALUES
         ('entity-source', 'fp-source', '[0.1,0.2]', 2, 1),
         ('entity-source', 'fp-shared', '[0.3,0.4]', 2, 1),
         ('entity-target', 'fp-shared', '[0.5,0.6]', 2, 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_entities (id, memory_id, entity_id, role, score, created_at)
       VALUES
         ('me-source-1', 'memory-1', 'entity-source', 'mentions', 0.9, 1),
         ('me-source-2', 'memory-2', 'entity-source', 'mentions', 0.8, 1),
         ('me-target-1', 'memory-1', 'entity-target', 'mentions', 0.4, 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_entity_relations (
         id, from_entity_id, to_entity_id, relation_type, fact, fact_hash,
         evidence_count, memory_id, observation_id, resolution_state,
         metadata_json, created_at
       ) VALUES
         ('relation-source', 'entity-source', 'entity-sqlite', 'uses', 'mtzs uses SQLite', 'fact-uses', 1, 'memory-2', 'obs-1', 'active', '{}', 1),
         ('relation-target', 'entity-target', 'entity-sqlite', 'uses', 'mtzs uses SQLite', 'fact-uses', 1, 'memory-1', 'obs-2', 'active', '{}', 1),
         ('relation-self', 'entity-source', 'entity-target', 'same_as', 'same project', 'fact-same', 1, 'memory-2', 'obs-1', 'active', '{}', 1),
         ('relation-inbound', 'entity-sqlite', 'entity-source', 'depends_on', 'SQLite supports mtzs', 'fact-inbound', 1, 'memory-2', 'obs-1', 'active', '{}', 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
       VALUES
         ('fs-source', 'relation-source', 'memory-2', 'obs-1', 1),
         ('fs-target', 'relation-target', 'memory-1', 'obs-2', 1),
         ('fs-self', 'relation-self', 'memory-2', 'obs-1', 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_fact_resolutions (
         id, relation_id, target_relation_id, resolution_type, confidence,
         reason_codes_json, requires_review, applied_invalidation,
         source_memory_id, target_memory_id, created_at
       ) VALUES
         ('resolution-duplicate', 'relation-source', 'relation-target', 'duplicate', 0.99, '[]', 0, 0, 'memory-2', 'memory-1', 1),
         ('resolution-self-target', 'relation-inbound', 'relation-self', 'coexists', 0.8, '[]', 0, 0, 'memory-2', 'memory-2', 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_entity_merge_candidates (
         id, source_entity_id, target_entity_id, matched_by, score,
         reason_json, state, created_at, updated_at
       ) VALUES ('merge-candidate', 'entity-source', 'entity-target', 'semantic', 0.94,
                 '["review_required"]', 'pending', 1, 1)`
    ).run();
  });

  afterEach(() => raw.close());

  it("merges all identity and graph references in one reviewed operation", async () => {
    const result = await new D1EntityMergeExecutor(db).resolve({
      candidateId: "merge-candidate",
      decision: "accept",
      actorType: "user",
      actorId: "mantou",
      reason: "same project",
      reviewedAt: 100,
    });

    expect(result).toMatchObject({
      candidateId: "merge-candidate",
      sourceEntityId: "entity-source",
      targetEntityId: "entity-target",
      state: "merged",
    });
    expect(raw.prepare(
      `SELECT lifecycle_state, merged_into_entity_id, merged_at, mention_count
       FROM sb_entities WHERE id = 'entity-source'`
    ).get()).toEqual({
      lifecycle_state: "merged",
      merged_into_entity_id: "entity-target",
      merged_at: 100,
      mention_count: 0,
    });
    expect(raw.prepare(
      `SELECT mention_count FROM sb_entities WHERE id = 'entity-target'`
    ).get()).toEqual({ mention_count: 5 });

    const aliases = raw.prepare(
      `SELECT alias_normalized FROM sb_entity_aliases
       WHERE entity_id = 'entity-target' ORDER BY alias_normalized`
    ).all() as Array<{ alias_normalized: string }>;
    expect(aliases.map((row) => row.alias_normalized)).toEqual([
      "mtzs client",
      "mtzs legacy",
      "馒头助手",
      "馒头助手 app",
    ]);
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM sb_entity_alias_sources s
       JOIN sb_entity_aliases a ON a.id = s.alias_id
       WHERE a.entity_id = 'entity-target' AND s.observation_id = 'obs-1'`
    ).get()).toEqual({ count: 1 });
    expect(raw.prepare(
      `SELECT entity_id FROM sb_entity_external_ids WHERE id = 'external-source'`
    ).get()).toEqual({ entity_id: "entity-target" });
    expect(raw.prepare(
      `SELECT embedding_fingerprint FROM sb_entity_embeddings
       WHERE entity_id = 'entity-target' ORDER BY embedding_fingerprint`
    ).all()).toEqual([
      { embedding_fingerprint: "fp-shared" },
      { embedding_fingerprint: "fp-source" },
    ]);
    expect(raw.prepare(
      `SELECT memory_id, score FROM sb_memory_entities
       WHERE entity_id = 'entity-target' ORDER BY memory_id`
    ).all()).toEqual([
      { memory_id: "memory-1", score: 0.9 },
      { memory_id: "memory-2", score: 0.8 },
    ]);

    expect(raw.prepare(
      `SELECT id, from_entity_id, to_entity_id FROM sb_entity_relations ORDER BY id`
    ).all()).toEqual([
      { id: "relation-inbound", from_entity_id: "entity-sqlite", to_entity_id: "entity-target" },
      { id: "relation-target", from_entity_id: "entity-target", to_entity_id: "entity-sqlite" },
    ]);
    expect(raw.prepare(
      `SELECT memory_id FROM sb_fact_sources
       WHERE relation_id = 'relation-target' ORDER BY memory_id`
    ).all()).toEqual([{ memory_id: "memory-1" }, { memory_id: "memory-2" }]);
    expect(raw.prepare(
      `SELECT relation_id, target_relation_id FROM sb_fact_resolutions
       WHERE id = 'resolution-duplicate'`
    ).get()).toBeUndefined();
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM sb_fact_resolutions
       WHERE relation_id = target_relation_id`
    ).get()).toEqual({ count: 0 });
    expect(raw.prepare(
      `SELECT target_relation_id, requires_review FROM sb_fact_resolutions
       WHERE id = 'resolution-self-target'`
    ).get()).toEqual({ target_relation_id: null, requires_review: 1 });
    expect(raw.prepare(
      `SELECT state, reviewed_by, reviewed_at FROM sb_entity_merge_candidates
       WHERE id = 'merge-candidate'`
    ).get()).toEqual({ state: "merged", reviewed_by: "mantou", reviewed_at: 100 });
    expect(raw.prepare(
      `SELECT source_entity_id, target_entity_id, actor_type, reason
       FROM sb_entity_merge_history WHERE candidate_id = 'merge-candidate'`
    ).get()).toEqual({
      source_entity_id: "entity-source",
      target_entity_id: "entity-target",
      actor_type: "user",
      reason: "same project",
    });
    expect(raw.prepare(
      `SELECT action, object_id FROM sb_audit_events
       WHERE object_type = 'entity_merge_candidate'`
    ).get()).toEqual({ action: "quality.entity_merge.accept", object_id: "merge-candidate" });

    const resolved = await new D1EntityResolver(db).resolve({
      name: "mtzs legacy",
      entityType: "project",
    }, { now: 101 });
    expect(resolved).toMatchObject({
      entityId: "entity-target",
      created: false,
      decision: { action: "use_existing", matchedBy: "alias" },
    });
  });

  it("rejects a candidate without mutating either entity", async () => {
    const result = await new D1EntityMergeExecutor(db).resolve({
      candidateId: "merge-candidate",
      decision: "reject",
      actorType: "user",
      actorId: "mantou",
      reason: "different projects",
      reviewedAt: 100,
    });

    expect(result.state).toBe("rejected");
    expect(raw.prepare(
      `SELECT lifecycle_state, mention_count FROM sb_entities
       WHERE id = 'entity-source'`
    ).get()).toEqual({ lifecycle_state: "active", mention_count: 2 });
    await expect(new D1EntityMergeExecutor(db).resolve({
      candidateId: "merge-candidate",
      decision: "accept",
      actorType: "user",
      actorId: "mantou",
      reviewedAt: 101,
    })).rejects.toBeInstanceOf(EntityMergeCandidateUnavailableError);
  });

  it("releases the accepted lock when an endpoint is unavailable", async () => {
    raw.prepare(`UPDATE sb_entities SET lifecycle_state = 'merged' WHERE id = 'entity-target'`).run();

    await expect(new D1EntityMergeExecutor(db).resolve({
      candidateId: "merge-candidate",
      decision: "accept",
      actorType: "user",
      actorId: "mantou",
      reviewedAt: 100,
    })).rejects.toBeInstanceOf(EntityMergeEndpointUnavailableError);
    expect(raw.prepare(
      `SELECT state, reviewed_by, reviewed_at FROM sb_entity_merge_candidates
       WHERE id = 'merge-candidate'`
    ).get()).toEqual({ state: "pending", reviewed_by: null, reviewed_at: null });
  });

  it("resumes an accepted candidate using its persisted review lock", async () => {
    raw.prepare(
      `UPDATE sb_entity_merge_candidates
       SET state = 'accepted', reviewed_by = 'mantou', reviewed_at = 100
       WHERE id = 'merge-candidate'`
    ).run();

    const result = await new D1EntityMergeExecutor(db).resolve({
      candidateId: "merge-candidate",
      decision: "accept",
      actorType: "user",
      actorId: "mantou",
      reviewedAt: 999,
    });
    expect(result.state).toBe("merged");
    expect(raw.prepare(
      `SELECT reviewed_at FROM sb_entity_merge_candidates WHERE id = 'merge-candidate'`
    ).get()).toEqual({ reviewed_at: 100 });
  });
});
