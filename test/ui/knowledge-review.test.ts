import { describe, expect, it, vi } from "vitest";

const {
  buildConflictDecision,
  createKnowledgeReviewApi,
  normalizeReviewQueues,
} = require("../../public/knowledge-review.js");

describe("Knowledge Review UI module", () => {
  it("normalizes all three server review queues without sharing source objects", () => {
    const payload = normalizeReviewQueues({
      conflicts: { conflicts: [{ id: "conflict-1" }] },
      entities: { candidates: [{ id: "entity-1" }] },
      memories: { candidates: [{ id: "memory-1" }] },
    });

    expect(payload.counts).toEqual({ conflicts: 1, entities: 1, memories: 1, total: 3 });
    expect(payload.conflicts).toEqual([{ id: "conflict-1" }]);
    expect(payload.entities).toEqual([{ id: "entity-1" }]);
    expect(payload.memories).toEqual([{ id: "memory-1" }]);
    expect(payload.conflicts).not.toBe(payload.entities);
  });

  it("maps explicit conflict decisions to fail-closed server outcomes", () => {
    expect(buildConflictDecision("use_new")).toEqual({
      state: "resolved",
      resolution: "use_new",
    });
    expect(buildConflictDecision("dismissed")).toEqual({
      state: "dismissed",
      resolution: "dismissed",
    });
    expect(() => buildConflictDecision("manual")).toThrow("unsupported_conflict_decision");
  });

  it("loads queues concurrently and authenticates every request", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => url.includes("conflict-cases")
        ? { ok: true, conflicts: [] }
        : { ok: true, candidates: [] },
      init,
    }));
    const api = createKnowledgeReviewApi({
      getBaseUrl: () => "https://memory.example/",
      getToken: () => "private-token",
      fetchImpl,
    });

    const queues = await api.loadQueues();

    expect(queues.counts.total).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer private-token" });
    }
  });

  it("does not reflect an upstream HTML error body", async () => {
    const api = createKnowledgeReviewApi({
      getBaseUrl: () => "https://memory.example",
      getToken: () => "token",
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => { throw new Error("not json"); },
      })),
    });

    await expect(api.loadQueues()).rejects.toThrow("review_request_failed (HTTP 502)");
  });
});
