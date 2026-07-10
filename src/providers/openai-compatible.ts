/**
 * OpenAI-compatible HTTP clients for chat + embeddings.
 * Works with DeepSeek, MiniMax, MiMo, OpenAI, and most gateways.
 */

import type { ChatMessage, ChatOptions, LLMProvider } from "./llm";
import type { EmbeddingProvider } from "./embedding";

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
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.defaultExtraBody = config.defaultExtraBody;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.max_tokens,
      stream: false,
      ...(this.defaultExtraBody ?? {}),
      ...(options.extraBody ?? {}),
    };
    if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`LLM error ${response.status}: ${errBody.slice(0, 200)}`);
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("LLM response missing choices[0].message.content");
    }
    return content;
  }

  async chatAsCfSse(messages: ChatMessage[], options: ChatOptions = {}): Promise<ReadableStream> {
    const text = await this.chat(messages, options);
    return textToCfSseStream(text);
  }
}

export class OpenAICompatibleEmbedding implements EmbeddingProvider {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private dimensions?: number;
  private sendDimensionsParameter: boolean;

  constructor(config: OpenAICompatibleEmbeddingConfig) {
    this.baseURL = normalizeBaseURL(config.baseURL);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.sendDimensionsParameter = config.sendDimensionsParameter !== false;
  }

  async embed(text: string): Promise<number[]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
    };
    // Only OpenAI / some Qwen models support dimensions — SiliconFlow BGE rejects it.
    if (
      this.sendDimensionsParameter &&
      this.dimensions != null &&
      this.dimensions > 0
    ) {
      body.dimensions = this.dimensions;
    }

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
      throw new Error(`Embedding error ${response.status}: ${errBody.slice(0, 200)}`);
    }

    const json = (await response.json()) as {
      data?: { embedding?: number[] }[];
    };
    const embedding = json.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("Embedding response missing data[0].embedding");
    }
    if (this.dimensions != null && embedding.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`
      );
    }
    return embedding;
  }
}
