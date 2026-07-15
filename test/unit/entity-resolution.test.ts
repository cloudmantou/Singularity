import { describe, expect, it } from "vitest";
import {
  decideEntityResolution,
  type EntityResolutionCandidate,
} from "../../src/memory/entity-resolution";

function candidate(
  overrides: Partial<EntityResolutionCandidate> = {}
): EntityResolutionCandidate {
  return {
    id: "entity-1",
    name: "馒头助手",
    nameNormalized: "馒头助手",
    entityType: "product",
    aliases: ["mtzs"],
    externalIds: [{ provider: "github", value: "cloudmantou/mtzs" }],
    embedding: null,
    mentionCount: 4,
    ...overrides,
  };
}

describe("decideEntityResolution", () => {
  it("reuses a unique canonical-name match", () => {
    expect(
      decideEntityResolution(
        { name: " 馒头助手 ", entityType: "product" },
        [candidate()]
      )
    ).toMatchObject({
      action: "use_existing",
      entityId: "entity-1",
      matchedBy: "canonical",
      confidence: 1,
    });
  });

  it("reuses unique aliases and stable external ids", () => {
    expect(
      decideEntityResolution(
        { name: "mtzs", entityType: "product" },
        [candidate()]
      )
    ).toMatchObject({ action: "use_existing", entityId: "entity-1", matchedBy: "alias" });

    expect(
      decideEntityResolution(
        {
          name: "馒头助手 App",
          entityType: "product",
          externalIds: [{ provider: "github", value: "cloudmantou/mtzs" }],
        },
        [candidate()]
      )
    ).toMatchObject({
      action: "use_existing",
      entityId: "entity-1",
      matchedBy: "external_id",
    });
  });

  it("queues ambiguous aliases for review instead of silently merging", () => {
    const result = decideEntityResolution(
      { name: "mtzs", entityType: "product" },
      [
        candidate(),
        candidate({ id: "entity-2", name: "MTZS CLI", aliases: ["mtzs"] }),
      ]
    );

    expect(result.action).toBe("review");
    expect(result.matchedBy).toBe("alias");
    expect(result.candidates.map((item) => item.entityId)).toEqual([
      "entity-1",
      "entity-2",
    ]);
  });

  it("queues semantic candidates but never auto-merges them", () => {
    const result = decideEntityResolution(
      { name: "馒头助手 App", entityType: "product" },
      [candidate({ aliases: [], externalIds: [], embedding: [1, 0] })],
      { queryEmbedding: [0.99, 0.01] }
    );

    expect(result).toMatchObject({ action: "review", matchedBy: "semantic" });
    expect(result.candidates[0].score).toBeGreaterThan(0.98);
  });

  it("accepts pre-ranked ANN candidates without loading stored vectors into JavaScript", () => {
    const result = decideEntityResolution(
      { name: "馒头助手 App", entityType: "product" },
      [candidate({ aliases: [], externalIds: [], embedding: null })],
      { semanticCandidates: [{ entityId: "entity-1", score: 0.97 }] }
    );

    expect(result).toMatchObject({ action: "review", matchedBy: "semantic" });
    expect(result.candidates).toEqual([
      { entityId: "entity-1", score: 0.97, matchedBy: "semantic" },
    ]);
  });

  it("does not suggest type-incompatible semantic candidates", () => {
    const result = decideEntityResolution(
      { name: "Java", entityType: "product" },
      [candidate({ name: "Java", nameNormalized: "java", entityType: "place", aliases: [], externalIds: [], embedding: [1, 0] })],
      { queryEmbedding: [1, 0] }
    );

    expect(result).toMatchObject({ action: "create", matchedBy: "none" });
  });

  it("queues canonical and stable-id disagreements instead of polluting either entity", () => {
    const result = decideEntityResolution(
      {
        name: "馒头助手",
        entityType: "product",
        externalIds: [{ provider: "github", value: "other/project" }],
      },
      [
        candidate(),
        candidate({
          id: "entity-2",
          name: "Other Project",
          nameNormalized: "other project",
          aliases: [],
          externalIds: [{ provider: "github", value: "other/project" }],
        }),
      ]
    );

    expect(result.action).toBe("review");
    expect(result.matchedBy).toBe("identity_conflict");
    expect(result.candidates.map((item) => item.entityId).sort()).toEqual([
      "entity-1",
      "entity-2",
    ]);
  });
});
