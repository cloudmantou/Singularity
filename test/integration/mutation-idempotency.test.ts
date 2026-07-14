import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

function context(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext;
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
});
