/**
 * Site-wide public URL configuration.
 *
 * Self-host users set once in .env:
 *   PUBLIC_URL=https://your.domain
 *
 * Used for OAuth issuer, MCP URL, logs, and any absolute links.
 * Never hardcode a personal domain in application logic.
 */

export const PUBLIC_URL_ENV_KEYS = [
  "PUBLIC_URL",
  "PUBLIC_BASE_URL",
  "SITE_URL",
] as const;

export type PublicUrlEnv = Partial<
  Record<(typeof PUBLIC_URL_ENV_KEYS)[number], string | undefined>
> & {
  PUBLIC_URL?: string;
  PUBLIC_BASE_URL?: string;
  SITE_URL?: string;
};

/** Strip trailing slashes; return empty string if unset/invalid. */
export function normalizePublicUrl(raw: string | undefined | null): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    // origin only — no path, no trailing slash
    return u.origin;
  } catch {
    // allow host without scheme → assume https
    try {
      const u = new URL(`https://${s.replace(/^\/+/, "")}`);
      return u.origin;
    } catch {
      return "";
    }
  }
}

/**
 * Read public site origin from env-like object (process.env or Worker Env).
 * Priority: PUBLIC_URL → PUBLIC_BASE_URL → SITE_URL
 */
export function readPublicUrl(env: PublicUrlEnv = {}): string {
  for (const key of PUBLIC_URL_ENV_KEYS) {
    const v = env[key];
    if (v?.trim()) {
      const n = normalizePublicUrl(v);
      if (n) return n;
    }
  }
  return "";
}

/** Same as readPublicUrl but also checks process.env when available. */
export function readPublicUrlFromProcess(
  env: PublicUrlEnv = {}
): string {
  const fromEnv = readPublicUrl(env);
  if (fromEnv) return fromEnv;
  if (typeof process !== "undefined" && process.env) {
    return readPublicUrl(process.env as PublicUrlEnv);
  }
  return "";
}

export function mcpPublicUrl(publicOrigin: string): string {
  const base = normalizePublicUrl(publicOrigin);
  return base ? `${base}/mcp` : "/mcp";
}

export function oauthAuthorizationServerUrl(publicOrigin: string): string {
  const base = normalizePublicUrl(publicOrigin);
  return base
    ? `${base}/.well-known/oauth-authorization-server`
    : "/.well-known/oauth-authorization-server";
}

export function siteConfigJson(publicOrigin: string): {
  publicUrl: string;
  mcpUrl: string;
  oauthAuthorizationServer: string;
  oauthAuthorize: string;
  oauthToken: string;
  oauthRegister: string;
} {
  const base = normalizePublicUrl(publicOrigin);
  return {
    publicUrl: base,
    mcpUrl: base ? `${base}/mcp` : "",
    oauthAuthorizationServer: base
      ? `${base}/.well-known/oauth-authorization-server`
      : "",
    oauthAuthorize: base ? `${base}/oauth/authorize` : "",
    oauthToken: base ? `${base}/oauth/token` : "",
    oauthRegister: base ? `${base}/oauth/register` : "",
  };
}
