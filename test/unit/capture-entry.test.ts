import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureEntry } from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

function makeContradictionAI(response: string) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5")
        return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

describe("captureEntry()", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("stores a plain entry and returns status=stored with a UUID id", async () => {
    const { ctx } = makeCtx();
    const result = await captureEntry("My first memory", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    if (result.status !== "stored") return;
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].content).toBe("My first memory");
    expect(db.entries[0].source).toBe("api");
  });

  it("uses the provided source value", async () => {
    const { ctx } = makeCtx();
    await captureEntry("Memory from claude", [], "claude", env, ctx);
    expect(db.entries[0].source).toBe("claude");
  });

  // ── Hashtag extraction ──────────────────────────────────────────────────────

  it("strips hashtags from content and stores them as tags", async () => {
    const { ctx } = makeCtx();
    const result = await captureEntry("went for a run #health #fitness", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    expect(db.entries[0].content).toBe("went for a run");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("health");
    expect(tags).toContain("fitness");
  });

  it("merges explicit tags with hashtag tags and deduplicates case-insensitively", async () => {
    const { ctx } = makeCtx();
    await captureEntry("note #health", ["Health", "fitness"], "api", env, ctx);
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags.filter(t => t === "health")).toHaveLength(1);
    expect(tags).toContain("fitness");
  });

  it("falls back to raw content when input is only hashtags", async () => {
    const { ctx } = makeCtx();
    await captureEntry("#task", [], "api", env, ctx);
    expect(db.entries[0].content).toBe("#task");
    const tags = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("task");
  });

  it("trims leading/trailing whitespace before storing", async () => {
    const { ctx } = makeCtx();
    await captureEntry("  padded note  ", [], "api", env, ctx);
    expect(db.entries[0].content).toBe("padded note");
  });

  // ── Duplicate: exact content hash only ──────────────────────────────────────

  it("links exact content fingerprint matches as new sources without adding entries", async () => {
    const { contentFingerprint } = await import("../../src/index");
    const content = "Exact same fact";
    db.entries.push({
      id: "existing",
      content,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["existing"]',
      recall_count: 0,
      importance_score: 0,
      content_hash: await contentFingerprint(content),
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.99, metadata: { parentId: "existing" } }],
        }),
      }),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry(content, [], "api", env, ctx);
    expect(result.status).toBe("sourced");
    if (result.status !== "sourced") return;
    expect(result.id).toBe("existing");
    expect(db.entries).toHaveLength(1);
    expect(db.observations).toHaveLength(1);
    expect(db.memories).toHaveLength(1);
    expect(db.memorySources).toHaveLength(1);
  });

  it("does not hard-block high vector similarity — still ADD + link", async () => {
    db.entries.push({
      id: "existing",
      content: "Server address is 192.168.1.10",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["existing"]',
      recall_count: 0,
      importance_score: 0,
      content_hash: "other-hash",
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.97, metadata: { parentId: "existing" } }],
        }),
      }),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("Server address is 192.168.1.11", [], "api", env, ctx);
    expect(result.status).not.toBe("blocked");
    expect(db.entries).toHaveLength(2);
    // High similarity should surface a relation or at least store as flagged/linked
    expect(["linked", "flagged", "stored", "contradiction", "contradiction_protected"]).toContain(result.status);
  });

  it("skips embed work when exact hash blocks (no waitUntil vectorize)", async () => {
    const { contentFingerprint } = await import("../../src/index");
    const content = "Exact same fact again";
    db.entries.push({
      id: "existing",
      content,
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["existing"]',
      recall_count: 0,
      importance_score: 0,
      content_hash: await contentFingerprint(content),
    });
    const query = vi.fn().mockResolvedValue({ matches: [] });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query }),
    });
    const pending: Promise<any>[] = [];
    const ctx = { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext;
    await captureEntry(content, [], "api", env, ctx);
    expect(query).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
  });

  // ── Duplicate: flagged ──────────────────────────────────────────────────────

  it("stores an active flagged match as a linked similarity", async () => {
    db.entries.push({
      id: "near", content: "Existing similar note", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: '["near"]', recall_count: 0, importance_score: 0,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "near", score: 0.88, metadata: { parentId: "near" } }],
        }),
      }),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("Similar note", [], "api", env, ctx);
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(result.linkedId).toBe("near");
    expect(result.relation).toBe("similar");
    expect(db.entries).toHaveLength(2);
    const tags: string[] = JSON.parse(db.entries.find(entry => entry.id === result.id)!.tags);
    expect(tags).toContain("duplicate-candidate");
  });

  // ── Contradiction ───────────────────────────────────────────────────────────

  it("returns status=contradiction, stores a new entry, and preserves the conflicting entry", async () => {
    db.entries.push({
      id: "old-entry",
      content: "I live in NYC",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["old-vec-1","old-vec-2"]',
      recall_count: 0,
      importance_score: 0,
    });

    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "old-vec-1", score: 0.72, metadata: { parentId: "old-entry" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeContradictionAI('{"contradicts": true, "conflicting_id": "old-entry", "reason": "different city"}'),
    });

    const { ctx } = makeCtx();
    const result = await captureEntry("I moved to LA", [], "api", env, ctx);

    expect(result.status).toBe("contradiction");
    if (result.status !== "contradiction") return;
    expect(result.conflictId).toBe("old-entry");
    expect(result.reason).toBe("different city");
    expect(typeof result.id).toBe("string");

    // New entry stored
    expect(db.entries.some(e => e.id === result.id)).toBe(true);
    // Conflicting entry remains unchanged and linked for audit.
    const conflictRow = db.entries.find(e => e.id === "old-entry");
    expect(conflictRow).toBeDefined();
    const conflictTags: string[] = JSON.parse(conflictRow!.tags);
    expect(conflictTags).not.toContain("status:deprecated");
    expect(conflictRow!.vector_ids).toBe('["old-vec-1","old-vec-2"]');
    expect(deleteByIdsMock).not.toHaveBeenCalled();
    expect(db.relations).toContainEqual(
      expect.objectContaining({
        from_memory_id: result.id,
        to_memory_id: "old-entry",
        relation_type: "contradicts",
      })
    );
    expect(db.conflictCases).toContainEqual(
      expect.objectContaining({
        old_memory_id: "old-entry",
        new_memory_id: result.id,
        conflict_type: "contradiction",
        reason: "different city",
        state: "pending",
      })
    );
    // The scoring metadata still promotes the newer observation.
    expect(db.entries.find(e => e.id === result.id)!.contradiction_wins).toBe(1);
    expect(conflictRow!.contradiction_losses).toBe(1);
  });

  it("returns status=contradiction_protected when conflicting entry is canonical — keeps canonical, demotes new to draft", async () => {
    db.entries.push({
      id: "canonical-entry",
      content: "I live in NYC",
      tags: '["status:canonical"]',
      source: "api",
      created_at: Date.now(),
      vector_ids: '["canonical-vec-1"]',
      recall_count: 0,
      importance_score: 0,
    });

    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "canonical-vec-1", score: 0.72, metadata: { parentId: "canonical-entry" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeContradictionAI('{"contradicts": true, "conflicting_id": "canonical-entry", "reason": "different city"}'),
    });

    const { ctx } = makeCtx();
    const result = await captureEntry("I moved to LA", [], "api", env, ctx);

    expect(result.status).toBe("contradiction_protected");
    if (result.status !== "contradiction_protected") return;
    expect(result.id).toBeDefined();
    expect(result.canonicalId).toBe("canonical-entry");
    expect(result.reason).toBe("different city");

    // Canonical entry is UNCHANGED
    const canonicalRow = db.entries.find(e => e.id === "canonical-entry");
    expect(canonicalRow).toBeDefined();
    const canonicalTags: string[] = JSON.parse(canonicalRow!.tags);
    expect(canonicalTags).toContain("status:canonical");
    expect(canonicalRow!.vector_ids).toBe('["canonical-vec-1"]');
    // deleteByIds NOT called on canonical vectors
    expect(deleteByIdsMock).not.toHaveBeenCalled();

    // New entry stored as draft
    const newRow = db.entries.find(e => e.id === result.id);
    expect(newRow).toBeDefined();
    const newTags: string[] = JSON.parse(newRow!.tags);
    expect(newTags).toContain("status:draft");
    expect(newTags).not.toContain("contradiction-resolved");
    // Canonical incumbent survived (win); new draft entry recorded the loss.
    expect(canonicalRow!.contradiction_wins).toBe(1);
    expect(newRow!.contradiction_losses).toBe(1);
  });

  it("adds contradiction-resolved tag when contradiction detected", async () => {
    db.entries.push({
      id: "conflict",
      content: "I live in NYC",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["conflict"]',
      recall_count: 0,
      importance_score: 0,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "conflict", score: 0.72, metadata: { parentId: "conflict" } }],
        }),
      }),
      AI: makeContradictionAI('{"contradicts": true, "conflicting_id": "conflict", "reason": "changed location"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I moved to LA", [], "api", env, ctx);
    expect(result.status).toBe("contradiction");
    if (result.status !== "contradiction") return;
    const storedEntry = db.entries.find(e => e.id === result.id);
    const tags: string[] = JSON.parse(storedEntry!.tags);
    expect(tags).toContain("contradiction-resolved");
  });

  // ── Smart merge: replace ────────────────────────────────────────────────────

  it("replace: stores a new entry and links it without rewriting the existing entry", async () => {
    db.entries.push({
      id: "existing", content: "I use VSCode", tags: '["work"]', source: "api",
      created_at: Date.now(), vector_ids: '["existing"]', recall_count: 0, importance_score: 3,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
      }),
      AI: makeContradictionAI('{"action":"replace","target_id":"existing"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I switched to Cursor", [], "api", env, ctx);
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(result.linkedId).toBe("existing");
    expect(result.relation).toBe("supersedes");
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find(entry => entry.id === "existing")!.content).toBe("I use VSCode");
    expect(db.entries.find(entry => entry.id === result.id)!.content).toBe("I switched to Cursor");
    expect(db.mergeCandidates).toContainEqual(
      expect.objectContaining({
        source_memory_id: result.id,
        target_memory_id: "existing",
        suggested_action: "replace",
        state: "pending",
      })
    );
  });

  it("replace: never deletes vectors belonging to the existing entry", async () => {
    db.entries.push({
      id: "existing", content: "I use VSCode", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: '["existing","existing-chunk-1"]', recall_count: 0, importance_score: 0,
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeContradictionAI('{"action":"replace","target_id":"existing"}'),
    });
    const { ctx } = makeCtx();
    await captureEntry("I switched to Cursor", [], "api", env, ctx);
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  it("replace: ignores an orphaned match when target is not found in D1", async () => {
    // Vectorize returns a match but D1 has no corresponding entry
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "ghost-id", score: 0.88, metadata: { parentId: "ghost-id" } }],
        }),
      }),
      AI: makeContradictionAI('{"action":"replace","target_id":"ghost-id"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I switched to Cursor", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    expect(db.entries).toHaveLength(1);
  });

  // ── Smart merge: merge ──────────────────────────────────────────────────────

  it("merge: stores raw new content and links it as a continuation", async () => {
    db.entries.push({
      id: "existing", content: "I prefer dark mode", tags: '["personal"]', source: "api",
      created_at: Date.now(), vector_ids: '["existing"]', recall_count: 0, importance_score: 2,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
      }),
      AI: makeContradictionAI('{"action":"merge","target_id":"existing","merged_content":"I prefer dark mode in all apps, especially at night"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I like dark mode especially at night", [], "api", env, ctx);
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(result.linkedId).toBe("existing");
    expect(result.relation).toBe("continuation_of");
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find(entry => entry.id === "existing")!.content).toBe("I prefer dark mode");
    expect(db.entries.find(entry => entry.id === result.id)!.content).toBe("I like dark mode especially at night");
    expect(db.mergeCandidates).toContainEqual(
      expect.objectContaining({
        source_memory_id: result.id,
        target_memory_id: "existing",
        suggested_action: "merge",
        state: "pending",
      })
    );
  });

  it("merge: embeds the raw new content, not the model-generated rewrite", async () => {
    db.entries.push({
      id: "existing", content: "I prefer dark mode", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: '["existing"]', recall_count: 0, importance_score: 0,
    });
    const insertMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
        insert: insertMock,
      }),
      AI: makeContradictionAI('{"action":"merge","target_id":"existing","merged_content":"Combined merged memory"}'),
    });
    const { ctx, drain } = makeCtx();
    await captureEntry("I like dark mode at night", [], "api", env, ctx);
    await drain();
    const insertedVectors = insertMock.mock.calls[0][0] as any[];
    expect(insertedVectors[0].metadata.content).toBe("I like dark mode at night");
  });

  it("merge: never deletes vectors belonging to the existing entry", async () => {
    db.entries.push({
      id: "existing", content: "I prefer dark mode", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: '["existing","existing-chunk-1"]', recall_count: 0, importance_score: 0,
    });
    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "existing", score: 0.88, metadata: { parentId: "existing" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeContradictionAI('{"action":"merge","target_id":"existing","merged_content":"Combined"}'),
    });
    const { ctx } = makeCtx();
    await captureEntry("I like dark mode at night", [], "api", env, ctx);
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  // ── Smart merge: keep_both becomes an explicit similarity link ──────────────

  it("keep_both: stores new entry with duplicate-candidate tag and similar relation", async () => {
    db.entries.push({
      id: "near", content: "I prefer dark mode", tags: "[]", source: "api",
      created_at: Date.now(), vector_ids: '["near"]', recall_count: 0, importance_score: 0,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "near", score: 0.88, metadata: { parentId: "near" } }],
        }),
      }),
      AI: makeContradictionAI('{"action":"keep_both"}'),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("I like dark themes", [], "api", env, ctx);
    expect(result.status).toBe("linked");
    if (result.status !== "linked") return;
    expect(result.relation).toBe("similar");
    expect(result.linkedId).toBe("near");
    expect(db.entries).toHaveLength(2);
    const tags: string[] = JSON.parse(db.entries[1].tags);
    expect(tags).toContain("duplicate-candidate");
  });

  // ── Importance scoring ──────────────────────────────────────────────────────

  it("schedules importance scoring via ctx.waitUntil for stored entries", async () => {
    env = makeTestEnv(db, {
      AI: makeContradictionAI('{"importance":4,"confidence":0.9,"canonical":false,"kind":"semantic"}'),
    });
    const { ctx, drain } = makeCtx();
    await captureEntry("Important decision", [], "api", env, ctx);
    await drain();
    expect(db.entries[0].importance_score).toBeGreaterThanOrEqual(1);
  });

  // ── Canonical auto-tagging ──────────────────────────────────────────────────

  it("promotes entry to status:canonical when classifyEntry returns canonical:true", async () => {
    function makeSseStream(response: string) {
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }
    env = makeTestEnv(db, {
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5")
            return { data: [new Array(384).fill(0.1)] };
          return makeSseStream('{"importance":5,"confidence":0.95,"canonical":true,"kind":"semantic"}');
        }),
      } as unknown as Ai,
    });
    const { ctx, drain } = makeCtx();
    const result = await captureEntry("I will always prefer TypeScript over JavaScript", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    await drain();
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("status:canonical");
  });

  it("does NOT add status: tag when classifyEntry returns canonical:false", async () => {
    function makeSseStream(response: string) {
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }
    env = makeTestEnv(db, {
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5")
            return { data: [new Array(384).fill(0.1)] };
          return makeSseStream('{"importance":2,"confidence":0.8,"canonical":false,"kind":"episodic"}');
        }),
      } as unknown as Ai,
    });
    const { ctx, drain } = makeCtx();
    const result = await captureEntry("Had a nice lunch today", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    await drain();
    const tags: string[] = JSON.parse(db.entries[0].tags);
    const hasStatusTag = tags.some(t => t.startsWith("status:"));
    expect(hasStatusTag).toBe(false);
  });

  // ── Re-read guard: status:draft blocks canonical auto-promotion ─────────────

  it("does NOT overwrite status:draft with status:canonical when classifier returns canonical:true", async () => {
    // Arrange: a canonical conflicting entry so the new entry is demoted to draft
    // before the async classify promise drains.
    db.entries.push({
      id: "canonical-conflict",
      content: "I live in NYC",
      tags: '["status:canonical"]',
      source: "api",
      created_at: Date.now(),
      vector_ids: '["canonical-vec"]',
      recall_count: 0,
      importance_score: 5,
    });

    // AI always returns canonical:true for the classification call, and the
    // contradiction-check JSON for the smart-merge call.
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "canonical-vec", score: 0.72, metadata: { parentId: "canonical-conflict" } }],
        }),
      }),
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5")
            return { data: [new Array(384).fill(0.1)] };
          // Both the smart-merge/contradiction call and the classify call get this
          // stream. The contradiction handler parses "contradicts/conflicting_id";
          // the classify handler parses "importance/canonical". Returning a JSON
          // object that satisfies both decoders lets a single mock serve both calls.
          return new ReadableStream({
            start(c) {
              const payload = '{"contradicts":true,"conflicting_id":"canonical-conflict","reason":"different city","importance":5,"confidence":0.95,"canonical":true,"kind":"semantic"}';
              c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(payload)}}\n\n`));
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          });
        }),
      } as unknown as Ai,
    });

    const { ctx, drain } = makeCtx();
    const result = await captureEntry("I moved to LA", [], "api", env, ctx);

    // The capture itself must be contradiction_protected — new entry is stored as draft
    expect(result.status).toBe("contradiction_protected");
    if (result.status !== "contradiction_protected") return;

    // Drain all async work including the classify waitUntil
    await drain();

    // Re-read guard: status:draft must be preserved — NOT overwritten to canonical
    const newRow = db.entries.find(e => e.id === result.id);
    expect(newRow).toBeDefined();
    const tags: string[] = JSON.parse(newRow!.tags);
    expect(tags).toContain("status:draft");
    expect(tags).not.toContain("status:canonical");
  });

  // ── Kind auto-tagging ───────────────────────────────────────────────────────

  it("adds kind:episodic tag when classifyEntry returns kind:'episodic'", async () => {
    function makeSseStream(response: string) {
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }
    env = makeTestEnv(db, {
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5")
            return { data: [new Array(384).fill(0.1)] };
          return makeSseStream('{"importance":2,"confidence":0.8,"canonical":false,"kind":"episodic"}');
        }),
      } as unknown as Ai,
    });
    const { ctx, drain } = makeCtx();
    const result = await captureEntry("Went for a run this morning", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    await drain();
    const tags: string[] = JSON.parse(db.entries[0].tags);
    expect(tags).toContain("kind:episodic");
  });

  it("does NOT add any kind: tag when classifyEntry returns kind:null", async () => {
    function makeSseStream(response: string) {
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }
    env = makeTestEnv(db, {
      AI: {
        run: vi.fn().mockImplementation(async (model: string) => {
          if (model === "@cf/baai/bge-small-en-v1.5")
            return { data: [new Array(384).fill(0.1)] };
          return makeSseStream('{"importance":3,"canonical":false}');
        }),
      } as unknown as Ai,
    });
    const { ctx, drain } = makeCtx();
    const result = await captureEntry("Some generic note", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    await drain();
    const tags: string[] = JSON.parse(db.entries[0].tags);
    const hasKindTag = tags.some(t => t.startsWith("kind:"));
    expect(hasKindTag).toBe(false);
  });

  // ── Non-fatal error handling ────────────────────────────────────────────────

  it("stores to D1 and returns stored even when Vectorize insert throws", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        insert: vi.fn().mockRejectedValue(new Error("Vectorize unavailable")),
      }),
    });
    const { ctx } = makeCtx();
    const result = await captureEntry("Note with broken vectorize", [], "api", env, ctx);
    expect(result.status).toBe("stored");
    expect(db.entries).toHaveLength(1);
  });
});
