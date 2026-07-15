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
});
