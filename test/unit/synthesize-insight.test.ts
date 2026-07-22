import { describe, it, expect, vi } from "vitest";
import {
  resolveVerifiedRecallInsight,
  synthesizeInsight,
  synthesizeVerifiedInsight,
  type Env,
} from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";
import { resetVerifiedAnswerCache } from "../../src/memory/verified-answer-cache";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

function aiMock(response: string) {
  return { run: vi.fn().mockResolvedValue(makeSseStream(response)) } as unknown as Ai;
}

function aiSequenceMock(...responses: string[]) {
  const run = vi.fn();
  for (const response of responses) {
    run.mockResolvedValueOnce(makeSseStream(response));
  }
  return { run } as unknown as Ai;
}

function structuredClaim(text: string, refs = ["C1"], kind: "fact" | "conflict" = "fact") {
  const citations = refs.map((ref) => `[${ref}]`).join("");
  return JSON.stringify({
    answer: refs.length ? `Based on the verified memory, ${text} ${citations}` : "",
    claims: [{ text, refs, kind }],
  });
}

function verifiedEvidence(id: string, content: string) {
  return {
    id,
    content,
    claims: [{
      id: `claim-${id}`,
      entryId: id,
      statement: content,
      status: "confirmed",
      verificationStatus: "confirmed" as const,
      conflictIds: [],
      opposingClaimIds: [],
    }],
  };
}

describe("synthesizeInsight()", () => {
  it("caches only the final verified answer and reports synthesis stages", async () => {
    resetVerifiedAnswerCache();
    const env = makeTestEnv(undefined, {
      VERIFIED_ANSWER_CACHE_TTL_MS: "60000",
      AI: aiMock(structuredClaim("The project uses SQLite")),
    });
    const context = {
      directEvidence: [verifiedEvidence("entry-cache", "The project uses SQLite")],
      relatedContext: [],
    };

    const first = await synthesizeVerifiedInsight("Which database is used?", context, env);
    const cacheEvents: string[] = [];
    const second = await synthesizeVerifiedInsight("Which database is used?", context, env, [], {
      onGenerationStart: () => cacheEvents.push("start"),
      onDraftDelta: (delta) => cacheEvents.push(`delta:${delta}`),
      onDraftComplete: () => cacheEvents.push("complete"),
    });

    expect(first.performance).toMatchObject({ cacheHit: false, modelCalls: 1 });
    expect(first.performance?.totalMs).toBeGreaterThanOrEqual(0);
    expect(second.answer).toBe(first.answer);
    expect(second.performance).toMatchObject({ cacheHit: true, modelCalls: 0 });
    expect(cacheEvents).toEqual([
      "start",
      expect.stringMatching(/^delta:/),
      "complete",
    ]);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("partitions cached answers by requester, related context, and model policy", async () => {
    resetVerifiedAnswerCache();
    const ai = aiSequenceMock(
      structuredClaim("The project uses SQLite"),
      structuredClaim("The project uses SQLite"),
      structuredClaim("The project uses SQLite"),
      structuredClaim("The project uses SQLite")
    );
    const baseEnv = makeTestEnv(undefined, {
      VERIFIED_ANSWER_CACHE_TTL_MS: "60000",
      LLM_EXTRA_BODY: JSON.stringify({ reasoning: { effort: "low" } }),
      AI: ai,
    });
    const context = {
      directEvidence: [verifiedEvidence("entry-partition", "The project uses SQLite")],
      relatedContext: [],
    };

    await synthesizeVerifiedInsight("Which database is used?", context, baseEnv, [], {
      cacheScope: "owner",
      retrievalPolicy: "semantic:hops=0",
    });
    await synthesizeVerifiedInsight("Which database is used?", context, baseEnv, [], {
      cacheScope: "token:client-a",
      retrievalPolicy: "semantic:hops=0",
    });
    await synthesizeVerifiedInsight("Which database is used?", {
      ...context,
      relatedContext: [{
        id: "related-1",
        content: "Related project context",
        associationType: "related_to",
        hop: 1,
      }],
    }, baseEnv, [], {
      cacheScope: "owner",
      retrievalPolicy: "semantic:hops=0",
    });
    await synthesizeVerifiedInsight("Which database is used?", context, {
      ...baseEnv,
      LLM_EXTRA_BODY: JSON.stringify({ reasoning: { effort: "high" } }),
    }, [], {
      cacheScope: "owner",
      retrievalPolicy: "semantic:hops=0",
    });

    expect(ai.run).toHaveBeenCalledTimes(4);
  });

  it("uses a separately configured verifier without weakening answer validation", async () => {
    resetVerifiedAnswerCache();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      const content = url.includes("verifier.example")
        ? JSON.stringify({ paragraphs: [{ id: "P1", supported: true }] })
        : JSON.stringify({
            answer: [{ text: "The project uses a SQLite database.", refs: ["C1"], kind: "fact" }],
          });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    }));
    const env = {
      ...makeTestEnv(),
      SELFHOST: "1",
      LLM_BASE_URL: "https://generator.example/v1",
      LLM_API_KEY: "generator-key",
      LLM_MODEL: "generator-model",
      VERIFIER_LLM_BASE_URL: "https://verifier.example/v1",
      VERIFIER_LLM_API_KEY: "verifier-key",
      VERIFIER_LLM_MODEL: "verifier-model",
    } as Env;

    try {
      const result = await synthesizeVerifiedInsight("Which database is used?", {
        directEvidence: [verifiedEvidence("entry-verifier", "The project uses SQLite")],
        relatedContext: [],
      }, env);

      expect(result.answer).toContain("SQLite database");
      expect(requests.map((request) => request.url)).toEqual([
        "https://generator.example/v1/chat/completions",
        "https://verifier.example/v1/chat/completions",
      ]);
      expect(result.performance).toMatchObject({ modelCalls: 2, verifierModelUsed: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requests provider JSON mode for verified answer synthesis", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: structuredClaim("The project uses SQLite") } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      ...makeTestEnv(),
      DB: undefined,
      SELFHOST: "1",
      LLM_BASE_URL: "https://api.deepseek.com/v1",
      LLM_API_KEY: "test-key",
      LLM_MODEL: "deepseek-v4-flash",
    } as unknown as Env;

    try {
      const result = await synthesizeVerifiedInsight("Which database is used?", {
        directEvidence: [verifiedEvidence("entry-database", "The project uses SQLite")],
        relatedContext: [],
      }, env);

      expect(result.answer).toContain("The project uses SQLite");
      const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(requestBody.response_format).toEqual({ type: "json_object" });
      expect(requestBody.max_tokens).toBe(1_600);
      expect(requestBody.messages[0].content).toContain(
        '{"answer":[{"text":"","refs":["C1"],"kind":"fact"}]}'
      );
      expect(requestBody.messages[0].content).toContain(
        "Use two to four short sentences total and at most three paragraph objects"
      );
      expect(requestBody.messages[0].content).toContain(
        "Each paragraph object must contain exactly one factual sentence about one project or theme"
      );
      expect(requestBody.messages[0].content).toContain(
        "The server renders Claim citations from each paragraph's refs"
      );
      expect(requestBody.messages[0].content).not.toContain('"claims"');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("checks query answerability even when recall returns one verified Claim", async () => {
    const env = makeTestEnv(undefined, {
      AI: aiMock(structuredClaim("The project uses SQLite")),
    });
    const result = await resolveVerifiedRecallInsight("What is the minimum iOS version?", {
      directEvidence: [verifiedEvidence("entry-database", "The project uses SQLite")],
      relatedContext: [],
    }, env);

    expect(env.AI.run).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("Retrieved direct evidence is insufficient for a verified answer.");
    expect(result.verifiedClaims).toEqual([]);
    expect(result.unverifiedClaims[0]?.reason).toBe("claim_not_answerable");
  });

  it("uses query-aware synthesis when one Entry contains multiple Claims", async () => {
    const env = makeTestEnv(undefined, {
      AI: aiMock(structuredClaim("The project port is 8787", ["C2"])),
    });
    const result = await resolveVerifiedRecallInsight("What is the project port?", {
      directEvidence: [{
        id: "entry-project",
        content: "Project details",
        claims: [{
          id: "claim-db",
          entryId: "entry-project",
          statement: "The project uses SQLite",
          status: "confirmed",
          verificationStatus: "confirmed",
          conflictIds: [],
          opposingClaimIds: [],
        }, {
          id: "claim-port",
          entryId: "entry-project",
          statement: "The project port is 8787",
          status: "confirmed",
          verificationStatus: "confirmed",
          conflictIds: [],
          opposingClaimIds: [],
        }],
      }],
      relatedContext: [],
    }, env);

    expect(result.answer).toBe("Based on the verified memory, The project port is 8787 [C2]");
    expect(env.AI.run).toHaveBeenCalled();
  });

  it("fails closed when direct Evidence has no Atomic Claim", async () => {
    const env = makeTestEnv(undefined, {
      AI: aiMock(structuredClaim("Legacy entry text")),
    });
    const result = await synthesizeVerifiedInsight("query", {
      directEvidence: [{ id: "legacy-entry", content: "Legacy entry text" }],
      relatedContext: [],
    }, env);

    expect(result.answer).toBe("Retrieved direct evidence is insufficient for a verified answer.");
    expect(result.verifiedClaims).toEqual([]);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("can cite the opposing side only for a conflict when one side was directly recalled", async () => {
    const conflict = {
      id: "conflict-1",
      state: "pending" as const,
      reason: "different_object",
      claimIds: ["claim-old", "claim-new"],
      claims: [
        { id: "claim-old", entryId: "entry-old", statement: "The project uses SQLite", status: "contested" },
        { id: "claim-new", entryId: "entry-new", statement: "The project uses Postgres", status: "contested" },
      ],
    };
    const directEvidence = [{
      id: "entry-old",
      content: "The project uses SQLite",
      claims: [{
        id: "claim-old",
        entryId: "entry-old",
        statement: "The project uses SQLite",
        status: "contested",
        verificationStatus: "contested" as const,
        conflictIds: ["conflict-1"],
        opposingClaimIds: ["claim-new"],
      }],
    }];
    const conflictEnv = makeTestEnv(undefined, {
      AI: aiSequenceMock(
        structuredClaim("Conflict", ["C1", "C2"], "conflict"),
        JSON.stringify({ paragraphs: [{ id: "P1", supported: true }] })
      ),
    });
    const disclosed = await synthesizeVerifiedInsight(
      "Which database is used?",
      { directEvidence, relatedContext: [] },
      conflictEnv,
      [conflict]
    );
    expect(disclosed.answer).toBe("Based on the verified memory, Conflict [C1][C2]");

    const factEnv = makeTestEnv(undefined, {
      AI: aiMock(structuredClaim("The project uses Postgres", ["C2"])),
    });
    const laundered = await synthesizeVerifiedInsight(
      "Which database is used?",
      { directEvidence, relatedContext: [] },
      factEnv,
      [conflict]
    );
    expect(laundered.answer).toBe("Retrieved direct evidence is insufficient for a verified answer.");
    expect(laundered.unverifiedClaims[0]?.reason).toBe("conflict_only_ref");
  });

  it("refuses to synthesize facts from Association-only navigation context", async () => {
    const env = makeTestEnv();
    const result = await synthesizeVerifiedInsight("query", {
      directEvidence: [],
      relatedContext: [{
        id: "related-1",
        content: "Navigation only",
        associationType: "related_to",
        hop: 1,
      }],
    }, env);
    expect(result).toMatchObject({
      answer: "Retrieved direct evidence is insufficient for a verified answer.",
      verifiedClaims: [],
      unverifiedClaims: [],
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("returns empty string immediately when rows is empty — AI not called", async () => {
    const env = makeTestEnv();
    const result = await synthesizeInsight("some query", [], env);
    expect(result).toBe("");
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("returns LLM response on happy path", async () => {
    const env = makeTestEnv(undefined, {
      AI: aiMock(structuredClaim("We chose JWT with 1hr expiry")),
    });
    const result = await synthesizeInsight(
      "auth strategy",
      [verifiedEvidence("1", "We chose JWT with 1hr expiry")],
      env
    );
    expect(result).toBe("Based on the verified memory, We chose JWT with 1hr expiry [C1]");
  });

  it("accepts a paraphrased answer only after paragraph-to-Claim entailment passes", async () => {
    const generated = JSON.stringify({
      answer: [{
        text: "The project currently relies on SQLite.",
        refs: ["C1"],
        kind: "fact",
      }],
    });
    const verified = JSON.stringify({
      paragraphs: [{ id: "P1", supported: true }],
    });
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock(generated, verified),
    });

    const result = await synthesizeVerifiedInsight(
      "Which database is used?",
      [verifiedEvidence("1", "The project uses SQLite")],
      env
    );

    expect(result.answer).toBe("The project currently relies on SQLite. [C1]");
    expect(result.unverifiedClaims).toEqual([]);
    expect(env.AI.run).toHaveBeenCalledTimes(2);
    const [, verifierOptions] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(verifierOptions.messages[0].content).toContain("strict evidence entailment verifier");
  });

  it("repairs an English answer when the user asked in Chinese", async () => {
    const english = JSON.stringify({
      answer: [{ text: "You are fixing Singularity recall.", refs: ["C1"], kind: "fact" }],
    });
    const chinese = JSON.stringify({
      answer: [{ text: "你正在修复 Singularity Recall。", refs: ["C1"], kind: "fact" }],
    });
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock(english, chinese),
    });

    const result = await synthesizeVerifiedInsight(
      "我在忙什么？",
      [verifiedEvidence("1", "你正在修复 Singularity Recall。")],
      env,
      [],
      { activitySummary: true }
    );

    expect(result.answer).toBe("你正在修复 Singularity Recall。 [C1]");
    expect(result.unverifiedClaims).toEqual([]);
    expect(env.AI.run).toHaveBeenCalledTimes(2);
    const [, repairOptions] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(repairOptions.messages[0].content).toContain("answer_language_mismatch");
  });

  it("rejects a repair that still ignores the user's language", async () => {
    const english = JSON.stringify({
      answer: [{ text: "You are fixing Singularity recall.", refs: ["C1"], kind: "fact" }],
    });
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock(english, english),
    });

    const result = await synthesizeVerifiedInsight(
      "我在忙什么？",
      [verifiedEvidence("1", "你正在修复 Singularity Recall。")],
      env,
      [],
      { activitySummary: true }
    );

    expect(result.answer).toBe("Retrieved direct evidence is insufficient for a verified answer.");
    expect(result.verifiedClaims).toEqual([]);
    expect(result.unverifiedClaims).toEqual([
      expect.objectContaining({ reason: "answer_language_mismatch", refs: ["C1"] }),
    ]);
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a cited paragraph adds a fact absent from its Claims", async () => {
    const generated = JSON.stringify({
      answer: [{
        text: "The project is production-ready.",
        refs: ["C1"],
        kind: "fact",
      }],
    });
    const rejected = JSON.stringify({
      paragraphs: [{ id: "P1", supported: false }],
    });
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock(generated, rejected),
    });

    const result = await synthesizeVerifiedInsight(
      "Which database is used?",
      [verifiedEvidence("1", "The project uses SQLite")],
      env
    );

    expect(result.answer).toBe("Retrieved direct evidence is insufficient for a verified answer.");
    expect(result.verifiedClaims).toEqual([]);
    expect(result.unverifiedClaims).toEqual([
      expect.objectContaining({ reason: "claim_text_not_supported", refs: ["C1"] }),
    ]);
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("does not bypass entailment when a paragraph copies a Claim before adding a new fact", async () => {
    const generated = JSON.stringify({
      answer: [{
        text: "The project uses SQLite and stores passwords in plaintext.",
        refs: ["C1"],
        kind: "fact",
      }],
    });
    const rejected = JSON.stringify({
      paragraphs: [{ id: "P1", supported: false }],
    });
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock(generated, rejected),
    });

    const result = await synthesizeVerifiedInsight(
      "Which database is used?",
      [verifiedEvidence("1", "The project uses SQLite")],
      env
    );

    expect(result.answer).toBe("Retrieved direct evidence is insufficient for a verified answer.");
    expect(result.verifiedClaims).toEqual([]);
    expect(result.unverifiedClaims).toEqual([
      expect.objectContaining({ reason: "claim_text_not_supported", refs: ["C1"] }),
    ]);
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("does not treat case-sensitive identifiers as an exact deterministic copy", async () => {
    const generated = JSON.stringify({
      answer: [{
        text: "database_url points to the production database.",
        refs: ["C1"],
        kind: "fact",
      }],
    });
    const rejected = JSON.stringify({
      paragraphs: [{ id: "P1", supported: false }],
    });
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock(generated, rejected),
    });

    const result = await synthesizeVerifiedInsight(
      "Which environment variable selects the production database?",
      [verifiedEvidence("1", "DATABASE_URL points to the production database")],
      env
    );

    expect(result.answer).toBe("Retrieved direct evidence is insufficient for a verified answer.");
    expect(result.verifiedClaims).toEqual([]);
    expect(result.unverifiedClaims).toEqual([
      expect.objectContaining({ reason: "claim_text_not_supported", refs: ["C1"] }),
    ]);
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("drops an unsupported paragraph while preserving supported cited paragraphs", async () => {
    const generated = JSON.stringify({
      answer: [{
        text: "The project currently relies on SQLite.",
        refs: ["C1"],
        kind: "fact",
      }, {
        text: "The project is production-ready.",
        refs: ["C2"],
        kind: "fact",
      }],
    });
    const verdict = JSON.stringify({
      paragraphs: [
        { id: "P1", supported: true },
        { id: "P2", supported: false },
      ],
    });
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock(generated, verdict),
    });

    const result = await synthesizeVerifiedInsight(
      "What is the current project state?",
      [{
        id: "entry-project",
        content: "Project state",
        claims: [{
          id: "claim-db",
          entryId: "entry-project",
          statement: "The project uses SQLite",
          status: "confirmed",
          verificationStatus: "confirmed",
          conflictIds: [],
          opposingClaimIds: [],
        }, {
          id: "claim-port",
          entryId: "entry-project",
          statement: "The project listens on port 8787",
          status: "confirmed",
          verificationStatus: "confirmed",
          conflictIds: [],
          opposingClaimIds: [],
        }],
      }],
      env,
      [],
      { activitySummary: true }
    );

    expect(result.answer).toBe("The project currently relies on SQLite. [C1]");
    expect(result.verifiedClaims).toEqual([
      expect.objectContaining({ refs: ["C1"] }),
    ]);
    expect(result.citations).toEqual([
      expect.objectContaining({ ref: "C1" }),
    ]);
    expect(result.unverifiedClaims).toEqual([]);
  });

  it("returns empty string when LLM throws — does not propagate error", async () => {
    const env = makeTestEnv(undefined, {
      AI: { run: vi.fn().mockRejectedValue(new Error("AI unavailable")) } as unknown as Ai,
    });
    const result = await synthesizeInsight("content", [verifiedEvidence("1", "content")], env);
    expect(result).toBe("");
  });

  it("returns empty string when LLM response text is empty", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("") });
    const result = await synthesizeInsight("content", [verifiedEvidence("1", "content")], env);
    expect(result).toBe("");
  });

  it("repairs one malformed successful model response with a bounded second call", async () => {
    const repaired = JSON.stringify({
      answer: [{
        text: "根据已验证记忆，项目使用 SQLite。",
        refs: ["C1"],
        kind: "fact",
      }],
    });
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock(
        "not valid JSON",
        repaired,
        JSON.stringify({ paragraphs: [{ id: "P1", supported: true }] })
      ),
    });

    const result = await synthesizeVerifiedInsight(
      "Which database is used?",
      [verifiedEvidence("1", "The project uses SQLite")],
      env
    );

    expect(result.answer).toBe("根据已验证记忆，项目使用 SQLite。 [C1]");
    expect(env.AI.run).toHaveBeenCalledTimes(3);
    const [, repairOptions] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(repairOptions.messages[0].content).toContain("Strict repair attempt");
    expect(repairOptions.messages[0].content).toContain("invalid_structured_response");
    expect(repairOptions.messages[0].content).not.toContain("not valid JSON");
  });

  it("stops after one failed structured-response repair", async () => {
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock("not valid JSON", "still not valid JSON"),
    });

    const result = await synthesizeVerifiedInsight(
      "Which database is used?",
      [verifiedEvidence("1", "The project uses SQLite")],
      env
    );

    expect(result.answer).toBe("Retrieved direct evidence is insufficient for a verified answer.");
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("regenerates from safe Claims when an activity summary mixes in a contested Claim", async () => {
    const firstResponse = JSON.stringify({
      answer: [{
        text: "你最近在推进旧数据库方案和 Singularity 回答修复。",
        refs: ["C1", "C2"],
        kind: "fact",
      }],
    });
    const safeResponse = JSON.stringify({
      answer: [{
        text: "你最近在推进 Singularity 回答修复。",
        refs: ["C2"],
        kind: "fact",
      }],
    });
    const env = makeTestEnv(undefined, {
      AI: aiSequenceMock(
        firstResponse,
        safeResponse,
        JSON.stringify({ paragraphs: [{ id: "P1", supported: true }] })
      ),
    });

    const result = await synthesizeVerifiedInsight(
      "我在忙什么？",
      {
        directEvidence: [{
          id: "entry-activity",
          content: "Recent project activity",
          claims: [{
            id: "claim-contested",
            entryId: "entry-activity",
            statement: "你正在推进旧数据库方案。",
            status: "contested",
            verificationStatus: "contested",
            conflictIds: ["conflict-database"],
            opposingClaimIds: ["claim-current"],
          }, {
            id: "claim-safe",
            entryId: "entry-activity",
            statement: "你正在推进 Singularity 回答修复。",
            status: "confirmed",
            verificationStatus: "confirmed",
            conflictIds: [],
            opposingClaimIds: [],
          }],
        }],
        relatedContext: [],
      },
      env,
      [],
      { activitySummary: true }
    );

    expect(result.answer).toBe("你最近在推进 Singularity 回答修复。 [C2]");
    expect(result.unverifiedClaims).toEqual([]);
    expect(env.AI.run).toHaveBeenCalledTimes(3);
    const [, firstOptions] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstOptions.messages[0].content).not.toContain("旧数据库方案");
    const [, retryOptions] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(retryOptions.messages[0].content).toContain("Allowed safe Claim data");
    expect(retryOptions.messages[0].content).toContain("[C2]");
    expect(retryOptions.messages[0].content).not.toContain("[C1]");
    expect(retryOptions.messages[0].content).not.toContain("旧数据库方案");
  });

  it("trims whitespace from LLM response", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock(`  ${structuredClaim("content")}  `) });
    const result = await synthesizeInsight("content", [verifiedEvidence("1", "content")], env);
    expect(result).toBe("Based on the verified memory, content [C1]");
  });

  it("includes the query in the prompt sent to LLM", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("ok") });
    await synthesizeInsight("fintech auth strategy", [verifiedEvidence("1", "note")], env);
    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages[0].content).toContain("fintech auth strategy");
  });

  it("includes all row content in the prompt", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("ok") });
    await synthesizeInsight("query", [
      verifiedEvidence("1", "JWT decision"),
      verifiedEvidence("2", "switched to Postgres"),
    ], env);
    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(messages[0].content).toContain("JWT decision");
    expect(messages[0].content).toContain("switched to Postgres");
  });

  it("does not expose Answerability conclusions to the model in shadow mode", async () => {
    const env = makeTestEnv(undefined, {
      ANSWERABILITY_MODE: "shadow",
      AI: aiMock(structuredClaim("The project uses SQLite")),
    });
    await synthesizeInsight("Which port is used?", [verifiedEvidence("1", "The project uses SQLite")], env);

    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = messages[0].content as string;
    expect(prompt).not.toContain("answerability=irrelevant");
    expect(prompt).not.toContain("Only cite a C* Claim whose answerability is");
    expect(prompt).toContain("Answerability is evaluated after model selection");
  });

  it("grounds the prompt: local evidence refs, insufficient-evidence path, no speculation", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("ok") });
    await synthesizeInsight("release v1.9", [verifiedEvidence("1", "note")], env);
    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = (messages[0].content as string).toLowerCase();
    expect(prompt).toContain("only");
    expect(prompt).toContain("[c1]");
    expect(prompt).toContain("insufficient");
    expect(prompt).toMatch(/speculate|guess|infer/);
  });

  it("instructs the model to disclose unresolved Claim conflicts", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("ok") });
    await synthesizeInsight(
      "which installer is used",
      [
        {
          id: "entry-old",
          content: "mtzs uses installation_proxy",
          claims: [{
            id: "claim-old",
            entryId: "entry-old",
            statement: "mtzs uses installation_proxy",
            status: "contested",
            verificationStatus: "contested",
            conflictIds: ["conflict-1"],
            opposingClaimIds: ["claim-new"],
          }],
        },
        {
          id: "entry-new",
          content: "mtzs uses new_installer",
          claims: [{
            id: "claim-new",
            entryId: "entry-new",
            statement: "mtzs uses new_installer",
            status: "contested",
            verificationStatus: "contested",
            conflictIds: ["conflict-1"],
            opposingClaimIds: ["claim-old"],
          }],
        },
      ],
      env,
      [{
        id: "conflict-1",
        state: "pending",
        reason: "different_object",
        claimIds: ["claim-old", "claim-new"],
        claims: [
          { id: "claim-old", entryId: "entry-old", statement: "mtzs uses installation_proxy", status: "contested" },
          { id: "claim-new", entryId: "entry-new", statement: "mtzs uses new_installer", status: "contested" },
        ],
      }]
    );

    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = messages[0].content as string;
    expect(prompt).toContain("conflict-1");
    expect(prompt).toContain("claim-old");
    expect(prompt).toContain("claim-new");
    expect(prompt.toLowerCase()).toMatch(/unresolved|未解决/);
  });

  it("separates direct Evidence refs from non-citable Association context refs", async () => {
    const env = makeTestEnv(undefined, {
      AI: aiMock(structuredClaim("The project uses SQLite")),
    });
    const result = await synthesizeInsight(
      "project database",
      {
        directEvidence: [verifiedEvidence("entry-direct", "The project uses SQLite")],
        relatedContext: [{
          id: "entry-related",
          content: "A related project uses Postgres",
          associationType: "references",
          hop: 1,
        }],
      },
      env
    );

    expect(result).toBe("Based on the verified memory, The project uses SQLite [C1]");
    const [, { messages }] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = messages[0].content as string;
    expect(prompt).toContain("[E1] evidence_id=entry-direct");
    expect(prompt).toContain("[C1] claim=claim-entry-direct");
    expect(prompt).toContain("statement=The project uses SQLite");
    expect(prompt).toContain("[R1] association=references; hop=1");
    expect(prompt).not.toContain("A related project uses Postgres");
    expect(prompt).toMatch(/R\*.*cannot|R1.*cannot|not factual evidence/i);
  });

  it("rejects model output that cites Association context as Evidence", async () => {
    const env = makeTestEnv(undefined, { AI: aiMock("The project uses Postgres [R1].") });
    const result = await synthesizeInsight(
      "project database",
      {
        directEvidence: [verifiedEvidence("entry-direct", "The project uses SQLite")],
        relatedContext: [{
          id: "entry-related",
          content: "A related project uses Postgres",
          associationType: "references",
          hop: 1,
        }],
      },
      env
    );

    expect(result).toContain("insufficient");
    expect(result).not.toContain("Postgres");
  });

  it("does not let an insufficient-evidence phrase bypass Association ref validation", async () => {
    const env = makeTestEnv(undefined, {
      AI: aiMock("Evidence is insufficient, but the project uses Postgres [R1]."),
    });
    const result = await synthesizeInsight(
      "project database",
      {
        directEvidence: [verifiedEvidence("entry-direct", "The project uses SQLite")],
        relatedContext: [{
          id: "entry-related",
          content: "A related project uses Postgres",
          associationType: "references",
          hop: 1,
        }],
      },
      env
    );

    expect(result).toBe("Retrieved direct evidence is insufficient for a verified answer.");
    expect(result).not.toContain("Postgres");
  });

  it("rejects missing and unknown direct Evidence refs", async () => {
    const missingRefEnv = makeTestEnv(undefined, {
      AI: aiMock(structuredClaim("The project uses SQLite", [])),
    });
    const unknownRefEnv = makeTestEnv(undefined, {
      AI: aiMock(structuredClaim("The project uses SQLite", ["C2"])),
    });

    await expect(synthesizeInsight(
      "project database",
      [verifiedEvidence("entry-direct", "The project uses SQLite")],
      missingRefEnv
    )).resolves.toBe("Retrieved direct evidence is insufficient for a verified answer.");
    await expect(synthesizeInsight(
      "project database",
      [verifiedEvidence("entry-direct", "The project uses SQLite")],
      unknownRefEnv
    )).resolves.toBe("Retrieved direct evidence is insufficient for a verified answer.");
  });
});
