import { describe, expect, it } from "vitest";
import {
  normalizeEntityName,
  normalizeEntityRelationType,
  normalizeEntityType,
  parseEntityList,
  parseEntityRelationList,
} from "../../src/memory/entities";
import { parseAtomicExtraction } from "../../src/memory/atomic";

describe("entity normalization", () => {
  it("normalizes names for dedup keys", () => {
    expect(normalizeEntityName("  Singularity  ")).toBe("singularity");
  });

  it("maps common type synonyms", () => {
    expect(normalizeEntityType("org")).toBe("organization");
    expect(normalizeEntityType("tool")).toBe("product");
  });

  it("maps relation synonyms", () => {
    expect(normalizeEntityRelationType("use")).toBe("uses");
    expect(normalizeEntityRelationType("part-of")).toBe("part_of");
  });
});

describe("entity parsers", () => {
  it("parses string and object entity lists", () => {
    const entities = parseEntityList([
      "Singularity",
      { name: "SQLite", type: "product" },
      "Singularity",
    ]);
    expect(entities).toHaveLength(2);
    expect(entities[1].entityType).toBe("product");
  });

  it("preserves explicit aliases and stable external ids for resolution", () => {
    const [entity] = parseEntityList([
      {
        name: "馒头助手",
        type: "product",
        aliases: ["mtzs"],
        external_ids: [{ provider: "github", value: "cloudmantou/mtzs" }],
      },
    ]);

    expect(entity.aliases).toEqual(["mtzs"]);
    expect(entity.externalIds).toEqual([
      { provider: "github", value: "cloudmantou/mtzs" },
    ]);
  });

  it("parses entity relation drafts", () => {
    const rels = parseEntityRelationList([
      { from: "Singularity", to: "SQLite", type: "uses", fact: "Singularity uses SQLite" },
    ]);
    expect(rels[0]).toMatchObject({
      from: "Singularity",
      to: "SQLite",
      relationType: "uses",
    });
  });
});

describe("atomic extraction entity fields", () => {
  it("parses entities and relations from fact payloads", () => {
    const facts = parseAtomicExtraction(
      JSON.stringify({
        facts: [
          {
            content: "Singularity uses SQLite for storage.",
            kind: "semantic",
            memory_class: "fact",
            importance: 4,
            confidence: 0.9,
            valid_from: 1_700_000_000_000,
            entities: [
              { name: "Singularity", type: "project" },
              { name: "SQLite", type: "product" },
            ],
            relations: [
              {
                from: "Singularity",
                to: "SQLite",
                type: "uses",
                fact: "Singularity uses SQLite",
              },
            ],
          },
        ],
      })
    );
    expect(facts[0].entities.map((e) => e.name)).toEqual(["Singularity", "SQLite"]);
    expect(facts[0].relations[0].relationType).toBe("uses");
    expect(facts[0].validFrom).toBe(1_700_000_000_000);
  });
});
