import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
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
  } as ExecutionContext;
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

  it("creates quality/audit tables through initialization", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const rows = db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('sb_memory_merge_candidates', 'sb_conflict_cases', 'sb_audit_events')
         ORDER BY name`
      ).all() as Array<{ name: string }>;
      expect(rows.map(row => row.name)).toEqual([
        "sb_audit_events",
        "sb_conflict_cases",
        "sb_memory_merge_candidates",
      ]);
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
    } finally {
      db.close();
    }
  });
});
