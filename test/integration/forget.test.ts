import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("POST /forget", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 400 when body is invalid JSON", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: "{not json",
      }),
      env,
      ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("POST", "/forget", { body: {} }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe("id is required");
  });

  it("returns 404 for non-existent id", async () => {
    const res = await worker.fetch(req("POST", "/forget", { body: { id: "no-such-id" } }), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("deletes an existing entry and queues its vectors for cleanup", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.entries.push({
      id: "entry-1",
      content: "Some content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1","entry-1-update-111"]',
    });
    db.relations.push({
      id: "relation-1",
      from_memory_id: "entry-1",
      to_memory_id: "entry-2",
      relation_type: "updates",
    });
    db.revisions.push({
      id: "revision-1",
      memory_id: "entry-1",
      event_type: "ADD",
    });

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "entry-1" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.id).toBe("entry-1");
    expect(data.deletedVectors).toBe(2);

    expect(db.entries.find((e: any) => e.id === "entry-1")).toBeUndefined();
    expect(db.relations).toHaveLength(0);
    expect(db.revisions).toHaveLength(0);
    expect(deleteByIdsMock).not.toHaveBeenCalled();
    expect(db.vectorCleanupQueue.map((row: any) => row.vector_id).sort()).toEqual([
      "entry-1",
      "entry-1-update-111",
    ]);
  });

  it("trims whitespace from id before lookup", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Some content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "  entry-1  " } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.id).toBe("entry-1");
  });

  it("does not call Vectorize directly when preparing durable cleanup", async () => {
    const deleteByIds = vi.fn().mockRejectedValue(new Error("Vectorize down"));
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds,
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: "Some content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "entry-1" } }), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(db.entries.find((e: any) => e.id === "entry-1")).toBeUndefined();
    expect(db.vectorCleanupQueue.map((row: any) => row.vector_id)).toEqual(["entry-1"]);
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it("also erases derived digests and patterns that may contain the forgotten content", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.entries.push(
      {
        id: "source",
        content: "Private source fact",
        tags: '["work"]',
        source: "api",
        created_at: Date.now(),
        vector_ids: '["source-vector"]',
      },
      {
        id: "digest",
        content: "Digest containing the private source fact",
        tags: '["synthesized","work"]',
        source: "system",
        created_at: Date.now(),
        vector_ids: '["digest-vector"]',
      },
      {
        id: "pattern",
        content: "Pattern inferred from the digest",
        tags: '["auto-pattern","status:draft"]',
        source: "system",
        created_at: Date.now(),
        vector_ids: '["pattern-vector"]',
      },
      {
        id: "other-source",
        content: "Another source retained after digest invalidation",
        tags: '["work","rolled-up"]',
        source: "api",
        created_at: Date.now(),
        vector_ids: '["other-source-vector"]',
      }
    );
    db.relations.push(
      {
        id: "digest-link",
        from_memory_id: "digest",
        to_memory_id: "source",
        relation_type: "digest_of",
      },
      {
        id: "pattern-link",
        from_memory_id: "pattern",
        to_memory_id: "digest",
        relation_type: "derived_from",
      },
      {
        id: "other-digest-link",
        from_memory_id: "digest",
        to_memory_id: "other-source",
        relation_type: "digest_of",
      }
    );
    db.revisions.push(
      { id: "source-rev", memory_id: "source", event_type: "ADD" },
      { id: "digest-rev", memory_id: "digest", event_type: "ADD" },
      { id: "pattern-rev", memory_id: "pattern", event_type: "ADD" },
      { id: "other-rev", memory_id: "other-source", event_type: "ROLLUP" }
    );

    const res = await worker.fetch(
      req("POST", "/forget", { body: { id: "source" } }),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, id: "source", deletedDerived: 2 });
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].id).toBe("other-source");
    expect(JSON.parse(db.entries[0].tags)).not.toContain("rolled-up");
    expect(db.relations).toHaveLength(0);
    expect(db.revisions.every(revision => revision.memory_id === "other-source")).toBe(true);
    expect(db.revisions).toContainEqual(
      expect.objectContaining({ memory_id: "other-source", event_type: "UNROLL" })
    );
    expect(deleteByIdsMock).not.toHaveBeenCalled();
    expect(db.vectorCleanupQueue.map((row: any) => row.vector_id).sort()).toEqual(
      ["digest-vector", "pattern-vector", "source-vector"]
    );
    expect(db.vectorCleanupQueue.map((row: any) => row.vector_id)).not.toContain("other-source-vector");
  });

  it("forgets pending rebuild entries by queuing active and pending vectors and decrementing expected entries", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.vectorRebuilds.push({
      id: "rebuild-1",
      slot: "current",
      state: "building",
      active_fingerprint: "active",
      pending_fingerprint: "pending",
      expected_entries: 1,
      processed_entries: 0,
      failed_entries: 0,
      conflict_entries: 0,
      last_error: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    db.entries.push({
      id: "entry-1",
      content: "Some content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["active-v1"]',
      pending_vector_ids: '["pending-v1"]',
      pending_embedding_fingerprint: "pending",
      pending_content_hash: "hash",
      pending_revision_id: "revision-1",
      pending_rebuild_id: "rebuild-1",
    });

    const res = await worker.fetch(req("POST", "/forget", { body: { id: "entry-1" } }), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(db.entries).toHaveLength(0);
    expect(db.vectorRebuilds[0].expected_entries).toBe(0);
    expect(db.vectorCleanupQueue.map((row: any) => row.vector_id).sort()).toEqual(["active-v1", "pending-v1"]);
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });
});
