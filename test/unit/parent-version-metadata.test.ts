import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("Parent Version metadata snapshot backfill", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    await ensureMemoryDataModel(db);
  });

  afterEach(() => raw.close());

  it("records provenance for observation, revision, recorded, and unknown snapshots", async () => {
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, source_channel, metadata_json, content_hash, created_at
       ) VALUES ('obs-1', 'source', 'obsidian', 'obsidian',
                 '{"tags":["historical"],"vault_id":"vault-a"}', 'obs-hash', 10)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_revisions (
         id, memory_id, event_type, new_metadata_json, actor, created_at
       ) VALUES ('revision-1', 'entry-2', 'UPDATE',
                 '{"tags":["revision-tag"],"source":"mcp","vault_id":"vault-b"}', 'mcp', 15)`
    ).run();
    raw.exec(`
      INSERT INTO sb_parent_versions (
        version_id, parent_id, version_number, source_observation_id,
        metadata_snapshot_hash, state, created_at, updated_at
      ) VALUES
        ('version-observation', 'entry-1', 1, 'obs-1', NULL, 'superseded', 10, 20),
        ('version-revision', 'entry:entry-2', 1, NULL, NULL, 'superseded', 20, 30),
        ('version-recorded', 'entry-3', 1, NULL, 'recorded-hash', 'active', 30, 30),
        ('version-unknown', 'entry-4', 1, NULL, NULL, 'active', 40, 40);
    `);

    await ensureMemoryDataModel(db);

    expect(raw.prepare(
      `SELECT tags_snapshot_json, source_snapshot, vault_snapshot,
              metadata_snapshot_hash, metadata_snapshot_source
       FROM sb_parent_versions WHERE version_id = 'version-observation'`
    ).get()).toEqual({
      tags_snapshot_json: '["historical"]',
      source_snapshot: "obsidian",
      vault_snapshot: "vault-a",
      metadata_snapshot_hash: "legacy-observation:version-observation",
      metadata_snapshot_source: "inferred_from_observation",
    });
    expect(raw.prepare(
      `SELECT tags_snapshot_json, source_snapshot, vault_snapshot,
              metadata_snapshot_source
       FROM sb_parent_versions WHERE version_id = 'version-revision'`
    ).get()).toEqual({
      tags_snapshot_json: '["revision-tag"]',
      source_snapshot: "mcp",
      vault_snapshot: "vault-b",
      metadata_snapshot_source: "inferred_from_revision",
    });
    expect(raw.prepare(
      `SELECT metadata_snapshot_hash, metadata_snapshot_source
       FROM sb_parent_versions WHERE version_id = 'version-recorded'`
    ).get()).toEqual({
      metadata_snapshot_hash: "recorded-hash",
      metadata_snapshot_source: "recorded",
    });
    expect(raw.prepare(
      `SELECT tags_snapshot_json, source_snapshot, vault_snapshot,
              metadata_snapshot_hash, metadata_snapshot_source
       FROM sb_parent_versions WHERE version_id = 'version-unknown'`
    ).get()).toEqual({
      tags_snapshot_json: "[]",
      source_snapshot: null,
      vault_snapshot: null,
      metadata_snapshot_hash: "legacy-unknown:version-unknown",
      metadata_snapshot_source: "unknown",
    });
  });
});
