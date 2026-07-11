import { beforeEach, describe, expect, it } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { createExecutionContext, createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";
import { flushTelemetry } from "../../src/telemetry";

describe("Observatory analytics API", () => {
  beforeEach(() => {
    resetSettingsCache();
  });

  it("protects analytics and returns P95 plus hourly points", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(env);
    const now = Date.now();
    db.prepare(
      `INSERT INTO sb_request_logs
       (id, trace_id, method, route, operation, source, status_code, success,
        started_at, duration_ms, request_bytes, response_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("request-1", "trace-1", "GET", "/stats", "memory.stats", "test", 200, 1, now, 100, 0, 10);
    db.prepare(
      `INSERT INTO sb_request_logs
       (id, trace_id, method, route, operation, source, status_code, success,
        started_at, duration_ms, request_bytes, response_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("request-2", "trace-2", "GET", "/stats", "memory.stats", "test", 200, 1, now, 200, 0, 10);

    const ctx = createExecutionContext();
    const unauthorized = await worker.fetch(
      new Request("http://localhost/analytics/overview"),
      env,
      ctx
    );
    expect(unauthorized.status).toBe(401);

    const overview = await worker.fetch(
      new Request("http://localhost/analytics/overview?hours=24", {
        headers: { Authorization: "Bearer test-token" },
      }),
      env,
      ctx
    );
    expect(overview.status).toBe(200);
    const overviewBody = await overview.json() as any;
    expect(overviewBody.requests.count).toBeGreaterThanOrEqual(2);
    expect(overviewBody.requests.p95_ms).toBe(200);

    const timeseries = await worker.fetch(
      new Request("http://localhost/analytics/timeseries?hours=24", {
        headers: { Authorization: "Bearer test-token" },
      }),
      env,
      ctx
    );
    const timeseriesBody = await timeseries.json() as any;
    expect(timeseriesBody.points[0].p50_ms).toBe(100);
    expect(timeseriesBody.points[0].p95_ms).toBe(200);

    await flushTelemetry(env.DB);
    db.close();
  });

  it("returns four-layer memory overview health and composition", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(env);
    const now = Date.now();
    const old = now - 10 * 60_000;

    db.prepare(
      `INSERT INTO entries
       (id, content, tags, source, created_at, vector_ids, classification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("entry-1", "Atomic overview fact", "[]", "api", old, "[]", "pending");
    db.prepare(
      `INSERT INTO sb_observations
       (id, content, source, metadata_json, content_hash, extraction_status,
        extraction_version, extraction_attempts, extraction_error,
        next_attempt_at, processing_started_at, processed_at, needs_reprocess, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "obs-1",
      "Atomic overview fact",
      "api",
      "{}",
      "hash-1",
      "partial_error",
      1,
      1,
      "atomic write failed",
      null,
      null,
      now,
      1,
      old
    );
    db.prepare(
      `INSERT INTO sb_memories
       (id, content, kind, memory_class, importance, confidence, entry_id,
        content_hash, observed_at, valid_from, valid_to, reference_time,
        invalid_at, expired_at, entities_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "mem-1",
      "Atomic overview fact",
      "semantic",
      "fact",
      4,
      0.9,
      "entry-1",
      "hash-1",
      old,
      null,
      null,
      old,
      null,
      null,
      "[]",
      old
    );
    db.prepare(
      `INSERT INTO sb_memory_sources
       (id, memory_id, observation_id, role, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("source-1", "mem-1", "obs-1", "derived_from", 0.9, old);
    db.prepare(
      `INSERT INTO sb_entities
       (id, name, name_normalized, entity_type, aliases_json, metadata_json,
        mention_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("entity-1", "Singularity", "singularity", "project", "[]", "{}", 2, old, now);
    db.prepare(
      `INSERT INTO sb_memory_entities
       (id, memory_id, entity_id, role, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("mem-entity-1", "mem-1", "entity-1", "mentions", 0.9, old);
    db.prepare(
      `INSERT INTO sb_entity_relations
       (id, from_entity_id, to_entity_id, relation_type, fact, memory_id,
        observation_id, score, valid_from, valid_to, invalid_at, expired_at,
        reference_time, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "rel-1",
      "entity-1",
      "entity-1",
      "related_to",
      "Singularity relates to itself in this fixture",
      "mem-1",
      "obs-1",
      0.8,
      null,
      null,
      null,
      null,
      old,
      "{}",
      old
    );
    db.prepare(
      `INSERT INTO sb_memory_revisions
       (id, memory_id, event_type, old_content, new_content,
        old_metadata_json, new_metadata_json, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("rev-1", "entry-1", "ADD", null, "Atomic overview fact", null, "{}", null, "api", old);

    const response = await worker.fetch(
      new Request("http://localhost/analytics/memory-overview", {
        headers: { Authorization: "Bearer test-token" },
      }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.totals).toMatchObject({
      observations: 1,
      atomic_memories: 1,
      entities: 1,
      active_facts: 1,
    });
    expect(body.health).toMatchObject({
      extraction_due: 1,
      partial_error: 1,
      unclassified: 1,
      unvectorized: 1,
    });
    expect(body.kinds).toContainEqual({ name: "semantic", count: 1 });
    expect(body.classes).toContainEqual({ name: "fact", count: 1 });
    expect(body.top_entities[0]).toMatchObject({ name: "Singularity", mention_count: 2 });
    expect(body.relation_types).toContainEqual({ name: "related_to", count: 1 });
    expect(body.recent_changes.length).toBeGreaterThan(0);

    db.close();
  });
});
