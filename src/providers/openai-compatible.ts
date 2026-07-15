/**
 * OpenAI-compatible HTTP clients for chat + embeddings.
 * Works with DeepSeek, MiniMax, MiMo, OpenAI, and most gateways.
 */

import type { ChatMessage, ChatOptions, LLMProvider } from "./llm";
import type { EmbedOptions, EmbeddingProvider } from "./embedding";
import { normalizeApiKey } from "../settings/model-settings";
import { logModelCall } from "../telemetry/queue";

export interface OpenAICompatibleConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Optional default request body extras (e.g. disable thinking). */
  defaultExtraBody?: Record<string, unknown>;
}

export interface OpenAICompatibleEmbeddingConfig extends OpenAICompatibleConfig {
  /** Expected output dimensions; validated on response. */
  dimensions?: number;
  /** Only send body.dimensions when the provider supports it (e.g. OpenAI, not SiliconFlow BGE). */
  sendDimensionsParameter?: boolean;
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

function isMiniMaxChatProvider(baseURL: string, model: string): boolean {
  const provider = `${baseURL} ${model}`.toLowerCase();
  return provider.includes("minimax");
}

function supportsJsonObjectResponseFormat(baseURL: string, model: string): boolean {
  // MiniMax chat models reject OpenAI's json_object format. Their structured
  // output support uses a different json_schema contract on selected models.
  return !isMiniMaxChatProvider(baseURL, model);
}

function isUnsupportedJsonFormatError(status: number, body: string): boolean {
  return status === 400 && /response[_ -]?format|json[_ -]?object/i.test(body);
}

function isTransientMiniMaxError(status: number, body: string): boolean {
  if (status >= 500 && status <= 504) return true;
  if (status === 529) return true;
  return status === 429 && /1000|1001|1002|1024|1033|server[_ -]?error|unknown error/i.test(body);
}

function waitBeforeTransientRetry(attempt: number): Promise<void> {
  const delayMs = 250 * 2 ** Math.max(0, attempt - 1);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function sendMiniMaxWithRetry(
  send: (requestBody: Record<string, unknown>) => Promise<Response>,
  requestBody: Record<string, unknown>,
  attempt = 1
): Promise<{ response: Response; errorBody: string | null }> {
  const response = await send(requestBody);
  if (response.ok) return { response, errorBody: null };

  const errorBody = await response.text().catch(() => "");
  if (attempt >= 3 || !isTransientMiniMaxError(response.status, errorBody)) {
    return { response, errorBody };
  }

  await waitBeforeTransientRetry(attempt);
  return sendMiniMaxWithRetry(send, requestBody, attempt + 1);
}

/** Enrich provider 401/2049 messages with region/key-type hints (esp. MiniMax). */
function enrichLlmHttpError(status: number, errBody: string, baseURL: string): string {
  const body = errBody.slice(0, 300);
  let msg = `LLM error ${status}: ${body}`;
  const lower = `${baseURL} ${body}`.toLowerCase();
  const isMiniMax =
    lower.includes("minimax") ||
    lower.includes("authorized_error") ||
    body.includes("2049") ||
    body.includes("无效的 API");
  if (status === 401 || body.includes("2049")) {
    if (isMiniMax || baseURL.includes("minimax")) {
      const isIo = baseURL.includes("minimax.io");
      const isCn = baseURL.includes("minimaxi.com");
      const regionHint = isIo
        ? "当前 Base URL 是国际站 api.minimax.io；若密钥来自国内 platform.minimaxi.com，请改用 https://api.minimaxi.com/v1"
        : isCn
          ? "当前 Base URL 是国内站 api.minimaxi.com；若密钥来自国际 platform.minimax.io，请改用 https://api.minimax.io/v1"
          : "请确认密钥与 Base URL 区域一致（国内 minimaxi.com / 国际 minimax.io）";
      msg += ` | 提示: MiniMax 401/2049=密钥无效或区域不匹配。${regionHint}。密钥需在开放平台「接口密钥」创建，不要混用 Coding Plan 订阅 Key 与按量 API Key。`;
    }
  }
  return msg;
}

function textToCfSseStream(text: string): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`)
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

interface OpenAIChatPayload {
  choices?: Array<{
    delta?: { content?: string | null };
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string | number;
  } | string;
}

function providerStreamError(payload: OpenAIChatPayload): Error | null {
  if (!payload.error) return null;
  const message = typeof payload.error === "string"
    ? payload.error
    : payload.error.message || `Provider stream error${payload.error.code ? ` (${payload.error.code})` : ""}`;
  return new Error(message);
}

function extractChatContent(payload: OpenAIChatPayload): string | null {
  const content =
    payload.choices?.[0]?.delta?.content ??
    payload.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

function openAiSseToCfSseStream(
  source: ReadableStream<Uint8Array>,
  record: (status: "success" | "error", output: string, usage?: OpenAIChatPayload["usage"], error?: unknown) => void
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";
  let output = "";
  let usage: OpenAIChatPayload["usage"];
  let providerDone = false;
  let providerFinished = false;

  const emitDone = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (providerDone) return;
    providerDone = true;
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };

  const processLine = (
    rawLine: string,
    controller: TransformStreamDefaultController<Uint8Array>
  ) => {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trimStart();
    if (!data) return;
    if (providerDone) throw new Error("Provider stream produced an event after DONE");
    if (data === "[DONE]") {
      emitDone(controller);
      return;
    }

    const payload = JSON.parse(data) as OpenAIChatPayload;
    const streamError = providerStreamError(payload);
    if (streamError) throw streamError;
    if (payload.usage) usage = payload.usage;
    if (payload.choices?.some((choice) => choice.finish_reason != null)) {
      providerFinished = true;
    }
    const content = extractChatContent(payload);
    if (!content) return;
    output += content;
    controller.enqueue(
      encoder.encode(`data: ${JSON.stringify({ response: content })}\n\n`)
    );
  };

  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        carry += decoder.decode(chunk, { stream: true });
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) processLine(line, controller);
      } catch (error) {
        record("error", output, usage, error);
        throw error;
      }
    },
    flush(controller) {
      try {
        carry += decoder.decode();
        if (carry) processLine(carry, controller);
        if (!providerDone && providerFinished) emitDone(controller);
        if (!providerDone) throw new Error("Provider stream ended before DONE");
        record("success", output, usage);
      } catch (error) {
        record("error", output, usage, error);
        throw error;
      }
    },
  });

  return source.pipeThrough(transformer);
}

/** Disable thinking for models that enable it by default (DeepSeek V4, MiniMax M3). */
export function thinkingDisabledBody(): Record<string, unknown> {
  return { thinking: { type: "disabled" } };
}

export class OpenAICompatibleLLM implements LLMProvider {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private defaultExtraBody?: Record<string, unknown>;

  constructor(config: OpenAICompatibleConfig) {
    this.baseURL = normalizeBaseURL(config.baseURL);
    this.apiKey = normalizeApiKey(config.apiKey);
    this.model = config.model;
    this.defaultExtraBody = config.defaultExtraBody;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const started = Date.now();
    const inputPreview = messages.map((m) => m.content).join("\n").slice(0, 2000);
    const miniMax = isMiniMaxChatProvider(this.baseURL, this.model);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? (miniMax ? 1 : 0.2),
      max_tokens: options.max_tokens,
      stream: false,
      ...(this.defaultExtraBody ?? {}),
      ...(options.extraBody ?? {}),
    };
    if (options.jsonMode && supportsJsonObjectResponseFormat(this.baseURL, this.model)) {
      body.response_format = { type: "json_object" };
    }

    try {
      const send = (requestBody: Record<string, unknown>) =>
        fetch(`${this.baseURL}/chat/completions`, {
          method: "POST",
          signal: options.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(requestBody),
        });
      const initial = miniMax
        ? await sendMiniMaxWithRetry(send, body)
        : { response: await send(body), errorBody: null };
      let response = initial.response;
      let consumedErrorBody = initial.errorBody;
      if (!response.ok && body.response_format) {
        consumedErrorBody = await response.text().catch(() => "");
        if (isUnsupportedJsonFormatError(response.status, consumedErrorBody)) {
          const { response_format: ignoredResponseFormat, ...fallbackBody } = body;
          void ignoredResponseFormat;
          response = await send(fallbackBody);
          consumedErrorBody = null;
        }
      }

      if (!response.ok) {
        const errBody = consumedErrorBody ?? await response.text().catch(() => "");
        throw new Error(enrichLlmHttpError(response.status, errBody, this.baseURL));
      }

      const json = (await response.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("LLM response missing choices[0].message.content");
      }
      logModelCall({
        call_type: "chat",
        provider: this.baseURL,
        model: this.model,
        duration_ms: Date.now() - started,
        status: "success",
        input_tokens: json.usage?.prompt_tokens ?? null,
        output_tokens: json.usage?.completion_tokens ?? null,
        total_tokens: json.usage?.total_tokens ?? null,
        input: inputPreview,
        output: content,
      });
      return content;
    } catch (e) {
      logModelCall({
        call_type: "chat",
        provider: this.baseURL,
        model: this.model,
        duration_ms: Date.now() - started,
        status: "error",
        input: inputPreview,
        error_message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  async chatAsCfSse(messages: ChatMessage[], options: ChatOptions = {}): Promise<ReadableStream> {
    const started = Date.now();
    const inputPreview = messages.map((message) => message.content).join("\n").slice(0, 2000);
    const miniMax = isMiniMaxChatProvider(this.baseURL, this.model);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? (miniMax ? 1 : 0.2),
      max_tokens: options.max_tokens,
      stream: true,
      ...(this.defaultExtraBody ?? {}),
      ...(options.extraBody ?? {}),
    };
    if (options.jsonMode && supportsJsonObjectResponseFormat(this.baseURL, this.model)) {
      body.response_format = { type: "json_object" };
    }

    let recorded = false;
    const record = (
      status: "success" | "error",
      output: string,
      usage?: OpenAIChatPayload["usage"],
      error?: unknown
    ) => {
      if (recorded) return;
      recorded = true;
      logModelCall({
        call_type: "chat",
        provider: this.baseURL,
        model: this.model,
        duration_ms: Date.now() - started,
        status,
        input_tokens: usage?.prompt_tokens ?? null,
        output_tokens: usage?.completion_tokens ?? null,
        total_tokens: usage?.total_tokens ?? null,
        input: inputPreview,
        output,
        error_message:
          error instanceof Error ? error.message : error ? String(error) : null,
      });
    };

    try {
      const send = (requestBody: Record<string, unknown>) =>
        fetch(`${this.baseURL}/chat/completions`, {
          method: "POST",
          signal: options.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream, application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(requestBody),
        });
      const initial = miniMax
        ? await sendMiniMaxWithRetry(send, body)
        : { response: await send(body), errorBody: null };
      let response = initial.response;
      let consumedErrorBody = initial.errorBody;

      if (!response.ok && body.response_format) {
        consumedErrorBody ??= await response.text().catch(() => "");
        if (isUnsupportedJsonFormatError(response.status, consumedErrorBody)) {
          const { response_format: _responseFormat, ...fallbackBody } = body;
          response = await send(fallbackBody);
          consumedErrorBody = null;
        }
      }

      if (!response.ok) {
        const errBody = consumedErrorBody ?? await response.text().catch(() => "");
        throw new Error(enrichLlmHttpError(response.status, errBody, this.baseURL));
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const payload = (await response.json()) as OpenAIChatPayload;
        const content = extractChatContent(payload);
        if (content == null) {
          throw new Error("LLM response missing choices[0].message.content");
        }
        record("success", content, payload.usage);
        return textToCfSseStream(content);
      }

      if (!response.body) throw new Error("LLM streaming response body is empty");
      return openAiSseToCfSseStream(response.body, record);
    } catch (error) {
      record("error", "", undefined, error);
      throw error;
    }
  }
}

/** MiniMax embedding (embo-01) uses native body/response, not OpenAI shape. */
function isMiniMaxEmbeddingHost(baseURL: string): boolean {
  const u = baseURL.toLowerCase();
  return (
    u.includes("minimax.io") ||
    u.includes("minimaxi.com") ||
    u.includes("minimax.chat")
  );
}

function assertMiniMaxEmbeddingOk(json: Record<string, unknown>): void {
  const baseResp = json.base_resp as
    | { status_code?: number; status_msg?: string }
    | undefined;
  if (baseResp && baseResp.status_code != null && baseResp.status_code !== 0) {
    throw new Error(
      `MiniMax embedding error ${baseResp.status_code}: ${baseResp.status_msg || "unknown"}`
    );
  }
}

function isNumberVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((x) => typeof x === "number");
}

/**
 * Extract embedding vectors from OpenAI-compatible or MiniMax-native responses.
 * OpenAI: { data: [{ embedding: number[], index?: number }] }
 * MiniMax: { vectors: number[][], base_resp: { status_code } }
 */
export function extractEmbeddingVectors(
  json: Record<string, unknown>
): number[][] | null {
  assertMiniMaxEmbeddingOk(json);

  // OpenAI / SiliconFlow / Zhipu
  const data = json.data;
  if (Array.isArray(data) && data.length > 0) {
    const rows = data
      .filter((item): item is { embedding?: unknown; index?: number } =>
        Boolean(item && typeof item === "object")
      )
      .map((item, fallbackIndex) => ({
        index: typeof item.index === "number" ? item.index : fallbackIndex,
        embedding: item.embedding,
      }))
      .filter((item): item is { index: number; embedding: number[] } =>
        isNumberVector(item.embedding)
      )
      .sort((a, b) => a.index - b.index);
    if (rows.length === data.length) {
      return rows.map((row) => row.embedding);
    }
  }

  // MiniMax native: vectors: number[][]
  const vectors = json.vectors;
  if (Array.isArray(vectors) && vectors.length > 0) {
    const valid = vectors.filter(isNumberVector);
    if (valid.length === vectors.length) return valid;
  }

  // Rare: top-level embedding
  if (isNumberVector(json.embedding)) {
    return [json.embedding];
  }

  return null;
}

export function extractEmbeddingVector(
  json: Record<string, unknown>
): number[] | null {
  return extractEmbeddingVectors(json)?.[0] ?? null;
}

export class OpenAICompatibleEmbedding implements EmbeddingProvider {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private dimensions?: number;
  private sendDimensionsParameter: boolean;
  private miniMax: boolean;

  constructor(config: OpenAICompatibleEmbeddingConfig) {
    this.baseURL = normalizeBaseURL(config.baseURL);
    this.apiKey = normalizeApiKey(config.apiKey);
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.sendDimensionsParameter = config.sendDimensionsParameter !== false;
    this.miniMax = isMiniMaxEmbeddingHost(this.baseURL);
  }

  async embed(text: string, options: EmbedOptions = {}): Promise<number[]> {
    const [embedding] = await this.requestEmbeddings([text], options, false);
    return embedding;
  }

  async embedMany(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    return this.requestEmbeddings(texts, options, true);
  }

  private async requestEmbeddings(
    texts: string[],
    options: EmbedOptions,
    batchInput: boolean
  ): Promise<number[][]> {
    if (!texts.length) return [];
    const started = Date.now();
    // MiniMax embo-01: texts + type (db|query), not OpenAI input
    const body: Record<string, unknown> = this.miniMax
      ? {
          model: this.model || "embo-01",
          texts,
          type: options.purpose === "query" ? "query" : "db",
        }
      : {
          model: this.model,
          input: batchInput ? texts : texts[0],
        };
    // Only OpenAI / some Qwen models support dimensions — SiliconFlow BGE rejects it.
    // MiniMax native API does not take dimensions.
    if (
      !this.miniMax &&
      this.sendDimensionsParameter &&
      this.dimensions != null &&
      this.dimensions > 0
    ) {
      body.dimensions = this.dimensions;
    }

    try {
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`Embedding error ${response.status}: ${errBody.slice(0, 280)}`);
      }

      const json = (await response.json()) as Record<string, unknown> & {
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };
      const embeddings = extractEmbeddingVectors(json);
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        const keys = Object.keys(json).slice(0, 12).join(",");
        throw new Error(
          `Embedding response missing vector batch (expected data[].embedding or vectors[]; keys=${keys}). ` +
            (this.miniMax
              ? "MiniMax 需用原生格式 texts/type；若仍失败请改用硅基流动 BGE。"
              : "检查模型是否支持 /embeddings。")
        );
      }
      const mismatched = this.dimensions != null
        ? embeddings.find((embedding) => embedding.length !== this.dimensions)
        : undefined;
      if (this.dimensions != null && mismatched) {
        throw new Error(
          `Embedding dimension mismatch: expected ${this.dimensions}, got ${mismatched.length}`
        );
      }
      logModelCall({
        call_type: "embedding",
        provider: this.baseURL,
        model: this.model,
        duration_ms: Date.now() - started,
        status: "success",
        input_tokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? null,
        total_tokens: json.usage?.total_tokens ?? null,
        input: texts.join("\n---\n").slice(0, 2000),
      });
      return embeddings;
    } catch (e) {
      logModelCall({
        call_type: "embedding",
        provider: this.baseURL,
        model: this.model,
        duration_ms: Date.now() - started,
        status: "error",
        input: texts.join("\n---\n").slice(0, 2000),
        error_message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}
