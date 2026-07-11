import { describe, expect, it } from "vitest";
import {
  buildAtomicExtractionPrompt,
  normalizeMemoryClass,
  parseAtomicExtraction,
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
});
