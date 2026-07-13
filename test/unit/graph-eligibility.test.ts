import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEntityGraph, listActiveEntityRelations } from "../../src/memory/entities";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("graph Claim eligibility", () => {
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
    raw.prepare(
      `INSERT INTO sb_entities (
         id, name, name_normalized, entity_type, aliases_json, metadata_json,
         mention_count, created_at, updated_at
       ) VALUES ('entity-project', 'Singularity', 'singularity', 'project', '[]', '{}', 3, 1, 1),
                ('entity-active', 'SQLite', 'sqlite', 'product', '[]', '{}', 1, 1, 1),
                ('entity-failed', 'LeakedDB', 'leakeddb', 'product', '[]', '{}', 1, 1, 1),
                ('entity-stale', 'StaleDB', 'staledb', 'product', '[]', '{}', 1, 1, 1),
                ('entity-review', 'ReviewDB', 'reviewdb', 'product', '[]', '{}', 1, 1, 1),
                ('entity-terminal', 'TerminalDB', 'terminaldb', 'product', '[]', '{}', 1, 1, 1),
                ('entity-orphan', 'OrphanDB', 'orphandb', 'product', '[]', '{}', 1, 1, 1)`
    ).run();
  });

  afterEach(() => raw.close());

  async function seedFact(input: {
    suffix: string;
    targetId: string;
    parentState: "active" | "failed" | null;
    entryHash: string;
    claimHash: string;
  }): Promise<void> {
    const { suffix, targetId, parentState, entryHash, claimHash } = input;
    raw.prepare(`INSERT INTO entries (id, content, content_hash) VALUES (?, ?, ?)`).run(
      `entry-${suffix}`, `fact-${suffix}`, entryHash
    );
    raw.prepare(
      `INSERT INTO sb_observations (
         id, content, source, metadata_json, content_hash,
         extraction_status, extraction_version, extraction_attempts,
         needs_reprocess, created_at
       ) VALUES (?, ?, 'api', '{}', ?, 'succeeded', 1, 1, 0, 1)`
    ).run(`observation-${suffix}`, `fact-${suffix}`, claimHash);
    raw.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, claim_status, content_hash,
         invalid_at, expired_at, entities_json, created_at
       ) VALUES (?, ?, ?, 'supported', ?, NULL, NULL, '[]', 1)`
    ).run(`claim-${suffix}`, `fact-${suffix}`, `entry-${suffix}`, claimHash);
    raw.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, created_at
       ) VALUES (?, ?, ?, 'derived_from', 'supports', 1)`
    ).run(`memory-source-${suffix}`, `claim-${suffix}`, `observation-${suffix}`);
    if (parentState) {
      raw.prepare(
        `INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
         VALUES (?, ?, 1, 1)`
      ).run(`parent-${suffix}`, `version-${suffix}`);
      raw.prepare(
        `INSERT INTO sb_parent_versions (
           version_id, parent_id, version_number, source_observation_id,
           source_snapshot_hash, state, summary_vector_ids, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, ?, '[]', 1, 1)`
      ).run(`version-${suffix}`, `parent-${suffix}`, `observation-${suffix}`, claimHash, parentState);
      raw.prepare(
        `INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
         VALUES (?, ?, 'supports', 1)`
      ).run(`version-${suffix}`, `claim-${suffix}`);
    }
    raw.prepare(
      `INSERT INTO sb_memory_entities (id, memory_id, entity_id, role, created_at)
       VALUES (?, ?, 'entity-project', 'mentions', 1)`
    ).run(`memory-entity-${suffix}`, `claim-${suffix}`);
    raw.prepare(
      `INSERT INTO sb_entity_relations (
         id, from_entity_id, to_entity_id, relation_type, fact, memory_id,
         resolution_state, metadata_json, created_at
       ) VALUES (?, 'entity-project', ?, 'uses', ?, ?, 'active', '{}', 1)`
    ).run(`relation-${suffix}`, targetId, `fact-${suffix}`, `claim-${suffix}`);
    raw.prepare(
      `INSERT INTO sb_fact_sources (id, relation_id, memory_id, observation_id, created_at)
       VALUES (?, ?, ?, ?, 1)`
    ).run(`fact-source-${suffix}`, `relation-${suffix}`, `claim-${suffix}`, `observation-${suffix}`);
  }

  it("exposes only facts backed by an active Parent, eligible Claim, Provenance, and matching Entry hash", async () => {
    await seedFact({ suffix: "active", targetId: "entity-active", parentState: "active", entryHash: "hash-active", claimHash: "hash-active" });
    await seedFact({ suffix: "failed", targetId: "entity-failed", parentState: "failed", entryHash: "hash-failed", claimHash: "hash-failed" });
    await seedFact({ suffix: "stale", targetId: "entity-stale", parentState: "active", entryHash: "entry-stale", claimHash: "claim-stale" });
    await seedFact({ suffix: "review", targetId: "entity-review", parentState: "active", entryHash: "hash-review", claimHash: "hash-review" });
    await seedFact({ suffix: "terminal", targetId: "entity-terminal", parentState: "active", entryHash: "hash-terminal", claimHash: "hash-terminal" });
    await seedFact({ suffix: "orphan", targetId: "entity-orphan", parentState: null, entryHash: "hash-orphan", claimHash: "hash-orphan" });
    raw.prepare(`UPDATE sb_entity_relations SET resolution_state = 'review' WHERE id = 'relation-review'`).run();
    raw.prepare(`UPDATE sb_memories SET claim_status = 'superseded' WHERE id = 'claim-terminal'`).run();

    const facts = await listActiveEntityRelations(db, { asOf: 10, limit: 20 });
    expect(facts.map((fact) => fact.id)).toEqual(["relation-active"]);

    const graph = await getEntityGraph(db, "entity-project", 20);
    expect(graph.relations.map((relation) => relation.id)).toEqual(["relation-active"]);
    expect(graph.memories.map((memory) => memory.id).sort()).toEqual([
      "claim-active",
      "claim-review",
    ]);
  });
});
