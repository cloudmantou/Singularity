export function isVectorSourceMetadataIndexError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return message.includes("metadata") && message.includes("index") &&
    (message.includes("source") || message.includes("filter"));
}

interface VectorSourceProbeCacheEntry {
  expiresAt: number;
  result: Promise<void>;
}

const vectorSourceProbeCache = new WeakMap<object, Map<string, VectorSourceProbeCacheEntry>>();

export async function cachedVectorSourceMetadataProbe(
  binding: object,
  cacheKey: string,
  probe: () => Promise<void>,
  options: { now?: number; ttlMs?: number } = {}
): Promise<void> {
  const now = options.now ?? Date.now();
  const ttlMs = Math.max(1, options.ttlMs ?? 60_000);
  const bindingCache = vectorSourceProbeCache.get(binding) ?? new Map();
  const cached = bindingCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const result = Promise.resolve().then(probe);
  bindingCache.set(cacheKey, { expiresAt: now + ttlMs, result });
  vectorSourceProbeCache.set(binding, bindingCache);
  return result;
}
