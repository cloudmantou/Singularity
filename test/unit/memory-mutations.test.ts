import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginMemoryMutation,
  markMemoryMutationEntryCommitted,
  markMemoryMutationFailed,
  markMemoryMutationProjectionResult,
  prepareMemoryMutationKnowledgeCommit,
  stageMemoryMutationEntryIntent,
  stageMemoryMutationKnowledgeIntent,
  MEMORY_MUTATION_SCHEMA_STATEMENTS,
} from "../../src/memory/mutations";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("memory mutation lifecycle", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    for (const statement of MEMORY_MUTATION_SCHEMA_STATEMENTS) await db.exec(statement);
    await db.exec(`
      CREATE TABLE entries (id TEXT PRIMARY KEY, content TEXT, content_hash TEXT);
      CREATE TABLE sb_observations (id TEXT PRIMARY KEY);
      CREATE TABLE sb_memories (id TEXT PRIMARY KEY, entry_id TEXT, content_hash TEXT);
      CREATE TABLE sb_memory_sources (memory_id TEXT, observation_id TEXT);
      CREATE TABLE sb_parent_version_claims (
        memory_id TEXT, parent_version_id TEXT, relation TEXT
      );
      CREATE TABLE sb_parent_versions (
        version_id TEXT PRIMARY KEY, parent_id TEXT, state TEXT
      );
      CREATE TABLE sb_parent_units (parent_id TEXT PRIMARY KEY, active_version_id TEXT);
    `);
  });

  afterEach(() => raw.close());

  it("detects payload conflicts and resumes from the last committed stage", async () => {
    const started = await beginMemoryMutation(db, {
      idempotencyKey: "request-1",
      sourceChannel: "api",
      operation: "append",
      entryId: "entry-1",
      requestHash: "request-hash",
      now: 100,
    });
    expect(started.status).toBe("started");
    expect(started.mutation.state).toBe("preparing");

    expect(await markMemoryMutationEntryCommitted(db, {
      mutationId: started.mutation.mutationId,
      leaseOwner: started.leaseOwner!,
      resultContent: "updated content",
      resultContentHash: "content-hash",
      resultVectorCount: 2,
      now: 110,
    })).toBe(true);
    raw.prepare(
      "INSERT INTO entries (id, content, content_hash) VALUES (?, ?, ?)"
    ).run("entry-1", "updated content", "content-hash");
    await markMemoryMutationFailed(db, {
      mutationId: started.mutation.mutationId,
      leaseOwner: started.leaseOwner!,
      error: "atomic_sync_failed",
      now: 120,
    });

    const resumed = await beginMemoryMutation(db, {
      idempotencyKey: "request-1",
      sourceChannel: "api",
      operation: "append",
      entryId: "entry-1",
      requestHash: "request-hash",
      now: 130,
    });
    expect(resumed.status).toBe("resumed");
    expect(resumed.mutation).toMatchObject({
      state: "entry_committed",
      resultContent: "updated content",
      resultVectorCount: 2,
    });

    const conflict = await beginMemoryMutation(db, {
      idempotencyKey: "request-1",
      sourceChannel: "api",
      operation: "append",
      entryId: "entry-1",
      requestHash: "different-request",
      now: 140,
    });
    expect(conflict.status).toBe("conflict");
  });

  it("bounds persisted failure details", async () => {
    const started = await beginMemoryMutation(db, {
      idempotencyKey: "request-error",
      sourceChannel: "api",
      operation: "append",
      entryId: "entry-error",
      requestHash: "request-hash-error",
      now: 150,
    });

    await markMemoryMutationFailed(db, {
      mutationId: started.mutation.mutationId,
      leaseOwner: started.leaseOwner!,
      error: `  ${"sensitive-provider-payload".repeat(40)}  `,
      now: 160,
    });

    const row = raw.prepare(
      "SELECT last_error FROM sb_memory_mutations WHERE mutation_id = ?"
    ).get(started.mutation.mutationId) as { last_error: string };
    expect(row.last_error).toHaveLength(500);
    expect(row.last_error.startsWith("sensitive-provider-payload")).toBe(true);
  });

  it("recovers entry and knowledge stages from persisted intents", async () => {
    raw.prepare(
      "INSERT INTO entries (id, content, content_hash) VALUES (?, ?, ?)"
    ).run("entry-recovery", "old content", "old-hash");
    const started = await beginMemoryMutation(db, {
      idempotencyKey: "request-recovery",
      sourceChannel: "api",
      operation: "update",
      entryId: "entry-recovery",
      requestHash: "request-hash-recovery",
      now: 2_000,
    });
    expect(await stageMemoryMutationEntryIntent(db, {
      mutationId: started.mutation.mutationId,
      leaseOwner: started.leaseOwner!,
      resultContent: "new content",
      resultContentHash: "new-hash",
      resultVectorCount: 1,
      now: 2_010,
    })).toBe(true);
    await markMemoryMutationFailed(db, {
      mutationId: started.mutation.mutationId,
      leaseOwner: started.leaseOwner!,
      error: "before_entry_commit",
      now: 2_020,
    });

    const beforeEntryCommit = await beginMemoryMutation(db, {
      idempotencyKey: "request-recovery",
      sourceChannel: "api",
      operation: "update",
      entryId: "entry-recovery",
      requestHash: "request-hash-recovery",
      now: 2_030,
    });
    expect(beforeEntryCommit.mutation.state).toBe("preparing");

    raw.prepare(
      "UPDATE entries SET content = ?, content_hash = ? WHERE id = ?"
    ).run("new content", "new-hash", "entry-recovery");
    await markMemoryMutationFailed(db, {
      mutationId: beforeEntryCommit.mutation.mutationId,
      leaseOwner: beforeEntryCommit.leaseOwner!,
      error: "after_entry_commit",
      now: 2_040,
    });
    const afterEntryCommit = await beginMemoryMutation(db, {
      idempotencyKey: "request-recovery",
      sourceChannel: "api",
      operation: "update",
      entryId: "entry-recovery",
      requestHash: "request-hash-recovery",
      now: 2_050,
    });
    expect(afterEntryCommit.mutation.state).toBe("entry_committed");

    expect(await stageMemoryMutationKnowledgeIntent(db, {
      mutationId: afterEntryCommit.mutation.mutationId,
      leaseOwner: afterEntryCommit.leaseOwner!,
      observationId: "observation-recovery",
      claimId: "claim-recovery",
      now: 2_060,
    })).toBe(true);
    raw.exec(`
      INSERT INTO sb_observations (id) VALUES ('observation-recovery');
      INSERT INTO sb_memories (id, entry_id, content_hash)
      VALUES ('claim-recovery', 'entry-recovery', 'new-hash');
      INSERT INTO sb_memory_sources (memory_id, observation_id)
      VALUES ('claim-recovery', 'observation-recovery');
      INSERT INTO sb_parent_versions (version_id, parent_id, state)
      VALUES ('version-recovery', 'parent-recovery', 'active');
      INSERT INTO sb_parent_version_claims (memory_id, parent_version_id, relation)
      VALUES ('claim-recovery', 'version-recovery', 'supports');
      INSERT INTO sb_parent_units (parent_id, active_version_id)
      VALUES ('parent-recovery', 'version-recovery');
    `);
    await markMemoryMutationFailed(db, {
      mutationId: afterEntryCommit.mutation.mutationId,
      leaseOwner: afterEntryCommit.leaseOwner!,
      error: "after_knowledge_commit",
      now: 2_070,
    });
    const afterKnowledgeCommit = await beginMemoryMutation(db, {
      idempotencyKey: "request-recovery",
      sourceChannel: "api",
      operation: "update",
      entryId: "entry-recovery",
      requestHash: "request-hash-recovery",
      now: 2_080,
    });
    expect(afterKnowledgeCommit.mutation.state).toBe("knowledge_committed");
  });

  it("commits the knowledge checkpoint under the same lease", async () => {
    const started = await beginMemoryMutation(db, {
      idempotencyKey: "request-2",
      sourceChannel: "mcp",
      operation: "update",
      entryId: "entry-2",
      requestHash: "request-hash-2",
      now: 200,
    });
    await markMemoryMutationEntryCommitted(db, {
      mutationId: started.mutation.mutationId,
      leaseOwner: started.leaseOwner!,
      resultContent: "replacement",
      resultContentHash: "replacement-hash",
      resultVectorCount: 1,
      now: 210,
    });
    const result = await db.batch([
      prepareMemoryMutationKnowledgeCommit(db, {
        mutationId: started.mutation.mutationId,
        leaseOwner: started.leaseOwner!,
        observationId: "obs-1",
        claimId: "claim-1",
        now: 220,
      }),
    ]);
    expect(result[0].meta?.changes).toBe(1);
    expect(raw.prepare(
      `SELECT state, observation_id, claim_id FROM sb_memory_mutations`
    ).get()).toEqual({
      state: "knowledge_committed",
      observation_id: "obs-1",
      claim_id: "claim-1",
    });
  });

  it("resumes only the projection stage after a queued projection warning", async () => {
    const started = await beginMemoryMutation(db, {
      idempotencyKey: "request-3",
      sourceChannel: "api",
      operation: "update",
      entryId: "entry-3",
      requestHash: "request-hash-3",
      now: 300,
    });
    await markMemoryMutationEntryCommitted(db, {
      mutationId: started.mutation.mutationId,
      leaseOwner: started.leaseOwner!,
      resultContent: "replacement",
      resultContentHash: "replacement-hash",
      resultVectorCount: 1,
      now: 310,
    });
    await db.batch([prepareMemoryMutationKnowledgeCommit(db, {
      mutationId: started.mutation.mutationId,
      leaseOwner: started.leaseOwner!,
      observationId: "obs-3",
      claimId: "claim-3",
      now: 320,
    })]);
    expect(await markMemoryMutationProjectionResult(db, {
      mutationId: started.mutation.mutationId,
      leaseOwner: started.leaseOwner!,
      warnings: ["claim_vector_enqueue_failed"],
      now: 330,
    })).toBe(true);

    const resumed = await beginMemoryMutation(db, {
      idempotencyKey: "request-3",
      sourceChannel: "api",
      operation: "update",
      entryId: "entry-3",
      requestHash: "request-hash-3",
      now: 340,
    });
    expect(resumed.status).toBe("resumed");
    expect(resumed.mutation).toMatchObject({
      state: "knowledge_committed",
      resultContent: "replacement",
      claimId: "claim-3",
    });
  });
});
