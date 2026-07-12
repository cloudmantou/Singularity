import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import type { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("POST /import", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("rejects missing auth", async () => {
    const res = await worker.fetch(
      req("POST", "/import", { token: null, body: [] }),
      env,
      ctx
    );
    expect(res.status).toBe(401);
  });

  it("imports array body", async () => {
    const body = [
      {
        id: "imp-1",
        content: "imported memory",
        tags: '["work"]',
        source: "claude-desktop",
        created_at: 1000,
        vector_ids: '["imp-1"]',
      },
    ];
    const res = await worker.fetch(req("POST", "/import", { body }), env, ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.inserted).toBe(1);
    expect(data.pendingVectorizeCount).toBe(1);
    expect(data.pendingVectorizeSample).toContain("imp-1");
    expect(db.entries[0].vector_ids).toBe("[]");
  });

  it("blocks import while a vector rebuild is open", async () => {
    db.entries.push({
      id: "active-1",
      content: "active memory",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 600_000,
      vector_ids: '["active-1"]',
      recall_count: 0,
      importance_score: 0,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });
    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);

    const res = await worker.fetch(
      req("POST", "/import", {
        body: [{ id: "blocked-import", content: "must wait for rebuild" }],
      }),
      env,
      ctx
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "import_blocked_during_vector_rebuild",
      rebuildId: db.vectorRebuilds[0].id,
    });
    expect(db.entries.some((entry: any) => entry.id === "blocked-import")).toBe(false);
  });

  it("rejects Cloudflare imports larger than the cold-start-safe batch", async () => {
    const body = Array.from({ length: 5 }, (_, index) => ({
      id: `imp-batch-${index}`,
      content: `memory ${index}`,
    }));
    const res = await worker.fetch(req("POST", "/import", { body }), env, ctx);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, maxRows: 4 });
    expect(db.entries).toHaveLength(0);
  });

  it("imports { entries, mode } envelope", async () => {
    db.entries.push({
      id: "imp-2",
      content: "old",
      tags: "[]",
      source: "api",
      created_at: 1,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });
    const res = await worker.fetch(
      req("POST", "/import", {
        body: {
          mode: "overwrite",
          extraTags: ["cf-import"],
          entries: [
            {
              id: "imp-2",
              content: "new",
              tags: ["x"],
              source: "import",
              created_at: 2,
            },
          ],
        },
      }),
      env,
      ctx
    );
    const data = (await res.json()) as any;
    expect(data.updated).toBe(1);
    expect(db.entries[0].content).toBe("new");
  });
});
