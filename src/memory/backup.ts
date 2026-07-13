import { importEntries, type ImportMode, type ImportOptions, type ImportResult } from "../import-entries";
import { ensureEntityResolutionDataModel } from "./entities";
import { ensureConflictClaimSchema } from "./quality";
import { ensureAssociationDataModel } from "./associations";

export const MEMORY_BACKUP_SCHEMA_VERSION = 13;
const MEMORY_BACKUP_FORMAT = "singularity-memory-backup";
const SUPPORTED_MEMORY_BACKUP_SCHEMA_VERSIONS = new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
const MEMORY_BACKUP_FEATURES = [
  "atomic-memory",
  "temporal-facts",
  "fact-sources",
  "embedding-fingerprints",
  "quality-review",
  "compliance-audit",
  "evidence-claim-provenance",
  "parent-versions",
  "parent-version-claims",
  "parent-version-time-windows",
  "parent-version-time-provenance",
  "parent-version-metadata-snapshots",
  "entity-resolution",
  "entity-merge-execution",
  "fact-resolution",
  "claim-level-conflicts",
  "association-graph",
  "association-validity-windows",
] as const;

const GRAPH_ARRAY_KEYS = [
  "scopes",
  "parentUnits",
  "parentVersions",
  "parentVersionClaims",
  "associationEdges",
  "associationEdgeHistory",
  "observations",
  "memories",
  "memorySources",
  "entities",
  "entityAliases",
  "entityAliasSources",
  "entityExternalIds",
  "entityExternalIdSources",
  "entityEmbeddings",
  "entityMergeCandidates",
  "entityMergeHistory",
  "memoryEntities",
  "entityRelations",
  "factResolutions",
  "factSources",
  "memoryRelations",
  "revisions",
  "mergeCandidates",
  "conflictCases",
  "auditEvents",
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

export interface MemoryBackup {
  backupFormat: typeof MEMORY_BACKUP_FORMAT;
  schemaVersion: 13;
  features: Array<(typeof MEMORY_BACKUP_FEATURES)[number]>;
  exportedAt: string;
  source: string;
  totals: Record<string, number>;
  integrity: BackupIntegrityReport;
  scopes: BackupRow[];
  parentUnits: BackupRow[];
  parentVersions: BackupRow[];
  parentVersionClaims: BackupRow[];
  associationEdges: BackupRow[];
  associationEdgeHistory: BackupRow[];
  entries: BackupRow[];
  observations: BackupRow[];
  memories: BackupRow[];
  memorySources: BackupRow[];
  entities: BackupRow[];
  entityAliases: BackupRow[];
  entityAliasSources: BackupRow[];
  entityExternalIds: BackupRow[];
  entityExternalIdSources: BackupRow[];
  entityEmbeddings: BackupRow[];
  entityMergeCandidates: BackupRow[];
  entityMergeHistory: BackupRow[];
  memoryEntities: BackupRow[];
  entityRelations: BackupRow[];
  factResolutions: BackupRow[];
  factSources: BackupRow[];
  memoryRelations: BackupRow[];
  revisions: BackupRow[];
  mergeCandidates: BackupRow[];
  conflictCases: BackupRow[];
  auditEvents: BackupRow[];
}

export interface MemoryBackupImportResult extends ImportResult {
  schemaVersion: 13;
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
  const schemaVersion = Number(record.schemaVersion);
  if (schemaVersion === MEMORY_BACKUP_SCHEMA_VERSION) {
    return record.backupFormat === MEMORY_BACKUP_FORMAT;
  }
  if (SUPPORTED_MEMORY_BACKUP_SCHEMA_VERSIONS.has(schemaVersion)) {
    return schemaVersion === 4 || record.backupFormat === MEMORY_BACKUP_FORMAT;
  }
  return Number.isFinite(schemaVersion) && schemaVersion > MEMORY_BACKUP_SCHEMA_VERSION;
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
       (SELECT COUNT(*) FROM sb_parent_versions pv
        LEFT JOIN sb_parent_units pu ON pu.parent_id = pv.parent_id
        WHERE pu.parent_id IS NULL) as parent_versions_missing_parent,
       (SELECT COUNT(*) FROM sb_parent_units pu
        LEFT JOIN sb_parent_versions pv ON pv.version_id = pu.active_version_id
        WHERE pu.active_version_id IS NOT NULL AND pv.version_id IS NULL) as parent_units_missing_active_version,
       (SELECT COUNT(*) FROM sb_memories m
        LEFT JOIN sb_parent_versions pv ON pv.version_id = m.parent_version_id
        WHERE m.parent_version_id IS NOT NULL AND pv.version_id IS NULL) as memories_missing_parent_version,
       (SELECT COUNT(*) FROM sb_parent_version_claims pvc
        LEFT JOIN sb_parent_versions pv ON pv.version_id = pvc.parent_version_id
        WHERE pv.version_id IS NULL) as parent_version_claims_missing_parent_version,
       (SELECT COUNT(*) FROM sb_parent_version_claims pvc
        LEFT JOIN sb_memories m ON m.id = pvc.memory_id
        WHERE m.id IS NULL) as parent_version_claims_missing_memory,
       (SELECT COUNT(*) FROM sb_claim_vectors cv
        LEFT JOIN sb_memories m ON m.id = cv.claim_id
        WHERE m.id IS NULL) as claim_vectors_missing_claim,
       (SELECT COUNT(*) FROM sb_association_edges ae
        LEFT JOIN sb_parent_units pu ON pu.parent_id = ae.source_parent_id
        WHERE pu.parent_id IS NULL) as association_edges_missing_source_parent,
       (SELECT COUNT(*) FROM sb_association_edges ae
        LEFT JOIN sb_parent_units pu ON pu.parent_id = ae.target_parent_id
        WHERE pu.parent_id IS NULL) as association_edges_missing_target_parent,
       (SELECT COUNT(*) FROM sb_association_edge_history ae
        LEFT JOIN sb_parent_units pu ON pu.parent_id = ae.source_parent_id
        WHERE pu.parent_id IS NULL) as association_history_missing_source_parent,
       (SELECT COUNT(*) FROM sb_association_edge_history ae
        LEFT JOIN sb_parent_units pu ON pu.parent_id = ae.target_parent_id
        WHERE pu.parent_id IS NULL) as association_history_missing_target_parent,
       (SELECT COUNT(*) FROM sb_entity_aliases a
        LEFT JOIN sb_entities e ON e.id = a.entity_id
        WHERE e.id IS NULL) as entity_aliases_missing_entity,
       (SELECT COUNT(*) FROM sb_entity_alias_sources s
        LEFT JOIN sb_entity_aliases a ON a.id = s.alias_id
        WHERE a.id IS NULL) as entity_alias_sources_missing_alias,
       (SELECT COUNT(*) FROM sb_entity_alias_sources s
        LEFT JOIN sb_observations o ON o.id = s.observation_id
        WHERE o.id IS NULL) as entity_alias_sources_missing_observation,
       (SELECT COUNT(*) FROM sb_entity_external_ids x
        LEFT JOIN sb_entities e ON e.id = x.entity_id
        WHERE e.id IS NULL) as entity_external_ids_missing_entity,
       (SELECT COUNT(*) FROM sb_entity_external_id_sources s
        LEFT JOIN sb_entity_external_ids x ON x.id = s.external_id_id
        WHERE x.id IS NULL) as entity_external_id_sources_missing_external_id,
       (SELECT COUNT(*) FROM sb_entity_external_id_sources s
        LEFT JOIN sb_observations o ON o.id = s.observation_id
        WHERE o.id IS NULL) as entity_external_id_sources_missing_observation,
       (SELECT COUNT(*) FROM sb_entity_embeddings x
        LEFT JOIN sb_entities e ON e.id = x.entity_id
        WHERE e.id IS NULL) as entity_embeddings_missing_entity,
       (SELECT COUNT(*) FROM sb_entity_merge_candidates c
        LEFT JOIN sb_entities e ON e.id = c.source_entity_id
        WHERE e.id IS NULL) as entity_merge_candidates_missing_source,
       (SELECT COUNT(*) FROM sb_entity_merge_candidates c
        LEFT JOIN sb_entities e ON e.id = c.target_entity_id
        WHERE e.id IS NULL) as entity_merge_candidates_missing_target,
       (SELECT COUNT(*) FROM sb_entity_merge_history h
        LEFT JOIN sb_entities e ON e.id = h.source_entity_id
        WHERE e.id IS NULL) as entity_merge_history_missing_source,
       (SELECT COUNT(*) FROM sb_entity_merge_history h
        LEFT JOIN sb_entities e ON e.id = h.target_entity_id
        WHERE e.id IS NULL) as entity_merge_history_missing_target,
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
       (SELECT COUNT(*) FROM sb_entity_relations er
        LEFT JOIN sb_entity_relations superseded ON superseded.id = er.supersedes_relation_id
        WHERE er.supersedes_relation_id IS NOT NULL AND superseded.id IS NULL) as entity_relations_missing_superseded_relation,
       (SELECT COUNT(*) FROM sb_fact_sources fs
        LEFT JOIN sb_entity_relations er ON er.id = fs.relation_id
        WHERE er.id IS NULL) as fact_sources_missing_relation,
       (SELECT COUNT(*) FROM sb_fact_sources fs
        LEFT JOIN sb_memories m ON m.id = fs.memory_id
        WHERE fs.memory_id IS NOT NULL AND m.id IS NULL) as fact_sources_missing_memory,
       (SELECT COUNT(*) FROM sb_fact_sources fs
        LEFT JOIN sb_observations o ON o.id = fs.observation_id
        WHERE fs.observation_id IS NOT NULL AND o.id IS NULL) as fact_sources_missing_observation,
       (SELECT COUNT(*) FROM sb_fact_resolutions fr
        LEFT JOIN sb_entity_relations er ON er.id = fr.relation_id
        WHERE er.id IS NULL) as fact_resolutions_missing_relation,
       (SELECT COUNT(*) FROM sb_fact_resolutions fr
        LEFT JOIN sb_entity_relations er ON er.id = fr.target_relation_id
        WHERE fr.target_relation_id IS NOT NULL AND er.id IS NULL) as fact_resolutions_missing_target_relation,
       (SELECT COUNT(*) FROM sb_fact_resolutions fr
        WHERE fr.target_relation_id = fr.relation_id) as fact_resolutions_self_referential,
       (SELECT COUNT(*) FROM sb_fact_resolutions fr
        LEFT JOIN sb_memories m ON m.id = fr.source_memory_id
        WHERE fr.source_memory_id IS NOT NULL AND m.id IS NULL) as fact_resolutions_missing_source_memory,
       (SELECT COUNT(*) FROM sb_fact_resolutions fr
        LEFT JOIN sb_memories m ON m.id = fr.target_memory_id
        WHERE fr.target_memory_id IS NOT NULL AND m.id IS NULL) as fact_resolutions_missing_target_memory,
       (SELECT COUNT(*) FROM sb_memory_relations r
        LEFT JOIN entries e ON e.id = r.from_memory_id
        WHERE e.id IS NULL) as memory_relations_missing_from_entry,
       (SELECT COUNT(*) FROM sb_memory_relations r
        LEFT JOIN entries e ON e.id = r.to_memory_id
        WHERE e.id IS NULL) as memory_relations_missing_to_entry,
       (SELECT COUNT(*) FROM sb_memory_revisions r
        LEFT JOIN entries e ON e.id = r.memory_id
        WHERE e.id IS NULL) as revisions_missing_entry,
       (SELECT COUNT(*) FROM sb_memory_merge_candidates c
        LEFT JOIN entries e ON e.id = c.source_memory_id
        WHERE e.id IS NULL) as merge_candidates_missing_source,
       (SELECT COUNT(*) FROM sb_memory_merge_candidates c
        LEFT JOIN entries e ON e.id = c.target_memory_id
        WHERE e.id IS NULL) as merge_candidates_missing_target,
       (SELECT COUNT(*) FROM sb_conflict_cases c
        LEFT JOIN entries e ON e.id = c.old_memory_id
        WHERE e.id IS NULL) as conflict_cases_missing_old,
       (SELECT COUNT(*) FROM sb_conflict_cases c
        LEFT JOIN entries e ON e.id = c.new_memory_id
        WHERE e.id IS NULL) as conflict_cases_missing_new,
       (SELECT COUNT(*) FROM sb_conflict_cases c
        LEFT JOIN sb_memories m ON m.id = c.old_claim_id
        WHERE c.old_claim_id IS NOT NULL AND m.id IS NULL) as conflict_cases_missing_old_claim,
       (SELECT COUNT(*) FROM sb_conflict_cases c
        LEFT JOIN sb_memories m ON m.id = c.new_claim_id
        WHERE c.new_claim_id IS NOT NULL AND m.id IS NULL) as conflict_cases_missing_new_claim`
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
): Promise<MemoryBackup> {
  await ensureEntityResolutionDataModel(db);
  await ensureConflictClaimSchema(db);
  await ensureAssociationDataModel(db);
  const [
    scopes,
    parentUnits,
    parentVersions,
    parentVersionClaims,
    associationEdges,
    associationEdgeHistory,
    entries,
    observations,
    memories,
    memorySources,
    entities,
    entityAliases,
    entityAliasSources,
    entityExternalIds,
    entityExternalIdSources,
    entityEmbeddings,
    entityMergeCandidates,
    entityMergeHistory,
    memoryEntities,
    entityRelations,
    factResolutions,
    factSources,
    memoryRelations,
    revisions,
    mergeCandidates,
    conflictCases,
    auditEvents,
  ] = await Promise.all([
    allRows(db, `SELECT scope_id, parent_scope_id, canonical_name, aliases_json,
                       scope_type, created_at, updated_at
                FROM sb_scopes
                ORDER BY updated_at DESC, scope_id DESC`),
    allRows(db, `SELECT parent_id, active_version_id, scope_id, created_at, updated_at
                FROM sb_parent_units
                ORDER BY updated_at DESC, parent_id DESC`),
    allRows(db, `SELECT version_id, parent_id, version_number, source_observation_id,
                       source_snapshot_hash, tags_snapshot_json, source_snapshot,
                       vault_snapshot, metadata_snapshot_hash,
                       summary, state, summary_vector_ids,
                       activated_at, superseded_at, activation_time_source,
                       superseded_time_source, created_at, updated_at
                FROM sb_parent_versions
                ORDER BY created_at DESC, version_id DESC`),
    allRows(db, `SELECT parent_version_id, memory_id, relation, created_at
                FROM sb_parent_version_claims
                ORDER BY created_at DESC, parent_version_id DESC, memory_id DESC`),
    allRows(db, `SELECT id, source_parent_id, target_parent_id, edge_type,
                       weight, provenance, metadata_json, directed, valid_from,
                       valid_to, deleted_at, created_at, updated_at
                FROM sb_association_edges
                ORDER BY updated_at DESC, id DESC`),
    allRows(db, `SELECT id, source_parent_id, target_parent_id, edge_type,
                       weight, provenance, metadata_json, directed, valid_from,
                       valid_to, deleted_at, created_at, updated_at
                FROM sb_association_edge_history
                ORDER BY updated_at DESC, id DESC`),
    allRows(db, `SELECT id, content, tags, source, created_at, vector_ids,
                       recall_count, importance_score, classification_confidence,
                       classification_status, classification_error, classification_attempts,
                       classification_next_attempt_at, classification_started_at,
                       classification_version, classified_at,
                       contradiction_wins, contradiction_losses, content_hash,
                       embedding_fingerprint
                FROM entries
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, content, source, metadata_json, content_hash,
                       source_channel, source_identity, author_type, source_uri,
                       source_timestamp, revision, root_evidence_id, previous_evidence_id,
                       extraction_status, extraction_version, extraction_attempts,
                       extraction_error, next_attempt_at, processing_started_at,
                       processed_at, needs_reprocess, created_at
                FROM sb_observations
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, content, kind, memory_class, importance, confidence,
                       entry_id, parent_version_id, claim_subject, claim_predicate,
                       claim_object, scope_id, polarity, modality, claim_status,
                       scores_json, content_hash, observed_at, valid_from, valid_to,
                       reference_time, invalid_at, expired_at, entities_json, created_at
                FROM sb_memories
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, memory_id, observation_id, role, score, relation,
                       extract_span, evidence_score, derivation_confidence,
                       extractor_model, extractor_version, evidence_root_id, created_at
                FROM sb_memory_sources
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, name, name_normalized, entity_type, aliases_json,
                       metadata_json, mention_count, lifecycle_state,
                       merged_into_entity_id, merged_at, created_at, updated_at
                FROM sb_entities
                ORDER BY updated_at DESC, id DESC`),
    allRows(db, `SELECT id, entity_id, alias, alias_normalized,
                       source_observation_id, confidence, created_at, updated_at
                FROM sb_entity_aliases
                ORDER BY updated_at DESC, id DESC`),
    allRows(db, `SELECT id, alias_id, observation_id, relation, created_at
                FROM sb_entity_alias_sources
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, entity_id, provider, external_id,
                       source_observation_id, created_at, updated_at
                FROM sb_entity_external_ids
                ORDER BY updated_at DESC, id DESC`),
    allRows(db, `SELECT id, external_id_id, observation_id, relation, created_at
                FROM sb_entity_external_id_sources
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT entity_id, embedding_fingerprint, embedding_json,
                       dimensions, updated_at
                FROM sb_entity_embeddings
                ORDER BY updated_at DESC, entity_id DESC`),
    allRows(db, `SELECT id, source_entity_id, target_entity_id, matched_by,
                       score, reason_json, state, source_observation_id,
                       reviewed_by, reviewed_at, created_at, updated_at
                FROM sb_entity_merge_candidates
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, source_entity_id, target_entity_id, candidate_id,
                       actor_type, reason, snapshot_json, created_at
                FROM sb_entity_merge_history
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, memory_id, entity_id, role, score, created_at
                FROM sb_memory_entities
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, from_entity_id, to_entity_id, relation_type, fact,
                       fact_hash, evidence_count, memory_id, observation_id,
                       score, valid_from, valid_to, invalid_at, expired_at,
                       reference_time, scope_id, polarity, modality,
                       resolution_type, resolution_state, supersedes_relation_id,
                       metadata_json, created_at
                FROM sb_entity_relations
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, relation_id, target_relation_id, resolution_type,
                       confidence, reason_codes_json, requires_review,
                       applied_invalidation, source_memory_id, target_memory_id,
                       created_at
                FROM sb_fact_resolutions
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, relation_id, memory_id, observation_id, created_at
                FROM sb_fact_sources
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, from_memory_id, to_memory_id, relation_type,
                       score, metadata_json, created_at
                FROM sb_memory_relations
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, memory_id, event_type, old_content, new_content,
                       old_metadata_json, new_metadata_json, reason, actor, created_at
                FROM sb_memory_revisions
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, source_memory_id, target_memory_id, similarity,
                       suggested_action, reason, state, reviewed_by, reviewed_at, created_at
                FROM sb_memory_merge_candidates
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, old_memory_id, new_memory_id, old_claim_id, new_claim_id, conflict_type,
                       reason, confidence, state, resolution, resolved_by,
                       resolved_at, created_at
                FROM sb_conflict_cases
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, occurred_at, trace_id, actor_type, actor_id,
                       token_id, action, object_type, object_id, vault_id,
                       before_hash, after_hash, success, error_code,
                       metadata_json, previous_event_hash, event_hash
                FROM sb_audit_events
                ORDER BY occurred_at DESC, id DESC`),
  ]);

  return {
    backupFormat: MEMORY_BACKUP_FORMAT,
    schemaVersion: MEMORY_BACKUP_SCHEMA_VERSION,
    features: [...MEMORY_BACKUP_FEATURES],
    exportedAt: new Date().toISOString(),
    source: input.source,
    totals: {
      scopes: countRows(scopes),
      parentUnits: countRows(parentUnits),
      parentVersions: countRows(parentVersions),
      parentVersionClaims: countRows(parentVersionClaims),
      associationEdges: countRows(associationEdges),
      associationEdgeHistory: countRows(associationEdgeHistory),
      entries: countRows(entries),
      observations: countRows(observations),
      memories: countRows(memories),
      memorySources: countRows(memorySources),
      entities: countRows(entities),
      entityAliases: countRows(entityAliases),
      entityAliasSources: countRows(entityAliasSources),
      entityExternalIds: countRows(entityExternalIds),
      entityExternalIdSources: countRows(entityExternalIdSources),
      entityEmbeddings: countRows(entityEmbeddings),
      entityMergeCandidates: countRows(entityMergeCandidates),
      entityMergeHistory: countRows(entityMergeHistory),
      memoryEntities: countRows(memoryEntities),
      entityRelations: countRows(entityRelations),
      factResolutions: countRows(factResolutions),
      factSources: countRows(factSources),
      memoryRelations: countRows(memoryRelations),
      revisions: countRows(revisions),
      mergeCandidates: countRows(mergeCandidates),
      conflictCases: countRows(conflictCases),
      auditEvents: countRows(auditEvents),
    },
    integrity: await inspectMemoryBackupIntegrity(db),
    scopes,
    parentUnits,
    parentVersions,
    parentVersionClaims,
    associationEdges,
    associationEdgeHistory,
    entries,
    observations,
    memories,
    memorySources,
    entities,
    entityAliases,
    entityAliasSources,
    entityExternalIds,
    entityExternalIdSources,
    entityEmbeddings,
    entityMergeCandidates,
    entityMergeHistory,
    memoryEntities,
    entityRelations,
    factResolutions,
    factSources,
    memoryRelations,
    revisions,
    mergeCandidates,
    conflictCases,
    auditEvents,
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

function entityLifecycleState(row: BackupRow): "active" | "merged" {
  const state = textOrDefault(row, "lifecycle_state", "active");
  if (state !== "active" && state !== "merged") {
    throw new Error("lifecycle_state must be active or merged");
  }
  if (state === "merged" && !textOrNull(row, "merged_into_entity_id")) {
    throw new Error("merged entities require merged_into_entity_id");
  }
  return state;
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
  if (rows.length === 0) return stats;
  const statements = rows.map(prepare);
  const results = await db.batch(statements);
  for (const result of results) {
    const changes = Number(result.meta?.changes ?? 0);
    if (changes > 0) stats.imported += 1;
    else stats.skipped += 1;
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
  await ensureEntityResolutionDataModel(db);
  await ensureConflictClaimSchema(db);
  await ensureAssociationDataModel(db);
  const rawSchemaVersion = body.schemaVersion == null ? 4 : Number(body.schemaVersion);
  if (!Number.isFinite(rawSchemaVersion) || rawSchemaVersion < 4) {
    throw new Error("Unsupported memory backup schemaVersion");
  }
  if (rawSchemaVersion > MEMORY_BACKUP_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported memory backup schemaVersion ${rawSchemaVersion}; this runtime supports up to ${MEMORY_BACKUP_SCHEMA_VERSION}`
    );
  }
  const mode: ImportMode = options.mode === "overwrite" ? "overwrite" : "skip";
  const entries = arrayFrom(body.entries);
  const entryResult = await importEntries(db, entries, {
    ...options,
    mode,
    extraTags: options.extraTags ?? [],
  });

  const graph = {} as Record<GraphArrayKey, TableImportStats>;

  graph.scopes = await importTable(db, rowsFor(body, "scopes"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_scopes (
         scope_id, parent_scope_id, canonical_name, aliases_json,
         scope_type, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "scope_id"),
      textOrNull(row, "parent_scope_id"),
      requiredText(row, "canonical_name"),
      jsonText(row, "aliases_json", "[]"),
      textOrNull(row, "scope_type"),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.parentUnits = await importTable(db, rowsFor(body, "parentUnits"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_parent_units (
         parent_id, active_version_id, scope_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "parent_id"),
      textOrNull(row, "active_version_id"),
      textOrNull(row, "scope_id"),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.parentVersions = await importTable(db, rowsFor(body, "parentVersions"), (row) => {
    const state = textOrDefault(row, "state", "building");
    const createdAt = intOrDefault(row, "created_at", Date.now());
    const updatedAt = intOrDefault(row, "updated_at", createdAt);
    const isActivated = ["active", "active_degraded", "superseded"].includes(state);
    const isSuperseded = state === "superseded";
    const recordedActivatedAt = numberOrNull(row, "activated_at");
    const recordedSupersededAt = numberOrNull(row, "superseded_at");
    return db.prepare(
      `${insertVerb(mode)} INTO sb_parent_versions (
         version_id, parent_id, version_number, source_observation_id,
         source_snapshot_hash, tags_snapshot_json, source_snapshot,
         vault_snapshot, metadata_snapshot_hash, summary, state, summary_vector_ids,
         activated_at, superseded_at, activation_time_source,
         superseded_time_source, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "version_id"),
      requiredText(row, "parent_id"),
      intOrDefault(row, "version_number", 1),
      textOrNull(row, "source_observation_id"),
      textOrNull(row, "source_snapshot_hash"),
      jsonText(row, "tags_snapshot_json", "[]"),
      textOrNull(row, "source_snapshot"),
      textOrNull(row, "vault_snapshot"),
      textOrNull(row, "metadata_snapshot_hash"),
      textOrNull(row, "summary"),
      state,
      jsonText(row, "summary_vector_ids", "[]"),
      recordedActivatedAt ?? (isActivated ? createdAt : null),
      recordedSupersededAt ?? (isSuperseded ? updatedAt : null),
      textOrNull(row, "activation_time_source") ?? (isActivated ? (recordedActivatedAt === null ? "inferred" : "recorded") : null),
      textOrNull(row, "superseded_time_source") ?? (isSuperseded ? (recordedSupersededAt === null ? "inferred" : "recorded") : null),
      createdAt,
      updatedAt
    );
  });

  graph.associationEdges = await importTable(db, rowsFor(body, "associationEdges"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_association_edges (
         id, source_parent_id, target_parent_id, edge_type, weight,
         provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "source_parent_id"),
      requiredText(row, "target_parent_id"),
      textOrDefault(row, "edge_type", "related_to"),
      numberOrDefault(row, "weight", 0.5),
      textOrDefault(row, "provenance", "system"),
      jsonText(row, "metadata_json", "{}"),
      intOrDefault(row, "directed", ["related_to", "manual"].includes(textOrDefault(row, "edge_type", "related_to")) ? 0 : 1),
      numberOrNull(row, "valid_from") ?? intOrDefault(row, "created_at", Date.now()),
      numberOrNull(row, "valid_to"),
      numberOrNull(row, "deleted_at"),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.associationEdgeHistory = await importTable(
    db,
    rowsFor(body, "associationEdgeHistory"),
    (row) => db.prepare(
      `${insertVerb(mode)} INTO sb_association_edge_history (
         id, source_parent_id, target_parent_id, edge_type, weight,
         provenance, metadata_json, directed, valid_from, valid_to, deleted_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "source_parent_id"),
      requiredText(row, "target_parent_id"),
      textOrDefault(row, "edge_type", "related_to"),
      numberOrDefault(row, "weight", 0.5),
      textOrDefault(row, "provenance", "system"),
      jsonText(row, "metadata_json", "{}"),
      intOrDefault(row, "directed", ["related_to", "manual"].includes(textOrDefault(row, "edge_type", "related_to")) ? 0 : 1),
      numberOrNull(row, "valid_from") ?? intOrDefault(row, "created_at", Date.now()),
      numberOrNull(row, "valid_to"),
      intOrDefault(row, "deleted_at", intOrDefault(row, "updated_at", Date.now())),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.observations = await importTable(db, rowsFor(body, "observations"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_observations (
         id, content, source, metadata_json, content_hash,
         source_channel, source_identity, author_type, source_uri,
         source_timestamp, revision, root_evidence_id, previous_evidence_id,
         extraction_status, extraction_version, extraction_attempts,
         extraction_error, next_attempt_at, processing_started_at,
         processed_at, needs_reprocess, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "content"),
      textOrDefault(row, "source", "import"),
      jsonText(row, "metadata_json", "{}"),
      textOrNull(row, "content_hash"),
      textOrDefault(row, "source_channel", textOrDefault(row, "source", "import")),
      textOrNull(row, "source_identity"),
      textOrDefault(row, "author_type", "unknown"),
      textOrNull(row, "source_uri"),
      numberOrNull(row, "source_timestamp"),
      intOrDefault(row, "revision", 1),
      textOrDefault(row, "root_evidence_id", requiredText(row, "id")),
      textOrNull(row, "previous_evidence_id"),
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
         entry_id, parent_version_id, claim_subject, claim_predicate,
         claim_object, scope_id, polarity, modality, claim_status,
         scores_json, content_hash, observed_at, valid_from, valid_to,
         reference_time, invalid_at, expired_at, entities_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "content"),
      textOrNull(row, "kind"),
      textOrNull(row, "memory_class"),
      numberOrNull(row, "importance"),
      numberOrNull(row, "confidence"),
      textOrNull(row, "entry_id"),
      textOrNull(row, "parent_version_id"),
      textOrNull(row, "claim_subject"),
      textOrNull(row, "claim_predicate"),
      textOrNull(row, "claim_object"),
      textOrNull(row, "scope_id"),
      textOrDefault(row, "polarity", "positive"),
      textOrDefault(row, "modality", "asserted"),
      textOrDefault(row, "claim_status", "supported"),
      jsonText(row, "scores_json", "{}"),
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

  graph.parentVersionClaims = await importTable(db, rowsFor(body, "parentVersionClaims"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_parent_version_claims (
         parent_version_id, memory_id, relation, created_at
       ) VALUES (?, ?, ?, ?)`
    ).bind(
      requiredText(row, "parent_version_id"),
      requiredText(row, "memory_id"),
      textOrDefault(row, "relation", "supports"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.memorySources = await importTable(db, rowsFor(body, "memorySources"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_memory_sources (
         id, memory_id, observation_id, role, score, relation, extract_span,
         evidence_score, derivation_confidence, extractor_model,
         extractor_version, evidence_root_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "memory_id"),
      requiredText(row, "observation_id"),
      textOrDefault(row, "role", "derived_from"),
      numberOrNull(row, "score"),
      textOrDefault(row, "relation", textOrDefault(row, "role", "derived_from")),
      textOrNull(row, "extract_span"),
      numberOrNull(row, "evidence_score"),
      numberOrNull(row, "derivation_confidence"),
      textOrNull(row, "extractor_model"),
      textOrNull(row, "extractor_version"),
      textOrDefault(row, "evidence_root_id", requiredText(row, "observation_id")),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.entities = await importTable(db, rowsFor(body, "entities"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entities (
         id, name, name_normalized, entity_type, aliases_json,
         metadata_json, mention_count, lifecycle_state,
         merged_into_entity_id, merged_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "name"),
      textOrDefault(row, "name_normalized", requiredText(row, "name").toLowerCase()),
      textOrNull(row, "entity_type"),
      jsonText(row, "aliases_json", "[]"),
      jsonText(row, "metadata_json", "{}"),
      intOrDefault(row, "mention_count", 0),
      entityLifecycleState(row),
      textOrNull(row, "merged_into_entity_id"),
      numberOrNull(row, "merged_at"),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.entityAliases = await importTable(db, rowsFor(body, "entityAliases"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entity_aliases (
         id, entity_id, alias, alias_normalized, source_observation_id,
         confidence, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "entity_id"),
      requiredText(row, "alias"),
      textOrDefault(row, "alias_normalized", requiredText(row, "alias").toLowerCase()),
      textOrNull(row, "source_observation_id"),
      numberOrNull(row, "confidence"),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.entityAliasSources = await importTable(db, rowsFor(body, "entityAliasSources"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entity_alias_sources (
         id, alias_id, observation_id, relation, created_at
       ) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "alias_id"),
      requiredText(row, "observation_id"),
      textOrDefault(row, "relation", "supports"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.entityExternalIds = await importTable(db, rowsFor(body, "entityExternalIds"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entity_external_ids (
         id, entity_id, provider, external_id, source_observation_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "entity_id"),
      requiredText(row, "provider"),
      requiredText(row, "external_id"),
      textOrNull(row, "source_observation_id"),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.entityExternalIdSources = await importTable(db, rowsFor(body, "entityExternalIdSources"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entity_external_id_sources (
         id, external_id_id, observation_id, relation, created_at
       ) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "external_id_id"),
      requiredText(row, "observation_id"),
      textOrDefault(row, "relation", "supports"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.entityEmbeddings = await importTable(db, rowsFor(body, "entityEmbeddings"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entity_embeddings (
         entity_id, embedding_fingerprint, embedding_json, dimensions, updated_at
       ) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "entity_id"),
      requiredText(row, "embedding_fingerprint"),
      jsonText(row, "embedding_json", "[]"),
      intOrDefault(row, "dimensions", 0),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.entityMergeCandidates = await importTable(db, rowsFor(body, "entityMergeCandidates"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entity_merge_candidates (
         id, source_entity_id, target_entity_id, matched_by, score,
         reason_json, state, source_observation_id, reviewed_by, reviewed_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "source_entity_id"),
      requiredText(row, "target_entity_id"),
      textOrDefault(row, "matched_by", "semantic"),
      numberOrNull(row, "score"),
      jsonText(row, "reason_json", "[]"),
      textOrDefault(row, "state", "pending"),
      textOrNull(row, "source_observation_id"),
      textOrNull(row, "reviewed_by"),
      numberOrNull(row, "reviewed_at"),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.entityMergeHistory = await importTable(db, rowsFor(body, "entityMergeHistory"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_entity_merge_history (
         id, source_entity_id, target_entity_id, candidate_id, actor_type,
         reason, snapshot_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "source_entity_id"),
      requiredText(row, "target_entity_id"),
      textOrNull(row, "candidate_id"),
      textOrDefault(row, "actor_type", "import"),
      textOrNull(row, "reason"),
      jsonText(row, "snapshot_json", "{}"),
      intOrDefault(row, "created_at", Date.now())
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
         id, from_entity_id, to_entity_id, relation_type, fact, fact_hash,
         evidence_count, memory_id, observation_id, score,
         valid_from, valid_to, invalid_at, expired_at, reference_time,
         scope_id, polarity, modality, resolution_type, resolution_state,
         supersedes_relation_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "from_entity_id"),
      requiredText(row, "to_entity_id"),
      textOrDefault(row, "relation_type", "related_to"),
      textOrNull(row, "fact"),
      textOrNull(row, "fact_hash"),
      intOrDefault(row, "evidence_count", 1),
      textOrNull(row, "memory_id"),
      textOrNull(row, "observation_id"),
      numberOrNull(row, "score"),
      numberOrNull(row, "valid_from"),
      numberOrNull(row, "valid_to"),
      numberOrNull(row, "invalid_at"),
      numberOrNull(row, "expired_at"),
      numberOrNull(row, "reference_time"),
      textOrNull(row, "scope_id"),
      textOrDefault(row, "polarity", "positive"),
      textOrDefault(row, "modality", "asserted"),
      textOrDefault(row, "resolution_type", "coexists"),
      textOrDefault(row, "resolution_state", "active"),
      textOrNull(row, "supersedes_relation_id"),
      jsonText(row, "metadata_json", "{}"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.factResolutions = await importTable(db, rowsFor(body, "factResolutions"), (row) => {
    const relationId = requiredText(row, "relation_id");
    const importedTargetRelationId = textOrNull(row, "target_relation_id");
    return db.prepare(
      `${insertVerb(mode)} INTO sb_fact_resolutions (
         id, relation_id, target_relation_id, resolution_type, confidence,
         reason_codes_json, requires_review, applied_invalidation,
         source_memory_id, target_memory_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      relationId,
      importedTargetRelationId === relationId ? null : importedTargetRelationId,
      textOrDefault(row, "resolution_type", "uncertain"),
      numberOrNull(row, "confidence"),
      jsonText(row, "reason_codes_json", "[]"),
      intOrDefault(row, "requires_review", 0),
      intOrDefault(row, "applied_invalidation", 0),
      textOrNull(row, "source_memory_id"),
      textOrNull(row, "target_memory_id"),
      intOrDefault(row, "created_at", Date.now())
    );
  });

  graph.factSources = await importTable(db, rowsFor(body, "factSources"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_fact_sources (
         id, relation_id, memory_id, observation_id, created_at
       ) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "relation_id"),
      textOrNull(row, "memory_id"),
      textOrNull(row, "observation_id"),
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

  graph.mergeCandidates = await importTable(db, rowsFor(body, "mergeCandidates"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_memory_merge_candidates (
         id, source_memory_id, target_memory_id, similarity,
         suggested_action, reason, state, reviewed_by, reviewed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "source_memory_id"),
      requiredText(row, "target_memory_id"),
      numberOrNull(row, "similarity"),
      textOrDefault(row, "suggested_action", "keep_both"),
      textOrNull(row, "reason"),
      textOrDefault(row, "state", "pending"),
      textOrNull(row, "reviewed_by"),
      numberOrNull(row, "reviewed_at"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.conflictCases = await importTable(db, rowsFor(body, "conflictCases"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_conflict_cases (
         id, old_memory_id, new_memory_id, old_claim_id, new_claim_id, conflict_type, reason,
         confidence, state, resolution, resolved_by, resolved_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "old_memory_id"),
      requiredText(row, "new_memory_id"),
      textOrNull(row, "old_claim_id"),
      textOrNull(row, "new_claim_id"),
      textOrDefault(row, "conflict_type", "contradiction"),
      textOrNull(row, "reason"),
      numberOrNull(row, "confidence"),
      textOrDefault(row, "state", "pending"),
      textOrNull(row, "resolution"),
      textOrNull(row, "resolved_by"),
      numberOrNull(row, "resolved_at"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.auditEvents = await importTable(db, rowsFor(body, "auditEvents"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_audit_events (
         id, occurred_at, trace_id, actor_type, actor_id, token_id,
         action, object_type, object_id, vault_id, before_hash, after_hash,
         success, error_code, metadata_json, previous_event_hash, event_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      intOrDefault(row, "occurred_at", Date.now()),
      textOrNull(row, "trace_id"),
      textOrDefault(row, "actor_type", "system"),
      textOrNull(row, "actor_id"),
      textOrNull(row, "token_id"),
      textOrDefault(row, "action", "imported"),
      textOrDefault(row, "object_type", "unknown"),
      textOrNull(row, "object_id"),
      textOrNull(row, "vault_id"),
      textOrNull(row, "before_hash"),
      textOrNull(row, "after_hash"),
      intOrDefault(row, "success", 1),
      textOrNull(row, "error_code"),
      jsonText(row, "metadata_json", "{}"),
      textOrNull(row, "previous_event_hash"),
      requiredText(row, "event_hash")
    )
  );

  const integrity = await inspectMemoryBackupIntegrity(db);
  if (!integrity.ok) {
    const broken = Object.entries(integrity.issues)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}=${count}`)
      .join(", ");
    throw new Error(`Imported backup failed integrity validation: ${broken}`);
  }
  return {
    ...entryResult,
    schemaVersion: MEMORY_BACKUP_SCHEMA_VERSION,
    graph,
    integrity,
  };
}
