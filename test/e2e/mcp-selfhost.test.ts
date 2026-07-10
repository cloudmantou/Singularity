import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const AUTH_TOKEN = "e2e-owner-token";
const ROOT = process.cwd();

let child: ChildProcess | undefined;
let baseUrl = "";
let tempDir = "";
let serverOutput = "";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve a local test port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child?.exitCode != null) {
      throw new Error(`Self-host process exited early:\n${serverOutput.slice(-3000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Self-host server did not become ready:\n${serverOutput.slice(-3000)}`);
}

function appendServerOutput(chunk: unknown): void {
  serverOutput = `${serverOutput}${String(chunk)}`.slice(-12000);
}

function mcpRequest(token: string | null, message: Record<string, unknown>): Request {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-06-18",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
}

function initializeMessage(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "selfhost-e2e", version: "1.0.0" },
    },
  };
}

beforeAll(async () => {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  tempDir = await mkdtemp(path.join(os.tmpdir(), "second-brain-mcp-e2e-"));

  child = spawn(
    process.execPath,
    [
      "--require",
      "./src/selfhost/register-cf-shim.cjs",
      "--import",
      "tsx",
      "src/server.ts",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        AUTH_TOKEN,
        DATABASE_PATH: path.join(tempDir, "memory.db"),
        ALLOW_DEV_EMBEDDING: "true",
        EMBEDDING_PROVIDER: "local-hash-dev",
        PUBLIC_URL: baseUrl,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout?.on("data", appendServerOutput);
  child.stderr?.on("data", appendServerOutput);
  await waitForHealth();
}, 15_000);

afterAll(async () => {
  const runningChild = child;
  if (runningChild && runningChild.exitCode == null) {
    runningChild.kill("SIGTERM");
    await Promise.race([once(runningChild, "exit"), delay(3_000)]);
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("self-host MCP and personal OAuth", () => {
  it("rejects anonymous access and returns complete JSON-RPC to the owner", async () => {
    const anonymous = await fetch(mcpRequest(null, initializeMessage(1)));
    expect(anonymous.status).toBe(401);

    const initialized = await fetch(mcpRequest(AUTH_TOKEN, initializeMessage(2)));
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("content-type")).toContain("application/json");
    expect(await initialized.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "second-brain" },
      },
    });

    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } } }
    );
    const client = new Client({ name: "selfhost-sdk-e2e", version: "1.0.0" });
    await client.connect(transport);
    const catalogue = await client.listTools();
    await client.close();

    expect(catalogue.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "remember",
        "append",
        "update",
        "set_status",
        "recall",
        "list_recent",
        "forget",
      ])
    );
  });

  it("completes owner-only OAuth with PKCE and revokes the issued token", async () => {
    const redirectUri = "https://chatgpt.com/aip/callback";
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://chatgpt.com",
      },
      body: JSON.stringify({
        client_name: "private-second-brain-e2e",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const clientInfo = (await registration.json()) as {
      client_id: string;
      registration_client_uri: string;
    };
    expect(clientInfo.registration_client_uri.startsWith(baseUrl)).toBe(true);

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
    const params = {
      response_type: "code",
      client_id: clientInfo.client_id,
      redirect_uri: redirectUri,
      scope: "mcp",
      state: "private-e2e-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${baseUrl}/mcp`,
    };
    for (const [key, value] of Object.entries(params)) {
      authorizeUrl.searchParams.set(key, value);
    }

    const login = await fetch(authorizeUrl, { redirect: "manual" });
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("仅个人实例使用");

    const denied = await fetch(authorizeUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "wrong-owner-token" }),
    });
    expect(denied.status).toBe(401);

    const authorized = await fetch(authorizeUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: AUTH_TOKEN }),
    });
    expect(authorized.status).toBe(302);
    const redirect = new URL(authorized.headers.get("location") || "");
    expect(redirect.searchParams.get("state")).toBe("private-e2e-state");
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code || "",
        redirect_uri: redirectUri,
        client_id: clientInfo.client_id,
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
    };
    expect(token).toMatchObject({ token_type: "bearer", scope: "mcp" });

    const oauthAccess = await fetch(
      mcpRequest(token.access_token, initializeMessage(3))
    );
    expect(oauthAccess.status).toBe(200);

    const revoked = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: token.access_token,
        client_id: clientInfo.client_id,
      }),
    });
    expect(revoked.status).toBe(200);

    const afterRevocation = await fetch(
      mcpRequest(token.access_token, initializeMessage(4))
    );
    expect(afterRevocation.status).toBe(401);
  });
});
