import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  linkPendingEntryConflictClaims,
  loadRecallConflictContext,
} from "../../src/memory/recall-conflicts";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { MEMORY_QUALITY_SCHEMA_STATEMENTS } from "../../src/memory/quality";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("Recall conflict context", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    raw.exec(`CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_hash TEXT
    )`);
    await ensureMemoryDataModel(db);
    for (const statement of MEMORY_QUALITY_SCHEMA_STATEMENTS) await db.exec(statement);

    raw.prepare(
      `INSERT INTO entries (id, content, content_hash)
       VALUES ('entry-old', 'mtzs uses installation_proxy', 'hash-old'),
              ('entry-new', 'mtzs uses new_installer', 'hash-new')`
    ).run();
    raw.prepare(
      `INSERT INTO sb_observations (id, content, source, content_hash, created_at)
       VALUES ('obs-old', 'mtzs uses installation_proxy', 'api', 'hash-old', 1),
              ('obs-new', 'mtzs uses new_installer', 'api', 'hash-new', 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
       VALUES ('parent-old', 'version-old', 1, 1), ('parent-new', 'version-new', 2, 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, source_observation_id,
         state, summary_vector_ids, created_at, updated_at
       ) VALUES ('version-old', 'parent-old', 1, 'obs-old', 'active', '[]', 1, 1),
                ('version-new', 'parent-new', 1, 'obs-new', 'active', '[]', 2, 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, parent_version_id, claim_status,
         content_hash, entities_json, created_at
       ) VALUES ('claim-old', 'mtzs uses installation_proxy', 'entry-old', 'version-old', 'contested', 'hash-old', '[]', 1),
                ('claim-new', 'mtzs uses new_installer', 'entry-new', 'version-new', 'contested', 'hash-new', '[]', 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
       VALUES ('version-old', 'claim-old', 'supports', 1),
              ('version-new', 'claim-new', 'supports', 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, created_at
       ) VALUES ('source-old', 'claim-old', 'obs-old', 'supports', 'supports', 1),
                ('source-new', 'claim-new', 'obs-new', 'supports', 'supports', 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_conflict_cases (
         id, old_memory_id, new_memory_id, old_claim_id, new_claim_id,
         conflict_type, reason, state, created_at
       ) VALUES ('conflict-1', 'entry-old', 'entry-new', 'claim-old', 'claim-new',
                 'fact_resolution', 'different_object', 'pending', 3)`
    ).run();
  });

  afterEach(() => raw.close());

  it("returns both contested Claims when either matching Entry participates in a pending conflict", async () => {
    const context = await loadRecallConflictContext(db, ["entry-old"], 10);

    expect(context.claimsByEntry.get("entry-old")).toEqual([{
      id: "claim-old",
      entryId: "entry-old",
      parentVersionId: "version-old",
      statement: "mtzs uses installation_proxy",
      status: "contested",
      verificationStatus: "contested",
      conflictIds: ["conflict-1"],
      opposingClaimIds: ["claim-new"],
    }]);
    expect(context.conflicts).toEqual([{
      id: "conflict-1",
      state: "pending",
      reason: "different_object",
      claimIds: ["claim-old", "claim-new"],
      claims: [
        { id: "claim-old", entryId: "entry-old", parentVersionId: "version-old", statement: "mtzs uses installation_proxy", status: "contested" },
        { id: "claim-new", entryId: "entry-new", parentVersionId: "version-new", statement: "mtzs uses new_installer", status: "contested" },
      ],
    }]);
  });

  it("upgrades a legacy Entry conflict to Claim IDs without guessing among multiple Claims", async () => {
    raw.prepare(
      `UPDATE sb_conflict_cases SET old_claim_id = NULL, new_claim_id = NULL
       WHERE id = 'conflict-1'`
    ).run();
    raw.prepare(
      `UPDATE sb_memories SET claim_status = 'supported'
       WHERE id IN ('claim-old', 'claim-new')`
    ).run();

    const linked = await linkPendingEntryConflictClaims(db, {
      oldEntryId: "entry-old",
      newEntryId: "entry-new",
      asOf: 10,
    });

    expect(linked).toBe(true);
    expect(raw.prepare(
      `SELECT old_claim_id, new_claim_id FROM sb_conflict_cases WHERE id = 'conflict-1'`
    ).get()).toEqual({ old_claim_id: "claim-old", new_claim_id: "claim-new" });
    expect(raw.prepare(
      `SELECT id, claim_status FROM sb_memories ORDER BY id`
    ).all()).toEqual([
      { id: "claim-new", claim_status: "contested" },
      { id: "claim-old", claim_status: "contested" },
    ]);
  });
});
