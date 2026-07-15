import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

function req(path: string, authenticated = false) {
  return new Request(`http://localhost${path}`, {
    headers: authenticated ? { Authorization: "Bearer test-token" } : {},
  });
}

function ctx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

describe("Operations health API", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("keeps liveness public and protects detailed operational state", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const liveness = await worker.fetch(req("/health"), env, ctx());
      expect(liveness.status).toBe(200);
      expect(await liveness.json()).toEqual({
        ok: true,
        status: "healthy",
        mode: "selfhost",
      });

      const denied = await worker.fetch(req("/health/details"), env, ctx());
      expect(denied.status).toBe(401);

      const details = await worker.fetch(req("/health/details", true), env, ctx());
      expect(details.status).toBe(200);
      const body = await details.json() as any;
      expect(body.ok).toBe(true);
      expect(body.components.database.status).toBe("healthy");
      expect(body.queues.aiReview).toEqual({
        queued: 0,
        processingLive: 0,
        processingExpired: 0,
        applyingLive: 0,
        applyingExpired: 0,
        failed: 0,
      });
      expect(body.components.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "obsidian" }),
      ]));
      expect(JSON.stringify(body)).not.toContain("test-token");
      expect(JSON.stringify(body)).not.toContain("apiKey");

      const providers = await worker.fetch(req("/integrations/providers", true), env, ctx());
      const providerBody = await providers.json() as any;
      expect(providerBody.ok).toBe(true);
      expect(providerBody.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "obsidian", transport: "push_pull" }),
        expect.objectContaining({ id: "development-session", transport: "webhook" }),
      ]));
    } finally {
      db.close();
    }
  });

  it("degrades a provider when its persisted state cannot be inspected", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.exec("DROP TABLE sb_external_links");

      const details = await worker.fetch(req("/health/details", true), env, ctx());
      expect(details.status).toBe(200);
      const body = await details.json() as any;
      expect(body.components.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "obsidian",
          configured: false,
          status: "degraded",
          error: "provider_state_unavailable",
        }),
      ]));
      expect(body.status).toBe("degraded");
    } finally {
      db.close();
    }
  });
});
