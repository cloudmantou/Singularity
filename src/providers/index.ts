/**
 * Provider factories — pick OpenAI-compatible external APIs when configured,
 * otherwise fall back to Cloudflare Workers AI bindings.
 */

import type { LLMProvider } from "./llm";
import type { EmbeddingProvider } from "./embedding";
import { OpenAICompatibleEmbedding, OpenAICompatibleLLM } from "./openai-compatible";
import {
  DEFAULT_WORKERS_EMBEDDING_MODEL,
  DEFAULT_WORKERS_LLM_MODEL,
  WorkersAIEmbedding,
  WorkersAILLM,
} from "./workers-ai";

export type { ChatMessage, ChatOptions, LLMProvider } from "./llm";
export type { EmbeddingProvider } from "./embedding";
export { OpenAICompatibleLLM, OpenAICompatibleEmbedding } from "./openai-compatible";
export {
  WorkersAILLM,
  WorkersAIEmbedding,
  DEFAULT_WORKERS_LLM_MODEL,
  DEFAULT_WORKERS_EMBEDDING_MODEL,
} from "./workers-ai";

/** Minimal env surface needed to construct providers (avoids circular Env import). */
export interface ProviderEnv {
  AI?: Ai;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_MODEL?: string;
}

export function createLLM(env: ProviderEnv): LLMProvider {
  if (env.LLM_BASE_URL && env.LLM_API_KEY) {
    return new OpenAICompatibleLLM({
      baseURL: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL || "deepseek-chat",
    });
  }
  if (env.AI) {
    return new WorkersAILLM(env.AI, env.LLM_MODEL || DEFAULT_WORKERS_LLM_MODEL);
  }
  throw new Error(
    "No LLM configured: set LLM_BASE_URL + LLM_API_KEY, or bind Workers AI"
  );
}

export function createEmbedding(env: ProviderEnv): EmbeddingProvider {
  if (env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY) {
    return new OpenAICompatibleEmbedding({
      baseURL: env.EMBEDDING_BASE_URL,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL || "text-embedding-3-small",
    });
  }
  if (env.AI) {
    return new WorkersAIEmbedding(
      env.AI,
      env.EMBEDDING_MODEL || DEFAULT_WORKERS_EMBEDDING_MODEL
    );
  }
  throw new Error(
    "No embedding configured: set EMBEDDING_BASE_URL + EMBEDDING_API_KEY, or bind Workers AI"
  );
}
