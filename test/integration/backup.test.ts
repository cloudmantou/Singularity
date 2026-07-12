import { describe, expect, it } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { createExecutionContext, createSelfhostEnv } from "../../src/selfhost/env";

function auth(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
  });
}

describe("full memory backup import/export", () => {
  it("exports and restores four-layer memory graph data with integrity checks", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(env);
    const now = Date.now();

    db.prepare(
      `INSERT INTO entries
       (id, content, tags, source, created_at, vector_ids, recall_count,
        importance_score, classification_confidence, classification_status,
        classification_error, classification_attempts, classification_next_attempt_at,
        classification_started_at, classification_version, classified_at,
        contradiction_wins, contradiction_losses, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "entry-1",
      "Singularity uses SQLite",
      '["work","kind:semantic"]',
      "api",
      now - 2000,
      '["entry-1"]',
      2,
      4,
      0.92,
      "succeeded",
      null,
      1,
      null,
      null,
      2,
      now - 1000,
      0,
      0,
      "hash-entry-1"
    );
    db.prepare(
      `INSERT INTO entries
       (id, content, tags, source, created_at, vector_ids, recall_count,
        importance_score, classification_status, classification_attempts,
        classification_version, contradiction_wins, contradiction_losses, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "entry-2",
      "SQLite supports local storage",
      '["work"]',
      "api",
      now - 1000,
      "[]",
      0,
      3,
      "pending",
      0,
      1,
      0,
      0,
      "hash-entry-2"
    );
    db.prepare(
      `INSERT INTO sb_observations
       (id, content, source, metadata_json, content_hash, extraction_status,
        extraction_version, extraction_attempts, extraction_error,
        next_attempt_at, processing_started_at, processed_at, needs_reprocess, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("obs-1", "Singularity uses SQLite", "api", "{}", "hash-entry-1", "succeeded", 1, 1, null, null, null, now, 0, now - 2000);
    db.prepare(
      `INSERT INTO sb_memories
       (id, content, kind, memory_class, importance, confidence, entry_id,
        content_hash, observed_at, valid_from, valid_to, reference_time,
        invalid_at, expired_at, entities_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("mem-1", "Singularity uses SQLite", "semantic", "fact", 4, 0.92, "entry-1", "hash-entry-1", now - 2000, null, null, now - 2000, null, null, "[]", now - 2000);
    db.prepare(
      `INSERT INTO sb_memory_sources
       (id, memory_id, observation_id, role, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("source-1", "mem-1", "obs-1", "derived_from", 0.92, now - 2000);
    db.prepare(
      `INSERT INTO sb_entities
       (id, name, name_normalized, entity_type, aliases_json, metadata_json,
        mention_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("entity-1", "Singularity", "singularity", "project", "[]", "{}", 1, now - 2000, now);
    db.prepare(
      `INSERT INTO sb_entities
       (id, name, name_normalized, entity_type, aliases_json, metadata_json,
        mention_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("entity-2", "SQLite", "sqlite", "product", "[]", "{}", 1, now - 2000, now);
    db.prepare(
      `INSERT INTO sb_memory_entities
       (id, memory_id, entity_id, role, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("mem-entity-1", "mem-1", "entity-1", "mentions", 0.9, now - 2000);
    db.prepare(
      `INSERT INTO sb_entity_relations
       (id, from_entity_id, to_entity_id, relation_type, fact, memory_id,
        observation_id, score, valid_from, valid_to, invalid_at, expired_at,
        reference_time, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("fact-1", "entity-1", "entity-2", "uses", "Singularity uses SQLite", "mem-1", "obs-1", 0.91, null, null, null, null, now - 2000, "{}", now - 2000);
    db.prepare(
      `INSERT INTO sb_fact_sources
       (id, relation_id, memory_id, observation_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("fact-source-1", "fact-1", "mem-1", "obs-1", now - 2000);
    db.prepare(
      `INSERT INTO sb_memory_relations
       (id, from_memory_id, to_memory_id, relation_type, score, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("relation-1", "entry-1", "entry-2", "supports", 0.8, "{}", now - 1000);
    db.prepare(
      `INSERT INTO sb_memory_revisions
       (id, memory_id, event_type, old_content, new_content,
        old_metadata_json, new_metadata_json, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("revision-1", "entry-1", "ADD", null, "Singularity uses SQLite", null, "{}", null, "api", now - 2000);

    const exportResponse = await worker.fetch(auth("/export?full=true"), env, createExecutionContext());
    expect(exportResponse.status).toBe(200);
    const backup = await exportResponse.json() as any;

    expect(backup.backupFormat).toBe("singularity-memory-backup");
    expect(backup.schemaVersion).toBe(5);
    expect(backup.features).toEqual(
      expect.arrayContaining([
        "atomic-memory",
        "temporal-facts",
        "fact-sources",
        "embedding-profiles",
        "vector-rebuild-state",
      ])
    );
    expect(backup.integrity.ok).toBe(true);
    expect(backup.totals).toMatchObject({
      entries: 2,
      observations: 1,
      memories: 1,
      memorySources: 1,
      entities: 2,
      memoryEntities: 1,
      entityRelations: 1,
      factSources: 1,
      memoryRelations: 1,
      revisions: 1,
    });

    const restored = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(restored.env);
    const importResponse = await worker.fetch(
      auth("/import", {
        method: "POST",
        body: JSON.stringify(backup),
      }),
      restored.env,
      createExecutionContext()
    );
    expect(importResponse.status).toBe(200);
    const imported = await importResponse.json() as any;
    expect(imported.schemaVersion).toBe(5);
    expect(imported.inserted).toBe(2);
    expect(imported.graph.memories.imported).toBe(1);
    expect(imported.graph.entityRelations.imported).toBe(1);
    expect(imported.graph.factSources.imported).toBe(1);
    expect(imported.integrity.ok).toBe(true);

    const restoredExport = await worker.fetch(
      auth("/export?full=true"),
      restored.env,
      createExecutionContext()
    );
    const restoredBackup = await restoredExport.json() as any;
    expect(restoredBackup.totals).toMatchObject(backup.totals);
    expect(restoredBackup.integrity.ok).toBe(true);

    const legacy = {
      ...backup,
      schemaVersion: 4,
      features: undefined,
      factSources: undefined,
    };
    const legacyRestored = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    await initializeDatabase(legacyRestored.env);
    const legacyImportResponse = await worker.fetch(
      auth("/import", {
        method: "POST",
        body: JSON.stringify(legacy),
      }),
      legacyRestored.env,
      createExecutionContext()
    );
    expect(legacyImportResponse.status).toBe(200);
    const legacyImported = await legacyImportResponse.json() as any;
    expect(legacyImported.schemaVersion).toBe(5);
    expect(legacyImported.graph.factSources.total).toBe(0);

    const missingFormatResponse = await worker.fetch(
      auth("/import", {
        method: "POST",
        body: JSON.stringify({ ...backup, backupFormat: undefined }),
      }),
      legacyRestored.env,
      createExecutionContext()
    );
    expect(missingFormatResponse.status).toBe(400);
    const missingFormatImported = await missingFormatResponse.json() as any;
    expect(missingFormatImported.error).toMatch(/backupFormat/);

    const futureImportResponse = await worker.fetch(
      auth("/import", {
        method: "POST",
        body: JSON.stringify({ ...backup, schemaVersion: 6 }),
      }),
      legacyRestored.env,
      createExecutionContext()
    );
    expect(futureImportResponse.status).toBe(400);
    const futureImported = await futureImportResponse.json() as any;
    expect(futureImported.error).toMatch(/schemaVersion 6/);

    db.close();
    restored.db.close();
    legacyRestored.db.close();
  });
});
