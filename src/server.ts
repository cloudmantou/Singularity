/**
 * Self-host entrypoint — Fastify front door over the existing Worker fetch handler.
 *
 * Usage:
 *   cp .env.example .env   # set AUTH_TOKEN + LLM_* / EMBEDDING_*
 *   npm run server
 *
 * Cloudflare Worker entry remains: src/index.ts via wrangler.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import dotenv from "dotenv";
import worker, { initializeDatabase } from "./index";
import {
  createExecutionContext,
  createSelfhostEnv,
} from "./selfhost/env";
import { handleWithWorker } from "./selfhost/fetch-adapter";
import {
  handleUnhandledRejection,
  isBenignStreamClose,
  runMcpRequest,
} from "./selfhost/process-errors";
import { getEffectiveModelSettings } from "./settings/store";
import { isDevLocalProvider } from "./settings/model-settings";
import { flushTelemetry } from "./telemetry";
import { createFixedWindowRateLimiter } from "./selfhost/rate-limit";

dotenv.config();

// Register ASAP: client disconnect mid-SSE must never kill the process.
// (Node 20/24 stream.pipeline used to throw uncaught ERR_STREAM_PREMATURE_CLOSE.)
process.on("uncaughtException", (err) => {
  if (isBenignStreamClose(err)) {
    console.warn("[stream] ignored premature close (client disconnected)");
    return;
  }
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  handleUnhandledRejection(reason, {
    warn: (message, ...details) => console.warn(message, ...details),
    error: (message, ...details) => console.error(message, ...details),
    exit: (code) => process.exit(code),
  });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
};

async function tryServePublic(
  urlPath: string
): Promise<{ body: Buffer; contentType: string } | null> {
  let rel = decodeURIComponent(urlPath.split("?")[0] || "/");
  if (rel === "/") rel = "/index.html";
  const resolved = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  try {
    const body = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    return { body, contentType: MIME[ext] || "application/octet-stream" };
  } catch {
    return null;
  }
}

async function main() {
  const { env, databasePath } = createSelfhostEnv();

  // Await schema init before accepting traffic (fixes empty-DB race).
  await initializeDatabase(env);

  const { effective } = await getEffectiveModelSettings(env);
  const embConfigured =
    Boolean(effective.embedding.baseURL && effective.embedding.apiKey) ||
    (isDevLocalProvider(effective.embedding.provider) &&
      (env.ALLOW_DEV_EMBEDDING === "1" || env.ALLOW_DEV_EMBEDDING === "true")) ||
    Boolean(env.AI && env.SELFHOST !== "1");

  if (!embConfigured) {
    console.warn(
      "[warn] Production embedding is not configured. Capture/recall will fail until " +
        "you set EMBEDDING_* or configure Settings → Models & API. " +
        "For smoke tests only: ALLOW_DEV_EMBEDDING=true EMBEDDING_PROVIDER=local-hash-dev"
    );
  }
  if (isDevLocalProvider(effective.embedding.provider)) {
    console.warn(
      "[warn] DEV local-hash embeddings are active. Do not use for real memory corpora."
    );
  }

  const app = Fastify({
    logger: true,
    // Keep the control plane narrow by default. Import and MCP receive explicit
    // route-level limits below.
    bodyLimit: 256 * 1024,
    // Only the same-host reverse proxy may provide X-Forwarded-For.
    trustProxy: ["127.0.0.1", "::1"],
  });

  const oauthRegistrationBurstLimiter = createFixedWindowRateLimiter({
    limit: 5,
    windowMs: 60_000,
  });
  const oauthRegistrationHourlyLimiter = createFixedWindowRateLimiter({
    limit: 20,
    windowMs: 60 * 60_000,
  });
  const oauthFailedAuthorizationLimiter = createFixedWindowRateLimiter({
    limit: 5,
    windowMs: 15 * 60_000,
  });
  const oauthTokenLimiter = createFixedWindowRateLimiter({
    limit: 30,
    windowMs: 60_000,
  });

  function oauthRateLimitPreHandler(
    ...limiters: Array<ReturnType<typeof createFixedWindowRateLimiter>>
  ) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.method !== "POST") return;
      const results = limiters.map((limiter) => limiter.consume(req.ip || "unknown"));
      const denied = results.find((result) => !result.allowed);
      if (!denied) return;
      return reply
        .code(429)
        .header("Retry-After", String(denied.retryAfterSeconds))
        .header("Cache-Control", "no-store")
        .send({
          ok: false,
          error: "Too many OAuth requests. Try again later.",
        });
    };
  }

  async function failedAuthorizationRateLimitPreHandler(
    req: FastifyRequest,
    reply: FastifyReply
  ) {
    if (req.method !== "POST") return;
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.body === "string"
        ? req.body
        : "";
    const suppliedPassword = new URLSearchParams(rawBody).get("password");
    if (suppliedPassword === env.AUTH_TOKEN) return;
    const result = oauthFailedAuthorizationLimiter.consume(req.ip || "unknown");
    if (result.allowed) return;
    return reply
      .code(429)
      .header("Retry-After", String(result.retryAfterSeconds))
      .header("Cache-Control", "no-store")
      .send({
        ok: false,
        error: "Too many failed owner authorization attempts. Try again later.",
      });
  }

  async function requireOwnerBeforeBody(
    req: FastifyRequest,
    reply: FastifyReply
  ) {
    if (req.headers.authorization === `Bearer ${env.AUTH_TOKEN}`) return;
    return reply
      .code(401)
      .header("Cache-Control", "no-store")
      .send({ ok: false, error: "Unauthorized" });
  }

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (!body || (body as string).length === 0) {
        done(null, null);
        return;
      }
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  app.get("/health", async () => ({
    ok: true,
    status: "healthy",
    mode: "selfhost",
  }));

  const forwardToWorker = async (req: FastifyRequest, reply: FastifyReply) => {
    await handleWithWorker(req, reply, env);
  };
  const forwardMcpToWorker = async (
    req: FastifyRequest,
    reply: FastifyReply
  ) => {
    await runMcpRequest(String(req.id), () =>
      handleWithWorker(req, reply, env)
    );
  };

  app.all(
    "/oauth/register",
    {
      bodyLimit: 64 * 1024,
      preHandler: oauthRateLimitPreHandler(
        oauthRegistrationBurstLimiter,
        oauthRegistrationHourlyLimiter
      ),
    },
    forwardToWorker
  );
  app.all(
    "/oauth/authorize",
    {
      bodyLimit: 64 * 1024,
      preHandler: failedAuthorizationRateLimitPreHandler,
    },
    forwardToWorker
  );
  app.all(
    "/oauth/token",
    {
      bodyLimit: 64 * 1024,
      preHandler: oauthRateLimitPreHandler(oauthTokenLimiter),
    },
    forwardToWorker
  );
  app.all("/mcp", { bodyLimit: 1024 * 1024 }, forwardMcpToWorker);
  app.post(
    "/import",
    {
      bodyLimit: 32 * 1024 * 1024,
      onRequest: requireOwnerBeforeBody,
    },
    forwardToWorker
  );

  app.all("/*", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD") {
      const urlPath = req.url.split("?")[0] || "/";
      const isApi =
        urlPath.startsWith("/mcp") ||
        urlPath.startsWith("/oauth") ||
        urlPath.startsWith("/capture") ||
        urlPath.startsWith("/recall") ||
        urlPath.startsWith("/relations") ||
        urlPath.startsWith("/list") ||
        urlPath.startsWith("/count") ||
        urlPath.startsWith("/stats") ||
        urlPath.startsWith("/chat") ||
        urlPath.startsWith("/digest") ||
        urlPath.startsWith("/append") ||
        urlPath.startsWith("/update") ||
        urlPath.startsWith("/forget") ||
        urlPath.startsWith("/tags") ||
        urlPath.startsWith("/settings") ||
        urlPath.startsWith("/import") ||
        urlPath.startsWith("/export") ||
        urlPath.startsWith("/analytics") ||
        urlPath.startsWith("/config") ||
        urlPath.startsWith("/health") ||
        urlPath.startsWith("/.well-known");

      if (!isApi) {
        const file = await tryServePublic(urlPath);
        if (file) {
          reply.header("content-type", file.contentType);
          if (req.method === "HEAD") return reply.send();
          return reply.send(file.body);
        }
      }
    }
    await handleWithWorker(req, reply, env);
  });

  let lastMaintenanceHour = "";
  setInterval(() => {
    const hour = new Date().toISOString().slice(0, 13);
    if (hour === lastMaintenanceHour) return;
    lastMaintenanceHour = hour;
    worker
      .scheduled({} as ScheduledEvent, env, createExecutionContext())
      .catch((err) => console.error("[scheduled]", err));
  }, 60 * 1000);

  await app.listen({ port: PORT, host: HOST });
  const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  const { readPublicUrlFromProcess, siteConfigJson } = await import("./config/site");
  const publicUrl = readPublicUrlFromProcess();
  const site = siteConfigJson(publicUrl);
  console.log(`Singularity self-host listening on http://${displayHost}:${PORT}`);
  console.log(`  database: ${databasePath}`);
  console.log(`  MCP local: http://${displayHost}:${PORT}/mcp`);
  if (publicUrl) {
    console.log(`  PUBLIC_URL: ${site.publicUrl}`);
    console.log(`  MCP public: ${site.mcpUrl}`);
    console.log(`  OAuth meta: ${site.oauthAuthorizationServer}`);
  } else {
    console.warn(
      "[warn] PUBLIC_URL is not set. Add to .env for ChatGPT/MCP OAuth:\n" +
        "       PUBLIC_URL=https://your.domain.example"
    );
  }
  console.log(
    `  LLM:      ${effective.llm.baseURL || env.LLM_BASE_URL || "(configure in Settings → Models)"}`
  );
}

async function shutdown() {
  try {
    await flushTelemetry();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
