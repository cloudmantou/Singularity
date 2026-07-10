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
import Fastify from "fastify";
import dotenv from "dotenv";
import worker, { initializeDatabase } from "./index";
import {
  createExecutionContext,
  createSelfhostEnv,
} from "./selfhost/env";
import { handleWithWorker } from "./selfhost/fetch-adapter";
import { getEffectiveModelSettings } from "./settings/store";
import { isDevLocalProvider } from "./settings/model-settings";
import { flushTelemetry } from "./telemetry";

dotenv.config();

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
    // Allow Cloudflare export JSON uploads (default 1MB is too small for large brains)
    bodyLimit: 32 * 1024 * 1024,
  });

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

  app.get("/health", async () => {
    const { effective: eff } = await getEffectiveModelSettings(env);
    return {
      ok: true,
      mode: "selfhost",
      database: databasePath,
      llm: Boolean(eff.llm.baseURL && eff.llm.apiKey),
      embedding: Boolean(eff.embedding.baseURL && eff.embedding.apiKey),
      embeddingProvider: eff.embedding.provider,
      devEmbedding: isDevLocalProvider(eff.embedding.provider),
    };
  });

  app.all("/*", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD") {
      const urlPath = req.url.split("?")[0] || "/";
      const isApi =
        urlPath.startsWith("/mcp") ||
        urlPath.startsWith("/oauth") ||
        urlPath.startsWith("/capture") ||
        urlPath.startsWith("/recall") ||
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
  const publicUrl = process.env.PUBLIC_URL || process.env.PUBLIC_BASE_URL || "";
  console.log(`Second Brain self-host listening on http://${displayHost}:${PORT}`);
  console.log(`  database: ${databasePath}`);
  console.log(`  MCP:      http://${displayHost}:${PORT}/mcp`);
  if (publicUrl) {
    console.log(`  public:   ${publicUrl.replace(/\/+$/, "")}`);
    console.log(
      `  OAuth:    ${publicUrl.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`
    );
  } else {
    console.warn(
      "[warn] PUBLIC_URL is not set. ChatGPT/MCP OAuth discovery may advertise http://host:443. " +
        "Set PUBLIC_URL=https://your.domain in .env"
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
