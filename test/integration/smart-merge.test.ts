import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";

function sse(response: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`)
      );
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function makePromptAwareAI(decision: string, classification: string): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string, options: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") {
        return { data: [new Array(384).fill(0.1)] };
      }
      const prompt = (options?.messages ?? [])
        .map((message: any) => message.content)
        .join("\n");
      return sse(prompt.includes("Choose exactly one action") ? decision : classification);
    }),
  } as unknown as Ai;
}

function seedEntry(db: D1Mock) {
  db.entries.push({
    id: "existing-id",
    content: "I prefer dark mode",
    tags: '["work"]',
    source: "api",
    created_at: Date.now() - 1_000,
    vector_ids: '["existing-id"]',
    recall_count: 0,
    importance_score: 3,
    contradiction_wins: 0,
    contradiction_losses: 0,
  });
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as unknown as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

describe("POST /capture — similarity decision guardrails", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("blocks only exact content fingerprints without calling the LLM", async () => {
    const { contentFingerprint } = await import("../../src/index");
    const content = "Existing duplicate";
    const run = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") {
        return { data: [new Array(384).fill(0.1)] };
      }
      throw new Error("LLM should not be called");
    });
    db.entries.push({
      id: "duplicate",
      content,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["duplicate"]',
      content_hash: await contentFingerprint(content),
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "duplicate", score: 0.97, metadata: { parentId: "duplicate" } }],
        }),
      }),
      AI: { run } as unknown as Ai,
    });

    const response = await worker.fetch(
      req("POST", "/capture", { body: { content } }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext
    );
    const body = (await response.json()) as any;

    expect(body).toMatchObject({
      ok: true,
      duplicate: true,
      action: "source_linked",
      id: "duplicate",
    });
    expect(db.entries).toHaveLength(1);
    expect(db.observations).toHaveLength(1);
    expect(db.memorySources).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not block high vector similarity when content differs", async () => {
    db.entries.push({
      id: "near",
      content: "Server address is 192.168.1.10",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["near"]',
      content_hash: "hash-a",
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "near", score: 0.97, metadata: { parentId: "near" } }],
        }),
      }),
      AI: makePromptAwareAI(
        '{"action":"keep_both"}',
        '{"importance":3,"confidence":0.8,"canonical":false,"kind":"semantic"}'
      ),
    });

    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "Server address is 192.168.1.11" } }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext
    );
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(db.entries.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the new D1 fact and its relation when asynchronous vectorization fails", async () => {
    seedEntry(db);
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
        insert: vi.fn().mockRejectedValue(new Error("Vectorize down")),
      }),
      AI: makePromptAwareAI(
        '{"action":"replace","target_id":"existing-id"}',
        '{"importance":2,"confidence":0.8,"canonical":false,"kind":"semantic"}'
      ),
    });
    const { ctx, drain } = makeCtx();

    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "I switched to Cursor" } }),
      env,
      ctx
    );
    const body = (await response.json()) as any;
    await drain();

    expect(body).toMatchObject({ ok: true, action: "linked", relation: "supersedes" });
    expect(db.entries).toHaveLength(2);
    expect(db.entries[0].content).toBe("I prefer dark mode");
    expect(db.relations).toHaveLength(1);
  });

  it("classifies the newly added memory, never the existing target", async () => {
    seedEntry(db);
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing-id", score: 0.88, metadata: { parentId: "existing-id" } }],
        }),
      }),
      AI: makePromptAwareAI(
        '{"action":"merge","target_id":"existing-id","merged_content":"ignored"}',
        '{"importance":4,"confidence":0.9,"canonical":false,"kind":"semantic"}'
      ),
    });
    const { ctx, drain } = makeCtx();

    const response = await worker.fetch(
      req("POST", "/capture", { body: { content: "I like dark mode at night" } }),
      env,
      ctx
    );
    const body = (await response.json()) as any;
    await drain();

    const original = db.entries.find(entry => entry.id === "existing-id");
    const added = db.entries.find(entry => entry.id === body.id);
    expect(original.importance_score).toBe(3);
    expect(JSON.parse(original.tags)).not.toContain("kind:semantic");
    expect(added.importance_score).toBe(4);
    expect(JSON.parse(added.tags)).toContain("kind:semantic");
  });
});
