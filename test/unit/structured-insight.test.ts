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
  it("accepts natural-language prose when its factual paragraph cites a verified Claim", () => {
    const result = validateStructuredInsightResponse(JSON.stringify({
      answer: "根据已验证记忆，项目当前使用 SQLite 作为数据库。[C1]",
      claims: [{ text: "The project uses SQLite.", refs: ["C1"], kind: "fact" }],
    }), [sqliteClaim]);

    expect(result.answer).toBe("根据已验证记忆，项目当前使用 SQLite 作为数据库。[C1]");
    expect(result.answer).not.toBe("The project uses SQLite. [C1]");
    expect(result.verifiedClaims).toEqual([{
      text: "The project uses SQLite.",
      refs: ["C1"],
      kind: "fact",
    }]);
    expect(result.citations).toEqual([{
      ref: "C1",
      memoryId: "claim-1",
      claimId: "claim-1",
      evidenceId: "entry-1",
      statement: "The project uses SQLite.",
      kind: "fact",
    }]);
    expect(result.unverifiedClaims).toEqual([]);
  });

  it("fails closed when the model adds an unsupported factual sentence", () => {
    const result = validateStructuredInsightResponse(JSON.stringify({
      answer: "The project uses SQLite. It will migrate to Postgres next year.",
      claims: [
        { text: "The project uses SQLite.", refs: ["C1"], kind: "fact" },
        { text: "It will migrate to Postgres next year.", refs: ["C1"], kind: "fact" },
      ],
    }), [sqliteClaim]);

    expect(result.answer).toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(result.answer).not.toContain("Postgres");
    expect(result.unverifiedClaims).toEqual(expect.arrayContaining([expect.objectContaining({
      text: "It will migrate to Postgres next year.",
      reason: "claim_text_not_supported",
    })]));
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

  it("supports shadow and warn modes without silently dropping the Claim", () => {
    const response = JSON.stringify({
      answer: "The project uses SQLite. [C1]",
      claims: [{ text: sqliteClaim.statement, refs: ["C1"], kind: "fact" }],
    });
    const notAnswerable = { ...sqliteClaim, queryRelevance: 0, answerability: "irrelevant" as const };

    const shadow = validateStructuredInsightResponse(response, [notAnswerable], "shadow");
    expect(shadow.answer).toBe("The project uses SQLite. [C1]");
    expect(shadow.answerabilityWarnings).toEqual([expect.objectContaining({
      refs: ["C1"],
      reason: "claim_not_answerable",
      mode: "shadow",
    })]);

    const warn = validateStructuredInsightResponse(response, [notAnswerable], "warn");
    expect(warn.answer).toBe("The project uses SQLite. [C1]");
    expect(warn.answerabilityWarnings?.[0]?.mode).toBe("warn");
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

  it("rejects a selected Claim when the model omits the natural-language answer", () => {
    const result = validateStructuredInsightResponse(JSON.stringify({
      answer: "",
      claims: [{ text: sqliteClaim.statement, refs: ["C1"], kind: "fact" }],
    }), [sqliteClaim]);

    expect(result.answer).toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(result.unverifiedClaims[0]?.reason).toBe("missing_answer");
  });

  it("requires every non-empty answer paragraph to carry a local Claim citation", () => {
    const result = validateStructuredInsightResponse(JSON.stringify({
      answer: "项目当前使用 SQLite。[C1]\n\n下一步会迁移到 Postgres。",
      claims: [{ text: sqliteClaim.statement, refs: ["C1"], kind: "fact" }],
    }), [sqliteClaim]);

    expect(result.answer).toBe(INSUFFICIENT_VERIFIED_EVIDENCE);
    expect(result.unverifiedClaims[0]?.reason).toBe("missing_answer_citation");
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
      answer: "当前存在数据库选择冲突，系统尚未确认唯一方案。[C1][C2]",
      claims: [{ text: "Conflict", refs: ["C1", "C2"], kind: "conflict" }],
    }), contested);
    expect(conflict.answer).toBe("当前存在数据库选择冲突，系统尚未确认唯一方案。[C1][C2]");
    expect(conflict.verifiedClaims[0]?.text).toContain("Unresolved conflict");
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
