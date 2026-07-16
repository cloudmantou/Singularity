import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase } from "../../src/index";
import { activeMemoryClaimPredicate } from "../../src/memory/claim-eligibility";
import {
  prepareMemoryKnowledgeEvolution,
  rollbackKnowledgeEvolution,
} from "../../src/memory/knowledge-evolution";
import { createAssociationEdge, deleteAssociationEdge } from "../../src/memory/associations";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seedCandidate(
  db: ReturnType<typeof createSelfhostEnv>["db"],
  input: { id: string; sourceContent: string; targetContent: string }
) {
  const now = Date.now();
  for (const side of ["source", "target"] as const) {
    const content = side === "source" ? input.sourceContent : input.targetContent;
    const entryId = `${input.id}-${side}`;
    const claimId = `${entryId}-claim`;
    const observationId = `${entryId}-observation`;
    const parentId = `${entryId}-parent`;
    const versionId = `${parentId}-v1`;
    const contentHash = await hash(content);
    db.prepare(
      `INSERT INTO entries (
         id, content, tags, source, created_at, vector_ids, content_hash,
         classification_status, classified_at
       ) VALUES (?, ?, ?, 'obsidian', ?, '[]', ?, 'completed', ?)`
    ).run(entryId, content, JSON.stringify(["project/singularity"]), now, contentHash, now);
    db.prepare(
      `INSERT INTO sb_observations (
         id, content, source, content_hash, source_channel, source_identity,
         author_type, source_timestamp, revision, root_evidence_id,
         extraction_status, created_at
       ) VALUES (?, ?, 'obsidian', ?, 'obsidian', ?, 'user', ?, 1, ?, 'completed', ?)`
    ).run(observationId, content, contentHash, `work-vault/${side}.md`, now, observationId, now);
    db.prepare(
      `INSERT INTO sb_parent_units (parent_id, active_version_id, scope_id, created_at, updated_at)
       VALUES (?, ?, 'project/singularity', ?, ?)`
    ).run(parentId, versionId, now, now);
    db.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, source_observation_id,
         source_snapshot_hash, tags_snapshot_json, source_snapshot, vault_snapshot,
         state, activated_at, activation_time_source, created_at, updated_at
       ) VALUES (?, ?, 1, ?, ?, ?, 'obsidian', 'work-vault',
                 'active', ?, 'recorded', ?, ?)`
    ).run(
      versionId,
      parentId,
      observationId,
      contentHash,
      JSON.stringify(["project/singularity"]),
      now,
      now,
      now
    );
    db.prepare(
      `INSERT INTO sb_memories (
         id, content, kind, memory_class, confidence, entry_id, parent_version_id,
         scope_id, claim_status, scores_json, content_hash, observed_at,
         entities_json, created_at
       ) VALUES (?, ?, 'semantic', 'fact', 0.95, ?, ?, 'project/singularity',
                 'supported', '{}', ?, ?, '[]', ?)`
    ).run(claimId, content, entryId, versionId, contentHash, now, now);
    db.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, score, relation, evidence_score,
         derivation_confidence, extractor_model, extractor_version,
         evidence_root_id, created_at
       ) VALUES (?, ?, ?, 'supports', 0.95, 'supports', 0.95, 0.95,
                 'seed', '1', ?, ?)`
    ).run(`${claimId}-source`, claimId, observationId, observationId, now);
    db.prepare(
      `INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
       VALUES (?, ?, 'supports', ?)`
    ).run(versionId, claimId, now);
  }
  db.prepare(
    `INSERT INTO sb_memory_merge_candidates (
       id, source_memory_id, target_memory_id, similarity,
       suggested_action, state, created_at
     ) VALUES (?, ?, ?, 0.94, 'merge', 'pending', ?)`
  ).run(input.id, `${input.id}-source`, `${input.id}-target`, now);
}

async function eligibleClaimIds(
  db: ReturnType<typeof createSelfhostEnv>["db"]
): Promise<string[]> {
  return (db.prepare(
    `SELECT m.id
     FROM sb_memories m
     JOIN entries e ON e.id = m.entry_id AND e.content_hash = m.content_hash
     WHERE ${activeMemoryClaimPredicate("m", String(Date.now()), { requireActiveParentLink: true })}
     ORDER BY m.id`
  ).all() as Array<{ id: string }>).map((row) => row.id);
}

describe("knowledge evolution", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("creates a refined claim backed by both immutable evidence roots", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, {
        id: "evolve-merge",
        sourceContent: "Singularity preserves raw observations.",
        targetContent: "Singularity refines claims without replacing evidence.",
      });
      const observationsBefore = db.prepare(
        `SELECT id, content, content_hash FROM sb_observations ORDER BY id`
      ).all();
      const reviewedAt = Date.now();
      const plan = await prepareMemoryKnowledgeEvolution(env.DB, {
        candidateId: "evolve-merge",
        aiReviewRunId: "run-merge",
        decision: "merge",
        refinementContent: "Singularity preserves raw observations while refining traceable claims.",
        decisionConfidence: 0.98,
        evidenceConfidence: 0.96,
        reviewedBy: "ai-review:system",
        reviewedAt,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE sb_memory_merge_candidates
           SET state = 'accepted', reviewed_by = ?, reviewed_at = ?
           WHERE id = ? AND state = 'pending'`
        ).bind("ai-review:system", reviewedAt, "evolve-merge"),
        ...plan.statements,
      ]);

      expect(db.prepare(
        `SELECT id, content, content_hash FROM sb_observations ORDER BY id`
      ).all()).toEqual(observationsBefore);
      const roots = db.prepare(
        `SELECT DISTINCT evidence_root_id
         FROM sb_memory_sources WHERE memory_id = ? ORDER BY evidence_root_id`
      ).all(plan.outputClaimId) as Array<{ evidence_root_id: string }>;
      expect(roots.map((row) => row.evidence_root_id)).toEqual([
        "evolve-merge-source-observation",
        "evolve-merge-target-observation",
      ]);
      expect(await eligibleClaimIds(db)).toEqual([plan.outputClaimId]);
    } finally {
      db.close();
    }
  });

  it("carries entity, fact, lineage, aggregate, and parent associations into a refined generation", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, {
        id: "evolve-linked",
        sourceContent: "Singularity links claims to durable evidence.",
        targetContent: "Singularity refines related knowledge into a new generation.",
      });
      await seedCandidate(db, {
        id: "evolve-neighbor",
        sourceContent: "Obsidian is the human knowledge workspace.",
        targetContent: "Obsidian projections remain traceable.",
      });
      const now = Date.now();
      db.prepare(
        `INSERT INTO sb_entities (
           id, name, name_normalized, entity_type, mention_count,
           lifecycle_state, created_at, updated_at
         ) VALUES ('entity-singularity', 'Singularity', 'singularity', 'project', 2,
                   'active', ?, ?)`
      ).run(now, now);
      for (const side of ["source", "target"] as const) {
        db.prepare(
          `INSERT INTO sb_memory_entities (id, memory_id, entity_id, role, score, created_at)
           VALUES (?, ?, 'entity-singularity', 'mentions', 0.98, ?)`
        ).run(`memory-entity-${side}`, `evolve-linked-${side}-claim`, now);
      }
      db.prepare(
        `INSERT INTO sb_entity_relations (
           id, from_entity_id, to_entity_id, relation_type, fact, evidence_count,
           memory_id, score, scope_id, polarity, modality, resolution_type,
           resolution_state, metadata_json, created_at
         ) VALUES (
           'fact-relation', 'entity-singularity', 'entity-singularity', 'preserves',
           'Singularity preserves evidence lineage', 2,
           'evolve-linked-source-claim', 0.98, 'project/singularity', 'positive',
           'asserted', 'supports', 'active', '{}', ?
         )`
      ).run(now);
      for (const side of ["source", "target"] as const) {
        db.prepare(
          `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
           VALUES (?, 'fact-relation', ?, ?, ?)`
        ).run(
          `fact-source-${side}`,
          `evolve-linked-${side}-claim`,
          `evolve-linked-${side}-observation`,
          now
        );
      }
      db.prepare(
        `INSERT INTO sb_knowledge_aggregates (
           id, aggregate_type, title, source_memory_ids_json, content,
           generated_at, created_at, updated_at
         ) VALUES ('aggregate-linked', 'project', 'Singularity', ?, 'Current state', ?, ?, ?)`
      ).run(JSON.stringify(["evolve-linked-source", "evolve-linked-target"]), now, now, now);
      await createAssociationEdge(env.DB, {
        source: "evolve-linked-source",
        target: "evolve-neighbor-source",
        edgeType: "part_of_project",
        provenance: "manual",
        weight: 0.9,
        metadata: { origin: "source" },
        createdAt: now,
      });
      await createAssociationEdge(env.DB, {
        source: "evolve-linked-target",
        target: "evolve-neighbor-source",
        edgeType: "part_of_project",
        provenance: "provider",
        weight: 0.6,
        metadata: { origin: "target" },
        createdAt: now,
      });

      const reviewedAt = now + 10;
      const plan = await prepareMemoryKnowledgeEvolution(env.DB, {
        candidateId: "evolve-linked",
        aiReviewRunId: "run-linked",
        decision: "merge",
        refinementContent: "Singularity refines related claims while preserving durable evidence lineage.",
        decisionConfidence: 0.99,
        evidenceConfidence: 0.98,
        reviewedBy: "ai-review:system",
        reviewedAt,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE sb_memory_merge_candidates
           SET state = 'accepted', reviewed_by = ?, reviewed_at = ?
           WHERE id = ? AND state = 'pending'`
        ).bind("ai-review:system", reviewedAt, "evolve-linked"),
        ...plan.statements,
      ]);

      expect(db.prepare(
        `SELECT entity_id FROM sb_memory_entities WHERE memory_id = ?`
      ).all(plan.outputClaimId)).toEqual([{ entity_id: "entity-singularity" }]);
      expect(db.prepare(
        `SELECT relation_id FROM sb_fact_sources WHERE memory_id = ?`
      ).all(plan.outputClaimId)).toEqual([{ relation_id: "fact-relation" }]);
      expect(db.prepare(
        `SELECT to_memory_id, relation_type
         FROM sb_memory_relations WHERE from_memory_id = ? ORDER BY to_memory_id`
      ).all(plan.outputEntryId)).toEqual([
        { to_memory_id: "evolve-linked-source", relation_type: "derived_from" },
        { to_memory_id: "evolve-linked-target", relation_type: "derived_from" },
      ]);
      expect(db.prepare(
        `SELECT stale_at FROM sb_knowledge_aggregates WHERE id = 'aggregate-linked'`
      ).get()).toEqual({ stale_at: reviewedAt });
      const outputParent = db.prepare(
        `SELECT pv.parent_id
         FROM sb_memories memory
         JOIN sb_parent_versions pv ON pv.version_id = memory.parent_version_id
         WHERE memory.id = ?`
      ).get(plan.outputClaimId) as { parent_id: string };
      const neighborParent = db.prepare(
        `SELECT pv.parent_id
         FROM sb_memories memory
         JOIN sb_parent_versions pv ON pv.version_id = memory.parent_version_id
         WHERE memory.id = 'evolve-neighbor-source-claim'`
      ).get() as { parent_id: string };
      const projectedAssociation = db.prepare(
        `SELECT edge_type, provenance, weight, metadata_json
         FROM sb_association_edges
         WHERE source_parent_id = ? AND target_parent_id = ?`
      ).get(outputParent.parent_id, neighborParent.parent_id) as {
        edge_type: string;
        provenance: string;
        weight: number;
        metadata_json: string;
      };
      expect(projectedAssociation).toMatchObject({
        edge_type: "part_of_project",
        provenance: "system",
        weight: 0.9,
      });
      const associationMetadata = JSON.parse(projectedAssociation.metadata_json) as {
        sourceEdges: Array<{ provenance: string; weight: number; metadata: { origin: string } }>;
      };
      expect(associationMetadata.sourceEdges).toEqual(expect.arrayContaining([
        expect.objectContaining({ provenance: "manual", weight: 0.9, metadata: { origin: "source" } }),
        expect.objectContaining({ provenance: "provider", weight: 0.6, metadata: { origin: "target" } }),
      ]));

      await rollbackKnowledgeEvolution(env.DB, {
        evolutionId: plan.evolutionId,
        actorId: "owner",
        reason: "verify reversible projections",
        rolledBackAt: reviewedAt + 10,
      });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_memory_entities WHERE id LIKE ?`
      ).get(`knowledge-evolution:${plan.evolutionId}:%`)).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_fact_sources WHERE id LIKE ?`
      ).get(`knowledge-evolution:${plan.evolutionId}:%`)).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_memory_relations WHERE id LIKE ?`
      ).get(`knowledge-evolution:${plan.evolutionId}:%`)).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_association_edges WHERE id LIKE ?`
      ).get(`knowledge-evolution:${plan.evolutionId}:%`)).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT stale_at FROM sb_knowledge_aggregates WHERE id = 'aggregate-linked'`
      ).get()).toEqual({ stale_at: null });
      expect(db.prepare(
        `SELECT COUNT(*) AS count
         FROM sb_association_edges
         WHERE deleted_at IS NULL AND edge_type = 'part_of_project'
           AND (source_parent_id IN (?, ?) OR target_parent_id IN (?, ?))`
      ).get(
        "evolve-linked-source-parent",
        "evolve-linked-target-parent",
        "evolve-linked-source-parent",
        "evolve-linked-target-parent"
      )).toEqual({ count: 2 });
      expect(await eligibleClaimIds(db)).toContain("evolve-linked-source-claim");
    } finally {
      db.close();
    }
  });

  it("reactivates a soft-deleted keep-separate association and restores it on rollback", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, {
        id: "evolve-soft-edge",
        sourceContent: "Source and target remain independently useful.",
        targetContent: "Target and source remain independently useful.",
      });
      const now = Date.now();
      const original = await createAssociationEdge(env.DB, {
        source: "evolve-soft-edge-source",
        target: "evolve-soft-edge-target",
        edgeType: "related_to",
        provenance: "manual",
        weight: 0.7,
        metadata: { origin: "manual" },
        createdAt: now,
      });
      await deleteAssociationEdge(env.DB, {
        source: "evolve-soft-edge-source",
        target: "evolve-soft-edge-target",
        edgeType: "related_to",
        asOf: now + 1,
      });

      const reviewedAt = now + 2;
      const plan = await prepareMemoryKnowledgeEvolution(env.DB, {
        candidateId: "evolve-soft-edge",
        aiReviewRunId: "run-soft-edge",
        decision: "keep_both",
        refinementContent: null,
        decisionConfidence: 0.96,
        evidenceConfidence: 0.95,
        reviewedBy: "ai-review:system",
        reviewedAt,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE sb_memory_merge_candidates
           SET state = 'rejected', reviewed_by = ?, reviewed_at = ?
           WHERE id = ? AND state = 'pending'`
        ).bind("ai-review:system", reviewedAt, "evolve-soft-edge"),
        ...plan.statements,
      ]);

      expect(db.prepare(
        `SELECT deleted_at, provenance FROM sb_association_edges
         WHERE source_parent_id = ? AND target_parent_id = ? AND edge_type = 'related_to'`
      ).get("evolve-soft-edge-source-parent", "evolve-soft-edge-target-parent")).toEqual({
        deleted_at: null,
        provenance: "system",
      });

      await rollbackKnowledgeEvolution(env.DB, {
        evolutionId: plan.evolutionId,
        actorId: "owner",
        reason: "restore prior association state",
        rolledBackAt: now + 3,
      });
      expect(db.prepare(
        `SELECT id, deleted_at, provenance, metadata_json FROM sb_association_edges
         WHERE source_parent_id = ? AND target_parent_id = ? AND edge_type = 'related_to'`
      ).get("evolve-soft-edge-source-parent", "evolve-soft-edge-target-parent")).toEqual({
        id: original.id,
        deleted_at: now + 1,
        provenance: "manual",
        metadata_json: JSON.stringify({ origin: "manual" }),
      });
    } finally {
      db.close();
    }
  });

  it("rolls back the projection without deleting raw evidence or source claims", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, {
        id: "evolve-rollback",
        sourceContent: "The source claim remains traceable.",
        targetContent: "The target claim remains traceable.",
      });
      const reviewedAt = Date.now();
      const plan = await prepareMemoryKnowledgeEvolution(env.DB, {
        candidateId: "evolve-rollback",
        aiReviewRunId: "run-rollback",
        decision: "merge",
        refinementContent: "Both source claims remain traceable after refinement.",
        decisionConfidence: 0.98,
        evidenceConfidence: 0.96,
        reviewedBy: "ai-review:system",
        reviewedAt,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE sb_memory_merge_candidates
           SET state = 'accepted', reviewed_by = ?, reviewed_at = ?
           WHERE id = ? AND state = 'pending'`
        ).bind("ai-review:system", reviewedAt, "evolve-rollback"),
        ...plan.statements,
      ]);

      await rollbackKnowledgeEvolution(env.DB, {
        evolutionId: plan.evolutionId,
        actorId: "owner",
        reason: "verification rollback",
      });

      expect(await eligibleClaimIds(db)).toEqual([
        "evolve-rollback-source-claim",
        "evolve-rollback-target-claim",
      ]);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM sb_observations`).get())
        .toEqual({ count: 2 });
      expect(db.prepare(
        `SELECT state FROM sb_knowledge_evolutions WHERE id = ?`
      ).get(plan.evolutionId)).toEqual({ state: "rolled_back" });
    } finally {
      db.close();
    }
  });

  it("blocks ancestor rollback while a later active evolution retains its output", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, {
        id: "evolve-parent",
        sourceContent: "The first source remains traceable.",
        targetContent: "The second source remains traceable.",
      });
      const parentReviewedAt = Date.now();
      const parent = await prepareMemoryKnowledgeEvolution(env.DB, {
        candidateId: "evolve-parent",
        aiReviewRunId: "run-parent",
        decision: "merge",
        refinementContent: "Both original sources remain traceable.",
        decisionConfidence: 0.98,
        evidenceConfidence: 0.96,
        reviewedBy: "ai-review:system",
        reviewedAt: parentReviewedAt,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE sb_memory_merge_candidates
           SET state = 'accepted', reviewed_by = ?, reviewed_at = ?
           WHERE id = ? AND state = 'pending'`
        ).bind("ai-review:system", parentReviewedAt, "evolve-parent"),
        ...parent.statements,
      ]);

      await seedCandidate(db, {
        id: "evolve-child",
        sourceContent: "Unused child seed source.",
        targetContent: "A distinct fact should remain separate.",
      });
      db.prepare(
        `UPDATE sb_memory_merge_candidates SET source_memory_id = ? WHERE id = ?`
      ).run(parent.outputEntryId, "evolve-child");
      const childReviewedAt = parentReviewedAt + 1;
      const child = await prepareMemoryKnowledgeEvolution(env.DB, {
        candidateId: "evolve-child",
        aiReviewRunId: "run-child",
        decision: "keep_both",
        refinementContent: null,
        decisionConfidence: 0.92,
        evidenceConfidence: 0.9,
        reviewedBy: "ai-review:system",
        reviewedAt: childReviewedAt,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE sb_memory_merge_candidates
           SET state = 'rejected', reviewed_by = ?, reviewed_at = ?
           WHERE id = ? AND state = 'pending'`
        ).bind("ai-review:system", childReviewedAt, "evolve-child"),
        ...child.statements,
      ]);

      await expect(rollbackKnowledgeEvolution(env.DB, {
        evolutionId: parent.evolutionId,
        actorId: "owner",
        reason: "must not invalidate an active descendant",
      })).rejects.toThrow("knowledge_evolution_has_active_descendant");
    } finally {
      db.close();
    }
  });

  it("removes consolidation provenance when a duplicate evolution is rolled back", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, {
        id: "evolve-duplicate",
        sourceContent: "The same fact was recorded twice.",
        targetContent: "The same fact was recorded twice.",
      });
      const targetClaimId = "evolve-duplicate-target-claim";
      const countSources = () => Number((db.prepare(
        `SELECT COUNT(*) AS count FROM sb_memory_sources WHERE memory_id = ?`
      ).get(targetClaimId) as { count: number }).count);
      expect(countSources()).toBe(1);

      const reviewedAt = Date.now();
      const plan = await prepareMemoryKnowledgeEvolution(env.DB, {
        candidateId: "evolve-duplicate",
        aiReviewRunId: "run-duplicate",
        decision: "duplicate",
        refinementContent: null,
        decisionConfidence: 1,
        evidenceConfidence: 1,
        reviewedBy: "ai-review:system",
        reviewedAt,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE sb_memory_merge_candidates
           SET state = 'accepted', reviewed_by = ?, reviewed_at = ?
           WHERE id = ? AND state = 'pending'`
        ).bind("ai-review:system", reviewedAt, "evolve-duplicate"),
        ...plan.statements,
      ]);
      expect(countSources()).toBe(2);

      await rollbackKnowledgeEvolution(env.DB, {
        evolutionId: plan.evolutionId,
        actorId: "owner",
        reason: "restore pre-consolidation provenance",
      });

      expect(countSources()).toBe(1);
      expect(await eligibleClaimIds(db)).toEqual([
        "evolve-duplicate-source-claim",
        "evolve-duplicate-target-claim",
      ]);
    } finally {
      db.close();
    }
  });
});
