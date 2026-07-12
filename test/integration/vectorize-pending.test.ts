import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { captureEntry } from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function pastGraceEntry(id: string) {
  return {
    id,
    content: `Content for ${id}`,
    tags: '["work"]',
    source: "api",
    created_at: Date.now() - 600000, // 10 minutes ago — past default 5-min grace
    vector_ids: "[]",
    recall_count: 0,
    importance_score: 0,
  };
}

describe("POST /vectorize-pending", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns { processed: 0, failed: 0, remaining: 0 } when no past-grace entries", async () => {
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("processes past-grace entries and returns correct counts", async () => {
    db.entries.push(pastGraceEntry("e1"), pastGraceEntry("e2"));
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("batches embeddings across multiple pending entries", async () => {
    db.entries.push(pastGraceEntry("e1"), pastGraceEntry("e2"), pastGraceEntry("e3"));

    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);

    const embeddingCalls = ((env.AI.run as any).mock.calls as any[])
      .filter(([model]) => model === "@cf/baai/bge-small-en-v1.5");
    expect(embeddingCalls).toHaveLength(1);
    expect(embeddingCalls[0][1].text).toHaveLength(3);
  });

  it("updates vector_ids in D1 after successful re-embed", async () => {
    db.entries.push(pastGraceEntry("fix-me"));
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const updated = db.entries.find((e: any) => e.id === "fix-me");
    const ids = JSON.parse(updated.vector_ids);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("batches chunk embeddings for a single large pending entry", async () => {
    db.entries.push({
      ...pastGraceEntry("chunked"),
      content: "batch embedding ".repeat(180),
    });

    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);

    const embeddingCalls = ((env.AI.run as any).mock.calls as any[])
      .filter(([model]) => model === "@cf/baai/bge-small-en-v1.5");
    expect(embeddingCalls).toHaveLength(1);
    expect(embeddingCalls[0][1].text.length).toBeGreaterThan(1);
  });

  it("skips entries within the grace window (vector_ids=[] but recent)", async () => {
    db.entries.push({
      id: "pending",
      content: "Just captured",
      tags: "[]",
      source: "api",
      created_at: Date.now(), // within grace window
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("skips entries that already have vector_ids populated", async () => {
    db.entries.push({
      id: "already-done",
      content: "Already vectorized",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 600000,
      vector_ids: '["already-done"]',
      recall_count: 0,
      importance_score: 0,
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
  });

  it("does not re-vectorize deprecated memories", async () => {
    db.entries.push({
      ...pastGraceEntry("deprecated"),
      tags: '["work","status:deprecated"]',
    });
    const insertMock = vi.fn();
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ insert: insertMock }),
    });

    const response = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await response.json() as any;

    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("counts failed and continues when storeEntry throws for one entry", async () => {
    db.entries.push(pastGraceEntry("bad"), pastGraceEntry("good"));
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockImplementation((vectors: any[]) => {
          if (vectors.some((vector) => vector.metadata?.parentId === "bad")) {
            throw new Error("Vectorize error");
          }
          return Promise.resolve({ mutationId: "m" });
        }),
      }),
    });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.remaining).toBe(1);
  });

  it("respects VECTORIZE_GRACE_MS env var", async () => {
    // entry 90s old — past 60s grace but within default 300s
    db.entries.push({
      id: "e90",
      content: "90-second-old memory",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 90000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    env = makeTestEnv(db, { VECTORIZE_GRACE_MS: "60000" });
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
  });

  it("queues blue-green reindex without clearing active vector ids", async () => {
    db.entries.push({
      ...pastGraceEntry("active"),
      vector_ids: '["active-old"]',
    });
    const clearAll = vi.fn();
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ clearAll } as any),
    });

    const res = await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const data = await res.json() as any;

    expect(data.mode).toBe("blue_green");
    expect(data.clearedVectors).toBe(0);
    expect(data.entriesQueued).toBe(1);
    expect(clearAll).not.toHaveBeenCalled();
    expect(db.entries[0].vector_ids).toBe('["active-old"]');
    expect(db.entries[0].pending_vector_ids).toBe("[]");
    expect(db.entries[0].pending_embedding_fingerprint).toBe(data.pendingFingerprint);
  });

  it("keeps a newly saved embedding config pending when active vectors already exist", async () => {
    db.entries.push({
      ...pastGraceEntry("active"),
      vector_ids: '["active-old"]',
    });

    const res = await worker.fetch(
      req("PUT", "/settings/models", {
        body: {
          embedding: {
            provider: "custom",
            baseURL: "https://embed-new.example/v1",
            apiKey: "new-key",
            model: "new-embedding",
            dimensions: 768,
            supportsDimensionsParameter: false,
          },
        },
      }),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.reindexRequired).toBe(true);
    expect(data.settings.embedding.model).toBe("new-embedding");
    expect(data.settings.pendingEmbedding.model).toBe("new-embedding");
    expect(data.settings.activeEmbedding.provider).toBe("none");
    expect(data.settings.embeddingFingerprint).not.toBe(data.settings.pendingEmbeddingFingerprint);
    expect(db.entries[0].vector_ids).toBe('["active-old"]');
  });

  it("activates pending vectors only after the blue-green queue is complete", async () => {
    db.entries.push({
      ...pastGraceEntry("active"),
      vector_ids: '["active-old"]',
    });

    const reindex = await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const reindexData = await reindex.json() as any;
    expect(db.entries[0].vector_ids).toBe('["active-old"]');

    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    const activeIds = JSON.parse(db.entries[0].vector_ids);

    expect(data.mode).toBe("blue_green");
    expect(data.processed).toBe(1);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
    expect(data.activated).toBe(1);
    expect(data.staleVectorsDeleted).toBe(0);
    expect(data.staleVectorsQueued).toBe(0);
    expect(data.cleanupBatchesPrepared).toBe(1);
    expect(data.cleanupBatchesReady).toBe(1);
    expect(env.VECTORIZE.deleteByIds).not.toHaveBeenCalled();
    expect(db.vectorCleanupBatches).toHaveLength(1);
    expect(db.vectorCleanupBatches[0]).toMatchObject({
      rebuild_id: reindexData.rebuildId,
      state: "ready",
    });
    expect(JSON.parse(db.vectorCleanupBatches[0].vector_ids_json)).toEqual(["active-old"]);
    expect(activeIds).toHaveLength(1);
    expect(activeIds[0]).not.toBe("active-old");
    expect(db.entries[0].pending_vector_ids).toBeNull();
    expect(db.entries[0].pending_embedding_fingerprint).toBeNull();
    expect(db.entries[0].pending_revision_id).toBeNull();
    expect(db.entries[0].pending_rebuild_id).toBeNull();
    expect(db.entries[0].embedding_fingerprint).toBe(reindexData.pendingFingerprint);
  });

  it("joins newly captured memories to an open rebuild before async vectorization finishes", async () => {
    db.entries.push({
      ...pastGraceEntry("active"),
      vector_ids: '["active-old"]',
      content_hash: "active-hash",
    });

    const reindex = await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const reindexData = await reindex.json() as any;
    const waits: Promise<any>[] = [];
    const captureCtx = {
      waitUntil: (promise: Promise<any>) => waits.push(promise),
    } as any;

    const result = await captureEntry(
      "New memory created during rebuild",
      ["work"],
      "api",
      env,
      captureCtx,
      { skipExtract: true }
    );
    await Promise.all(waits);

    expect(result.status).toBe("stored");
    if (result.status !== "stored") return;
    const created = db.entries.find((entry: any) => entry.id === result.id);
    expect(created.pending_rebuild_id).toBe(reindexData.rebuildId);
    expect(created.pending_embedding_fingerprint).toBe(reindexData.pendingFingerprint);
    expect(created.pending_vector_ids).toBe("[]");
    expect(db.vectorRebuilds[0].expected_entries).toBe(2);
  });

  it("reconciles a current non-deprecated entry that has not joined the rebuild", async () => {
    db.entries.push({
      ...pastGraceEntry("active"),
      vector_ids: '["active-old"]',
      content_hash: "active-hash",
    });

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    db.entries.push({
      ...pastGraceEntry("unjoined"),
      vector_ids: '["unjoined-active"]',
      content_hash: "unjoined-hash",
      pending_vector_ids: null,
      pending_embedding_fingerprint: null,
      pending_content_hash: null,
      pending_revision_id: null,
      pending_rebuild_id: null,
    });

    const res = await worker.fetch(
      req("POST", "/vectorize-pending", { body: { includeRecent: true } }),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(data.mode).toBe("blue_green");
    expect(data.reconciledEntries).toBe(1);
    expect(data.processed).toBe(2);
    expect(data.remaining).toBe(0);
    expect(data.activated).toBe(2);
    expect(data.activationState).toBe("active");
    expect(data.activationIntegrity).toEqual({ activatable: 2, blocked: 0 });
    expect(db.entries.find((entry: any) => entry.id === "active").vector_ids).not.toBe('["active-old"]');
  });

  it("deletes ready stale active vector batches during scheduled cleanup", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "delete" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds }),
    });
    db.entries.push({
      ...pastGraceEntry("active"),
      vector_ids: '["active-old"]',
    });

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.activated).toBe(1);
    expect(data.staleVectorsDeleted).toBe(0);
    expect(data.staleVectorsQueued).toBe(0);
    expect(db.entries[0].vector_ids).not.toBe('["active-old"]');
    expect(db.vectorCleanupBatches).toHaveLength(1);
    expect(db.vectorCleanupBatches[0].state).toBe("ready");
    expect(deleteByIds).not.toHaveBeenCalled();

    const pending: Promise<any>[] = [];
    await (worker as any).scheduled({} as any, env, {
      waitUntil: (promise: Promise<any>) => pending.push(promise),
    } as any);
    await Promise.all(pending);

    expect(deleteByIds).toHaveBeenCalledWith(["active-old"]);
    expect(db.vectorCleanupBatches[0].state).toBe("completed");
  });

  it("splits cleanup batches so referenced vectors retry without blocking deletable vectors", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "delete" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds }),
    });
    db.entries.push({
      ...pastGraceEntry("holder"),
      vector_ids: '["still-active"]',
    });
    db.vectorCleanupBatches.push({
      id: "cleanup-1",
      rebuild_id: "rebuild-1",
      vector_ids_json: '["still-active","orphaned"]',
      state: "ready",
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      created_at: Date.now() - 1000,
      updated_at: Date.now() - 1000,
    });

    const pending: Promise<any>[] = [];
    await (worker as any).scheduled({} as any, env, {
      waitUntil: (promise: Promise<any>) => pending.push(promise),
    } as any);
    await Promise.all(pending);

    expect(deleteByIds).toHaveBeenCalledWith(["orphaned"]);
    expect(db.vectorCleanupBatches[0].state).toBe("ready");
    expect(JSON.parse(db.vectorCleanupBatches[0].vector_ids_json)).toEqual(["still-active"]);
    expect(db.vectorCleanupBatches[0].last_error).toBe("vector_still_referenced:1");
    expect(db.vectorCleanupBatches[0].attempts).toBe(1);
    expect(db.vectorCleanupBatches[0].next_attempt_at).toEqual(expect.any(Number));
    expect(db.vectorCleanupBatches[0].next_attempt_at).toBeGreaterThanOrEqual(
      db.vectorCleanupBatches[0].updated_at + 5 * 60_000
    );
  });

  it("batches pending blue-green rebuild embeddings across entries", async () => {
    db.entries.push(
      {
        ...pastGraceEntry("active-1"),
        vector_ids: '["active-1-old"]',
      },
      {
        ...pastGraceEntry("active-2"),
        vector_ids: '["active-2-old"]',
      }
    );

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);

    const embeddingCalls = ((env.AI.run as any).mock.calls as any[])
      .filter(([model]) => model === "@cf/baai/bge-small-en-v1.5");
    expect(embeddingCalls).toHaveLength(1);
    expect(embeddingCalls[0][1].text).toHaveLength(2);
    expect(db.entries.every((entry: any) => entry.pending_vector_ids == null)).toBe(true);
  });

  it("does not activate blue-green vectors while recent pending rows remain in grace", async () => {
    db.entries.push(
      {
        ...pastGraceEntry("old"),
        vector_ids: '["old-active"]',
      },
      {
        id: "recent",
        content: "Recent memory",
        tags: "[]",
        source: "api",
        created_at: Date.now(),
        vector_ids: '["recent-active"]',
        recall_count: 0,
        importance_score: 0,
      }
    );

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const res = await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const data = await res.json() as any;
    const old = db.entries.find((entry: any) => entry.id === "old");
    const recent = db.entries.find((entry: any) => entry.id === "recent");

    expect(data.mode).toBe("blue_green");
    expect(data.processed).toBe(1);
    expect(data.remaining).toBe(1);
    expect(data.activated).toBe(0);
    expect(old.vector_ids).toBe('["old-active"]');
    expect(old.pending_vector_ids).not.toBe("[]");
    expect(old.pending_revision_id).toBeTruthy();
    expect(recent.vector_ids).toBe('["recent-active"]');
    expect(recent.pending_vector_ids).toBe("[]");
  });

  it("repairs stale pending content vectors and then activates blue-green rebuild", async () => {
    db.entries.push(
      {
        ...pastGraceEntry("old"),
        vector_ids: '["old-active"]',
      },
      {
        id: "recent",
        content: "Recent memory",
        tags: "[]",
        source: "api",
        created_at: Date.now(),
        vector_ids: '["recent-active"]',
        recall_count: 0,
        importance_score: 0,
      }
    );

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const old = db.entries.find((entry: any) => entry.id === "old");
    expect(old.pending_vector_ids).not.toBe("[]");
    expect(old.pending_content_hash).toBeTruthy();
    expect(old.pending_revision_id).toBeTruthy();

    old.content = "Edited after pending vector build";
    old.content_hash = "edited-content-hash";

    const res = await worker.fetch(
      req("POST", "/vectorize-pending", { body: { includeRecent: true } }),
      env,
      ctx
    );
    const data = await res.json() as any;
    const recent = db.entries.find((entry: any) => entry.id === "recent");

    expect(data.mode).toBe("blue_green");
    expect(data.remaining).toBe(0);
    expect(data.repairedPendingGenerations).toBe(1);
    expect(data.activated).toBe(2);
    expect(data.activationBlocked).toBe(0);
    expect(data.activationIntegrity).toEqual({ activatable: 2, blocked: 0 });
    expect(old.vector_ids).not.toBe('["old-active"]');
    expect(old.pending_vector_ids).toBeNull();
    expect(recent.vector_ids).not.toBe('["recent-active"]');
    expect(recent.pending_vector_ids).toBeNull();
  });

  it("repairs stale pending metadata vectors and then activates blue-green rebuild", async () => {
    db.entries.push(
      {
        ...pastGraceEntry("old"),
        vector_ids: '["old-active"]',
      },
      {
        id: "recent",
        content: "Recent memory",
        tags: "[]",
        source: "api",
        created_at: Date.now(),
        vector_ids: '["recent-active"]',
        recall_count: 0,
        importance_score: 0,
      }
    );

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const old = db.entries.find((entry: any) => entry.id === "old");
    expect(old.pending_vector_ids).not.toBe("[]");
    expect(old.pending_metadata_hash).toBeTruthy();

    old.tags = '["work","kind:semantic"]';
    old.metadata_hash = "metadata-changed-after-pending-build";

    const res = await worker.fetch(
      req("POST", "/vectorize-pending", { body: { includeRecent: true } }),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(data.mode).toBe("blue_green");
    expect(data.remaining).toBe(0);
    expect(data.repairedPendingGenerations).toBe(1);
    expect(data.activated).toBe(2);
    expect(data.activationBlocked).toBe(0);
    expect(data.activationIntegrity).toEqual({ activatable: 2, blocked: 0 });
    expect(old.vector_ids).not.toBe('["old-active"]');
    expect(old.pending_vector_ids).toBeNull();
  });

  it("invalidates pending vectors when status metadata changes and then activates rebuild", async () => {
    db.entries.push(
      {
        ...pastGraceEntry("old"),
        vector_ids: '["old-active"]',
      },
      {
        id: "recent",
        content: "Recent memory",
        tags: "[]",
        source: "api",
        created_at: Date.now(),
        vector_ids: '["recent-active"]',
        recall_count: 0,
        importance_score: 0,
      }
    );

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const old = db.entries.find((entry: any) => entry.id === "old");
    const stalePendingIds = JSON.parse(old.pending_vector_ids);
    expect(stalePendingIds.length).toBeGreaterThan(0);
    expect(old.pending_metadata_hash).toBeTruthy();

    const statusRes = await worker.fetch(
      req("POST", "/status", { body: { id: "old", status: "canonical" } }),
      env,
      ctx
    );
    const statusData = await statusRes.json() as any;

    expect(statusRes.status).toBe(200);
    expect(statusData.ok).toBe(true);
    expect(old.pending_vector_ids).toBe("[]");
    expect(old.pending_content_hash).toBeNull();
    expect(old.pending_revision_id).toBeNull();
    expect(old.pending_metadata_hash).toBeNull();
    expect(db.vectorCleanupQueue.map((item: any) => item.vector_id)).toEqual(stalePendingIds);
    expect(db.vectorCleanupQueue.every((item: any) => item.reason === "status_metadata_changed")).toBe(true);

    const res = await worker.fetch(
      req("POST", "/vectorize-pending", { body: { includeRecent: true } }),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(data.mode).toBe("blue_green");
    expect(data.repairedPendingGenerations).toBe(0);
    expect(data.activated).toBe(2);
    expect(data.activationBlocked).toBe(0);
    expect(data.activationIntegrity).toEqual({ activatable: 2, blocked: 0 });
    expect(old.vector_ids).not.toBe('["old-active"]');
    expect(old.pending_vector_ids).toBeNull();
  });

  it("does not overwrite a fresh pending generation written during stale repair", async () => {
    db.entries.push({
      ...pastGraceEntry("old"),
      vector_ids: '["old-active"]',
      content_hash: "content-current",
      metadata_hash: "metadata-current",
    });

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const rebuild = db.vectorRebuilds[0];
    const old = db.entries[0];
    old.pending_vector_ids = '["stale-pending"]';
    old.pending_embedding_fingerprint = rebuild.pending_fingerprint;
    old.pending_rebuild_id = rebuild.id;
    old.pending_revision_id = "stale-revision";
    old.pending_content_hash = "content-stale";
    old.pending_metadata_hash = "metadata-stale";

    db.beforePendingGenerationReset = (row: any) => {
      row.pending_vector_ids = '["fresh-pending"]';
      row.pending_revision_id = "fresh-revision";
      row.pending_content_hash = row.content_hash;
      row.pending_metadata_hash = row.metadata_hash;
    };

    const res = await worker.fetch(
      req("POST", "/vectorize-pending", { body: { includeRecent: true } }),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(data.repairedPendingGenerations).toBe(0);
    expect(data.remaining).toBe(0);
    expect(data.activated).toBe(1);
    expect(old.vector_ids).toBe('["fresh-pending"]');
    expect(db.vectorCleanupQueue.map((item: any) => item.vector_id)).toEqual(["stale-pending"]);
    expect(db.vectorCleanupQueue[0].reason).toBe("pending_generation_stale");
  });

  it("queues displaced pending vectors before reconcile attaches an entry to the current rebuild", async () => {
    db.entries.push({
      ...pastGraceEntry("old"),
      vector_ids: '["old-active"]',
    });

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const old = db.entries[0];
    old.pending_vector_ids = '["old-rebuild-pending"]';
    old.pending_embedding_fingerprint = "old-fingerprint";
    old.pending_rebuild_id = "old-rebuild";
    old.pending_revision_id = "old-revision";
    old.pending_content_hash = "old-content";
    old.pending_metadata_hash = "old-metadata";

    const res = await worker.fetch(
      req("POST", "/vectorize-pending", { body: { includeRecent: true } }),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(data.reconciledEntries).toBe(1);
    expect(data.remaining).toBe(0);
    expect(data.activated).toBe(1);
    expect(db.vectorCleanupQueue.map((item: any) => item.vector_id)).toEqual(["old-rebuild-pending"]);
    expect(db.vectorCleanupQueue[0].reason).toBe("rebuild_reconcile_displaced_pending");
  });

  it("counts unrepaired stale pending rows in remaining when repair limit is reached", async () => {
    for (let index = 0; index < 60; index++) {
      db.entries.push({
        ...pastGraceEntry(`stale-${index}`),
        vector_ids: `["active-${index}"]`,
        content_hash: `content-current-${index}`,
        metadata_hash: `metadata-current-${index}`,
      });
    }

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const rebuild = db.vectorRebuilds[0];
    for (let index = 0; index < 60; index++) {
      const row = db.entries[index];
      row.pending_vector_ids = `["stale-pending-${index}"]`;
      row.pending_embedding_fingerprint = rebuild.pending_fingerprint;
      row.pending_rebuild_id = rebuild.id;
      row.pending_revision_id = `stale-revision-${index}`;
      row.pending_content_hash = `content-stale-${index}`;
      row.pending_metadata_hash = `metadata-stale-${index}`;
    }

    const res = await worker.fetch(
      req("POST", "/vectorize-pending", { body: { includeRecent: true, limit: 200 } }),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(data.repairedPendingGenerations).toBe(50);
    expect(data.pendingQueueRemaining).toBe(0);
    expect(data.stalePendingRemaining).toBe(10);
    expect(data.unjoinedRemaining).toBe(0);
    expect(data.remaining).toBe(10);
    expect(data.activationState).toBe("building");
    expect(data.activated).toBe(0);
  });

  it("rejects starting a second rebuild while pending vectors are still referenced", async () => {
    db.entries.push(
      {
        ...pastGraceEntry("old"),
        vector_ids: '["old-active"]',
      },
      {
        id: "recent",
        content: "Recent memory",
        tags: "[]",
        source: "api",
        created_at: Date.now(),
        vector_ids: '["recent-active"]',
        recall_count: 0,
        importance_score: 0,
      }
    );

    const first = await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const firstData = await first.json() as any;
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);

    const res = await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(409);
    expect(data.error).toBe("rebuild_already_running");
    expect(data.pendingFingerprint).toBe(firstData.pendingFingerprint);
    expect(data.pendingRows).toBe(2);
  });

  it("can explicitly cancel an existing pending rebuild before starting a new one", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "delete" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds }),
    });
    db.entries.push(
      {
        ...pastGraceEntry("old"),
        vector_ids: '["old-active"]',
      },
      {
        id: "recent",
        content: "Recent memory",
        tags: "[]",
        source: "api",
        created_at: Date.now(),
        vector_ids: '["recent-active"]',
        recall_count: 0,
        importance_score: 0,
      }
    );

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const oldPendingIds = JSON.parse(
      db.entries.find((entry: any) => entry.id === "old").pending_vector_ids
    );

    const res = await worker.fetch(
      req("POST", "/settings/models/reindex", { body: { cancelExisting: true } }),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.cancelledExisting).toBe(true);
    expect(data.cancelledEntriesCleared).toBe(2);
    expect(data.cancelledPendingVectorsDeleted).toBe(0);
    expect(data.cancelledPendingVectorsQueued).toBe(oldPendingIds.length);
    expect(data.cancelledCleanupBatchesPrepared).toBe(1);
    expect(data.entriesQueued).toBe(2);
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(db.vectorCleanupBatches).toHaveLength(1);
    expect(JSON.parse(db.vectorCleanupBatches[0].vector_ids_json)).toEqual(oldPendingIds);
    expect(db.vectorCleanupBatches[0].state).toBe("ready");
    expect(db.entries.every((entry: any) => entry.pending_vector_ids === "[]")).toBe(true);
    expect(db.entries.every((entry: any) => entry.pending_revision_id == null)).toBe(true);
    expect(db.entries.every((entry: any) => entry.pending_rebuild_id != null)).toBe(true);
  });

  it("cancels a pending blue-green rebuild and prepares pending vectors for durable cleanup", async () => {
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "delete" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds }),
    });
    db.entries.push(
      {
        ...pastGraceEntry("old"),
        vector_ids: '["old-active"]',
      },
      {
        id: "recent",
        content: "Recent memory",
        tags: "[]",
        source: "api",
        created_at: Date.now(),
        vector_ids: '["recent-active"]',
        recall_count: 0,
        importance_score: 0,
      }
    );

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const pendingIds = JSON.parse(
      db.entries.find((entry: any) => entry.id === "old").pending_vector_ids
    );

    const res = await worker.fetch(
      req("POST", "/settings/models/reindex/cancel"),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.cancelled).toBe(true);
    expect(data.pendingVectorsDeleted).toBe(0);
    expect(data.pendingVectorsQueued).toBe(pendingIds.length);
    expect(data.cleanupBatchesPrepared).toBe(1);
    expect(data.entriesCleared).toBe(2);
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(db.vectorCleanupBatches).toHaveLength(1);
    expect(JSON.parse(db.vectorCleanupBatches[0].vector_ids_json)).toEqual(pendingIds);
    expect(db.vectorCleanupBatches[0].state).toBe("ready");
    expect(db.entries.every((entry: any) => entry.pending_vector_ids == null)).toBe(true);
    expect(db.entries.every((entry: any) => entry.pending_embedding_fingerprint == null)).toBe(true);
    expect(db.entries.every((entry: any) => entry.pending_revision_id == null)).toBe(true);
    expect(db.entries.every((entry: any) => entry.pending_rebuild_id == null)).toBe(true);
    expect(db.entries[0].vector_ids).toBe('["old-active"]');
    expect(db.entries[1].vector_ids).toBe('["recent-active"]');
  });
});
