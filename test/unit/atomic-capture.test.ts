import { describe, expect, it, vi, beforeEach } from "vitest";
import worker, { captureEntry, inspectExtractionQueue, processExtractionQueue } from "../../src/index";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";
import type { D1Mock } from "../helpers/d1-mock";

function makeCtx() {
  const pending: Promise<any>[] = [];
  const ctx = {
    waitUntil: (p: Promise<any>) => {
      pending.push(p);
    },
  } as any as ExecutionContext;
  return {
    ctx,
    drain: async () => {
      await Promise.allSettled(pending);
    },
  };
}

function makeExtractionAI(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") {
        return { data: [new Array(384).fill(0.1)] };
      }
      return new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(`data: {"response":${JSON.stringify(body)}}\n\n`)
          );
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

describe("captureEntry atomic dual-write", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("splits multi-claim input into batch atomic memories with observation provenance", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI({
        facts: [
          {
            content: "用户已完成 Singularity 分类系统。",
            subject: "Singularity",
            predicate: "completed_component",
            object: "分类系统",
            scope_id: "singularity",
            polarity: "positive",
            modality: "confirmed",
            status: "confirmed",
            kind: "episodic",
            memory_class: "milestone",
            importance: 4,
            confidence: 0.92,
            entities: ["Singularity"],
          },
          {
            content: "用户正在研究 Graphiti。",
            kind: "semantic",
            memory_class: "project",
            importance: 3,
            confidence: 0.88,
            entities: ["Graphiti"],
          },
          {
            content: "用户计划下周开始开发 Universe UI。",
            kind: "procedural",
            memory_class: "plan",
            importance: 3,
            confidence: 0.8,
            entities: ["Universe"],
          },
        ],
      }),
    });

    const { ctx, drain } = makeCtx();
    const result = await captureEntry(
      "我完成了分类系统，正在研究 Graphiti，下周准备开始 Universe UI。",
      ["work"],
      "api",
      env,
      ctx
    );
    await drain();

    expect(result.status).toBe("batch");
    if (result.status !== "batch") return;
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.status !== "blocked")).toBe(true);
    expect(db.observations).toHaveLength(1);
    expect(db.observations[0]).toMatchObject({
      extraction_status: "succeeded",
      extraction_attempts: 1,
      needs_reprocess: 0,
    });
    expect(typeof db.observations[0].processed_at).toBe("number");
    expect(db.observations[0]).toMatchObject({
      source_channel: "api",
      author_type: "user",
      revision: 1,
      root_evidence_id: result.observationId,
    });
    expect(db.parentUnits).toHaveLength(1);
    expect(db.parentVersions).toHaveLength(1);
    expect(db.parentVersions[0]).toMatchObject({
      parent_id: result.observationId,
      source_observation_id: result.observationId,
      source_snapshot_hash: db.observations[0].content_hash,
      state: "active",
    });
    expect(db.parentUnits[0]).toMatchObject({
      parent_id: result.observationId,
      active_version_id: db.parentVersions[0].version_id,
    });
    expect(db.memories).toHaveLength(3);
    expect(db.memorySources).toHaveLength(3);
    expect(db.entries).toHaveLength(3);
    expect(db.entries.some((e) => String(e.tags).includes("class:milestone"))).toBe(true);
    expect(db.memories.map((m) => m.memory_class).sort()).toEqual(
      ["milestone", "plan", "project"].sort()
    );
    expect(db.memories.every((memory) => memory.parent_version_id === db.parentVersions[0].version_id)).toBe(true);
    expect(db.memories[0]).toMatchObject({
      claim_subject: "Singularity",
      claim_predicate: "completed_component",
      claim_object: "分类系统",
      scope_id: "singularity",
      polarity: "positive",
      modality: "confirmed",
      claim_status: "supported",
    });
    expect(JSON.parse(db.memories[0].scores_json)).toMatchObject({
      evidenceQuality: 0.92,
      derivationConfidence: 0.92,
      conflictState: "none",
    });
    expect(db.memorySources.every((s) => s.observation_id === result.observationId)).toBe(true);
    expect(db.memorySources.every((s) => s.relation === "supports")).toBe(true);
    expect(db.memorySources.every((s) => s.evidence_root_id === result.observationId)).toBe(true);
  });

  it("falls back to a single dual-written fact when extraction fails", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI("not valid json at all"),
    });
    const { ctx, drain } = makeCtx();
    const result = await captureEntry("单独一条事实，没有逗号拆分需要。", [], "api", env, ctx);
    await drain();
    expect(result.status).not.toBe("batch");
    expect(db.observations).toHaveLength(1);
    expect(db.observations[0]).toMatchObject({
      extraction_status: "fallback",
      extraction_attempts: 1,
      extraction_error: "invalid_extraction",
      needs_reprocess: 1,
    });
    expect(db.entries).toHaveLength(1);
    expect(db.memories).toHaveLength(1);
    expect(db.memorySources).toHaveLength(1);
    expect(db.parentVersions[0]).toMatchObject({
      source_observation_id: db.observations[0].id,
      state: "active_degraded",
    });
  });

  it("marks assistant-origin evidence as assistant instead of user", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI({
        facts: [
          {
            content: "Claude 总结了 Singularity 的 Evidence 设计。",
            kind: "semantic",
            memory_class: "summary",
            importance: 3,
            confidence: 0.86,
          },
        ],
      }),
    });
    const { ctx, drain } = makeCtx();

    const result = await captureEntry("Claude 总结了 Singularity 的 Evidence 设计。", [], "claude", env, ctx);
    await drain();

    expect(result.status).not.toBe("blocked");
    expect(db.observations).toHaveLength(1);
    expect(db.observations[0]).toMatchObject({
      source_channel: "claude",
      author_type: "assistant",
    });
  });

  it("reprocesses fallback observations through the extraction queue", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI("not valid json at all"),
    });

    const firstCtx = makeCtx();
    const first = await captureEntry("先失败成整段，之后应该能拆成两个事实。", ["work"], "api", env, firstCtx.ctx);
    await firstCtx.drain();
    expect(first.status).not.toBe("batch");
    expect(db.observations[0]).toMatchObject({
      extraction_status: "fallback",
      needs_reprocess: 1,
    });
    expect(db.entries).toHaveLength(1);

    env.AI = makeExtractionAI({
      facts: [
        {
          content: "先失败成整段。",
          kind: "episodic",
          memory_class: "event",
          importance: 2,
          confidence: 0.7,
        },
        {
          content: "之后应该能拆成两个事实。",
          kind: "procedural",
          memory_class: "plan",
          importance: 3,
          confidence: 0.8,
        },
      ],
    });

    const secondCtx = makeCtx();
    const queue = await processExtractionQueue(env, secondCtx.ctx, 5);
    await secondCtx.drain();

    expect(queue).toMatchObject({
      processed: 1,
      failed: 0,
      skipped: 0,
      remaining: 0,
    });
    expect(db.observations[0]).toMatchObject({
      extraction_status: "succeeded",
      extraction_attempts: 2,
      needs_reprocess: 0,
    });
    expect(db.entries).toHaveLength(3);
    expect(db.memories).toHaveLength(3);
    expect(new Set(db.memorySources.map((source) => source.observation_id)).size).toBe(1);
    expect(db.parentVersions).toHaveLength(2);
    expect(db.parentVersions.filter((version) => version.state === "active")).toHaveLength(1);
    expect(db.parentVersions.filter((version) => version.state === "superseded")).toHaveLength(1);
    const activeVersion = db.parentVersions.find((version) => version.state === "active");
    expect(db.parentUnits[0].active_version_id).toBe(activeVersion?.version_id);
    expect(db.memories.slice(1).every((memory) => memory.parent_version_id === activeVersion?.version_id)).toBe(true);
  });

  it("scheduled maintenance drains due fallback extraction work", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI("not valid json at all"),
    });

    const firstCtx = makeCtx();
    await captureEntry("定时维护应该重新提炼这条 fallback observation。", ["work"], "api", env, firstCtx.ctx);
    await firstCtx.drain();
    expect(db.observations[0]).toMatchObject({
      extraction_status: "fallback",
      needs_reprocess: 1,
    });

    env.AI = makeExtractionAI({
      facts: [
        {
          content: "定时维护重新提炼 fallback observation。",
          kind: "semantic",
          memory_class: "fact",
          importance: 3,
          confidence: 0.82,
        },
      ],
    });

    const pending: Promise<unknown>[] = [];
    await worker.scheduled({} as any, env, {
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    } as any);
    await Promise.all(pending);

    expect(db.observations[0]).toMatchObject({
      extraction_status: "succeeded",
      needs_reprocess: 0,
    });
    expect(db.parentVersions.filter((version) => version.state === "active")).toHaveLength(1);
  });

  it("dry-runs the extraction queue with orphan and retry breakdowns", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI({ facts: [] }),
    });

    const future = Date.now() + 60_000;
    db.observations.push(
      {
        id: "orphan-pending",
        content: "legacy orphan",
        source: "api",
        metadata_json: "{}",
        extraction_status: "pending",
        extraction_attempts: 0,
        next_attempt_at: null,
        processing_started_at: null,
        extraction_version: 1,
        needs_reprocess: 0,
        created_at: 1,
      },
      {
        id: "sourced-pending",
        content: "pending with source",
        source: "api",
        metadata_json: "{}",
        extraction_status: "pending",
        extraction_attempts: 0,
        next_attempt_at: null,
        processing_started_at: null,
        extraction_version: 1,
        needs_reprocess: 0,
        created_at: 2,
      },
      {
        id: "fallback",
        content: "fallback",
        source: "api",
        metadata_json: "{}",
        extraction_status: "fallback",
        extraction_attempts: 1,
        next_attempt_at: null,
        processing_started_at: null,
        extraction_version: 1,
        needs_reprocess: 1,
        created_at: 3,
      },
      {
        id: "retryable-due",
        content: "retryable due",
        source: "api",
        metadata_json: "{}",
        extraction_status: "retryable_error",
        extraction_attempts: 1,
        next_attempt_at: 0,
        processing_started_at: null,
        extraction_version: 1,
        needs_reprocess: 0,
        created_at: 4,
      },
      {
        id: "partial-error",
        content: "legacy saved but atomic dual-write failed",
        source: "api",
        metadata_json: "{}",
        extraction_status: "partial_error",
        extraction_attempts: 1,
        next_attempt_at: null,
        processing_started_at: null,
        extraction_version: 1,
        needs_reprocess: 1,
        created_at: 4.5,
      },
      {
        id: "retryable-deferred",
        content: "retryable later",
        source: "api",
        metadata_json: "{}",
        extraction_status: "retryable_error",
        extraction_attempts: 1,
        next_attempt_at: future,
        processing_started_at: null,
        extraction_version: 1,
        needs_reprocess: 0,
        created_at: 5,
      },
      {
        id: "stale-processing",
        content: "stale processing",
        source: "api",
        metadata_json: "{}",
        extraction_status: "processing",
        extraction_attempts: 1,
        next_attempt_at: null,
        processing_started_at: 1,
        extraction_version: 1,
        needs_reprocess: 0,
        created_at: 6,
      },
      {
        id: "terminal",
        content: "terminal",
        source: "api",
        metadata_json: "{}",
        extraction_status: "terminal_error",
        extraction_attempts: 3,
        next_attempt_at: null,
        processing_started_at: null,
        extraction_version: 1,
        needs_reprocess: 0,
        created_at: 7,
      }
    );
    db.memorySources.push({
      id: "source",
      memory_id: "memory",
      observation_id: "sourced-pending",
      role: "derived_from",
      score: null,
      created_at: 2,
    });

    const result = await inspectExtractionQueue(env, 5);

    expect(result).toMatchObject({
      dryRun: true,
      limit: 5,
      due: 6,
      deferred: 1,
      exhausted: 1,
      orphanPending: 1,
      fallbackReprocess: 1,
      partialError: 1,
      retryableDue: 1,
      staleProcessing: 1,
    });
  });

  it("marks observations partial_error when atomic dual-write fails after legacy storage", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI({
        facts: [
          {
            content: "Singularity atomic 写入失败也要可修复。",
            kind: "semantic",
            memory_class: "fact",
            importance: 4,
            confidence: 0.9,
          },
        ],
      }),
    });

    const originalBatch = db.batch.bind(db);
    let failedAtomicBatch = false;
    db.batch = vi.fn(async (statements: any[]) => {
      if (!failedAtomicBatch && db.entries.length > 0 && db.memories.length === 0 && statements.length >= 2) {
        failedAtomicBatch = true;
        throw new Error("atomic batch exploded");
      }
      return originalBatch(statements);
    }) as any;

    const ctx = makeCtx();
    const result = await captureEntry(
      "Singularity atomic 写入失败也要可修复。",
      ["work"],
      "api",
      env,
      ctx.ctx
    );
    await ctx.drain();

    expect(result.status).toBe("failed");
    expect(db.entries).toHaveLength(1);
    expect(JSON.parse(db.entries[0].tags)).toContain("status:deprecated");
    expect(db.memories).toHaveLength(0);
    expect(db.parentVersions[0]).toMatchObject({
      state: "failed",
    });
    expect(db.observations).toHaveLength(1);
    expect(db.observations[0]).toMatchObject({
      extraction_status: "partial_error",
      needs_reprocess: 1,
      extraction_error: "atomic batch exploded",
    });

    const queue = await inspectExtractionQueue(env, 5);
    expect(queue).toMatchObject({
      due: 1,
      partialError: 1,
    });
  });

  it("links exact duplicate observations as additional sources instead of dropping them", async () => {
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      }),
      AI: makeExtractionAI({
        facts: [
          {
            content: "Singularity 已经启用四层记忆模型。",
            kind: "semantic",
            memory_class: "fact",
            importance: 4,
            confidence: 0.91,
            entities: ["Singularity"],
          },
        ],
      }),
    });

    const firstCtx = makeCtx();
    const first = await captureEntry(
      "Singularity 已经启用四层记忆模型。",
      ["work"],
      "api",
      env,
      firstCtx.ctx
    );
    await firstCtx.drain();
    expect(first.status).toBe("stored");
    expect(db.entries).toHaveLength(1);
    expect(db.observations).toHaveLength(1);
    expect(db.memories).toHaveLength(1);
    expect(db.memorySources).toHaveLength(1);
    expect(db.parentVersionClaims).toHaveLength(1);

    const secondCtx = makeCtx();
    const second = await captureEntry(
      "Singularity 已经启用四层记忆模型。",
      ["work"],
      "claude-code",
      env,
      secondCtx.ctx
    );
    await secondCtx.drain();

    expect(second.status).toBe("sourced");
    expect(db.entries).toHaveLength(1);
    expect(db.observations).toHaveLength(2);
    expect(db.memories).toHaveLength(1);
    expect(db.memorySources).toHaveLength(2);
    expect(db.parentVersionClaims).toHaveLength(2);
    expect(new Set(db.memorySources.map((source) => source.memory_id)).size).toBe(1);
    expect(new Set(db.memorySources.map((source) => source.observation_id)).size).toBe(2);
    expect(new Set(db.parentVersionClaims.map((claim) => claim.memory_id)).size).toBe(1);
    expect(new Set(db.parentVersionClaims.map((claim) => claim.parent_version_id)).size).toBe(2);
    expect(
      db.parentVersions
        .filter((version) => version.state === "active_degraded")
        .every((version) =>
          db.parentVersionClaims.some((claim) => claim.parent_version_id === version.version_id)
        )
    ).toBe(true);
  });
});
