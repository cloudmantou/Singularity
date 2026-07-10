import { describe, it, expect } from "vitest";
import { isBenignStreamClose } from "../../src/selfhost/fetch-adapter";

describe("isBenignStreamClose", () => {
  it("treats ERR_STREAM_PREMATURE_CLOSE as benign", () => {
    const err = Object.assign(new Error("Premature close"), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });
    expect(isBenignStreamClose(err)).toBe(true);
  });

  it("treats ECONNRESET / EPIPE / AbortError as benign", () => {
    expect(
      isBenignStreamClose(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
    ).toBe(true);
    expect(
      isBenignStreamClose(Object.assign(new Error("pipe"), { code: "EPIPE" }))
    ).toBe(true);
    expect(
      isBenignStreamClose(Object.assign(new Error("aborted"), { name: "AbortError" }))
    ).toBe(true);
  });

  it("does not treat arbitrary errors as benign", () => {
    expect(isBenignStreamClose(new Error("LLM failed"))).toBe(false);
    expect(isBenignStreamClose(null)).toBe(false);
  });
});
