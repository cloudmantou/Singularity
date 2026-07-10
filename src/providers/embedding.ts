/**
 * Embedding provider interface — platform-agnostic text → vector.
 */

export interface EmbeddingProvider {
  /** Embed a single string; returns a dense float vector. */
  embed(text: string): Promise<number[]>;
}
