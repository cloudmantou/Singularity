export interface VerifiedAnswerCacheClaimSnapshot {
  id: string | null;
  statement: string;
  status: string;
  versionId: string | null;
  conflictIds: readonly string[];
}

export interface VerifiedAnswerCacheRelatedContextSnapshot {
  id: string;
  content: string;
  versionId?: string | null;
  associationType?: string;
  hop?: number;
}

export interface VerifiedAnswerCacheKeyInput {
  query: string;
  activitySummary: boolean;
  answerabilityMode: string;
  modelSignature: string;
  cacheScope: string;
  retrievalPolicy: string;
  relatedContext: readonly VerifiedAnswerCacheRelatedContextSnapshot[];
  claims: readonly VerifiedAnswerCacheClaimSnapshot[];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildVerifiedAnswerCacheKey(
  input: VerifiedAnswerCacheKeyInput
): Promise<string> {
  const claims = input.claims.map((claim) => ({
    id: claim.id,
    statement: claim.statement.trim().replace(/\s+/g, " "),
    status: claim.status,
    versionId: claim.versionId,
    conflictIds: [...claim.conflictIds].sort(),
  }));
  const relatedContext = input.relatedContext.map((row) => ({
    id: row.id,
    content: row.content.trim().replace(/\s+/g, " "),
    versionId: row.versionId ?? null,
    associationType: row.associationType ?? null,
    hop: row.hop ?? null,
  }));
  return sha256(JSON.stringify({
    query: normalizeQuery(input.query),
    activitySummary: input.activitySummary,
    answerabilityMode: input.answerabilityMode,
    modelSignature: input.modelSignature,
    cacheScope: input.cacheScope,
    retrievalPolicy: input.retrievalPolicy,
    relatedContext,
    claims,
  }));
}

export class BoundedVerifiedAnswerCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: { maxEntries: number; ttlMs: number }) {
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries));
    this.ttlMs = Math.max(1, Math.trunc(options.ttlMs));
  }

  get(key: string, now = Date.now()): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      const next = new Map(this.entries);
      next.delete(key);
      this.entries = next;
      return null;
    }
    return cloneValue(entry.value);
  }

  set(key: string, value: T, now = Date.now()): void {
    const next = new Map(this.entries);
    next.delete(key);
    while (next.size >= this.maxEntries) {
      const oldest = next.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      next.delete(oldest);
    }
    next.set(key, { value: cloneValue(value), expiresAt: now + this.ttlMs });
    this.entries = next;
  }

  clear(): void {
    this.entries = new Map();
  }
}

let sharedCache: BoundedVerifiedAnswerCache<unknown> | null = null;
let sharedCacheConfig = "";

export function getVerifiedAnswerCache<T>(options: {
  maxEntries: number;
  ttlMs: number;
}): BoundedVerifiedAnswerCache<T> {
  const config = `${Math.max(1, Math.trunc(options.maxEntries))}:${Math.max(1, Math.trunc(options.ttlMs))}`;
  if (!sharedCache || sharedCacheConfig !== config) {
    sharedCache = new BoundedVerifiedAnswerCache<unknown>(options);
    sharedCacheConfig = config;
  }
  return sharedCache as BoundedVerifiedAnswerCache<T>;
}

export function resetVerifiedAnswerCache(): void {
  sharedCache?.clear();
  sharedCache = null;
  sharedCacheConfig = "";
}
