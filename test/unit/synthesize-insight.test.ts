import { describe, it, expect, vi } from "vitest";
import {
  resolveVerifiedRecallInsight,
  synthesizeInsight,
  synthesizeVerifiedInsight,
  type Env,
} from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";

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
      expect(requestBody.max_tokens).toBeGreaterThanOrEqual(800);
      expect(requestBody.messages[0].content).toContain(
        '{"answer":"","claims":[{"refs":["C1"],"kind":"fact"}]}'
      );
      expect(requestBody.messages[0].content).not.toContain(
        '{"answer":"","claims":[{"text":"","refs"'
      );
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
      AI: aiMock(structuredClaim("Conflict", ["C1", "C2"], "conflict")),
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
    expect(result).toEqual({
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
