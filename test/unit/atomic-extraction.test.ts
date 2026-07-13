import { describe, expect, it } from "vitest";
import {
  buildAtomicExtractionPrompt,
  normalizeMemoryClass,
  parseAtomicExtraction,
  PromptAtomicExtractor,
  isValidEvidenceRevisionLink,
  applyEntityResolutionBudget,
} from "../../src/memory/atomic";

describe("parseAtomicExtraction", () => {
  it("parses multiple atomic facts", () => {
    const facts = parseAtomicExtraction(JSON.stringify({
      facts: [
        {
          content: "用户已完成分类系统。",
          kind: "episodic",
          memory_class: "milestone",
          importance: 4,
          confidence: 0.9,
          entities: ["Singularity"],
        },
        {
          content: "用户正在研究 Graphiti。",
          kind: "semantic",
          memory_class: "project",
          importance: 3,
          confidence: 0.85,
          entities: ["Graphiti"],
        },
        {
          content: "用户计划下周开始开发 Universe UI。",
          kind: "procedural",
          memory_class: "plan",
          importance: 3,
          confidence: 0.8,
          entities: ["Universe"],
        },
      ],
    }));
    expect(facts).toHaveLength(3);
    expect(facts[0].memoryClass).toBe("milestone");
    expect(facts[1].entities.map((e) => e.name)).toContain("Graphiti");
    expect(facts[2].kind).toBe("procedural");
  });

  it("rejects empty payloads", () => {
    expect(() => parseAtomicExtraction('{"facts":[]}')).toThrow("empty_extraction");
    expect(() => parseAtomicExtraction("not json")).toThrow("invalid_extraction");
  });

  it("normalizes memory_class synonyms", () => {
    expect(normalizeMemoryClass("how_to")).toBe("procedure");
    expect(normalizeMemoryClass("goal")).toBe("plan");
  });

  it("includes the source content in the extraction prompt", () => {
    expect(buildAtomicExtractionPrompt("hello world")).toContain("hello world");
  });

  it("uses previous evidence only as bounded extraction context", () => {
    const prompt = buildAtomicExtractionPrompt("mtzs now uses a new installer", [
      { id: "evidence-1", content: "mtzs previously used installation_proxy", sourceTimestamp: 1_000 },
    ]);

    expect(prompt).toContain("Previous Evidence Revisions");
    expect(prompt).toContain("evidence-1");
    expect(prompt).toContain("never copy claims not stated by the current input");
  });

  it("drops model-invented aliases and external ids not present in current evidence", async () => {
    const extractor = new PromptAtomicExtractor(async () => JSON.stringify({
      facts: [{
        content: "馒头助手 is the product name.",
        entities: [{
          name: "馒头助手",
          type: "product",
          aliases: ["mtzs", "invented-alias"],
          external_ids: [
            { provider: "github", value: "cloudmantou/mtzs" },
            { provider: "github", value: "attacker/repo" },
          ],
        }],
      }],
    }));

    const [fact] = await extractor.extract({
      id: "evidence-1",
      content: "馒头助手（mtzs）的仓库是 cloudmantou/mtzs。",
    });

    expect(fact.entities[0].aliases).toEqual(["mtzs"]);
    expect(fact.entities[0].externalIds).toEqual([
      { provider: "github", value: "cloudmantou/mtzs" },
    ]);
  });

  it("rejects previous evidence from another root, vault, or non-contiguous revision", () => {
    const current = {
      id: "e2",
      content: "new",
      rootEvidenceId: "root-a",
      sourceIdentity: "obsidian:vault-a:file",
      sourceChannel: "obsidian",
      vaultId: "vault-a",
      revision: 2,
    };
    expect(isValidEvidenceRevisionLink(current, {
      id: "e1",
      content: "old",
      rootEvidenceId: "root-a",
      sourceIdentity: "obsidian:vault-a:file",
      sourceChannel: "obsidian",
      vaultId: "vault-a",
      revision: 1,
    })).toBe(true);
    expect(isValidEvidenceRevisionLink(current, {
      id: "foreign",
      content: "foreign",
      rootEvidenceId: "root-b",
      sourceIdentity: "obsidian:vault-b:file",
      sourceChannel: "obsidian",
      vaultId: "vault-b",
      revision: 1,
    })).toBe(false);
  });

  it("enforces one entity-resolution budget across all extracted facts", () => {
    const facts = parseAtomicExtraction(JSON.stringify({
      facts: Array.from({ length: 3 }, (_, factIndex) => ({
        content: `fact ${factIndex}`,
        entities: Array.from({ length: 16 }, (_, entityIndex) => ({
          name: `entity-${factIndex}-${entityIndex}`,
        })),
      })),
    }));

    const bounded = applyEntityResolutionBudget(facts, 32);
    expect(bounded.flatMap((fact) => fact.entities)).toHaveLength(32);
  });
});
