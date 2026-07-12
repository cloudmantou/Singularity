import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

function auth(path: string, init: RequestInit = {}) {
  return authWithToken(path, "test-token", init);
}

function authWithToken(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
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
      const ruleTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sb_automation_rules'`
      ).get() as any;
      const aggregateTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sb_knowledge_aggregates'`
      ).get() as any;
      expect(ruleTable.name).toBe("sb_automation_rules");
      expect(aggregateTable.name).toBe("sb_knowledge_aggregates");

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
        objectType: "memory",
        vaultId: "work-vault",
        syncStatus: "synced",
      });
      expect(pushed.link.path).toContain("Singularity/10 提炼知识/");
      expect(pushed.observationId).toEqual(expect.any(String));
      expect(pushed.sourceId).toEqual(expect.any(String));
      expect(pushed.sourceRevision).toBe(1);
      expect(pushed.sourceHash).toEqual(expect.any(String));
      expect(pushed.observationLink).toMatchObject({
        provider: "obsidian",
        objectType: "observation",
        objectId: pushed.observationId,
        vaultId: "work-vault",
        path: "Singularity/Projects/mtzs.md",
        syncStatus: "synced",
      });

      const memoryLinkRow = db.prepare(
        `SELECT object_type, object_id, entry_id, vault_id, external_path, external_file_id, sync_status
         FROM sb_external_links
         WHERE provider = 'obsidian'
           AND object_type = 'memory'`
      ).get() as any;
      expect(memoryLinkRow).toMatchObject({
        object_type: "memory",
        object_id: pushed.entryId,
        entry_id: pushed.entryId,
        vault_id: "work-vault",
        external_file_id: "Singularity/Projects/mtzs.md",
        sync_status: "synced",
      });
      expect(memoryLinkRow.external_path).toContain("Singularity/10 提炼知识/");

      const pullResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/pull?vaultId=work-vault"),
        env
      );
      expect(pullResponse.status).toBe(200);
      const pulled = await json(pullResponse);
      expect(pulled.count).toBe(1);
      expect(pulled.results[0]).toMatchObject({
        entryId: pushed.entryId,
      });
      expect(pulled.results[0].path).toContain("Singularity/10 提炼知识/");
      expect(pulled.results[0].markdown).toContain("singularity_id:");
      expect(pulled.results[0].markdown).toContain("singularity_type:");
      expect(pulled.results[0].markdown).toContain("managed_by: singularity");
      expect(pulled.results[0].markdown).toContain("source_file: \"Singularity/Projects/mtzs.md\"");
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
        total: 2,
        byStatus: { synced: 2 },
      });

      const repeatResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Projects/mtzs.md",
            content: "mtzs currently uses installation_proxy for the durable install path.",
            properties: {
              singularity_type: "raw-material",
              singularity_source_id: pushed.sourceId,
              tags: ["project/mtzs"],
            },
          }),
        }),
        env
      );
      expect(repeatResponse.status).toBe(200);
      const repeated = await json(repeatResponse);
      expect(repeated).toMatchObject({
        ok: true,
        action: "unchanged",
        sourceId: pushed.sourceId,
        sourceRevision: 1,
        observationId: pushed.observationId,
      });
      const observationCount = db.prepare(
        `SELECT COUNT(*) AS count FROM sb_observations WHERE source = 'obsidian'`
      ).get() as any;
      expect(observationCount.count).toBe(1);

      const changedResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Projects/mtzs.md",
            content: "mtzs currently uses installation_proxy and AFC for the durable install path.",
            properties: {
              singularity_type: "raw-material",
              singularity_source_id: pushed.sourceId,
              tags: ["project/mtzs"],
            },
          }),
        }),
        env
      );
      expect(changedResponse.status).toBe(200);
      const changed = await json(changedResponse);
      expect(changed).toMatchObject({
        ok: true,
        sourceId: pushed.sourceId,
        sourceRevision: 2,
      });
      expect(changed.entryId).not.toBe(pushed.entryId);
      const oldEntry = db.prepare(`SELECT tags FROM entries WHERE id = ?`).get(pushed.entryId) as any;
      expect(JSON.parse(oldEntry.tags)).toContain("status:deprecated");
      const changedObservationCount = db.prepare(
        `SELECT COUNT(*) AS count FROM sb_observations WHERE source = 'obsidian'`
      ).get() as any;
      expect(changedObservationCount.count).toBe(2);
    } finally {
      db.close();
    }
  });

  it("does not write generated YAML frontmatter back into memory content", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const original = "Singularity keeps generated Markdown metadata out of memory content.";
      const pushed = await json(await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Projects/frontmatter.md",
            content: original,
            properties: { tags: ["project/singularity"] },
          }),
        }),
        env
      ));
      const pulled = await json(await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/pull?vaultId=work-vault"),
        env
      ));
      const item = pulled.results.find((result: any) => result.entryId === pushed.entryId);
      expect(item.markdown.match(/^---$/gm)).toHaveLength(2);

      const roundTrip = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: item.path,
            entryId: pushed.entryId,
            baseRevisionId: item.revisionId,
            content: item.markdown,
            properties: {
              managed_by: "singularity",
              singularity_id: pushed.entryId,
              singularity_revision: item.revisionId,
              tags: ["project/singularity"],
            },
          }),
        }),
        env
      );
      expect(roundTrip.status).toBe(200);
      const row = db.prepare(`SELECT content FROM entries WHERE id = ?`).get(pushed.entryId) as any;
      expect(row.content).toBe(original);
      expect(row.content).not.toContain("managed_by: singularity");
      expect(row.content).not.toMatch(/^---/);
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
           AND external_path = 'Singularity/Decisions/vector-v2.md'
           AND object_type = 'memory'`
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

  it("acks pulled memory sync state and allows Obsidian scoped tokens only on scoped routes", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const tokenResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/tokens", {
          method: "POST",
          body: JSON.stringify({
            name: "Test vault token",
            vaultId: "work-vault",
          }),
        }),
        env
      );
      expect(tokenResponse.status).toBe(201);
      const tokenBody = await json(tokenResponse);
      expect(tokenBody.token).toMatch(/^sb_obs_/);

      const pushed = await json(await fetchAndDrainWaitUntil(
        authWithToken("/integrations/obsidian/push", tokenBody.token, {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Projects/scoped.md",
            content: "Scoped Obsidian token can push to its vault.",
            properties: { tags: ["project/singularity"] },
          }),
        }),
        env
      ));
      expect(pushed.ok).toBe(true);

      const forbidden = await fetchAndDrainWaitUntil(
        authWithToken("/count", tokenBody.token),
        env
      );
      expect(forbidden.status).toBe(401);

      await fetchAndDrainWaitUntil(
        auth("/update", {
          method: "POST",
          body: JSON.stringify({
            id: pushed.entryId,
            content: "Scoped Obsidian token can push and ack to its vault.",
          }),
        }),
        env
      );
      const pullResponse = await fetchAndDrainWaitUntil(
        authWithToken("/integrations/obsidian/pull?vaultId=work-vault", tokenBody.token),
        env
      );
      expect(pullResponse.status).toBe(200);
      const pulled = await json(pullResponse);
      const item = pulled.results.find((result: any) => result.entryId === pushed.entryId);
      expect(item.syncStatus).toBe("remote_changed");

      const ackResponse = await fetchAndDrainWaitUntil(
        authWithToken("/integrations/obsidian/ack", tokenBody.token, {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            linkId: item.link.id,
            revisionId: item.revisionId,
            contentHash: item.contentHash,
          }),
        }),
        env
      );
      expect(ackResponse.status).toBe(200);
      const link = db.prepare(`SELECT last_synced_revision_id, last_synced_content_hash, sync_status FROM sb_external_links WHERE id = ?`).get(item.link.id) as any;
      expect(link.last_synced_revision_id).toBe(item.revisionId);
      expect(link.last_synced_content_hash).toBe(item.contentHash);
      expect(link.sync_status).toBe("synced");
    } finally {
      db.close();
    }
  });
});
