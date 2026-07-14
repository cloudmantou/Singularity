import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import {
  DEFAULT_CLAIM_VECTOR_LEASE_MS,
  claimVectorActivationBlock,
  enqueueClaimVectorJob,
  enqueueMissingClaimVectorJobs,
  getClaimVectorQueueStatus,
  processClaimVectorJobs,
  reclaimExpiredClaimVectorJobs,
  retryFailedClaimVectorJobs,
} from "../../src/memory/claim-vector-queue";

describe("Claim vector queue", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    await ensureMemoryDataModel(db);
    raw.exec(`CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_hash TEXT
    )`);
    raw.prepare(
      `INSERT INTO entries (id, content, content_hash)
       VALUES ('entry-1', 'historical fact', 'entry-current-hash')`
    ).run();
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, content_hash, root_evidence_id, author_type, created_at
       ) VALUES ('obs-1', 'source fact', 'mcp', 'evidence-hash', 'root-1', 'user', 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
       VALUES ('parent-1', 'parent-v1', 1, 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, state, activated_at, created_at, updated_at
       ) VALUES ('parent-v1', 'parent-1', 1, 'active', 1, 1, 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, parent_version_id, content_hash,
         claim_status, entities_json, created_at
       ) VALUES (
         'claim-1', 'historical fact', 'entry-1', 'parent-v1', 'claim-hash-v1',
         'supported', '[]', 1
       )`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, evidence_root_id, created_at
       ) VALUES ('source-1', 'claim-1', 'obs-1', 'supports', 'supports', 'root-1', 1)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
       VALUES ('parent-v1', 'claim-1', 'supports', 1)`
    ).run();
  });

  afterEach(() => raw.close());

  it("uses a lease long enough for external embedding providers", () => {
    expect(DEFAULT_CLAIM_VECTOR_LEASE_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("reports terminal failures as an explicit activation blocker", () => {
    expect(claimVectorActivationBlock({ terminal_failed: 2 })).toBe("claim_vector_terminal_failures");
    expect(claimVectorActivationBlock({ terminal_failed: 0 })).toBeUndefined();
  });

  it("distinguishes live and expired processing leases", async () => {
    raw.prepare(
      `INSERT INTO sb_claim_vector_jobs (
         id, claim_id, target_fingerprint, content_hash, parent_version_id,
         status, attempts, lease_owner, lease_expires_at, created_at, updated_at
       ) VALUES
         ('job-live', 'claim-1', 'fp-v1', 'claim-hash-v1', 'parent-v1', 'processing', 1, 'lease-live', 2000, 1, 1),
         ('job-expired', 'claim-2', 'fp-v1', 'claim-hash-v1', 'parent-v1', 'processing', 1, 'lease-old', 50, 1, 1)`
    ).run();

    await expect(getClaimVectorQueueStatus(db, "fp-v1", 100)).resolves.toMatchObject({
      processing: 2,
      processing_live: 1,
      processing_expired: 1,
    });
    expect(await reclaimExpiredClaimVectorJobs(db, {
      targetFingerprint: "fp-v1",
      now: 100,
    })).toBe(1);
    expect(await getClaimVectorQueueStatus(db, "fp-v1", 100)).toMatchObject({
      processing: 1,
      processing_live: 1,
      processing_expired: 0,
      retryable_error: 1,
    });
  });

  it("persists retryable jobs and completes only after the Claim mapping is durable", async () => {
    expect(await enqueueMissingClaimVectorJobs(db, {
      targetFingerprint: "fp-v1",
      now: 100,
      limit: 10,
    })).toBe(1);
    expect(await getClaimVectorQueueStatus(db, "fp-v1", 100)).toMatchObject({
      pending: 1,
      missing: 1,
    });

    const failed = await processClaimVectorJobs(db, {
      targetFingerprint: "fp-v1",
      now: 100,
      limit: 10,
      index: async () => {
        throw new Error("embedding unavailable");
      },
    });
    expect(failed).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(await getClaimVectorQueueStatus(db, "fp-v1", 100)).toMatchObject({
      retryable_error: 1,
      missing: 1,
    });

    const retried = await processClaimVectorJobs(db, {
      targetFingerprint: "fp-v1",
      now: 10_000,
      limit: 10,
      index: async (job) => {
        raw.prepare(
          `INSERT INTO sb_claim_vectors (
             claim_id, embedding_fingerprint, parent_version_id,
             content_hash, vector_ids_json, indexed_at
           ) VALUES (?, ?, ?, ?, '["vector-1"]', ?)`
        ).run(
          job.claimId,
          job.targetFingerprint,
          job.parentVersionId,
          job.contentHash,
          10_000
        );
      },
    });
    expect(retried).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await getClaimVectorQueueStatus(db, "fp-v1", 10_000)).toMatchObject({
      succeeded: 1,
      missing: 0,
    });

    raw.prepare(
      `UPDATE sb_memories SET content = 'changed fact', content_hash = 'claim-hash-v2'
       WHERE id = 'claim-1'`
    ).run();
    expect(await enqueueMissingClaimVectorJobs(db, {
      targetFingerprint: "fp-v1",
      now: 20_000,
      limit: 10,
    })).toBe(1);
    expect(await getClaimVectorQueueStatus(db, "fp-v1", 20_000)).toMatchObject({
      pending: 1,
      missing: 1,
    });
  });

  it("keeps failed jobs terminal until an operator explicitly retries them", async () => {
    await enqueueClaimVectorJob(db, { claimId: "claim-1", targetFingerprint: "fp-v1", now: 100 });
    raw.prepare(
      `UPDATE sb_claim_vector_jobs
       SET status = 'failed', attempts = 6, last_error = 'terminal'
       WHERE claim_id = 'claim-1' AND target_fingerprint = 'fp-v1'`
    ).run();

    expect(await enqueueMissingClaimVectorJobs(db, {
      targetFingerprint: "fp-v1",
      now: 200,
      limit: 10,
    })).toBe(0);
    expect(raw.prepare(
      `SELECT status, attempts, last_error FROM sb_claim_vector_jobs
       WHERE claim_id = 'claim-1' AND target_fingerprint = 'fp-v1'`
    ).get()).toEqual({ status: "failed", attempts: 6, last_error: "terminal" });
    expect(await getClaimVectorQueueStatus(db, "fp-v1", 200)).toMatchObject({
      missing: 1,
      missing_retryable: 0,
      terminal_failed: 1,
    });

    expect(await retryFailedClaimVectorJobs(db, {
      targetFingerprint: "fp-v1",
      now: 300,
      limit: 10,
    })).toBe(1);
    expect(raw.prepare(
      `SELECT status, attempts, last_error FROM sb_claim_vector_jobs
       WHERE claim_id = 'claim-1' AND target_fingerprint = 'fp-v1'`
    ).get()).toEqual({ status: "pending", attempts: 0, last_error: null });
  });

  it("skips terminal failed Claims so later missing Claims are not starved", async () => {
    await enqueueClaimVectorJob(db, { claimId: "claim-1", targetFingerprint: "fp-v1", now: 100 });
    raw.prepare(
      `UPDATE sb_claim_vector_jobs
       SET status = 'failed', attempts = 6, last_error = 'terminal'
       WHERE claim_id = 'claim-1' AND target_fingerprint = 'fp-v1'`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, parent_version_id, content_hash,
         claim_status, entities_json, created_at
       ) VALUES ('claim-2', 'later fact', 'entry-1', 'parent-v1', 'claim-hash-v2',
                 'supported', '[]', 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, evidence_root_id, created_at
       ) VALUES ('source-2', 'claim-2', 'obs-1', 'supports', 'supports', 'root-1', 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
       VALUES ('parent-v1', 'claim-2', 'supports', 2)`
    ).run();

    expect(await enqueueMissingClaimVectorJobs(db, {
      targetFingerprint: "fp-v1",
      now: 200,
      limit: 1,
    })).toBe(1);
    expect(raw.prepare(
      `SELECT claim_id, status FROM sb_claim_vector_jobs
       WHERE target_fingerprint = 'fp-v1' ORDER BY claim_id`
    ).all()).toEqual([
      { claim_id: "claim-1", status: "failed" },
      { claim_id: "claim-2", status: "pending" },
    ]);
    expect(await getClaimVectorQueueStatus(db, "fp-v1", 200)).toMatchObject({
      missing: 2,
      missing_retryable: 1,
      terminal_failed: 1,
    });
  });

  it("rechecks Claim eligibility after leasing and refuses to index an unsupported Claim", async () => {
    await enqueueClaimVectorJob(db, { claimId: "claim-1", targetFingerprint: "fp-v1", now: 100 });
    raw.prepare(`UPDATE sb_memories SET claim_status = 'unsupported' WHERE id = 'claim-1'`).run();
    let indexCalls = 0;

    const result = await processClaimVectorJobs(db, {
      targetFingerprint: "fp-v1",
      now: 200,
      index: async () => { indexCalls += 1; },
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(indexCalls).toBe(0);
    expect(raw.prepare(
      `SELECT status, last_error FROM sb_claim_vector_jobs
       WHERE claim_id = 'claim-1' AND target_fingerprint = 'fp-v1'`
    ).get()).toEqual({ status: "failed", last_error: "claim_snapshot_ineligible_or_changed" });
  });
});
