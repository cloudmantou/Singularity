/**
 * Smoke-test external OpenAI-compatible LLM (and optional embedding).
 *
 * Usage:
 *   LLM_BASE_URL=https://api.deepseek.com/v1 \
 *   LLM_API_KEY=sk-... \
 *   LLM_MODEL=deepseek-chat \
 *   npx tsx scripts/test-ai.ts
 *
 * Optional embedding:
 *   EMBEDDING_BASE_URL=... EMBEDDING_API_KEY=... EMBEDDING_MODEL=...
 */

import { createEmbedding, createLLM } from "../src/providers";

async function main() {
  const env = {
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
    EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
    EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
  };

  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) {
    console.error("Set LLM_BASE_URL and LLM_API_KEY (and optionally LLM_MODEL)");
    process.exit(1);
  }

  const llm = createLLM(env);
  console.log("LLM:", env.LLM_MODEL || "deepseek-chat", "@", env.LLM_BASE_URL);
  const reply = await llm.chat([{ role: "user", content: "Reply with exactly: ok" }], {
    max_tokens: 16,
    temperature: 0,
  });
  console.log("chat:", JSON.stringify(reply));

  if (env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY) {
    const embedding = createEmbedding(env);
    const vector = await embedding.embed("second brain test");
    console.log("embed: dim=", vector.length, "sample=", vector.slice(0, 3));
  } else {
    console.log("embed: skipped (set EMBEDDING_BASE_URL + EMBEDDING_API_KEY to test)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
