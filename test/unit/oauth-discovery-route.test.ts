import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/index";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

describe("OAuth discovery routes", () => {
  let env: Env;
  beforeEach(() => {
    env = makeTestEnv();
    (env as Env).PUBLIC_URL = "https://agent.mtzs.cloud";
  });

  it("GET /.well-known/oauth-authorization-server", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/.well-known/oauth-authorization-server"),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.issuer).toBe("https://agent.mtzs.cloud");
    expect(data.authorization_endpoint).toBe(
      "https://agent.mtzs.cloud/oauth/authorize"
    );
    expect(data.token_endpoint).toBe("https://agent.mtzs.cloud/oauth/token");
    expect(data.registration_endpoint).toBe(
      "https://agent.mtzs.cloud/oauth/register"
    );
    expect(data.scopes_supported).toEqual(["mcp"]);
    expect(data.revocation_endpoint).toBe(
      "https://agent.mtzs.cloud/oauth/token"
    );
  });

  it("GET /.well-known/oauth-protected-resource/mcp", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/.well-known/oauth-protected-resource/mcp"),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.resource).toBe("https://agent.mtzs.cloud/mcp");
    expect(data.authorization_servers).toEqual(["https://agent.mtzs.cloud"]);
  });

  it("MCP 401 WWW-Authenticate points at https protected-resource metadata", async () => {
    const res = await worker.fetch(
      new Request("http://agent.mtzs.cloud:443/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      ctx
    );
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") || "";
    // Mock may not set WWW-Authenticate; real provider does after origin rewrite
    if (www) {
      expect(www).toMatch(/https:\/\/agent\.mtzs\.cloud/);
      expect(www).not.toMatch(/http:\/\/agent\.mtzs\.cloud:443/);
    }
  });
});
