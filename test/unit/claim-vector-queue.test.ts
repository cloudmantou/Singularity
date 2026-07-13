import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import {
  enqueueMissingClaimVectorJobs,
  getClaimVectorQueueStatus,
  processClaimVectorJobs,
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
});
