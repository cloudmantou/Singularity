import { describe, it, expect } from "vitest";
import {
  applyClassificationLifecycleTags,
  CANONICAL_CANDIDATE_TAG,
  CANONICAL_CONFIDENCE_THRESHOLD,
  CURRENT_CLASSIFICATION_VERSION,
  contentFingerprint,
  formatRelevanceLabel,
  getHalfLifeMs,
  normalizeContentForDedup,
  relevanceBand,
} from "../../src/index";

describe("applyClassificationLifecycleTags", () => {
  it("promotes high-confidence canonical suggestions", () => {
    expect(
      applyClassificationLifecycleTags(["work"], true, CANONICAL_CONFIDENCE_THRESHOLD)
    ).toEqual(["work", "status:canonical"]);
  });

  it("marks low-confidence canonical as draft candidate with classifier source", () => {
    expect(applyClassificationLifecycleTags(["work"], true, 0.35)).toEqual([
      "work",
      "status:draft",
      "status_source:classifier",
      CANONICAL_CANDIDATE_TAG,
    ]);
  });

  it("upgrades classifier-owned draft to canonical when confidence is high", () => {
    expect(
      applyClassificationLifecycleTags(
        ["work", "status:draft", "status_source:classifier", CANONICAL_CANDIDATE_TAG],
        true,
        0.9
      )
    ).toEqual(["work", "status:canonical"]);
  });

  it("does not upgrade user-owned draft to canonical automatically", () => {
    expect(
      applyClassificationLifecycleTags(
        ["work", "status:draft", "status_source:user"],
        true,
        0.95
      )
    ).toEqual(["work", "status:draft", "status_source:user"]);
  });

  it("does not demote an existing status on low-confidence canonical", () => {
    expect(
      applyClassificationLifecycleTags(["work", "status:deprecated"], true, 0.2)
    ).toEqual(["work", "status:deprecated", CANONICAL_CANDIDATE_TAG]);
  });

  it("clears candidate marker when high-confidence promotion wins", () => {
    expect(
      applyClassificationLifecycleTags(
        ["work", CANONICAL_CANDIDATE_TAG],
        true,
        0.9
      )
    ).toEqual(["work", "status:canonical"]);
  });

  it("leaves tags alone when not canonical", () => {
    expect(applyClassificationLifecycleTags(["work", CANONICAL_CANDIDATE_TAG], false, 0.9)).toEqual([
      "work",
    ]);
  });
});

describe("classification version constant", () => {
  it("exposes a positive current classification version", () => {
    expect(CURRENT_CLASSIFICATION_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("getHalfLifeMs", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("uses a one-year half-life for procedural memories", () => {
    expect(getHalfLifeMs(["kind:procedural"])).toBe(365 * DAY);
  });

  it("still prioritizes task decay over procedural when both are present", () => {
    expect(getHalfLifeMs(["task", "kind:procedural"])).toBe(7 * DAY);
  });
});

describe("relevance labels", () => {
  it("maps normalized rank scores to plain-language bands", () => {
    expect(formatRelevanceLabel(1)).toBe("highly relevant");
    expect(formatRelevanceLabel(0.7)).toBe("relevant");
    expect(formatRelevanceLabel(0.2)).toBe("possibly relevant");
    expect(relevanceBand(0.9)).toBe("high");
    expect(relevanceBand(0.6)).toBe("medium");
    expect(relevanceBand(0.1)).toBe("low");
  });
});

describe("content fingerprint", () => {
  it("normalizes whitespace for dedup", () => {
    expect(normalizeContentForDedup("  a   b\n")).toBe("a b");
  });

  it("hashes normalized content stably", async () => {
    const a = await contentFingerprint("hello   world");
    const b = await contentFingerprint("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
