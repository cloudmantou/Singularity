import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaimRelationMismatchError,
  ConflictClaimsUnavailableError,
  D1ResolutionCoordinator,
  ManualResolutionOutcomeRequiredError,
} from "../../src/memory/resolution-coordinator";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { MEMORY_QUALITY_SCHEMA_STATEMENTS } from "../../src/memory/quality";
import { FACT_RESOLUTION_SCHEMA_STATEMENTS } from "../../src/memory/fact-resolution";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("ResolutionCoordinator", () => {
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
    for (const statement of FACT_RESOLUTION_SCHEMA_STATEMENTS) await db.exec(statement);

    raw.prepare(`INSERT INTO entries (id, content, content_hash) VALUES (?, ?, ?), (?, ?, ?)`).run(
      "entry-old", "mtzs uses installation_proxy", "hash-old",
      "entry-new", "mtzs uses new_installer", "hash-new"
    );
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, claim_status, content_hash,
         invalid_at, expired_at, entities_json, created_at
       ) VALUES (?, ?, ?, 'supported', ?, NULL, NULL, '[]', ?),
                (?, ?, ?, 'supported', ?, NULL, NULL, '[]', ?)`
    ).run(
      "claim-old", "mtzs uses installation_proxy", "entry-old", "hash-old", 1,
      "claim-new", "mtzs uses new_installer", "entry-new", "hash-new", 2
    );
    raw.prepare(
      `INSERT INTO sb_entity_relations (
         id, from_entity_id, to_entity_id, relation_type, fact,
         memory_id, resolution_type, resolution_state, metadata_json, created_at
       ) VALUES (?, 'mtzs', 'old-installer', 'uses', ?, ?, 'coexists', 'active', '{}', ?),
                (?, 'mtzs', 'new-installer', 'uses', ?, ?, 'contradicts', 'review', '{}', ?)`
    ).run(
      "relation-old", "mtzs uses installation_proxy", "claim-old", 1,
      "relation-new", "mtzs uses new_installer", "claim-new", 2
    );
    raw.prepare(
      `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
       VALUES ('source-old', 'relation-old', 'claim-old', NULL, 1),
              ('source-new', 'relation-new', 'claim-new', NULL, 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_fact_resolutions (
         id, relation_id, target_relation_id, resolution_type, confidence,
         reason_codes_json, requires_review, applied_invalidation,
         source_memory_id, target_memory_id, created_at
       ) VALUES ('resolution-1', 'relation-new', 'relation-old', 'contradicts', 0.9,
                 '[]', 1, 0, 'claim-new', 'claim-old', 2)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_conflict_cases (
         id, old_memory_id, new_memory_id, old_claim_id, new_claim_id,
         conflict_type, state, created_at
       ) VALUES ('conflict-1', 'entry-old', 'entry-new', 'claim-old', 'claim-new',
                 'fact_resolution', 'pending', 2)`
    ).run();
  });

  afterEach(() => raw.close());

  it("resolves a Claim conflict and synchronizes Claim, Edge, review, relation, and audit state", async () => {
    const coordinator = new D1ResolutionCoordinator(db);
    const changed = await coordinator.applyConflictResolution({
      conflictId: "conflict-1",
      resolution: "use_new",
      resolvedBy: "mantou",
      effectiveAt: 10,
      actorType: "user",
      actorId: "mantou",
    });

    expect(changed).toBe(true);
    expect(raw.prepare(`SELECT claim_status, invalid_at, expired_at FROM sb_memories WHERE id = 'claim-old'`).get())
      .toEqual({ claim_status: "superseded", invalid_at: 10, expired_at: 10 });
    expect(raw.prepare(`SELECT claim_status FROM sb_memories WHERE id = 'claim-new'`).get())
      .toEqual({ claim_status: "confirmed" });
    expect(raw.prepare(`SELECT resolution_state, invalid_at, expired_at FROM sb_entity_relations WHERE id = 'relation-old'`).get())
      .toEqual({ resolution_state: "superseded", invalid_at: 10, expired_at: 10 });
    expect(raw.prepare(`SELECT resolution_state FROM sb_entity_relations WHERE id = 'relation-new'`).get())
      .toEqual({ resolution_state: "active" });
    expect(raw.prepare(`SELECT requires_review, applied_invalidation FROM sb_fact_resolutions WHERE id = 'resolution-1'`).get())
      .toEqual({ requires_review: 0, applied_invalidation: 1 });
    expect(raw.prepare(`SELECT relation_type FROM sb_memory_relations WHERE from_memory_id = 'entry-new' AND to_memory_id = 'entry-old'`).get())
      .toEqual({ relation_type: "supersedes" });
    expect(raw.prepare(`SELECT state, resolution FROM sb_conflict_cases WHERE id = 'conflict-1'`).get())
      .toEqual({ state: "resolved", resolution: "use_new" });
    expect(raw.prepare(`SELECT action, object_id FROM sb_audit_events WHERE object_id = 'conflict-1'`).get())
      .toEqual({ action: "quality.conflict_case.resolve", object_id: "conflict-1" });

    expect(await coordinator.applyConflictResolution({
      conflictId: "conflict-1",
      resolution: "use_new",
      resolvedBy: "mantou",
      effectiveAt: 11,
      actorType: "user",
      actorId: "mantou",
    })).toBe(false);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_audit_events WHERE object_id = 'conflict-1'`).get())
      .toEqual({ count: 1 });
  });

  it("keeps both contested Claims and activates both Fact edges", async () => {
    const changed = await new D1ResolutionCoordinator(db).applyConflictResolution({
      conflictId: "conflict-1",
      resolution: "keep_both",
      resolvedBy: "mantou",
      effectiveAt: 10,
      actorType: "user",
      actorId: "mantou",
    });

    expect(changed).toBe(true);
    expect(raw.prepare(`SELECT id, claim_status FROM sb_memories ORDER BY id`).all())
      .toEqual([
        { id: "claim-new", claim_status: "contested" },
        { id: "claim-old", claim_status: "contested" },
      ]);
    expect(raw.prepare(`SELECT id, resolution_state FROM sb_entity_relations ORDER BY id`).all())
      .toEqual([
        { id: "relation-new", resolution_state: "active" },
        { id: "relation-old", resolution_state: "active" },
      ]);
    expect(raw.prepare(`SELECT requires_review, applied_invalidation FROM sb_fact_resolutions WHERE id = 'resolution-1'`).get())
      .toEqual({ requires_review: 0, applied_invalidation: 0 });
  });

  it("keeps the old Claim and deprecates the rejected new Claim", async () => {
    const changed = await new D1ResolutionCoordinator(db).applyConflictResolution({
      conflictId: "conflict-1",
      resolution: "use_old",
      resolvedBy: "mantou",
      effectiveAt: 10,
      actorType: "user",
    });

    expect(changed).toBe(true);
    expect(raw.prepare(`SELECT claim_status FROM sb_memories WHERE id = 'claim-old'`).get())
      .toEqual({ claim_status: "confirmed" });
    expect(raw.prepare(`SELECT claim_status, invalid_at FROM sb_memories WHERE id = 'claim-new'`).get())
      .toEqual({ claim_status: "deprecated", invalid_at: 10 });
    expect(raw.prepare(`SELECT resolution_state FROM sb_entity_relations WHERE id = 'relation-old'`).get())
      .toEqual({ resolution_state: "active" });
    expect(raw.prepare(`SELECT resolution_state, invalid_at FROM sb_entity_relations WHERE id = 'relation-new'`).get())
      .toEqual({ resolution_state: "superseded", invalid_at: 10 });
    expect(raw.prepare(`SELECT relation_type FROM sb_memory_relations WHERE from_memory_id = 'entry-old' AND to_memory_id = 'entry-new'`).get())
      .toEqual({ relation_type: "supersedes" });
  });

  it("dismisses a review without promoting either Claim", async () => {
    const changed = await new D1ResolutionCoordinator(db).applyConflictResolution({
      conflictId: "conflict-1",
      state: "dismissed",
      resolution: "dismissed",
      resolvedBy: "mantou",
      effectiveAt: 10,
      actorType: "user",
    });

    expect(changed).toBe(true);
    expect(raw.prepare(`SELECT state, resolution FROM sb_conflict_cases WHERE id = 'conflict-1'`).get())
      .toEqual({ state: "dismissed", resolution: "dismissed" });
    expect(raw.prepare(`SELECT claim_status FROM sb_memories ORDER BY id`).all())
      .toEqual([{ claim_status: "supported" }, { claim_status: "supported" }]);
    expect(raw.prepare(`SELECT resolution_state FROM sb_entity_relations WHERE id = 'relation-new'`).get())
      .toEqual({ resolution_state: "active" });
  });

  it("applies an automatic supersession through the same lifecycle coordinator", async () => {
    const changed = await new D1ResolutionCoordinator(db).applySupersession({
      sourceClaimId: "claim-new",
      targetClaimId: "claim-old",
      sourceRelationId: "relation-new",
      targetRelationId: "relation-old",
      effectiveAt: 10,
      actorType: "system",
      actorId: "fact-resolver",
    });

    expect(changed).toBe(true);
    expect(raw.prepare(`SELECT claim_status FROM sb_memories WHERE id = 'claim-old'`).get())
      .toEqual({ claim_status: "superseded" });
    expect(raw.prepare(`SELECT resolution_type, resolution_state, supersedes_relation_id FROM sb_entity_relations WHERE id = 'relation-new'`).get())
      .toEqual({
        resolution_type: "supersedes",
        resolution_state: "active",
        supersedes_relation_id: "relation-old",
      });
    expect(raw.prepare(`SELECT action FROM sb_audit_events WHERE object_id = 'relation-new'`).get())
      .toEqual({ action: "fact.supersede.apply" });
  });

  it("keeps a Conflict pending when manual resolution omits final Claim and Edge outcomes", async () => {
    await expect(new D1ResolutionCoordinator(db).applyConflictResolution({
      conflictId: "conflict-1",
      resolution: "manual",
      resolvedBy: "mantou",
      effectiveAt: 10,
      actorType: "user",
    })).rejects.toBeInstanceOf(ManualResolutionOutcomeRequiredError);

    expect(raw.prepare(`SELECT claim_status FROM sb_memories ORDER BY id`).all())
      .toEqual([{ claim_status: "supported" }, { claim_status: "supported" }]);
    expect(raw.prepare(`SELECT resolution_state FROM sb_entity_relations WHERE id = 'relation-new'`).get())
      .toEqual({ resolution_state: "review" });
    expect(raw.prepare(`SELECT state, resolution FROM sb_conflict_cases WHERE id = 'conflict-1'`).get())
      .toEqual({ state: "pending", resolution: null });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_audit_events WHERE object_id = 'conflict-1'`).get())
      .toEqual({ count: 0 });
  });

  it("rejects automatic supersession when Claim and Fact Relation pairs are crossed", async () => {
    await expect(new D1ResolutionCoordinator(db).applySupersession({
      sourceClaimId: "claim-new",
      targetClaimId: "claim-old",
      sourceRelationId: "relation-old",
      targetRelationId: "relation-new",
      effectiveAt: 10,
      actorType: "system",
    })).rejects.toBeInstanceOf(ClaimRelationMismatchError);

    expect(raw.prepare(`SELECT id, claim_status FROM sb_memories ORDER BY id`).all()).toEqual([
      { id: "claim-new", claim_status: "supported" },
      { id: "claim-old", claim_status: "supported" },
    ]);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_audit_events`).get()).toEqual({ count: 0 });
  });

  it("refuses to guess a Claim when a legacy Entry has multiple active Claims", async () => {
    raw.prepare(`UPDATE sb_conflict_cases SET old_claim_id = NULL, new_claim_id = NULL WHERE id = 'conflict-1'`).run();
    raw.prepare(
      `INSERT INTO sb_memories (id, content, entry_id, claim_status, entities_json, created_at)
       VALUES ('claim-old-2', 'another old Claim', 'entry-old', 'supported', '[]', 3)`
    ).run();

    await expect(new D1ResolutionCoordinator(db).applyConflictResolution({
      conflictId: "conflict-1",
      resolution: "use_new",
      resolvedBy: "mantou",
      effectiveAt: 10,
      actorType: "user",
    })).rejects.toBeInstanceOf(ConflictClaimsUnavailableError);
    expect(raw.prepare(`SELECT state FROM sb_conflict_cases WHERE id = 'conflict-1'`).get())
      .toEqual({ state: "pending" });
  });

  it("does not apply stale lifecycle writes after another resolver wins the pending case", async () => {
    const staleDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            raw.prepare(
              `UPDATE sb_conflict_cases
               SET state = 'resolved', resolution = 'manual', resolved_by = 'other', resolved_at = 9
               WHERE id = 'conflict-1'`
            ).run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const changed = await new D1ResolutionCoordinator(staleDb).applyConflictResolution({
      conflictId: "conflict-1",
      resolution: "use_new",
      resolvedBy: "mantou",
      effectiveAt: 10,
      actorType: "user",
    });

    expect(changed).toBe(false);
    expect(raw.prepare(`SELECT id, claim_status FROM sb_memories ORDER BY id`).all())
      .toEqual([
        { id: "claim-new", claim_status: "supported" },
        { id: "claim-old", claim_status: "supported" },
      ]);
    expect(raw.prepare(`SELECT resolution_state FROM sb_entity_relations WHERE id = 'relation-new'`).get())
      .toEqual({ resolution_state: "review" });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_audit_events WHERE object_id = 'conflict-1'`).get())
      .toEqual({ count: 0 });
  });

  it("serializes concurrent opposing resolutions so only the recorded winner mutates lifecycle state", async () => {
    const coordinator = new D1ResolutionCoordinator(db);
    const [useNew, useOld] = await Promise.all([
      coordinator.applyConflictResolution({
        conflictId: "conflict-1",
        resolution: "use_new",
        resolvedBy: "new-reviewer",
        effectiveAt: 10,
        actorType: "user",
      }),
      coordinator.applyConflictResolution({
        conflictId: "conflict-1",
        resolution: "use_old",
        resolvedBy: "old-reviewer",
        effectiveAt: 11,
        actorType: "user",
      }),
    ]);

    expect([useNew, useOld].filter(Boolean)).toHaveLength(1);
    const conflict = raw.prepare(
      `SELECT resolution, resolved_by FROM sb_conflict_cases WHERE id = 'conflict-1'`
    ).get() as { resolution: string; resolved_by: string };
    const claims = raw.prepare(`SELECT id, claim_status FROM sb_memories ORDER BY id`).all();
    if (conflict.resolution === "use_new") {
      expect(claims).toEqual([
        { id: "claim-new", claim_status: "confirmed" },
        { id: "claim-old", claim_status: "superseded" },
      ]);
    } else {
      expect(conflict.resolution).toBe("use_old");
      expect(claims).toEqual([
        { id: "claim-new", claim_status: "deprecated" },
        { id: "claim-old", claim_status: "confirmed" },
      ]);
    }
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sb_audit_events WHERE object_id = 'conflict-1'`).get())
      .toEqual({ count: 1 });
  });
});
