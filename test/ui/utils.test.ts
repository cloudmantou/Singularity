import { describe, it, expect, vi } from "vitest";

const {
  parseRecallResult,
  escHtml,
  escAttr,
  toDateStr,
  createCfSseParser,
  createRecallSseParser,
  createRecallDraftAnimator,
  consumeRecallSseResponse,
  parseApiJsonResponse,
  importEntriesInBatches,
} = require("../../public/utils.js");

describe("importEntriesInBatches", () => {
  it("sends five entries as sequential 4 + 1 batches and aggregates totals", async () => {
    const calls: number[][] = [];
    let active = 0;
    let maxActive = 0;
    const result = await importEntriesInBatches([1, 2, 3, 4, 5], async (batch: number[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(batch);
      await Promise.resolve();
      active -= 1;
      return {
        ok: true,
        inserted: batch.length,
        skipped: 0,
        updated: 0,
        failed: 0,
        pendingVectorizeCount: batch.length,
      };
    }, 4);

    expect(calls).toEqual([[1, 2, 3, 4], [5]]);
    expect(maxActive).toBe(1);
    expect(result).toMatchObject({ inserted: 5, pendingVectorizeCount: 5 });
  });

  it("stops after a failed batch", async () => {
    let calls = 0;
    await expect(importEntriesInBatches([1, 2, 3, 4, 5], async () => {
      calls += 1;
      if (calls === 2) throw new Error("batch failed");
      return { ok: true, inserted: 4 };
    }, 4)).rejects.toThrow("batch failed");
    expect(calls).toBe(2);
  });
});

describe("parseApiJsonResponse", () => {
  it("returns a successful REST payload", async () => {
    const response = new Response(JSON.stringify({ ok: true, id: "memory-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    await expect(parseApiJsonResponse(response, "Save failed")).resolves.toEqual({
      ok: true,
      id: "memory-1",
    });
  });

  it("rejects an HTTP error with the server-safe message", async () => {
    const response = new Response(
      JSON.stringify({ ok: false, error: "Append failed. Retry later." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );

    await expect(parseApiJsonResponse(response, "Append failed")).rejects.toThrow(
      "Append failed. Retry later."
    );
  });

  it("rejects a 200 response whose API contract says ok:false", async () => {
    const response = new Response(JSON.stringify({ ok: false, error: "Not stored" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    await expect(parseApiJsonResponse(response, "Save failed")).rejects.toThrow(
      "Not stored"
    );
  });

  it("allows the capture duplicate outcome when explicitly requested", async () => {
    const response = new Response(
      JSON.stringify({ ok: false, duplicate: true, matchId: "existing" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

    await expect(
      parseApiJsonResponse(response, "Save failed", { allowDuplicate: true })
    ).resolves.toMatchObject({ duplicate: true, matchId: "existing" });
  });

  it("does not accept a duplicate body from a failed HTTP response", async () => {
    const response = new Response(JSON.stringify({ duplicate: true }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });

    await expect(
      parseApiJsonResponse(response, "Save failed", { allowDuplicate: true })
    ).rejects.toThrow("Save failed (HTTP 503)");
  });

  it("rejects malformed JSON without exposing the response body", async () => {
    const response = new Response("<html>private upstream error</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });

    await expect(parseApiJsonResponse(response, "Save failed")).rejects.toThrow(
      "Save failed (HTTP 502)"
    );
  });
});

describe("createCfSseParser", () => {
  it("preserves a JSON event split across network chunks", () => {
    const deltas: string[] = [];
    let done = false;
    const parser = createCfSseParser({
      onResponse: (text: string) => deltas.push(text),
      onDone: () => { done = true; },
    });

    parser.push('data: {"res');
    parser.push('ponse":"你好"}\n\nda');
    parser.push('ta: [DONE]\n\n');
    parser.finish();

    expect(deltas).toEqual(["你好"]);
    expect(done).toBe(true);
  });

  it("parses multiple response events from one chunk", () => {
    const deltas: string[] = [];
    const parser = createCfSseParser({ onResponse: (text: string) => deltas.push(text) });

    parser.push('data: {"response":"最近"}\n\ndata: {"response":"在开发"}\n\n');
    parser.finish();

    expect(deltas.join("")).toBe("最近在开发");
  });
});

describe("createRecallSseParser", () => {
  it("preserves event order across split chunks and exposes only the final payload as final", () => {
    const events: string[] = [];
    let finalPayload: unknown = null;
    const parser = createRecallSseParser({
      onStatus: (phase: string) => events.push(`status:${phase}`),
      onDraftDelta: (delta: string) => events.push(`draft:${delta}`),
      onFinal: (data: unknown) => {
        events.push("final");
        finalPayload = data;
      },
      onDone: () => events.push("done"),
    });

    parser.push('data: {"type":"status","phase":"retr');
    parser.push('ieval"}\n\ndata: {"type":"draft_delta","delta":"你');
    parser.push('好"}\n\ndata: {"type":"final","data":{"ok":true,"answer":"你好 [C1]"}}\n\n');
    parser.push('data: [DONE]\n\n');
    parser.finish();

    expect(events).toEqual([
      "status:retrieval",
      "draft:你好",
      "final",
      "done",
    ]);
    expect(finalPayload).toEqual({ ok: true, answer: "你好 [C1]" });
  });

  it("reports malformed events without manufacturing a final payload", () => {
    const errors: unknown[] = [];
    const finals: unknown[] = [];
    const parser = createRecallSseParser({
      onError: (error: unknown) => errors.push(error),
      onFinal: (data: unknown) => finals.push(data),
    });

    parser.push('data: {not-json}\n\n');
    parser.finish();

    expect(errors).toHaveLength(1);
    expect(finals).toEqual([]);
  });
});

describe("consumeRecallSseResponse", () => {
  it("streams draft callbacks but resolves only the single completed final payload", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"type":"draft_delta","delta":"草稿"}\n\n'
        ));
        controller.enqueue(encoder.encode(
          'data: {"type":"final","data":{"ok":true,"answer":"最终答案"}}\n\n'
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const drafts: string[] = [];
    const finals: unknown[] = [];

    const result = await consumeRecallSseResponse(response, {
      onDraftDelta: (delta: string) => drafts.push(delta),
      onFinal: (data: unknown) => finals.push(data),
    });

    expect(drafts).toEqual(["草稿"]);
    expect(finals).toEqual([{ ok: true, answer: "最终答案" }]);
    expect(result).toEqual({ ok: true, answer: "最终答案" });
  });

  it("rejects a completed stream that never produced a final payload", async () => {
    const response = new Response(
      'data: {"type":"draft_delta","delta":"未经验证"}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );

    await expect(consumeRecallSseResponse(response)).rejects.toThrow(
      "Recall stream ended without a final response"
    );
  });

  it("rejects duplicate final events", async () => {
    const response = new Response(
      'data: {"type":"final","data":{"ok":true,"answer":"A"}}\n\n' +
      'data: {"type":"final","data":{"ok":true,"answer":"B"}}\n\n' +
      'data: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );

    await expect(consumeRecallSseResponse(response)).rejects.toThrow(
      "Recall stream produced multiple final responses"
    );
  });

  it("rejects events delivered after DONE in the same network chunk", async () => {
    const response = new Response(
      'data: {"type":"final","data":{"ok":true}}\n\n' +
      'data: [DONE]\n\n' +
      'data: {"type":"draft_delta","delta":"late"}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );

    await expect(consumeRecallSseResponse(response)).rejects.toThrow("after DONE");
  });

  it("cancels the response stream immediately after the first protocol error", async () => {
    const cancel = vi.fn();
    const drafts: string[] = [];
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"error","message":"invalid stream"}\n\n' +
          'data: {"type":"draft_delta","delta":"must not render"}\n\n'
        ));
      },
      cancel,
    }), { status: 200 });

    await expect(consumeRecallSseResponse(response, {
      onDraftDelta: (delta: string) => drafts.push(delta),
    })).rejects.toThrow("invalid stream");
    expect(cancel).toHaveBeenCalledOnce();
    expect(drafts).toEqual([]);
  });
});

describe("createRecallDraftAnimator", () => {
  it("reveals streamed text one character per animation tick", async () => {
    vi.useFakeTimers();
    const updates: string[] = [];
    const animator = createRecallDraftAnimator({
      intervalMs: 12,
      onText: (text: string) => updates.push(text),
    });

    animator.push("你好呀");
    expect(updates).toEqual([]);

    await vi.advanceTimersByTimeAsync(12);
    expect(updates).toEqual(["你"]);
    await vi.advanceTimersByTimeAsync(12);
    expect(updates).toEqual(["你", "你好"]);

    const finished = animator.finish();
    await vi.runAllTimersAsync();
    await finished;
    expect(updates.at(-1)).toBe("你好呀");
    vi.useRealTimers();
  });

  it("holds split citation markers out of the temporary draft", async () => {
    vi.useFakeTimers();
    let visible = "";
    const animator = createRecallDraftAnimator({
      intervalMs: 10,
      onText: (text: string) => { visible = text; },
    });

    animator.push("进度 [");
    await vi.runAllTimersAsync();
    expect(visible).toBe("进度");

    animator.push("C12] 已完成");
    const finished = animator.finish();
    await vi.runAllTimersAsync();
    await finished;
    expect(visible).toBe("进度 已完成");
    vi.useRealTimers();
  });

  it("cancels queued characters without writing more text", async () => {
    vi.useFakeTimers();
    const updates: string[] = [];
    const animator = createRecallDraftAnimator({
      intervalMs: 10,
      onText: (text: string) => updates.push(text),
    });

    animator.push("不会全部显示");
    await vi.advanceTimersByTimeAsync(10);
    animator.cancel();
    await vi.runAllTimersAsync();

    expect(updates).toEqual(["不"]);
    vi.useRealTimers();
  });
});

describe("parseRecallResult", () => {
  it("parses a JSON array of entries", () => {
    const json = JSON.stringify([
      { score: 87, content: "My note content", tags: ["api"], id: "abc-123" },
    ]);
    const results = parseRecallResult(json);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(87);
    expect(results[0].id).toBe("abc-123");
    expect(results[0].content).toBe("My note content");
    expect(results[0].tags).toEqual(["api"]);
  });

  it("normalises 0–1 similarity scores to percent", () => {
    const json = JSON.stringify([{ score: 0.87, content: "note", tags: [], id: "x" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(87);
  });

  it("parses multiple text list blocks", () => {
    const text = [
      "1. [90%] First note (id: id-1)",
      "2. [75%] Second note (id: id-2)",
    ].join("\n");
    const results = parseRecallResult(text);
    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(90);
    expect(results[1].score).toBe(75);
  });

  it("returns empty array for empty string", () => {
    expect(parseRecallResult("")).toEqual([]);
  });

  it("returns empty array for null / undefined", () => {
    expect(parseRecallResult(null)).toEqual([]);
    expect(parseRecallResult(undefined)).toEqual([]);
  });

  it("parses hashtags out of body text", () => {
    const text = `1. [80%] Tagged note #react #typescript (id: t1)`;
    const results = parseRecallResult(text);
    expect(results[0].tags).toEqual(["react", "typescript"]);
    expect(results[0].content).toBe("Tagged note");
  });

  it("parses Chinese hashtags with the same Unicode rules as the server", () => {
    const results = parseRecallResult(`1. [80%] 中文笔记 #记忆 #黑洞设计 (id: t2)`);
    expect(results[0].tags).toEqual(["记忆", "黑洞设计"]);
    expect(results[0].content).toBe("中文笔记");
  });

  it("preserves C# syntax and overlong Unicode hashtag text", () => {
    const longTag = "记".repeat(16);
    const results = parseRecallResult(`1. [80%] C#中文教程 #${longTag} (id: t3)`);
    expect(results[0].tags).toEqual([]);
    expect(results[0].content).toBe(`C#中文教程 #${longTag}`);
  });

  it("preserves a hashtag that exceeds the byte limit after lowercasing", () => {
    const expandsWhenLowercased = "İ".repeat(23);
    const results = parseRecallResult(`1. [80%] note #${expandsWhenLowercased} (id: t4)`);
    expect(results[0].tags).toEqual([]);
    expect(results[0].content).toBe(`note #${expandsWhenLowercased}`);
  });

  it("returns null id when no (id: …) marker is present", () => {
    const text = `1. [70%] Content without ID`;
    const results = parseRecallResult(text);
    expect(results[0].id).toBeNull();
    expect(results[0].content).toBe("Content without ID");
  });
});

describe("parseRecallResult — direct object input (non-string path)", () => {
  it("accepts a plain JS object with a .results array (skips JSON.parse)", () => {
    const results = parseRecallResult({ results: [{ score: 80, content: "direct object", tags: [], id: "o1" }] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("direct object");
    expect(results[0].score).toBe(80);
  });

  it("parses the GET /recall REST response shape — one entry per result, regardless of content", () => {
    // Contract test: the REST response shape must yield one entry per result,
    // never splitting on list items inside content (the old text-parsing bug).
    // The recall chat flow now maps data.results directly (inline in index.html,
    // not testable here); this pins the shape both depend on.
    const restResponse = {
      ok: true,
      results: [
        { id: "r1", content: "Changelog:\n- item one\n- item two\n1. numbered line", score: 87.3, tags: ["work"], source: "api", created_at: 1717000000000, updated: false },
        { id: "r2", content: "Plain note", score: 64.9, tags: [], source: "claude-desktop", created_at: 1717000001000, updated: true },
      ],
      insight: "Some synthesized insight.",
    };
    const results = parseRecallResult(restResponse);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "r1", score: 87, tags: ["work"] });
    expect(results[0].content).toContain("- item one");
    expect(results[1]).toMatchObject({ id: "r2", score: 65, content: "Plain note" });
  });
});

describe("parseRecallResult — text block with no score", () => {
  it("defaults score to 0 when no [NN%] marker is present", () => {
    const text = "- A note with no score at all";
    const results = parseRecallResult(text);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0);
    expect(results[0].content).toBe("A note with no score at all");
  });
});

describe("normalizeEntry (via parseRecallResult JSON path)", () => {
  it("parses tags when they are a JSON string", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: '["a","b"]', id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].tags).toEqual(["a", "b"]);
  });

  it("coerces a plain string tag into a single-element array", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: "mytag", id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].tags).toEqual(["mytag"]);
  });

  it("uses e.similarity as score fallback when e.score is absent", () => {
    const json = JSON.stringify([{ similarity: 0.72, content: "note", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(72);
  });

  it("uses e.text as content fallback when e.content is absent", () => {
    const json = JSON.stringify([{ score: 50, text: "fallback content", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].content).toBe("fallback content");
  });

  it("score 0.0 stays 0 (boundary: not in 0–1 range)", () => {
    const json = JSON.stringify([{ score: 0.0, content: "note", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(0);
  });

  it("score 1.0 converts to 100 (boundary: exactly 1)", () => {
    const json = JSON.stringify([{ score: 1.0, content: "note", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(100);
  });

  it("score defaults to 0 when both score and similarity are absent", () => {
    const json = JSON.stringify([{ content: "note", tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].score).toBe(0);
  });

  it("coerces a falsy string tag ('') to an empty array", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: "", id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].tags).toEqual([]);
  });

  it("coerces a non-array non-string tags value (number) to an empty array", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: 42, id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].tags).toEqual([]);
  });

  it("returns empty string for content when both content and text are absent", () => {
    const json = JSON.stringify([{ score: 50, tags: [], id: "1" }]);
    const results = parseRecallResult(json);
    expect(results[0].content).toBe("");
  });

  it("returns null for id when id field is absent", () => {
    const json = JSON.stringify([{ score: 50, content: "note", tags: [] }]);
    const results = parseRecallResult(json);
    expect(results[0].id).toBeNull();
  });
});

describe("parseRecallResult — JSON property fallbacks", () => {
  it("extracts entries from a .results wrapper object", () => {
    const json = JSON.stringify({ results: [{ score: 80, content: "from results", tags: [], id: "r1" }] });
    const results = parseRecallResult(json);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("from results");
  });

  it("extracts entries from a .memories wrapper object", () => {
    const json = JSON.stringify({ memories: [{ score: 70, content: "from memories", tags: [], id: "m1" }] });
    const results = parseRecallResult(json);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("from memories");
  });

  it("extracts entries from an .entries wrapper object", () => {
    const json = JSON.stringify({ entries: [{ score: 60, content: "from entries", tags: [], id: "e1" }] });
    const results = parseRecallResult(json);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("from entries");
  });
});

describe("escHtml", () => {
  it("escapes < and >", () => {
    expect(escHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes &", () => {
    expect(escHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes double quotes", () => {
    expect(escHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("leaves safe strings unchanged", () => {
    expect(escHtml("hello world")).toBe("hello world");
  });

  it("returns empty string for null input", () => {
    expect(escHtml(null)).toBe("");
  });

  it("escapes single quotes to &#39;", () => {
    expect(escHtml("it's")).toBe("it&#39;s");
  });
});

describe("escAttr", () => {
  it("escapes single quotes", () => {
    expect(escAttr("it's")).toBe("it\\'s");
  });

  it("replaces newlines with spaces", () => {
    expect(escAttr("line1\nline2")).toBe("line1 line2");
  });

  it("escapes backslashes", () => {
    expect(escAttr("C:\\path")).toBe("C:\\\\path");
  });

  it("removes carriage returns", () => {
    expect(escAttr("line1\rline2")).toBe("line1line2");
  });

  it("returns empty string for null input", () => {
    expect(escAttr(null)).toBe("");
  });
});

describe("toDateStr", () => {
  it("returns zero-padded yyyy-mm-dd", () => {
    const d = new Date(2026, 4, 20); // May 20 2026
    expect(toDateStr(d)).toBe("2026-05-20");
  });

  it("zero-pads single-digit month and day", () => {
    const d = new Date(2026, 0, 1); // January 1 2026
    expect(toDateStr(d)).toBe("2026-01-01");
  });

  it("zero-pads December correctly", () => {
    const d = new Date(2026, 11, 31); // December 31 2026
    expect(toDateStr(d)).toBe("2026-12-31");
  });
});
