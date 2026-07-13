import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("CORS", () => {
  let env: Env;
  beforeEach(() => { env = makeTestEnv(); });

  it("OPTIONS /capture allows the same origin without database work", async () => {
    const db = makeTestDb();
    env = makeTestEnv(db);
    const request = new Request("http://localhost/capture", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost" },
    });
    const res = await worker.fetch(request, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
    expect(db.statementCount).toBe(0);
  });

  it("allows configured dashboard origins and does not use wildcard CORS", async () => {
    env.DASHBOARD_ALLOWED_ORIGINS = "https://dashboard.example";
    const request = req("POST", "/capture", { body: { content: "hello" } });
    request.headers.set("Origin", "https://dashboard.example");
    const res = await worker.fetch(request, env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://dashboard.example");
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("does not expose management APIs to arbitrary browser origins", async () => {
    const request = req("POST", "/capture", { body: { content: "hello" } });
    request.headers.set("Origin", "https://attacker.example");
    const res = await worker.fetch(request, env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects scanner routes before telemetry or schema initialization", async () => {
    const db = makeTestDb();
    env = makeTestEnv(db);
    const res = await worker.fetch(new Request("http://localhost/owa"), env, ctx);
    expect(res.status).toBe(404);
    expect(db.statementCount).toBe(0);
  });

  it("keeps non-browser clients usable without adding a CORS wildcard", async () => {
    const res = await worker.fetch(req("POST", "/capture", { body: { content: "hello" } }), env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
