/**
 * Deterministic local embedding for self-host when no embedding API is configured.
 * Quality is far below real models — good enough for smoke tests and keyword-ish
 * recall; set EMBEDDING_BASE_URL for production semantic search.
 */

import type { EmbeddingProvider } from "./embedding";
import { logModelCall } from "../telemetry/queue";

export class LocalHashEmbedding implements EmbeddingProvider {
  constructor(private dimensions = 384) {}

  private vectorize(text: string): number[] {
    const dims = this.dimensions;
    const vec = new Array<number>(dims).fill(0);
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

    for (const token of tokens) {
      let h = 2166136261;
      for (let i = 0; i < token.length; i++) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % dims;
      vec[idx] += 1;
      // bigram boost for slightly better short-text separation
      if (token.length > 1) {
        let h2 = 2166136261;
        for (let i = 0; i < token.length - 1; i++) {
          h2 ^= token.charCodeAt(i) ^ (token.charCodeAt(i + 1) << 7);
          h2 = Math.imul(h2, 16777619);
        }
        vec[Math.abs(h2) % dims] += 0.5;
      }
    }

    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return vec.map((x) => x / norm);
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedMany([text]);
    return vector;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const started = Date.now();
    try {
      const vectors = texts.map((text) => this.vectorize(text));
      logModelCall({
        call_type: "embedding",
        provider: "local",
        model: "local-hash-dev",
        duration_ms: Date.now() - started,
        status: "success",
        input: texts.join("\n---\n").slice(0, 2000),
      });
      return vectors;
    } catch (error) {
      logModelCall({
        call_type: "embedding",
        provider: "local",
        model: "local-hash-dev",
        duration_ms: Date.now() - started,
        status: "error",
        input: texts.join("\n---\n").slice(0, 2000),
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
