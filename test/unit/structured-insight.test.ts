import { describe, expect, it } from "vitest";
import {
  INSUFFICIENT_VERIFIED_EVIDENCE,
  validateInsightEvidenceReferences,
  validateStructuredInsightResponse,
  type CitableInsightClaim,
} from "../../src/memory/recall-context";

const sqliteClaim: CitableInsightClaim = {
  ref: "C1",
  evidenceId: "entry-1",
  claimId: "claim-1",
  statement: "The project uses SQLite.",
  status: "confirmed",
  conflictIds: [],
  queryRelevance: 1,
  answerability: "answerable",
};

describe("validateStructuredInsightResponse", () => {
  it("renders only canonical text selected by valid local Claim refs", () => {
    const result = validateStructuredInsightResponse(JSON.stringify({
      answer: "ignored model prose",
      claims: [{ text: "The project uses SQLite.", refs: ["C1"], kind: "fact" }],
    }), [sqliteClaim]);

    expect(result.answer).toBe("The project uses SQLite. [C1]");
    expect(result.verifiedClaims).toEqual([{
      text: "The project uses SQLite.",
      refs: ["C1"],
      kind: "fact",
    }]);
    expect(result.unverifiedClaims).toEqual([]);
  });

  it("drops an unsupported extra factual sentence instead of passing it through", () => {
    const result = validateStructuredInsightResponse(JSON.stringify({
      answer: "The project uses SQLite. It will migrate to Postgres next year.",
      claims: [
        { text: "The project uses SQLite.", refs: ["C1"], kind: "fact" },
        { text: "It will migrate to Postgres next year.", refs: ["C1"], kind: "fact" },
      ],
    }), [sqliteClaim]);

    expect(result.answer).toBe("The project uses SQLite. [C1]");
    expect(result.answer).not.toContain("Postgres");
    expect(result.unverifiedClaims).toEqual([expect.objectContaining({
      text: "It will migrate to Postgres next year.",
      reason: "claim_text_not_supported",
    })]);
  });

  it("rejects a supported Claim that the server ranked as not answerable", () => {
    const result = validateStructuredInsightResponse(JSON.stringify({
      claims: [{ text: sqliteClaim.statement, refs: ["C1"], kind: "fact" }],
    }), [{
      ...sqliteClaim,
      queryRelevance: 0,
      answerability: "irrelevant",
    }]);

    expect(result.answer).toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(result.verifiedClaims).toEqual([]);
    expect(result.unverifiedClaims[0]?.reason).toBe("claim_not_answerable");
  });

  it("rejects a fact when any attached Claim ref has a different statement", () => {
    const result = validateStructuredInsightResponse(JSON.stringify({
      claims: [{
        text: "The project uses SQLite.",
        refs: ["C1", "C2"],
        kind: "fact",
      }],
    }), [
      sqliteClaim,
      {
        ...sqliteClaim,
        ref: "C2",
        claimId: "claim-2",
        statement: "The project plans to use Postgres.",
      },
    ]);

    expect(result.answer).toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(result.unverifiedClaims[0]?.reason).toBe("claim_text_not_supported");
  });

  it("fails closed instead of truncating Claim refs above the validation limit", () => {
    const claims = Array.from({ length: 11 }, (_, index): CitableInsightClaim => ({
      ...sqliteClaim,
      ref: `C${index + 1}`,
      claimId: `claim-${index + 1}`,
      statement: index === 10
        ? "The project plans to use Postgres."
        : sqliteClaim.statement,
    }));
    const result = validateStructuredInsightResponse(JSON.stringify({
      claims: [{
        text: sqliteClaim.statement,
        refs: claims.map((claim) => claim.ref),
        kind: "fact",
      }],
    }), claims);

    expect(result.answer).toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(result.verifiedClaims).toEqual([]);
    expect(result.unverifiedClaims[0]?.reason).toBe("too_many_claim_refs");
  });

  it("fails closed for malformed JSON and unknown refs", () => {
    expect(validateStructuredInsightResponse("SQLite [C1]", [sqliteClaim]).answer)
      .toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    const unknown = validateStructuredInsightResponse(JSON.stringify({
      answer: "",
      claims: [{ text: "The project uses SQLite.", refs: ["C2"] }],
    }), [sqliteClaim]);
    expect(unknown.answer).toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(unknown.unverifiedClaims[0]?.reason).toBe("unknown_claim_ref");
  });

  it("rejects malformed claim arrays and conflict refs that do not share one case", () => {
    expect(validateStructuredInsightResponse(JSON.stringify({ claims: {} }), [sqliteClaim]))
      .toMatchObject({ answer: INSUFFICIENT_VERIFIED_EVIDENCE });
    expect(validateStructuredInsightResponse(JSON.stringify({
      claims: Array.from({ length: 21 }, () => ({ text: "x", refs: ["C1"] })),
    }), [sqliteClaim])).toMatchObject({ answer: INSUFFICIENT_VERIFIED_EVIDENCE });

    const malformed = validateStructuredInsightResponse(JSON.stringify({
      claims: [null, "not-an-object"],
    }), [sqliteClaim]);
    expect(malformed.unverifiedClaims).toEqual([
      { text: "", refs: [], reason: "invalid_structured_response" },
      { text: "", refs: [], reason: "invalid_structured_response" },
    ]);

    const invalidConflict = validateStructuredInsightResponse(JSON.stringify({
      claims: [{ text: "conflict", refs: ["C1", "C2"], kind: "conflict" }],
    }), [
      { ...sqliteClaim, conflictIds: ["conflict-a"] },
      { ...sqliteClaim, ref: "C2", claimId: "claim-2", conflictIds: ["conflict-b"] },
    ]);
    expect(invalidConflict.unverifiedClaims[0]?.reason).toBe("invalid_conflict_refs");
  });

  it("requires both sides of an unresolved conflict and never treats either side as a fact", () => {
    const contested: CitableInsightClaim[] = [
      { ...sqliteClaim, status: "contested", conflictIds: ["conflict-1"] },
      {
        ref: "C2",
        evidenceId: "entry-2",
        claimId: "claim-2",
        statement: "The project uses Postgres.",
        status: "contested",
        conflictIds: ["conflict-1"],
        queryRelevance: 1,
        answerability: "answerable",
      },
    ];
    const fact = validateStructuredInsightResponse(JSON.stringify({
      answer: "",
      claims: [{ text: "The project uses SQLite.", refs: ["C1"], kind: "fact" }],
    }), contested);
    expect(fact.answer).toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(fact.unverifiedClaims[0]?.reason).toBe("unresolved_conflict");

    const conflict = validateStructuredInsightResponse(JSON.stringify({
      answer: "",
      claims: [{ text: "Conflict", refs: ["C1", "C2"], kind: "conflict" }],
    }), contested);
    expect(conflict.answer).toContain("Unresolved conflict");
    expect(conflict.answer).toContain("The project uses SQLite.");
    expect(conflict.answer).toContain("The project uses Postgres.");
  });
});

describe("validateInsightEvidenceReferences legacy compatibility", () => {
  it("accepts only in-range direct Evidence refs", () => {
    expect(validateInsightEvidenceReferences("", 1)).toBe("");
    expect(validateInsightEvidenceReferences("Stored fact [E1]", 1)).toBe("Stored fact [E1]");
    expect(validateInsightEvidenceReferences("Unknown [E2]", 1))
      .toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(validateInsightEvidenceReferences("Navigation [R1]", 1))
      .toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(validateInsightEvidenceReferences("No references", 1))
      .toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
  });
});
