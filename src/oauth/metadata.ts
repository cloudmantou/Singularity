/**
 * OAuth 2.0 discovery documents for MCP / ChatGPT connectors.
 *
 * - RFC 8414 Authorization Server Metadata
 * - RFC 9728 Protected Resource Metadata
 */

export const MCP_SCOPE = "mcp";

export function buildAuthorizationServerMetadata(origin: string): Record<string, unknown> {
  const base = origin.replace(/\/+$/, "");
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
    // Helpful for clients that probe revocation
    revocation_endpoint: `${base}/oauth/token`,
  };
}

/**
 * Protected resource metadata for the MCP endpoint.
 * @param origin public origin e.g. https://agent.mtzs.cloud
 * @param resourcePath path of the resource, usually "/mcp"
 */
export function buildProtectedResourceMetadata(
  origin: string,
  resourcePath = "/mcp"
): Record<string, unknown> {
  const base = origin.replace(/\/+$/, "");
  const path = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  const resource = path === "/" ? base : `${base}${path}`;
  return {
    resource,
    authorization_servers: [base],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

/** Path-suffixed well-known: /.well-known/oauth-protected-resource/mcp → resource path /mcp */
export function resourcePathFromProtectedWellKnown(pathname: string): string {
  const prefix = "/.well-known/oauth-protected-resource";
  if (pathname === prefix || pathname === `${prefix}/`) return "/mcp";
  if (pathname.startsWith(prefix + "/")) {
    const suffix = pathname.slice(prefix.length);
    return suffix.startsWith("/") ? suffix : `/${suffix}`;
  }
  return "/mcp";
}

export function isOAuthAuthorizationServerWellKnown(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-authorization-server/"
  );
}

export function isOAuthProtectedResourceWellKnown(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname.startsWith("/.well-known/oauth-protected-resource/")
  );
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 0), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, *",
    },
  });
}
