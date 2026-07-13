import { describe, it, expect, vi } from "vitest";
import { checkDuplicateAndContradiction } from "../../src/index";
import type { MergeAction } from "../../src/index";
import { makeTestDb, makeVectorizeMock, makeKVMock } from "../helpers/make-env";
import type { Env } from "../../src/index";

function makeEnv(aiResponse: string, vectorMatches: any[] = [], dbEntries: any[] = []): Env {
  const db = makeTestDb();
  db.entries = dbEntries;
  return {
    DB: db as unknown as D1Database,
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({ matches: vectorMatches }),
    }),
    AI: {
      run: vi.fn().mockImplementation(async (model: string) => {
        if (model === "@cf/baai/bge-small-en-v1.5")
          return { data: [new Array(384).fill(0.1)] };
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(aiResponse)}}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        });
      }),
    } as unknown as Ai,
    AUTH_TOKEN: "test-token",
    OAUTH_KV: makeKVMock(),
  };
}

function entry(id: string, content: string) {
  return { id, content, tags: "[]", source: "claude", created_at: Date.now(), vector_ids: JSON.stringify([id]), recall_count: 0, importance_score: 0 };
}

function match(id: string, score: number) {
  return { id, score, metadata: { parentId: id } };
}

describe("checkDuplicateAndContradiction()", () => {
  it("returns unique + no contradiction when all matches are below threshold", async () => {
    const env = makeEnv("", [match("a", 0.3)], [entry("a", "I enjoy hiking")]);
    const { duplicate, contradiction } = await checkDuplicateAndContradiction("I live in Paris", env);
    expect(duplicate.status).toBe("unique");
    expect(contradiction.detected).toBe(false);
  });

  it("passes the active embedding fingerprint filter to the vector query", async () => {
    const queryFn = vi.fn().mockResolvedValue({ matches: [match("a", 0.3)] });
    const env = makeEnv("", [], [entry("a", "I enjoy hiking")]);
    (env.VECTORIZE as any).query = queryFn;

    await checkDuplicateAndContradiction("I live in Paris", env);

    const [, options] = queryFn.mock.calls[0];
    expect(options.filter).toEqual({
      embedding_fingerprint: expect.any(String),
      source: { $ne: "singularity-claim" },
    });
  });

  it("does not use an unfiltered Top-K fallback when the source metadata index is missing", async () => {
    const queryFn = vi.fn().mockRejectedValueOnce(new Error("metadata index missing for source"));
    const env = makeEnv("", [], [entry("a", "I enjoy hiking")]);
    (env.VECTORIZE as any).query = queryFn;

    const { duplicate } = await checkDuplicateAndContradiction("I enjoy hiking", env);

    expect(duplicate.status).toBe("unique");
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][1].filter).toEqual({
      embedding_fingerprint: expect.any(String),
      source: { $ne: "singularity-claim" },
    });
  });

  it("returns no contradiction when LLM says no contradiction", async () => {
    const env = makeEnv(
      '{"contradicts": false}',
      [match("a", 0.7)],
      [entry("a", "I enjoy hiking")]
    );
    const { contradiction } = await checkDuplicateAndContradiction("I live in NYC", env);
    expect(contradiction.detected).toBe(false);
  });

  it("detects a contradiction and returns conflicting_id and reason", async () => {
    const env = makeEnv(
      '{"contradicts": true, "conflicting_id": "abc123", "reason": "different city"}',
      [match("abc123", 0.72)],
      [entry("abc123", "I live in NYC")]
    );
    const { contradiction } = await checkDuplicateAndContradiction("I moved to LA last year", env);
    expect(contradiction.detected).toBe(true);
    expect(contradiction.conflicting_id).toBe("abc123");
    expect(contradiction.reason).toBe("different city");
  });

  it("maps masked numeric contradiction refs back to real IDs without exposing IDs in the prompt", async () => {
    const env = makeEnv(
      '{"contradicts": true, "conflicting_id": "1", "reason": "different city"}',
      [match("abc123", 0.72)],
      [entry("abc123", "I live in NYC")]
    );
    const { contradiction } = await checkDuplicateAndContradiction("I moved to LA last year", env);
    expect(contradiction.detected).toBe(true);
    expect(contradiction.conflicting_id).toBe("abc123");

    const llmCall = (env.AI.run as any).mock.calls.find(
      ([model]: [string]) => model !== "@cf/baai/bge-small-en-v1.5"
    );
    expect(JSON.stringify(llmCall?.[1] ?? "")).not.toContain("abc123");
    expect(JSON.stringify(llmCall?.[1] ?? "")).toContain("[1]");
  });

  it("ignores a hallucinated ID not in the candidate results", async () => {
    const env = makeEnv(
      '{"contradicts": true, "conflicting_id": "made-up-id", "reason": "different city"}',
      [match("real-id", 0.72)],
      [entry("real-id", "I live in NYC")]
    );
    const { contradiction } = await checkDuplicateAndContradiction("I moved to LA", env);
    expect(contradiction.detected).toBe(false);
  });

  it("returns no contradiction when LLM returns malformed JSON", async () => {
    const env = makeEnv(
      "Sorry, I cannot help with that.",
      [match("a", 0.7)],
      [entry("a", "I live in NYC")]
    );
    const { contradiction } = await checkDuplicateAndContradiction("I moved to LA", env);
    expect(contradiction.detected).toBe(false);
  });

  it("returns no contradiction when AI throws", async () => {
    const db = makeTestDb();
    db.entries = [entry("a", "I live in NYC")];
    const env: Env = {
      DB: db as unknown as D1Database,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [match("a", 0.72)] }),
      }),
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
          throw new Error("AI service unavailable");
        }),
      } as unknown as Ai,
      AUTH_TOKEN: "test-token",
      OAUTH_KV: makeKVMock(),
    };
    const { contradiction } = await checkDuplicateAndContradiction("I moved to LA", env);
    expect(contradiction.detected).toBe(false);
  });

  it("flags near-exact semantic matches (score ≥ 0.95) without hard-blocking — PR5 stop-fact-loss", async () => {
    const queryFn = vi.fn().mockResolvedValue({ matches: [match("a", 0.96)] });
    const env = makeEnv("", [match("a", 0.96)], [entry("a", "Original content")]);
    (env.VECTORIZE as any).query = queryFn;
    const { duplicate, contradiction } = await checkDuplicateAndContradiction("Original content", env);
    expect(duplicate.status).toBe("flagged");
    expect(contradiction.detected).toBe(false);
  });

  it("returns flagged duplicate status", async () => {
    // score 0.88 → flagged band; combined prompt runs; "keep_both" is the safe default
    const env = makeEnv('{"action":"keep_both"}', [match("a", 0.88)], [entry("a", "Similar content")]);
    const { duplicate, mergeAction } = await checkDuplicateAndContradiction("Similar content", env);
    expect(duplicate.status).toBe("flagged");
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  // ── Smart merge (flagged band 0.85–0.95) ────────────────────────────────────

  it("returns mergeAction=keep_both for flagged entry when LLM says keep_both", async () => {
    const env = makeEnv('{"action":"keep_both"}', [match("near", 0.88)], [entry("near", "I prefer dark mode")]);
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("returns mergeAction=replace with validated target_id for flagged entry", async () => {
    const env = makeEnv(
      '{"action":"replace","target_id":"near"}',
      [match("near", 0.88)],
      [entry("near", "I use VSCode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I switched to Cursor", env);
    expect(mergeAction).toEqual({ action: "replace", target_id: "near" });
  });

  it("maps masked numeric merge targets back to real IDs without exposing IDs in the prompt", async () => {
    const env = makeEnv(
      '{"action":"replace","target_id":"1"}',
      [match("near", 0.88)],
      [entry("near", "I use VSCode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I switched to Cursor", env);
    expect(mergeAction).toEqual({ action: "replace", target_id: "near" });

    const llmCall = (env.AI.run as any).mock.calls.find(
      ([model]: [string]) => model !== "@cf/baai/bge-small-en-v1.5"
    );
    expect(JSON.stringify(llmCall?.[1] ?? "")).not.toContain("near");
    expect(JSON.stringify(llmCall?.[1] ?? "")).toContain("[1]");
  });

  it("returns mergeAction=merge with a validated target_id without generating rewritten content", async () => {
    const env = makeEnv(
      '{"action":"merge","target_id":"near"}',
      [match("near", 0.88)],
      [entry("near", "I prefer dark mode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode especially at night", env);
    expect(mergeAction).toEqual({
      action: "merge",
      target_id: "near",
    });
  });

  it("returns contradiction (not mergeAction) when combined prompt returns contradiction for flagged entry", async () => {
    const env = makeEnv(
      '{"action":"contradiction","conflicting_id":"near","reason":"different city"}',
      [match("near", 0.88)],
      [entry("near", "I live in NYC")]
    );
    const { contradiction, mergeAction } = await checkDuplicateAndContradiction("I live in LA", env);
    expect(contradiction.detected).toBe(true);
    expect(contradiction.conflicting_id).toBe("near");
    expect(mergeAction).toBeNull();
  });

  it("falls back to keep_both when flagged LLM throws", async () => {
    const db = makeTestDb();
    db.entries = [entry("near", "I prefer dark mode")];
    const env: Env = {
      DB: db as unknown as D1Database,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [match("near", 0.88)] }),
      }),
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
          throw new Error("AI unavailable");
        }),
      } as unknown as Ai,
      AUTH_TOKEN: "test-token",
      OAUTH_KV: makeKVMock(),
    };
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("falls back to keep_both when flagged LLM returns malformed JSON", async () => {
    const env = makeEnv("Sorry, I cannot help.", [match("near", 0.88)], [entry("near", "I prefer dark mode")]);
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("falls back to keep_both when replace target_id is a hallucinated ID", async () => {
    const env = makeEnv(
      '{"action":"replace","target_id":"made-up-id"}',
      [match("real-id", 0.88)],
      [entry("real-id", "I use VSCode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I switched to Cursor", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("falls back to keep_both when merge target_id is hallucinated", async () => {
    const env = makeEnv(
      '{"action":"merge","target_id":"fake-id"}',
      [match("real-id", 0.88)],
      [entry("real-id", "I prefer dark mode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode at night", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("falls back to keep_both when merge target_id is missing", async () => {
    const env = makeEnv(
      '{"action":"merge"}',
      [match("near", 0.88)],
      [entry("near", "I prefer dark mode")]
    );
    const { mergeAction } = await checkDuplicateAndContradiction("I like dark mode", env);
    expect(mergeAction).toEqual({ action: "keep_both" });
  });

  it("returns mergeAction=null for non-flagged entries (0.45–0.85 range unchanged)", async () => {
    const env = makeEnv(
      '{"contradicts": false}',
      [match("a", 0.72)],
      [entry("a", "I enjoy hiking")]
    );
    const { mergeAction, contradiction } = await checkDuplicateAndContradiction("I live in Paris", env);
    expect(mergeAction).toBeNull();
    expect(contradiction.detected).toBe(false);
  });

  it("returns mergeAction=null for non-flagged entries (0.45–0.85 range unchanged)", async () => {
    const env = makeEnv("", [match("a", 0.6)], [entry("a", "I live in Paris")]);
    const { mergeAction, contradiction } = await checkDuplicateAndContradiction("I live in Paris", env);
    expect(mergeAction).toBeNull();
    expect(contradiction.detected).toBe(false);
  });
});
