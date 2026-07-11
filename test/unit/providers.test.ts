import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createEmbedding,
  createLLM,
  OpenAICompatibleEmbedding,
  OpenAICompatibleLLM,
  WorkersAILLM,
  DEFAULT_WORKERS_LLM_MODEL,
} from "../../src/providers";

describe("createLLM / createEmbedding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses OpenAI-compatible LLM when LLM_BASE_URL + LLM_API_KEY are set", async () => {
    const llm = await createLLM({
      LLM_BASE_URL: "https://api.deepseek.com/v1",
      LLM_API_KEY: "sk-test",
      LLM_MODEL: "deepseek-chat",
      AI: { run: vi.fn() } as unknown as Ai,
    });
    expect(llm).toBeInstanceOf(OpenAICompatibleLLM);
  });

  it("falls back to Workers AI when external LLM env is unset", async () => {
    const llm = await createLLM({
      AI: { run: vi.fn() } as unknown as Ai,
    });
    expect(llm).toBeInstanceOf(WorkersAILLM);
  });

  it("throws when neither external LLM nor Workers AI is available", async () => {
    await expect(createLLM({})).rejects.toThrow(/No LLM configured/);
  });

  it("does not fall back to Workers AI in self-host mode", async () => {
    await expect(createLLM({
      SELFHOST: "1",
      AI: { run: vi.fn() } as unknown as Ai,
    })).rejects.toThrow(/No LLM configured/);
  });

  it("uses OpenAI-compatible embedding when EMBEDDING_* is set", async () => {
    const emb = await createEmbedding({
      EMBEDDING_BASE_URL: "https://api.openai.com/v1",
      EMBEDDING_API_KEY: "sk-test",
      EMBEDDING_MODEL: "text-embedding-3-small",
      AI: { run: vi.fn() } as unknown as Ai,
    });
    expect(emb).toBeInstanceOf(OpenAICompatibleEmbedding);
  });

  it("uses local hash only when explicitly allowed for dev", async () => {
    const { LocalHashEmbedding } = await import("../../src/providers");
    const emb = await createEmbedding({
      SELFHOST: "1",
      EMBEDDING_PROVIDER: "local-hash-dev",
      ALLOW_DEV_EMBEDDING: "true",
    });
    expect(emb).toBeInstanceOf(LocalHashEmbedding);
    const v = await emb.embed("hello world");
    expect(v).toHaveLength(384);
  });

  it("rejects bare self-host without real embedding or ALLOW_DEV_EMBEDDING", async () => {
    await expect(createEmbedding({
      SELFHOST: "1",
      AI: { run: vi.fn() } as unknown as Ai,
    })).rejects.toThrow(/not configured/i);
  });
});

describe("OpenAICompatibleLLM", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs chat/completions and returns message content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello from deepseek" } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const llm = new OpenAICompatibleLLM({
      baseURL: "https://api.deepseek.com/v1/",
      apiKey: "sk-test",
      model: "deepseek-chat",
    });
    const text = await llm.chat([{ role: "user", content: "hi" }], { max_tokens: 32 });
    expect(text).toBe("hello from deepseek");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(false);
    expect(body.messages[0].content).toBe("hi");
  });

  it("chatAsCfSse streams OpenAI-compatible deltas as Workers-compatible events", async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"stream"}}]}\n\nda'));
        controller.enqueue(encoder.encode('ta: {"choices":[{"delta":{"content":" me"}}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const llm = new OpenAICompatibleLLM({
      baseURL: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
    });
    const stream = await llm.chatAsCfSse([{ role: "user", content: "x" }]);
    const raw = await new Response(stream).text();
    expect(raw).toContain('"response":"stream"');
    expect(raw).toContain('"response":" me"');
    expect(raw).toContain("[DONE]");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
  });
});

describe("WorkersAILLM", () => {
  it("uses the default CF model name", async () => {
    const run = vi.fn().mockResolvedValue({ response: "ok" });
    const llm = new WorkersAILLM({ run } as unknown as Ai);
    const text = await llm.chat([{ role: "user", content: "hi" }], { max_tokens: 10 });
    expect(text).toBe("ok");
    expect(run).toHaveBeenCalledWith(
      DEFAULT_WORKERS_LLM_MODEL,
      expect.objectContaining({ max_tokens: 10 })
    );
    // stream must stay undefined for non-stream chat (derivePattern contract)
    expect(run.mock.calls[0][1].stream).toBeUndefined();
  });
});

describe("OpenAICompatibleEmbedding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns data[0].embedding", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const emb = new OpenAICompatibleEmbedding({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk",
      model: "text-embedding-3-small",
    });
    await expect(emb.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).input).toBe("hello");
  });

  it("embeds OpenAI-compatible batches with array input", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const emb = new OpenAICompatibleEmbedding({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk",
      model: "text-embedding-3-small",
      dimensions: 2,
    });

    await expect(emb.embedMany(["first", "second"])).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).input).toEqual(["first", "second"]);
  });

  it("uses MiniMax native texts/type body and vectors[] response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        vectors: [[0.01, 0.02, 0.03]],
        base_resp: { status_code: 0, status_msg: "" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const emb = new OpenAICompatibleEmbedding({
      baseURL: "https://api.minimaxi.com/v1",
      apiKey: "sk-mm",
      model: "embo-01",
      dimensions: 3,
      sendDimensionsParameter: false,
    });
    await expect(emb.embed("probe", { purpose: "query" })).resolves.toEqual([
      0.01, 0.02, 0.03,
    ]);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.texts).toEqual(["probe"]);
    expect(body.type).toBe("query");
    expect(body.model).toBe("embo-01");
    expect(body.input).toBeUndefined();
    expect(body.dimensions).toBeUndefined();
  });

  it("surfaces MiniMax base_resp errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          base_resp: { status_code: 2013, status_msg: "invalid params" },
        }),
      })
    );
    const emb = new OpenAICompatibleEmbedding({
      baseURL: "https://api.minimax.io/v1",
      apiKey: "sk",
      model: "embo-01",
    });
    await expect(emb.embed("x")).rejects.toThrow(/2013|invalid params/);
  });
});
