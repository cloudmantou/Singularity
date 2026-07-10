import { describe, it, expect } from "vitest";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  isOAuthAuthorizationServerWellKnown,
  isOAuthProtectedResourceWellKnown,
  resourcePathFromProtectedWellKnown,
} from "../../src/oauth/metadata";
import {
  resolvePublicOrigin,
  rewriteRequestPublicOrigin,
} from "../../src/oauth/public-origin";

describe("OAuth metadata", () => {
  it("builds authorization server metadata for ChatGPT/MCP", () => {
    const m = buildAuthorizationServerMetadata("https://agent.mtzs.cloud");
    expect(m.issuer).toBe("https://agent.mtzs.cloud");
    expect(m.authorization_endpoint).toBe(
      "https://agent.mtzs.cloud/oauth/authorize"
    );
    expect(m.token_endpoint).toBe("https://agent.mtzs.cloud/oauth/token");
    expect(m.registration_endpoint).toBe(
      "https://agent.mtzs.cloud/oauth/register"
    );
    expect(m.scopes_supported).toEqual(["mcp"]);
    expect(m.code_challenge_methods_supported).toContain("S256");
    expect(m.revocation_endpoint).toBe("https://agent.mtzs.cloud/oauth/token");
  });

  it("builds protected resource metadata for /mcp", () => {
    const m = buildProtectedResourceMetadata("https://agent.mtzs.cloud", "/mcp");
    expect(m.resource).toBe("https://agent.mtzs.cloud/mcp");
    expect(m.authorization_servers).toEqual(["https://agent.mtzs.cloud"]);
    expect(m.scopes_supported).toEqual(["mcp"]);
  });

  it("parses well-known paths", () => {
    expect(isOAuthAuthorizationServerWellKnown("/.well-known/oauth-authorization-server")).toBe(
      true
    );
    expect(isOAuthProtectedResourceWellKnown("/.well-known/oauth-protected-resource/mcp")).toBe(
      true
    );
    expect(resourcePathFromProtectedWellKnown("/.well-known/oauth-protected-resource/mcp")).toBe(
      "/mcp"
    );
    expect(resourcePathFromProtectedWellKnown("/.well-known/oauth-protected-resource")).toBe(
      "/mcp"
    );
  });
});

describe("public origin", () => {
  it("prefers PUBLIC_URL over mangled request url", () => {
    const req = new Request("http://agent.mtzs.cloud:443/mcp");
    expect(resolvePublicOrigin(req, { PUBLIC_URL: "https://agent.mtzs.cloud" })).toBe(
      "https://agent.mtzs.cloud"
    );
  });

  it("fixes http + :443 host to https origin", () => {
    const req = new Request("http://agent.mtzs.cloud:443/.well-known/oauth-authorization-server", {
      headers: { host: "agent.mtzs.cloud:443" },
    });
    expect(resolvePublicOrigin(req)).toBe("https://agent.mtzs.cloud");
  });

  it("honors X-Forwarded-Proto https", () => {
    const req = new Request("http://127.0.0.1:8787/mcp", {
      headers: {
        host: "127.0.0.1:8787",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "agent.mtzs.cloud",
      },
    });
    expect(resolvePublicOrigin(req)).toBe("https://agent.mtzs.cloud");
  });

  it("rewrites request url for OAuthProvider", () => {
    const req = new Request("http://agent.mtzs.cloud:443/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const out = rewriteRequestPublicOrigin(req, {
      PUBLIC_URL: "https://agent.mtzs.cloud",
    });
    expect(new URL(out.url).origin).toBe("https://agent.mtzs.cloud");
    expect(new URL(out.url).pathname).toBe("/mcp");
  });
});
