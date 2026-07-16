import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import {
  ensureAIReviewDataModel,
  enqueueAIReviewJob,
  processAIReviewJob,
} from "../../src/memory/ai-review";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

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

async function json(response: Response) {
  return await response.json() as any;
}

function testCtx(): ExecutionContext {
  return {
    waitUntil() {
      /* no-op */
    },
    passThroughOnException() {
      /* no-op */
    },
    props: {},
  } as unknown as ExecutionContext;
}

function collectingCtx(): { ctx: ExecutionContext; drain: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {
        /* no-op */
      },
      props: {},
    } as unknown as ExecutionContext,
    drain: async () => { await Promise.all(pending); },
  };
}

function insertMemoryReviewCandidate(
  db: ReturnType<typeof createSelfhostEnv>["db"],
  input: { id: string; exactContext?: boolean }
) {
  const now = Date.now();
  const sourceId = `${input.id}-source`;
  const targetId = `${input.id}-target`;
  db.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
     VALUES (?, 'Exact duplicate', '[]', 'api', ?, '[]', 'same-hash'),
            (?, 'Exact duplicate', '[]', 'api', ?, '[]', 'same-hash')`
  ).run(sourceId, now, targetId, now);
  db.prepare(
    `INSERT INTO sb_memory_merge_candidates (
       id, source_memory_id, target_memory_id, similarity,
       suggested_action, state, created_at
     ) VALUES (?, ?, ?, 1, 'duplicate', 'pending', ?)`
  ).run(input.id, sourceId, targetId, now);
  if (input.exactContext) {
    const observationId = `${input.id}-observation`;
    const evidenceRootId = `${input.id}-evidence-root`;
    db.prepare(
      `INSERT INTO sb_observations (
         id, content, source, source_channel, source_identity, author_type,
         source_timestamp, revision, root_evidence_id, created_at
       ) VALUES (?, 'Exact duplicate', 'api', 'api', ?, 'user', ?, 1, ?, ?)`
    ).run(observationId, `${input.id}/exact-repeat`, now, evidenceRootId, now);
    db.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, vault_snapshot, state, created_at, updated_at
       ) VALUES (?, ?, 1, 'work-vault', 'active', ?, ?),
                (?, ?, 1, 'work-vault', 'active', ?, ?)`
    ).run(
      `${input.id}-source-v1`, `${input.id}-source-parent`, now, now,
      `${input.id}-target-v1`, `${input.id}-target-parent`, now, now
    );
    db.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, parent_version_id, scope_id, content_hash,
         observed_at, entities_json, created_at
       ) VALUES (?, 'Exact duplicate', ?, ?, 'project/singularity', 'same-hash', ?, '[]', ?),
                (?, 'Exact duplicate', ?, ?, 'project/singularity', 'same-hash', ?, '[]', ?)`
    ).run(
      `${input.id}-source-claim`, sourceId, `${input.id}-source-v1`, now, now,
      `${input.id}-target-claim`, targetId, `${input.id}-target-v1`, now, now
    );
    db.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, relation, evidence_score,
         derivation_confidence, evidence_root_id, created_at
       ) VALUES (?, ?, ?, 'supports', 1, 1, ?, ?),
                (?, ?, ?, 'supports', 1, 1, ?, ?)`
    ).run(
      `${input.id}-source-proof`, `${input.id}-source-claim`, observationId, evidenceRootId, now,
      `${input.id}-target-proof`, `${input.id}-target-claim`, observationId, evidenceRootId, now
    );
  }
}

describe("memory quality review queues", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("creates quality/audit tables and lazily initializes the AI review ledger", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await ensureAIReviewDataModel(env.DB);
      const rows = db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'sb_memory_merge_candidates', 'sb_conflict_cases', 'sb_audit_events',
             'sb_ai_review_jobs', 'sb_ai_review_runs', 'sb_ai_review_applications'
           )
         ORDER BY name`
      ).all() as Array<{ name: string }>;
      expect(rows.map(row => row.name)).toEqual([
        "sb_ai_review_applications",
        "sb_ai_review_jobs",
        "sb_ai_review_runs",
        "sb_audit_events",
        "sb_conflict_cases",
        "sb_memory_merge_candidates",
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps suggestions pending until a human applies the immutable AI run", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      insertMemoryReviewCandidate(db, { id: "ai-suggest" });
      const job = await enqueueAIReviewJob(env.DB, {
        objectType: "memory_merge_candidate",
        objectId: "ai-suggest",
        mode: "suggest",
        requestedBy: "owner",
      });
      const { run } = await processAIReviewJob(env.DB, job.id, {
        provider: "test",
        model: "reviewer-v1",
        complete: async () => JSON.stringify({
          decision: "duplicate",
          reason: "Both evidence references contain the same statement.",
          evidenceRefs: ["SOURCE", "TARGET"],
          confidence: { decision: 0.96, evidence: 0.9 },
          abstain: false,
          reviewability: "sufficient",
          missingContext: [],
          keyDifferences: [{
            dimension: "content",
            status: "same",
            summary: "No material content difference was found.",
            evidenceRefs: ["SOURCE", "TARGET"],
          }],
        }),
      });
      expect(db.prepare(
        `SELECT state FROM sb_memory_merge_candidates WHERE id = 'ai-suggest'`
      ).get()).toEqual({ state: "pending" });

      const response = await worker.fetch(auth("/quality/ai-review/apply", {
        method: "POST",
        body: JSON.stringify({ runId: run.id }),
      }), env, testCtx());

      expect(response.status).toBe(200);
      expect(db.prepare(
        `SELECT state, reviewed_by FROM sb_memory_merge_candidates WHERE id = 'ai-suggest'`
      ).get()).toEqual({ state: "accepted", reviewed_by: "ai-review:owner" });
      expect(db.prepare(
        `SELECT decision, application_mode FROM sb_ai_review_applications WHERE run_id = ?`
      ).get(run.id)).toEqual({ decision: "duplicate", application_mode: "human" });
      const audit = db.prepare(
        `SELECT metadata_json FROM sb_audit_events
         WHERE action = 'quality.merge_candidate.resolve' AND object_id = 'ai-suggest'`
      ).get() as { metadata_json: string };
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        ai_review_run_id: run.id,
        ai_review_decision: "duplicate",
      });
      const listed = await worker.fetch(
        auth("/quality/ai-review?objectType=memory_merge_candidate&limit=10"),
        env,
        testCtx()
      );
      expect(listed.status).toBe(200);
      expect((await listed.json() as any).reviews[0].run).toMatchObject({
        reviewability: "sufficient",
        missingContext: [],
        keyDifferences: [{
          dimension: "content",
          status: "same",
          evidenceRefs: ["SOURCE", "TARGET"],
        }],
      });
      expect((await (await worker.fetch(
        auth("/quality/ai-review?objectType=memory_merge_candidate&limit=10"),
        env,
        testCtx()
      )).json() as any).reviews[0].context).toMatchObject({
        evidence: [
          expect.objectContaining({ ref: "SOURCE" }),
          expect.objectContaining({ ref: "TARGET" }),
        ],
      });
    } finally {
      db.close();
    }
  });

  it("never applies shadow reviews", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      insertMemoryReviewCandidate(db, { id: "ai-shadow" });
      const job = await enqueueAIReviewJob(env.DB, {
        objectType: "memory_merge_candidate",
        objectId: "ai-shadow",
        mode: "shadow",
        requestedBy: "owner",
      });
      const { run } = await processAIReviewJob(env.DB, job.id, {
        provider: "test",
        model: "reviewer-v1",
        complete: async () => JSON.stringify({
          decision: "duplicate",
          reason: "Shadow evaluation only.",
          evidenceRefs: ["SOURCE", "TARGET"],
          confidence: { decision: 0.9, evidence: 0.9 },
          abstain: false,
          reviewability: "sufficient",
          missingContext: [],
          keyDifferences: [{
            dimension: "content",
            status: "same",
            summary: "No material content difference was found.",
            evidenceRefs: ["SOURCE", "TARGET"],
          }],
        }),
      });

      const response = await worker.fetch(auth("/quality/ai-review/apply", {
        method: "POST",
        body: JSON.stringify({ runId: run.id }),
      }), env, testCtx());

      expect(response.status).toBe(409);
      expect(db.prepare(
        `SELECT state FROM sb_memory_merge_candidates WHERE id = 'ai-shadow'`
      ).get()).toEqual({ state: "pending" });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM sb_ai_review_applications`).get())
        .toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("atomically rolls back the domain decision when its AI receipt cannot be written", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      insertMemoryReviewCandidate(db, { id: "ai-atomic" });
      const job = await enqueueAIReviewJob(env.DB, {
        objectType: "memory_merge_candidate",
        objectId: "ai-atomic",
        mode: "suggest",
        requestedBy: "owner",
      });
      const { run } = await processAIReviewJob(env.DB, job.id, {
        provider: "test",
        model: "reviewer-v1",
        complete: async () => JSON.stringify({
          decision: "duplicate",
          reason: "Exact duplicate suggestion.",
          evidenceRefs: ["SOURCE", "TARGET"],
          confidence: { decision: 0.9, evidence: 0.9 },
          abstain: false,
          reviewability: "sufficient",
          missingContext: [],
          keyDifferences: [{
            dimension: "content",
            status: "same",
            summary: "No material content difference was found.",
            evidenceRefs: ["SOURCE", "TARGET"],
          }],
        }),
      });
      db.exec(
        `CREATE TRIGGER reject_ai_receipt BEFORE INSERT ON sb_ai_review_applications
         BEGIN SELECT RAISE(ABORT, 'injected_receipt_failure'); END`
      );

      await expect(worker.fetch(auth("/quality/ai-review/apply", {
        method: "POST",
        body: JSON.stringify({ runId: run.id }),
      }), env, testCtx())).rejects.toThrow("injected_receipt_failure");
      expect(db.prepare(
        `SELECT state, reviewed_by, reviewed_at FROM sb_memory_merge_candidates WHERE id = 'ai-atomic'`
      ).get()).toEqual({ state: "pending", reviewed_by: null, reviewed_at: null });
      expect(db.prepare(
        `SELECT status FROM sb_ai_review_jobs WHERE id = ?`
      ).get(job.id)).toEqual({ status: "completed" });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_audit_events
         WHERE action = 'quality.merge_candidate.resolve' AND object_id = 'ai-atomic'`
      ).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("auto-applies only exact duplicates with matching explicit scope and vault", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      insertMemoryReviewCandidate(db, { id: "ai-auto", exactContext: true });
      const background = collectingCtx();

      const response = await worker.fetch(auth("/quality/ai-review", {
        method: "POST",
        body: JSON.stringify({
          objectType: "memory_merge_candidate",
          objectId: "ai-auto",
          mode: "auto_low_risk",
        }),
      }), env, background.ctx);
      await background.drain();

      expect(response.status).toBe(202);
      expect(db.prepare(
        `SELECT state, reviewed_by FROM sb_memory_merge_candidates WHERE id = 'ai-auto'`
      ).get()).toEqual({ state: "accepted", reviewed_by: "ai-review:owner" });
      expect(db.prepare(
        `SELECT decision, application_mode, applied_by FROM sb_ai_review_applications`
      ).get()).toEqual({
        decision: "duplicate",
        application_mode: "deterministic_auto",
        applied_by: "owner",
      });
    } finally {
      db.close();
    }
  });

  it("applies approved AI conflict and entity recommendations through their domain coordinators", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const now = Date.now();
      await worker.fetch(
        auth("/quality/entity-merge-candidates?state=pending"),
        env,
        testCtx()
      );
      db.prepare(
        `INSERT INTO sb_entities (
           id, name, name_normalized, entity_type, aliases_json, metadata_json,
           mention_count, lifecycle_state, created_at, updated_at
         ) VALUES ('entity-source', 'Project Alpha', 'project alpha', 'project', '[]', '{}', 1, 'active', ?, ?),
                  ('entity-target', 'Project Beta', 'project beta', 'project', '[]', '{}', 1, 'active', ?, ?)`
      ).run(now, now, now, now);
      db.prepare(
        `INSERT INTO sb_entity_merge_candidates (
           id, source_entity_id, target_entity_id, matched_by, score,
           reason_json, state, created_at, updated_at
         ) VALUES ('ai-entity', 'entity-source', 'entity-target', 'semantic', 0.84,
                   '["review_required"]', 'pending', ?, ?)`
      ).run(now, now);
      const entityJob = await enqueueAIReviewJob(env.DB, {
        objectType: "entity_merge_candidate",
        objectId: "ai-entity",
        mode: "suggest",
        requestedBy: "owner",
      });
      const entityRun = (await processAIReviewJob(env.DB, entityJob.id, {
        provider: "test",
        model: "reviewer-v1",
        complete: async () => JSON.stringify({
          decision: "keep_separate",
          reason: "The evidence does not establish identity.",
          evidenceRefs: ["SOURCE", "TARGET"],
          confidence: { decision: 0.88, evidence: 0.75 },
          abstain: false,
          reviewability: "sufficient",
          missingContext: [],
          keyDifferences: [{
            dimension: "identity",
            status: "different",
            summary: "The entity names identify different projects.",
            evidenceRefs: ["SOURCE", "TARGET"],
          }],
        }),
      })).run;
      expect((await worker.fetch(auth("/quality/ai-review/apply", {
        method: "POST",
        body: JSON.stringify({ runId: entityRun.id }),
      }), env, testCtx())).status).toBe(200);
      expect(db.prepare(
        `SELECT state, reviewed_by FROM sb_entity_merge_candidates WHERE id = 'ai-entity'`
      ).get()).toEqual({ state: "rejected", reviewed_by: "ai-review:owner" });

      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES ('old-entry-ai', 'Service uses SQLite', '[]', 'api', ?, '[]', 'old-hash'),
                ('new-entry-ai', 'Service uses Postgres', '[]', 'api', ?, '[]', 'new-hash')`
      ).run(now - 1, now);
      db.prepare(
        `INSERT INTO sb_memories (
           id, content, entry_id, content_hash, observed_at, entities_json, created_at
         ) VALUES ('old-claim-ai', 'Service uses SQLite', 'old-entry-ai', 'old-hash', ?, '[]', ?),
                  ('new-claim-ai', 'Service uses Postgres', 'new-entry-ai', 'new-hash', ?, '[]', ?)`
      ).run(now - 1, now - 1, now, now);
      db.prepare(
        `INSERT INTO sb_conflict_cases (
           id, old_memory_id, new_memory_id, old_claim_id, new_claim_id,
           conflict_type, reason, confidence, state, created_at
         ) VALUES ('ai-conflict', 'old-entry-ai', 'new-entry-ai', 'old-claim-ai', 'new-claim-ai',
                   'contradiction', 'different database', 0.9, 'pending', ?)`
      ).run(now);
      const conflictJob = await enqueueAIReviewJob(env.DB, {
        objectType: "conflict_case",
        objectId: "ai-conflict",
        mode: "suggest",
        requestedBy: "owner",
      });
      const conflictRun = (await processAIReviewJob(env.DB, conflictJob.id, {
        provider: "test",
        model: "reviewer-v1",
        complete: async () => JSON.stringify({
          decision: "use_new",
          reason: "The incoming evidence is newer.",
          evidenceRefs: ["OLD", "NEW"],
          confidence: { decision: 0.91, evidence: 0.9 },
          abstain: false,
          reviewability: "sufficient",
          missingContext: [],
          keyDifferences: [{
            dimension: "time",
            status: "different",
            summary: "The incoming evidence is newer.",
            evidenceRefs: ["OLD", "NEW"],
          }],
        }),
      })).run;
      expect((await worker.fetch(auth("/quality/ai-review/apply", {
        method: "POST",
        body: JSON.stringify({ runId: conflictRun.id }),
      }), env, testCtx())).status).toBe(200);
      expect(db.prepare(
        `SELECT state, resolution, resolved_by FROM sb_conflict_cases WHERE id = 'ai-conflict'`
      ).get()).toEqual({ state: "resolved", resolution: "use_new", resolved_by: "ai-review:owner" });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_ai_review_applications
         WHERE run_id IN (?, ?)`
      ).get(entityRun.id, conflictRun.id)).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("removes legacy conflict cases whose entries no longer exist", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO sb_conflict_cases (
           id, old_memory_id, new_memory_id, old_claim_id, new_claim_id,
           conflict_type, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "orphan-conflict",
        "missing-old-entry",
        "missing-new-entry",
        null,
        null,
        "contradiction",
        "pending",
        Date.now()
      );
      db.prepare(
        `DELETE FROM sb_schema_migrations WHERE id = ?`
      ).run("20260715_remove_orphan_conflict_cases");

      await initializeDatabase(env);

      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_conflict_cases WHERE id = ?`
      ).get("orphan-conflict")).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("migrates existing parent version CHECK constraints to allow active_degraded", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      db.exec(
        `CREATE TABLE sb_parent_versions (
          version_id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL,
          version_number INTEGER NOT NULL,
          source_observation_id TEXT,
          source_snapshot_hash TEXT,
          summary TEXT,
          state TEXT NOT NULL DEFAULT 'building',
          summary_vector_ids TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (state IN ('building', 'active', 'superseded', 'failed')),
          UNIQUE(parent_id, version_number)
        )`
      );
      db.prepare(
        `INSERT INTO sb_parent_versions (
           version_id, parent_id, version_number, source_observation_id,
           source_snapshot_hash, summary, state, summary_vector_ids, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("old-version", "parent-1", 1, "obs-1", "hash-1", null, "active", "[]", 1, 1);

      await initializeDatabase(env);

      const schema = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sb_parent_versions'`
      ).get() as { sql: string };
      expect(schema.sql).toContain("active_degraded");
      const parentVersionColumns = db.prepare(`PRAGMA table_info(sb_parent_versions)`).all() as Array<{ name: string }>;
      expect(parentVersionColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["activated_at", "superseded_at"])
      );
      expect(db.prepare(`SELECT state FROM sb_parent_versions WHERE version_id = ?`).get("old-version")).toEqual({
        state: "active",
      });
      db.prepare(
        `INSERT INTO sb_parent_versions (
           version_id, parent_id, version_number, source_observation_id,
           source_snapshot_hash, summary, state, summary_vector_ids, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("degraded-version", "parent-1", 2, "obs-2", "hash-2", null, "active_degraded", "[]", 2, 2);
      expect(db.prepare(`SELECT state FROM sb_parent_versions WHERE version_id = ?`).get("degraded-version")).toEqual({
        state: "active_degraded",
      });
    } finally {
      db.close();
    }
  });

  it("lists and executes reviewed entity merge candidates", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const now = Date.now();
      const emptyList = await json(await worker.fetch(
        auth("/quality/entity-merge-candidates?state=pending"),
        env,
        testCtx()
      ));
      expect(emptyList).toMatchObject({ ok: true, count: 0, candidates: [] });
      const invalidReview = await worker.fetch(
        auth("/quality/entity-merge-candidates/resolve", {
          method: "POST",
          body: JSON.stringify({ id: "entity-merge-1", decision: "accept", unexpected: true }),
        }),
        env,
        testCtx()
      );
      expect(invalidReview.status).toBe(400);
      expect(await invalidReview.json()).toMatchObject({ error: "invalid_entity_merge_review" });
      db.prepare(
        `INSERT INTO sb_entities (
           id, name, name_normalized, entity_type, aliases_json, metadata_json,
           mention_count, lifecycle_state, created_at, updated_at
         ) VALUES
           ('entity-source', '馒头助手 App', '馒头助手 app', 'project', '[]', '{}', 2, 'active', ?, ?),
           ('entity-target', 'mtzs', 'mtzs', 'project', '[]', '{}', 3, 'active', ?, ?)`
      ).run(now, now, now, now);
      db.prepare(
        `INSERT INTO sb_entity_merge_candidates (
           id, source_entity_id, target_entity_id, matched_by, score,
           reason_json, state, created_at, updated_at
         ) VALUES ('entity-merge-1', 'entity-source', 'entity-target', 'semantic', 0.94,
                   '["review_required"]', 'pending', ?, ?)`
      ).run(now, now);

      const list = await json(await worker.fetch(
        auth("/quality/entity-merge-candidates?state=pending"),
        env,
        testCtx()
      ));
      expect(list).toMatchObject({
        ok: true,
        count: 1,
        candidates: [{
          id: "entity-merge-1",
          sourceEntityId: "entity-source",
          targetEntityId: "entity-target",
          state: "pending",
          source: { name: "馒头助手 App", lifecycleState: "active" },
          target: { name: "mtzs", lifecycleState: "active" },
        }],
      });

      const response = await worker.fetch(
        auth("/quality/entity-merge-candidates/resolve", {
          method: "POST",
          body: JSON.stringify({
            id: "entity-merge-1",
            decision: "accept",
            reviewedBy: "mantou",
            reason: "same project",
          }),
        }),
        env,
        testCtx()
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        candidateId: "entity-merge-1",
        sourceEntityId: "entity-source",
        targetEntityId: "entity-target",
        state: "merged",
        reviewedBy: "mantou",
      });
      expect(db.prepare(
        `SELECT lifecycle_state, merged_into_entity_id
         FROM sb_entities WHERE id = 'entity-source'`
      ).get()).toEqual({ lifecycle_state: "merged", merged_into_entity_id: "entity-target" });
      expect(db.prepare(
        `SELECT state FROM sb_entity_merge_candidates WHERE id = 'entity-merge-1'`
      ).get()).toEqual({ state: "merged" });
      expect(db.prepare(
        `SELECT actor_type, actor_id FROM sb_audit_events
         WHERE action = 'quality.entity_merge.accept'`
      ).get()).toEqual({ actor_type: "owner", actor_id: "owner" });
    } finally {
      db.close();
    }
  });

  it("lists and resolves merge candidates and conflict cases", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const now = Date.now();
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "old-memory",
        "I live in NYC",
        "[]",
        "api",
        now - 10,
        "[]",
        "old-hash",
        "new-memory",
        "I moved to LA",
        "[]",
        "api",
        now,
        "[]",
        "new-hash"
      );
      db.prepare(
        `INSERT INTO sb_memory_merge_candidates (
           id, source_memory_id, target_memory_id, similarity,
           suggested_action, reason, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "merge-1",
        "new-memory",
        "old-memory",
        0.91,
        "replace",
        "test candidate",
        "pending",
        now
      );
      db.prepare(
        `INSERT INTO sb_conflict_cases (
           id, old_memory_id, new_memory_id, old_claim_id, new_claim_id, conflict_type,
           reason, confidence, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "conflict-1",
        "old-memory",
        "new-memory",
        "old-claim",
        "new-claim",
        "contradiction",
        "different city",
        0.72,
        "pending",
        now
      );
      db.prepare(
        `INSERT INTO sb_memories (
           id, content, kind, memory_class, importance, confidence, entry_id,
           content_hash, observed_at, valid_from, valid_to, reference_time,
           invalid_at, expired_at, entities_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
                  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "old-claim",
        "I live in NYC",
        "semantic",
        "fact",
        3,
        0.8,
        "old-memory",
        "old-hash",
        now - 10,
        null,
        null,
        null,
        null,
        null,
        "[]",
        now - 10,
        "new-claim",
        "I moved to LA",
        "semantic",
        "fact",
        4,
        0.9,
        "new-memory",
        "new-hash",
        now,
        null,
        null,
        null,
        null,
        null,
        "[]",
        now
      );

      const mergeList = await json(await worker.fetch(
        auth("/quality/merge-candidates?state=pending"),
        env,
        testCtx()
      ));
      expect(mergeList).toMatchObject({
        ok: true,
        count: 1,
        candidates: [
          {
            id: "merge-1",
            sourceMemoryId: "new-memory",
            targetMemoryId: "old-memory",
            suggestedAction: "replace",
            state: "pending",
          },
        ],
      });

      const mergeResolve = await worker.fetch(
        auth("/quality/merge-candidates/resolve", {
          method: "POST",
          body: JSON.stringify({ id: "merge-1", state: "accepted", reviewedBy: "mantou" }),
        }),
        env,
        testCtx()
      );
      expect(mergeResolve.status).toBe(200);
      expect(db.prepare(`SELECT state, reviewed_by FROM sb_memory_merge_candidates WHERE id = ?`)
        .get("merge-1")).toEqual({ state: "accepted", reviewed_by: "mantou" });

      const conflictList = await json(await worker.fetch(
        auth("/quality/conflict-cases?state=pending"),
        env,
        testCtx()
      ));
      expect(conflictList).toMatchObject({
        ok: true,
        count: 1,
        conflicts: [
          {
            id: "conflict-1",
            oldMemoryId: "old-memory",
            newMemoryId: "new-memory",
            oldClaimId: "old-claim",
            newClaimId: "new-claim",
            conflictType: "contradiction",
            state: "pending",
          },
        ],
      });

      const conflictResolve = await worker.fetch(
        auth("/quality/conflict-cases/resolve", {
          method: "POST",
          body: JSON.stringify({
            id: "conflict-1",
            state: "resolved",
            resolution: "use_new",
            resolvedBy: "mantou",
          }),
        }),
        env,
        testCtx()
      );
      expect(conflictResolve.status).toBe(200);
      expect(db.prepare(`SELECT state, resolution, resolved_by FROM sb_conflict_cases WHERE id = ?`)
        .get("conflict-1")).toEqual({
          state: "resolved",
          resolution: "use_new",
          resolved_by: "mantou",
        });
      expect(db.prepare(`SELECT claim_status FROM sb_memories WHERE id = ?`).get("old-claim")).toEqual({
        claim_status: "superseded",
      });
      expect(db.prepare(`SELECT claim_status FROM sb_memories WHERE id = ?`).get("new-claim")).toEqual({
        claim_status: "confirmed",
      });

      const audit = await json(await worker.fetch(
        auth("/audit/events?action=quality.conflict_case.resolve"),
        env,
        testCtx()
      ));
      expect(audit).toMatchObject({
        ok: true,
        count: 1,
        events: [
          {
            action: "quality.conflict_case.resolve",
            objectType: "conflict_case",
            objectId: "conflict-1",
            actorType: "owner",
            success: true,
          },
        ],
      });
      expect(audit.events[0].eventHash).toEqual(expect.any(String));
      expect(audit.events[0].previousEventHash).toEqual(expect.any(String));

      const invalidPair = await worker.fetch(
        auth("/quality/conflict-cases/resolve", {
          method: "POST",
          body: JSON.stringify({
            id: "conflict-1",
            state: "dismissed",
            resolution: "use_new",
          }),
        }),
        env,
        testCtx()
      );
      expect(invalidPair.status).toBe(400);

      db.prepare(
        `UPDATE sb_conflict_cases
         SET state = 'pending', resolution = NULL, resolved_by = NULL, resolved_at = NULL
         WHERE id = 'conflict-1'`
      ).run();
      const manualWithoutOutcome = await worker.fetch(
        auth("/quality/conflict-cases/resolve", {
          method: "POST",
          body: JSON.stringify({
            id: "conflict-1",
            state: "resolved",
            resolution: "manual",
          }),
        }),
        env,
        testCtx()
      );
      expect(manualWithoutOutcome.status).toBe(400);
      expect(await manualWithoutOutcome.json()).toMatchObject({
        error: "manual_resolution_requires_outcome",
      });
      expect(db.prepare(`SELECT state, resolution FROM sb_conflict_cases WHERE id = 'conflict-1'`).get())
        .toEqual({ state: "pending", resolution: null });
    } finally {
      db.close();
    }
  });
});
