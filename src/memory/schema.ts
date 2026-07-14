import {
  ATOMIC_SCHEMA_BACKFILL_STATEMENTS,
  ATOMIC_OBSERVATION_MIGRATIONS,
  ATOMIC_POST_MIGRATION_INDEX_STATEMENTS,
  ATOMIC_SCHEMA_STATEMENTS,
} from "./atomic";
import { ensureEntityDataModel } from "./entities";
import {
  EVIDENCE_CONTRACT_INDEX_STATEMENTS,
  EVIDENCE_CONTRACT_SCHEMA_STATEMENTS,
  MEMORY_CLAIM_MIGRATIONS,
  MEMORY_SOURCE_PROVENANCE_MIGRATIONS,
  OBSERVATION_EVIDENCE_MIGRATIONS,
  PARENT_VERSION_METADATA_BACKFILL_STATEMENTS,
  PARENT_VERSION_METADATA_MIGRATIONS,
  PARENT_VERSION_TEMPORAL_BACKFILL_STATEMENTS,
  PARENT_VERSION_TEMPORAL_MIGRATIONS,
} from "./evidence-contract";
import { CLAIM_VECTOR_QUEUE_SCHEMA_STATEMENTS } from "./claim-vector-queue";
import { MEMORY_MUTATION_SCHEMA_STATEMENTS } from "./mutations";

const MEMORY_SCHEMA_STATEMENTS = [
  ...ATOMIC_SCHEMA_STATEMENTS,
  ...EVIDENCE_CONTRACT_SCHEMA_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS sb_memory_relations (
    id TEXT PRIMARY KEY,
    from_memory_id TEXT NOT NULL,
    to_memory_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    score REAL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    UNIQUE(from_memory_id, to_memory_id, relation_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_relations_from
    ON sb_memory_relations(from_memory_id, relation_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_relations_to
    ON sb_memory_relations(to_memory_id, relation_type, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_memory_revisions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    old_content TEXT,
    new_content TEXT,
    old_metadata_json TEXT,
    new_metadata_json TEXT,
    reason TEXT,
    actor TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_revisions_memory
    ON sb_memory_revisions(memory_id, created_at ASC)`,
  `CREATE TABLE IF NOT EXISTS sb_claim_vectors (
    claim_id TEXT NOT NULL,
    embedding_fingerprint TEXT NOT NULL,
    parent_version_id TEXT,
    content_hash TEXT NOT NULL,
    vector_ids_json TEXT NOT NULL DEFAULT '[]',
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY (claim_id, embedding_fingerprint)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_claim_vectors_parent
    ON sb_claim_vectors(parent_version_id, indexed_at DESC)`,
  ...CLAIM_VECTOR_QUEUE_SCHEMA_STATEMENTS,
  ...MEMORY_MUTATION_SCHEMA_STATEMENTS,
] as const;

async function tableColumns(db: D1Database, table: string): Promise<Set<string> | null> {
  try {
    const { results } = await db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>();
    return new Set(results.map((row) => row.name));
  } catch {
    return null;
  }
}

async function applyColumnMigrations(
  db: D1Database,
  table: string,
  migrations: readonly { column: string; statement: string }[]
): Promise<void> {
  const columns = await tableColumns(db, table);
  for (const migration of migrations) {
    if (columns?.has(migration.column)) continue;
    try {
      await db.exec(migration.statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
}

export async function ensureMemoryDataModel(db: D1Database): Promise<void> {
  for (const statement of MEMORY_SCHEMA_STATEMENTS) {
    await db.exec(statement);
  }
  await applyColumnMigrations(db, "sb_observations", [
    ...ATOMIC_OBSERVATION_MIGRATIONS,
    ...OBSERVATION_EVIDENCE_MIGRATIONS,
  ]);
  await applyColumnMigrations(db, "sb_memories", MEMORY_CLAIM_MIGRATIONS);
  await applyColumnMigrations(db, "sb_memory_sources", MEMORY_SOURCE_PROVENANCE_MIGRATIONS);
  await applyColumnMigrations(db, "sb_parent_versions", PARENT_VERSION_TEMPORAL_MIGRATIONS);
  await applyColumnMigrations(db, "sb_parent_versions", PARENT_VERSION_METADATA_MIGRATIONS);
  for (const statement of PARENT_VERSION_TEMPORAL_BACKFILL_STATEMENTS) {
    await db.exec(statement);
  }
  for (const statement of PARENT_VERSION_METADATA_BACKFILL_STATEMENTS) {
    await db.exec(statement);
  }
  for (const statement of ATOMIC_POST_MIGRATION_INDEX_STATEMENTS) {
    await db.exec(statement);
  }
  for (const statement of EVIDENCE_CONTRACT_INDEX_STATEMENTS) {
    await db.exec(statement);
  }
  for (const statement of ATOMIC_SCHEMA_BACKFILL_STATEMENTS) {
    await db.exec(statement);
  }
  await ensureEntityDataModel(db);
}
