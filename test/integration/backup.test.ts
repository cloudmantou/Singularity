import { describe, expect, it } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { ensureAssociationDataModel } from "../../src/memory/associations";
import { ensureEntityResolutionDataModel } from "../../src/memory/entities";
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
    await ensureEntityResolutionDataModel(env.DB);
    await ensureAssociationDataModel(env.DB);
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
       (id, content, source, metadata_json, content_hash,
        source_channel, source_identity, author_type, source_uri,
        source_timestamp, revision, root_evidence_id, previous_evidence_id,
        extraction_status, extraction_version, extraction_attempts, extraction_error,
        next_attempt_at, processing_started_at, processed_at, needs_reprocess, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "obs-1",
      "Singularity uses SQLite",
      "api",
      JSON.stringify({
        parent_id: "parent-1",
        parent_version_id: "parent-version-1",
        parent_version_number: 1,
        evidence_root_id: "evidence-root-1",
      }),
      "hash-entry-1",
      "api",
      "api:obs-1",
      "user",
      "memory://obs-1",
      now - 2000,
      1,
      "evidence-root-1",
      null,
      "succeeded",
      1,
      1,
      null,
      null,
      null,
      now,
      0,
      now - 2000
    );
    db.prepare(
      `INSERT INTO sb_scopes
       (scope_id, parent_scope_id, canonical_name, aliases_json, scope_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("scope-1", null, "Singularity", '["singularity"]', "project", now - 2000, now);
    db.prepare(
      `INSERT INTO sb_parent_units
       (parent_id, active_version_id, scope_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("parent-1", "parent-version-1", "scope-1", now - 2000, now);
    db.prepare(
      `INSERT INTO sb_parent_units
       (parent_id, active_version_id, scope_id, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?)`
    ).run("parent-2", "scope-1", now - 1000, now);
    db.prepare(
      `INSERT INTO sb_association_edges (
         id, source_parent_id, target_parent_id, edge_type, weight,
         provenance, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "association-1",
      "parent-1",
      "parent-2",
      "part_of_project",
      0.8,
      "manual",
      "{}",
      now - 500,
      now - 500
    );
    db.prepare(
      `INSERT INTO sb_parent_versions
       (version_id, parent_id, version_number, source_observation_id,
        source_snapshot_hash, summary, state, summary_vector_ids,
        activated_at, superseded_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("parent-version-1", "parent-1", 1, "obs-1", "hash-entry-1", "Singularity uses SQLite", "active", "[]", now - 1500, null, now - 2000, now);
    db.prepare(
      `INSERT INTO sb_memories
       (id, content, kind, memory_class, importance, confidence, entry_id,
        parent_version_id, claim_subject, claim_predicate, claim_object,
        scope_id, polarity, modality, claim_status, scores_json,
        content_hash, observed_at, valid_from, valid_to, reference_time,
        invalid_at, expired_at, entities_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "mem-1",
      "Singularity uses SQLite",
      "semantic",
      "fact",
      4,
      0.92,
      "entry-1",
      "parent-version-1",
      "Singularity",
      "uses_storage",
      "SQLite",
      "scope-1",
      "positive",
      "confirmed",
      "confirmed",
      JSON.stringify({
        relevance: 0.9,
        evidenceQuality: 0.95,
        derivationConfidence: 0.92,
        conflictState: "none",
      }),
      "hash-entry-1",
      now - 2000,
      null,
      null,
      now - 2000,
      null,
      null,
      "[]",
      now - 2000
    );
    db.prepare(
      `INSERT INTO sb_parent_version_claims
       (parent_version_id, memory_id, relation, created_at)
       VALUES (?, ?, ?, ?)`
    ).run("parent-version-1", "mem-1", "supports", now - 2000);
    db.prepare(
      `INSERT INTO sb_memory_sources
       (id, memory_id, observation_id, role, score, relation, extract_span,
        evidence_score, derivation_confidence, extractor_model,
        extractor_version, evidence_root_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("source-1", "mem-1", "obs-1", "derived_from", 0.92, "supports", "{\"start\":0,\"end\":24}", 0.95, 0.92, "test-extractor", "1", "evidence-root-1", now - 2000);
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
      `INSERT INTO sb_entity_aliases
       (id, entity_id, alias, alias_normalized, source_observation_id,
        confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("alias-1", "entity-1", "SB", "sb", "obs-1", 1, now - 2000, now);
    db.prepare(
      `INSERT INTO sb_entity_alias_sources
       (id, alias_id, observation_id, relation, created_at)
       VALUES (?, ?, ?, 'supports', ?)`
    ).run("alias-source-1", "alias-1", "obs-1", now);
    db.prepare(
      `INSERT INTO sb_entity_external_ids
       (id, entity_id, provider, external_id, source_observation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("external-1", "entity-1", "github", "cloudmantou/Singularity", "obs-1", now - 2000, now);
    db.prepare(
      `INSERT INTO sb_entity_external_id_sources
       (id, external_id_id, observation_id, relation, created_at)
       VALUES (?, ?, ?, 'supports', ?)`
    ).run("external-source-1", "external-1", "obs-1", now);
    db.prepare(
      `INSERT INTO sb_entity_embeddings
       (entity_id, embedding_fingerprint, embedding_json, dimensions, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("entity-1", "test-v1", "[1,0]", 2, now);
    db.prepare(
      `INSERT INTO sb_entity_merge_candidates
       (id, source_entity_id, target_entity_id, matched_by, score, reason_json,
        state, source_observation_id, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`
    ).run("entity-candidate-1", "entity-2", "entity-1", "semantic", 0.9, "[]", "obs-1", now, now);
    db.prepare(
      `INSERT INTO sb_entity_merge_history
       (id, source_entity_id, target_entity_id, candidate_id, actor_type,
        reason, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("entity-history-1", "entity-2", "entity-1", "entity-candidate-1", "user", "reviewed", "{}", now);
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
      `INSERT INTO sb_fact_resolutions
       (id, relation_id, target_relation_id, resolution_type, confidence,
        reason_codes_json, requires_review, applied_invalidation,
        source_memory_id, target_memory_id, created_at)
       VALUES (?, ?, NULL, 'supports', 0.91, '[]', 0, 0, ?, NULL, ?)`
    ).run("fact-resolution-1", "fact-1", "mem-1", now - 2000);
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
    db.prepare(
      `INSERT INTO sb_conflict_cases (
         id, old_memory_id, new_memory_id, old_claim_id, new_claim_id,
         conflict_type, state, created_at
       ) VALUES (?, ?, ?, ?, NULL, 'fact_resolution', 'pending', ?)`
    ).run("conflict-1", "entry-1", "entry-2", "mem-1", now - 500);

    const exportResponse = await worker.fetch(auth("/export?full=true"), env, createExecutionContext());
    expect(exportResponse.status).toBe(200);
    const backup = await exportResponse.json() as any;

    expect(backup.backupFormat).toBe("singularity-memory-backup");
    expect(backup.schemaVersion).toBe(11);
    expect(backup.features).toEqual(
      expect.arrayContaining([
        "atomic-memory",
        "temporal-facts",
        "fact-sources",
        "embedding-fingerprints",
        "evidence-claim-provenance",
        "parent-versions",
        "parent-version-claims",
        "parent-version-time-windows",
        "entity-resolution",
        "entity-merge-execution",
        "fact-resolution",
        "claim-level-conflicts",
        "association-graph",
      ])
    );
    expect(backup.features).not.toContain("vector-rebuild-state");
    expect(backup.entries[0]).not.toHaveProperty("pending_rebuild_id");
    expect(backup.integrity.ok).toBe(true);
    expect(backup.totals).toMatchObject({
      scopes: 1,
      parentUnits: 2,
      parentVersions: 1,
      parentVersionClaims: 1,
      associationEdges: 1,
      entries: 2,
      observations: 1,
      memories: 1,
      memorySources: 1,
      entities: 2,
      entityAliases: 1,
      entityAliasSources: 1,
      entityExternalIds: 1,
      entityExternalIdSources: 1,
      entityEmbeddings: 1,
      entityMergeCandidates: 1,
      entityMergeHistory: 1,
      memoryEntities: 1,
      entityRelations: 1,
      factResolutions: 1,
      factSources: 1,
      memoryRelations: 1,
      revisions: 1,
      conflictCases: 1,
    });
    expect(backup.scopes[0]).toMatchObject({ scope_id: "scope-1" });
    expect(backup.parentUnits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parent_id: "parent-1",
        active_version_id: "parent-version-1",
      }),
    ]));
    expect(backup.parentVersions[0]).toMatchObject({
      version_id: "parent-version-1",
      state: "active",
      activated_at: now - 1500,
      superseded_at: null,
    });
    expect(backup.parentVersionClaims[0]).toMatchObject({
      parent_version_id: "parent-version-1",
      memory_id: "mem-1",
      relation: "supports",
    });
    expect(backup.associationEdges[0]).toMatchObject({
      id: "association-1",
      source_parent_id: "parent-1",
      target_parent_id: "parent-2",
      edge_type: "part_of_project",
      provenance: "manual",
    });
    expect(backup.observations[0]).toMatchObject({
      root_evidence_id: "evidence-root-1",
      revision: 1,
      author_type: "user",
    });
    expect(backup.memories[0]).toMatchObject({
      parent_version_id: "parent-version-1",
      claim_subject: "Singularity",
      claim_predicate: "uses_storage",
      claim_object: "SQLite",
      claim_status: "confirmed",
    });
    expect(backup.memorySources[0]).toMatchObject({
      relation: "supports",
      evidence_root_id: "evidence-root-1",
      extractor_model: "test-extractor",
    });
    expect(backup.entities[0]).toMatchObject({
      lifecycle_state: "active",
      merged_into_entity_id: null,
      merged_at: null,
    });
    expect(backup.conflictCases[0]).toMatchObject({
      old_memory_id: "entry-1",
      new_memory_id: "entry-2",
      old_claim_id: "mem-1",
      new_claim_id: null,
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
    expect(imported.schemaVersion).toBe(11);
    expect(imported.inserted).toBe(2);
    expect(imported.graph.scopes.imported).toBe(1);
    expect(imported.graph.parentUnits.imported).toBe(2);
    expect(imported.graph.parentVersions.imported).toBe(1);
    expect(imported.graph.parentVersionClaims.imported).toBe(1);
    expect(imported.graph.associationEdges.imported).toBe(1);
    expect(imported.graph.memories.imported).toBe(1);
    expect(imported.graph.entityRelations.imported).toBe(1);
    expect(imported.graph.entityAliases.imported).toBe(1);
    expect(imported.graph.entityAliasSources.imported).toBe(1);
    expect(imported.graph.entityExternalIds.imported).toBe(1);
    expect(imported.graph.entityExternalIdSources.imported).toBe(1);
    expect(imported.graph.entityEmbeddings.imported).toBe(1);
    expect(imported.graph.entityMergeCandidates.imported).toBe(1);
    expect(imported.graph.entityMergeHistory.imported).toBe(1);
    expect(imported.graph.factResolutions.imported).toBe(1);
    expect(imported.graph.factSources.imported).toBe(1);
    expect(imported.graph.conflictCases.imported).toBe(1);
    expect(imported.integrity.ok).toBe(true);

    const restoredExport = await worker.fetch(
      auth("/export?full=true"),
      restored.env,
      createExecutionContext()
    );
    const restoredBackup = await restoredExport.json() as any;
    expect(restoredBackup.totals).toMatchObject(backup.totals);
    expect(restoredBackup.integrity.ok).toBe(true);
    expect(restoredBackup.parentVersions[0]).toMatchObject({
      activated_at: now - 1500,
      superseded_at: null,
    });
    expect(restoredBackup.entities[0]).toMatchObject({
      lifecycle_state: "active",
      merged_into_entity_id: null,
      merged_at: null,
    });

    const forgetResponse = await worker.fetch(
      auth("/forget", {
        method: "POST",
        body: JSON.stringify({ id: "entry-1" }),
      }),
      restored.env,
      createExecutionContext()
    );
    expect(forgetResponse.status).toBe(200);
    const postForgetExport = await worker.fetch(
      auth("/export?full=true"),
      restored.env,
      createExecutionContext()
    );
    const postForgetBackup = await postForgetExport.json() as any;
    expect(postForgetBackup.integrity).toMatchObject({ ok: true });
    expect(postForgetBackup.mergeCandidates).toEqual([]);
    expect(postForgetBackup.conflictCases).toEqual([]);
    expect(postForgetBackup.factResolutions).toEqual([]);

    const legacy = {
      ...backup,
      schemaVersion: 4,
      features: undefined,
      factSources: undefined,
      entityAliases: undefined,
      entityAliasSources: undefined,
      entityExternalIds: undefined,
      entityExternalIdSources: undefined,
      entityEmbeddings: undefined,
      entityMergeCandidates: undefined,
      entityMergeHistory: undefined,
      factResolutions: undefined,
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
    expect(legacyImported.schemaVersion).toBe(11);
    expect(legacyImported.graph.factSources.total).toBe(0);
    expect(legacyImported.graph.parentVersionClaims.total).toBe(1);

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
        body: JSON.stringify({ ...backup, schemaVersion: 12 }),
      }),
      legacyRestored.env,
      createExecutionContext()
    );
    expect(futureImportResponse.status).toBe(400);
    const futureImported = await futureImportResponse.json() as any;
    expect(futureImported.error).toMatch(/schemaVersion 12/);

    db.close();
    restored.db.close();
    legacyRestored.db.close();
  });
});
