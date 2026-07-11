import {
  ATOMIC_SCHEMA_BACKFILL_STATEMENTS,
  ATOMIC_OBSERVATION_MIGRATIONS,
  ATOMIC_POST_MIGRATION_INDEX_STATEMENTS,
  ATOMIC_SCHEMA_STATEMENTS,
} from "./atomic";
import { ensureEntityDataModel } from "./entities";

const MEMORY_SCHEMA_STATEMENTS = [
  ...ATOMIC_SCHEMA_STATEMENTS,
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
] as const;

export async function ensureMemoryDataModel(db: D1Database): Promise<void> {
  for (const statement of MEMORY_SCHEMA_STATEMENTS) {
    await db.exec(statement);
  }
  let observationColumns: Set<string> | null = null;
  try {
    const { results } = await db
      .prepare(`PRAGMA table_info(sb_observations)`)
      .all<{ name: string }>();
    observationColumns = new Set(results.map((row) => row.name));
  } catch {
    observationColumns = null;
  }

  for (const migration of ATOMIC_OBSERVATION_MIGRATIONS) {
    if (observationColumns?.has(migration.column)) continue;
    try {
      await db.exec(migration.statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
  for (const statement of ATOMIC_POST_MIGRATION_INDEX_STATEMENTS) {
    await db.exec(statement);
  }
  for (const statement of ATOMIC_SCHEMA_BACKFILL_STATEMENTS) {
    await db.exec(statement);
  }
  await ensureEntityDataModel(db);
}
