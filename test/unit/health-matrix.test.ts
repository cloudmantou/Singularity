import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectHealthMatrix } from "../../src/operations/health";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import {
  ensureConflictClaimSchema,
  MEMORY_QUALITY_SCHEMA_STATEMENTS,
  prepareComplianceAuditEvent,
} from "../../src/memory/quality";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("Health Matrix", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    raw.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'api',
        created_at INTEGER NOT NULL,
        vector_ids TEXT NOT NULL DEFAULT '[]',
        classification_status TEXT NOT NULL DEFAULT 'pending',
        classification_attempts INTEGER NOT NULL DEFAULT 0,
        classification_next_attempt_at INTEGER,
        classification_started_at INTEGER,
        classification_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sb_external_links (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        sync_status TEXT NOT NULL
      );
    `);
    await ensureMemoryDataModel(db);
    for (const statement of MEMORY_QUALITY_SCHEMA_STATEMENTS) await db.exec(statement);
    await ensureConflictClaimSchema(db);
  });

  afterEach(() => raw.close());

  it("reports queue depth and degrades explicitly when vector search is unavailable", async () => {
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, extraction_status, created_at
       ) VALUES ('obs-1', 'pending', 'api', 'pending', 1)`
    ).run();
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, classification_status)
       VALUES ('entry-1', 'pending', '[]', 'api', 1, '[]', 'retryable_error')`
    ).run();
    raw.prepare(
      `INSERT INTO sb_conflict_cases (
         id, old_memory_id, new_memory_id, conflict_type, state, created_at
       ) VALUES ('conflict-1', 'a', 'b', 'contradiction', 'pending', 1)`
    ).run();

    const matrix = await collectHealthMatrix({
      db,
      vectorize: {
        describe: vi.fn().mockRejectedValue(new Error("index unavailable")),
      },
      mode: "selfhost",
      llmConfigured: true,
      embeddingConfigured: true,
      providers: [{ id: "obsidian", configured: true, status: "healthy" }],
    });

    expect(matrix.status).toBe("degraded");
    expect(matrix.components.vectorIndex).toMatchObject({
      status: "degraded",
      error: "index unavailable",
    });
    expect(matrix.queues).toMatchObject({
      extraction: 1,
      classification: 1,
      conflicts: 1,
    });
    expect(JSON.stringify(matrix)).not.toContain("apiKey");
  });

  it("does not report a tampered audit record as a healthy chain", async () => {
    raw.prepare(
      `INSERT INTO sb_audit_events (
         id, occurred_at, actor_type, action, object_type, metadata_json, event_hash
       ) VALUES ('audit-1', 1, 'system', 'test', 'memory', '{}', 'tampered')`
    ).run();

    const matrix = await collectHealthMatrix({
      db,
      vectorize: { describe: vi.fn().mockResolvedValue({ dimensions: 384 }) },
      mode: "selfhost",
      llmConfigured: true,
      embeddingConfigured: true,
      providers: [],
    });

    expect(matrix.components.auditChain).toMatchObject({
      status: "unhealthy",
      events: 1,
      checked: 1,
    });
    expect(matrix.status).toBe("unhealthy");
  });

  it("uses production queue semantics for recoverable, deferred, and exhausted work", async () => {
    const now = Date.now();
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, extraction_status, extraction_attempts,
         next_attempt_at, needs_reprocess, created_at
       ) VALUES
         ('obs-partial', 'partial', 'api', 'partial_error', 1, NULL, 1, 1),
         ('obs-fallback', 'fallback', 'api', 'fallback', 1, NULL, 1, 2),
         ('obs-deferred', 'deferred', 'api', 'retryable_error', 1, ?, 0, 3),
         ('obs-terminal', 'terminal', 'api', 'terminal_error', 3, NULL, 0, 4)`
    ).run(now + 60_000);
    raw.prepare(
      `INSERT INTO entries (
         id, content, tags, source, created_at, vector_ids,
         classification_status, classification_attempts, classification_next_attempt_at,
         classification_version
       ) VALUES
         ('class-deferred', 'deferred', '[]', 'api', 1, '[]', 'retryable_error', 1, ?, 2),
         ('class-terminal', 'terminal', '[]', 'api', 2, '[]', 'terminal_error', 3, NULL, 2)`
    ).run(now + 60_000);

    const matrix = await collectHealthMatrix({
      db,
      vectorize: { describe: vi.fn().mockResolvedValue({ dimensions: 384 }) },
      mode: "selfhost",
      llmConfigured: true,
      embeddingConfigured: true,
      providers: [],
    });

    expect(matrix.queueDetails).toMatchObject({
      extraction: { due: 2, deferred: 1, exhausted: 1 },
      classification: { due: 0, deferred: 1, exhausted: 1 },
    });
    expect(matrix.queues.extraction).toBe(4);
    expect(matrix.queues.classification).toBe(2);
    expect(matrix.status).toBe("degraded");
  });

  it("accepts valid predecessor links even when equal timestamps sort by random ids", async () => {
    const uuid = vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("z-event")
      .mockReturnValueOnce("a-event");
    try {
      const first = await prepareComplianceAuditEvent(db, {
        actorType: "system",
        action: "first",
        objectType: "memory",
        occurredAt: 100,
      });
      await first.statement.run();
      const second = await prepareComplianceAuditEvent(db, {
        actorType: "system",
        action: "second",
        objectType: "memory",
        occurredAt: 100,
      });
      await second.statement.run();
    } finally {
      uuid.mockRestore();
    }

    const matrix = await collectHealthMatrix({
      db,
      vectorize: { describe: vi.fn().mockResolvedValue({ dimensions: 384 }) },
      mode: "selfhost",
      llmConfigured: true,
      embeddingConfigured: true,
      providers: [],
    });

    expect(matrix.components.auditChain).toMatchObject({
      status: "healthy",
      events: 2,
      checked: 2,
    });
  });

  it("marks a bounded audit sample as degraded instead of claiming full health", async () => {
    for (let index = 0; index < 257; index++) {
      const event = await prepareComplianceAuditEvent(db, {
        actorType: "system",
        action: `event-${index}`,
        objectType: "memory",
        occurredAt: index + 1,
      });
      await event.statement.run();
    }
    raw.prepare(
      `UPDATE sb_audit_events SET metadata_json = '{"tampered":true}'
       WHERE occurred_at = 1`
    ).run();

    const matrix = await collectHealthMatrix({
      db,
      vectorize: { describe: vi.fn().mockResolvedValue({ dimensions: 384 }) },
      mode: "selfhost",
      llmConfigured: true,
      embeddingConfigured: true,
      providers: [],
    });

    expect(matrix.components.auditChain).toMatchObject({
      status: "degraded",
      events: 257,
      checked: 256,
      complete: false,
    });
    expect(matrix.status).toBe("degraded");
  });
});
