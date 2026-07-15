import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { activeEmbeddingOf, embeddingFingerprintOf } from "../../src/settings/model-settings";
import { getEffectiveModelSettings } from "../../src/settings/store";
import { resetSettingsCache } from "../../src/settings/store";

function context(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

function appendRequest(key: string) {
  return new Request("http://localhost/append", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ id: "entry-1", addition: "new durable fact" }),
  });
}

function updateRequest(key: string, content = "replacement durable fact") {
  return new Request("http://localhost/update", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ id: "entry-1", content }),
  });
}

describe("Append mutation idempotency", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("replays a completed request without appending twice", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES ('entry-1', 'original', '[]', 'api', 1, '[]', 'original-hash')`
      ).run();

      const first = await worker.fetch(appendRequest("append-key-1"), env, context());
      const firstBody = await first.json() as any;
      const replay = await worker.fetch(appendRequest("append-key-1"), env, context());
      const replayBody = await replay.json() as any;

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replayBody).toMatchObject({
        mutation_id: firstBody.mutation_id,
        idempotent_replay: true,
      });
      const content = String((db.prepare(
        `SELECT content FROM entries WHERE id = 'entry-1'`
      ).get() as { content: string }).content);
      expect(content.match(/new durable fact/g)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("resumes Atomic knowledge sync without repeating an already committed append", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES ('entry-1', 'original', '[]', 'api', 1, '[]', 'original-hash')`
      ).run();
      db.exec(`DROP TABLE sb_parent_versions`);

      const failed = await worker.fetch(appendRequest("append-key-resume"), env, context());
      expect(failed.status).toBe(503);
      const afterFailure = String((db.prepare(
        `SELECT content FROM entries WHERE id = 'entry-1'`
      ).get() as { content: string }).content);
      expect(afterFailure.match(/new durable fact/g)).toHaveLength(1);

      await ensureMemoryDataModel(env.DB);
      const resumed = await worker.fetch(appendRequest("append-key-resume"), env, context());
      const resumedBody = await resumed.json() as any;

      expect(resumed.status).toBe(200);
      expect(resumedBody).toMatchObject({ resumed: true, idempotent_replay: false });
      const content = String((db.prepare(
        `SELECT content FROM entries WHERE id = 'entry-1'`
      ).get() as { content: string }).content);
      expect(content.match(/new durable fact/g)).toHaveLength(1);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM sb_memories WHERE entry_id = 'entry-1'`).get())
        .toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("replays updates once and rejects reuse with a different payload", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES ('entry-1', 'original', '[]', 'api', 1, '[]', 'original-hash')`
      ).run();

      const first = await worker.fetch(updateRequest("update-key-1"), env, context());
      const replay = await worker.fetch(updateRequest("update-key-1"), env, context());
      const replayBody = await replay.json() as any;
      const conflict = await worker.fetch(
        updateRequest("update-key-1", "different replacement"),
        env,
        context()
      );

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replayBody.idempotent_replay).toBe(true);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: "idempotency_conflict" });
      expect(db.prepare(
        `SELECT content FROM entries WHERE id = 'entry-1'`
      ).get()).toEqual({ content: "replacement durable fact" });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_memory_revisions
         WHERE memory_id = 'entry-1' AND event_type = 'UPDATE'`
      ).get()).toEqual({ count: 1 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_memories WHERE entry_id = 'entry-1'`
      ).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects a replay whose committed Entry projection no longer matches", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES ('entry-1', 'original', '[]', 'api', 1, '[]', 'original-hash')`
      ).run();

      const first = await worker.fetch(updateRequest("update-key-stale"), env, context());
      expect(first.status).toBe(200);
      db.prepare(
        `UPDATE entries SET content = 'externally changed', content_hash = 'external-hash'
         WHERE id = 'entry-1'`
      ).run();

      const replay = await worker.fetch(updateRequest("update-key-stale"), env, context());
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({ error: "idempotency_conflict" });
    } finally {
      db.close();
    }
  });

  it("does not persist revision, audit, or cleanup side effects after an Entry CAS loss", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES ('entry-1', 'original', '[]', 'api', 1, '["old-vector"]', 'original-hash')`
      ).run();
      const originalBatch = env.DB.batch.bind(env.DB);
      env.DB.batch = vi.fn(async (statements: D1PreparedStatement[]) => {
        db.prepare(
          `UPDATE entries SET content = 'concurrent content', vector_ids = '["concurrent-vector"]',
           content_hash = 'concurrent-hash' WHERE id = 'entry-1'`
        ).run();
        return originalBatch(statements);
      }) as unknown as D1Database["batch"];

      const response = await worker.fetch(updateRequest("update-key-cas-loss"), env, context());
      expect(response.status).toBe(503);
      expect(db.prepare(
        `SELECT content, vector_ids FROM entries WHERE id = 'entry-1'`
      ).get()).toEqual({ content: "concurrent content", vector_ids: '["concurrent-vector"]' });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_memory_revisions WHERE memory_id = 'entry-1'`
      ).get()).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_audit_events WHERE object_id = 'entry-1'`
      ).get()).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_vector_cleanup_queue WHERE vector_id = 'old-vector'`
      ).get()).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT state FROM sb_memory_mutations WHERE idempotency_key = 'update-key-cas-loss'`
      ).get()).toEqual({ state: "failed" });
    } finally {
      db.close();
    }
  });

  it("reconciles an abandoned entry_committed mutation without changing Entry again", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES ('entry-1', 'recovered content', '[]', 'api', 1, '[]', 'recovered-hash')`
      ).run();
      db.prepare(
        `INSERT INTO sb_memory_mutations (
           mutation_id, idempotency_key, source_channel, operation, entry_id,
           request_hash, state, result_content, result_content_hash,
           result_vector_count, created_at, updated_at
         ) VALUES (
           'mutation-reconcile-1', 'reconcile-key', 'api', 'update', 'entry-1',
           'request-hash', 'entry_committed', 'recovered content', 'recovered-hash',
           0, 1, 1
         )`
      ).run();

      const response = await worker.fetch(new Request("http://localhost/maintenance/mutations/reconcile", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 10 }),
      }), env, context());
      const body = await response.json() as any;
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ ok: true, scanned: 1, claimed: 1, reconciled: 1, failed: 0 });
      expect(db.prepare(
        `SELECT state FROM sb_memory_mutations WHERE mutation_id = 'mutation-reconcile-1'`
      ).get()).toEqual({ state: "completed" });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_memories WHERE entry_id = 'entry-1'`
      ).get()).toEqual({ count: 1 });

      const status = await worker.fetch(new Request("http://localhost/maintenance/mutations/status", {
        headers: { Authorization: "Bearer test-token" },
      }), env, context());
      expect(await status.json()).toMatchObject({
        ok: true,
        mutations: { entry_committed: 0, incomplete: 0, completed: 1 },
      });
    } finally {
      db.close();
    }
  });

  it("does not reproject an entry_committed mutation superseded by a newer Entry", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES ('entry-1', 'newer content', '[]', 'api', 1, '[]', 'newer-hash')`
      ).run();
      db.prepare(
        `INSERT INTO sb_memory_mutations (
           mutation_id, idempotency_key, source_channel, operation, entry_id,
           request_hash, state, result_content, result_content_hash,
           result_vector_count, created_at, updated_at
         ) VALUES (
           'mutation-stale-1', 'stale-key', 'api', 'update', 'entry-1',
           'request-hash', 'entry_committed', 'older content', 'older-hash',
           1, 1, 1
         )`
      ).run();

      const response = await worker.fetch(new Request("http://localhost/maintenance/mutations/reconcile", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 10 }),
      }), env, context());
      expect(await response.json()).toMatchObject({ ok: true, scanned: 1, failed: 1, reconciled: 0 });
      expect(db.prepare(
        `SELECT state, last_error FROM sb_memory_mutations WHERE mutation_id = 'mutation-stale-1'`
      ).get()).toEqual({ state: "failed", last_error: "mutation_reconcile_entry_projection_is_stale" });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_memories WHERE entry_id = 'entry-1'`
      ).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("converges projection_pending when the Claim vector was already indexed", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const effective = (await getEffectiveModelSettings(env)).effective;
      const fingerprint = effective.embeddingFingerprint ?? embeddingFingerprintOf(activeEmbeddingOf(effective));
      db.exec(`
        INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
        VALUES ('entry-projection', 'projection content', '[]', 'api', 1, '[]', 'entry-hash');
        INSERT INTO sb_observations (id, content, source, content_hash, created_at)
        VALUES ('obs-projection', 'projection evidence', 'api', 'obs-hash', 1);
        INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
        VALUES ('parent-projection', 'version-projection', 1, 1);
        INSERT INTO sb_parent_versions (version_id, parent_id, version_number, state, created_at, updated_at)
        VALUES ('version-projection', 'parent-projection', 1, 'active', 1, 1);
        INSERT INTO sb_memories (id, content, entry_id, parent_version_id, content_hash, claim_status, created_at)
        VALUES ('claim-projection', 'projection content', 'entry-projection', 'version-projection', 'entry-hash', 'confirmed', 1);
        INSERT INTO sb_memory_sources (id, memory_id, observation_id, role, relation, evidence_root_id, created_at)
        VALUES ('source-projection', 'claim-projection', 'obs-projection', 'supports', 'supports', 'root-projection', 1);
        INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
        VALUES ('version-projection', 'claim-projection', 'supports', 1);
        INSERT INTO sb_claim_vectors (
          claim_id, embedding_fingerprint, parent_version_id, content_hash, vector_ids_json, indexed_at
        ) VALUES ('claim-projection', '${fingerprint}', 'version-projection', 'entry-hash', '[\"claim-vector\"]', 1);
        INSERT INTO sb_memory_mutations (
          mutation_id, idempotency_key, source_channel, operation, entry_id,
          request_hash, state, result_content, result_content_hash,
          result_vector_count, observation_id, claim_id, warnings_json,
          created_at, updated_at
        ) VALUES (
          'mutation-projection-pending', 'projection-pending', 'api', 'update', 'entry-projection',
          'request-hash', 'projection_pending', 'projection content', 'entry-hash',
          1, 'obs-projection', 'claim-projection', '[\"claim_vector_enqueue_failed\"]', 1, 1
        );
      `);

      const response = await worker.fetch(new Request("http://localhost/maintenance/mutations/reconcile", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 10 }),
      }), env, context());
      expect(await response.json()).toMatchObject({ ok: true, scanned: 1, reconciled: 1, failed: 0 });
      expect(db.prepare(
        `SELECT state, warnings_json FROM sb_memory_mutations WHERE mutation_id = 'mutation-projection-pending'`
      ).get()).toEqual({ state: "completed", warnings_json: "[]" });
    } finally {
      db.close();
    }
  });
});
