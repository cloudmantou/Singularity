/**
 * Resolve the public HTTPS origin for OAuth metadata and redirects.
 *
 * Behind Nginx, Request.url is often wrong (`http://host:443`). Prefer:
 * 1. PUBLIC_URL / PUBLIC_BASE_URL / SITE_URL env (global site config)
 * 2. X-Forwarded-Proto + X-Forwarded-Host / Host (strip default ports)
 */

import { readPublicUrl, type PublicUrlEnv } from "../config/site";

export type PublicOriginEnv = PublicUrlEnv;

export function resolvePublicOrigin(
  request: Request,
  env: PublicOriginEnv = {}
): string {
  const configured = readPublicUrl(env);
  if (configured) return configured;

  const url = new URL(request.url);
  const xfProto = headerFirst(request, "x-forwarded-proto");
  const xfHost = headerFirst(request, "x-forwarded-host");
  const hostRaw = xfHost || headerFirst(request, "host") || url.host;

  let host = hostRaw.split(",")[0].trim();
  // Drop default ports that break issuer matching for ChatGPT / MCP clients
  host = host.replace(/:443$/i, "").replace(/:80$/i, "");

  let proto = (xfProto || url.protocol.replace(":", "") || "http")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (hostRaw.includes(":443") && proto === "http") proto = "https";
  // Production personal domains should be HTTPS when not localhost
  if (
    proto === "http" &&
    host &&
    !/^localhost\b/i.test(host) &&
    !/^127\./.test(host) &&
    !/^\[::1\]/.test(host)
  ) {
    // Keep http only if explicitly local; otherwise prefer https behind reverse proxy
    if (xfProto) {
      /* honor explicit forward */
    } else if (url.port === "443" || hostRaw.includes(":443")) {
      proto = "https";
    }
  }

  return `${proto}://${host}`;
}

function headerFirst(request: Request, name: string): string | null {
  const v = request.headers.get(name);
  if (!v) return null;
  return v.split(",")[0].trim() || null;
}

/** Rebuild request so OAuthProvider sees the public origin in request.url. */
export function rewriteRequestPublicOrigin(
  request: Request,
  env: PublicOriginEnv
): Request {
  const origin = resolvePublicOrigin(request, env);
  const current = new URL(request.url);
  const next = new URL(current.pathname + current.search, origin);
  if (next.href === request.url) return request;

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: request.headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Required by undici/Node when body is a stream
    init.duplex = "half";
  }
  return new Request(next.toString(), init);
}
