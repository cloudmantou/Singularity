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

export class OpenAICompatibleLLM implements LLMProvider {
  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(config: OpenAICompatibleConfig) {
    this.baseURL = normalizeBaseURL(config.baseURL);
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.max_tokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LLM error ${response.status}: ${body.slice(0, 200)}`);
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
    // Buffer then re-emit as CF-compatible SSE so the existing dashboard parser works.
    const text = await this.chat(messages, options);
    return textToCfSseStream(text);
  }
}

export class OpenAICompatibleEmbedding implements EmbeddingProvider {
  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(config: OpenAICompatibleConfig) {
    this.baseURL = normalizeBaseURL(config.baseURL);
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Embedding error ${response.status}: ${body.slice(0, 200)}`);
    }

    const json = (await response.json()) as {
      data?: { embedding?: number[] }[];
    };
    const embedding = json.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("Embedding response missing data[0].embedding");
    }
    return embedding;
  }
}
