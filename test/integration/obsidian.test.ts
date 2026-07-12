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

async function fetchAndDrainWaitUntil(request: Request, env: any): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(Promise.resolve(promise).catch(() => undefined));
    },
    passThroughOnException() {
      /* no-op outside Workers */
    },
    props: {},
  } as ExecutionContext;

  const response = await worker.fetch(request, env, ctx);
  await Promise.all(pending);
  return response;
}

describe("Obsidian integration", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("pushes an Obsidian note into a managed external link and pulls Markdown", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);

      const pushResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Projects/mtzs.md",
            content: "mtzs currently uses installation_proxy for the durable install path.",
            properties: {
              tags: ["project/mtzs"],
              status: "canonical",
            },
          }),
        }),
        env
      );
      expect(pushResponse.status).toBe(200);
      const pushed = await json(pushResponse);
      expect(pushed).toMatchObject({
        ok: true,
        action: "created",
      });
      expect(pushed.entryId).toEqual(expect.any(String));
      expect(pushed.link).toMatchObject({
        provider: "obsidian",
        vaultId: "work-vault",
        path: "Singularity/Projects/mtzs.md",
        syncStatus: "synced",
      });

      const linkRow = db.prepare(
        `SELECT entry_id, vault_id, external_path, sync_status
         FROM sb_external_links
         WHERE provider = 'obsidian'`
      ).get() as any;
      expect(linkRow).toMatchObject({
        entry_id: pushed.entryId,
        vault_id: "work-vault",
        external_path: "Singularity/Projects/mtzs.md",
        sync_status: "synced",
      });

      const pullResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/pull?vaultId=work-vault"),
        env
      );
      expect(pullResponse.status).toBe(200);
      const pulled = await json(pullResponse);
      expect(pulled.count).toBe(1);
      expect(pulled.results[0]).toMatchObject({
        entryId: pushed.entryId,
        path: "Singularity/Projects/mtzs.md",
      });
      expect(pulled.results[0].markdown).toContain("singularity_id:");
      expect(pulled.results[0].markdown).toContain("project/mtzs");
      expect(pulled.results[0].markdown).toContain("installation_proxy");

      const statusResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/status?vaultId=work-vault"),
        env
      );
      expect(statusResponse.status).toBe(200);
      const status = await json(statusResponse);
      expect(status).toMatchObject({
        ok: true,
        total: 1,
        byStatus: { synced: 1 },
      });
    } finally {
      db.close();
    }
  });

  it("returns a conflict when Obsidian pushes from a stale content revision", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);

      const firstPush = await json(await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Decisions/vector-v2.md",
            content: "Vector V2 uses sqlite-vec for local ANN recall.",
            properties: { tags: ["project/singularity"] },
          }),
        }),
        env
      ));
      expect(firstPush.ok).toBe(true);

      const updateResponse = await fetchAndDrainWaitUntil(
        auth("/update", {
          method: "POST",
          body: JSON.stringify({
            id: firstPush.entryId,
            content: "Vector V2 uses sqlite-vec with a guarded rebuild lifecycle.",
          }),
        }),
        env
      );
      expect(updateResponse.status).toBe(200);

      const conflictResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Decisions/vector-v2.md",
            entryId: firstPush.entryId,
            baseRevisionId: firstPush.revisionId,
            content: "Vector V2 uses sqlite-vec for local ANN recall and FTS trigram fallback.",
            properties: { tags: ["project/singularity"] },
          }),
        }),
        env
      );
      expect(conflictResponse.status).toBe(409);
      const conflict = await json(conflictResponse);
      expect(conflict).toMatchObject({
        ok: false,
        error: "obsidian_sync_conflict",
        entryId: firstPush.entryId,
        baseRevisionId: firstPush.revisionId,
      });

      const linkRow = db.prepare(
        `SELECT sync_status, last_error
         FROM sb_external_links
         WHERE provider = 'obsidian'
           AND vault_id = 'work-vault'
           AND external_path = 'Singularity/Decisions/vector-v2.md'`
      ).get() as any;
      expect(linkRow.sync_status).toBe("conflict");
      expect(linkRow.last_error).toContain("remote memory changed");

      const resolvedResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/resolve-conflict", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Decisions/vector-v2.md",
            resolution: "use_singularity",
          }),
        }),
        env
      );
      expect(resolvedResponse.status).toBe(200);
      const resolved = await json(resolvedResponse);
      expect(resolved).toMatchObject({
        ok: true,
        resolution: "use_singularity",
        entryId: firstPush.entryId,
      });
      expect(resolved.markdown).toContain("guarded rebuild lifecycle");
      expect(resolved.link.syncStatus).toBe("synced");
    } finally {
      db.close();
    }
  });
});
