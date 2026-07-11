import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any,
    drain: () => Promise.allSettled(pending),
  };
}

function makeClassificationAI() {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(controller) {
          const response = '{"importance":4,"confidence":0.9,"canonical":false,"kind":"semantic"}';
          controller.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
    }),
  } as unknown as Ai;
}

describe("POST /capture", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("stores importance_score after async AI scoring completes", async () => {
    env = makeTestEnv(db, { AI: makeClassificationAI() });
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Decided to switch to TypeScript for all new projects" } }), env, ctx);
    expect(res.status).toBe(200);
    await drain();
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].importance_score).toBeGreaterThanOrEqual(1);
    expect(db.entries[0].importance_score).toBeLessThanOrEqual(5);
  });

  it("returns 400 when content is missing", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: {} }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is whitespace-only", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "   " } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("dry-runs extraction backlog without invoking the LLM", async () => {
    const run = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      throw new Error("LLM should not be called during dry-run");
    });
    env = makeTestEnv(db, { AI: { run } as unknown as Ai });
    db.observations.push({
      id: "orphan-pending",
      content: "legacy orphan",
      source: "api",
      metadata_json: "{}",
      extraction_status: "pending",
      extraction_attempts: 0,
      next_attempt_at: null,
      processing_started_at: null,
      extraction_version: 1,
      needs_reprocess: 0,
      created_at: 1,
    });

    const { ctx } = makeCtx();
    const res = await worker.fetch(req("GET", "/extract-pending?dryRun=true&limit=3"), env, ctx);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      dryRun: true,
      limit: 3,
      due: 1,
      orphanPending: 1,
    });
    expect(db.observations[0].extraction_status).toBe("pending");
    expect(run).not.toHaveBeenCalled();
  });

  it("stores valid entry and returns id", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Test note" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(typeof data.id).toBe("string");
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("Test note");
  });

  it("still stores near-exact semantic matches (score ≥ 0.95) instead of hard-blocking", async () => {
    db.entries.push({
      id: "existing",
      content: "Existing duplicate note",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["existing"]',
      content_hash: "hash-existing",
    });
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "existing", score: 0.97, metadata: { parentId: "existing" } }],
      }),
    });
    env = makeTestEnv(db, { VECTORIZE: vectorize });

    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Duplicate note" } }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.duplicate).not.toBe(true);
    expect(db.entries).toHaveLength(2);
  });

  it("does not block capture from an orphaned stale vector", async () => {
    db.entries.push({
      id: "existing",
      content: "Current unrelated fact",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["g-current"]',
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{
            id: "g-stale",
            score: 0.99,
            metadata: { parentId: "existing", content: "Old matching fact" },
          }],
        }),
      }),
    });

    const { ctx } = makeCtx();
    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "Old matching fact" } }),
      env,
      ctx
    );
    const data = await response.json() as any;

    expect(data.ok).toBe(true);
    expect(data.duplicate).not.toBe(true);
    expect(db.entries).toHaveLength(2);
  });

  it("does not use a deprecated memory for duplicate detection", async () => {
    db.entries.push({
      id: "deprecated",
      content: "Deprecated matching fact",
      tags: '["status:deprecated"]',
      source: "api",
      created_at: Date.now(),
      vector_ids: '["g-deprecated"]',
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{
            id: "g-deprecated",
            score: 0.99,
            metadata: { parentId: "deprecated", content: "Deprecated matching fact" },
          }],
        }),
      }),
    });

    const { ctx } = makeCtx();
    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "Deprecated matching fact" } }),
      env,
      ctx
    );
    const data = await response.json() as any;

    expect(data.ok).toBe(true);
    expect(data.duplicate).not.toBe(true);
    expect(db.entries).toHaveLength(2);
  });

  it("blocks exact content via fingerprint without requiring a vector query", async () => {
    const { contentFingerprint } = await import("../../src/index");
    const content = "Active duplicate";
    db.entries.push({
      id: "existing",
      content,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["g-active"]',
      content_hash: await contentFingerprint(content),
    });
    const queryMock = vi.fn().mockResolvedValue({ matches: [] });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: queryMock }),
    });

    const { ctx } = makeCtx();
    const response = await worker.fetch(
      req("POST", "/capture", { body: { content } }),
      env,
      ctx
    );
    const data = await response.json() as any;

    expect(data).toMatchObject({
      ok: true,
      duplicate: true,
      action: "source_linked",
      id: "existing",
    });
    expect(db.observations).toHaveLength(1);
    expect(db.memorySources).toHaveLength(1);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("overfetches before filtering so high-similarity linking still sees active vectors", async () => {
    db.entries.push({
      id: "existing",
      content: "Server address is 192.168.1.10",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["g-active"]',
      content_hash: "hash-old",
    });
    const ranked = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `g-stale-${index}`,
        score: 0.99 - index * 0.001,
        metadata: { parentId: "existing", content: "Server address is 192.168.1.10" },
      })),
      {
        id: "g-active",
        score: 0.96,
        metadata: { parentId: "existing", content: "Server address is 192.168.1.10" },
      },
    ];
    const queryMock = vi.fn().mockImplementation(
      async (_values: number[], options: { topK: number }) => ({
        matches: ranked.slice(0, options.topK),
      })
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: queryMock }),
    });

    const { ctx } = makeCtx();
    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "Server address is 192.168.1.11" } }),
      env,
      ctx
    );
    const data = await response.json() as any;

    // Different content must ADD (never hard-block by vector score).
    expect(data.duplicate).not.toBe(true);
    expect(data.ok).toBe(true);
    expect(queryMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ topK: 50 })
    );
    expect(db.entries.length).toBe(2);
  });

  it("extracts hashtags from content and stores clean content with tags", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "went for a run #health #fitness" } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("went for a run");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("health");
    expect(tags).toContain("fitness");
  });

  it("merges hashtag tags with explicit tags and deduplicates case-insensitively", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "note #health", tags: ["Health", "fitness"] } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    const healthCount = tags.filter(t => t === "health").length;
    expect(healthCount).toBe(1);
    expect(tags).toContain("fitness");
  });

  it("behaves identically when no hashtags are present (regression)", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "plain note", tags: ["work"] } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    expect(db.entries[0].content).toBe("plain note");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toEqual(["work"]);
  });

  it("falls back to original content when input is only hashtags", async () => {
    const { ctx, drain } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "#task" } }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    expect(db.entries[0].content).toBe("#task");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("task");
  });

  it("stores flagged similarity as a linked memory with duplicate-candidate tag", async () => {
    db.entries.push({
      id: "near",
      content: "Near existing note",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["near"]',
    });
    const vectorize = makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "near", score: 0.88, metadata: { parentId: "near" } }],
      }),
    });
    env = makeTestEnv(db, { VECTORIZE: vectorize });

    const { ctx } = makeCtx();
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "Similar note" } }), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.action).toBe("linked");
    expect(data.relation).toBe("similar");
    expect(data.linked_id).toBe("near");
    expect(db.entries).toHaveLength(2);
    const tags = JSON.parse(db.entries.find((entry) => entry.id === data.id)!.tags);
    expect(tags).toContain("duplicate-candidate");
  });
});
