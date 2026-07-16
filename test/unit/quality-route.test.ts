import { describe, expect, it, vi } from "vitest";
import { handleQualityRoute } from "../../src/routes/quality";

function services() {
  return {
    authenticate: vi.fn(() => ({ ok: true as const, principal: { id: "owner" } })),
    listEntityCandidates: vi.fn(async () => []),
    resolveEntityCandidate: vi.fn(async () => ({ id: "entity-review" })),
    listMemoryCandidates: vi.fn(async () => []),
    resolveMemoryCandidate: vi.fn(async () => true),
    listConflictCases: vi.fn(async () => []),
    resolveConflictCase: vi.fn(async () => true),
    listAIReviews: vi.fn(async () => []),
    requestAIReview: vi.fn(async () => ({ id: "ai-job-1", status: "queued" })),
    requestAIReviewBatch: vi.fn(async () => ({ jobs: [{ id: "ai-job-1" }] })),
    getKnowledgeEvolutionStatus: vi.fn(async () => ({
      runId: "evolution-run-1",
      state: "running",
      total: 8,
      processed: 3,
      percent: 38,
    })),
    startKnowledgeEvolution: vi.fn(async () => ({
      runId: "evolution-run-1",
      state: "running",
      total: 8,
      processed: 3,
      percent: 38,
    })),
    applyAIReview: vi.fn(async () => ({ runId: "ai-run-1", status: "applied" })),
    mapError: vi.fn(() => null),
  };
}

describe("quality route module", () => {
  it("does not authenticate unrelated routes", async () => {
    const deps = services();
    const response = await handleQualityRoute(
      new Request("https://memory.example/recall"),
      new URL("https://memory.example/recall"),
      deps
    );
    expect(response).toBeNull();
    expect(deps.authenticate).not.toHaveBeenCalled();
  });

  it("prevents authenticated review data from being cached", async () => {
    const deps = services();
    const response = await handleQualityRoute(
      new Request("https://memory.example/quality/conflict-cases"),
      new URL("https://memory.example/quality/conflict-cases"),
      deps
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("validates entity merge decisions before invoking the executor", async () => {
    const deps = services();
    const response = await handleQualityRoute(
      new Request("https://memory.example/quality/entity-merge-candidates/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "candidate-1", decision: "automatic" }),
      }),
      new URL("https://memory.example/quality/entity-merge-candidates/resolve"),
      deps
    );
    expect(response?.status).toBe(400);
    expect(deps.resolveEntityCandidate).not.toHaveBeenCalled();
  });

  it("dispatches explicit conflict outcomes with the authenticated principal", async () => {
    const deps = services();
    const response = await handleQualityRoute(
      new Request("https://memory.example/quality/conflict-cases/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "conflict-1", state: "resolved", resolution: "use_new" }),
      }),
      new URL("https://memory.example/quality/conflict-cases/resolve"),
      deps
    );
    expect(response?.status).toBe(200);
    expect(deps.resolveConflictCase).toHaveBeenCalledWith(expect.objectContaining({
      id: "conflict-1",
      state: "resolved",
      resolution: "use_new",
      principal: { id: "owner" },
    }));
  });

  it("rejects manual conflict closure without a concrete outcome", async () => {
    const deps = services();
    const response = await handleQualityRoute(
      new Request("https://memory.example/quality/conflict-cases/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "conflict-1", state: "resolved", resolution: "manual" }),
      }),
      new URL("https://memory.example/quality/conflict-cases/resolve"),
      deps
    );
    expect(response?.status).toBe(400);
    expect(deps.resolveConflictCase).not.toHaveBeenCalled();
  });

  it("queues AI review without resolving the underlying candidate", async () => {
    const deps = services();
    const response = await handleQualityRoute(
      new Request("https://memory.example/quality/ai-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objectType: "conflict_case",
          objectId: "conflict-1",
          mode: "suggest",
        }),
      }),
      new URL("https://memory.example/quality/ai-review"),
      deps
    );

    expect(response?.status).toBe(202);
    expect(deps.requestAIReview).toHaveBeenCalledWith(expect.objectContaining({
      objectType: "conflict_case",
      objectId: "conflict-1",
      mode: "suggest",
      principal: { id: "owner" },
    }));
    expect(deps.resolveConflictCase).not.toHaveBeenCalled();
  });

  it("validates AI review applications by immutable run id", async () => {
    const deps = services();
    const invalid = await handleQualityRoute(
      new Request("https://memory.example/quality/ai-review/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: "" }),
      }),
      new URL("https://memory.example/quality/ai-review/apply"),
      deps
    );
    expect(invalid?.status).toBe(400);
    expect(deps.applyAIReview).not.toHaveBeenCalled();
  });

  it("reports and starts a persisted serial knowledge evolution run", async () => {
    const deps = services();
    const status = await handleQualityRoute(
      new Request("https://memory.example/quality/knowledge-evolution/status"),
      new URL("https://memory.example/quality/knowledge-evolution/status"),
      deps
    );
    expect(status?.status).toBe(200);
    expect(await status?.json()).toMatchObject({
      ok: true,
      state: "running",
      total: 8,
      processed: 3,
    });

    const started = await handleQualityRoute(
      new Request("https://memory.example/quality/knowledge-evolution/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      new URL("https://memory.example/quality/knowledge-evolution/run"),
      deps
    );
    expect(started?.status).toBe(202);
    expect(deps.startKnowledgeEvolution).toHaveBeenCalledWith({
      objectType: null,
      mode: "auto_low_risk",
      principal: { id: "owner" },
    });
  });
});
