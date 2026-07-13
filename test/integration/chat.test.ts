import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("removed POST /chat", () => {
  let env: Env;

  beforeEach(() => {
    env = makeTestEnv(makeTestDb());
  });

  it("is not exposed as an unverified answer bypass", async () => {
    const res = await worker.fetch(req("POST", "/chat", {
      body: { query: "hello", memories: "client supplied facts" },
    }), env, ctx);
    expect(res.status).toBe(404);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

});
