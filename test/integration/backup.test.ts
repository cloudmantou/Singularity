import { describe, expect, it } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { ensureAssociationDataModel } from "../../src/memory/associations";
import { ensureAIReviewDataModel } from "../../src/memory/ai-review";
import { exportMemoryBackup, importMemoryBackup } from "../../src/memory/backup";
import { ensureEntityResolutionDataModel } from "../../src/memory/entities";
import {
  acquireAuditImportLock,
  prepareComplianceAuditEvent,
  releaseAuditImportLock,
} from "../../src/memory/quality";
import { createExecutionContext, createSelfhostEnv } from "../../src/selfhost/env";

function auth(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
  });
}

describe("full memory backup import/export", () => {
  it("rejects an applied AI review without an immutable application receipt before import", async () => {
    const source = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    const target = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(source.env);
      await initializeDatabase(target.env);
      const backup = await exportMemoryBackup(source.env.DB, { source: "test" });
      const now = Date.now();
      const manifest = JSON.stringify({
        objectType: "memory_merge_candidate",
        objectId: "candidate-missing-receipt",
        state: "accepted",
        evidence: [],
        policyInput: {},
      });
      const invalid = {
        ...backup,
        aiReviewJobs: [{
          id: "job-missing-receipt",
          object_type: "memory_merge_candidate",
          object_id: "candidate-missing-receipt",
          mode: "suggest",
          status: "applied",
          requested_by: "owner",
          input_snapshot_hash: "snapshot-hash",
          input_snapshot_json: manifest,
          run_id: "run-missing-receipt",
          created_at: now,
        }],
        aiReviewRuns: [{
          id: "run-missing-receipt",
          job_id: "job-missing-receipt",
          object_type: "memory_merge_candidate",
          object_id: "candidate-missing-receipt",
          mode: "suggest",
          decision: "duplicate",
          reason: "invalid fixture",
          evidence_refs_json: '["SOURCE","TARGET"]',
          confidence_json: "{}",
          reviewability: "sufficient",
          missing_context_json: "[]",
          key_differences_json: JSON.stringify([{
            dimension: "content",
            status: "same",
            summary: "The normalized content is identical.",
            evidenceRefs: ["SOURCE", "TARGET"],
          }]),
          reviewer_provider: "test",
          reviewer_model: "reviewer",
          prompt_version: "v1",
          input_snapshot_hash: "snapshot-hash",
          input_snapshot_json: manifest,
          created_at: now,
        }],
        aiReviewApplications: [],
      };

      await expect(importMemoryBackup(
        target.env.DB,
        invalid as unknown as Record<string, unknown>,
        { atomic: true }
      )).rejects.toThrow(/applied AI review.*receipt/i);
      expect(target.db.prepare(`SELECT COUNT(*) AS count FROM entries`).get())
        .toEqual({ count: 0 });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a v17 AI review that makes a decision from incomplete context before import", async () => {
    const source = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    const target = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(source.env);
      await initializeDatabase(target.env);
      const backup = await exportMemoryBackup(source.env.DB, { source: "test" });
      const now = Date.now();
      const manifest = JSON.stringify({
        objectType: "memory_merge_candidate",
        objectId: "candidate-forced",
        state: "pending",
        evidence: [],
        policyInput: {},
      });
      const invalid = {
        ...backup,
        aiReviewJobs: [{
          id: "job-forced",
          object_type: "memory_merge_candidate",
          object_id: "candidate-forced",
          mode: "suggest",
          status: "completed",
          requested_by: "owner",
          input_snapshot_hash: "snapshot-hash",
          input_snapshot_json: manifest,
          run_id: "run-forced",
          created_at: now,
        }],
        aiReviewRuns: [{
          id: "run-forced",
          job_id: "job-forced",
          object_type: "memory_merge_candidate",
          object_id: "candidate-forced",
          mode: "suggest",
          decision: "duplicate",
          reason: "forced decision",
          evidence_refs_json: "[]",
          confidence_json: "{}",
          reviewability: "partial",
          missing_context_json: '["scope_context"]',
          key_differences_json: "[]",
          abstained: 0,
          reviewer_provider: "test",
          reviewer_model: "reviewer",
          prompt_version: "knowledge-review-v2",
          input_snapshot_hash: "snapshot-hash",
          input_snapshot_json: manifest,
          created_at: now,
        }],
        aiReviewApplications: [],
      };

      await expect(importMemoryBackup(
        target.env.DB,
        invalid as unknown as Record<string, unknown>,
        { atomic: true }
      )).rejects.toThrow(/incomplete AI review context/i);
      expect(target.db.prepare(`SELECT COUNT(*) AS count FROM entries`).get())
        .toEqual({ count: 0 });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects a v17 applyable AI review without evidence-bound differences before import", async () => {
    const source = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    const target = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(source.env);
      await initializeDatabase(target.env);
      const backup = await exportMemoryBackup(source.env.DB, { source: "test" });
      const now = Date.now();
      const manifest = JSON.stringify({
        objectType: "memory_merge_candidate",
        objectId: "candidate-unbound",
        state: "pending",
        evidence: [],
        policyInput: {},
      });
      const invalid = {
        ...backup,
        aiReviewJobs: [{
          id: "job-unbound",
          object_type: "memory_merge_candidate",
          object_id: "candidate-unbound",
          mode: "suggest",
          status: "completed",
          requested_by: "owner",
          input_snapshot_hash: "snapshot-hash",
          input_snapshot_json: manifest,
          run_id: "run-unbound",
          created_at: now,
        }],
        aiReviewRuns: [{
          id: "run-unbound",
          job_id: "job-unbound",
          object_type: "memory_merge_candidate",
          object_id: "candidate-unbound",
          mode: "suggest",
          decision: "duplicate",
          reason: "unbound decision",
          evidence_refs_json: "[]",
          confidence_json: "{}",
          reviewability: "sufficient",
          missing_context_json: "[]",
          key_differences_json: "[]",
          abstained: 0,
          reviewer_provider: "test",
          reviewer_model: "reviewer",
          prompt_version: "knowledge-review-v3",
          input_snapshot_hash: "snapshot-hash",
          input_snapshot_json: manifest,
          created_at: now,
        }],
        aiReviewApplications: [],
      };

      await expect(importMemoryBackup(
        target.env.DB,
        invalid as unknown as Record<string, unknown>,
        { atomic: true }
      )).rejects.toThrow(/evidence references and key differences/i);
      expect(target.db.prepare(`SELECT COUNT(*) AS count FROM entries`).get())
        .toEqual({ count: 0 });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("round-trips immutable AI review manifests and application receipts", async () => {
    const source = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    const target = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(source.env);
      await initializeDatabase(target.env);
      await ensureAIReviewDataModel(source.env.DB);
      const now = Date.now();
      const manifest = JSON.stringify({
        objectType: "memory_merge_candidate",
        objectId: "candidate-1",
        state: "pending",
        evidence: [{ ref: "SOURCE", evidenceHash: "hash-1", scopeIds: ["scope-1"], vaultIds: ["vault-1"] }],
        policyInput: { suggestedAction: "duplicate" },
      });
      source.db.prepare(
        `INSERT INTO sb_ai_review_jobs (
           id, object_type, object_id, mode, status, requested_by,
           input_snapshot_hash, input_snapshot_json, run_id, created_at, completed_at
         ) VALUES ('job-1', 'memory_merge_candidate', 'candidate-1', 'suggest', 'applied',
                   'owner', 'snapshot-hash', ?, 'run-1', ?, ?)`
      ).run(manifest, now, now);
      source.db.prepare(
        `INSERT INTO sb_ai_review_runs (
           id, job_id, object_type, object_id, mode, decision, reason,
           evidence_refs_json, confidence_json, reviewability,
           missing_context_json, key_differences_json, abstained, requires_human,
           auto_apply_eligible, reviewer_provider, reviewer_model, prompt_version,
           input_snapshot_hash, input_snapshot_json, created_at
         ) VALUES ('run-1', 'job-1', 'memory_merge_candidate', 'candidate-1', 'suggest',
                   'duplicate', 'Exact evidence match', '["SOURCE"]',
                   '{"decision":1,"evidence":1}', 'sufficient', '[]',
                   '[{"dimension":"content","status":"same","summary":"No material difference","evidenceRefs":["SOURCE"]}]',
                   0, 1, 0, 'test', 'reviewer-v1',
                   'knowledge-review-v2', 'snapshot-hash', ?, ?)`
      ).run(manifest, now);
      source.db.prepare(
        `INSERT INTO sb_ai_review_applications (
           id, run_id, object_type, object_id, decision, applied_by,
           application_mode, created_at
         ) VALUES ('application-1', 'run-1', 'memory_merge_candidate', 'candidate-1',
                   'duplicate', 'owner', 'human', ?)`
      ).run(now);

      const backup = await exportMemoryBackup(source.env.DB, { source: "test" });
      expect(backup.schemaVersion).toBe(17);
      expect(backup.totals).toMatchObject({
        aiReviewJobs: 1,
        aiReviewRuns: 1,
        aiReviewApplications: 1,
      });
      expect(JSON.stringify(backup.aiReviewRuns)).not.toContain("private source text");
      expect(backup.aiReviewRuns[0]).toMatchObject({
        reviewability: "sufficient",
        missing_context_json: "[]",
      });

      const imported = await importMemoryBackup(
        target.env.DB,
        backup as unknown as Record<string, unknown>,
        { atomic: true }
      );
      expect(imported.graph.aiReviewJobs.imported).toBe(1);
      expect(imported.graph.aiReviewRuns.imported).toBe(1);
      expect(imported.graph.aiReviewApplications.imported).toBe(1);
      expect(target.db.prepare(
        `SELECT status, lease_owner FROM sb_ai_review_jobs WHERE id = 'job-1'`
      ).get()).toEqual({ status: "applied", lease_owner: null });
      expect(target.db.prepare(
        `SELECT decision, application_mode FROM sb_ai_review_applications WHERE id = 'application-1'`
      ).get()).toEqual({ decision: "duplicate", application_mode: "human" });
      expect(target.db.prepare(
        `SELECT reviewability, missing_context_json FROM sb_ai_review_runs WHERE id = 'run-1'`
      ).get()).toEqual({ reviewability: "sufficient", missing_context_json: "[]" });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("restores audit events in chain order and rejects silent chain merges", async () => {
    const source = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    const target = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(source.env);
      await initializeDatabase(target.env);

      const first = await prepareComplianceAuditEvent(source.env.DB, {
        actorType: "system",
        action: "first",
        objectType: "memory",
        occurredAt: 100,
      });
      await first.statement.run();
      const second = await prepareComplianceAuditEvent(source.env.DB, {
        actorType: "system",
        action: "second",
        objectType: "memory",
        occurredAt: 300,
      });
      await second.statement.run();
      const backup = await exportMemoryBackup(source.env.DB, { source: "test" });

      await importMemoryBackup(target.env.DB, backup as unknown as Record<string, unknown>);
      expect(target.db.prepare(
        `SELECT event_hash FROM sb_audit_chain_head WHERE id = 1`
      ).get()).toEqual({ event_hash: second.record.event_hash });

      const third = await prepareComplianceAuditEvent(source.env.DB, {
        actorType: "system",
        action: "third",
        objectType: "memory",
        occurredAt: 400,
      });
      await third.statement.run();
      await importMemoryBackup(target.env.DB, {
        backupFormat: "singularity-memory-backup",
        schemaVersion: 15,
        auditEvents: [third.record],
      }, { auditMode: "append_verified" });
      expect(target.db.prepare(`SELECT COUNT(*) AS count FROM sb_audit_events`).get()).toEqual({ count: 3 });

      await expect(importMemoryBackup(target.env.DB, {
        backupFormat: "singularity-memory-backup",
        schemaVersion: 15,
        auditEvents: [first.record],
      })).rejects.toThrow("audit_import_requires_append_verified");

      const fourth = await prepareComplianceAuditEvent(source.env.DB, {
        actorType: "system",
        action: "fourth",
        objectType: "memory",
        occurredAt: 500,
      });
      await fourth.statement.run();
      const completeBackup = await exportMemoryBackup(source.env.DB, { source: "test" });
      await importMemoryBackup(target.env.DB, completeBackup as unknown as Record<string, unknown>, {
        auditMode: "append_verified",
      });
      expect(target.db.prepare(`SELECT COUNT(*) AS count FROM sb_audit_events`).get()).toEqual({ count: 4 });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rejects tampered audit event bodies before importing business rows", async () => {
    const source = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    const target = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(source.env);
      await initializeDatabase(target.env);
      const event = await prepareComplianceAuditEvent(source.env.DB, {
        actorType: "system",
        action: "original",
        objectType: "memory",
      });
      await event.statement.run();
      const backup = await exportMemoryBackup(source.env.DB, { source: "test" });
      const tampered = {
        ...backup,
        entries: [{ id: "must-not-import", content: "business row" }],
        auditEvents: backup.auditEvents.map((row) => ({ ...row, action: "tampered" })),
      };

      await expect(importMemoryBackup(
        target.env.DB,
        tampered as unknown as Record<string, unknown>
      )).rejects.toThrow("audit_event_hash_mismatch");
      expect(target.db.prepare(`SELECT COUNT(*) AS count FROM entries`).get()).toEqual({ count: 0 });
      expect(target.db.prepare(`SELECT COUNT(*) AS count FROM sb_audit_events`).get()).toEqual({ count: 0 });
    } finally {
      source.db.close();
      target.db.close();
    }
  });

  it("rolls back a self-host restore when a later graph table fails", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(env);
    try {
      await expect(importMemoryBackup(env.DB, {
        backupFormat: "singularity-memory-backup",
        schemaVersion: 15,
        entries: [{ id: "rollback-entry", content: "must roll back" }],
        scopes: [{ scope_id: "broken-scope" }],
      }, { atomic: true })).rejects.toThrow("canonical_name is required");
      expect(db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE id = 'rollback-entry'`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("does not advertise separate-chain restore as implemented", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(env);
    try {
      const event = await prepareComplianceAuditEvent(env.DB, {
        actorType: "system",
        action: "chain",
        objectType: "memory",
      });
      await event.statement.run();
      const backup = await exportMemoryBackup(env.DB, { source: "test" });
      await expect(importMemoryBackup(
        env.DB,
        backup as unknown as Record<string, unknown>,
        { auditMode: "separate_chain" }
      )).rejects.toThrow("audit_separate_chain_not_implemented");
    } finally {
      db.close();
    }
  });

  it("serializes all backup imports while an audit restore is active", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(env);
    await acquireAuditImportLock(env.DB, "restore-owner", Date.now());
    try {
      await expect(importMemoryBackup(env.DB, {
        backupFormat: "singularity-memory-backup",
        schemaVersion: 15,
        entries: [],
      })).rejects.toThrow("audit_import_in_progress");
      expect(db.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 0 });
    } finally {
      await releaseAuditImportLock(env.DB, "restore-owner");
      db.close();
    }
  });

  it("exports and restores four-layer memory graph data with integrity checks", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(env);
    await ensureEntityResolutionDataModel(env.DB);
    await ensureAssociationDataModel(env.DB);
    const now = Date.now();

    db.prepare(
      `INSERT INTO entries
       (id, content, tags, source, created_at, vector_ids, recall_count,
        importance_score, classification_confidence, classification_status,
        classification_error, classification_attempts, classification_next_attempt_at,
        classification_started_at, classification_version, classified_at,
        contradiction_wins, contradiction_losses, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "entry-1",
      "Singularity uses SQLite",
      '["work","kind:semantic"]',
      "api",
      now - 2000,
      '["entry-1"]',
      2,
      4,
      0.92,
      "succeeded",
      null,
      1,
      null,
      null,
      2,
      now - 1000,
      0,
      0,
      "hash-entry-1"
    );
    db.prepare(
      `INSERT INTO entries
       (id, content, tags, source, created_at, vector_ids, recall_count,
        importance_score, classification_status, classification_attempts,
        classification_version, contradiction_wins, contradiction_losses, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "entry-2",
      "SQLite supports local storage",
      '["work"]',
      "api",
      now - 1000,
      "[]",
      0,
      3,
      "pending",
      0,
      1,
      0,
      0,
      "hash-entry-2"
    );
    db.prepare(
      `INSERT INTO sb_observations
       (id, content, source, metadata_json, content_hash,
        source_channel, source_identity, author_type, source_uri,
        source_timestamp, revision, root_evidence_id, previous_evidence_id,
        extraction_status, extraction_version, extraction_attempts, extraction_error,
        next_attempt_at, processing_started_at, processed_at, needs_reprocess, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "obs-1",
      "Singularity uses SQLite",
      "api",
      JSON.stringify({
        parent_id: "parent-1",
        parent_version_id: "parent-version-1",
        parent_version_number: 1,
        evidence_root_id: "evidence-root-1",
      }),
      "hash-entry-1",
      "api",
      "api:obs-1",
      "user",
      "memory://obs-1",
      now - 2000,
      1,
      "evidence-root-1",
      null,
      "succeeded",
      1,
      1,
      null,
      null,
      null,
      now,
      0,
      now - 2000
    );
    db.prepare(
      `INSERT INTO sb_scopes
       (scope_id, parent_scope_id, canonical_name, aliases_json, scope_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("scope-1", null, "Singularity", '["singularity"]', "project", now - 2000, now);
    db.prepare(
      `INSERT INTO sb_parent_units
       (parent_id, active_version_id, scope_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("parent-1", "parent-version-1", "scope-1", now - 2000, now);
    db.prepare(
      `INSERT INTO sb_parent_units
       (parent_id, active_version_id, scope_id, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?)`
    ).run("parent-2", "scope-1", now - 1000, now);
    db.prepare(
      `INSERT INTO sb_association_edges (
         id, source_parent_id, target_parent_id, edge_type, weight,
         provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "association-1",
      "parent-1",
      "parent-2",
      "part_of_project",
      0.8,
      "manual",
      "{}",
      1,
      now - 500,
      now + 500,
      null,
      now - 500,
      now - 500
    );
    db.prepare(
      `INSERT INTO sb_association_edge_history (
         id, source_parent_id, target_parent_id, edge_type, weight,
         provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "association-history-1",
      "parent-1",
      "parent-2",
      "references",
      0.6,
      "manual",
      "{}",
      1,
      now - 2000,
      null,
      now - 1000,
      now - 2000,
      now - 1000
    );
    db.prepare(
      `INSERT INTO sb_parent_versions
       (version_id, parent_id, version_number, source_observation_id,
        source_snapshot_hash, tags_snapshot_json, source_snapshot,
        vault_snapshot, metadata_snapshot_hash, summary, state, summary_vector_ids,
        activated_at, superseded_at, activation_time_source,
        superseded_time_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "parent-version-1", "parent-1", 1, "obs-1", "hash-entry-1",
      '["database"]', "obsidian", "vault-a", "snapshot-hash",
      "Singularity uses SQLite", "active", "[]", now - 1500, null,
      "recorded", null, now - 2000, now
    );
    db.prepare(
      `INSERT INTO sb_memories
       (id, content, kind, memory_class, importance, confidence, entry_id,
        parent_version_id, claim_subject, claim_predicate, claim_object,
        scope_id, polarity, modality, claim_status, scores_json,
        content_hash, observed_at, valid_from, valid_to, reference_time,
        invalid_at, expired_at, entities_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "mem-1",
      "Singularity uses SQLite",
      "semantic",
      "fact",
      4,
      0.92,
      "entry-1",
      "parent-version-1",
      "Singularity",
      "uses_storage",
      "SQLite",
      "scope-1",
      "positive",
      "confirmed",
      "confirmed",
      JSON.stringify({
        relevance: 0.9,
        evidenceQuality: 0.95,
        derivationConfidence: 0.92,
        conflictState: "none",
      }),
      "hash-entry-1",
      now - 2000,
      null,
      null,
      now - 2000,
      null,
      null,
      "[]",
      now - 2000
    );
    db.prepare(
      `INSERT INTO sb_parent_version_claims
       (parent_version_id, memory_id, relation, created_at)
       VALUES (?, ?, ?, ?)`
    ).run("parent-version-1", "mem-1", "supports", now - 2000);
    db.prepare(
      `INSERT INTO sb_memory_sources
       (id, memory_id, observation_id, role, score, relation, extract_span,
        evidence_score, derivation_confidence, extractor_model,
        extractor_version, evidence_root_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("source-1", "mem-1", "obs-1", "derived_from", 0.92, "supports", "{\"start\":0,\"end\":24}", 0.95, 0.92, "test-extractor", "1", "evidence-root-1", now - 2000);
    db.prepare(
      `INSERT INTO sb_entities
       (id, name, name_normalized, entity_type, aliases_json, metadata_json,
        mention_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("entity-1", "Singularity", "singularity", "project", "[]", "{}", 1, now - 2000, now);
    db.prepare(
      `INSERT INTO sb_entities
       (id, name, name_normalized, entity_type, aliases_json, metadata_json,
        mention_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("entity-2", "SQLite", "sqlite", "product", "[]", "{}", 1, now - 2000, now);
    db.prepare(
      `INSERT INTO sb_entity_aliases
       (id, entity_id, alias, alias_normalized, source_observation_id,
        confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("alias-1", "entity-1", "SB", "sb", "obs-1", 1, now - 2000, now);
    db.prepare(
      `INSERT INTO sb_entity_alias_sources
       (id, alias_id, observation_id, relation, created_at)
       VALUES (?, ?, ?, 'supports', ?)`
    ).run("alias-source-1", "alias-1", "obs-1", now);
    db.prepare(
      `INSERT INTO sb_entity_external_ids
       (id, entity_id, provider, external_id, source_observation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("external-1", "entity-1", "github", "cloudmantou/Singularity", "obs-1", now - 2000, now);
    db.prepare(
      `INSERT INTO sb_entity_external_id_sources
       (id, external_id_id, observation_id, relation, created_at)
       VALUES (?, ?, ?, 'supports', ?)`
    ).run("external-source-1", "external-1", "obs-1", now);
    db.prepare(
      `INSERT INTO sb_entity_embeddings
       (entity_id, embedding_fingerprint, embedding_json, dimensions, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("entity-1", "test-v1", "[1,0]", 2, now);
    db.prepare(
      `INSERT INTO sb_entity_merge_candidates
       (id, source_entity_id, target_entity_id, matched_by, score, reason_json,
        state, source_observation_id, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`
    ).run("entity-candidate-1", "entity-2", "entity-1", "semantic", 0.9, "[]", "obs-1", now, now);
    db.prepare(
      `INSERT INTO sb_entity_merge_history
       (id, source_entity_id, target_entity_id, candidate_id, actor_type,
        reason, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("entity-history-1", "entity-2", "entity-1", "entity-candidate-1", "user", "reviewed", "{}", now);
    db.prepare(
      `INSERT INTO sb_memory_entities
       (id, memory_id, entity_id, role, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("mem-entity-1", "mem-1", "entity-1", "mentions", 0.9, now - 2000);
    db.prepare(
      `INSERT INTO sb_entity_relations
       (id, from_entity_id, to_entity_id, relation_type, fact, memory_id,
        observation_id, score, valid_from, valid_to, invalid_at, expired_at,
        reference_time, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("fact-1", "entity-1", "entity-2", "uses", "Singularity uses SQLite", "mem-1", "obs-1", 0.91, null, null, null, null, now - 2000, "{}", now - 2000);
    db.prepare(
      `INSERT INTO sb_fact_sources
       (id, relation_id, memory_id, observation_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("fact-source-1", "fact-1", "mem-1", "obs-1", now - 2000);
    db.prepare(
      `INSERT INTO sb_fact_resolutions
       (id, relation_id, target_relation_id, resolution_type, confidence,
        reason_codes_json, requires_review, applied_invalidation,
        source_memory_id, target_memory_id, created_at)
       VALUES (?, ?, NULL, 'supports', 0.91, '[]', 0, 0, ?, NULL, ?)`
    ).run("fact-resolution-1", "fact-1", "mem-1", now - 2000);
    db.prepare(
      `INSERT INTO sb_memory_relations
       (id, from_memory_id, to_memory_id, relation_type, score, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("relation-1", "entry-1", "entry-2", "supports", 0.8, "{}", now - 1000);
    db.prepare(
      `INSERT INTO sb_memory_revisions
       (id, memory_id, event_type, old_content, new_content,
        old_metadata_json, new_metadata_json, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("revision-1", "entry-1", "ADD", null, "Singularity uses SQLite", null, "{}", null, "api", now - 2000);
    db.prepare(
      `INSERT INTO sb_conflict_cases (
         id, old_memory_id, new_memory_id, old_claim_id, new_claim_id,
         conflict_type, state, created_at
       ) VALUES (?, ?, ?, ?, NULL, 'fact_resolution', 'pending', ?)`
    ).run("conflict-1", "entry-1", "entry-2", "mem-1", now - 500);
    db.prepare(
      `INSERT INTO sb_memory_mutations (
         mutation_id, idempotency_key, source_channel, operation, entry_id,
         request_hash, state, result_content, result_content_hash,
         result_vector_count, observation_id, claim_id, warnings_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'update', ?, ?, 'completed', ?, ?, 1, ?, ?, '[]', ?, ?)`
    ).run(
      "mutation-1",
      "request-1",
      "api",
      "entry-1",
      "request-hash-1",
      "Singularity uses SQLite",
      "hash-1",
      "obs-1",
      "mem-1",
      now - 1000,
      now - 500
    );

    const exportResponse = await worker.fetch(auth("/export?full=true"), env, createExecutionContext());
    expect(exportResponse.status).toBe(200);
    const backup = await exportResponse.json() as any;

    expect(backup.backupFormat).toBe("singularity-memory-backup");
    expect(backup.schemaVersion).toBe(17);
    expect(backup.features).toEqual(
      expect.arrayContaining([
        "atomic-memory",
        "temporal-facts",
        "fact-sources",
        "embedding-fingerprints",
        "evidence-claim-provenance",
        "parent-versions",
        "parent-version-claims",
        "parent-version-time-windows",
        "parent-version-metadata-snapshots",
        "entity-resolution",
        "entity-merge-execution",
        "fact-resolution",
        "claim-level-conflicts",
        "association-graph",
        "entry-mutation-journal",
        "ai-assisted-quality-review",
      ])
    );
    expect(backup.features).not.toContain("vector-rebuild-state");
    expect(backup.entries[0]).not.toHaveProperty("pending_rebuild_id");
    expect(backup.integrity.ok).toBe(true);
    expect(backup.totals).toMatchObject({
      scopes: 1,
      parentUnits: 2,
      parentVersions: 1,
      parentVersionClaims: 1,
      memoryMutations: 1,
      associationEdges: 1,
      associationEdgeHistory: 1,
      entries: 2,
      observations: 1,
      memories: 1,
      memorySources: 1,
      entities: 2,
      entityAliases: 1,
      entityAliasSources: 1,
      entityExternalIds: 1,
      entityExternalIdSources: 1,
      entityEmbeddings: 1,
      entityMergeCandidates: 1,
      entityMergeHistory: 1,
      memoryEntities: 1,
      entityRelations: 1,
      factResolutions: 1,
      factSources: 1,
      memoryRelations: 1,
      revisions: 1,
      conflictCases: 1,
    });
    expect(backup.scopes[0]).toMatchObject({ scope_id: "scope-1" });
    expect(backup.parentUnits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parent_id: "parent-1",
        active_version_id: "parent-version-1",
      }),
    ]));
    expect(backup.parentVersions[0]).toMatchObject({
      version_id: "parent-version-1",
      state: "active",
      activated_at: now - 1500,
      superseded_at: null,
      activation_time_source: "recorded",
      superseded_time_source: null,
    });
    expect(backup.parentVersionClaims[0]).toMatchObject({
      parent_version_id: "parent-version-1",
      memory_id: "mem-1",
      relation: "supports",
    });
    expect(backup.memoryMutations[0]).toMatchObject({
      mutation_id: "mutation-1",
      state: "completed",
      entry_id: "entry-1",
      claim_id: "mem-1",
    });
    expect(backup.memoryMutationBackupMode).toBe("audit_only");
    expect(backup.memoryMutations[0]).not.toHaveProperty("idempotency_key");
    expect(backup.memoryMutations[0]).not.toHaveProperty("request_hash");
    expect(backup.memoryMutations[0]).not.toHaveProperty("result_content");
    expect(backup.memoryMutations[0]).not.toHaveProperty("last_error");
    expect(backup.memoryMutations[0]).not.toHaveProperty("lease_owner");
    expect(backup.associationEdges[0]).toMatchObject({
      id: "association-1",
      source_parent_id: "parent-1",
      target_parent_id: "parent-2",
      edge_type: "part_of_project",
      provenance: "manual",
      directed: 1,
      valid_from: now - 500,
      valid_to: now + 500,
      deleted_at: null,
    });
    expect(backup.associationEdgeHistory[0]).toMatchObject({
      id: "association-history-1",
      edge_type: "references",
      directed: 1,
      valid_from: now - 2000,
      deleted_at: now - 1000,
    });
    expect(backup.observations[0]).toMatchObject({
      root_evidence_id: "evidence-root-1",
      revision: 1,
      author_type: "user",
    });
    expect(backup.memories[0]).toMatchObject({
      parent_version_id: "parent-version-1",
      claim_subject: "Singularity",
      claim_predicate: "uses_storage",
      claim_object: "SQLite",
      claim_status: "confirmed",
    });
    expect(backup.memorySources[0]).toMatchObject({
      relation: "supports",
      evidence_root_id: "evidence-root-1",
      extractor_model: "test-extractor",
    });
    expect(backup.entities[0]).toMatchObject({
      lifecycle_state: "active",
      merged_into_entity_id: null,
      merged_at: null,
    });
    expect(backup.conflictCases[0]).toMatchObject({
      old_memory_id: "entry-1",
      new_memory_id: "entry-2",
      old_claim_id: "mem-1",
      new_claim_id: null,
    });

    const restored = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(restored.env);
    const importResponse = await worker.fetch(
      auth("/import", {
        method: "POST",
        body: JSON.stringify(backup),
      }),
      restored.env,
      createExecutionContext()
    );
    expect(importResponse.status).toBe(200);
    const imported = await importResponse.json() as any;
    expect(imported.schemaVersion).toBe(17);
    expect(imported.inserted).toBe(2);
    expect(imported.graph.scopes.imported).toBe(1);
    expect(imported.graph.parentUnits.imported).toBe(2);
    expect(imported.graph.parentVersions.imported).toBe(1);
    expect(imported.graph.parentVersionClaims.imported).toBe(1);
    expect(imported.graph.memoryMutations.imported).toBe(1);
    expect(restored.db.prepare(
      `SELECT idempotency_key, source_channel, state, result_content, lease_owner
       FROM sb_memory_mutations WHERE mutation_id = 'mutation-1'`
    ).get()).toEqual({
      idempotency_key: "restored:mutation-1",
      source_channel: "backup_restore",
      state: "failed",
      result_content: null,
      lease_owner: null,
    });
    expect(imported.graph.associationEdges.imported).toBe(1);
    expect(imported.graph.associationEdgeHistory.imported).toBe(1);
    expect(imported.graph.memories.imported).toBe(1);
    expect(imported.graph.entityRelations.imported).toBe(1);
    expect(imported.graph.entityAliases.imported).toBe(1);
    expect(imported.graph.entityAliasSources.imported).toBe(1);
    expect(imported.graph.entityExternalIds.imported).toBe(1);
    expect(imported.graph.entityExternalIdSources.imported).toBe(1);
    expect(imported.graph.entityEmbeddings.imported).toBe(1);
    expect(imported.graph.entityMergeCandidates.imported).toBe(1);
    expect(imported.graph.entityMergeHistory.imported).toBe(1);
    expect(imported.graph.factResolutions.imported).toBe(1);
    expect(imported.graph.factSources.imported).toBe(1);
    expect(imported.graph.conflictCases.imported).toBe(1);
    expect(imported.integrity.ok).toBe(true);

    const restoredExport = await worker.fetch(
      auth("/export?full=true"),
      restored.env,
      createExecutionContext()
    );
    const restoredBackup = await restoredExport.json() as any;
    expect(restoredBackup.totals).toMatchObject(backup.totals);
    expect(restoredBackup.integrity.ok).toBe(true);
    expect(restoredBackup.parentVersions[0]).toMatchObject({
      activated_at: now - 1500,
      superseded_at: null,
      activation_time_source: "recorded",
      tags_snapshot_json: '["database"]',
      source_snapshot: "obsidian",
      vault_snapshot: "vault-a",
      metadata_snapshot_hash: "snapshot-hash",
      metadata_snapshot_source: "recorded",
    });
    expect(restoredBackup.associationEdges[0]).toMatchObject({
      directed: 1,
      valid_from: now - 500,
      valid_to: now + 500,
      deleted_at: null,
    });
    expect(restoredBackup.associationEdgeHistory[0]).toMatchObject({
      id: "association-history-1",
      deleted_at: now - 1000,
    });
    expect(restoredBackup.entities[0]).toMatchObject({
      lifecycle_state: "active",
      merged_into_entity_id: null,
      merged_at: null,
    });

    const forgetResponse = await worker.fetch(
      auth("/forget", {
        method: "POST",
        body: JSON.stringify({ id: "entry-1" }),
      }),
      restored.env,
      createExecutionContext()
    );
    expect(forgetResponse.status).toBe(200);
    const postForgetExport = await worker.fetch(
      auth("/export?full=true"),
      restored.env,
      createExecutionContext()
    );
    const postForgetBackup = await postForgetExport.json() as any;
    expect(postForgetBackup.integrity).toMatchObject({ ok: true });
    expect(postForgetBackup.mergeCandidates).toEqual([]);
    expect(postForgetBackup.conflictCases).toEqual([]);
    expect(postForgetBackup.factResolutions).toEqual([]);
    expect(postForgetBackup.memoryMutations).toEqual([]);

    const legacy = {
      ...backup,
      schemaVersion: 4,
      features: undefined,
      factSources: undefined,
      entityAliases: undefined,
      entityAliasSources: undefined,
      entityExternalIds: undefined,
      entityExternalIdSources: undefined,
      entityEmbeddings: undefined,
      entityMergeCandidates: undefined,
      entityMergeHistory: undefined,
      factResolutions: undefined,
      memoryMutations: undefined,
    };
    const legacyRestored = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(legacyRestored.env);
    const legacyImportResponse = await worker.fetch(
      auth("/import", {
        method: "POST",
        body: JSON.stringify(legacy),
      }),
      legacyRestored.env,
      createExecutionContext()
    );
    expect(legacyImportResponse.status).toBe(200);
    const legacyImported = await legacyImportResponse.json() as any;
    expect(legacyImported.schemaVersion).toBe(17);
    expect(legacyImported.graph.factSources.total).toBe(0);
    expect(legacyImported.graph.parentVersionClaims.total).toBe(1);

    const missingFormatResponse = await worker.fetch(
      auth("/import", {
        method: "POST",
        body: JSON.stringify({ ...backup, backupFormat: undefined }),
      }),
      legacyRestored.env,
      createExecutionContext()
    );
    expect(missingFormatResponse.status).toBe(400);
    const missingFormatImported = await missingFormatResponse.json() as any;
    expect(missingFormatImported.error).toMatch(/backupFormat/);

    const futureImportResponse = await worker.fetch(
      auth("/import", {
        method: "POST",
        body: JSON.stringify({ ...backup, schemaVersion: 18 }),
      }),
      legacyRestored.env,
      createExecutionContext()
    );
    expect(futureImportResponse.status).toBe(400);
    const futureImported = await futureImportResponse.json() as any;
    expect(futureImported.error).toMatch(/schemaVersion 18/);

    db.close();
    restored.db.close();
    legacyRestored.db.close();
  });
});
