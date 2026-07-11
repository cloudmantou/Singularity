import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function seedEntry(db: D1Mock, overrides: Partial<ReturnType<typeof makeEntry>> = {}) {
  const entry = makeEntry(overrides);
  db.entries.push(entry);
  return entry;
}

function makeEntry(overrides: Partial<{
  id: string; content: string; tags: string; source: string;
  created_at: number; vector_ids: string; recall_count: number; importance_score: number;
  classification_status: string; classification_confidence: number | null;
}> = {}) {
  return {
    id: "entry-abc",
    content: "Original content",
    tags: '["work"]',
    source: "api",
    created_at: Date.now(),
    vector_ids: '["entry-abc"]',
    recall_count: 0,
    importance_score: 3,
    classification_status: "succeeded",
    classification_confidence: 0.9,
    ...overrides,
  };
}

describe("POST /update", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "x", content: "new" }, token: null }),
      env, ctx
    );
    expect(res.status).toBe(401);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("returns 400 when id is missing", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { content: "new content" } }),
      env, ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/id/);
  });

  it("returns 400 when content is missing", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc" } }),
      env, ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/content/);
  });

  it("returns 400 when content is blank whitespace", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "   " } }),
      env, ctx
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when entry does not exist", async () => {
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "nonexistent", content: "new content" } }),
      env, ctx
    );
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/nonexistent/);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("updates D1 content and returns ok:true with id", async () => {
    seedEntry(db);
    db.memories.push({
      id: "atomic-old",
      content: "Original content",
      entry_id: "entry-abc",
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
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.id).toBe("entry-abc");
    expect(db.entries[0].content).toBe("Updated content");
    expect(db.entries[0].classification_status).not.toBe("succeeded");
    expect(db.entries[0].classification_confidence).toBeNull();
    expect(db.revisions).toContainEqual(
      expect.objectContaining({
        memory_id: "entry-abc",
        event_type: "UPDATE",
        old_content: "Original content",
        new_content: "Updated content",
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
      entry_id: "entry-abc",
      content: "Updated content",
      invalid_at: null,
      expired_at: null,
    });
    expect(db.memorySources).toContainEqual(
      expect.objectContaining({
        memory_id: newAtomic.id,
        observation_id: db.observations[0].id,
      })
    );
  });

  it("preserves existing tags and source after update", async () => {
    seedEntry(db, { tags: '["work","important"]', source: "claude" });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "New content" } }),
      env, ctx
    );
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("work");
    expect(tags).toContain("important");
    expect(db.entries[0].source).toBe("claude");
  });

  // ── Hashtag merge ───────────────────────────────────────────────────────────

  it("merges new #hashtag from content into tags and strips it from stored content", async () => {
    seedEntry(db, { tags: '["work"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content #newtag" } }),
      env, ctx
    );
    expect(db.entries[0].content).toBe("Updated content");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("work");
    expect(tags).toContain("newtag");
  });

  it("does not duplicate a tag already present when the same #tag appears in content", async () => {
    seedEntry(db, { tags: '["work"]' });
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content #work" } }),
      env, ctx
    );
    expect(db.entries[0].content).toBe("Updated content");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags.filter((t: string) => t === "work")).toHaveLength(1);
  });

  it("calls Vectorize insert (re-embed) with new content", async () => {
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ insert: insertMock }),
    });
    seedEntry(db);
    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Brand new content" } }),
      env, ctx
    );
    expect(insertMock).toHaveBeenCalledOnce();
    const insertedVectors = insertMock.mock.calls[0][0] as any[];
    expect(insertedVectors[0].id).not.toBe("entry-abc");
    expect(insertedVectors[0].id).toMatch(/^g-[0-9a-f-]{36}(?:-chunk-\d+)?$/);
    expect(insertedVectors[0].id.length).toBeLessThanOrEqual(64);
  });

  // ── Vector orphan prevention ────────────────────────────────────────────────

  it("deletes the complete old generation after the new generation is committed", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: '["entry-abc","entry-abc-chunk-1"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env, ctx
    );

    expect(deleteByIdsMock).toHaveBeenCalledOnce();
    expect(deleteByIdsMock.mock.calls[0][0]).toEqual([
      "entry-abc",
      "entry-abc-chunk-1",
    ]);
  });

  it("deletes a single-vector old generation after switching to a unique new id", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: '["entry-abc"]' });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env, ctx
    );

    expect(deleteByIdsMock).toHaveBeenCalledWith(["entry-abc"]);
  });

  it("does not call deleteByIds when vector_ids is empty", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, { vector_ids: "[]" });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated" } }),
      env, ctx
    );

    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  // ── Failure-safe switching ──────────────────────────────────────────────────

  it("returns 503 and preserves the old fact when new vector insertion fails", async () => {
    const insertMock = vi.fn().mockRejectedValue(new Error("Vectorize down"));
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });
    seedEntry(db, { vector_ids: '["entry-abc"]' });
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env, ctx
    );
    expect(res.status).toBe(503);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).not.toContain("Vectorize down");
    expect(db.entries[0].content).toBe("Original content");
    expect(db.entries[0].vector_ids).toBe('["entry-abc"]');
    expect(db.revisions).toHaveLength(0);
    const preparedIds = (insertMock.mock.calls[0][0] as any[]).map((vector) => vector.id);
    expect(deleteByIdsMock).toHaveBeenCalledWith(preparedIds);
    expect(deleteByIdsMock).not.toHaveBeenCalledWith(["entry-abc"]);
  });

  it("returns ok:true even when deleteByIds throws", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        deleteByIds: vi.fn().mockRejectedValue(new Error("Delete failed")),
      }),
    });
    seedEntry(db, { vector_ids: '["entry-abc"]' });
    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env, ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it("clears stale pending vectors and requeues edited content during blue-green rebuild", async () => {
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
    seedEntry(db, {
      vector_ids: '["active-old"]',
      content_hash: "old-content-hash",
    } as any);

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    const pendingFingerprint = db.entries[0].pending_embedding_fingerprint;
    db.entries[0].pending_vector_ids = '["pending-old"]';
    db.entries[0].pending_content_hash = "old-content-hash";

    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(db.entries[0].content).toBe("Updated content");
    expect(db.entries[0].pending_vector_ids).toBe("[]");
    expect(db.entries[0].pending_embedding_fingerprint).toBe(pendingFingerprint);
    expect(db.entries[0].pending_content_hash).toBeNull();
    expect(deleteByIdsMock).toHaveBeenCalledWith(["pending-old"]);
  });

  it("removes the prepared generation when the D1 version switch fails", async () => {
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "insert" });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "delete" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });
    seedEntry(db, { vector_ids: '["old-vector"]' });
    vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("D1 unavailable"));

    const res = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env,
      ctx
    );

    const insertedIds = (insertMock.mock.calls[0][0] as any[]).map((vector) => vector.id);
    expect(res.status).toBe(503);
    expect(db.entries[0].content).toBe("Original content");
    expect(db.entries[0].vector_ids).toBe('["old-vector"]');
    expect(db.revisions).toHaveLength(0);
    expect(deleteByIdsMock).toHaveBeenCalledWith(insertedIds);
    expect(deleteByIdsMock).not.toHaveBeenCalledWith(["old-vector"]);
  });

  it("rejects a stale update instead of overwriting a concurrently committed version", async () => {
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
    seedEntry(db, { vector_ids: '["old-vector"]' });

    const response = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Stale update" } }),
      env,
      ctx
    );

    const preparedIds = (insertMock.mock.calls[0][0] as any[]).map((vector) => vector.id);
    expect(response.status).toBe(503);
    expect(db.entries[0].content).toBe("Concurrent content");
    expect(db.entries[0].vector_ids).toBe('["concurrent-vector"]');
    expect(db.revisions).toHaveLength(0);
    expect(deleteByIdsMock).toHaveBeenCalledWith(preparedIds);
    expect(deleteByIdsMock).not.toHaveBeenCalledWith(["concurrent-vector"]);
  });

  it("adopts a late initial vector generation when the content is still current", async () => {
    const insertMock = vi.fn().mockImplementation(async () => {
      db.entries[0].vector_ids = '["background-vector"]';
      return { mutationId: "insert" };
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });
    seedEntry(db, { vector_ids: "[]" });

    const response = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Updated content" } }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(db.entries[0].content).toBe("Updated content");
    expect(deleteByIdsMock).toHaveBeenCalledWith(["background-vector"]);
  });

  it("does not overwrite a lifecycle status changed while vectors are prepared", async () => {
    const insertMock = vi.fn().mockImplementation(async () => {
      db.entries[0].tags = '["work","status:deprecated"]';
      db.entries[0].vector_ids = "[]";
      return { mutationId: "insert" };
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });
    seedEntry(db, { tags: '["work"]', vector_ids: '["old-vector"]' });

    const response = await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Stale update" } }),
      env,
      ctx
    );

    const preparedIds = (insertMock.mock.calls[0][0] as any[]).map((vector) => vector.id);
    expect(response.status).toBe(503);
    expect(db.entries[0].content).toBe("Original content");
    expect(db.entries[0].tags).toBe('["work","status:deprecated"]');
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(db.revisions).toHaveLength(0);
    expect(deleteByIdsMock).toHaveBeenCalledWith(preparedIds);
  });

  // ── Safe ordering ───────────────────────────────────────────────────────────

  it("inserts the new generation before changing D1 and deletes old vectors last", async () => {
    // Seed entry with known vector_ids
    seedEntry(db, { vector_ids: '["old-vec-1","old-vec-2"]' });

    const callOrder: string[] = [];
    let contentAtInsert = "";
    let vectorIdsAtInsert = "";
    const deleteByIdsMock = vi.fn().mockImplementation(async (ids: string[]) => {
      callOrder.push(`delete:${ids.join(",")}`);
      return { mutationId: "m" };
    });
    const insertMock = vi.fn().mockImplementation(async () => {
      contentAtInsert = db.entries[0].content;
      vectorIdsAtInsert = db.entries[0].vector_ids;
      callOrder.push("insert");
      return { mutationId: "m" };
    });

    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ insert: insertMock, deleteByIds: deleteByIdsMock }),
    });

    await worker.fetch(
      req("POST", "/update", { body: { id: "entry-abc", content: "Replaced content" } }),
      env, ctx
    );

    expect(contentAtInsert).toBe("Original content");
    expect(vectorIdsAtInsert).toBe('["old-vec-1","old-vec-2"]');
    expect(db.entries[0].content).toBe("Replaced content");
    const activeIds: string[] = JSON.parse(db.entries[0].vector_ids);
    expect(activeIds.every((id) => id.startsWith("g-"))).toBe(true);
    expect(activeIds.every((id) => id.length <= 64)).toBe(true);

    // insert must happen before delete — new vectors before old ones removed
    const insertIdx = callOrder.indexOf("insert");
    const deleteIdx = callOrder.findIndex(s => s.startsWith("delete:"));
    expect(insertIdx).toBeLessThan(deleteIdx);
    expect(callOrder[deleteIdx]).toContain("old-vec-1");
    expect(callOrder[deleteIdx]).toContain("old-vec-2");
  });

  it("does not let delayed initial vectorization overwrite a newer update generation", async () => {
    let releaseInitialInsert!: () => void;
    const initialInsertGate = new Promise<void>((resolve) => {
      releaseInitialInsert = resolve;
    });
    const insertMock = vi.fn()
      .mockImplementationOnce(() => initialInsertGate)
      .mockResolvedValue({ mutationId: "update" });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });

    const pending: Promise<unknown>[] = [];
    const captureCtx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as unknown as ExecutionContext;
    const captureResponse = await worker.fetch(
      req("POST", "/capture", { body: { content: "Initial content" } }),
      env,
      captureCtx
    );
    const captureResult = await captureResponse.json() as { id: string };
    await vi.waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));
    const initialIds = (insertMock.mock.calls[0][0] as any[]).map((vector) => vector.id);

    const updateResponse = await worker.fetch(
      req("POST", "/update", {
        body: { id: captureResult.id, content: "Updated before initial vectors completed" },
      }),
      env,
      ctx
    );
    expect(updateResponse.status).toBe(200);
    const committedIds = JSON.parse(db.entries[0].vector_ids) as string[];
    expect(committedIds.every((id) => id.startsWith("g-"))).toBe(true);

    releaseInitialInsert();
    await Promise.allSettled(pending);

    expect(db.entries[0].content).toBe("Updated before initial vectors completed");
    expect(JSON.parse(db.entries[0].vector_ids)).toEqual(committedIds);
    expect(initialIds.every((id) => id.startsWith("g-"))).toBe(true);
    expect(deleteByIdsMock).toHaveBeenCalledWith(initialIds);
    expect(deleteByIdsMock).not.toHaveBeenCalledWith(committedIds);
  });

  it("does not attach delayed initial vectors after an overwrite import changes content", async () => {
    let releaseInitialInsert!: () => void;
    const initialInsertGate = new Promise<void>((resolve) => {
      releaseInitialInsert = resolve;
    });
    const insertMock = vi.fn().mockImplementation(() => initialInsertGate);
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });
    const pending: Promise<unknown>[] = [];
    const captureCtx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as unknown as ExecutionContext;

    const captureResponse = await worker.fetch(
      req("POST", "/capture", { body: { content: "Content before import" } }),
      env,
      captureCtx
    );
    const captureResult = await captureResponse.json() as { id: string };
    await vi.waitFor(() => expect(insertMock).toHaveBeenCalledOnce());
    const initialIds = (insertMock.mock.calls[0][0] as any[]).map((vector) => vector.id);

    db.entries[0].content = "Replacement imported content";
    db.entries[0].vector_ids = "[]";
    releaseInitialInsert();
    await Promise.allSettled(pending);

    expect(db.entries[0].id).toBe(captureResult.id);
    expect(db.entries[0].content).toBe("Replacement imported content");
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(deleteByIdsMock).toHaveBeenCalledWith(initialIds);
  });

  it("does not attach delayed initial vectors after the memory is deprecated", async () => {
    let releaseInitialInsert!: () => void;
    const initialInsertGate = new Promise<void>((resolve) => {
      releaseInitialInsert = resolve;
    });
    const insertMock = vi.fn().mockImplementation(() => initialInsertGate);
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: insertMock,
        deleteByIds: deleteByIdsMock,
      }),
    });
    const pending: Promise<unknown>[] = [];
    const captureCtx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as unknown as ExecutionContext;

    await worker.fetch(
      req("POST", "/capture", { body: { content: "Soon deprecated" } }),
      env,
      captureCtx
    );
    await vi.waitFor(() => expect(insertMock).toHaveBeenCalledOnce());
    const initialIds = (insertMock.mock.calls[0][0] as any[]).map((vector) => vector.id);
    db.entries[0].tags = '["status:deprecated"]';
    db.entries[0].vector_ids = "[]";

    releaseInitialInsert();
    await Promise.allSettled(pending);

    expect(db.entries[0].tags).toBe('["status:deprecated"]');
    expect(db.entries[0].vector_ids).toBe("[]");
    expect(deleteByIdsMock).toHaveBeenCalledWith(initialIds);
  });
});
