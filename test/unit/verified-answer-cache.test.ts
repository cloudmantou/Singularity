import { describe, expect, it } from "vitest";
import {
  BoundedVerifiedAnswerCache,
  buildVerifiedAnswerCacheKey,
} from "../../src/memory/verified-answer-cache";

describe("verified answer cache", () => {
  it("binds entries to the query, claim snapshot, policy, and model", async () => {
    const base = {
      query: "What database is used?",
      activitySummary: false,
      answerabilityMode: "enforce",
      modelSignature: "minimax:M3",
      cacheScope: "owner",
      retrievalPolicy: "semantic:hops=0:direction=outgoing",
      relatedContext: [],
      claims: [{
        id: "claim-1",
        statement: "The project uses SQLite",
        status: "confirmed",
        versionId: "v1",
        conflictIds: [],
      }],
    } as const;

    const first = await buildVerifiedAnswerCacheKey(base);
    const same = await buildVerifiedAnswerCacheKey({
      ...base,
      query: "  what   database is USED? ",
    });
    const changedVersion = await buildVerifiedAnswerCacheKey({
      ...base,
      claims: [{ ...base.claims[0], versionId: "v2" }],
    });
    const changedConflict = await buildVerifiedAnswerCacheKey({
      ...base,
      claims: [{ ...base.claims[0], conflictIds: ["conflict-1"] }],
    });
    const changedScope = await buildVerifiedAnswerCacheKey({
      ...base,
      cacheScope: "token:scoped-client",
    });
    const changedPolicy = await buildVerifiedAnswerCacheKey({
      ...base,
      retrievalPolicy: "semantic:hops=2:direction=both",
    });
    const changedRelatedContext = await buildVerifiedAnswerCacheKey({
      ...base,
      relatedContext: [{
        id: "related-1",
        content: "A related but non-citable project note",
        versionId: "related-v1",
      }],
    });

    expect(same).toBe(first);
    expect(changedVersion).not.toBe(first);
    expect(changedConflict).not.toBe(first);
    expect(changedScope).not.toBe(first);
    expect(changedPolicy).not.toBe(first);
    expect(changedRelatedContext).not.toBe(first);
  });

  it("returns copies, expires entries, and evicts the oldest key", () => {
    const cache = new BoundedVerifiedAnswerCache<{ answer: string; refs: string[] }>({
      maxEntries: 2,
      ttlMs: 100,
    });
    cache.set("a", { answer: "A", refs: ["C1"] }, 1_000);
    cache.set("b", { answer: "B", refs: ["C2"] }, 1_010);

    const copy = cache.get("a", 1_020);
    expect(copy).toEqual({ answer: "A", refs: ["C1"] });
    copy?.refs.push("mutated");
    expect(cache.get("a", 1_020)).toEqual({ answer: "A", refs: ["C1"] });

    cache.set("c", { answer: "C", refs: ["C3"] }, 1_030);
    expect(cache.get("a", 1_030)).toBeNull();
    expect(cache.get("b", 1_030)).toEqual({ answer: "B", refs: ["C2"] });
    expect(cache.get("b", 1_111)).toBeNull();
  });
});
