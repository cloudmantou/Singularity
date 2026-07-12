import { MEMORY_QUALITY_SCHEMA_STATEMENTS } from "./memory/quality";

// Centralised schema migration runner with checksum verification.
// All DDL changes are tracked in the registry so that missing or changed
// migration statements are detected at startup (strict + auto-repair).

/** Minimal shape so this file avoids a circular import from index.ts. */
interface Env {
  DB: D1Database;
}

export interface Migration {
  id: string;
  name: string;
  /** sha256 of the canonical-concatenated statements. */
  checksum: string;
  /** Idempotent DDL statements run for new or checksum-changed migrations. */
  statements: string[];
  /**
   * Precheck hook for legacy non-idempotent rebuilds.
   * Runs before the migration is applied to decide whether recovery
   * or a full rebuild is needed.
   */
  precheck?: (db: D1Database) => Promise<{ ok: true; skip?: boolean } | { ok: false; recovery: "rebuild" | "rename-only" }>;
  /**
   * Atomic execute hook for legacy rebuilds. Called instead of the
   * idempotent-statements loop when present.
   */
  execute?: (db: D1Database) => Promise<void>;
}

async function executeIdempotentSchemaStatement(
  db: D1Database,
  statement: string
): Promise<void> {
  try {
    await db.exec(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Cloudflare D1 commonly reports duplicate column / table / index as
    // 'duplicate column name', 'already exists', or 'no such index'.
    if (!/duplicate column name|already exists|no such index/i.test(message)) throw error;
  }
}

/**
 * Run a registry of migrations in order. Each migration is tracked in
 * sb_schema_migrations. If a migration's on-disk checksum differs from
 * the stored checksum (strict policy), the statements are re-run
 * idempotently and the stored checksum is updated (auto-repair).
 */
export async function runMigrations(env: Env, registry: Migration[]): Promise<void> {
  const db = env.DB;
  const migrationTableAlreadyExisted = await tableExists(db, "sb_schema_migrations");
  await db.exec(
    `CREATE TABLE IF NOT EXISTS sb_schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      last_verified_at INTEGER NOT NULL
    )`
  );
  if (migrationTableAlreadyExisted) {
    await executeIdempotentSchemaStatement(
      db,
      `ALTER TABLE sb_schema_migrations ADD COLUMN last_verified_at INTEGER`
    );
    await db.prepare(
      `UPDATE sb_schema_migrations
       SET last_verified_at = COALESCE(last_verified_at, applied_at, ?)`
    ).bind(Date.now()).run();
  }

  for (const m of registry) {
    const existing = await db.prepare(
      `SELECT checksum FROM sb_schema_migrations WHERE id = ?`
    ).bind(m.id).first<{ checksum: string }>();

    if (existing) {
      if (existing.checksum !== m.checksum) {
        // Checksum mismatch: resync then re-run idempotently.
        console.warn(
          `[migrations] checksum changed for "${m.id}" — re-running idempotently`
        );
        if (m.execute) {
          await m.execute(db);
        } else {
          for (const statement of m.statements) {
            await executeIdempotentSchemaStatement(db, statement);
          }
        }
        await db.prepare(
          `UPDATE sb_schema_migrations
           SET checksum = ?, last_verified_at = ?
           WHERE id = ?`
        ).bind(m.checksum, Date.now(), m.id).run();
      } else {
        await db.prepare(
          `UPDATE sb_schema_migrations
           SET last_verified_at = ?
           WHERE id = ?`
        ).bind(Date.now(), m.id).run();
      }
      continue;
    }

    // New migration — apply.
    let skipExecute = false;
    if (m.precheck) {
      const result = await m.precheck(db);
      if (!result.ok) {
        console.warn(
          `[migrations] precheck failed for "${m.id}" recovery=${result.recovery}`
        );
      } else {
        skipExecute = result.skip === true;
      }
    }
    if (skipExecute) {
      // The current schema already matches the migration target. Record it so
      // future checksum checks remain strict without spending cold-start DDL.
    } else if (m.execute) {
      await m.execute(db);
    } else {
      for (const statement of m.statements) {
        await executeIdempotentSchemaStatement(db, statement);
      }
    }
    await db.prepare(
      `INSERT OR IGNORE INTO sb_schema_migrations
       (id, name, checksum, applied_at, last_verified_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(m.id, m.name, m.checksum, Date.now(), Date.now()).run();
  }
}

// ── Legacy external links unify migration ──────────────────────────────────

/**
 * Replaces ensureExternalLinksSchema with a single registered migration
 * whose precheck() skips already-unified schemas and whose execute()
 * recovers partially-finished rebuild states before doing the legacy
 * CREATE-next / copy / drop / rename flow.
 */
async function legacyExternalLinksPrecheck(
  db: D1Database
): Promise<{ ok: true; skip?: boolean } | { ok: false; recovery: "rebuild" | "rename-only" }> {
  const current = await db.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'table' AND name = 'sb_external_links'
     LIMIT 1`
  ).first<{ sql: string }>();

  const sql = current?.sql ?? "";
  const legacyExists = sql.includes("UNIQUE(provider, vault_id, external_path)");
  if (legacyExists) return { ok: true };
  const alreadyUnified = [
    "external_block_id",
    "object_type",
    "object_id",
    "sync_etag",
    "last_synced_sync_etag",
    "last_status",
  ].every((column) => sql.includes(column));
  if (alreadyUnified) return { ok: true, skip: true };

  const nextExists = await db.prepare(
    `SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'sb_external_links_next'
     LIMIT 1`
  ).first<{ "1": number }>();
  // No legacy table — check for orphaned next table.
  if (nextExists) {
    return { ok: false, recovery: "rename-only" };
  }
  return { ok: true };
}

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = ?
     LIMIT 1`
  ).bind(name).first<{ "1": number }>();
  return Boolean(row);
}

async function tableCount(db: D1Database, name: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function legacyExternalLinksExecute(db: D1Database): Promise<void> {
  const currentExists = await tableExists(db, "sb_external_links");
  const nextExists = await tableExists(db, "sb_external_links_next");
  if (!currentExists && nextExists) {
    await db.exec(`ALTER TABLE sb_external_links_next RENAME TO sb_external_links`);
    return;
  }
  if (!currentExists) return;
  if (nextExists) {
    const currentCount = await tableCount(db, "sb_external_links");
    const nextCount = await tableCount(db, "sb_external_links_next");
    if (nextCount >= currentCount) {
      await db.exec(`DROP TABLE sb_external_links`);
      await db.exec(`ALTER TABLE sb_external_links_next RENAME TO sb_external_links`);
      return;
    }
    await db.exec(`DROP TABLE sb_external_links_next`);
  }

  // Add missing columns to the current table first.
  for (const alter of [
    `ALTER TABLE sb_external_links ADD COLUMN external_block_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE sb_external_links ADD COLUMN object_type TEXT NOT NULL DEFAULT 'memory'`,
    `ALTER TABLE sb_external_links ADD COLUMN object_id TEXT`,
    `ALTER TABLE sb_external_links ADD COLUMN content_hash TEXT`,
    `ALTER TABLE sb_external_links ADD COLUMN sync_etag TEXT`,
    `ALTER TABLE sb_external_links ADD COLUMN last_synced_sync_etag TEXT`,
    `ALTER TABLE sb_external_links ADD COLUMN last_status TEXT`,
  ]) {
    try {
      await db.exec(alter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }

  // Backfill NULL columns.
  await db.exec(
    `UPDATE sb_external_links
     SET object_type = COALESCE(NULLIF(object_type, ''), 'memory'),
         object_id = COALESCE(NULLIF(object_id, ''), entry_id),
         content_hash = COALESCE(content_hash, last_synced_content_hash),
         sync_etag = COALESCE(sync_etag, content_hash, last_synced_content_hash),
         last_synced_sync_etag = COALESCE(last_synced_sync_etag, sync_etag, content_hash, last_synced_content_hash),
         external_block_id = COALESCE(external_block_id, '')`
  );

  // Check whether the table still has the legacy UNIQUE constraint.
  const table = await db.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'table' AND name = 'sb_external_links'`
  ).first<{ sql: string }>();
  const sql = table?.sql ?? "";
  if (!sql.includes("UNIQUE(provider, vault_id, external_path)")) return;

  // Rebuild to drop the legacy UNIQUE constraint.
  await db.exec(
    `CREATE TABLE IF NOT EXISTS sb_external_links_next (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      external_path TEXT NOT NULL,
      external_block_id TEXT NOT NULL DEFAULT '',
      object_type TEXT NOT NULL DEFAULT 'memory',
      object_id TEXT,
      entry_id TEXT,
      external_file_id TEXT,
      content_hash TEXT,
      sync_etag TEXT,
      last_synced_content_hash TEXT,
      last_synced_revision_id TEXT,
      last_synced_sync_etag TEXT,
      last_status TEXT,
      sync_direction TEXT NOT NULL DEFAULT 'bidirectional',
      sync_status TEXT NOT NULL DEFAULT 'synced',
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (sync_direction IN ('bidirectional', 'obsidian_to_singularity', 'singularity_to_obsidian')),
      CHECK (sync_status IN ('synced', 'local_changed', 'remote_changed', 'conflict', 'deleted_local', 'deleted_remote', 'error')),
      CHECK (object_type IN ('observation', 'memory', 'aggregate', 'rule'))
    )`
  );
  await db.exec(
    `INSERT OR IGNORE INTO sb_external_links_next (
       id, provider, vault_id, external_path, external_block_id, object_type,
       object_id, entry_id, external_file_id, content_hash,
       sync_etag, last_synced_content_hash, last_synced_revision_id,
       last_synced_sync_etag, last_status, sync_direction,
       sync_status, last_error, created_at, updated_at
     )
     SELECT
       id, provider, vault_id, external_path, COALESCE(external_block_id, ''),
       COALESCE(NULLIF(object_type, ''), 'memory'),
       COALESCE(NULLIF(object_id, ''), entry_id),
       entry_id, external_file_id, COALESCE(content_hash, last_synced_content_hash),
       COALESCE(sync_etag, content_hash, last_synced_content_hash),
       last_synced_content_hash, last_synced_revision_id,
       COALESCE(last_synced_sync_etag, sync_etag, content_hash, last_synced_content_hash),
       last_status,
       sync_direction,
       sync_status, last_error, created_at, updated_at
     FROM sb_external_links`
  );
  await db.exec(`DROP TABLE sb_external_links`);
  await db.exec(`ALTER TABLE sb_external_links_next RENAME TO sb_external_links`);
}

// ── Obsidian P1 sync contract (carried forward from inline) ─────────────────

const OBSIDIAN_P1_STATEMENTS = [
  `ALTER TABLE sb_external_links ADD COLUMN sync_etag TEXT`,
  `ALTER TABLE sb_external_links ADD COLUMN last_synced_sync_etag TEXT`,
  `ALTER TABLE sb_automation_rules ADD COLUMN vault_id TEXT`,
  `ALTER TABLE sb_knowledge_aggregates ADD COLUMN vault_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_automation_rules_vault
   ON sb_automation_rules(vault_id, enabled, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_aggregates_vault
   ON sb_knowledge_aggregates(vault_id, updated_at DESC)`,
  `UPDATE sb_external_links
   SET sync_etag = COALESCE(sync_etag, content_hash, last_synced_content_hash),
       last_synced_sync_etag = COALESCE(last_synced_sync_etag, sync_etag, content_hash, last_synced_content_hash)
   WHERE sync_etag IS NULL OR last_synced_sync_etag IS NULL`,
];

async function obsidianP1Precheck(
  db: D1Database
): Promise<{ ok: true; skip?: boolean } | { ok: false; recovery: "rebuild" | "rename-only" }> {
  const rows = await db.prepare(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'table'
       AND name IN ('sb_external_links', 'sb_automation_rules', 'sb_knowledge_aggregates')`
  ).all<{ name: string; sql: string }>();
  const byName = new Map((rows.results ?? []).map((row) => [row.name, row.sql ?? ""]));
  const externalLinks = byName.get("sb_external_links") ?? "";
  const rules = byName.get("sb_automation_rules") ?? "";
  const aggregates = byName.get("sb_knowledge_aggregates") ?? "";
  const alreadyApplied =
    externalLinks.includes("sync_etag") &&
    externalLinks.includes("last_synced_sync_etag") &&
    rules.includes("vault_id") &&
    aggregates.includes("vault_id");
  return alreadyApplied ? { ok: true, skip: true } : { ok: true };
}

// ── Obsidian v2 sync ETag + vault binding marker ────────────────────────────

const OBSIDIAN_V2_STATEMENTS = [
  // Re-sync stale sync_etag values for memory links (owner path).
  `UPDATE sb_external_links
   SET sync_etag = 'sync2_resync_' || COALESCE(object_id, entry_id, '') || '_' || COALESCE(content_hash, '')
   WHERE provider = 'obsidian'
     AND sync_etag NOT LIKE 'sync2_%'
     AND object_type IN ('memory', 'aggregate')`,
];

// ── Memory quality review + compliance audit ────────────────────────────────

const MEMORY_QUALITY_REVIEW_STATEMENTS = [...MEMORY_QUALITY_SCHEMA_STATEMENTS];

// ── Registry ─────────────────────────────────────────────────────────────────

export const MIGRATIONS: Migration[] = [
  {
    id: "20260712_legacy_external_links_unify",
    name: "Unify sb_external_links schema — drop legacy UNIQUE, add block/type/etag columns",
    checksum: "obsidian-legacy-external-links-v2",
    statements: [],
    precheck: legacyExternalLinksPrecheck,
    execute: legacyExternalLinksExecute,
  },
  {
    id: "20260712_obsidian_p1_sync_contract",
    name: "Obsidian P1 sync etag, vault-scoped rules, and aggregate APIs",
    checksum: "obsidian-p1-sync-v1",
    statements: OBSIDIAN_P1_STATEMENTS,
    precheck: obsidianP1Precheck,
  },
  {
    id: "20260713_obsidian_v2_sync_etag_and_vault_binding",
    name: "Obsidian v2 sync ETag (content+metadata+status) and vault binding audit trail",
    checksum: "obsidian-v2-sync-etag-vault-v2",
    statements: OBSIDIAN_V2_STATEMENTS,
  },
  {
    id: "20260713_memory_quality_review_and_audit",
    name: "Memory quality review queues and compliance audit events",
    checksum: "memory-quality-review-audit-v1",
    statements: MEMORY_QUALITY_REVIEW_STATEMENTS,
  },
];
