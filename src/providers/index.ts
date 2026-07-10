/**
 * Provider factories — pick OpenAI-compatible external APIs when configured,
 * otherwise fall back to Cloudflare Workers AI bindings.
 * Control-plane settings (DB) override env via resolveProviderEnv.
 */

import type { LLMProvider } from "./llm";
import type { EmbeddingProvider } from "./embedding";
import { LocalHashEmbedding } from "./local-embedding";
import {
  OpenAICompatibleEmbedding,
  OpenAICompatibleLLM,
  thinkingDisabledBody,
} from "./openai-compatible";
import { resolveProviderEnv } from "../settings/store";
import {
  DEFAULT_WORKERS_EMBEDDING_MODEL,
  DEFAULT_WORKERS_LLM_MODEL,
  WorkersAIEmbedding,
  WorkersAILLM,
} from "./workers-ai";

export type { ChatMessage, ChatOptions, LLMProvider } from "./llm";
export type { EmbeddingProvider } from "./embedding";
export { OpenAICompatibleLLM, OpenAICompatibleEmbedding } from "./openai-compatible";
export { LocalHashEmbedding } from "./local-embedding";
export {
  WorkersAILLM,
  WorkersAIEmbedding,
  DEFAULT_WORKERS_LLM_MODEL,
  DEFAULT_WORKERS_EMBEDDING_MODEL,
} from "./workers-ai";

/** Minimal env surface needed to construct providers (avoids circular Env import). */
export interface ProviderEnv {
  AI?: Ai;
  DB?: D1Database;
  SELFHOST?: string;
  ALLOW_DEV_EMBEDDING?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  /** Optional JSON string of default extraBody for OpenAI-compatible chat. */
  LLM_EXTRA_BODY?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  /**
   * Embedding mode:
   * - unset / empty: require real provider or Workers AI
   * - "local" | "local-hash-dev": only when ALLOW_DEV_EMBEDDING=true
   */
  EMBEDDING_PROVIDER?: string;
  EMBEDDING_DIM?: string;
  /** "0"/"false" = do not send dimensions in embedding request body. */
  EMBEDDING_SEND_DIMENSIONS?: string;
}

function parseExtraBody(raw?: string): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Disable thinking only where the API honors it (DeepSeek V4, MiniMax-M3). */
function defaultThinkingBody(model: string, baseURL: string): Record<string, unknown> | undefined {
  const m = model.toLowerCase();
  const u = baseURL.toLowerCase();
  if (m.includes("deepseek-v4") || u.includes("deepseek.com")) {
    return thinkingDisabledBody();
  }
  // MiniMax M2.x still thinks even with disabled — only send for M3.
  if (m === "minimax-m3" || (u.includes("minimax") && m.includes("m3") && !m.includes("m2"))) {
    return thinkingDisabledBody();
  }
  return undefined;
}

function buildLLM(env: ProviderEnv): LLMProvider {
  if (env.LLM_BASE_URL && env.LLM_API_KEY) {
    const model = env.LLM_MODEL || "deepseek-v4-flash";
    const extra =
      parseExtraBody(env.LLM_EXTRA_BODY) ??
      defaultThinkingBody(model, env.LLM_BASE_URL);
    return new OpenAICompatibleLLM({
      baseURL: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model,
      defaultExtraBody: extra,
    });
  }
  if (env.AI) {
    return new WorkersAILLM(env.AI, env.LLM_MODEL || DEFAULT_WORKERS_LLM_MODEL);
  }
  throw new Error(
    "No LLM configured: open Settings → Models & API, or set LLM_BASE_URL + LLM_API_KEY"
  );
}

function isDevLocalEmbedding(env: ProviderEnv): boolean {
  const p = (env.EMBEDDING_PROVIDER || "").toLowerCase();
  const allowed =
    env.ALLOW_DEV_EMBEDDING === "1" ||
    env.ALLOW_DEV_EMBEDDING === "true";
  return (
    allowed &&
    (p === "local" || p === "local-hash" || p === "local-hash-dev")
  );
}

function buildEmbedding(env: ProviderEnv): EmbeddingProvider {
  if (env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY) {
    const dimensions = parseInt(env.EMBEDDING_DIM || "384", 10) || 384;
    const sendDimensions =
      env.EMBEDDING_SEND_DIMENSIONS !== "0" &&
      env.EMBEDDING_SEND_DIMENSIONS !== "false";
    return new OpenAICompatibleEmbedding({
      baseURL: env.EMBEDDING_BASE_URL,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL || "text-embedding-3-small",
      dimensions,
      sendDimensionsParameter: sendDimensions,
    });
  }

  if (isDevLocalEmbedding(env)) {
    const dim = parseInt(env.EMBEDDING_DIM || "384", 10) || 384;
    return new LocalHashEmbedding(dim);
  }

  if (env.AI) {
    return new WorkersAIEmbedding(
      env.AI,
      env.EMBEDDING_MODEL || DEFAULT_WORKERS_EMBEDDING_MODEL
    );
  }

  throw new Error(
    "Production embedding is not configured. Set EMBEDDING_BASE_URL + EMBEDDING_API_KEY " +
      "(and EMBEDDING_DIM), or for smoke tests only: EMBEDDING_PROVIDER=local-hash-dev and ALLOW_DEV_EMBEDDING=true"
  );
}

/** Async: merges control-plane DB settings, then builds LLM client. */
export async function createLLM(env: ProviderEnv): Promise<LLMProvider> {
  const resolved = await resolveProviderEnv(env);
  return buildLLM(resolved);
}

/** Async: merges control-plane DB settings, then builds embedding client. */
export async function createEmbedding(env: ProviderEnv): Promise<EmbeddingProvider> {
  const resolved = await resolveProviderEnv(env);
  return buildEmbedding(resolved);
}

/** Sync builders when env is already resolved (tests / internal). */
export function createLLMFromResolved(env: ProviderEnv): LLMProvider {
  return buildLLM(env);
}

export function createEmbeddingFromResolved(env: ProviderEnv): EmbeddingProvider {
  return buildEmbedding(env);
}
