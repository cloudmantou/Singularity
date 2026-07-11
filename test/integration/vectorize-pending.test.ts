import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
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
    let callCount = 0;
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) throw new Error("Vectorize error");
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
    expect(activeIds).toHaveLength(1);
    expect(activeIds[0]).not.toBe("active-old");
    expect(db.entries[0].pending_vector_ids).toBeNull();
    expect(db.entries[0].pending_embedding_fingerprint).toBeNull();
    expect(db.entries[0].embedding_fingerprint).toBe(reindexData.pendingFingerprint);
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
    expect(recent.vector_ids).toBe('["recent-active"]');
    expect(recent.pending_vector_ids).toBe("[]");
  });
});
