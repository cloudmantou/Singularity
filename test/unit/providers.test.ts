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

  it("does not send unsupported json_object response format to MiniMax chat models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "{}" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://api.minimaxi.com/v1",
      apiKey: "test-key",
      model: "MiniMax-M3",
    });

    await llm.chat([{ role: "user", content: "Return JSON" }], { jsonMode: true });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.response_format).toBeUndefined();
  });

  it("uses MiniMax's recommended temperature and retries one transient server error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({
          type: "error",
          error: { type: "server_error", message: "unknown error, 500 (1000)" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "{}" } }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://api.minimaxi.com/v1",
      apiKey: "test-key",
      model: "MiniMax-M3",
    });

    await expect(llm.chat(
      [{ role: "user", content: "Return JSON" }],
      { jsonMode: true }
    )).resolves.toBe("{}");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.temperature).toBe(1);
    expect(secondBody).toEqual(firstBody);
  });

  it("retries MiniMax peak-load 529 responses until a bounded attempt succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 529,
        text: async () => JSON.stringify({
          type: "error",
          error: { type: "server_error", message: "peak-hour surge (1000)" },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({
          type: "error",
          error: { type: "server_error", message: "unknown error, 500 (1000)" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "{}" } }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://api.minimaxi.com/v1",
      apiKey: "test-key",
      model: "MiniMax-M3",
    });

    await expect(llm.chat(
      [{ role: "user", content: "Return JSON" }],
      { jsonMode: true }
    )).resolves.toBe("{}");

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops MiniMax transient retries after the third failed HTTP attempt", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 529,
      text: async () => JSON.stringify({
        type: "error",
        error: { type: "server_error", message: "peak-hour surge (1000)" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://api.minimaxi.com/v1",
      apiKey: "test-key",
      model: "MiniMax-M3",
    });

    await expect(llm.chat(
      [{ role: "user", content: "Return JSON" }],
      { jsonMode: true }
    )).rejects.toThrow(/529/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries once without json_object when a compatible provider rejects the field", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "unsupported response_format",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "{}" } }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://gateway.example/v1",
      apiKey: "test-key",
      model: "custom-model",
    });

    await expect(llm.chat(
      [{ role: "user", content: "Return JSON" }],
      { jsonMode: true }
    )).resolves.toBe("{}");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.response_format).toEqual({ type: "json_object" });
    expect(secondBody.response_format).toBeUndefined();
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

  it("retries bounded MiniMax 529 failures before opening a chat stream", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        ));
        controller.close();
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("peak load", { status: 529 }))
      .mockResolvedValueOnce(new Response(upstream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://api.minimaxi.com/v1",
      apiKey: "test-key",
      model: "MiniMax-M3",
    });

    const stream = await llm.chatAsCfSse(
      [{ role: "user", content: "stream" }],
      { jsonMode: true }
    );
    await expect(new Response(stream).text()).resolves.toContain('"response":"ok"');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(firstBody.stream).toBe(true);
    expect(firstBody.temperature).toBe(1);
    expect(firstBody.response_format).toBeUndefined();
  });

  it("retries a rejected streaming json_object request without response_format", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        ));
        controller.close();
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unsupported response_format", { status: 400 }))
      .mockResolvedValueOnce(new Response(upstream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://gateway.example/v1",
      apiKey: "test-key",
      model: "custom-model",
    });

    const stream = await llm.chatAsCfSse(
      [{ role: "user", content: "Return JSON" }],
      { jsonMode: true }
    );
    await expect(new Response(stream).text()).resolves.toContain('"response":"ok"');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(firstBody.response_format).toEqual({ type: "json_object" });
    expect(secondBody.response_format).toBeUndefined();
  });

  it("rejects OpenAI-compatible errors delivered inside a successful stream", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"error":{"message":"quota exhausted"}}\n\n'
        ));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://gateway.example/v1",
      apiKey: "test-key",
      model: "custom-model",
    });

    const stream = await llm.chatAsCfSse([{ role: "user", content: "stream" }]);

    await expect(new Response(stream).text()).rejects.toThrow("quota exhausted");
  });

  it("rejects OpenAI-compatible streams that end before DONE", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
        ));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://gateway.example/v1",
      apiKey: "test-key",
      model: "custom-model",
    });

    const stream = await llm.chatAsCfSse([{ role: "user", content: "stream" }]);

    await expect(new Response(stream).text()).rejects.toThrow("before DONE");
  });

  it("rejects OpenAI-compatible events after DONE", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: [DONE]\n\ndata: {"choices":[{"delta":{"content":"late"}}]}\n\n'
        ));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const llm = new OpenAICompatibleLLM({
      baseURL: "https://gateway.example/v1",
      apiKey: "test-key",
      model: "custom-model",
    });

    const stream = await llm.chatAsCfSse([{ role: "user", content: "stream" }]);

    await expect(new Response(stream).text()).rejects.toThrow("after DONE");
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

  it("cancels an active Workers AI stream when the caller aborts", async () => {
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
      },
      cancel,
    });
    const llm = new WorkersAILLM({
      run: vi.fn().mockResolvedValue(upstream),
    } as unknown as Ai);
    const abortController = new AbortController();
    const stream = await llm.chatAsCfSse(
      [{ role: "user", content: "stream" }],
      { signal: abortController.signal }
    );
    const reader = stream.getReader();
    const pendingRead = reader.read();

    try {
      abortController.abort("replaced");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      await expect(pendingRead).resolves.toMatchObject({ done: true });
    } finally {
      if (!cancel.mock.calls.length) upstreamController?.close();
      reader.releaseLock();
    }
  });

  it("aborts buffered Workers AI verification reads", async () => {
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
      },
      cancel,
    });
    const llm = new WorkersAILLM({
      run: vi.fn().mockResolvedValue(upstream),
    } as unknown as Ai);
    const abortController = new AbortController();
    const chat = llm.chat(
      [{ role: "user", content: "verify" }],
      { signal: abortController.signal }
    );

    try {
      await Promise.resolve();
      abortController.abort("replaced");
      await expect(chat).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    } finally {
      if (!cancel.mock.calls.length) upstreamController?.close();
    }
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
