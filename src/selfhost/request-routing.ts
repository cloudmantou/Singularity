import path from "node:path";
import {
  isOAuthAuthorizationServerWellKnown,
  isOAuthProtectedResourceWellKnown,
} from "../oauth/metadata";

const GET_ROUTES = new Set([
  "/analytics/logs", "/analytics/memory-overview", "/analytics/overview",
  "/analytics/timeseries", "/analytics/vector-runtime", "/associations/connections",
  "/audit/events", "/config", "/config.json", "/connections", "/count", "/digest/preview",
  "/entities", "/export", "/extract-pending", "/graph/facts", "/health", "/health/details",
  "/integrations/obsidian/aggregates", "/integrations/obsidian/pull",
  "/integrations/obsidian/rules", "/integrations/obsidian/status", "/integrations/providers",
  "/list", "/maintenance/claim-vectors/status", "/maintenance/mutations/status", "/maintenance/vector-index/status", "/quality/conflict-cases",
  "/quality/ai-review", "/quality/entity-merge-candidates", "/quality/merge-candidates", "/recall", "/relations",
  "/settings/models", "/settings/oauth/clients", "/settings/telemetry", "/stats", "/tags",
]);

const POST_ROUTES = new Set([
  "/analytics/purge", "/append", "/associations/link", "/associations/unlink", "/capture",
  "/classify-pending", "/digest", "/extract-pending", "/forget", "/import",
  "/integrations/development-session/capture", "/integrations/obsidian/ack",
  "/integrations/obsidian/aggregates/generate", "/integrations/obsidian/push",
  "/integrations/obsidian/resolve-conflict", "/integrations/obsidian/rules",
  "/integrations/obsidian/tokens", "/link", "/maintenance/claim-vectors/backfill",
  "/maintenance/claim-vectors/retry-failed", "/maintenance/mutations/reconcile", "/maintenance/vector-index/backfill",
  "/quality/ai-review", "/quality/ai-review/apply", "/quality/ai-review/batch",
  "/quality/conflict-cases/resolve", "/quality/entity-merge-candidates/resolve",
  "/quality/merge-candidates/resolve", "/settings/models/reindex",
  "/settings/models/reindex/cancel", "/settings/models/test", "/status", "/unlink", "/update",
  "/vectorize-pending",
]);

const PUT_ROUTES = new Set(["/settings/models", "/settings/telemetry"]);

function isDynamicGetRoute(pathname: string): boolean {
  return pathname.startsWith("/analytics/traces/") ||
    /^\/entities\/[^/]+$/.test(pathname) ||
    /^\/graph\/entity\/[^/]+$/.test(pathname);
}

function isOAuthDiscoveryRoute(pathname: string): boolean {
  return isOAuthAuthorizationServerWellKnown(pathname) ||
    isOAuthProtectedResourceWellKnown(pathname);
}

function isOAuthClientDeleteRoute(pathname: string): boolean {
  const match = pathname.match(/^\/settings\/oauth\/clients\/([^/]+)$/);
  if (!match) return false;
  try {
    const clientId = decodeURIComponent(match[1]).trim();
    return Boolean(clientId) && !clientId.includes("/");
  } catch {
    return false;
  }
}

function isKnownPath(pathname: string): boolean {
  return GET_ROUTES.has(pathname) ||
    POST_ROUTES.has(pathname) ||
    PUT_ROUTES.has(pathname) ||
    isDynamicGetRoute(pathname) ||
    pathname === "/oauth/authorize" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/token" ||
    pathname === "/mcp" ||
    isOAuthDiscoveryRoute(pathname) ||
    isOAuthClientDeleteRoute(pathname);
}

export function isKnownWorkerRoute(method: string, urlPath: string): boolean {
  const pathname = urlPath.split("?")[0] || "/";
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "OPTIONS" && isKnownPath(pathname)) return true;
  if (
    normalizedMethod === "HEAD" &&
    (GET_ROUTES.has(pathname) || pathname === "/config.json" || isOAuthDiscoveryRoute(pathname))
  ) {
    return true;
  }
  if (normalizedMethod === "GET" && (GET_ROUTES.has(pathname) || isDynamicGetRoute(pathname))) return true;
  if (normalizedMethod === "POST" && POST_ROUTES.has(pathname)) return true;
  if (normalizedMethod === "PUT" && PUT_ROUTES.has(pathname)) return true;
  if (pathname === "/oauth/authorize" && (normalizedMethod === "GET" || normalizedMethod === "POST")) {
    return true;
  }
  if ((pathname === "/oauth/register" || pathname === "/oauth/token") && normalizedMethod === "POST") {
    return true;
  }
  if (isOAuthDiscoveryRoute(pathname) && normalizedMethod === "GET") return true;
  if (isOAuthClientDeleteRoute(pathname) && normalizedMethod === "DELETE") return true;
  if (pathname === "/mcp") {
    return ["GET", "POST", "DELETE", "OPTIONS"].includes(normalizedMethod);
  }
  return false;
}

export function resolvePublicAssetPath(
  urlPath: string,
  publicDir: string
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}
