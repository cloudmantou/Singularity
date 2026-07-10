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

  it("uses OpenAI-compatible LLM when LLM_BASE_URL + LLM_API_KEY are set", () => {
    const llm = createLLM({
      LLM_BASE_URL: "https://api.deepseek.com/v1",
      LLM_API_KEY: "sk-test",
      LLM_MODEL: "deepseek-chat",
      AI: { run: vi.fn() } as unknown as Ai,
    });
    expect(llm).toBeInstanceOf(OpenAICompatibleLLM);
  });

  it("falls back to Workers AI when external LLM env is unset", () => {
    const llm = createLLM({
      AI: { run: vi.fn() } as unknown as Ai,
    });
    expect(llm).toBeInstanceOf(WorkersAILLM);
  });

  it("throws when neither external LLM nor Workers AI is available", () => {
    expect(() => createLLM({})).toThrow(/No LLM configured/);
  });

  it("uses OpenAI-compatible embedding when EMBEDDING_* is set", () => {
    const emb = createEmbedding({
      EMBEDDING_BASE_URL: "https://api.openai.com/v1",
      EMBEDDING_API_KEY: "sk-test",
      EMBEDDING_MODEL: "text-embedding-3-small",
      AI: { run: vi.fn() } as unknown as Ai,
    });
    expect(emb).toBeInstanceOf(OpenAICompatibleEmbedding);
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

  it("chatAsCfSse emits Workers-compatible response deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "stream me" } }],
        }),
      })
    );

    const llm = new OpenAICompatibleLLM({
      baseURL: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
    });
    const stream = await llm.chatAsCfSse([{ role: "user", content: "x" }]);
    const raw = await new Response(stream).text();
    expect(raw).toContain('"response":"stream me"');
    expect(raw).toContain("[DONE]");
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      })
    );
    const emb = new OpenAICompatibleEmbedding({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk",
      model: "text-embedding-3-small",
    });
    await expect(emb.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
  });
});
