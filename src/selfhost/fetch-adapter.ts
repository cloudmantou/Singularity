/**
 * Convert a Fastify request into a Fetch API Request and write the Response back.
 *
 * JSON/HTML are fully buffered (avoids empty bodies under Fastify/Nginx).
 * SSE (text/event-stream) is streamed for /chat.
 */

import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../index";
import worker from "../index";
import { createExecutionContext } from "./env";

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
  // Prefer explicit public origin (ChatGPT OAuth issuer must be https://domain)
  const configured = (process.env.PUBLIC_URL || process.env.PUBLIC_BASE_URL || "").trim();
  if (configured) {
    try {
      const origin = new URL(configured).origin;
      return `${origin}${req.url}`;
    } catch {
      /* fall through */
    }
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
  response.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    reply.header(key, value);
  });

  if (!response.body) {
    reply.send();
    return;
  }

  const contentType = response.headers.get("content-type") || "";

  // Only stream true SSE; buffer everything else so JSON APIs never return empty bodies.
  if (contentType.includes("text/event-stream")) {
    const nodeStream = Readable.fromWeb(
      response.body as unknown as import("stream/web").ReadableStream
    );
    reply.send(nodeStream);
    return;
  }

  const buf = Buffer.from(await response.arrayBuffer());
  reply.header("content-length", String(buf.length));
  reply.send(buf);
}
