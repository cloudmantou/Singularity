import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

function request(path: string, init: RequestInit = {}, authenticated = true): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: "Bearer test-token" } : {}),
      ...(init.headers || {}),
    },
  });
}

describe("Knowledge Evolution automation API", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("authenticates, runs one persisted item, and exposes completed progress", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    const background: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) { background.push(promise); },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO sb_memory_merge_candidates (
           id, source_memory_id, target_memory_id, similarity,
           suggested_action, state, created_at
         ) VALUES ('candidate-missing', 'missing-a', 'missing-b', 0.9,
                   'merge', 'pending', ?)`
      ).run(Date.now());

      const unauthorized = await worker.fetch(
        request("/quality/knowledge-evolution/status", {}, false),
        env,
        ctx
      );
      expect(unauthorized.status).toBe(401);

      const started = await worker.fetch(request("/quality/knowledge-evolution/run", {
        method: "POST",
        body: "{}",
      }), env, ctx);
      expect(started.status).toBe(202);
      expect(await started.json()).toMatchObject({
        ok: true,
        state: "running",
        total: 1,
        processed: 0,
      });
      await Promise.all(background);

      const status = await worker.fetch(
        request("/quality/knowledge-evolution/status"),
        env,
        ctx
      );
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        ok: true,
        state: "completed",
        total: 1,
        processed: 1,
        skipped: 0,
        failed: 1,
        percent: 100,
        current: null,
      });
    } finally {
      db.close();
    }
  });
});
