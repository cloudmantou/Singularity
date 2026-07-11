import { importEntries, type ImportMode, type ImportOptions, type ImportResult } from "../import-entries";

export const MEMORY_BACKUP_SCHEMA_VERSION = 4;

const GRAPH_ARRAY_KEYS = [
  "observations",
  "memories",
  "memorySources",
  "entities",
  "memoryEntities",
  "entityRelations",
  "memoryRelations",
  "revisions",
] as const;

type GraphArrayKey = (typeof GRAPH_ARRAY_KEYS)[number];
type BackupRow = Record<string, unknown>;

export interface TableImportStats {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
}

export interface BackupIntegrityReport {
  ok: boolean;
  issues: Record<string, number>;
}

export interface MemoryBackupV4 {
  schemaVersion: 4;
  exportedAt: string;
  source: string;
  totals: Record<string, number>;
  integrity: BackupIntegrityReport;
  entries: BackupRow[];
  observations: BackupRow[];
  memories: BackupRow[];
  memorySources: BackupRow[];
  entities: BackupRow[];
  memoryEntities: BackupRow[];
  entityRelations: BackupRow[];
  memoryRelations: BackupRow[];
  revisions: BackupRow[];
}

export interface MemoryBackupImportResult extends ImportResult {
  schemaVersion: 4;
  graph: Record<GraphArrayKey, TableImportStats>;
  integrity: BackupIntegrityReport;
}

function arrayFrom(value: unknown): BackupRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is BackupRow => Boolean(row) && typeof row === "object" && !Array.isArray(row));
}

export function isMemoryBackupPayload(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return record.schemaVersion === MEMORY_BACKUP_SCHEMA_VERSION ||
    GRAPH_ARRAY_KEYS.some((key) => Array.isArray(record[key]));
}

export function memoryBackupRowCount(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  const record = body as Record<string, unknown>;
  const entries = Array.isArray(record.entries) ? record.entries.length : 0;
  return entries + GRAPH_ARRAY_KEYS.reduce((sum, key) => {
    const value = record[key];
    return sum + (Array.isArray(value) ? value.length : 0);
  }, 0);
}

async function allRows<T extends BackupRow>(db: D1Database, sql: string): Promise<T[]> {
  const { results } = await db.prepare(sql).all<T>();
  return (results ?? []) as T[];
}

async function firstRow<T extends BackupRow>(db: D1Database, sql: string): Promise<T | null> {
  return await db.prepare(sql).first<T>();
}

function countRows(rows: unknown[]): number {
  return Array.isArray(rows) ? rows.length : 0;
}

export async function inspectMemoryBackupIntegrity(db: D1Database): Promise<BackupIntegrityReport> {
  const row = await firstRow<Record<string, unknown>>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM sb_memory_sources s
        LEFT JOIN sb_memories m ON m.id = s.memory_id
        WHERE m.id IS NULL) as memory_sources_missing_memory,
       (SELECT COUNT(*) FROM sb_memory_sources s
        LEFT JOIN sb_observations o ON o.id = s.observation_id
        WHERE o.id IS NULL) as memory_sources_missing_observation,
       (SELECT COUNT(*) FROM sb_memory_entities me
        LEFT JOIN sb_memories m ON m.id = me.memory_id
        WHERE m.id IS NULL) as memory_entities_missing_memory,
       (SELECT COUNT(*) FROM sb_memory_entities me
        LEFT JOIN sb_entities e ON e.id = me.entity_id
        WHERE e.id IS NULL) as memory_entities_missing_entity,
       (SELECT COUNT(*) FROM sb_entity_relations er
        LEFT JOIN sb_entities e ON e.id = er.from_entity_id
        WHERE e.id IS NULL) as entity_relations_missing_from_entity,
       (SELECT COUNT(*) FROM sb_entity_relations er
        LEFT JOIN sb_entities e ON e.id = er.to_entity_id
        WHERE e.id IS NULL) as entity_relations_missing_to_entity,
       (SELECT COUNT(*) FROM sb_entity_relations er
        LEFT JOIN sb_memories m ON m.id = er.memory_id
        WHERE er.memory_id IS NOT NULL AND m.id IS NULL) as entity_relations_missing_memory,
       (SELECT COUNT(*) FROM sb_entity_relations er
        LEFT JOIN sb_observations o ON o.id = er.observation_id
        WHERE er.observation_id IS NOT NULL AND o.id IS NULL) as entity_relations_missing_observation,
       (SELECT COUNT(*) FROM sb_memory_relations r
        LEFT JOIN entries e ON e.id = r.from_memory_id
        WHERE e.id IS NULL) as memory_relations_missing_from_entry,
       (SELECT COUNT(*) FROM sb_memory_relations r
        LEFT JOIN entries e ON e.id = r.to_memory_id
        WHERE e.id IS NULL) as memory_relations_missing_to_entry,
       (SELECT COUNT(*) FROM sb_memory_revisions r
        LEFT JOIN entries e ON e.id = r.memory_id
        WHERE e.id IS NULL) as revisions_missing_entry`
  );
  const issues: Record<string, number> = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    issues[key] = Number(value ?? 0);
  }
  return {
    ok: Object.values(issues).every((count) => count === 0),
    issues,
  };
}

export async function exportMemoryBackup(
  db: D1Database,
  input: { source: string }
): Promise<MemoryBackupV4> {
  const [
    entries,
    observations,
    memories,
    memorySources,
    entities,
    memoryEntities,
    entityRelations,
    memoryRelations,
    revisions,
  ] = await Promise.all([
    allRows(db, `SELECT id, content, tags, source, created_at, vector_ids,
                       recall_count, importance_score, classification_confidence,
                       classification_status, classification_error, classification_attempts,
                       classification_next_attempt_at, classification_started_at,
                       classification_version, classified_at,
                       contradiction_wins, contradiction_losses, content_hash,
                       embedding_fingerprint, pending_vector_ids,
                       pending_embedding_fingerprint, pending_content_hash
                FROM entries
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, content, source, metadata_json, content_hash,
                       extraction_status, extraction_version, extraction_attempts,
                       extraction_error, next_attempt_at, processing_started_at,
                       processed_at, needs_reprocess, created_at
                FROM sb_observations
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, content, kind, memory_class, importance, confidence,
                       entry_id, content_hash, observed_at, valid_from, valid_to,
                       reference_time, invalid_at, expired_at, entities_json, created_at
                FROM sb_memories
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, memory_id, observation_id, role, score, created_at
                FROM sb_memory_sources
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, name, name_normalized, entity_type, aliases_json,
                       metadata_json, mention_count, created_at, updated_at
                FROM sb_entities
                ORDER BY updated_at DESC, id DESC`),
    allRows(db, `SELECT id, memory_id, entity_id, role, score, created_at
                FROM sb_memory_entities
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, from_entity_id, to_entity_id, relation_type, fact,
                       memory_id, observation_id, score, valid_from, valid_to,
                       invalid_at, expired_at, reference_time, metadata_json, created_at
                FROM sb_entity_relations
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, from_memory_id, to_memory_id, relation_type,
                       score, metadata_json, created_at
                FROM sb_memory_relations
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, memory_id, event_type, old_content, new_content,
                       old_metadata_json, new_metadata_json, reason, actor, created_at
                FROM sb_memory_revisions
                ORDER BY created_at DESC, id DESC`),
  ]);

  return {
    schemaVersion: MEMORY_BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    source: input.source,
    totals: {
      entries: countRows(entries),
      observations: countRows(observations),
      memories: countRows(memories),
      memorySources: countRows(memorySources),
      entities: countRows(entities),
      memoryEntities: countRows(memoryEntities),
      entityRelations: countRows(entityRelations),
      memoryRelations: countRows(memoryRelations),
      revisions: countRows(revisions),
    },
    integrity: await inspectMemoryBackupIntegrity(db),
    entries,
    observations,
    memories,
    memorySources,
    entities,
    memoryEntities,
    entityRelations,
    memoryRelations,
    revisions,
  };
}

function requiredText(row: BackupRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function textOrNull(row: BackupRow, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value !== "string") return String(value);
  return value;
}

function textOrDefault(row: BackupRow, key: string, fallback: string): string {
  const value = textOrNull(row, key);
  return value == null || value === "" ? fallback : value;
}

function numberOrNull(row: BackupRow, key: string): number | null {
  const value = row[key];
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrDefault(row: BackupRow, key: string, fallback: number): number {
  return numberOrNull(row, key) ?? fallback;
}

function intOrDefault(row: BackupRow, key: string, fallback: number): number {
  return Math.trunc(numberOrDefault(row, key, fallback));
}

function jsonText(row: BackupRow, key: string, fallback: string): string {
  const value = row[key];
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return fallback;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function insertVerb(mode: ImportMode): "INSERT OR IGNORE" | "INSERT OR REPLACE" {
  return mode === "overwrite" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
}

async function importTable(
  db: D1Database,
  rows: BackupRow[],
  prepare: (row: BackupRow) => D1PreparedStatement
): Promise<TableImportStats> {
  const stats: TableImportStats = {
    total: rows.length,
    imported: 0,
    skipped: 0,
    failed: 0,
  };
  for (const row of rows) {
    try {
      const result = await prepare(row).run();
      const changes = Number(result.meta?.changes ?? 0);
      if (changes > 0) stats.imported += 1;
      else stats.skipped += 1;
    } catch {
      stats.failed += 1;
    }
  }
  return stats;
}

function rowsFor(body: Record<string, unknown>, key: GraphArrayKey): BackupRow[] {
  return arrayFrom(body[key]);
}

export async function importMemoryBackup(
  db: D1Database,
  body: Record<string, unknown>,
  options: ImportOptions = {}
): Promise<MemoryBackupImportResult> {
  const mode: ImportMode = options.mode === "overwrite" ? "overwrite" : "skip";
  const entries = arrayFrom(body.entries);
  const entryResult = await importEntries(db, entries, {
    ...options,
    mode,
    extraTags: options.extraTags ?? [],
  });

  const graph = {} as Record<GraphArrayKey, TableImportStats>;

  graph.observations = await importTable(db, rowsFor(body, "observations"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_observations (
         id, content, source, metadata_json, content_hash,
         extraction_status, extraction_version, extraction_attempts,
         extraction_error, next_attempt_at, processing_started_at,
         processed_at, needs_reprocess, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "content"),
      textOrDefault(row, "source", "import"),
      jsonText(row, "metadata_json", "{}"),
      textOrNull(row, "content_hash"),
      textOrDefault(row, "extraction_status", "pending"),
      intOrDefault(row, "extraction_version", 1),
      intOrDefault(row, "extraction_attempts", 0),
      textOrNull(row, "extraction_error"),
      numberOrNull(row, "next_attempt_at"),
      numberOrNull(row, "processing_started_at"),
      numberOrNull(row, "processed_at"),
      intOrDefault(row, "needs_reprocess", 0),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.memories = await importTable(db, rowsFor(body, "memories"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_memories (
         id, content, kind, memory_class, importance, confidence,
         entry_id, content_hash, observed_at, valid_from, valid_to,
         reference_time, invalid_at, expired_at, entities_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "content"),
      textOrNull(row, "kind"),
      textOrNull(row, "memory_class"),
      numberOrNull(row, "importance"),
      numberOrNull(row, "confidence"),
      textOrNull(row, "entry_id"),
      textOrNull(row, "content_hash"),
      numberOrNull(row, "observed_at"),
      numberOrNull(row, "valid_from"),
      numberOrNull(row, "valid_to"),
      numberOrNull(row, "reference_time"),
      numberOrNull(row, "invalid_at"),
      numberOrNull(row, "expired_at"),
      jsonText(row, "entities_json", "[]"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.memorySources = await importTable(db, rowsFor(body, "memorySources"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_memory_sources (
         id, memory_id, observation_id, role, score, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "memory_id"),
      requiredText(row, "observation_id"),
      textOrDefault(row, "role", "derived_from"),
      numberOrNull(row, "score"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.entities = await importTable(db, rowsFor(body, "entities"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entities (
         id, name, name_normalized, entity_type, aliases_json,
         metadata_json, mention_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "name"),
      textOrDefault(row, "name_normalized", requiredText(row, "name").toLowerCase()),
      textOrNull(row, "entity_type"),
      jsonText(row, "aliases_json", "[]"),
      jsonText(row, "metadata_json", "{}"),
      intOrDefault(row, "mention_count", 0),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.memoryEntities = await importTable(db, rowsFor(body, "memoryEntities"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_memory_entities (
         id, memory_id, entity_id, role, score, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "memory_id"),
      requiredText(row, "entity_id"),
      textOrDefault(row, "role", "mentions"),
      numberOrNull(row, "score"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.entityRelations = await importTable(db, rowsFor(body, "entityRelations"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entity_relations (
         id, from_entity_id, to_entity_id, relation_type, fact, memory_id,
         observation_id, score, valid_from, valid_to, invalid_at, expired_at,
         reference_time, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "from_entity_id"),
      requiredText(row, "to_entity_id"),
      textOrDefault(row, "relation_type", "related_to"),
      textOrNull(row, "fact"),
      textOrNull(row, "memory_id"),
      textOrNull(row, "observation_id"),
      numberOrNull(row, "score"),
      numberOrNull(row, "valid_from"),
      numberOrNull(row, "valid_to"),
      numberOrNull(row, "invalid_at"),
      numberOrNull(row, "expired_at"),
      numberOrNull(row, "reference_time"),
      jsonText(row, "metadata_json", "{}"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.memoryRelations = await importTable(db, rowsFor(body, "memoryRelations"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_memory_relations (
         id, from_memory_id, to_memory_id, relation_type, score, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "from_memory_id"),
      requiredText(row, "to_memory_id"),
      textOrDefault(row, "relation_type", "derived_from"),
      numberOrNull(row, "score"),
      jsonText(row, "metadata_json", "{}"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.revisions = await importTable(db, rowsFor(body, "revisions"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_memory_revisions (
         id, memory_id, event_type, old_content, new_content,
         old_metadata_json, new_metadata_json, reason, actor, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "memory_id"),
      textOrDefault(row, "event_type", "ADD"),
      textOrNull(row, "old_content"),
      textOrNull(row, "new_content"),
      jsonText(row, "old_metadata_json", "{}"),
      jsonText(row, "new_metadata_json", "{}"),
      textOrNull(row, "reason"),
      textOrDefault(row, "actor", "import"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  return {
    ...entryResult,
    schemaVersion: MEMORY_BACKUP_SCHEMA_VERSION,
    graph,
    integrity: await inspectMemoryBackupIntegrity(db),
  };
}
