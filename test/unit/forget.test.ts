import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureEntityResolutionDataModel } from "../../src/memory/entities";
import { ensureAIReviewDataModel } from "../../src/memory/ai-review";
import { inspectMemoryBackupIntegrity } from "../../src/memory/backup";
import { FACT_RESOLUTION_SCHEMA_STATEMENTS } from "../../src/memory/fact-resolution";
import { forgetMemoryGraph } from "../../src/memory/forget";
import { ensureKnowledgeEvolutionDataModel } from "../../src/memory/knowledge-evolution";
import { MEMORY_QUALITY_SCHEMA_STATEMENTS } from "../../src/memory/quality";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("forgetMemoryGraph Fact evidence repair", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    await ensureMemoryDataModel(db);
    await ensureEntityResolutionDataModel(db);
    await db.exec(MEMORY_QUALITY_SCHEMA_STATEMENTS.join(";\n"));
    await db.exec(FACT_RESOLUTION_SCHEMA_STATEMENTS.join(";\n"));
    raw.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        vector_ids TEXT NOT NULL DEFAULT '[]',
        pending_vector_ids TEXT,
        pending_rebuild_id TEXT
      );
    `);
    await ensureAIReviewDataModel(db);
    await ensureKnowledgeEvolutionDataModel(db);
  });

  afterEach(() => raw.close());

  it("counts surviving revisions and AI derivations from one Evidence root once", async () => {
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
       VALUES ('entry-delete', 'independent support', '[]', 'api', 1, '[]')`
    ).run();
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, content_hash, root_evidence_id, revision, author_type, created_at
       ) VALUES
         ('obs-delete', 'independent support', 'mcp', 'hash-b1', 'root-b', 1, 'user', 1),
         ('obs-a1', 'first revision', 'obsidian', 'hash-a1', 'root-a', 1, 'user', 2),
         ('obs-a2', 'second revision', 'obsidian', 'hash-a2', 'root-a', 2, 'user', 3),
         ('obs-ai', 'AI-derived support', 'system', 'hash-a3', 'root-a', 3, 'assistant', 4)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, claim_status, entities_json, created_at
       ) VALUES
         ('claim-delete', 'independent support', 'entry-delete', 'supported', '[]', 1),
         ('claim-a1', 'first revision', NULL, 'supported', '[]', 2),
         ('claim-a2', 'second revision', NULL, 'supported', '[]', 3),
         ('claim-ai', 'AI-derived support', NULL, 'supported', '[]', 4)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, evidence_root_id, created_at
       ) VALUES
         ('ms-delete', 'claim-delete', 'obs-delete', 'supports', 'supports', 'root-b', 1),
         ('ms-a1', 'claim-a1', 'obs-a1', 'supports', 'supports', 'root-a', 2),
         ('ms-a2', 'claim-a2', 'obs-a2', 'supports', 'supports', 'root-a', 3),
         ('ms-ai', 'claim-ai', 'obs-ai', 'derived', 'derived_from', 'root-a', 4)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_entity_relations (
         id, from_entity_id, to_entity_id, relation_type, fact, fact_hash,
         evidence_count, memory_id, observation_id, resolution_state,
         metadata_json, created_at
       ) VALUES (
         'relation-1', 'entity-a', 'entity-b', 'uses', 'project uses SQLite', 'fact-1',
         2, 'claim-delete', 'obs-delete', 'active', '{}', 1
       )`
    ).run();
    raw.prepare(
      `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
       VALUES
         ('fs-delete', 'relation-1', 'claim-delete', 'obs-delete', 1),
         ('fs-a1', 'relation-1', 'claim-a1', 'obs-a1', 2),
         ('fs-a2', 'relation-1', 'claim-a2', 'obs-a2', 3),
         ('fs-ai', 'relation-1', 'claim-ai', 'obs-ai', 4)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_claim_vectors (
         claim_id, embedding_fingerprint, content_hash, vector_ids_json, indexed_at
       ) VALUES ('claim-delete', 'profile-a', 'hash-b1', '["claim-vector-1","claim-vector-2"]', 1)`
    ).run();
    const deleteByIds = vi.fn().mockResolvedValue(undefined);

    const result = await forgetMemoryGraph(
      "entry-delete",
      db,
      { deleteByIds } as unknown as VectorizeIndex
    );

    expect(result).toMatchObject({ status: "deleted", vectorCount: 2 });
    expect(deleteByIds).toHaveBeenCalledWith(["claim-vector-1", "claim-vector-2"]);
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM sb_claim_vectors WHERE claim_id = 'claim-delete'`
    ).get()).toEqual({ count: 0 });
    expect(raw.prepare(
      `SELECT evidence_count, memory_id, observation_id
       FROM sb_entity_relations WHERE id = 'relation-1'`
    ).get()).toEqual({
      evidence_count: 1,
      memory_id: "claim-a1",
      observation_id: "obs-a1",
    });
  });

  it("preserves the database when a tracked Claim vector mapping is malformed", async () => {
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
       VALUES ('entry-malformed', 'keep me', '[]', 'api', 1, '[]')`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memories (id, content, entry_id, claim_status, entities_json, created_at)
       VALUES ('claim-malformed', 'keep me', 'entry-malformed', 'supported', '[]', 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_claim_vectors (
         claim_id, embedding_fingerprint, content_hash, vector_ids_json, indexed_at
       ) VALUES ('claim-malformed', 'profile-a', 'hash-a', 'not-json', 1)`
    ).run();
    const deleteByIds = vi.fn();

    await expect(forgetMemoryGraph(
      "entry-malformed",
      db,
      { deleteByIds } as unknown as VectorizeIndex
    )).resolves.toEqual({ status: "delete_failed" });
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(raw.prepare(`SELECT id FROM entries WHERE id = 'entry-malformed'`).get())
      .toEqual({ id: "entry-malformed" });
    expect(raw.prepare(`SELECT id FROM sb_memories WHERE id = 'claim-malformed'`).get())
      .toEqual({ id: "claim-malformed" });
  });

  it("purges AI review manifests when forgetting their reviewed memory object", async () => {
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
       VALUES ('review-source', 'private source', '[]', 'api', 1, '[]'),
              ('review-target', 'private target', '[]', 'api', 1, '[]')`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_merge_candidates (
         id, source_memory_id, target_memory_id, similarity,
         suggested_action, state, created_at
       ) VALUES ('review-candidate', 'review-source', 'review-target', 1,
                 'duplicate', 'pending', 1)`
    ).run();
    const manifest = JSON.stringify({
      objectType: "memory_merge_candidate",
      objectId: "review-candidate",
      evidence: [{ ref: "SOURCE", memoryId: "review-source" }],
    });
    raw.prepare(
      `INSERT INTO sb_ai_review_jobs (
         id, object_type, object_id, mode, status, requested_by,
         input_snapshot_hash, input_snapshot_json, run_id, created_at
       ) VALUES ('review-job', 'memory_merge_candidate', 'review-candidate',
                 'suggest', 'applied', 'owner', 'snapshot-hash', ?, 'review-run', 1)`
    ).run(manifest);
    raw.prepare(
      `INSERT INTO sb_ai_review_runs (
         id, job_id, object_type, object_id, mode, decision, reason,
         evidence_refs_json, confidence_json, reviewer_provider, reviewer_model,
         prompt_version, input_snapshot_hash, input_snapshot_json, created_at
       ) VALUES ('review-run', 'review-job', 'memory_merge_candidate', 'review-candidate',
                 'suggest', 'duplicate', 'same content', '["SOURCE"]', '{}',
                 'test', 'reviewer', 'v1', 'snapshot-hash', ?, 1)`
    ).run(manifest);
    raw.prepare(
      `INSERT INTO sb_ai_review_applications (
         id, run_id, object_type, object_id, decision, applied_by,
         application_mode, created_at
       ) VALUES ('review-application', 'review-run', 'memory_merge_candidate',
                 'review-candidate', 'duplicate', 'owner', 'human', 1)`
    ).run();

    await expect(forgetMemoryGraph(
      "review-source",
      db,
      { deleteByIds: vi.fn().mockResolvedValue(undefined) } as unknown as VectorizeIndex
    )).resolves.toMatchObject({ status: "deleted" });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_ai_review_jobs`).get())
      .toEqual({ count: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_ai_review_runs`).get())
      .toEqual({ count: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_ai_review_applications`).get())
      .toEqual({ count: 0 });
  });

  it("removes evolution lineage and copied provenance when forgetting a consolidated source", async () => {
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
       VALUES ('evolution-source', 'same fact', '[]', 'api', 1, '[]'),
              ('evolution-target', 'same fact', '[]', 'api', 2, '[]')`
    ).run();
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, root_evidence_id, revision, author_type, created_at
       ) VALUES ('evolution-source-observation', 'same fact', 'api', 'root-source', 1, 'user', 1),
                ('evolution-target-observation', 'same fact', 'api', 'root-target', 1, 'user', 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, claim_status, invalid_at, entities_json, created_at
       ) VALUES ('evolution-source-claim', 'same fact', 'evolution-source', 'superseded', 10, '[]', 1),
                ('evolution-target-claim', 'same fact', 'evolution-target', 'supported', NULL, '[]', 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, extractor_model,
         extractor_version, evidence_root_id, created_at
       ) VALUES ('evolution-source-proof', 'evolution-source-claim',
                 'evolution-source-observation', 'supports', 'supports', 'seed', '1', 'root-source', 1),
                ('evolution-target-proof', 'evolution-target-claim',
                 'evolution-target-observation', 'supports', 'supports', 'seed', '1', 'root-target', 2),
                ('evolution-copied-proof', 'evolution-target-claim',
                 'evolution-source-observation', 'derived_from', 'derived_from',
                 'knowledge-evolution', 'review:evolution-run', 'root-source', 10)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_merge_candidates (
         id, source_memory_id, target_memory_id, similarity,
         suggested_action, state, reviewed_by, reviewed_at, created_at
       ) VALUES ('evolution-candidate', 'evolution-source', 'evolution-target', 1,
                 'duplicate', 'accepted', 'ai-review:system', 10, 1)`
    ).run();
    const manifest = JSON.stringify({
      objectType: "memory_merge_candidate",
      objectId: "evolution-candidate",
      state: "pending",
      evidence: [],
      policyInput: {},
    });
    raw.prepare(
      `INSERT INTO sb_ai_review_jobs (
         id, object_type, object_id, mode, status, requested_by,
         input_snapshot_hash, input_snapshot_json, run_id, created_at, completed_at
       ) VALUES ('evolution-job', 'memory_merge_candidate', 'evolution-candidate',
                 'auto_low_risk', 'applied', 'system', 'snapshot', ?, 'evolution-run', 1, 10)`
    ).run(manifest);
    raw.prepare(
      `INSERT INTO sb_ai_review_runs (
         id, job_id, object_type, object_id, mode, decision, reason,
         evidence_refs_json, confidence_json, reviewer_provider, reviewer_model,
         prompt_version, input_snapshot_hash, input_snapshot_json, created_at
       ) VALUES ('evolution-run', 'evolution-job', 'memory_merge_candidate',
                 'evolution-candidate', 'auto_low_risk', 'duplicate', 'same fact',
                 '["SOURCE","TARGET"]', '{"decision":1,"evidence":1}',
                 'rules', 'exact', 'v3', 'snapshot', ?, 10)`
    ).run(manifest);
    raw.prepare(
      `INSERT INTO sb_ai_review_applications (
         id, run_id, object_type, object_id, decision, applied_by,
         application_mode, created_at
       ) VALUES ('evolution-application', 'evolution-run', 'memory_merge_candidate',
                 'evolution-candidate', 'duplicate', 'system', 'deterministic_auto', 10)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_knowledge_evolutions (
         id, ai_review_run_id, candidate_id, operation, state, generation,
         output_entry_id, output_claim_id, output_generated,
         decision_confidence, evidence_confidence, applied_by, applied_at,
         created_at, updated_at
       ) VALUES ('evolution-1', 'evolution-run', 'evolution-candidate', 'consolidate',
                 'active', 1, 'evolution-target', 'evolution-target-claim', 0,
                 1, 1, 'system', 10, 10, 10)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_knowledge_evolution_sources (
         evolution_id, claim_id, entry_id, disposition, previous_claim_status,
         previous_invalid_at, source_order, created_at
       ) VALUES ('evolution-1', 'evolution-source-claim', 'evolution-source',
                 'absorbed', 'supported', NULL, 0, 10),
                ('evolution-1', 'evolution-target-claim', 'evolution-target',
                 'retained', 'supported', NULL, 1, 10)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_knowledge_claim_ownership (claim_id, evolution_id, acquired_at)
       VALUES ('evolution-source-claim', 'evolution-1', 10)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_knowledge_evolution_history (
         id, evolution_id, action, actor_id, created_at
       ) VALUES ('evolution-history', 'evolution-1', 'applied', 'system', 10)`
    ).run();

    await expect(forgetMemoryGraph(
      "evolution-source",
      db,
      { deleteByIds: vi.fn().mockResolvedValue(undefined) } as unknown as VectorizeIndex
    )).resolves.toMatchObject({ status: "deleted" });

    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM sb_memory_sources
       WHERE id = 'evolution-copied-proof'`
    ).get()).toEqual({ count: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_knowledge_evolutions`).get())
      .toEqual({ count: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_knowledge_evolution_sources`).get())
      .toEqual({ count: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_knowledge_claim_ownership`).get())
      .toEqual({ count: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_knowledge_evolution_history`).get())
      .toEqual({ count: 0 });
    expect(raw.prepare(
      `SELECT claim_status, invalid_at FROM sb_memories WHERE id = 'evolution-target-claim'`
    ).get()).toEqual({ claim_status: "supported", invalid_at: null });
    expect((await inspectMemoryBackupIntegrity(db)).ok).toBe(true);
  });
});
