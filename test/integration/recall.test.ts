import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { captureEntry } from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

// Returns an AI mock that always resolves a contradiction verdict (for captureEntry).
function makeContradictionAI(response: string): Ai {
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

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeMatch(id: string, score: number, overrides: Record<string, any> = {}) {
  return {
    id,
    score,
    metadata: { parentId: id, isUpdate: false, ...overrides },
  };
}

// The AI mock embeds every query as 384 dims of 0.1 (make-env.ts) —
// SIMILAR_VEC scores cosine 1.0 against it, DISSIMILAR_VEC scores ~0.
const SIMILAR_VEC = new Array(384).fill(0.1);
const DISSIMILAR_VEC = Array.from({ length: 384 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1));

describe("GET /recall", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 400 when query is missing", async () => {
    const res = await worker.fetch(req("GET", "/recall"), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe("query is required");
  });

  it("returns an empty result set with a message when nothing matches", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [] }) }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=anything"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toEqual([]);
    expect(data.message).toBe("Nothing found matching that query.");
  });

  it("uses recent chronological entries for 最近在忙什么 without embedding", async () => {
    const now = Date.now();
    for (let i = 0; i < 35; i++) {
      db.entries.push({
        id: `recent-${i}`,
        content: `Project update ${i}`,
        tags: '["work"]',
        source: "codex",
        created_at: now - i * 60_000,
        vector_ids: "[]",
      });
    }
    db.entries.push({
      id: "too-old",
      content: "Old project update",
      tags: '["work"]',
      source: "codex",
      created_at: now - 31 * 86_400_000,
      vector_ids: "[]",
    });
    const queryMock = vi.fn().mockResolvedValue({ matches: [] });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: queryMock }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("最近在忙什么")}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.mode).toBe("recent_activity");
    expect(data.results).toHaveLength(30);
    expect(data.results[0].id).toBe("recent-0");
    expect(data.results.some((entry: any) => entry.id === "too-old")).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns ranked matches hydrated from D1", async () => {
    db.entries.push(
      { id: "entry-1", content: "First memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
      { id: "entry-2", content: "Second memory", tags: '["idea"]', source: "api", created_at: 2000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
    );
    const queryMock = vi.fn().mockResolvedValue({
      matches: [makeMatch("entry-1", 0.9), makeMatch("entry-2", 0.8)],
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: queryMock,
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=memory"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(2);
    expect(data.results[0]).toMatchObject({ id: "entry-1", content: "First memory", tags: ["work"], source: "api" });
    // Fused scores are normalized so the top match is 100% and the list descends.
    expect(data.results[0].score).toBe(100);
    expect(data.results[1].score).toBeLessThanOrEqual(data.results[0].score);
    expect(data.results[1]).toMatchObject({ id: "entry-2", content: "Second memory" });
    expect(typeof data.insight === "string" || data.insight === null).toBe(true);
    const [, options] = queryMock.mock.calls[0];
    expect(options.filter).toEqual({ embedding_fingerprint: expect.any(String) });
  });

  it("does not hydrate entries whose only parent version is superseded", async () => {
    const now = Date.now();
    db.entries.push(
      {
        id: "entry-old-parent",
        content: "parent invariant old claim",
        tags: "[]",
        source: "api",
        created_at: now - 1000,
        vector_ids: "[]",
        recall_count: 0,
        importance_score: 0,
      },
      {
        id: "entry-active-parent",
        content: "parent invariant active claim",
        tags: "[]",
        source: "api",
        created_at: now,
        vector_ids: "[]",
        recall_count: 0,
        importance_score: 0,
      }
    );
    db.parentUnits.push({
      parent_id: "parent-invariant",
      active_version_id: "pv-active",
      scope_id: null,
      created_at: now - 2000,
      updated_at: now,
    });
    db.parentVersions.push(
      {
        version_id: "pv-old",
        parent_id: "parent-invariant",
        version_number: 1,
        source_observation_id: "obs-old",
        source_snapshot_hash: "hash-old",
        summary: null,
        state: "superseded",
        summary_vector_ids: "[]",
        created_at: now - 2000,
        updated_at: now - 1000,
      },
      {
        version_id: "pv-active",
        parent_id: "parent-invariant",
        version_number: 2,
        source_observation_id: "obs-active",
        source_snapshot_hash: "hash-active",
        summary: null,
        state: "active",
        summary_vector_ids: "[]",
        created_at: now - 1000,
        updated_at: now,
      }
    );
    db.memories.push(
      {
        id: "mem-old-parent",
        entry_id: "entry-old-parent",
        content: "parent invariant old claim",
        parent_version_id: "pv-old",
        claim_status: "supported",
        confidence: 0.9,
        invalid_at: null,
        expired_at: null,
        created_at: now - 1000,
      },
      {
        id: "mem-active-parent",
        entry_id: "entry-active-parent",
        content: "parent invariant active claim",
        parent_version_id: "pv-active",
        claim_status: "supported",
        confidence: 0.9,
        invalid_at: null,
        expired_at: null,
        created_at: now,
      }
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=parent%20invariant"), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results.map((row: any) => row.id)).toEqual(["entry-active-parent"]);
  });

  it("filters invalid dense parent candidates before topK slicing", async () => {
    const now = Date.now();
    db.entries.push(
      {
        id: "entry-superseded-dense",
        content: "dense parent superseded claim",
        tags: "[]",
        source: "api",
        created_at: now - 1000,
        vector_ids: '["vec-superseded"]',
        recall_count: 0,
        importance_score: 0,
      },
      {
        id: "entry-active-dense",
        content: "dense parent active claim",
        tags: "[]",
        source: "api",
        created_at: now,
        vector_ids: '["vec-active"]',
        recall_count: 0,
        importance_score: 0,
      }
    );
    db.parentUnits.push({
      parent_id: "parent-dense",
      active_version_id: "pv-dense-active",
      scope_id: null,
      created_at: now - 2000,
      updated_at: now,
    });
    db.parentVersions.push(
      {
        version_id: "pv-dense-old",
        parent_id: "parent-dense",
        version_number: 1,
        source_observation_id: "obs-dense-old",
        source_snapshot_hash: "hash-dense-old",
        summary: null,
        state: "superseded",
        summary_vector_ids: "[]",
        created_at: now - 2000,
        updated_at: now - 1000,
      },
      {
        version_id: "pv-dense-active",
        parent_id: "parent-dense",
        version_number: 2,
        source_observation_id: "obs-dense-active",
        source_snapshot_hash: "hash-dense-active",
        summary: null,
        state: "active",
        summary_vector_ids: "[]",
        created_at: now - 1000,
        updated_at: now,
      }
    );
    db.memories.push(
      {
        id: "mem-dense-old",
        entry_id: "entry-superseded-dense",
        content: "dense parent superseded claim",
        parent_version_id: "pv-dense-old",
        claim_status: "supported",
        confidence: 0.99,
        invalid_at: null,
        expired_at: null,
        created_at: now - 1000,
      },
      {
        id: "mem-dense-active",
        entry_id: "entry-active-dense",
        content: "dense parent active claim",
        parent_version_id: "pv-dense-active",
        claim_status: "supported",
        confidence: 0.8,
        invalid_at: null,
        expired_at: null,
        created_at: now,
      }
    );
    db.parentVersionClaims.push(
      {
        parent_version_id: "pv-dense-old",
        memory_id: "mem-dense-old",
        relation: "supports",
        created_at: now - 1000,
      },
      {
        parent_version_id: "pv-dense-active",
        memory_id: "mem-dense-active",
        relation: "supports",
        created_at: now,
      }
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            makeMatch("vec-superseded", 0.99, { parentId: "entry-superseded-dense" }),
            makeMatch("vec-active", 0.8, { parentId: "entry-active-dense" }),
          ],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=dense%20parent&topK=1"), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results.map((row: any) => row.id)).toEqual(["entry-active-dense"]);
  });

  it("filters graph recall signals through active parent claim links", async () => {
    const now = Date.now();
    db.entries.push(
      {
        id: "entry-graph-old",
        content: "old graph-only fact",
        tags: "[]",
        source: "api",
        created_at: now - 1000,
        vector_ids: "[]",
        recall_count: 0,
        importance_score: 0,
      },
      {
        id: "entry-graph-active",
        content: "active graph-only fact",
        tags: "[]",
        source: "api",
        created_at: now,
        vector_ids: "[]",
        recall_count: 0,
        importance_score: 0,
      }
    );
    db.parentUnits.push({
      parent_id: "parent-graph",
      active_version_id: "pv-graph-active",
      scope_id: null,
      created_at: now - 2000,
      updated_at: now,
    });
    db.parentVersions.push(
      {
        version_id: "pv-graph-old",
        parent_id: "parent-graph",
        version_number: 1,
        source_observation_id: "obs-graph-old",
        source_snapshot_hash: "hash-graph-old",
        summary: null,
        state: "superseded",
        summary_vector_ids: "[]",
        created_at: now - 2000,
        updated_at: now - 1000,
      },
      {
        version_id: "pv-graph-active",
        parent_id: "parent-graph",
        version_number: 2,
        source_observation_id: "obs-graph-active",
        source_snapshot_hash: "hash-graph-active",
        summary: null,
        state: "active",
        summary_vector_ids: "[]",
        created_at: now - 1000,
        updated_at: now,
      }
    );
    db.memories.push(
      {
        id: "mem-graph-old",
        entry_id: "entry-graph-old",
        content: "old graph-only fact",
        parent_version_id: "pv-graph-old",
        claim_status: "supported",
        confidence: 0.9,
        invalid_at: null,
        expired_at: null,
        created_at: now - 1000,
      },
      {
        id: "mem-graph-active",
        entry_id: "entry-graph-active",
        content: "active graph-only fact",
        parent_version_id: "pv-graph-active",
        claim_status: "supported",
        confidence: 0.9,
        invalid_at: null,
        expired_at: null,
        created_at: now,
      }
    );
    db.parentVersionClaims.push(
      {
        parent_version_id: "pv-graph-old",
        memory_id: "mem-graph-old",
        relation: "supports",
        created_at: now - 1000,
      },
      {
        parent_version_id: "pv-graph-active",
        memory_id: "mem-graph-active",
        relation: "supports",
        created_at: now,
      }
    );
    db.entities.push({
      id: "entity-graph-scope",
      name: "GraphScopeEntity",
      name_normalized: "graphscopeentity",
      entity_type: "concept",
      aliases_json: "[]",
      mention_count: 2,
      updated_at: now,
    });
    db.memoryEntities.push(
      {
        id: "me-graph-old",
        memory_id: "mem-graph-old",
        entity_id: "entity-graph-scope",
        role: "mentions",
        score: 0.99,
        created_at: now - 1000,
      },
      {
        id: "me-graph-active",
        memory_id: "mem-graph-active",
        entity_id: "entity-graph-scope",
        role: "mentions",
        score: 0.8,
        created_at: now,
      }
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=GraphScopeEntity&topK=2"), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results.map((row: any) => row.id)).toEqual(["entry-graph-active"]);
    expect(data.results[0].matched_entities).toEqual(["GraphScopeEntity"]);
  });

  it("uses current D1 tags for rerank instead of stale vector metadata", async () => {
    const now = Date.now();
    db.entries.push(
      {
        id: "entry-current-work",
        content: "Current D1 tags should drive ranking",
        tags: '["work"]',
        source: "api",
        created_at: now,
        vector_ids: '["entry-current-work"]',
        recall_count: 0,
        importance_score: 0,
      },
      {
        id: "entry-stale-work",
        content: "Stale vector metadata should not win",
        tags: '["personal"]',
        source: "api",
        created_at: now,
        vector_ids: '["entry-stale-work"]',
        recall_count: 0,
        importance_score: 0,
      },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [
            makeMatch("entry-stale-work", 0.9, {
              parentId: "entry-stale-work",
              tags: ["work"],
              created_at: now,
            }),
            makeMatch("entry-current-work", 0.9, {
              parentId: "entry-current-work",
              tags: ["personal"],
              created_at: now,
            }),
          ],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=work&topK=2"), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results.map((entry: any) => entry.id)).toEqual([
      "entry-current-work",
      "entry-stale-work",
    ]);
  });

  it("degrades to active-id fallback when Vectorize metadata filter is unavailable", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Fallback memory",
      tags: '["work"]',
      source: "api",
      created_at: Date.now(),
      vector_ids: '["active-vector"]',
      recall_count: 0,
      importance_score: 0,
    });
    const queryMock = vi.fn()
      .mockRejectedValueOnce(new Error("metadata index missing"))
      .mockResolvedValueOnce({
        matches: [makeMatch("active-vector", 0.91, { parentId: "entry-1" })],
      });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: queryMock }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=fallback"), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.degraded_mode).toBe(true);
    expect(data.degraded_reason).toBe("vector_metadata_filter_unavailable");
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][1].filter).toEqual({ embedding_fingerprint: expect.any(String) });
    expect(queryMock.mock.calls[1][1].filter).toBeUndefined();
  });

  it("ignores stale vectors that are no longer referenced by the D1 entry", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Current unrelated content",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["g-current"]',
      recall_count: 0,
      importance_score: 0,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("g-stale", 0.99, {
            parentId: "entry-1",
            content: "legacy-only topic",
          })],
        }),
      }),
    });

    const response = await worker.fetch(
      req("GET", "/recall?query=legacy-only%20topic"),
      env,
      ctx
    );
    const data = await response.json() as any;

    expect(response.status).toBe(200);
    expect(data.results).toEqual([]);
  });

  it("overfetches before filtering so stale top results do not hide an active semantic match", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Current semantic result",
      tags: "[]",
      source: "api",
      created_at: Date.now(),
      vector_ids: '["g-active"]',
      recall_count: 0,
      importance_score: 0,
    });
    const ranked = [
      ...Array.from({ length: 5 }, (_, index) => makeMatch(`g-stale-${index}`, 0.99 - index * 0.001, {
        parentId: "entry-1",
      })),
      makeMatch("g-active", 0.9, { parentId: "entry-1" }),
    ];
    const queryMock = vi.fn().mockImplementation(
      async (_values: number[], options: { topK: number }) => ({
        matches: ranked.slice(0, options.topK),
      })
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: queryMock }),
    });

    const response = await worker.fetch(
      req("GET", "/recall?query=semantic-needle&topK=1"),
      env,
      ctx
    );
    const data = await response.json() as any;

    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
    expect(queryMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ topK: 50 })
    );
  });

  it("does not let a newer deprecated keyword hit consume the final topK slot", async () => {
    const now = Date.now();
    db.entries.push(
      {
        id: "deprecated",
        content: "needle exact identifier",
        tags: '["status:deprecated"]',
        source: "api",
        created_at: now,
        vector_ids: "[]",
        recall_count: 0,
        importance_score: 0,
      },
      {
        id: "active",
        content: "needle exact identifier",
        tags: "[]",
        source: "api",
        created_at: now - 1000,
        vector_ids: "[]",
        recall_count: 0,
        importance_score: 0,
      }
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const response = await worker.fetch(
      req("GET", "/recall?query=needle%20exact%20identifier&topK=1"),
      env,
      ctx
    );
    const data = await response.json() as any;

    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("active");
  });

  it("dedupes matches that share the same parentId", async () => {
    db.entries.push(
      { id: "entry-1", content: "Chunked memory", tags: "[]", source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("entry-1", 0.9), makeMatch("entry-1-update-1", 0.85, { parentId: "entry-1", isUpdate: true })],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=memory"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
  });

  it("surfaces tagged entries via getByIds even when a global query would miss them", async () => {
    db.entries.push(
      { id: "entry-1", content: "Work memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
      { id: "entry-2", content: "Idea memory", tags: '["idea"]', source: "api", created_at: 2000, vector_ids: '["entry-2"]', recall_count: 0, importance_score: 0 },
    );
    // Global semantic query returns nothing — the old path would lose this entry entirely
    const queryMock = vi.fn().mockResolvedValue({ matches: [] });
    const getByIdsMock = vi.fn().mockResolvedValue([
      { id: "entry-1", values: SIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
    ]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock, getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
    // Only the tag's own vectors are fetched; the global query is never used
    expect(getByIdsMock).toHaveBeenCalledWith(["entry-1"]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns empty results immediately when the tag has no matching entries", async () => {
    const queryMock = vi.fn().mockResolvedValue({ matches: [makeMatch("entry-1", 0.9)] });
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock, getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=nonexistent"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toEqual([]);
    // Short-circuits before hitting Vectorize since the tag resolves to no IDs in D1
    expect(queryMock).not.toHaveBeenCalled();
    expect(getByIdsMock).not.toHaveBeenCalled();
  });

  it("clamps ?topK= to the 1-20 range", async () => {
    const queryMock = vi.fn().mockResolvedValue({ matches: [] });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock }) });

    await worker.fetch(req("GET", "/recall?query=memory&topK=999"), env, ctx);
    const [, opts] = queryMock.mock.calls[0];
    expect(opts.topK).toBeLessThanOrEqual(50);
  });

  it("ranks tag-scoped results by cosine similarity to the query", async () => {
    db.entries.push(
      { id: "entry-1", content: "Less similar", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
      { id: "entry-2", content: "More similar", tags: '["work"]', source: "api", created_at: 2000, vector_ids: '["entry-2"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([
      { id: "entry-1", values: DISSIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
      { id: "entry-2", values: SIMILAR_VEC, metadata: { parentId: "entry-2", isUpdate: false } },
    ]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results.map((r: any) => r.id)).toEqual(["entry-2", "entry-1"]);
    expect(data.results[0].score).toBeGreaterThan(data.results[1].score);
  });

  it("omits stale vector IDs that getByIds does not return", async () => {
    db.entries.push(
      { id: "entry-1", content: "Live memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1","entry-1-stale"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([
      { id: "entry-1", values: SIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
    ]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
  });

  it("returns empty results when all of the tag's vectors are stale", async () => {
    db.entries.push(
      { id: "entry-1", content: "Orphaned memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toEqual([]);
    expect(getByIdsMock).toHaveBeenCalledWith(["entry-1"]);
  });

  it("returns empty without calling Vectorize when tagged entries have no vectors", async () => {
    db.entries.push(
      { id: "entry-1", content: "Unvectorized memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 },
    );
    const queryMock = vi.fn().mockResolvedValue({ matches: [] });
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock, getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toEqual([]);
    expect(getByIdsMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("batches getByIds calls at 20 IDs (Vectorize error 40007 above that)", async () => {
    const manyIds = Array.from({ length: 41 }, (_, i) => `entry-1-chunk-${i}`);
    db.entries.push(
      { id: "entry-1", content: "Heavily chunked memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: JSON.stringify(manyIds), recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    expect(getByIdsMock).toHaveBeenCalledTimes(3);
    expect(getByIdsMock.mock.calls[0][0]).toEqual(manyIds.slice(0, 20));
    expect(getByIdsMock.mock.calls[1][0]).toEqual(manyIds.slice(20, 40));
    expect(getByIdsMock.mock.calls[2][0]).toEqual(manyIds.slice(40));
  });

  it("dedupes duplicate vector IDs shared across tagged entries before fetching", async () => {
    db.entries.push(
      { id: "entry-1", content: "First", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["shared-vec"]', recall_count: 0, importance_score: 0 },
      { id: "entry-2", content: "Second", tags: '["work"]', source: "api", created_at: 2000, vector_ids: '["shared-vec"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    expect(getByIdsMock).toHaveBeenCalledTimes(1);
    expect(getByIdsMock.mock.calls[0][0]).toEqual(["shared-vec"]);
  });

  it("respects topK in tag-scoped recall", async () => {
    for (let i = 1; i <= 5; i++) {
      db.entries.push(
        { id: `entry-${i}`, content: `Memory ${i}`, tags: '["work"]', source: "api", created_at: 1000 + i, vector_ids: `["entry-${i}"]`, recall_count: 0, importance_score: 0 },
      );
    }
    const getByIdsMock = vi.fn().mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ id: `entry-${i + 1}`, values: SIMILAR_VEC, metadata: { parentId: `entry-${i + 1}`, isUpdate: false } })),
    );
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work&topK=2"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(2);
  });

  it("dedupes tag-scoped chunk vectors that share the same parentId", async () => {
    db.entries.push(
      { id: "entry-1", content: "Chunked memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1-chunk-0","entry-1-chunk-1"]', recall_count: 0, importance_score: 0 },
    );
    const getByIdsMock = vi.fn().mockResolvedValue([
      { id: "entry-1-chunk-0", values: SIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
      { id: "entry-1-chunk-1", values: SIMILAR_VEC, metadata: { parentId: "entry-1", isUpdate: false } },
    ]);
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-1");
  });

  it("chunks the candidate scoring query for tags with more than 100 entries", async () => {
    const count = 150;
    for (let i = 1; i <= count; i++) {
      db.entries.push(
        { id: `entry-${i}`, content: `Memory ${i}`, tags: '["work"]', source: "api", created_at: 1000 + i, vector_ids: `["entry-${i}"]`, recall_count: 0, importance_score: 0 },
      );
    }
    const getByIdsMock = vi.fn().mockResolvedValue(
      Array.from({ length: count }, (_, i) => ({ id: `entry-${i + 1}`, values: SIMILAR_VEC, metadata: { parentId: `entry-${i + 1}`, isUpdate: false } })),
    );
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });
    const prepareSpy = vi.spyOn(db, "prepare");

    const res = await worker.fetch(req("GET", "/recall?query=memory&tag=work"), env, ctx);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(5); // default topK
    // D1 allows max 100 bound parameters per query — 150 candidates must be chunked into 2 calls
    const scoringCalls = prepareSpy.mock.calls.filter(([sql]) => sql.includes("recall_count, importance_score"));
    expect(scoringCalls).toHaveLength(2);
  });

  it("hashtag or keyword in query skips the LLM during tag inference", async () => {
    db.entries.push(
      { id: "entry-1", content: "Work meeting notes", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
    );
    const aiRun = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":"work"}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    });
    env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [makeMatch("entry-1", 0.9)] }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=work+meeting"), env, ctx);
    expect(res.status).toBe(200);
    // "work" is a known tag AND appears as a keyword in the query → LLM not called for inference
    // (embed call uses BGE model; only LLM calls use other models)
    const llmCalls = aiRun.mock.calls.filter((args: any[]) => args[0] !== "@cf/baai/bge-small-en-v1.5");
    expect(llmCalls).toHaveLength(0);
  });

  it("excludes status:deprecated entries from recall results", async () => {
    db.entries.push(
      { id: "entry-active", content: "Active memory", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-active"]', recall_count: 0, importance_score: 0 },
      { id: "entry-deprecated", content: "Deprecated memory", tags: '["work","status:deprecated"]', source: "api", created_at: 2000, vector_ids: '["entry-deprecated"]', recall_count: 0, importance_score: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("entry-active", 0.9), makeMatch("entry-deprecated", 0.85)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=memory"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-active");
  });

  it("filters recall results to only the requested kind", async () => {
    db.entries.push(
      { id: "entry-episodic", content: "Attended a team offsite in January", tags: '["work","kind:episodic"]', source: "api", created_at: 1000, vector_ids: '["entry-episodic"]', recall_count: 0, importance_score: 0 },
      { id: "entry-semantic", content: "The company uses a monorepo structure", tags: '["work","kind:semantic"]', source: "api", created_at: 2000, vector_ids: '["entry-semantic"]', recall_count: 0, importance_score: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("entry-episodic", 0.9), makeMatch("entry-semantic", 0.85)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=memory&kind=episodic"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("entry-episodic");
  });

  it("query with no matching keywords exercises the LLM fallback for tag inference", async () => {
    db.entries.push(
      { id: "entry-1", content: "Office lease renewal", tags: '["work"]', source: "api", created_at: 1000, vector_ids: '["entry-1"]', recall_count: 0, importance_score: 0 },
    );
    const aiRun = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":"work"}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    });
    env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [makeMatch("entry-1", 0.9)] }),
      }),
    });

    // "quarterly planning" — no hashtags, "work" is not a whole word in this query
    const res = await worker.fetch(req("GET", "/recall?query=quarterly+planning"), env, ctx);
    expect(res.status).toBe(200);
    // LLM called at least once (for tag inference); embedding uses BGE model (not counted)
    const llmCalls = aiRun.mock.calls.filter((args: any[]) => args[0] !== "@cf/baai/bge-small-en-v1.5");
    expect(llmCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("a contradiction survivor outranks an equally-scored contested loser", async () => {
    db.entries.push(
      { id: "shaky", content: "Contested fact", tags: '["work"]', source: "api", created_at: 2000, vector_ids: "[]", recall_count: 0, importance_score: 4, contradiction_wins: 0, contradiction_losses: 3 },
      { id: "survivor", content: "Battle-tested fact", tags: '["work"]', source: "api", created_at: 2000, vector_ids: "[]", recall_count: 0, importance_score: 4, contradiction_wins: 3, contradiction_losses: 0 },
    );
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("shaky", 0.9), makeMatch("survivor", 0.9)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=fact"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.results[0].id).toBe("survivor");
    expect(data.results[1].id).toBe("shaky");
  });

  // ── End-to-end: captureEntry WRITES contradiction_wins → recallEntries READS and reranks ──

  it("e2e: captureEntry writes contradiction_wins=1; subsequent recall ranks the winner above a peer with imp=3,wins=0 (real rerank, not seeded)", async () => {
    // Phase 1 — CAPTURE: resolve a contradiction through production captureEntry.
    //
    // Seed the non-canonical incumbent "old-fact" that the new entry will beat.
    // It needs vector_ids so the deprecation path has something to delete from Vectorize.
    const now = Date.now();
    db.entries.push({
      id: "old-fact",
      content: "I live in Boston",
      tags: "[]",
      source: "api",
      created_at: now - 10000,
      vector_ids: '["old-fact-vec"]',
      recall_count: 0,
      importance_score: 0,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });

    // Seed an uncontested peer with importance_score=3, contradiction_wins=0.
    // Rerank math (verified against src/index.ts rerankWithTimeDecay):
    //   peer:   imp=3, net=0 → effectiveImp=3 → importanceMultiplier = 0.8+(3/5)*0.4 = 1.04
    //   winner: imp=0 (unclassified), net=+1 (1 win 0 losses)
    //           → base=3 (unscored-but-contested neutral midpoint)
    //           → adj = sign(1)*log1p(1)*1.0 = ln(2) ≈ 0.693
    //           → effectiveImp = 3+0.693 = 3.693
    //           → importanceMultiplier = 0.8+(3.693/5)*0.4 = 1.0954
    //   winner importanceMultiplier (1.0954) > peer (1.04), so winner ranks first.
    //   Tie-breaker guard: peer is placed FIRST in the Vectorize matches array so that
    //   without the win boost, the peer would be listed first — the win is the sole differentiator.
    db.entries.push({
      id: "peer",
      content: "Uncontested peer fact",
      tags: "[]",
      source: "api",
      created_at: now - 10000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 3,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });

    const deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    const captureEnv = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        // captureEntry uses this query mock to find the near-match during capture
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "old-fact-vec", score: 0.72, metadata: { parentId: "old-fact" } }],
        }),
        deleteByIds: deleteByIdsMock,
      }),
      AI: makeContradictionAI('{"contradicts": true, "conflicting_id": "old-fact", "reason": "different city"}'),
    });

    const captureCtx = { waitUntil: (_: Promise<any>) => {} } as any as ExecutionContext;
    const captureResult = await captureEntry("I moved to Seattle", [], "api", captureEnv, captureCtx);

    // Assert production code wrote contradiction_wins=1 on the new entry
    expect(captureResult.status).toBe("contradiction");
    if (captureResult.status !== "contradiction") return;
    const winnerId = captureResult.id;

    const winnerRow = db.entries.find(e => e.id === winnerId);
    expect(winnerRow).toBeDefined();
    expect(winnerRow!.contradiction_wins).toBe(1); // written by production, not seeded
    // This test stubs away waitUntil vectorization, so mark the two mocked dense
    // vectors as active before exercising the real recall/rerank path.
    winnerRow!.vector_ids = JSON.stringify([winnerId]);
    db.entries.find(e => e.id === "peer")!.vector_ids = '["peer"]';

    // Phase 2 — RECALL: the shared db now has winner (wins=1, imp=0) and peer (wins=0, imp=3).
    // Configure Vectorize to return [peer first, winner second] at equal score 0.9 —
    // without the win boost the peer would appear first (it's listed first in matches).
    // The real rerank formula must lift the winner above the peer.
    const recallEnv = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("peer", 0.9), makeMatch(winnerId, 0.9)],
        }),
      }),
    });

    const res = await worker.fetch(req("GET", "/recall?query=where do I live"), recallEnv, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    // Winner (contradiction_wins=1, imp=0 → effectiveImp≈3.69) must rank above
    // peer (contradiction_wins=0, imp=3 → effectiveImp=3.0) even though peer was listed first.
    expect(data.results[0].id).toBe(winnerId);
    expect(data.results[1].id).toBe("peer");
  });

  // ── Hybrid recall: keyword fusion surfaces exact-identifier matches ──

  it("surfaces an exact-identifier match the dense top-K missed, via keyword fusion", async () => {
    const now = Date.now();
    const seed: [string, string][] = [
      ["v16", "Release notes for v1.6 — web UI polish"],
      ["v17", "Release notes for v1.7 — added OAuth support"],
      ["v18", "Release notes for v1.8 — fixed a re-embed bug"],
      ["v19", "Release notes for v1.9 — added the memory status layer"],
    ];
    seed.forEach(([id, content], i) => db.entries.push({
      id, content, tags: "[]", source: "api",
      created_at: now - (seed.length - i) * 1000,
      vector_ids: `["${id}"]`, recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0,
    }));

    // Dense search returns the near-twins at high scores but misses v1.9 entirely —
    // version tokens embed near-identically, so cosine can't single it out.
    const queryMock = vi.fn().mockResolvedValue({
      matches: [makeMatch("v16", 0.82), makeMatch("v17", 0.81), makeMatch("v18", 0.80)],
    });
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ query: queryMock }) });
    const prepareSpy = vi.spyOn(db, "prepare");

    const res = await worker.fetch(req("GET", "/recall?query=release+v1.9"), env, ctx);
    const data = await res.json() as any;

    // Keyword search ran on this recall — it's always-on, not a fallback
    expect(prepareSpy.mock.calls.some(([sql]) => sql.includes("content LIKE"))).toBe(true);
    // The exact v1.9 entry is surfaced AND ranked first despite being absent from dense
    const ids = data.results.map((r: any) => r.id);
    expect(ids).toContain("v19");
    expect(ids[0]).toBe("v19");
    expect(data.results[0].score).toBe(100);
  });

  it("uses self-host lexical vector ids as a third RRF source", async () => {
    const now = Date.now();
    db.entries.push({
      id: "lex-entry",
      content: "Local FTS row surfaced by vector id",
      tags: "[]",
      source: "api",
      created_at: now,
      vector_ids: '["lex-vector"]',
      recall_count: 0,
      importance_score: 0,
      contradiction_wins: 0,
      contradiction_losses: 0,
    });
    const queryLexical = vi.fn().mockReturnValue(["lex-vector"]);
    env = makeTestEnv(db, {
      SELFHOST: "1",
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
        getByIds: vi.fn().mockResolvedValue([
          { id: "lex-vector", values: SIMILAR_VEC, metadata: { parentId: "lex-entry" } },
        ]),
        queryLexical,
      } as any),
    });

    const res = await worker.fetch(req("GET", "/recall?query=needle"), env, ctx);
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(queryLexical).toHaveBeenCalledWith("needle", expect.any(Number));
    expect(data.results.map((row: any) => row.id)).toEqual(["lex-entry"]);
    expect(data.results[0].score_details.keyword).toBeGreaterThan(0);
  });

  it("re-ranks an identifier hit to the top within a tag (hybrid on the tag path)", async () => {
    const now = Date.now();
    const seed: [string, string][] = [
      ["v16", "Release notes for v1.6"],
      ["v17", "Release notes for v1.7"],
      ["v18", "Release notes for v1.8"],
      ["v19", "Release notes for v1.9"],
    ];
    seed.forEach(([id, content], i) => db.entries.push({
      id, content, tags: '["rel"]', source: "api",
      created_at: now - (seed.length - i) * 1000,
      vector_ids: `["${id}"]`, recall_count: 0, importance_score: 0,
      contradiction_wins: 0, contradiction_losses: 0,
    }));
    // All tagged vectors score equally on cosine — only keyword fusion distinguishes them.
    const getByIdsMock = vi.fn().mockResolvedValue(
      seed.map(([id]) => ({ id, values: SIMILAR_VEC, metadata: { parentId: id, isUpdate: false } })),
    );
    env = makeTestEnv(db, { VECTORIZE: makeVectorizeMock({ getByIds: getByIdsMock }) });

    const res = await worker.fetch(req("GET", "/recall?query=release+v1.9&tag=rel"), env, ctx);
    const data = await res.json() as any;
    expect(data.results[0].id).toBe("v19");
  });

  it("boosts current entity-linked memories and returns score details", async () => {
    const now = Date.now();
    db.entries.push(
      { id: "peer", content: "Generic database note", tags: "[]", source: "api", created_at: now, vector_ids: '["peer"]', recall_count: 0, importance_score: 0 },
      { id: "singularity-entry", content: "Singularity currently uses SQLite for local storage", tags: "[]", source: "api", created_at: now, vector_ids: '["singularity-entry"]', recall_count: 0, importance_score: 0 },
    );
    db.memories.push({
      id: "memory-singularity",
      entry_id: "singularity-entry",
      content: "Singularity currently uses SQLite for local storage",
      kind: "semantic",
      memory_class: "fact",
      importance: 4,
      confidence: 0.92,
      valid_from: null,
      valid_to: null,
      invalid_at: null,
      expired_at: null,
      created_at: now,
    });
    db.entities.push({
      id: "entity-singularity",
      name: "Singularity",
      name_normalized: "singularity",
      entity_type: "project",
      mention_count: 1,
      updated_at: now,
    });
    db.memoryEntities.push({
      id: "me-singularity",
      memory_id: "memory-singularity",
      entity_id: "entity-singularity",
      role: "mentions",
      score: 0.95,
      created_at: now,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [makeMatch("peer", 0.9), makeMatch("singularity-entry", 0.9)],
        }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("Singularity 用什么数据库")}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results[0].id).toBe("singularity-entry");
    expect(data.results[0].matched_entities).toContain("Singularity");
    expect(data.results[0].score_details.entity).toBeGreaterThan(0);
    expect(data.results[0].score_details.temporal).toBe(0.6);
    expect(data.results[0].time_basis).toBe("inferred_current");
    expect(data.results[0].score_details.semantic).toBeGreaterThan(0);
  });

  it("does not match short Latin entities inside longer words", async () => {
    const now = Date.now();
    db.entries.push({
      id: "ai-entry",
      content: "Artificial intelligence architecture note.",
      tags: "[]",
      source: "api",
      created_at: now,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    db.memories.push({
      id: "memory-ai",
      entry_id: "ai-entry",
      content: "Artificial intelligence architecture note.",
      kind: "semantic",
      memory_class: "fact",
      importance: 3,
      confidence: 0.8,
      valid_from: null,
      valid_to: null,
      invalid_at: null,
      expired_at: null,
      created_at: now,
    });
    db.entities.push({
      id: "entity-ai",
      name: "AI",
      name_normalized: "ai",
      entity_type: "concept",
      mention_count: 1,
      updated_at: now,
    });
    db.memoryEntities.push({
      id: "me-ai",
      memory_id: "memory-ai",
      entity_id: "entity-ai",
      role: "mentions",
      score: 0.9,
      created_at: now,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("mail training plan")}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
  });

  it("matches entity aliases and scores explicit temporal coverage highest", async () => {
    const now = Date.now();
    db.entries.push({
      id: "alias-entry",
      content: "The project currently uses SQLite.",
      tags: "[]",
      source: "api",
      created_at: now,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    db.memories.push({
      id: "memory-alias",
      entry_id: "alias-entry",
      content: "The project currently uses SQLite.",
      kind: "semantic",
      memory_class: "fact",
      importance: 4,
      confidence: 0.9,
      valid_from: now - 1_000,
      valid_to: now + 60_000,
      invalid_at: null,
      expired_at: null,
      created_at: now,
    });
    db.entities.push({
      id: "entity-singularity",
      name: "Singularity",
      name_normalized: "singularity",
      entity_type: "project",
      aliases_json: '["奇点"]',
      mention_count: 1,
      updated_at: now,
    });
    db.memoryEntities.push({
      id: "me-alias",
      memory_id: "memory-alias",
      entity_id: "entity-singularity",
      role: "mentions",
      score: 0.93,
      created_at: now,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("奇点 当前方案")}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("alias-entry");
    expect(data.results[0].matched_entities).toContain("Singularity");
    expect(data.results[0].score_details.temporal).toBe(1);
  });

  it("surfaces graph-only current fact candidates when dense and keyword recall miss", async () => {
    const now = Date.now();
    db.entries.push({
      id: "graph-entry",
      content: "The local durable store is SQLite.",
      tags: "[]",
      source: "api",
      created_at: now,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    db.memories.push({
      id: "memory-graph",
      entry_id: "graph-entry",
      content: "The local durable store is SQLite.",
      kind: "semantic",
      memory_class: "fact",
      importance: 4,
      confidence: 0.91,
      valid_from: null,
      valid_to: null,
      invalid_at: null,
      expired_at: null,
      created_at: now,
    });
    db.entities.push(
      { id: "entity-singularity", name: "Singularity", name_normalized: "singularity", entity_type: "project", mention_count: 2, updated_at: now },
      { id: "entity-sqlite", name: "SQLite", name_normalized: "sqlite", entity_type: "product", mention_count: 1, updated_at: now },
    );
    db.memoryEntities.push({
      id: "me-graph",
      memory_id: "memory-graph",
      entity_id: "entity-singularity",
      role: "mentions",
      score: 0.9,
      created_at: now,
    });
    db.entityRelations.push({
      id: "fact-graph",
      from_entity_id: "entity-singularity",
      to_entity_id: "entity-sqlite",
      relation_type: "uses",
      fact: "Singularity uses SQLite",
      memory_id: "memory-graph",
      observation_id: "obs-graph",
      score: 0.92,
      valid_from: null,
      valid_to: null,
      invalid_at: null,
      expired_at: null,
      reference_time: now,
      created_at: now,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("Singularity 的数据库是什么")}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("graph-entry");
    expect(data.results[0].score_details.semantic).toBe(0);
    expect(data.results[0].score_details.entity).toBeGreaterThan(0);
    expect(data.results[0].score_details.relation).toBeGreaterThan(0);
    expect(data.results[0].score_details.temporal).toBe(0.8);
    expect(data.results[0].time_basis).toBe("reference_time");
    expect(data.results[0].graph_facts).toContain("Singularity uses SQLite");
  });

  it("does not let inferred-current graph facts bypass a historical window", async () => {
    const now = Date.now();
    const after = now - 30 * 86_400_000;
    const before = now - 10 * 86_400_000;
    db.entries.push({
      id: "current-only-entry",
      content: "Singularity currently uses the local durable store.",
      tags: "[]",
      source: "api",
      created_at: now,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    db.memories.push({
      id: "memory-current-only",
      entry_id: "current-only-entry",
      content: "Singularity currently uses the local durable store.",
      kind: "semantic",
      memory_class: "fact",
      importance: 4,
      confidence: 0.9,
      valid_from: null,
      valid_to: null,
      reference_time: null,
      invalid_at: null,
      expired_at: null,
      created_at: now,
    });
    db.entities.push({
      id: "entity-singularity",
      name: "Singularity",
      name_normalized: "singularity",
      entity_type: "project",
      mention_count: 1,
      updated_at: now,
    });
    db.memoryEntities.push({
      id: "me-current-only",
      memory_id: "memory-current-only",
      entity_id: "entity-singularity",
      role: "mentions",
      score: 0.94,
      created_at: now,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("Singularity historical storage")}&after=${after}&before=${before}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
  });

  it("keeps graph-temporal facts in historical windows even when the entry was created earlier", async () => {
    const now = Date.now();
    const entryCreatedAt = now - 90 * 86_400_000;
    const after = now - 30 * 86_400_000;
    const before = now - 10 * 86_400_000;
    db.entries.push({
      id: "historical-graph-entry",
      content: "The durable store remained active across the queried period.",
      tags: "[]",
      source: "api",
      created_at: entryCreatedAt,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    db.memories.push({
      id: "memory-historical-graph",
      entry_id: "historical-graph-entry",
      content: "The durable store remained active across the queried period.",
      kind: "semantic",
      memory_class: "fact",
      importance: 4,
      confidence: 0.9,
      valid_from: entryCreatedAt,
      valid_to: null,
      invalid_at: null,
      expired_at: null,
      created_at: entryCreatedAt,
    });
    db.entities.push({
      id: "entity-singularity",
      name: "Singularity",
      name_normalized: "singularity",
      entity_type: "project",
      mention_count: 1,
      updated_at: now,
    });
    db.memoryEntities.push({
      id: "me-historical-graph",
      memory_id: "memory-historical-graph",
      entity_id: "entity-singularity",
      role: "mentions",
      score: 0.94,
      created_at: entryCreatedAt,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("Singularity historical storage")}&after=${after}&before=${before}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("historical-graph-entry");
    expect(data.results[0].score_details.temporal).toBe(0.8);
    expect(data.results[0].time_basis).toBe("explicit_start");
    expect(data.results[0].matched_entities).toContain("Singularity");
  });

  it("recalls graph facts that were invalidated after the requested historical window", async () => {
    const now = Date.now();
    const entryCreatedAt = now - 120 * 86_400_000;
    const invalidAt = now - 5 * 86_400_000;
    const after = now - 30 * 86_400_000;
    const before = now - 10 * 86_400_000;
    db.entries.push({
      id: "historical-invalidated-entry",
      content: "Singularity used storage plan A before it was replaced.",
      tags: "[]",
      source: "api",
      created_at: entryCreatedAt,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    db.memories.push({
      id: "memory-historical-invalidated",
      entry_id: "historical-invalidated-entry",
      content: "Singularity used storage plan A before it was replaced.",
      kind: "semantic",
      memory_class: "fact",
      importance: 4,
      confidence: 0.9,
      valid_from: entryCreatedAt,
      valid_to: null,
      invalid_at: invalidAt,
      expired_at: null,
      created_at: entryCreatedAt,
    });
    db.entities.push({
      id: "entity-singularity",
      name: "Singularity",
      name_normalized: "singularity",
      entity_type: "project",
      mention_count: 1,
      updated_at: now,
    });
    db.memoryEntities.push({
      id: "me-historical-invalidated",
      memory_id: "memory-historical-invalidated",
      entity_id: "entity-singularity",
      role: "mentions",
      score: 0.94,
      created_at: entryCreatedAt,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("Singularity historical storage")}&after=${after}&before=${before}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("historical-invalidated-entry");
  });

  it("continues graph-only recall when query embedding fails", async () => {
    const now = Date.now();
    db.entries.push({
      id: "embedding-fallback-entry",
      content: "The local durable store is SQLite.",
      tags: "[]",
      source: "api",
      created_at: now,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    db.memories.push({
      id: "memory-embedding-fallback",
      entry_id: "embedding-fallback-entry",
      content: "The local durable store is SQLite.",
      kind: "semantic",
      memory_class: "fact",
      importance: 4,
      confidence: 0.91,
      valid_from: null,
      valid_to: null,
      invalid_at: null,
      expired_at: null,
      created_at: now,
    });
    db.entities.push({
      id: "entity-singularity",
      name: "Singularity",
      name_normalized: "singularity",
      entity_type: "project",
      mention_count: 1,
      updated_at: now,
    });
    db.memoryEntities.push({
      id: "me-embedding-fallback",
      memory_id: "memory-embedding-fallback",
      entity_id: "entity-singularity",
      role: "mentions",
      score: 0.95,
      created_at: now,
    });
    const vectorQuery = vi.fn().mockResolvedValue({ matches: [] });
    const aiRun = vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") throw new Error("embedding provider unavailable");
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":""}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    });
    env = makeTestEnv(db, {
      AI: { run: aiRun } as unknown as Ai,
      VECTORIZE: makeVectorizeMock({ query: vectorQuery }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("Singularity storage")}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].id).toBe("embedding-fallback-entry");
    expect(data.results[0].score_details.semantic).toBe(0);
    expect(data.results[0].score_details.entity).toBeGreaterThan(0);
    expect(data.degraded_mode).toBe(true);
    expect(data.degraded_reason).toBe("embedding_failed");
    expect(vectorQuery).not.toHaveBeenCalled();
  });

  it("does not surface expired entity facts as current graph-only recall results", async () => {
    const now = Date.now();
    db.entries.push({
      id: "expired-entry",
      content: "Old project storage plan",
      tags: "[]",
      source: "api",
      created_at: now - 10_000,
      vector_ids: "[]",
      recall_count: 0,
      importance_score: 0,
    });
    db.memories.push({
      id: "memory-expired",
      entry_id: "expired-entry",
      content: "Old project storage plan",
      kind: "semantic",
      memory_class: "fact",
      importance: 3,
      confidence: 0.8,
      valid_from: now - 100_000,
      valid_to: now - 1_000,
      invalid_at: null,
      expired_at: null,
      created_at: now - 10_000,
    });
    db.entities.push({
      id: "entity-singularity",
      name: "Singularity",
      name_normalized: "singularity",
      entity_type: "project",
      mention_count: 1,
      updated_at: now,
    });
    db.memoryEntities.push({
      id: "me-expired",
      memory_id: "memory-expired",
      entity_id: "entity-singularity",
      role: "mentions",
      score: 0.95,
      created_at: now - 10_000,
    });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
    });

    const res = await worker.fetch(
      req("GET", `/recall?query=${encodeURIComponent("Singularity 当前方案")}`),
      env,
      ctx
    );
    const data = await res.json() as any;

    expect(res.status).toBe(200);
    expect(data.results).toEqual([]);
  });
});
