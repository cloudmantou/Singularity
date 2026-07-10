/**
 * Convert a Fastify request into a Fetch API Request and write the Response back.
 *
 * JSON/HTML are fully buffered (avoids empty bodies under Fastify/Nginx).
 * SSE (text/event-stream) is streamed for /chat.
 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../index";
import worker from "../index";
import { createExecutionContext } from "./env";
import { readPublicUrlFromProcess } from "../config/site";

const HOP_BY_HOP = new Set([
  "transfer-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "upgrade",
]);

/** Client aborted / proxy cut the socket mid-stream — never crash the process. */
export function isBenignStreamClose(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as NodeJS.ErrnoException & { name?: string };
  const code = e.code || "";
  if (
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ECANCELED" ||
    code === "ABORT_ERR"
  ) {
    return true;
  }
  if (e.name === "AbortError") return true;
  const msg = String(e.message || "");
  return /premature close|aborted|socket hang up/i.test(msg);
}

function buildRequestUrl(req: FastifyRequest): string {
  // Prefer PUBLIC_URL from .env — single global site domain for OAuth issuer
  const configured = readPublicUrlFromProcess();
  if (configured) {
    return `${configured}${req.url}`;
  }

  const xfHost = req.headers["x-forwarded-host"];
  const hostRaw =
    (Array.isArray(xfHost) ? xfHost[0] : xfHost) || req.headers.host || "127.0.0.1";
  let host = String(hostRaw).split(",")[0].trim();
  host = host.replace(/:443$/i, "").replace(/:80$/i, "");

  const protoHeader = req.headers["x-forwarded-proto"];
  let proto =
    (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) || "http";
  proto = String(proto).split(",")[0].trim().toLowerCase();
  if (String(hostRaw).includes(":443") && proto === "http") proto = "https";

  return `${proto}://${host}${req.url}`;
}

/**
 * Pipe Fetch SSE body → HTTP ServerResponse without crashing when the browser
 * tab closes mid-stream (ERR_STREAM_PREMATURE_CLOSE).
 */
async function pipeSseToResponse(
  webBody: ReadableStream,
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  responseHeaders: Array<[string, string]>
): Promise<void> {
  // Hijack so Fastify does not end the response when the route handler returns.
  reply.hijack();
  reply.raw.statusCode = status;
  for (const [key, value] of responseHeaders) {
    reply.raw.setHeader(key, value);
  }
  reply.raw.setHeader("cache-control", "no-cache, no-transform");
  reply.raw.setHeader("x-accel-buffering", "no");
  if (!reply.raw.headersSent) {
    reply.raw.flushHeaders();
  }

  const nodeStream = Readable.fromWeb(
    webBody as unknown as import("stream/web").ReadableStream
  );

  // Swallow async stream errors so they never become uncaughtException
  // after pipeline() has already settled (common on client disconnect).
  const quiet = (err: unknown) => {
    if (!isBenignStreamClose(err)) {
      console.error("[sse] stream error:", err);
    }
  };
  nodeStream.on("error", quiet);
  reply.raw.on("error", quiet);

  const abortUpstream = () => {
    if (!nodeStream.destroyed) {
      nodeStream.destroy();
    }
  };
  // Client closed the socket (refresh, navigate away, proxy timeout)
  req.raw.on("close", abortUpstream);
  reply.raw.on("close", abortUpstream);

  try {
    await pipeline(nodeStream, reply.raw);
  } catch (error) {
    if (!isBenignStreamClose(error)) {
      console.error("[sse] pipeline failed:", error);
    }
    // Always ensure source is torn down; destination may already be closed.
    abortUpstream();
  } finally {
    req.raw.off("close", abortUpstream);
    reply.raw.off("close", abortUpstream);
    if (!nodeStream.destroyed) nodeStream.destroy();
  }
}

export async function handleWithWorker(
  req: FastifyRequest,
  reply: FastifyReply,
  env: Env
): Promise<void> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  headers.delete("content-length");

  let body: BodyInit | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.body == null) {
      body = undefined;
    } else if (Buffer.isBuffer(req.body)) {
      body = new Uint8Array(req.body);
    } else if (typeof req.body === "string") {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const request = new Request(buildRequestUrl(req), {
    method: req.method,
    headers,
    body,
  });

  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);

  reply.status(response.status);
  const responseHeaders: Array<[string, string]> = [];
  response.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    responseHeaders.push([key, value]);
    reply.header(key, value);
  });

  if (!response.body) {
    reply.send();
    return;
  }

  const contentType = response.headers.get("content-type") || "";

  // Only stream true SSE; buffer everything else so JSON APIs never return empty bodies.
  if (contentType.includes("text/event-stream")) {
    await pipeSseToResponse(
      response.body,
      req,
      reply,
      response.status,
      responseHeaders
    );
    return;
  }

  const buf = Buffer.from(await response.arrayBuffer());
  reply.header("content-length", String(buf.length));
  reply.send(buf);
}
