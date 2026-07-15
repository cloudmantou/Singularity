import { createHash } from "node:crypto";

export interface FixedWindowRateLimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export function createFixedWindowRateLimiter(options: FixedWindowRateLimiterOptions) {
  const limit = Math.max(1, Math.floor(options.limit));
  const windowMs = Math.max(1, Math.floor(options.windowMs));
  const maxKeys = Math.max(limit, Math.floor(options.maxKeys ?? 10_000));
  const buckets = new Map<string, RateLimitBucket>();

  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
    while (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  return {
    consume(key: string, now = Date.now()): RateLimitResult {
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        if (!bucket && buckets.size >= maxKeys) prune(now);
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return {
          allowed: true,
          remaining: limit - 1,
          retryAfterSeconds: 0,
        };
      }

      if (bucket.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        };
      }

      buckets.set(key, { ...bucket, count: bucket.count + 1 });
      return {
        allowed: true,
        remaining: limit - bucket.count - 1,
        retryAfterSeconds: 0,
      };
    },
  };
}

export type ExpensiveRouteClass = "model" | "maintenance" | "import" | "mcp";

const MODEL_ROUTES = new Set(["GET /recall", "POST /settings/models/test"]);
const MAINTENANCE_ROUTES = new Set([
  "POST /classify-pending",
  "POST /extract-pending",
  "POST /maintenance/claim-vectors/backfill",
  "POST /maintenance/claim-vectors/retry-failed",
  "POST /maintenance/mutations/reconcile",
  "POST /maintenance/vector-index/backfill",
  "POST /settings/models/reindex",
  "POST /vectorize-pending",
]);

export function classifyExpensiveRoute(
  method: string,
  pathname: string
): ExpensiveRouteClass | null {
  const key = `${method.toUpperCase()} ${pathname}`;
  if (pathname === "/mcp") return "mcp";
  if (key === "POST /import") return "import";
  if (MODEL_ROUTES.has(key)) return "model";
  if (MAINTENANCE_ROUTES.has(key)) return "maintenance";
  return null;
}

export function createRateLimitIdentity(
  ip: string,
  authorization?: string,
  trustedAuthorization?: string
): string {
  const auth = String(authorization ?? "").trim();
  const trusted = String(trustedAuthorization ?? "").trim();
  const fingerprint = auth && trusted && auth === trusted
    ? createHash("sha256").update(auth).digest("hex").slice(0, 24)
    : "anonymous";
  return `${ip || "unknown"}:${fingerprint}`;
}
