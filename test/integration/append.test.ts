import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

// Content just over CHUNK_MAX_CHARS (1600) to trigger the full re-embed path
const LONG_CONTENT = "a".repeat(1601);

describe("POST /append", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { addition: "update" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when addition is missing", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { id: "abc" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent id", async () => {
    const res = await worker.fetch(req("POST", "/append", { body: { id: "no-such-id", addition: "update" } }), env, ctx);
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
  });

  it("appends to existing entry", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Original content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
      classification_status: "succeeded",
      classification_confidence: 0.9,
    });
    db.memories.push({
      id: "atomic-old",
      content: "Original content",
      entry_id: "entry-1",
      content_hash: "old-hash",
      valid_to: null,
      invalid_at: null,
      created_at: Date.now(),
    });
    db.entityRelations.push({
      id: "fact-old",
      memory_id: "atomic-old",
      valid_to: null,
      invalid_at: null,
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "New info" } }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(db.entries[0].content).toContain("Original content");
    expect(db.entries[0].content).toContain("New info");
    expect(db.entries[0].classification_status).not.toBe("succeeded");
    expect(db.entries[0].classification_confidence).toBeNull();
    expect(db.revisions).toContainEqual(
      expect.objectContaining({
        memory_id: "entry-1",
        event_type: "APPEND",
        old_content: "Original content",
        new_content: expect.stringContaining("New info"),
      })
    );
    expect(db.memories).toHaveLength(2);
    const oldAtomic = db.memories.find((memory: any) => memory.id === "atomic-old");
    const newAtomic = db.memories.find((memory: any) => memory.id !== "atomic-old");
    expect(oldAtomic.invalid_at).toEqual(expect.any(Number));
    expect(oldAtomic.expired_at).toBe(oldAtomic.invalid_at);
    expect(oldAtomic.valid_to).toBe(oldAtomic.invalid_at);
    expect(db.entityRelations[0].invalid_at).toBe(oldAtomic.invalid_at);
    expect(db.entityRelations[0].expired_at).toBe(oldAtomic.invalid_at);
    expect(newAtomic).toMatchObject({
      entry_id: "entry-1",
      content: expect.stringContaining("New info"),
      invalid_at: null,
      expired_at: null,
    });
    expect(db.observations).toContainEqual(
      expect.objectContaining({
        id: expect.any(String),
        content: expect.stringContaining("New info"),
      })
    );
    expect(db.memorySources).toContainEqual(
      expect.objectContaining({
        memory_id: newAtomic.id,
        observation_id: db.observations[0].id,
      })
    );
  });

  it("returns an error when append succeeds but atomic sync fails", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Original content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });
    const originalBatch = db.batch.bind(db);
    db.batch = vi.fn(async (statements: any[]) => {
      const looksLikeAtomicReplacement =
        statements.length >= 8 &&
        db.entries[0]?.content.includes("New info") &&
        db.revisions.some((revision: any) => revision.event_type === "APPEND");
      if (looksLikeAtomicReplacement) {
        throw new Error("atomic replacement failed");
      }
      return originalBatch(statements);
    }) as any;

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "New info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(503);
    const data = await res.json() as any;
    expect(data).toMatchObject({
      ok: false,
      id: "entry-1",
      error: "atomic_sync_failed",
    });
    expect(db.entries[0].content).toContain("New info");
    expect(db.memories).toHaveLength(0);
  });

  it("retries parent version allocation when another writer claims the next version", async () => {
    const now = Date.now();
    db.entries.push({
      id: "entry-1",
      content: "Original content",
      tags: "[]",
      source: "api",
      created_at: now,
      vector_ids: "[]",
      content_hash: "hash-original",
    });
    const originalBatch = db.batch.bind(db);
    let raced = false;
    db.batch = vi.fn(async (statements: any[]) => {
      const looksLikeAtomicReplacement =
        statements.length >= 8 &&
        db.entries[0]?.content.includes("New info") &&
        db.revisions.some((revision: any) => revision.event_type === "APPEND");
      if (looksLikeAtomicReplacement && !raced) {
        raced = true;
        db.parentVersions.push({
          version_id: "racing-parent-version",
          parent_id: "entry:entry-1",
          version_number: 1,
          source_observation_id: "obs-racing",
          source_snapshot_hash: "hash-racing",
          summary: null,
          state: "active",
          summary_vector_ids: "[]",
          created_at: now,
          updated_at: now,
        });
        throw new Error("UNIQUE constraint failed: sb_parent_versions.parent_id, sb_parent_versions.version_number");
      }
      return originalBatch(statements);
    }) as any;

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "New info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(raced).toBe(true);
    expect(db.parentVersions).toContainEqual(
      expect.objectContaining({
        parent_id: "entry:entry-1",
        version_number: 2,
        state: "active_degraded",
      })
    );
  });

  it("does not globally invalidate a claim still supported by another active parent", async () => {
    const now = Date.now();
    db.entries.push({
      id: "entry-1",
      content: "Shared claim content",
      tags: "[]",
      source: "api",
      created_at: now,
      vector_ids: "[]",
      content_hash: "hash-shared-old",
    });
    db.parentUnits.push(
      {
        parent_id: "parent-entry",
        active_version_id: "pv-entry-old",
        scope_id: null,
        created_at: now - 2000,
        updated_at: now - 1000,
      },
      {
        parent_id: "parent-other",
        active_version_id: "pv-other",
        scope_id: null,
        created_at: now - 2000,
        updated_at: now - 1000,
      }
    );
    db.parentVersions.push(
      {
        version_id: "pv-entry-old",
        parent_id: "parent-entry",
        version_number: 2,
        source_observation_id: "obs-entry-old",
        source_snapshot_hash: "hash-shared-old",
        summary: null,
        state: "active",
        summary_vector_ids: "[]",
        created_at: now - 2000,
        updated_at: now - 1000,
      },
      {
        version_id: "pv-other",
        parent_id: "parent-other",
        version_number: 1,
        source_observation_id: "obs-other",
        source_snapshot_hash: "hash-shared-old",
        summary: null,
        state: "active",
        summary_vector_ids: "[]",
        created_at: now - 2000,
        updated_at: now - 1000,
      }
    );
    db.memories.push({
      id: "shared-claim",
      entry_id: "entry-1",
      content: "Shared claim content",
      content_hash: "hash-shared-old",
      claim_status: "supported",
      confidence: 0.9,
      invalid_at: null,
      expired_at: null,
      created_at: now - 1000,
    });
    db.parentVersionClaims.push(
      {
        parent_version_id: "pv-entry-old",
        memory_id: "shared-claim",
        relation: "supports",
        created_at: now - 1000,
      },
      {
        parent_version_id: "pv-other",
        memory_id: "shared-claim",
        relation: "supports",
        created_at: now - 1000,
      }
    );

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "New local projection" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const sharedClaim = db.memories.find((memory: any) => memory.id === "shared-claim");
    expect(sharedClaim.invalid_at).toBeNull();
    expect(sharedClaim.expired_at).toBeNull();
    expect(db.parentVersions.find((version: any) => version.version_id === "pv-other")?.state).toBe("active");
    expect(db.parentUnits.find((unit: any) => unit.parent_id === "parent-other")?.active_version_id).toBe("pv-other");
    expect(db.observations).toContainEqual(
      expect.objectContaining({
        source: "api",
        source_channel: "api",
        author_type: "user",
        previous_evidence_id: "obs-entry-old",
        revision: 3,
      })
    );
  });

  // ── Short append: append-only path (≤ CHUNK_MAX_CHARS) ──────────────────────

  it("short append: uses a unique update generation and does not delete old vectors", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.entries.push({
      id: "entry-1",
      content: "Short original",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "Small addition" } }),
      env,
      ctx
    );

    // vector_ids should have a new -update- entry appended, not chunk-style IDs
    const vectorIds: string[] = JSON.parse(db.entries[0].vector_ids);
    expect(vectorIds).toHaveLength(2);
    expect(vectorIds[0]).toBe("entry-1");
    expect(vectorIds[1]).toMatch(/^u-[0-9a-f-]{36}$/);
    expect(vectorIds[1].length).toBeLessThanOrEqual(64);
    // Old vectors should NOT be deleted on the short path
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  it("short append during an open rebuild keeps the entry attached by pending_rebuild_id", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Short original",
      tags: "[]",
      source: "api",
      created_at: Date.now() - 600_000,
      vector_ids: '["entry-1"]',
      content_hash: "old-hash",
    });
    const reindex = await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const reindexData = await reindex.json() as any;

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "Small addition" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(db.entries[0].pending_rebuild_id).toBe(reindexData.rebuildId);
    expect(db.entries[0].pending_embedding_fingerprint).toBe(reindexData.pendingFingerprint);
    expect(db.entries[0].pending_vector_ids).toBe("[]");
    expect(db.vectorRebuilds[0].expected_entries).toBe(1);
  });

  // ── Oversized append: full re-embed path (> CHUNK_MAX_CHARS) ────────────────

  it("oversized append: triggers full re-embed and queues old vectors", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1","entry-1-update-111"]',
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);

    // D1 content updated with full combined text
    expect(db.entries[0].content).toContain(LONG_CONTENT);
    expect(db.entries[0].content).toContain("More info");

    // vector_ids updated to chunk-style IDs (not -update- style)
    const vectorIds: string[] = JSON.parse(db.entries[0].vector_ids);
    expect(vectorIds.every((id: string) => !id.includes("-update-"))).toBe(true);
    expect(vectorIds.every((id: string) => id.startsWith("g-"))).toBe(true);
    expect(vectorIds.every((id: string) => id.length <= 64)).toBe(true);

    expect(deleteByIdsMock).not.toHaveBeenCalled();
    expect(db.vectorCleanupQueue.map((row: any) => row.vector_id).sort()).toEqual([
      "entry-1",
      "entry-1-update-111",
    ]);
  });

  it("oversized append: new vectors inserted before old ones are queued for cleanup", async () => {
    const callOrder: string[] = [];
    let contentAtInsert = "";
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockImplementation(async () => {
          contentAtInsert = db.entries[0].content;
          callOrder.push("insert");
          return { mutationId: "m" };
        }),
        deleteByIds: vi.fn().mockImplementation(async () => { callOrder.push("delete"); return { mutationId: "m" }; }),
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(contentAtInsert).toBe(LONG_CONTENT);
    expect(db.entries[0].content).toContain("More info");
    expect(callOrder).toEqual(["insert"]);
    expect(db.vectorCleanupQueue.map((row: any) => row.vector_id)).toEqual(["entry-1"]);
  });

  it("oversized append: preserves old content and vectors when re-embed fails", async () => {
    const insertMock = vi.fn().mockRejectedValue(new Error("Vectorize down"));
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).not.toContain("Vectorize down");
    expect(db.entries[0].content).toBe(LONG_CONTENT);
    expect(db.entries[0].vector_ids).toBe('["entry-1"]');
    expect(db.revisions).toHaveLength(0);
    const preparedIds = (insertMock.mock.calls[0][0] as any[]).map((vector) => vector.id);
    expect(deleteByIdsMock).toHaveBeenCalledWith(preparedIds);
    expect(deleteByIdsMock).not.toHaveBeenCalledWith(["entry-1"]);
  });

  it("oversized append: old vector deletion failure is non-fatal", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("delete failed")),
      }),
    });
    db.entries.push({
      id: "entry-1",
      content: LONG_CONTENT,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["entry-1"]',
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "More info" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it("populates per-tag metadata keys when entry has non-empty tags (short path)", async () => {
    db.entries.push({
      id: "tagged-entry",
      content: "Original",
      tags: '["work","idea"]',
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "tagged-entry", addition: "Short update" } }),
      env, ctx
    );
    expect(res.status).toBe(200);

    // Verify Vectorize.insert was called with tag_* metadata fields
    const insertMock = env.VECTORIZE.insert as ReturnType<typeof import("vitest").vi.fn>;
    const vectors = insertMock.mock.calls[0][0] as any[];
    expect(vectors[0].metadata).toMatchObject({ tag_work: true, tag_idea: true });
  });

  it("returns 500 when appendToEntry throws due to Vectorize failure (short path)", async () => {
    db.entries.push({
      id: "fail-entry",
      content: "Short content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });

    const insertMock = vi.fn().mockRejectedValue(new Error("Vectorize unavailable"));
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const failEnv = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });

    const res = await worker.fetch(
      req("POST", "/append", { body: { id: "fail-entry", addition: "short addition" } }),
      failEnv, ctx
    );
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).not.toContain("Vectorize unavailable");
    expect(db.entries[0].content).toBe("Short content");
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(db.revisions).toHaveLength(0);
    const attemptedId = (insertMock.mock.calls[0][0] as any[])[0].id;
    expect(deleteByIdsMock).toHaveBeenCalledWith([attemptedId]);
  });

  it("short append rejects a stale write without overwriting concurrent content", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Original content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["old-vector"]',
    });
    const insertMock = vi.fn().mockImplementation(async () => {
      db.entries[0].content = "Concurrent content";
      db.entries[0].vector_ids = '["concurrent-vector"]';
      return { mutationId: "insert" };
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });

    const response = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "Stale addition" } }),
      env,
      ctx
    );

    const attemptedId = (insertMock.mock.calls[0][0] as any[])[0].id;
    expect(response.status).toBe(500);
    expect(db.entries[0].content).toBe("Concurrent content");
    expect(db.entries[0].vector_ids).toBe('["concurrent-vector"]');
    expect(db.revisions).toHaveLength(0);
    expect(deleteByIdsMock).toHaveBeenCalledWith([attemptedId]);
    expect(deleteByIdsMock).not.toHaveBeenCalledWith(["concurrent-vector"]);
  });

  it("does not append to a deprecated memory", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Deprecated content",
      tags: '["status:deprecated"]',
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });
    const insertMock = vi.fn();
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ insert: insertMock }),
    });

    const response = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "Must not reactivate" } }),
      env,
      ctx
    );

    expect(response.status).toBe(500);
    expect(db.entries[0].content).toBe("Deprecated content");
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("short append loses the CAS when the memory is deprecated during embedding", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Active content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: "[]",
    });
    const insertMock = vi.fn().mockImplementation(async () => {
      db.entries[0].tags = '["status:deprecated"]';
      db.entries[0].vector_ids = "[]";
      return { mutationId: "insert" };
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ insert: insertMock, deleteByIds: deleteByIdsMock }),
    });

    const response = await worker.fetch(
      req("POST", "/append", { body: { id: "entry-1", addition: "Concurrent addition" } }),
      env,
      ctx
    );

    const attemptedId = (insertMock.mock.calls[0][0] as any[])[0].id;
    expect(response.status).toBe(500);
    expect(db.entries[0].content).toBe("Active content");
    expect(db.entries[0].tags).toBe('["status:deprecated"]');
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(deleteByIdsMock).toHaveBeenCalledWith([attemptedId]);
  });
});
