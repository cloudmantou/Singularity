import { describe, expect, it } from "vitest";
import { applyRecallClaimRelevance } from "../../src/memory/recall-conflicts";
import { rankClaimAnswerability } from "../../src/memory/query-answerability";

describe("rankClaimAnswerability", () => {
  it("rejects a verified but unrelated Claim", () => {
    expect(rankClaimAnswerability(
      "What is the minimum iOS version?",
      "The project uses SQLite."
    )).toMatchObject({ answerability: "irrelevant" });
  });

  it("treats generic project wording as insufficient without the queried concept", () => {
    expect(rankClaimAnswerability(
      "What is the project port?",
      "The project uses SQLite."
    )).toMatchObject({ answerability: "irrelevant" });
    expect(rankClaimAnswerability(
      "What is the project port?",
      "The project port is 8787."
    )).toMatchObject({ answerability: "answerable" });
  });

  it("does not treat a query with no informative tokens as universally answerable", () => {
    expect(rankClaimAnswerability("是什么吗", "The project uses SQLite.")).toMatchObject({
      queryRelevance: 0,
      answerability: "irrelevant",
    });
  });

  it("recognizes deterministic domain concepts and optional semantic scores", () => {
    expect(rankClaimAnswerability(
      "Which database is used?",
      "The project uses SQLite."
    )).toMatchObject({ answerability: "answerable" });
    expect(rankClaimAnswerability("How is authentication handled?", "JWT expires in one hour."))
      .toMatchObject({ answerability: "answerable" });
    expect(rankClaimAnswerability("minimum supported platform", "Deployment target is iOS 16.", 0.82))
      .toMatchObject({ answerability: "answerable", queryRelevance: 0.82 });
  });

  it("attaches Claim vector scores without mutating loaded evidence", () => {
    const claims = [{
      id: "claim-1",
      entryId: "entry-1",
      statement: "The project uses SQLite.",
      status: "supported",
      verificationStatus: "supported" as const,
      conflictIds: [],
      opposingClaimIds: [],
    }];
    const ranked = applyRecallClaimRelevance(claims, new Map([["claim-1", 0.84]]));

    expect(ranked[0]).toMatchObject({ id: "claim-1", queryRelevance: 0.84 });
    expect(claims[0]).not.toHaveProperty("queryRelevance");
  });
});
