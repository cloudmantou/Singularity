/**
 * Cloudflare Workers AI adapters — default when no external LLM/embedding env is set.
 * Keeps the existing CF deployment runnable without configuration changes.
 */

import type { ChatMessage, ChatOptions, LLMProvider } from "./llm";
import type { EmbeddingProvider } from "./embedding";

export const DEFAULT_WORKERS_LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const DEFAULT_WORKERS_EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

async function readCfSseText(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      decoder.decode(value).split("\n").forEach((line) => {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const d = JSON.parse(line.slice(6));
            if (d.response) text += d.response;
          } catch {
            /* ignore partial chunks */
          }
        }
      });
    }
  } finally {
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
    const payload: Record<string, unknown> = {
      messages,
      max_tokens: options.max_tokens,
    };
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    // Only set stream when explicitly true — derivePattern tests assert stream is undefined.
    if (options.stream === true) payload.stream = true;

    const result = (await this.ai.run(this.model as any, payload as any)) as unknown;

    if (isReadableStream(result)) {
      return readCfSseText(result);
    }
    return extractWorkersText(result);
  }

  async chatAsCfSse(messages: ChatMessage[], options: ChatOptions = {}): Promise<ReadableStream> {
    const stream = (await this.ai.run(this.model as any, {
      messages,
      max_tokens: options.max_tokens,
      temperature: options.temperature,
      stream: true,
    } as any)) as ReadableStream;
    return stream;
  }
}

export class WorkersAIEmbedding implements EmbeddingProvider {
  constructor(
    private ai: Ai,
    private model: string = DEFAULT_WORKERS_EMBEDDING_MODEL
  ) {}

  async embed(text: string): Promise<number[]> {
    const result = (await this.ai.run(this.model as any, { text: [text] })) as {
      data?: number[][];
    };
    const vector = result?.data?.[0];
    if (!Array.isArray(vector)) {
      throw new Error("Workers AI embedding response missing data[0]");
    }
    return vector;
  }
}
