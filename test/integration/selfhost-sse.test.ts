import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWithWorker } from "../../src/selfhost/fetch-adapter";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";

describe("retired self-host chat route", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it("returns 404 without invoking the legacy streaming model", async () => {
    const run = vi.fn();
    const env = makeTestEnv(makeTestDb(), {
      AI: { run } as unknown as Ai,
    });
    const app = Fastify();
    apps.push(app);
    app.post("/chat", async (request, reply) => {
      await handleWithWorker(request, reply, env);
    });

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      payload: {
        query: "我在忙什么？",
        memories: "一条近期记忆",
        mode: "recent_activity",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps serving supported routes after a client probes /chat", async () => {
    const env = makeTestEnv(makeTestDb());
    const app = Fastify();
    apps.push(app);
    app.post("/chat", async (request, reply) => {
      await handleWithWorker(request, reply, env);
    });
    app.get("/probe", async () => ({ ok: true }));

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fastify did not expose a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const removed = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "legacy request" }),
    });
    expect(removed.status).toBe(404);
    const probe = await fetch(`${baseUrl}/probe`, {
      signal: AbortSignal.timeout(1_000),
    });

    expect(probe.status).toBe(200);
    await expect(probe.json()).resolves.toEqual({ ok: true });
  });
});
