/**
 * LLM provider interface — platform-agnostic chat completions.
 * Used by both Cloudflare Workers AI and OpenAI-compatible APIs
 * (DeepSeek, MiniMax, MiMo, OpenAI, etc.).
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  /** When true, Workers AI uses SSE; OpenAI-compatible may still buffer. */
  stream?: boolean;
}

export interface LLMProvider {
  /**
   * Complete a chat and return the full assistant text.
   * Callers parse JSON / free text themselves.
   */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;

  /**
   * Stream a chat as Cloudflare Workers AI–compatible SSE
   * (`data: {"response":"..."}`), for the web UI `/chat` endpoint.
   */
  chatAsCfSse(messages: ChatMessage[], options?: ChatOptions): Promise<ReadableStream>;
}
