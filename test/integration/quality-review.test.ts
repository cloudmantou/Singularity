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
           id, old_memory_id, new_memory_id, conflict_type,
           reason, confidence, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "conflict-1",
        "old-memory",
        "new-memory",
        "contradiction",
        "different city",
        0.72,
        "pending",
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
    } finally {
      db.close();
    }
  });
});
