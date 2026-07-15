/**
 * Cloudflare Workers AI adapters — default when no external LLM/embedding env is set.
 * Keeps the existing CF deployment runnable without configuration changes.
 */

import type { ChatMessage, ChatOptions, LLMProvider } from "./llm";
import type { EmbeddingProvider } from "./embedding";
import { logModelCall } from "../telemetry/queue";

export const DEFAULT_WORKERS_LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const DEFAULT_WORKERS_EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbortedResolve?: (value: T) => void | Promise<void>
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted || signal.aborted) {
          void onAbortedResolve?.(value);
          reject(abortError());
          return;
        }
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function readCfSseText(stream: ReadableStream, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    await stream.cancel(signal.reason).catch(() => undefined);
    throw abortError();
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let carry = "";
  const cancelReader = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const d = JSON.parse(line.slice(6));
            if (d.response) text += d.response;
          } catch {
            /* ignore incomplete JSON fragments */
          }
        }
      }
    }
    carry += decoder.decode();
    if (carry.startsWith("data: ") && !carry.includes("[DONE]")) {
      try {
        const d = JSON.parse(carry.slice(6));
        if (d.response) text += d.response;
      } catch {
        /* ignore */
      }
    }
    if (signal?.aborted) throw abortError();
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  return text;
}

function isReadableStream(value: unknown): value is ReadableStream {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadableStream).getReader === "function"
  );
}

function extractWorkersText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as {
    response?: string;
    choices?: { message?: { content?: string | null } }[];
  };
  return (
    r.choices?.[0]?.message?.content ??
    r.response ??
    ""
  );
}

export class WorkersAILLM implements LLMProvider {
  constructor(
    private ai: Ai,
    private model: string = DEFAULT_WORKERS_LLM_MODEL
  ) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const started = Date.now();
    const input = messages.map((message) => message.content).join("\n");
    const payload: Record<string, unknown> = {
      messages,
      max_tokens: options.max_tokens,
    };
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    // Only set stream when explicitly true — derivePattern tests assert stream is undefined.
    if (options.stream === true) payload.stream = true;

    try {
      const result = await awaitWithAbort(
        this.ai.run(this.model as any, payload as any) as Promise<unknown>,
        options.signal,
        (value) => isReadableStream(value)
          ? value.cancel(options.signal?.reason)
          : undefined
      );
      const content = isReadableStream(result)
        ? await readCfSseText(result, options.signal)
        : extractWorkersText(result);
      logModelCall({
        call_type: "chat",
        provider: "workers-ai",
        model: this.model,
        duration_ms: Date.now() - started,
        status: "success",
        input,
        output: content,
      });
      return content;
    } catch (error) {
      logModelCall({
        call_type: "chat",
        provider: "workers-ai",
        model: this.model,
        duration_ms: Date.now() - started,
        status: "error",
        input,
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async chatAsCfSse(messages: ChatMessage[], options: ChatOptions = {}): Promise<ReadableStream> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const started = Date.now();
    const input = messages.map((message) => message.content).join("\n");
    try {
      const stream = await awaitWithAbort(
        this.ai.run(this.model as any, {
          messages,
          max_tokens: options.max_tokens,
          temperature: options.temperature,
          stream: true,
        } as any) as Promise<ReadableStream>,
        options.signal,
        (value) => isReadableStream(value)
          ? value.cancel(options.signal?.reason)
          : undefined
      );
      if (!isReadableStream(stream)) throw new Error("Workers AI chat stream missing");
      if (options.signal?.aborted) {
        await stream.cancel(options.signal.reason).catch(() => undefined);
        throw abortError();
      }
      const reader = stream.getReader();
      let settled = false;
      const cancelUpstream = (reason?: unknown) => reader.cancel(reason).catch(() => undefined);
      const onAbort = () => {
        void cancelUpstream(options.signal?.reason);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      const record = (status: "success" | "error", error?: unknown) => {
        if (settled) return;
        settled = true;
        logModelCall({
          call_type: "chat",
          provider: "workers-ai",
          model: this.model,
          duration_ms: Date.now() - started,
          status,
          input,
          error_message: error instanceof Error ? error.message : error ? String(error) : null,
        });
      };
      return new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              cleanup();
              if (options.signal?.aborted) record("error", abortError());
              else record("success");
              controller.close();
            } else {
              controller.enqueue(next.value);
            }
          } catch (error) {
            cleanup();
            record("error", error);
            controller.error(error);
          }
        },
        async cancel(reason) {
          cleanup();
          record("error", reason);
          await cancelUpstream(reason);
        },
      });
    } catch (error) {
      logModelCall({
        call_type: "chat",
        provider: "workers-ai",
        model: this.model,
        duration_ms: Date.now() - started,
        status: "error",
        input,
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export class WorkersAIEmbedding implements EmbeddingProvider {
  constructor(
    private ai: Ai,
    private model: string = DEFAULT_WORKERS_EMBEDDING_MODEL
  ) {}

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedMany([text]);
    return vector;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const started = Date.now();
    try {
      const result = (await this.ai.run(this.model as any, { text: texts })) as {
        data?: number[][];
      };
      const vectors = result?.data;
      if (
        !Array.isArray(vectors) ||
        vectors.length !== texts.length ||
        vectors.some((vector) => !Array.isArray(vector))
      ) {
        throw new Error("Workers AI embedding response missing data[0]");
      }
      logModelCall({
        call_type: "embedding",
        provider: "workers-ai",
        model: this.model,
        duration_ms: Date.now() - started,
        status: "success",
        input: texts.join("\n---\n").slice(0, 2000),
      });
      return vectors;
    } catch (error) {
      logModelCall({
        call_type: "embedding",
        provider: "workers-ai",
        model: this.model,
        duration_ms: Date.now() - started,
        status: "error",
        input: texts.join("\n---\n").slice(0, 2000),
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
