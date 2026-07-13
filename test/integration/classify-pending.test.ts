import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function unclassifiedEntry(id: string, tags: string[] = ["work"]) {
  return {
    id,
    content: `Content for ${id}`,
    tags: JSON.stringify(tags),
    source: "api",
    created_at: Date.now() - 600000,
    vector_ids: '["v"]',
    recall_count: 0,
    importance_score: 0,
    classification_confidence: null,
    classification_status: "pending",
    classification_error: null,
    classification_attempts: 0,
    classified_at: null,
  };
}

// The shared default AI mock (makeAIMock in make-env.ts) returns a bare "3" with
// no parseable canonical/kind, so classifyEntry yields no signal and no tag gets
// written. That's realistic (ambiguous content stays untagged and gets retried —
// see the "still unclassified" test below) but most of these tests want a
// classifier that actually resolves, so they supply one explicitly.
function makeClassifyingAIMock(result: {
  importance: number;
  canonical: boolean;
  kind: "episodic" | "semantic" | "procedural";
  confidence?: number;
}) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(JSON.stringify({ confidence: 0.5, ...result }))}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as any;
}

function makeDelayedClassificationAI() {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const run = vi.fn().mockImplementation(async (model: string) => {
    if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
    markStarted();
    await gate;
    const result = '{"importance":4,"confidence":0.9,"canonical":false,"kind":"semantic"}';
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(result)}}\n\n`));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  });
  return { ai: { run } as unknown as Ai, run, started, release };
}

describe("POST /classify-pending", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(req("POST", "/classify-pending", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns { processed: 0, failed: 0, remaining: 0 } when nothing is unclassified", async () => {
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("processes unclassified entries, writes tags, and drains remaining to 0", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ confidence: 0.9, importance: 4, canonical: true, kind: "semantic" }) });
    db.entries.push(unclassifiedEntry("e1"), unclassifiedEntry("e2"));
    const first = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(first).toMatchObject({ processed: 1, failed: 0, remaining: 1 });
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(data).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
    for (const id of ["e1", "e2"]) {
      const tags: string[] = JSON.parse(db.entries.find((e: any) => e.id === id).tags);
      expect(tags).toContain("kind:semantic");
      expect(tags).toContain("status:canonical");
      const entry = db.entries.find((e: any) => e.id === id);
      expect(entry.classification_status).toBe("succeeded");
      expect(entry.classification_confidence).toBe(0.9);
      expect(entry.classification_version).toBe(2);
      expect(entry.classification_attempts).toBe(1);
      expect(entry.classification_error).toBeNull();
      expect(entry.classified_at).toEqual(expect.any(Number));
    }
  });

  it("invalidates stale pending vectors after classification metadata changes and rebuild activates", async () => {
    env = makeTestEnv(db, {
      AI: makeClassifyingAIMock({
        confidence: 0.9,
        importance: 4,
        canonical: true,
        kind: "semantic",
      }),
    });
    db.entries.push(
      unclassifiedEntry("needs-classification"),
      {
        id: "recent",
        content: "Recent classified memory",
        tags: JSON.stringify(["work", "kind:semantic"]),
        source: "api",
        created_at: Date.now(),
        vector_ids: '["recent-active"]',
        recall_count: 0,
        importance_score: 0,
        classification_confidence: 0.9,
        classification_status: "succeeded",
        classification_error: null,
        classification_attempts: 1,
        classified_at: Date.now(),
      }
    );

    await worker.fetch(req("POST", "/settings/models/reindex"), env, ctx);
    await worker.fetch(req("POST", "/vectorize-pending"), env, ctx);
    const row = db.entries.find((entry: any) => entry.id === "needs-classification");
    const stalePendingIds = JSON.parse(row.pending_vector_ids);
    expect(stalePendingIds.length).toBeGreaterThan(0);
    expect(row.pending_metadata_hash).toBeTruthy();

    const classifyRes = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const classifyData = await classifyRes.json() as any;

    expect(classifyRes.status).toBe(200);
    expect(classifyData).toMatchObject({ processed: 1, failed: 0 });
    expect(row.pending_vector_ids).toBe("[]");
    expect(row.pending_content_hash).toBeNull();
    expect(row.pending_revision_id).toBeNull();
    expect(row.pending_metadata_hash).toBeNull();
    expect(db.vectorCleanupQueue.map((item: any) => item.vector_id)).toEqual(stalePendingIds);
    expect(db.vectorCleanupQueue.every((item: any) => item.reason === "classification_metadata_changed")).toBe(true);

    const vectorizeRes = await worker.fetch(
      req("POST", "/vectorize-pending", { body: { includeRecent: true } }),
      env,
      ctx
    );
    const vectorizeData = await vectorizeRes.json() as any;

    expect(vectorizeRes.status).toBe(200);
    expect(vectorizeData.mode).toBe("blue_green");
    expect(vectorizeData.repairedPendingGenerations).toBe(0);
    expect(vectorizeData.activated).toBe(2);
    expect(vectorizeData.activationBlocked).toBe(0);
    expect(row.pending_vector_ids).toBeNull();
    expect(row.vector_ids).not.toBe('["v"]');
  });

  it("keeps self-hosted classification batches bounded", async () => {
    env = makeTestEnv(db, {
      AI: makeClassifyingAIMock({ importance: 3, canonical: false, kind: "semantic" }),
      SELFHOST: "1",
    });
    for (let index = 0; index < 20; index++) db.entries.push(unclassifiedEntry(`batch-${index}`));
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(data.processed + data.failed).toBe(14);
    expect(data.remaining).toBe(6);
  });

  it("uses a one-row Cloudflare batch to leave room for cold-start schema and provider queries", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 3, canonical: false, kind: "semantic" }) });
    for (let index = 0; index < 10; index++) db.entries.push(unclassifiedEntry(`cf-batch-${index}`));
    await initializeDatabase(env);
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(data).toMatchObject({ processed: 1, failed: 0, remaining: 9 });
    expect(db.execCount).toBeGreaterThan(0);
    // Cold-start schema now includes atomic memory, Vector V2 profile fields,
    // vector rebuild state, durable cleanup outboxes, metadata guards,
    // fact-source provenance, external object/source links, scoped access tokens,
    // automation rules, regenerable aggregate state, formal schema migration
    // ledger rows, migration checksum verification, vault-bound Obsidian
    // prechecks, unified sync2 etags, quality review queues, and compliance
    // audit event indexes, evidence/claim/provenance contracts, and parent
    // version snapshots, parent-version claim links, and Claim vector mappings;
    // keep a bounded D1 headroom check instead of letting init grow unnoticed.
    expect(db.statementCount).toBeLessThanOrEqual(197);
  });

  it("skips entries whose durable classification status is already succeeded", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ confidence: 0.9, importance: 4, canonical: true, kind: "semantic" }) });
    db.entries.push(
      {
        ...unclassifiedEntry("has-status", ["work", "status:draft"]),
        classification_status: "succeeded",
        classification_version: 2,
        classification_confidence: 0.9,
      },
      {
        ...unclassifiedEntry("has-kind", ["work", "kind:episodic"]),
        classification_status: "succeeded",
        classification_version: 2,
        classification_confidence: 0.9,
      },
    );
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
    // untouched — still exactly the tags they started with
    expect(JSON.parse(db.entries.find((e: any) => e.id === "has-status").tags)).toEqual(["work", "status:draft"]);
    expect(JSON.parse(db.entries.find((e: any) => e.id === "has-kind").tags)).toEqual(["work", "kind:episodic"]);
  });

  it("is resumable: re-running after a full drain is a no-op", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ confidence: 0.9, importance: 4, canonical: true, kind: "semantic" }) });
    db.entries.push(unclassifiedEntry("only-one"));
    await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const res2 = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data2 = await res2.json() as any;
    expect(data2.processed).toBe(0);
    expect(data2.remaining).toBe(0);
  });

  it("marks an inconclusive response failed and leaves it retryable", async () => {
    db.entries.push(unclassifiedEntry("ambiguous"));
    env = makeTestEnv(db, { AI: makeClassifyingAIMock("not json" as any) });
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.failed).toBe(1);
    expect(db.entries.find((e: any) => e.id === "ambiguous")).toMatchObject({
      classification_status: "retryable_error",
      classification_error: "invalid_response",
      classification_attempts: 1,
    });
    expect(data.remaining).toBe(0);
    expect(data.deferred).toBe(1);
  });

  it("retries a failed classification and clears the previous error on success", async () => {
    db.entries.push({
      ...unclassifiedEntry("retry-me"),
      classification_status: "retryable_error",
      classification_error: "provider_error",
      classification_attempts: 1,
      classification_next_attempt_at: Date.now() - 1,
    });
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 4, canonical: false, kind: "semantic" }) });
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
    expect(db.entries.find((e: any) => e.id === "retry-me")).toMatchObject({
      classification_status: "succeeded",
      classification_error: null,
      classification_attempts: 2,
      classification_confidence: 0.5,
    });
  });

  it("does not retry entries that exhausted the classification attempt limit", async () => {
    db.entries.push({
      ...unclassifiedEntry("exhausted"),
      classification_status: "terminal_error",
      classification_error: "provider_error",
      classification_attempts: 3,
    });
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data).toMatchObject({ processed: 0, failed: 0, remaining: 0, exhausted: 1 });
  });

  it("uses the post-claim attempt count when the final retry fails", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock("not json" as any) });
    db.entries.push({
      ...unclassifiedEntry("last-retry"),
      classification_status: "retryable_error",
      classification_attempts: 2,
      classification_next_attempt_at: Date.now() - 1,
    });
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(data.failed).toBe(1);
    expect(db.entries.find((entry: any) => entry.id === "last-retry")).toMatchObject({
      classification_status: "terminal_error",
      classification_attempts: 3,
      classification_next_attempt_at: null,
    });
  });

  it("defers retryable failures until their backoff expires", async () => {
    const ai = makeClassifyingAIMock({ importance: 4, canonical: false, kind: "semantic" });
    env = makeTestEnv(db, { AI: ai });
    db.entries.push({
      ...unclassifiedEntry("deferred"),
      classification_status: "retryable_error",
      classification_attempts: 1,
      classification_next_attempt_at: Date.now() + 60_000,
    });
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(data).toMatchObject({ processed: 0, failed: 0, remaining: 0, deferred: 1 });
    expect((ai as any).run).not.toHaveBeenCalled();
  });

  it("reclaims a processing entry after its lease expires", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 4, canonical: false, kind: "procedural" }) });
    db.entries.push({
      ...unclassifiedEntry("stale-processing"),
      classification_status: "processing",
      classification_attempts: 1,
      classification_started_at: Date.now() - 11 * 60_000,
    });
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(data.processed).toBe(1);
    expect(db.entries.find((entry: any) => entry.id === "stale-processing")).toMatchObject({
      classification_status: "succeeded",
      classification_attempts: 2,
    });
  });

  it("never classifies deprecated memories", async () => {
    const ai = makeClassifyingAIMock({ importance: 4, canonical: false, kind: "semantic" });
    env = makeTestEnv(db, { AI: ai });
    db.entries.push(unclassifiedEntry("deprecated", ["status:deprecated"]));
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(data).toMatchObject({ processed: 0, failed: 0, remaining: 0 });
    expect((ai as any).run).not.toHaveBeenCalled();
  });

  it("does not let a stale classifier overwrite content changed in flight", async () => {
    const delayed = makeDelayedClassificationAI();
    env = makeTestEnv(db, { AI: delayed.ai });
    db.entries.push(unclassifiedEntry("raced"));
    const request = worker.fetch(req("POST", "/classify-pending"), env, ctx);
    await delayed.started;
    const row = db.entries.find((entry: any) => entry.id === "raced");
    Object.assign(row, {
      content: "newer content",
      classification_status: "pending",
      classification_attempts: 0,
      classification_started_at: null,
    });
    delayed.release();
    const data = await (await request).json() as any;
    expect(data.skipped).toBe(1);
    expect(row).toMatchObject({ content: "newer content", classification_status: "pending" });
    expect(JSON.parse(row.tags)).not.toContain("kind:semantic");
  });

  it("atomically claims a row so concurrent workers call the classifier once", async () => {
    const delayed = makeDelayedClassificationAI();
    env = makeTestEnv(db, { AI: delayed.ai });
    db.entries.push(unclassifiedEntry("single-claim"));
    const first = worker.fetch(req("POST", "/classify-pending"), env, ctx);
    await delayed.started;
    const secondData = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(secondData).toMatchObject({ processed: 0, failed: 0, skipped: 0 });
    delayed.release();
    await first;
    expect(delayed.run).toHaveBeenCalledTimes(1);
  });

  it("preserves lifecycle tags changed between classification read and commit", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 4, canonical: false, kind: "semantic" }) });
    db.entries.push(unclassifiedEntry("lifecycle-race"));
    db.beforeClassificationCommit = row => {
      row.tags = JSON.stringify(["status:deprecated"]);
    };
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(data.processed).toBe(1);
    const row = db.entries.find((entry: any) => entry.id === "lifecycle-race");
    expect(JSON.parse(row.tags)).toEqual(expect.arrayContaining(["status:deprecated", "kind:semantic"]));
    expect(row.classification_status).toBe("succeeded");
  });

  it("exhausts a row when repeated tag CAS conflicts reach the attempt limit", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 4, canonical: false, kind: "semantic" }) });
    db.entries.push({ ...unclassifiedEntry("repeated-tag-race"), classification_attempts: 2 });
    let conflicts = 0;
    db.beforeClassificationCommit = row => {
      conflicts += 1;
      row.tags = JSON.stringify(["work", `concurrent-${conflicts}`]);
      return conflicts < 2;
    };

    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    const row = db.entries.find((entry: any) => entry.id === "repeated-tag-race");

    expect(data).toMatchObject({ processed: 0, failed: 1, skipped: 0, exhausted: 1 });
    expect(conflicts).toBe(2);
    expect(row).toMatchObject({
      classification_status: "terminal_error",
      classification_attempts: 3,
      classification_error: "classification_conflict",
      classification_next_attempt_at: null,
    });
  });

  it("promotes canonical status and writes kind for a fully unclassified entry", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ confidence: 0.9, importance: 5, canonical: true, kind: "episodic" }) });
    // A pending row is selected from durable classification state and receives
    // both lifecycle and kind tags on success.
    db.entries.push(unclassifiedEntry("neither", ["work"]));
    await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const neither = JSON.parse(db.entries.find((e: any) => e.id === "neither").tags);
    expect(neither).toContain("status:canonical");
    expect(neither).toContain("kind:episodic");
  });

  it("backfills importance_score together with status and kind", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ confidence: 0.9, importance: 5, canonical: true, kind: "semantic" }) });
    db.entries.push(unclassifiedEntry("importance-check"));
    await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const updated = db.entries.find((e: any) => e.id === "importance-check");
    expect(updated.importance_score).toBe(5);
  });

  it("counts failed and continues when a row can't be updated (e.g. corrupt tags JSON)", async () => {
    // classifyEntry swallows AI-level errors internally (returns a neutral,
    // untagged result), so to exercise this endpoint's own try/catch we force a
    // failure downstream of that call instead: malformed tags JSON blows up
    // JSON.parse inside the handler.
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ confidence: 0.9, importance: 4, canonical: true, kind: "semantic" }) });
    db.entries.push(
      { ...unclassifiedEntry("bad"), tags: "not-json" },
      unclassifiedEntry("good"),
    );
    const first = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(first).toMatchObject({ processed: 0, failed: 1, remaining: 1, deferred: 1 });
    expect(data).toMatchObject({ processed: 1, failed: 0, remaining: 0, deferred: 1 });
    // "bad" is retryable after backoff; "good" succeeded and drops out of the queue.
    expect(data.remaining).toBe(0);
    expect(data.deferred).toBe(1);
  });


  it("does not auto-promote canonical when confidence is below threshold", async () => {
    env = makeTestEnv(db, {
      AI: makeClassifyingAIMock({ importance: 4, confidence: 0.35, canonical: true, kind: "semantic" }),
    });
    db.entries.push(unclassifiedEntry("low-conf-canon"));
    await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const row = db.entries.find((e: any) => e.id === "low-conf-canon");
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("status:draft");
    expect(tags).toContain("canonical-candidate");
    expect(tags).not.toContain("status:canonical");
    expect(tags).toContain("kind:semantic");
    expect(row.classification_confidence).toBe(0.35);
    expect(row.classification_version).toBe(2);
  });

  it("auto-promotes canonical only when confidence meets the threshold", async () => {
    env = makeTestEnv(db, {
      AI: makeClassifyingAIMock({ importance: 5, confidence: 0.85, canonical: true, kind: "semantic" }),
    });
    db.entries.push(unclassifiedEntry("high-conf-canon"));
    await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const tags: string[] = JSON.parse(db.entries.find((e: any) => e.id === "high-conf-canon").tags);
    expect(tags).toContain("status:canonical");
    expect(tags).not.toContain("canonical-candidate");
  });

  it("reclassifies succeeded rows on a stale classification_version", async () => {
    env = makeTestEnv(db, {
      AI: makeClassifyingAIMock({ importance: 4, confidence: 0.9, canonical: false, kind: "procedural" }),
    });
    db.entries.push({
      ...unclassifiedEntry("stale-version", ["work", "kind:semantic", "status:draft"]),
      classification_status: "succeeded",
      classification_confidence: 0.5,
      classification_attempts: 1,
      classification_version: 1,
      classified_at: Date.now() - 10_000,
    });
    const data = await (await worker.fetch(req("POST", "/classify-pending"), env, ctx)).json() as any;
    expect(data.processed).toBe(1);
    const row = db.entries.find((e: any) => e.id === "stale-version");
    expect(row).toMatchObject({
      classification_status: "succeeded",
      classification_version: 2,
      classification_confidence: 0.9,
    });
    expect(JSON.parse(row.tags)).toContain("kind:procedural");
  });

  it("scheduled maintenance drains the classification queue", async () => {
    // Use Workers AI path (not SELFHOST) so the classifying AI mock is reachable.
    // SELFHOST=1 requires external LLM_BASE_URL/API_KEY and would fail open in unit tests.
    env = makeTestEnv(db, {
      AI: makeClassifyingAIMock({ importance: 3, confidence: 0.7, canonical: false, kind: "semantic" }),
    });
    db.entries.push(unclassifiedEntry("cron-1"));
    const pending: Promise<unknown>[] = [];
    const scheduledCtx = {
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    } as any;
    await worker.scheduled({} as any, env, scheduledCtx);
    await Promise.all(pending);
    expect(db.entries.find((e: any) => e.id === "cron-1").classification_status).toBe("succeeded");
    expect(db.entries.find((e: any) => e.id === "cron-1").classification_version).toBe(2);
  });

});
