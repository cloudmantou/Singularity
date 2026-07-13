import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker, { initializeDatabase, type Env } from "../../src/index";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { req } from "../helpers/make-request";

const ctx = { waitUntil() {} } as unknown as ExecutionContext;

describe("digest HTTP method semantics", () => {
  let db: Database.Database;
  let env: Env;

  beforeEach(async () => {
    const selfhost = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    db = selfhost.db;
    env = selfhost.env;
    await initializeDatabase(env);
  });

  afterEach(() => db.close());

  it("previews eligibility with GET without creating a digest", async () => {
    for (let index = 0; index < 20; index += 1) {
      db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
         VALUES (?, ?, '["work"]', 'test', ?, '[]')`
      ).run(`work-${index}`, `Work note ${index}`, index + 1);
    }

    const response = await worker.fetch(req("GET", "/digest/preview?tag=work"), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      tag: "work",
      source_count: 20,
      eligible: true,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM entries`).get()).toEqual({ count: 20 });
  });

  it("requires POST and validates digest tags before running compression", async () => {
    expect((await worker.fetch(req("GET", "/digest?tag=work"), env, ctx)).status).toBe(404);
    expect((await worker.fetch(req("GET", `/digest/preview?tag=${"x".repeat(513)}`), env, ctx)).status)
      .toBe(400);
    expect((await worker.fetch(req("POST", "/digest", { body: {} }), env, ctx)).status).toBe(400);
    expect((await worker.fetch(req("POST", "/digest", {
      body: { tag: "x".repeat(513) },
    }), env, ctx)).status).toBe(400);
    expect((await worker.fetch(req("POST", "/digest", {
      body: { tag: "work" },
      token: null,
    }), env, ctx)).status).toBe(401);
  });
});
