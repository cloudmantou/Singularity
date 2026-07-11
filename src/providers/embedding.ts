/**
 * Embedding provider interface — platform-agnostic text → vector.
 */

export type EmbedPurpose = "document" | "query";

export interface EmbedOptions {
  /**
   * Some providers (MiniMax embo-01) use asymmetric vectors:
   * - document: store / index (db)
   * - query: search / recall (query)
   */
  purpose?: EmbedPurpose;
}

export interface EmbeddingProvider {
  /** Embed a single string; returns a dense float vector. */
  embed(text: string, options?: EmbedOptions): Promise<number[]>;
  /** Embed multiple strings in provider-native batches when supported. */
  embedMany?(texts: string[], options?: EmbedOptions): Promise<number[][]>;
}
