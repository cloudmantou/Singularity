/**
 * Convert a Fastify request into a Fetch API Request and write the Response back.
 *
 * JSON/HTML are fully buffered (avoids empty bodies under Fastify/Nginx).
 * SSE (text/event-stream) is streamed for /chat without using stream.pipeline
 * (pipeline + client disconnect → ERR_STREAM_PREMATURE_CLOSE can kill Node).
 */

import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../index";
import worker from "../index";
import { createExecutionContext } from "./env";
import { readPublicUrlFromProcess } from "../config/site";
import { isBenignStreamClose } from "./process-errors";

export { isBenignStreamClose } from "./process-errors";

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

function buildRequestUrl(req: FastifyRequest): string {
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

function clientGone(req: FastifyRequest, reply: FastifyReply): boolean {
  return (
    req.raw.aborted === true ||
    reply.raw.destroyed ||
    reply.raw.writableEnded ||
    !reply.raw.writable
  );
}

/**
 * Write one chunk; resolve even if client already closed (benign).
 */
function writeChunk(
  res: import("node:http").ServerResponse,
  chunk: Buffer | Uint8Array
): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed || res.writableEnded || !res.writable) {
      resolve();
      return;
    }
    try {
      const ok = res.write(chunk, (err) => {
        // write callback error (EPIPE etc.) — always resolve to keep process alive
        if (err && !isBenignStreamClose(err)) {
          console.error("[sse] write error:", err);
        }
        resolve();
      });
      if (!ok) {
        res.once("drain", () => resolve());
        res.once("close", () => resolve());
        res.once("error", () => resolve());
      }
    } catch (err) {
      if (!isBenignStreamClose(err)) console.error("[sse] write threw:", err);
      resolve();
    }
  });
}

/**
 * Manually pump Web/Node stream → HTTP response.
 * Avoids stream.pipeline() which throws uncaught ERR_STREAM_PREMATURE_CLOSE
 * when the browser closes the tab mid-SSE (kills the whole Node process).
 */
async function pipeSseToResponse(
  webBody: ReadableStream,
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  responseHeaders: Array<[string, string]>
): Promise<void> {
  reply.hijack();
  reply.raw.statusCode = status;
  for (const [key, value] of responseHeaders) {
    try {
      reply.raw.setHeader(key, value);
    } catch {
      /* headers may already be sent */
    }
  }
  try {
    reply.raw.setHeader("cache-control", "no-cache, no-transform");
    reply.raw.setHeader("x-accel-buffering", "no");
    if (!reply.raw.headersSent) reply.raw.flushHeaders();
  } catch {
    /* ignore */
  }

  // Soft-ignore residual errors on the socket
  reply.raw.on("error", (err) => {
    if (!isBenignStreamClose(err)) console.error("[sse] response error:", err);
  });

  const nodeStream = Readable.fromWeb(
    webBody as unknown as import("stream/web").ReadableStream
  );
  nodeStream.on("error", (err) => {
    if (!isBenignStreamClose(err)) console.error("[sse] source error:", err);
  });

  const abortUpstream = () => {
    if (!nodeStream.destroyed) nodeStream.destroy();
  };
  req.raw.once("aborted", abortUpstream);
  reply.raw.once("close", abortUpstream);

  try {
    for await (const chunk of nodeStream) {
      if (clientGone(req, reply)) break;
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      await writeChunk(reply.raw, buf);
    }
    if (!clientGone(req, reply)) {
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    // for-await can surface destroy/abort as throw — never rethrow
    if (!isBenignStreamClose(error)) {
      console.error("[sse] pump failed:", error);
    }
  } finally {
    req.raw.off("aborted", abortUpstream);
    reply.raw.off("close", abortUpstream);
    if (!nodeStream.destroyed) {
      try {
        nodeStream.destroy();
      } catch {
        /* ignore */
      }
    }
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    }
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
