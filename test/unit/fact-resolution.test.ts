import { describe, expect, it } from "vitest";
import {
  resolveFact,
  type FactResolutionCandidate,
  type FactResolutionInput,
} from "../../src/memory/fact-resolution";

const base: FactResolutionInput = {
  fromEntityId: "mtzs",
  toEntityId: "installation-proxy",
  predicate: "uses",
  fact: "mtzs uses installation_proxy",
  scopeId: "mtzs/ios/production",
  polarity: "positive",
  modality: "confirmed",
  validFrom: 1_000,
  validTo: null,
  referenceTime: 1_000,
  memoryId: "memory-new",
  allowInvalidation: true,
};

function existing(
  overrides: Partial<FactResolutionCandidate> = {}
): FactResolutionCandidate {
  return {
    relationId: "relation-old",
    ...base,
    memoryId: "memory-old",
    evidenceCount: 1,
    ...overrides,
  };
}

describe("resolveFact", () => {
  it("deduplicates identical structured facts", () => {
    expect(resolveFact(base, [existing()])).toMatchObject({
      type: "duplicate",
      targetRelationId: "relation-old",
      applyInvalidation: false,
    });
  });

  it("treats production and test scopes as coexisting", () => {
    const result = resolveFact(
      { ...base, scopeId: "mtzs/ios/test" },
      [existing({ scopeId: "mtzs/ios/production" })]
    );

    expect(result).toMatchObject({
      type: "coexists",
      targetRelationId: "relation-old",
      applyInvalidation: false,
    });
  });

  it("supersedes only with compatible scope and explicit replacement language", () => {
    const result = resolveFact(
      {
        ...base,
        toEntityId: "new-installer",
        fact: "mtzs production now replaces installation_proxy with new_installer",
        validFrom: 2_000,
        referenceTime: 2_000,
      },
      [existing()]
    );

    expect(result).toMatchObject({
      type: "supersedes",
      targetRelationId: "relation-old",
      applyInvalidation: true,
    });
  });

  it("keeps contradictory facts active for review when replacement is not explicit", () => {
    const result = resolveFact(
      {
        ...base,
        toEntityId: "new-installer",
        fact: "mtzs uses new_installer",
      },
      [existing()]
    );

    expect(result).toMatchObject({
      type: "contradicts",
      targetRelationId: "relation-old",
      applyInvalidation: false,
      requiresReview: true,
    });
  });

  it("keeps non-overlapping historical windows as coexisting facts", () => {
    const result = resolveFact(
      { ...base, validFrom: 10_000, validTo: 20_000, referenceTime: 10_000 },
      [existing({ validFrom: 1_000, validTo: 2_000, referenceTime: 1_000 })]
    );

    expect(result.type).toBe("coexists");
    expect(result.applyInvalidation).toBe(false);
  });

  it("requires review when scope is missing, modality is hypothetical, or prior support is independent", () => {
    expect(resolveFact(
      { ...base, toEntityId: "new-installer", scopeId: null, fact: "now replaces old with new" },
      [existing()]
    )).toMatchObject({ type: "supersedes", applyInvalidation: false, requiresReview: true });

    expect(resolveFact(
      { ...base, toEntityId: "new-installer", modality: "hypothetical", fact: "now replaces old with new" },
      [existing()]
    )).toMatchObject({ type: "supersedes", applyInvalidation: false, requiresReview: true });

    expect(resolveFact(
      { ...base, toEntityId: "new-installer", fact: "now replaces old with new" },
      [existing({ evidenceCount: 2 })]
    )).toMatchObject({ type: "supersedes", applyInvalidation: false, requiresReview: true });
  });

  it("does not treat negated replacement language as a supersede", () => {
    const result = resolveFact(
      {
        ...base,
        toEntityId: "new-installer",
        fact: "mtzs does not replace installation_proxy with new_installer",
      },
      [existing()]
    );

    expect(result.type).toBe("contradicts");
    expect(result.applyInvalidation).toBe(false);
  });

  it("filters incompatible scopes before selecting a conflicting candidate", () => {
    const result = resolveFact(
      {
        ...base,
        toEntityId: "new-installer",
        fact: "mtzs production uses new_installer",
      },
      [
        existing({
          relationId: "relation-test-same-object",
          scopeId: "mtzs/ios/test",
          toEntityId: "new-installer",
          fact: "mtzs test uses new_installer",
        }),
        existing({
          relationId: "relation-production-conflict",
          scopeId: "mtzs/ios/production",
          toEntityId: "installation-proxy",
          fact: "mtzs production uses installation_proxy",
        }),
      ]
    );

    expect(result).toMatchObject({
      type: "contradicts",
      targetRelationId: "relation-production-conflict",
      requiresReview: true,
    });
  });

  it("ranks compatible candidates by independent support and recency instead of relation id", () => {
    const result = resolveFact(
      {
        ...base,
        toEntityId: "new-installer",
        fact: "mtzs production now replaces the prior installer with new-installer",
      },
      [
        existing({
          relationId: "a-random-id",
          toEntityId: "weak-installer",
          evidenceCount: 1,
          createdAt: 3_000,
        }),
        existing({
          relationId: "z-strong-id",
          toEntityId: "supported-installer",
          evidenceCount: 3,
          createdAt: 2_000,
        }),
      ]
    );

    expect(result).toMatchObject({
      type: "supersedes",
      targetRelationId: "z-strong-id",
      applyInvalidation: false,
      requiresReview: true,
    });
  });
});
