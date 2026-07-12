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
  await drainPending(pending);
  return response;
}

async function fetchWithCapturedWaitUntil(request: Request, env: any): Promise<{
  response: Response;
  pending: Promise<unknown>[];
}> {
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
  return {
    response: await worker.fetch(request, env, ctx),
    pending,
  };
}

async function drainPending(pending: Promise<unknown>[]): Promise<void> {
  for (let drained = 0; drained < 10 && pending.length; drained++) {
    const batch = pending.splice(0, pending.length);
    await Promise.all(batch);
  }
}

function entryIdForObservation(db: any, observationId: string): string {
  const row = db.prepare(
    `SELECT m.entry_id
     FROM sb_memory_sources s
     JOIN sb_memories m ON m.id = s.memory_id
     WHERE s.observation_id = ?
       AND m.entry_id IS NOT NULL
     ORDER BY m.created_at ASC
     LIMIT 1`
  ).get(observationId) as any;
  expect(row?.entry_id).toEqual(expect.any(String));
  return row.entry_id;
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
      expect(pushResponse.status).toBe(202);
      const pushed = await json(pushResponse);
      expect(pushed).toMatchObject({
        ok: true,
        action: "queued",
        status: "queued",
      });
      expect(pushed.entryId).toBeNull();
      expect(pushed.link).toBeNull();
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
      const pushedEntryId = entryIdForObservation(db, pushed.observationId);

      const memoryLinkRow = db.prepare(
        `SELECT object_type, object_id, entry_id, vault_id, external_path, external_file_id,
                sync_status, sync_etag, last_synced_sync_etag
         FROM sb_external_links
         WHERE provider = 'obsidian'
           AND object_type = 'memory'`
      ).get() as any;
      expect(memoryLinkRow).toMatchObject({
        object_type: "memory",
        object_id: pushedEntryId,
        entry_id: pushedEntryId,
        vault_id: "work-vault",
        external_file_id: "Singularity/Projects/mtzs.md",
        sync_status: "synced",
      });
      expect(memoryLinkRow.external_path).toContain("Singularity/10 提炼知识/");
      expect(memoryLinkRow.sync_etag).toEqual(expect.any(String));
      expect(memoryLinkRow.last_synced_sync_etag).toBe(memoryLinkRow.sync_etag);

      const pullResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/pull?vaultId=work-vault"),
        env
      );
      expect(pullResponse.status).toBe(200);
      const pulled = await json(pullResponse);
      expect(pulled.count).toBe(1);
      expect(pulled.nextCursor).toBeNull();
      expect(pulled.results[0]).toMatchObject({
        entryId: pushedEntryId,
      });
      expect(pulled.results[0].syncEtag).toEqual(expect.any(String));
      expect(pulled.results[0].lastSyncedSyncEtag).toBe(pulled.results[0].syncEtag);
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
        sources: 1,
        byStatus: { synced: 2 },
      });
      expect(status.migrations.map((row: any) => row.id)).toContain("20260712_obsidian_p1_sync_contract");

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
      expect(repeated.entryId).toBe(pushedEntryId);
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
      expect(changedResponse.status).toBe(202);
      const changed = await json(changedResponse);
      expect(changed).toMatchObject({
        ok: true,
        action: "queued",
        sourceId: pushed.sourceId,
        sourceRevision: 2,
      });
      const changedEntryId = entryIdForObservation(db, changed.observationId);
      expect(changedEntryId).not.toBe(pushedEntryId);
      const oldEntry = db.prepare(`SELECT tags FROM entries WHERE id = ?`).get(pushedEntryId) as any;
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
      const pushedEntryId = entryIdForObservation(db, pushed.observationId);
      const pulled = await json(await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/pull?vaultId=work-vault"),
        env
      ));
      const item = pulled.results.find((result: any) => result.entryId === pushedEntryId);
      expect(item.markdown.match(/^---$/gm)).toHaveLength(2);

      const roundTrip = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: item.path,
            entryId: pushedEntryId,
            baseRevisionId: item.revisionId,
            content: item.markdown,
            properties: {
              managed_by: "singularity",
              singularity_id: pushedEntryId,
              singularity_revision: item.revisionId,
              tags: ["project/singularity"],
            },
          }),
        }),
        env
      );
      expect(roundTrip.status).toBe(200);
      const row = db.prepare(`SELECT content FROM entries WHERE id = ?`).get(pushedEntryId) as any;
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
      const firstEntryId = entryIdForObservation(db, firstPush.observationId);
      const firstPulled = await json(await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/pull?vaultId=work-vault"),
        env
      ));
      const firstItem = firstPulled.results.find((result: any) => result.entryId === firstEntryId);
      expect(firstItem.revisionId).toEqual(expect.any(String));

      const updateResponse = await fetchAndDrainWaitUntil(
        auth("/update", {
          method: "POST",
          body: JSON.stringify({
            id: firstEntryId,
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
            entryId: firstEntryId,
            baseRevisionId: firstItem.revisionId,
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
        entryId: firstEntryId,
        baseRevisionId: firstItem.revisionId,
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
        entryId: firstEntryId,
      });
      expect(resolved.markdown).toContain("guarded rebuild lifecycle");
      expect(resolved.link.syncStatus).toBe("synced");
    } finally {
      db.close();
    }
  });

  it("queues raw Obsidian extraction without blocking the push response", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const { response, pending } = await fetchWithCapturedWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Inbox/async.md",
            content: "Obsidian raw material extraction should run after the push response.",
            properties: { tags: ["project/singularity"] },
          }),
        }),
        env
      );
      expect(response.status).toBe(202);
      const body = await json(response);
      expect(body).toMatchObject({
        ok: true,
        action: "queued",
        entryId: null,
        memoryIds: [],
      });
      const beforeDrain = db.prepare(
        `SELECT COUNT(*) AS count FROM sb_external_links
         WHERE provider = 'obsidian'
           AND object_type = 'memory'`
      ).get() as any;
      expect(beforeDrain.count).toBe(0);

      await drainPending(pending);
      const entryId = entryIdForObservation(db, body.observationId);
      const afterDrain = db.prepare(
        `SELECT object_id, entry_id, external_file_id
         FROM sb_external_links
         WHERE provider = 'obsidian'
           AND object_type = 'memory'`
      ).get() as any;
      expect(afterDrain).toMatchObject({
        object_id: entryId,
        entry_id: entryId,
        external_file_id: "Singularity/Inbox/async.md",
      });
    } finally {
      db.close();
    }
  });

  it("paginates Obsidian pull results with stable sync etags", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      for (const name of ["one", "two", "three"]) {
        await fetchAndDrainWaitUntil(
          auth("/integrations/obsidian/push", {
            method: "POST",
            body: JSON.stringify({
              vaultId: "work-vault",
              path: `Singularity/Inbox/${name}.md`,
              content: `Paged Obsidian pull memory ${name}.`,
              properties: { tags: ["project/singularity"] },
            }),
          }),
          env
        );
      }

      const first = await json(await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/pull?vaultId=work-vault&limit=2"),
        env
      ));
      expect(first.count).toBe(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(first.results.every((item: any) => typeof item.syncEtag === "string")).toBe(true);

      const second = await json(await fetchAndDrainWaitUntil(
        auth(`/integrations/obsidian/pull?vaultId=work-vault&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`),
        env
      ));
      expect(second.count).toBe(1);
      expect(second.hasMore).toBe(false);
      const ids = [...first.results, ...second.results].map((item: any) => item.entryId);
      expect(new Set(ids).size).toBe(3);
    } finally {
      db.close();
    }
  });

  it("manages Obsidian rules and regenerable aggregates outside ordinary memories", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const pushed = await json(await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/push", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            path: "Singularity/Projects/p1.md",
            content: "P1 Obsidian rules and aggregates must stay outside normal recall entries.",
            properties: { tags: ["project/singularity"] },
          }),
        }),
        env
      ));
      const sourceEntryId = entryIdForObservation(db, pushed.observationId);

      const ruleResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/rules", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            name: "Project status aggregate",
            triggerType: "manual",
            sourceFilter: { tags: ["project/singularity"] },
            extractorSchema: { fields: ["decision", "risk"] },
            tagRules: { add: ["project/singularity"] },
            aggregationRule: { type: "project-status" },
            outputTemplate: "# {{title}}",
          }),
        }),
        env
      );
      expect(ruleResponse.status).toBe(201);
      const ruleBody = await json(ruleResponse);
      expect(ruleBody.rule).toMatchObject({
        name: "Project status aggregate",
        triggerType: "manual",
        vaultId: "work-vault",
        enabled: true,
      });

      const aggregateResponse = await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/aggregates/generate", {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            aggregateType: "project-status",
            title: "Singularity P1 状态",
            sourceMemoryIds: [sourceEntryId],
            generationRuleId: ruleBody.rule.id,
          }),
        }),
        env
      );
      expect(aggregateResponse.status).toBe(201);
      const aggregateBody = await json(aggregateResponse);
      expect(aggregateBody.aggregate).toMatchObject({
        title: "Singularity P1 状态",
        aggregateType: "project-status",
        sourceMemoryIds: [sourceEntryId],
      });
      expect(aggregateBody.aggregate.markdown).toContain("singularity_type: \"knowledge-aggregate\"");
      expect(aggregateBody.aggregate.markdown).toContain("P1 Obsidian rules and aggregates");
      expect(aggregateBody.link).toMatchObject({
        objectType: "aggregate",
        vaultId: "work-vault",
        syncStatus: "synced",
      });

      const rules = await json(await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/rules?vaultId=work-vault"),
        env
      ));
      expect(rules.count).toBe(1);
      const aggregates = await json(await fetchAndDrainWaitUntil(
        auth("/integrations/obsidian/aggregates?vaultId=work-vault"),
        env
      ));
      expect(aggregates.count).toBe(1);

      await fetchAndDrainWaitUntil(
        auth("/update", {
          method: "POST",
          body: JSON.stringify({
            id: sourceEntryId,
            content: "P1 Obsidian rules and aggregates are now stale after this source update.",
          }),
        }),
        env
      );
      const stale = db.prepare(
        `SELECT stale_at FROM sb_knowledge_aggregates WHERE id = ?`
      ).get(aggregateBody.aggregate.id) as any;
      expect(stale.stale_at).toEqual(expect.any(Number));

      const ruleEntry = db.prepare(
        `SELECT id FROM entries WHERE content LIKE '%Project status aggregate%'`
      ).get() as any;
      expect(ruleEntry).toBeUndefined();
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
      const pushedEntryId = entryIdForObservation(db, pushed.observationId);

      const forbidden = await fetchAndDrainWaitUntil(
        authWithToken("/count", tokenBody.token),
        env
      );
      expect(forbidden.status).toBe(401);

      await fetchAndDrainWaitUntil(
        auth("/update", {
          method: "POST",
          body: JSON.stringify({
            id: pushedEntryId,
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
      const item = pulled.results.find((result: any) => result.entryId === pushedEntryId);
      expect(item.syncStatus).toBe("remote_changed");
      expect(item.syncEtag).not.toBe(item.lastSyncedSyncEtag);

      const ackResponse = await fetchAndDrainWaitUntil(
        authWithToken("/integrations/obsidian/ack", tokenBody.token, {
          method: "POST",
          body: JSON.stringify({
            vaultId: "work-vault",
            linkId: item.link.id,
            revisionId: item.revisionId,
            contentHash: item.contentHash,
            syncEtag: item.syncEtag,
          }),
        }),
        env
      );
      expect(ackResponse.status).toBe(200);
      const link = db.prepare(
        `SELECT last_synced_revision_id, last_synced_content_hash, last_synced_sync_etag, sync_status
         FROM sb_external_links
         WHERE id = ?`
      ).get(item.link.id) as any;
      expect(link.last_synced_revision_id).toBe(item.revisionId);
      expect(link.last_synced_content_hash).toBe(item.contentHash);
      expect(link.sync_status).toBe("synced");
      expect(link.last_synced_sync_etag).toBe(item.syncEtag);
    } finally {
      db.close();
    }
  });
});
