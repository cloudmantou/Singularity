import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const AUTH_TOKEN = "e2e-owner-token";
const ROOT = process.cwd();

let child: ChildProcess | undefined;
let baseUrl = "";
let tempDir = "";
let databasePath = "";
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
  tempDir = await mkdtemp(path.join(os.tmpdir(), "singularity-mcp-e2e-"));
  databasePath = path.join(tempDir, "memory.db");

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
        DATABASE_PATH: databasePath,
        ALLOW_DEV_EMBEDDING: "true",
        EMBEDDING_PROVIDER: "local-hash-dev",
        EXTERNAL_EVOLUTION_MCP: "1",
        OAUTH_ALLOWED_REDIRECT_ORIGINS: "https://chatgpt.com,http://127.0.0.1,http://localhost",
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
  it("rejects scanner routes before Worker telemetry", async () => {
    const beforeDb = new Database(databasePath, { readonly: true });
    const before = Number((beforeDb.prepare(
      `SELECT COUNT(*) AS count FROM sb_request_logs`
    ).get() as { count: number }).count);
    beforeDb.close();

    const responses = await Promise.all([
      fetch(`${baseUrl}/wp-json/gravitysmtp/v1/tests/mock-data`),
      fetch(`${baseUrl}/robots.txt`),
      fetch(`${baseUrl}/api/graphql`, { method: "POST" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    await delay(100);

    const afterDb = new Database(databasePath, { readonly: true });
    const after = Number((afterDb.prepare(
      `SELECT COUNT(*) AS count FROM sb_request_logs`
    ).get() as { count: number }).count);
    afterDb.close();
    expect(after).toBe(before);
  });

  it("keeps OAuth issuer and resource consistent behind forwarded proxy headers", async () => {
    const proxyHeaders = {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "proxy-internal.invalid",
    };
    const authorizationServer = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
      { headers: proxyHeaders }
    );
    expect(authorizationServer.status).toBe(200);
    expect(await authorizationServer.json()).toMatchObject({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
    });

    const protectedResource = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
      { headers: proxyHeaders }
    );
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
    });
  });

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
        serverInfo: { name: "singularity" },
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
        "evolution_next",
        "evolution_submit",
        "forget",
      ])
    );
  });

  it("leases and applies a traceable exact duplicate through the external evolution tools", async () => {
    const now = Date.now();
    const contents = {
      source: "Singularity preserves immutable source observations.",
      target: "Singularity preserves immutable source observations.",
    } as const;
    const contentHashes = {
      source: createHash("sha256").update(contents.source).digest("hex"),
      target: createHash("sha256").update(contents.target).digest("hex"),
    } as const;
    const db = new Database(databasePath);
    try {
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
         VALUES ('evolution-source', ?, '["project/singularity"]', 'mcp', ?, '[]', ?),
                ('evolution-target', ?, '["project/singularity"]', 'mcp', ?, '[]', ?)`
      ).run(contents.source, now, contentHashes.source, contents.target, now, contentHashes.target);
      db.prepare(
        `INSERT INTO sb_observations (
           id, content, source, content_hash, source_channel, source_identity,
           author_type, source_timestamp, revision, root_evidence_id,
           extraction_status, created_at
         ) VALUES ('evolution-source-observation', ?, 'mcp', ?, 'mcp', 'e2e/shared',
                   'user', ?, 1, 'evolution-shared-root', 'completed', ?),
                  ('evolution-target-observation', ?, 'mcp', ?, 'mcp', 'e2e/shared',
                   'user', ?, 1, 'evolution-shared-root', 'completed', ?)`
      ).run(
        contents.source,
        contentHashes.source,
        now,
        now,
        contents.target,
        contentHashes.target,
        now,
        now
      );
      db.prepare(
        `INSERT INTO sb_external_links (
           id, provider, vault_id, external_path, object_type, object_id,
           entry_id, sync_status, created_at, updated_at
         ) VALUES ('evolution-source-link', 'mcp', 'work-vault', 'source', 'memory',
                   'evolution-source', 'evolution-source', 'synced', ?, ?),
                  ('evolution-target-link', 'mcp', 'work-vault', 'target', 'memory',
                   'evolution-target', 'evolution-target', 'synced', ?, ?)`
      ).run(now, now, now, now);
      for (const side of ["source", "target"] as const) {
        const parentId = `evolution-${side}-parent`;
        const versionId = `${parentId}-v1`;
        const entryId = `evolution-${side}`;
        const claimId = `${entryId}-claim`;
        const observationId = `${entryId}-observation`;
        const evidenceRootId = "evolution-shared-root";
        const content = contents[side];
        const contentHash = contentHashes[side];
        db.prepare(
          `INSERT INTO sb_parent_units (
             parent_id, active_version_id, scope_id, created_at, updated_at
           ) VALUES (?, ?, 'project/singularity', ?, ?)`
        ).run(parentId, versionId, now, now);
        db.prepare(
          `INSERT INTO sb_parent_versions (
             version_id, parent_id, version_number, source_observation_id,
             source_snapshot_hash, tags_snapshot_json, source_snapshot, vault_snapshot,
             metadata_snapshot_hash, metadata_snapshot_source,
             state, activated_at, activation_time_source, created_at, updated_at
           ) VALUES (?, ?, 1, ?, ?, '["project/singularity"]',
                     'mcp', 'work-vault', ?, 'recorded', 'active', ?, 'recorded', ?, ?)`
        ).run(
          versionId,
          parentId,
          observationId,
          contentHash,
          `e2e:${versionId}`,
          now,
          now,
          now
        );
        db.prepare(
          `INSERT INTO sb_memories (
             id, content, kind, memory_class, confidence, entry_id, parent_version_id,
             scope_id, claim_status, scores_json, content_hash, observed_at,
             entities_json, created_at
           ) VALUES (?, ?, 'semantic', 'fact', 1, ?, ?, 'project/singularity',
                     'supported', '{}', ?, ?, '[]', ?)`
        ).run(claimId, content, entryId, versionId, contentHash, now, now);
        db.prepare(
          `INSERT INTO sb_memory_sources (
             id, memory_id, observation_id, role, score, relation, evidence_score,
             derivation_confidence, extractor_model, extractor_version,
             evidence_root_id, created_at
           ) VALUES (?, ?, ?, 'supports', 1, 'supports', 1, 1,
                     'e2e', '1', ?, ?)`
        ).run(`${claimId}-source`, claimId, observationId, evidenceRootId, now);
        db.prepare(
          `INSERT INTO sb_parent_version_claims (
             parent_version_id, memory_id, relation, created_at
           ) VALUES (?, ?, 'supports', ?)`
        ).run(versionId, claimId, now);
      }
      db.prepare(
        `INSERT INTO sb_memory_merge_candidates (
           id, source_memory_id, target_memory_id, similarity,
           suggested_action, state, created_at
         ) VALUES ('evolution-e2e', 'evolution-source', 'evolution-target', 0.94,
                   'duplicate', 'pending', ?)`
      ).run(now);
    } finally {
      db.close();
    }

    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } } }
    );
    const client = new Client({ name: "external-evolution-e2e", version: "1.0.0" });
    await client.connect(transport);
    try {
      const next = (await client.callTool({
        name: "evolution_next",
        arguments: { reviewer_id: "codex-e2e", lease_seconds: 60 },
      })) as any;
      expect(next.isError).not.toBe(true);
      const lease = JSON.parse(next.content?.find((part: any) => part.type === "text")?.text ?? "{}");
      expect(lease).toMatchObject({ objectId: "evolution-e2e", objectType: "memory_merge_candidate" });
      expect(lease.manifest.evidence.map((item: any) => item.vaultIds)).toEqual([
        ["work-vault"],
        ["work-vault"],
      ]);
      const leaseDb = new Database(databasePath, { readonly: true });
      try {
        expect(leaseDb.prepare(
          `SELECT m.entry_id, m.parent_version_id, pv.vault_snapshot
           FROM sb_memories m
           LEFT JOIN sb_parent_versions pv ON pv.version_id = m.parent_version_id
           WHERE m.entry_id IN ('evolution-source', 'evolution-target')
           ORDER BY m.entry_id`
        ).all()).toEqual([
          {
            entry_id: "evolution-source",
            parent_version_id: "evolution-source-parent-v1",
            vault_snapshot: "work-vault",
          },
          {
            entry_id: "evolution-target",
            parent_version_id: "evolution-target-parent-v1",
            vault_snapshot: "work-vault",
          },
        ]);
      } finally {
        leaseDb.close();
      }

      const submitted = (await client.callTool({
        name: "evolution_submit",
        arguments: {
          job_id: lease.jobId,
          lease_token: lease.leaseToken,
          snapshot_hash: lease.snapshotHash,
          reviewer_id: "codex-e2e",
          reviewer_model: "codex-e2e-model",
          proposal: {
            decision: "duplicate",
            reason: "Both claims are the same fact from the same evidence lineage.",
            evidenceRefs: ["SOURCE", "TARGET"],
            confidence: { decision: 1, evidence: 1 },
            abstain: false,
            reviewability: "sufficient",
            missingContext: [],
            keyDifferences: [{
              dimension: "content",
              status: "same",
              summary: "The normalized Claim content and evidence lineage are identical.",
              evidenceRefs: ["SOURCE", "TARGET"],
            }],
            refinement: {
              action: "consolidate",
              content: null,
              sourceRefs: ["SOURCE", "TARGET"],
            },
          },
        },
      })) as any;
      expect(submitted.isError, `${JSON.stringify(submitted)}\n${serverOutput}`).not.toBe(true);
      const result = JSON.parse(
        submitted.content?.find((part: any) => part.type === "text")?.text ?? "{}"
      );
      expect(result).toMatchObject({
        objectId: "evolution-e2e",
        decision: "duplicate",
        status: "applied",
      });
    } finally {
      await client.close();
    }

    const verified = new Database(databasePath, { readonly: true });
    try {
      expect(verified.prepare(
        `SELECT state, reviewed_by FROM sb_memory_merge_candidates WHERE id = 'evolution-e2e'`
      ).get()).toMatchObject({ state: "accepted" });
      expect(verified.prepare(
        `SELECT decision_source FROM sb_ai_review_applications
         WHERE object_id = 'evolution-e2e'`
      ).get()).toEqual({ decision_source: "deterministic" });
      const evolution = verified.prepare(
        `SELECT output_claim_id, output_generated
         FROM sb_knowledge_evolutions WHERE candidate_id = 'evolution-e2e'`
      ).get() as { output_claim_id: string; output_generated: number };
      expect(evolution.output_generated).toBe(0);
      expect(verified.prepare(
        `SELECT evidence_root_id FROM sb_memory_sources
         WHERE memory_id = ? ORDER BY evidence_root_id`
      ).all(evolution.output_claim_id)).toEqual([
        { evidence_root_id: "evolution-shared-root" },
        { evidence_root_id: "evolution-shared-root" },
      ]);
      expect(verified.prepare(
        `SELECT id, content FROM sb_observations
         WHERE id LIKE 'evolution-%-observation' ORDER BY id`
      ).all()).toEqual([
        { id: "evolution-source-observation", content: contents.source },
        { id: "evolution-target-observation", content: contents.target },
      ]);
    } finally {
      verified.close();
    }
  });

  it("updates a remembered fact through MCP and exposes the committed version", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } } }
    );
    const client = new Client({ name: "selfhost-update-e2e", version: "1.0.0" });
    await client.connect(transport);

    try {
      const remembered = (await client.callTool({
        name: "remember",
        arguments: {
          content: "MCP version switch original",
          tags: ["e2e"],
          source: "e2e",
        },
      })) as any;
      const rememberText = remembered.content?.find((part: any) => part.type === "text")?.text ?? "";
      const id = rememberText.match(/ID:\s*([0-9a-f-]{36})/i)?.[1];
      expect(id).toBeTruthy();

      // The initial vector write is scheduled through waitUntil; allow it to
      // settle before exercising the explicit version switch.
      await delay(100);
      const updated = (await client.callTool({
        name: "update",
        arguments: { id, content: "MCP version switch updated" },
      })) as any;
      expect(updated.isError).not.toBe(true);

      const listed = await fetch(`${baseUrl}/list?n=100`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      expect(listed.status).toBe(200);
      const entries = (await listed.json()) as Array<{ id: string; content: string }>;
      expect(entries.find((entry) => entry.id === id)?.content).toBe(
        "MCP version switch updated"
      );
    } finally {
      await client.close();
    }
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
        client_name: "private-singularity-e2e",
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
    expect(login.headers.get("cache-control")).toContain("no-store");
    expect(login.headers.get("referrer-policy")).toBe("no-referrer");
    expect(login.headers.get("x-frame-options")).toBe("DENY");
    expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Chrome enforces form-action on the OAuth post-submit redirect to the client.
    expect(login.headers.get("content-security-policy")).toContain("form-action");
    expect(login.headers.get("content-security-policy")).toContain("https://chatgpt.com");
    const loginHtml = await login.text();
    expect(loginHtml).toContain("仅个人实例使用");
    expect(loginHtml).toContain("private-singularity-e2e");
    expect(loginHtml).toContain("https://chatgpt.com/aip/callback");
    expect(loginHtml).toContain("读取、写入和删除");

    const plainPkce = new URL(authorizeUrl);
    plainPkce.searchParams.set("code_challenge_method", "plain");
    const plainResponse = await fetch(plainPkce, { redirect: "manual" });
    expect(plainResponse.status).toBe(400);

    const unsupportedScope = new URL(authorizeUrl);
    unsupportedScope.searchParams.set("scope", "read-only");
    expect((await fetch(unsupportedScope, { redirect: "manual" })).status).toBe(400);

    const unsupportedResponseType = new URL(authorizeUrl);
    unsupportedResponseType.searchParams.set("response_type", "token");
    expect(
      (await fetch(unsupportedResponseType, { redirect: "manual" })).status
    ).toBe(400);

    const denied = await fetch(authorizeUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "wrong-owner-token" }),
    });
    expect(denied.status).toBe(401);

    const approveCode = async (): Promise<string> => {
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
      return code || "";
    };

    const wrongVerifierCode = await approveCode();
    const wrongVerifier = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: wrongVerifierCode,
        redirect_uri: redirectUri,
        client_id: clientInfo.client_id,
        code_verifier: `${verifier}-wrong`,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(wrongVerifier.status).toBe(400);

    const wrongRedirectCode = await approveCode();
    const wrongRedirect = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: wrongRedirectCode,
        redirect_uri: "https://chatgpt.com/not-the-registered-callback",
        client_id: clientInfo.client_id,
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(wrongRedirect.status).toBe(400);

    const oneTimeCode = await approveCode();
    const oneTimeExchange = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: oneTimeCode,
        redirect_uri: redirectUri,
        client_id: clientInfo.client_id,
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(oneTimeExchange.status).toBe(200);
    const reusedCode = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: oneTimeCode,
        redirect_uri: redirectUri,
        client_id: clientInfo.client_id,
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(reusedCode.status).toBe(400);

    const code = await approveCode();

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
      refresh_token: string;
      token_type: string;
      scope: string;
    };
    expect(token).toMatchObject({ token_type: "bearer", scope: "mcp" });
    expect(token.refresh_token).toBeTruthy();

    const oauthAccess = await fetch(
      mcpRequest(token.access_token, initializeMessage(3))
    );
    expect(oauthAccess.status).toBe(200);
    expect(await oauthAccess.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: { protocolVersion: "2025-06-18" },
    });

    const oauthTransport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } } }
    );
    const oauthClient = new Client({ name: "oauth-tools-e2e", version: "1.0.0" });
    await oauthClient.connect(oauthTransport);
    const oauthCatalogue = await oauthClient.listTools();
    const recent = await oauthClient.callTool({
      name: "list_recent",
      arguments: { n: 1 },
    });
    await oauthClient.close();
    expect(oauthCatalogue.tools.map((tool) => tool.name)).toContain("list_recent");
    expect(recent.isError).not.toBe(true);

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

    const invalidRefreshScope = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: clientInfo.client_id,
        resource: `${baseUrl}/mcp`,
        scope: "read-only",
      }),
    });
    expect(invalidRefreshScope.status).toBe(400);
    expect(await invalidRefreshScope.json()).toMatchObject({
      error: "invalid_scope",
    });

    const refreshResponse = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: clientInfo.client_id,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).toBeTruthy();
    expect(
      (await fetch(mcpRequest(refreshed.access_token, initializeMessage(5)))).status
    ).toBe(200);

    const revokedRefresh = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshed.refresh_token,
        client_id: clientInfo.client_id,
      }),
    });
    expect(revokedRefresh.status).toBe(200);

    const afterRefreshRevocation = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshed.refresh_token,
        client_id: clientInfo.client_id,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(afterRefreshRevocation.status).toBe(400);
    expect(
      (await fetch(mcpRequest(refreshed.access_token, initializeMessage(6)))).status
    ).toBe(401);

    const managedClients = await fetch(`${baseUrl}/settings/oauth/clients`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(managedClients.status).toBe(200);
    expect(
      ((await managedClients.json()) as { clients: Array<{ clientId: string }> }).clients
        .map((item) => item.clientId)
    ).toContain(clientInfo.client_id);

    const deletedClient = await fetch(
      `${baseUrl}/settings/oauth/clients/${encodeURIComponent(clientInfo.client_id)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      }
    );
    expect(deletedClient.status).toBe(200);
    expect(await deletedClient.json()).toMatchObject({
      ok: true,
      deleted: clientInfo.client_id,
    });
  });

  it("uses narrow OAuth body limits while retaining the larger import limit", async () => {
    const oversizedRegistration = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    });
    expect(oversizedRegistration.status).toBe(413);

    const anonymousImport = await fetch(`${baseUrl}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Deliberately invalid JSON: a 401 proves onRequest auth ran before the
      // parser tried to buffer/parse this otherwise-expensive body.
      body: "x".repeat(300 * 1024),
    });
    expect(anonymousImport.status).toBe(401);

    const importResponse = await fetch(`${baseUrl}/import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries: [], padding: "x".repeat(300 * 1024) }),
    });
    expect(importResponse.status).toBe(200);
  });

  it("rejects authorization redirects outside the personal allowlist", async () => {
    const redirectUri = "https://evil.example/callback";
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.20",
      },
      body: JSON.stringify({
        client_name: '<img src=x onerror="alert(1)">',
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string };
    const authorize = new URL(`${baseUrl}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", "mcp");
    authorize.searchParams.set("code_challenge", "test-challenge");
    authorize.searchParams.set("code_challenge_method", "S256");

    const blocked = await fetch(authorize, { redirect: "manual" });
    expect(blocked.status).toBe(403);
    const blockedHtml = await blocked.text();
    expect(blockedHtml).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(blockedHtml).not.toContain('<img src=x onerror="alert(1)">');
  });

  it("rate-limits repeated dynamic client registrations", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: `rate-test-${i}`,
          redirect_uris: [`http://127.0.0.1:${43000 + i}/callback`],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
  });

  it("blocks repeated wrong owner-token attempts for fifteen minutes", async () => {
    const redirectUri = "http://localhost:43199/callback";
    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.20",
      },
      body: JSON.stringify({
        client_name: "failed-auth-rate-test",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string };
    const authorize = new URL(`${baseUrl}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", "mcp");
    authorize.searchParams.set("code_challenge", "failed-auth-test-challenge");
    authorize.searchParams.set("code_challenge_method", "S256");

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await fetch(authorize, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Forwarded-For": "198.51.100.20",
        },
        body: new URLSearchParams({ password: `wrong-${i}` }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
    const blocked = statuses.lastIndexOf(429);
    expect(blocked).toBeGreaterThanOrEqual(0);
  });
});
