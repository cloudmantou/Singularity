import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");

describe("recall source contract", () => {
  it("logs graph signals on recalled memory events", () => {
    expect(source).toContain('logMemoryEvent(m.id, "recalled"');
    expect(source).toContain("graph: {");
    expect(source).toContain("entities: m.matchedEntities ?? []");
    expect(source).toContain("facts: m.graphFacts ?? []");
    expect(source).toContain("temporal_score: m.scoreDetails?.temporal ?? 0");
  });
});
