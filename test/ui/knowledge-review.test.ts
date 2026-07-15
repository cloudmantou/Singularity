import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const {
  buildConflictDecision,
  createKnowledgeReviewApi,
  nextReviewTab,
  normalizeReviewQueues,
} = require("../../public/knowledge-review.js");

const reviewHtml = readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");

describe("Knowledge Review UI module", () => {
  it("normalizes all three server review queues without sharing source objects", () => {
    const payload = normalizeReviewQueues({
      conflicts: { conflicts: [{ id: "conflict-1" }] },
      entities: { candidates: [{ id: "entity-1" }] },
      memories: { candidates: [{ id: "memory-1" }] },
    });

    expect(payload.counts).toEqual({ conflicts: 1, entities: 1, memories: 1, total: 3 });
    expect(payload.conflicts).toEqual([{ id: "conflict-1", aiReview: null }]);
    expect(payload.entities).toEqual([{ id: "entity-1", aiReview: null }]);
    expect(payload.memories).toEqual([{ id: "memory-1", aiReview: null }]);
    expect(payload.conflicts).not.toBe(payload.entities);
  });

  it("attaches the latest immutable AI review to its matching queue item", () => {
    const missingContext = ["scope_context"];
    const keyDifferences = [{
      dimension: "scope",
      status: "missing",
      summary: "The scopes are not identified.",
      evidenceRefs: ["OLD", "NEW"],
    }];
    const sourceChannels = ["obsidian"];
    const payload = normalizeReviewQueues({
      conflicts: { conflicts: [{ id: "conflict-1" }] },
      entities: { candidates: [{ id: "entity-1" }] },
      memories: { candidates: [{ id: "memory-1" }] },
      aiReviews: { reviews: [{
        id: "job-1",
        objectType: "conflict_case",
        objectId: "conflict-1",
        status: "completed",
        context: { evidence: [{ ref: "OLD", sourceChannels, scopeIds: ["production"] }] },
        run: {
          id: "run-1",
          decision: "uncertain",
          reviewability: "partial",
          missingContext,
          keyDifferences,
          requiresHuman: true,
        },
      }] },
    });

    expect(payload.conflicts[0].aiReview).toMatchObject({
      id: "job-1",
      run: {
        id: "run-1",
        decision: "uncertain",
        reviewability: "partial",
        missingContext: ["scope_context"],
      },
    });
    expect(payload.conflicts[0].aiReview.run.missingContext).not.toBe(missingContext);
    expect(payload.conflicts[0].aiReview.run.keyDifferences).not.toBe(keyDifferences);
    expect(payload.conflicts[0].aiReview.run.keyDifferences[0].evidenceRefs)
      .not.toBe(keyDifferences[0].evidenceRefs);
    expect(payload.conflicts[0].aiReview.context.evidence[0].sourceChannels)
      .not.toBe(sourceChannels);
    expect(payload.entities[0].aiReview).toBeNull();
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

  it("requests AI review separately from applying its immutable run", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, id: "ai-job-1" }),
    }));
    const api = createKnowledgeReviewApi({
      getBaseUrl: () => "https://memory.example",
      getToken: () => "private-token",
      fetchImpl,
    });

    await api.requestAIReview("conflict_case", "conflict-1", "suggest");
    await api.applyAIReview("ai-run-1");

    expect(fetchImpl.mock.calls[0][0]).toContain("/quality/ai-review");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({
      objectType: "conflict_case",
      objectId: "conflict-1",
      mode: "suggest",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).toEqual({ runId: "ai-run-1" });
  });

  it("preserves shadow and low-risk modes for single and batch review requests", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, id: "ai-job-1" }),
    }));
    const api = createKnowledgeReviewApi({
      getBaseUrl: () => "https://memory.example",
      getToken: () => "private-token",
      fetchImpl,
    });

    await api.requestAIReview("entity_merge_candidate", "entity-1", "shadow");
    await api.requestAIReviewBatch("memory_merge_candidate", "auto_low_risk", 5);

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toMatchObject({ mode: "shadow" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).toMatchObject({
      objectType: "memory_merge_candidate",
      mode: "auto_low_risk",
      limit: 5,
    });
  });

  it("keeps the review queue keyboard navigable and browser zoom available", () => {
    expect(reviewHtml).not.toContain("user-scalable=no");
    expect(reviewHtml).not.toContain("maximum-scale=1.0");
    expect(reviewHtml).toContain('role="tab"');
    expect(reviewHtml).toContain('aria-selected="true"');
    expect(reviewHtml).toContain('role="tabpanel"');
    expect(reviewHtml).toContain('data-i18n-aria="review.refresh"');
  });

  it("moves review tab focus deterministically without escaping the queue", () => {
    const tabs = ["conflicts", "entities", "memories"];

    expect(nextReviewTab(tabs, "conflicts", "ArrowRight")).toBe("entities");
    expect(nextReviewTab(tabs, "conflicts", "ArrowLeft")).toBe("memories");
    expect(nextReviewTab(tabs, "entities", "Home")).toBe("conflicts");
    expect(nextReviewTab(tabs, "entities", "End")).toBe("memories");
    expect(nextReviewTab(tabs, "entities", "Enter")).toBeNull();
  });
});
