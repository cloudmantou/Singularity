import { importEntries, type ImportMode, type ImportOptions, type ImportResult } from "../import-entries";
import { ensureEntityResolutionDataModel } from "./entities";
import {
  acquireAuditImportLock,
  analyzeAuditChainRows,
  computeComplianceAuditEventHash,
  ensureConflictClaimSchema,
  releaseAuditImportLock,
  renewAuditImportLock,
  type AuditChainNode,
  type ComplianceAuditEventRecord,
} from "./quality";
import { ensureAssociationDataModel } from "./associations";
import { MEMORY_MUTATION_SCHEMA_STATEMENTS } from "./mutations";
import {
  AI_REVIEW_DIFFERENCE_DIMENSIONS,
  AI_REVIEW_DIFFERENCE_STATUSES,
  AI_REVIEW_MISSING_CONTEXT_REASONS,
  AI_REVIEWABILITY_LEVELS,
  ensureAIReviewDataModel,
} from "./ai-review";
import { ensureKnowledgeEvolutionDataModel } from "./knowledge-evolution";

export const MEMORY_BACKUP_SCHEMA_VERSION = 19;
export const MEMORY_MUTATION_BACKUP_MODE = "audit_only" as const;
const MEMORY_BACKUP_FORMAT = "singularity-memory-backup";
const SUPPORTED_MEMORY_BACKUP_SCHEMA_VERSIONS = new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
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
  "parent-version-metadata-provenance",
  "entity-resolution",
  "entity-merge-execution",
  "fact-resolution",
  "claim-level-conflicts",
  "association-graph",
  "association-validity-windows",
  "entry-mutation-journal",
  "entry-mutation-journal-audit-only",
  "ai-assisted-quality-review",
  "context-aware-ai-review",
  "reversible-knowledge-evolution",
  "knowledge-evolution-association-snapshots",
] as const;

export const AUDIT_IMPORT_MODES = ["replace_empty", "append_verified"] as const;
export type AuditImportMode = (typeof AUDIT_IMPORT_MODES)[number];
export type AuditImportModeInput = AuditImportMode | "separate_chain";

const AUDIT_IMPORT_BATCH_SIZE = 80;
const auditLockHeartbeats = new WeakMap<object, () => Promise<void>>();

const GRAPH_ARRAY_KEYS = [
  // Runtime automation leases are intentionally excluded; restore rebuilds work from pending domain rows.
  "scopes",
  "parentUnits",
  "parentVersions",
  "parentVersionClaims",
  "memoryMutations",
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
  "aiReviewJobs",
  "aiReviewRuns",
  "aiReviewApplications",
  "knowledgeEvolutions",
  "knowledgeEvolutionSources",
  "knowledgeEvolutionAssociationSnapshots",
  "knowledgeClaimOwnership",
  "knowledgeEvolutionHistory",
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
  schemaVersion: 19;
  features: Array<(typeof MEMORY_BACKUP_FEATURES)[number]>;
  exportedAt: string;
  source: string;
  memoryMutationBackupMode: typeof MEMORY_MUTATION_BACKUP_MODE;
  totals: Record<string, number>;
  integrity: BackupIntegrityReport;
  scopes: BackupRow[];
  parentUnits: BackupRow[];
  parentVersions: BackupRow[];
  parentVersionClaims: BackupRow[];
  memoryMutations: BackupRow[];
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
  aiReviewJobs: BackupRow[];
  aiReviewRuns: BackupRow[];
  aiReviewApplications: BackupRow[];
  knowledgeEvolutions: BackupRow[];
  knowledgeEvolutionSources: BackupRow[];
  knowledgeEvolutionAssociationSnapshots: BackupRow[];
  knowledgeClaimOwnership: BackupRow[];
  knowledgeEvolutionHistory: BackupRow[];
  auditEvents: BackupRow[];
}

export interface MemoryBackupImportResult extends ImportResult {
  schemaVersion: 19;
  memoryMutationBackupMode: typeof MEMORY_MUTATION_BACKUP_MODE;
  graph: Record<GraphArrayKey, TableImportStats>;
  integrity: BackupIntegrityReport;
}

export interface MemoryBackupImportOptions extends ImportOptions {
  auditMode?: AuditImportModeInput;
  /** Use a self-host SQLite transaction around the complete restore. */
  atomic?: boolean;
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
       (SELECT COUNT(*) FROM sb_memory_mutations mutation
        LEFT JOIN entries e ON e.id = mutation.entry_id
        WHERE e.id IS NULL) as memory_mutations_missing_entry,
       (SELECT COUNT(*) FROM sb_memory_mutations mutation
        LEFT JOIN sb_observations o ON o.id = mutation.observation_id
        WHERE mutation.observation_id IS NOT NULL AND o.id IS NULL) as memory_mutations_missing_observation,
       (SELECT COUNT(*) FROM sb_memory_mutations mutation
        LEFT JOIN sb_memories m ON m.id = mutation.claim_id
        WHERE mutation.claim_id IS NOT NULL AND m.id IS NULL) as memory_mutations_missing_claim,
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
        WHERE c.new_claim_id IS NOT NULL AND m.id IS NULL) as conflict_cases_missing_new_claim,
       (SELECT COUNT(*) FROM sb_ai_review_runs r
        LEFT JOIN sb_ai_review_jobs j ON j.id = r.job_id
        WHERE j.id IS NULL) as ai_review_runs_missing_job,
       (SELECT COUNT(*) FROM sb_ai_review_jobs j
        LEFT JOIN sb_ai_review_runs r ON r.id = j.run_id
        WHERE j.run_id IS NOT NULL AND r.id IS NULL) as ai_review_jobs_missing_run,
       (SELECT COUNT(*) FROM sb_ai_review_applications a
        LEFT JOIN sb_ai_review_runs r ON r.id = a.run_id
        WHERE r.id IS NULL) as ai_review_applications_missing_run,
       (SELECT COUNT(*) FROM sb_ai_review_jobs j
        WHERE j.status = 'applied'
          AND NOT EXISTS (
            SELECT 1 FROM sb_ai_review_applications a
            WHERE a.run_id = j.run_id
          )) as ai_review_applied_jobs_missing_receipt,
       (SELECT COUNT(*) FROM sb_knowledge_evolutions evolution
        LEFT JOIN sb_ai_review_runs run ON run.id = evolution.ai_review_run_id
        WHERE run.id IS NULL) as knowledge_evolutions_missing_run,
       (SELECT COUNT(*) FROM sb_knowledge_evolutions evolution
        LEFT JOIN sb_memories claim ON claim.id = evolution.output_claim_id
        WHERE evolution.output_claim_id IS NOT NULL AND claim.id IS NULL)
          as knowledge_evolutions_missing_output_claim,
       (SELECT COUNT(*) FROM sb_knowledge_evolution_sources source
        LEFT JOIN sb_knowledge_evolutions evolution ON evolution.id = source.evolution_id
        WHERE evolution.id IS NULL) as knowledge_evolution_sources_missing_evolution,
       (SELECT COUNT(*) FROM sb_knowledge_evolution_sources source
        LEFT JOIN sb_memories claim ON claim.id = source.claim_id
        WHERE claim.id IS NULL) as knowledge_evolution_sources_missing_claim,
       (SELECT COUNT(*) FROM sb_knowledge_evolution_association_snapshots snapshot
        LEFT JOIN sb_knowledge_evolutions evolution ON evolution.id = snapshot.evolution_id
        WHERE evolution.id IS NULL) as knowledge_evolution_association_snapshots_missing_evolution,
       (SELECT COUNT(*) FROM sb_knowledge_evolution_association_snapshots snapshot
        LEFT JOIN sb_parent_units parent ON parent.parent_id = snapshot.source_parent_id
        WHERE parent.parent_id IS NULL) as knowledge_evolution_association_snapshots_missing_source_parent,
       (SELECT COUNT(*) FROM sb_knowledge_evolution_association_snapshots snapshot
        LEFT JOIN sb_parent_units parent ON parent.parent_id = snapshot.target_parent_id
        WHERE parent.parent_id IS NULL) as knowledge_evolution_association_snapshots_missing_target_parent,
       (SELECT COUNT(*) FROM sb_knowledge_evolution_aggregate_snapshots snapshot
        LEFT JOIN sb_knowledge_evolutions evolution ON evolution.id = snapshot.evolution_id
        WHERE evolution.id IS NULL) as knowledge_evolution_aggregate_snapshots_missing_evolution,
       (SELECT COUNT(*) FROM sb_knowledge_claim_ownership ownership
        LEFT JOIN sb_knowledge_evolutions evolution ON evolution.id = ownership.evolution_id
        WHERE evolution.id IS NULL OR evolution.state <> 'active')
          as knowledge_claim_ownership_missing_active_evolution,
       (SELECT COUNT(*) FROM sb_knowledge_claim_ownership ownership
        LEFT JOIN sb_memories claim ON claim.id = ownership.claim_id
        WHERE claim.id IS NULL) as knowledge_claim_ownership_missing_claim,
       (SELECT COUNT(*) FROM sb_knowledge_evolution_history history
        LEFT JOIN sb_knowledge_evolutions evolution ON evolution.id = history.evolution_id
        WHERE evolution.id IS NULL) as knowledge_evolution_history_missing_evolution`
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
  await ensureAIReviewDataModel(db);
  await ensureKnowledgeEvolutionDataModel(db);
  for (const statement of MEMORY_MUTATION_SCHEMA_STATEMENTS) await db.exec(statement);
  const [
    scopes,
    parentUnits,
    parentVersions,
    parentVersionClaims,
    memoryMutations,
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
    aiReviewJobs,
    aiReviewRuns,
    aiReviewApplications,
    knowledgeEvolutions,
    knowledgeEvolutionSources,
    knowledgeEvolutionAssociationSnapshots,
    knowledgeClaimOwnership,
    knowledgeEvolutionHistory,
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
                       vault_snapshot, metadata_snapshot_hash, metadata_snapshot_source,
                       summary, state, summary_vector_ids,
                       activated_at, superseded_at, activation_time_source,
                       superseded_time_source, created_at, updated_at
                FROM sb_parent_versions
                ORDER BY created_at DESC, version_id DESC`),
    allRows(db, `SELECT parent_version_id, memory_id, relation, created_at
                FROM sb_parent_version_claims
                ORDER BY created_at DESC, parent_version_id DESC, memory_id DESC`),
    allRows(db, `SELECT mutation_id, source_channel, operation, entry_id, state,
                       observation_id, claim_id, created_at, updated_at
                FROM sb_memory_mutations
                ORDER BY updated_at DESC, mutation_id DESC`),
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
    allRows(db, `SELECT id, object_type, object_id, mode, status, requested_by,
                       review_policy_version, input_snapshot_hash, input_snapshot_json, run_id, error_code,
                       created_at, started_at, completed_at
                FROM sb_ai_review_jobs
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, job_id, object_type, object_id, mode, decision, reason,
                       evidence_refs_json, confidence_json, reviewability,
                       missing_context_json, key_differences_json, refinement_json,
                       abstained, requires_human,
                       auto_apply_eligible, reviewer_provider, reviewer_model,
                       prompt_version, input_snapshot_hash, input_snapshot_json, created_at
                FROM sb_ai_review_runs
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, run_id, object_type, object_id, decision, applied_by,
                       application_mode, decision_source, created_at
                FROM sb_ai_review_applications
                ORDER BY created_at DESC, id DESC`),
    allRows(db, `SELECT id, ai_review_run_id, candidate_id, operation, state,
                       generation, output_entry_id, output_claim_id, output_generated,
                       decision_confidence, evidence_confidence, applied_by, applied_at,
                       rolled_back_by, rolled_back_at, rollback_reason, created_at, updated_at
                FROM sb_knowledge_evolutions
                ORDER BY applied_at DESC, id DESC`),
    allRows(db, `SELECT evolution_id, claim_id, entry_id, disposition,
                       previous_claim_status, previous_invalid_at, source_order, created_at
                FROM sb_knowledge_evolution_sources
                ORDER BY created_at DESC, evolution_id DESC, source_order ASC`),
    allRows(db, `SELECT evolution_id, edge_id, source_parent_id, target_parent_id,
                       edge_type, weight, provenance, metadata_json, directed,
                       valid_from, valid_to, deleted_at, created_at, updated_at
                FROM sb_knowledge_evolution_association_snapshots
                ORDER BY updated_at DESC, evolution_id DESC, edge_id DESC`),
    allRows(db, `SELECT claim_id, evolution_id, acquired_at
                FROM sb_knowledge_claim_ownership
                ORDER BY acquired_at DESC, claim_id DESC`),
    allRows(db, `SELECT id, evolution_id, action, actor_id, reason, created_at
                FROM sb_knowledge_evolution_history
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
    memoryMutationBackupMode: MEMORY_MUTATION_BACKUP_MODE,
    totals: {
      scopes: countRows(scopes),
      parentUnits: countRows(parentUnits),
      parentVersions: countRows(parentVersions),
      parentVersionClaims: countRows(parentVersionClaims),
      memoryMutations: countRows(memoryMutations),
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
      aiReviewJobs: countRows(aiReviewJobs),
      aiReviewRuns: countRows(aiReviewRuns),
      aiReviewApplications: countRows(aiReviewApplications),
      knowledgeEvolutions: countRows(knowledgeEvolutions),
      knowledgeEvolutionSources: countRows(knowledgeEvolutionSources),
      knowledgeEvolutionAssociationSnapshots: countRows(knowledgeEvolutionAssociationSnapshots),
      knowledgeClaimOwnership: countRows(knowledgeClaimOwnership),
      knowledgeEvolutionHistory: countRows(knowledgeEvolutionHistory),
      auditEvents: countRows(auditEvents),
    },
    integrity: await inspectMemoryBackupIntegrity(db),
    scopes,
    parentUnits,
    parentVersions,
    parentVersionClaims,
    memoryMutations,
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
    aiReviewJobs,
    aiReviewRuns,
    aiReviewApplications,
    knowledgeEvolutions,
    knowledgeEvolutionSources,
    knowledgeEvolutionAssociationSnapshots,
    knowledgeClaimOwnership,
    knowledgeEvolutionHistory,
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

async function heartbeatAuditImport(db: D1Database): Promise<void> {
  await auditLockHeartbeats.get(db)?.();
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
  for (let offset = 0; offset < rows.length; offset += AUDIT_IMPORT_BATCH_SIZE) {
    await heartbeatAuditImport(db);
    const statements = rows.slice(offset, offset + AUDIT_IMPORT_BATCH_SIZE).map(prepare);
    const results = await db.batch(statements);
    for (const result of results) {
      const changes = Number(result.meta?.changes ?? 0);
      if (changes > 0) stats.imported += 1;
      else stats.skipped += 1;
    }
    await heartbeatAuditImport(db);
  }
  return stats;
}

interface AuditImportPlan {
  mode: AuditImportMode;
  rows: BackupRow[];
}

function auditRecordFromBackupRow(row: BackupRow): ComplianceAuditEventRecord {
  return {
    id: requiredText(row, "id"),
    occurred_at: intOrDefault(row, "occurred_at", Date.now()),
    trace_id: textOrNull(row, "trace_id"),
    actor_type: textOrDefault(row, "actor_type", "system"),
    actor_id: textOrNull(row, "actor_id"),
    token_id: textOrNull(row, "token_id"),
    action: textOrDefault(row, "action", "imported"),
    object_type: textOrDefault(row, "object_type", "unknown"),
    object_id: textOrNull(row, "object_id"),
    vault_id: textOrNull(row, "vault_id"),
    before_hash: textOrNull(row, "before_hash"),
    after_hash: textOrNull(row, "after_hash"),
    success: intOrDefault(row, "success", 1),
    error_code: textOrNull(row, "error_code"),
    metadata_json: jsonText(row, "metadata_json", "{}"),
    previous_event_hash: textOrNull(row, "previous_event_hash"),
    event_hash: requiredText(row, "event_hash"),
  };
}

function auditNodeFromRecord(record: ComplianceAuditEventRecord): AuditChainNode {
  return {
    eventHash: record.event_hash,
    previousEventHash: record.previous_event_hash,
  };
}

function auditNodeFromBackupRow(row: BackupRow): AuditChainNode {
  return auditNodeFromRecord(auditRecordFromBackupRow(row));
}

async function verifyAuditBackupRows(
  db: D1Database,
  rows: BackupRow[]
): Promise<{ records: ComplianceAuditEventRecord[]; nodes: AuditChainNode[] }> {
  const records: ComplianceAuditEventRecord[] = [];
  for (let index = 0; index < rows.length; index++) {
    if (index % AUDIT_IMPORT_BATCH_SIZE === 0) await heartbeatAuditImport(db);
    const record = auditRecordFromBackupRow(rows[index]);
    const expectedHash = await computeComplianceAuditEventHash(record);
    if (expectedHash !== record.event_hash) {
      throw new Error(`audit_event_hash_mismatch:${record.id}`);
    }
    records.push(record);
  }
  const nodes = records.map(auditNodeFromRecord);
  await heartbeatAuditImport(db);
  return { records, nodes };
}

function sortAuditRows(rows: BackupRow[], shape: ReturnType<typeof analyzeAuditChainRows>): BackupRow[] {
  if (!shape.rootHash) return [];
  const byHash = new Map(rows.map((row) => [auditNodeFromBackupRow(row).eventHash, row]));
  const nextByPrevious = new Map<string, BackupRow>();
  for (const row of rows) {
    const node = auditNodeFromBackupRow(row);
    if (node.previousEventHash) nextByPrevious.set(node.previousEventHash, row);
  }
  const ordered: BackupRow[] = [];
  let current = shape.rootHash;
  while (current) {
    const row = byHash.get(current);
    if (!row) break;
    ordered.push(row);
    const next = nextByPrevious.get(current);
    current = next ? auditNodeFromBackupRow(next).eventHash : "";
  }
  return ordered;
}

async function rejectExistingAuditHashes(
  db: D1Database,
  rows: BackupRow[]
): Promise<void> {
  const hashes = rows.map((row) => auditNodeFromBackupRow(row).eventHash);
  for (let offset = 0; offset < hashes.length; offset += 80) {
    const batch = hashes.slice(offset, offset + 80);
    const placeholders = batch.map(() => "?").join(", ");
    const existing = await db.prepare(
      `SELECT event_hash FROM sb_audit_events WHERE event_hash IN (${placeholders}) LIMIT 1`
    ).bind(...batch).first<{ event_hash: string }>();
    if (existing) throw new Error("audit_event_already_exists");
  }
}

async function prepareAuditImport(
  db: D1Database,
  rows: BackupRow[],
  requestedMode?: AuditImportModeInput
): Promise<AuditImportPlan | null> {
  if (rows.length === 0) return null;
  if (requestedMode === "separate_chain") {
    throw new Error("audit_separate_chain_not_implemented");
  }
  if (requestedMode && !AUDIT_IMPORT_MODES.includes(requestedMode)) {
    throw new Error("unsupported_audit_import_mode");
  }

  const source = await verifyAuditBackupRows(db, rows);

  const targetRows = (await db.prepare(
    `SELECT id, occurred_at, trace_id, actor_type, actor_id, token_id,
            action, object_type, object_id, vault_id, before_hash, after_hash,
            success, error_code, metadata_json, previous_event_hash, event_hash
     FROM sb_audit_events`
  ).all<ComplianceAuditEventRecord>()).results ?? [];
  const target = await verifyAuditBackupRows(db, targetRows);

  const sourceShape = analyzeAuditChainRows(source.nodes);
  const targetShape = analyzeAuditChainRows(target.nodes);

  if (targetRows.length === 0) {
    if (requestedMode && requestedMode !== "replace_empty") {
      throw new Error("audit_import_requires_replace_empty");
    }
    if (!sourceShape.valid) throw new Error(sourceShape.error);
    return { mode: "replace_empty", rows: sortAuditRows(rows, sourceShape) };
  }
  if (requestedMode !== "append_verified") {
    throw new Error("audit_import_requires_append_verified");
  }
  if (!targetShape.valid || !targetShape.tailHash || !targetShape.rootHash) {
    throw new Error(`existing_audit_chain_invalid:${targetShape.error ?? "unknown"}`);
  }

  const targetByHash = new Map(target.records.map((record) => [record.event_hash, record]));
  const sourceByHash = new Map(source.records.map((record) => [record.event_hash, record]));
  if (sourceShape.valid) {
    const sourceIsTargetPrefix = sourceShape.rootHash === targetShape.rootHash && !target.records.some((record) => {
      const sourceRecord = sourceByHash.get(record.event_hash);
      return !sourceRecord || sourceRecord.previous_event_hash !== record.previous_event_hash;
    });
    if (!sourceIsTargetPrefix) throw new Error("audit_import_chain_prefix_mismatch");
  }

  const suffixRows = rows.filter((row) => !targetByHash.has(auditRecordFromBackupRow(row).event_hash));
  if (suffixRows.length === 0) throw new Error("audit_import_no_new_events");
  const suffixRecords = suffixRows.map(auditRecordFromBackupRow);
  const suffixRoot = suffixRecords.filter((record) =>
    record.previous_event_hash === targetShape.tailHash
  );
  if (suffixRoot.length !== 1) {
    throw new Error("audit_import_previous_hash_mismatch");
  }
  const normalizedSuffixShape = analyzeAuditChainRows(suffixRecords.map((record) =>
    record.event_hash === suffixRoot[0].event_hash
      ? { eventHash: record.event_hash, previousEventHash: null }
      : auditNodeFromRecord(record)
  ));
  if (!normalizedSuffixShape.valid) throw new Error(normalizedSuffixShape.error);
  await rejectExistingAuditHashes(db, suffixRows);
  return { mode: "append_verified", rows: sortAuditRows(suffixRows, normalizedSuffixShape) };
}

async function importAuditEvents(
  db: D1Database,
  plan: AuditImportPlan | null,
  prepare: (row: BackupRow) => D1PreparedStatement
): Promise<TableImportStats> {
  if (!plan) return { total: 0, imported: 0, skipped: 0, failed: 0 };
  const stats: TableImportStats = { total: plan.rows.length, imported: 0, skipped: 0, failed: 0 };
  for (let offset = 0; offset < plan.rows.length; offset += AUDIT_IMPORT_BATCH_SIZE) {
    await heartbeatAuditImport(db);
    const results = await db.batch(
      plan.rows.slice(offset, offset + AUDIT_IMPORT_BATCH_SIZE).map(prepare)
    );
    for (const result of results) {
      if (Number(result.meta?.changes ?? 0) > 0) stats.imported += 1;
      else stats.skipped += 1;
    }
    await heartbeatAuditImport(db);
  }
  return stats;
}

function rowsFor(body: Record<string, unknown>, key: GraphArrayKey): BackupRow[] {
  return arrayFrom(body[key]);
}

function verifyAIReviewBackupRows(body: Record<string, unknown>, schemaVersion: number): void {
  const jobs = rowsFor(body, "aiReviewJobs");
  const runs = rowsFor(body, "aiReviewRuns");
  const applications = rowsFor(body, "aiReviewApplications");
  const jobsById = new Map(jobs.map((row) => [requiredText(row, "id"), row]));
  const runsById = new Map(runs.map((row) => [requiredText(row, "id"), row]));
  const applicationsByRunId = new Map(
    applications.map((row) => [requiredText(row, "run_id"), row])
  );
  const requiredArray = (row: BackupRow, key: string): unknown[] => {
    const raw = row[key];
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      throw new Error(`AI review run ${key} must be valid JSON`);
    }
    if (!Array.isArray(parsed)) throw new Error(`AI review run ${key} must be an array`);
    return parsed;
  };

  for (const run of runs) {
    const job = jobsById.get(requiredText(run, "job_id"));
    if (!job) throw new Error("AI review run references a missing job");
    const linkedRunId = textOrNull(job, "run_id");
    if (linkedRunId !== requiredText(run, "id")) {
      throw new Error("AI review job and run linkage does not match");
    }
    if (schemaVersion >= 17) {
      const reviewability = requiredText(run, "reviewability");
      if (!(AI_REVIEWABILITY_LEVELS as readonly string[]).includes(reviewability)) {
        throw new Error("AI review run has an invalid reviewability state");
      }
      const abstained = intOrDefault(run, "abstained", 0) === 1;
      const decision = requiredText(run, "decision");
      const evidenceRefs = requiredArray(run, "evidence_refs_json");
      const missingContext = requiredArray(run, "missing_context_json");
      const keyDifferences = requiredArray(run, "key_differences_json");
      if (schemaVersion >= 18) {
        let refinement: unknown = { action: "none", content: null, sourceRefs: [] };
        try {
          if (run.refinement_json != null) {
            refinement = typeof run.refinement_json === "string"
              ? JSON.parse(run.refinement_json)
              : run.refinement_json;
          }
        } catch {
          refinement = null;
        }
        if (
          !refinement || typeof refinement !== "object" || Array.isArray(refinement) ||
          !["none", "consolidate", "merge", "supersede", "keep_separate"]
            .includes(String((refinement as Record<string, unknown>).action ?? "")) ||
          !Array.isArray((refinement as Record<string, unknown>).sourceRefs)
        ) {
          throw new Error("AI review run has an invalid refinement plan");
        }
      }
      if (evidenceRefs.some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error("AI review run has an invalid evidence reference");
      }
      const evidenceRefSet = new Set(evidenceRefs as string[]);
      if (missingContext.some((value) =>
        typeof value !== "string" ||
        !(AI_REVIEW_MISSING_CONTEXT_REASONS as readonly string[]).includes(value))) {
        throw new Error("AI review run has an invalid missing context reason");
      }
      if (keyDifferences.some((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return true;
        const difference = value as Record<string, unknown>;
        return typeof difference.dimension !== "string" ||
          !(AI_REVIEW_DIFFERENCE_DIMENSIONS as readonly string[]).includes(difference.dimension) ||
          typeof difference.status !== "string" ||
          !(AI_REVIEW_DIFFERENCE_STATUSES as readonly string[]).includes(difference.status) ||
          typeof difference.summary !== "string" || !difference.summary.trim() ||
          !Array.isArray(difference.evidenceRefs) ||
          difference.evidenceRefs.some((ref) =>
            typeof ref !== "string" || !evidenceRefSet.has(ref));
      })) {
        throw new Error("AI review run has an invalid key difference");
      }
      if (reviewability !== "sufficient" && (!abstained || decision !== "uncertain" || missingContext.length === 0)) {
        throw new Error("Incomplete AI review context must abstain with a reason");
      }
      if (reviewability === "sufficient" && missingContext.length > 0) {
        throw new Error("Sufficient AI review context cannot list missing context");
      }
      if (!abstained && decision !== "uncertain" &&
          (evidenceRefs.length === 0 || keyDifferences.length === 0)) {
        throw new Error("Applyable AI review runs require evidence references and key differences");
      }
    }
  }
  for (const application of applications) {
    const runId = requiredText(application, "run_id");
    const run = runsById.get(runId);
    if (!run) throw new Error("AI review application references a missing run");
    if (
      requiredText(application, "object_type") !== requiredText(run, "object_type") ||
      requiredText(application, "object_id") !== requiredText(run, "object_id") ||
      requiredText(application, "decision") !== requiredText(run, "decision")
    ) {
      throw new Error("AI review application does not match its immutable run");
    }
  }
  for (const job of jobs) {
    if (textOrDefault(job, "status", "failed") !== "applied") continue;
    const runId = textOrNull(job, "run_id");
    if (!runId || !runsById.has(runId) || !applicationsByRunId.has(runId)) {
      throw new Error("Applied AI review is missing its immutable application receipt");
    }
  }
}

function verifyKnowledgeEvolutionBackupRows(
  body: Record<string, unknown>,
  schemaVersion: number
): void {
  if (schemaVersion < 18) return;
  const keys = [
    "knowledgeEvolutions",
    "knowledgeEvolutionSources",
    "knowledgeClaimOwnership",
    "knowledgeEvolutionHistory",
  ] as const;
  for (const key of keys) {
    if (!Array.isArray(body[key])) throw new Error(`${key} must be an array in schema v18 backups`);
  }
  if (schemaVersion >= 19 && !Array.isArray(body.knowledgeEvolutionAssociationSnapshots)) {
    throw new Error("knowledgeEvolutionAssociationSnapshots must be an array in schema v19 backups");
  }

  const evolutions = rowsFor(body, "knowledgeEvolutions");
  const sources = rowsFor(body, "knowledgeEvolutionSources");
  const ownership = rowsFor(body, "knowledgeClaimOwnership");
  const history = rowsFor(body, "knowledgeEvolutionHistory");
  const associationSnapshots = rowsFor(body, "knowledgeEvolutionAssociationSnapshots");
  const runs = new Set(rowsFor(body, "aiReviewRuns").map((row) => requiredText(row, "id")));
  const claims = new Set(rowsFor(body, "memories").map((row) => requiredText(row, "id")));
  const entries = new Set(arrayFrom(body.entries).map((row) => requiredText(row, "id")));
  const parents = new Set(rowsFor(body, "parentUnits").map((row) => requiredText(row, "parent_id")));
  const evolutionsById = new Map<string, BackupRow>();
  const activeEvolutionIds = new Set<string>();
  const sourceCounts = new Map<string, number>();

  for (const evolution of evolutions) {
    const id = requiredText(evolution, "id");
    if (evolutionsById.has(id)) throw new Error("Knowledge evolution IDs must be unique");
    evolutionsById.set(id, evolution);
    if (!runs.has(requiredText(evolution, "ai_review_run_id"))) {
      throw new Error("Knowledge evolution references a missing AI review run");
    }
    if (!["consolidate", "merge", "supersede", "keep_separate"]
      .includes(requiredText(evolution, "operation"))) {
      throw new Error("Knowledge evolution has an invalid operation");
    }
    const state = textOrDefault(evolution, "state", "active");
    if (!["active", "rolled_back"].includes(state)) {
      throw new Error("Knowledge evolution has an invalid state");
    }
    if (state === "active") activeEvolutionIds.add(id);
    if (intOrDefault(evolution, "generation", 0) < 1) {
      throw new Error("Knowledge evolution generation must be positive");
    }
    const outputClaimId = textOrNull(evolution, "output_claim_id");
    const outputEntryId = textOrNull(evolution, "output_entry_id");
    const outputGenerated = intOrDefault(evolution, "output_generated", 0);
    if (outputClaimId && !claims.has(outputClaimId)) {
      throw new Error("Knowledge evolution references a missing output Claim");
    }
    if (outputEntryId && !entries.has(outputEntryId)) {
      throw new Error("Knowledge evolution references a missing output Entry");
    }
    if (outputGenerated === 1 && (!outputClaimId || !outputEntryId)) {
      throw new Error("Generated knowledge evolution requires output Entry and Claim IDs");
    }
  }

  for (const source of sources) {
    const evolutionId = requiredText(source, "evolution_id");
    if (!evolutionsById.has(evolutionId)) {
      throw new Error("Knowledge evolution source references a missing evolution");
    }
    if (!claims.has(requiredText(source, "claim_id"))) {
      throw new Error("Knowledge evolution source references a missing Claim");
    }
    if (!["absorbed", "superseded", "retained"]
      .includes(requiredText(source, "disposition"))) {
      throw new Error("Knowledge evolution source has an invalid disposition");
    }
    sourceCounts.set(evolutionId, (sourceCounts.get(evolutionId) ?? 0) + 1);
  }
  for (const evolutionId of evolutionsById.keys()) {
    if ((sourceCounts.get(evolutionId) ?? 0) < 2) {
      throw new Error("Knowledge evolution must preserve both source Claims");
    }
  }

  const ownedClaims = new Set<string>();
  for (const row of ownership) {
    const claimId = requiredText(row, "claim_id");
    if (ownedClaims.has(claimId)) throw new Error("Knowledge Claim ownership must be unique");
    ownedClaims.add(claimId);
    if (!claims.has(claimId)) throw new Error("Knowledge Claim ownership references a missing Claim");
    if (!activeEvolutionIds.has(requiredText(row, "evolution_id"))) {
      throw new Error("Knowledge Claim ownership requires an active evolution");
    }
  }
  for (const row of history) {
    if (!evolutionsById.has(requiredText(row, "evolution_id"))) {
      throw new Error("Knowledge evolution history references a missing evolution");
    }
    if (!["applied", "rolled_back"].includes(requiredText(row, "action"))) {
      throw new Error("Knowledge evolution history has an invalid action");
    }
  }
  for (const snapshot of associationSnapshots) {
    if (!evolutionsById.has(requiredText(snapshot, "evolution_id"))) {
      throw new Error("Knowledge evolution association snapshot references a missing evolution");
    }
    if (!parents.has(requiredText(snapshot, "source_parent_id")) ||
        !parents.has(requiredText(snapshot, "target_parent_id"))) {
      throw new Error("Knowledge evolution association snapshot references a missing Parent");
    }
  }
}

async function importMemoryBackupUnlocked(
  db: D1Database,
  body: Record<string, unknown>,
  options: MemoryBackupImportOptions = {}
): Promise<MemoryBackupImportResult> {
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
  verifyAIReviewBackupRows(body, rawSchemaVersion);
  verifyKnowledgeEvolutionBackupRows(body, rawSchemaVersion);
  const auditImportPlan = await prepareAuditImport(
    db,
    rowsFor(body, "auditEvents"),
    options.auditMode
  );
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
    const versionId = requiredText(row, "version_id");
    const state = textOrDefault(row, "state", "building");
    const createdAt = intOrDefault(row, "created_at", Date.now());
    const updatedAt = intOrDefault(row, "updated_at", createdAt);
    const isActivated = ["active", "active_degraded", "superseded"].includes(state);
    const isSuperseded = state === "superseded";
    const recordedActivatedAt = numberOrNull(row, "activated_at");
    const recordedSupersededAt = numberOrNull(row, "superseded_at");
    const metadataSnapshotHash = textOrNull(row, "metadata_snapshot_hash") ?? `imported-unknown:${versionId}`;
    const metadataSnapshotSource = textOrNull(row, "metadata_snapshot_source") ??
      (textOrNull(row, "metadata_snapshot_hash") ? "recorded" : "unknown");
    return db.prepare(
      `${insertVerb(mode)} INTO sb_parent_versions (
         version_id, parent_id, version_number, source_observation_id,
         source_snapshot_hash, tags_snapshot_json, source_snapshot,
         vault_snapshot, metadata_snapshot_hash, metadata_snapshot_source,
         summary, state, summary_vector_ids,
         activated_at, superseded_at, activation_time_source,
         superseded_time_source, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      versionId,
      requiredText(row, "parent_id"),
      intOrDefault(row, "version_number", 1),
      textOrNull(row, "source_observation_id"),
      textOrNull(row, "source_snapshot_hash"),
      jsonText(row, "tags_snapshot_json", "[]"),
      textOrNull(row, "source_snapshot"),
      textOrNull(row, "vault_snapshot"),
      metadataSnapshotHash,
      metadataSnapshotSource,
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

  graph.memoryMutations = await importTable(db, rowsFor(body, "memoryMutations"), (row) => {
    const mutationId = requiredText(row, "mutation_id");
    const operation = textOrDefault(row, "operation", "update");
    if (operation !== "append" && operation !== "update") {
      throw new Error("memory mutation operation must be append or update");
    }
    return db.prepare(
      `${insertVerb(mode)} INTO sb_memory_mutations (
         mutation_id, idempotency_key, source_channel, operation, entry_id,
         request_hash, state, result_content, result_content_hash,
         result_vector_count, observation_id, claim_id, warnings_json,
         last_error, lease_owner, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).bind(
      mutationId,
      `restored:${mutationId}`,
      "backup_restore",
      operation,
      requiredText(row, "entry_id"),
      `restored:${mutationId}`,
      "failed",
      null,
      null,
      null,
      textOrNull(row, "observation_id"),
      textOrNull(row, "claim_id"),
      "[]",
      "restored_mutation_audit_only",
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
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

  graph.aiReviewJobs = await importTable(db, rowsFor(body, "aiReviewJobs"), (row) => {
    const rawStatus = textOrDefault(row, "status", "failed");
    const status = rawStatus === "processing"
      ? "queued"
      : rawStatus === "applying" ? "completed" : rawStatus;
    return db.prepare(
      `INSERT OR IGNORE INTO sb_ai_review_jobs (
         id, object_type, object_id, mode, status, requested_by, review_policy_version,
         input_snapshot_hash, input_snapshot_json, run_id, error_code,
         created_at, started_at, completed_at, lease_owner, lease_expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "object_type"),
      requiredText(row, "object_id"),
      textOrDefault(row, "mode", "shadow"),
      status,
      textOrDefault(row, "requested_by", "backup_restore"),
      textOrDefault(row, "review_policy_version", "knowledge-review-v1"),
      requiredText(row, "input_snapshot_hash"),
      jsonText(row, "input_snapshot_json", "{}"),
      textOrNull(row, "run_id"),
      textOrNull(row, "error_code"),
      intOrDefault(row, "created_at", Date.now()),
      numberOrNull(row, "started_at"),
      numberOrNull(row, "completed_at")
    );
  });

  graph.aiReviewRuns = await importTable(db, rowsFor(body, "aiReviewRuns"), (row) =>
    db.prepare(
      `INSERT OR IGNORE INTO sb_ai_review_runs (
         id, job_id, object_type, object_id, mode, decision, reason,
         evidence_refs_json, confidence_json, reviewability,
         missing_context_json, key_differences_json, refinement_json,
         abstained, requires_human,
         auto_apply_eligible, reviewer_provider, reviewer_model, prompt_version,
         input_snapshot_hash, input_snapshot_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "job_id"),
      requiredText(row, "object_type"),
      requiredText(row, "object_id"),
      textOrDefault(row, "mode", "shadow"),
      requiredText(row, "decision"),
      textOrDefault(row, "reason", "Restored AI review recommendation"),
      jsonText(row, "evidence_refs_json", "[]"),
      jsonText(row, "confidence_json", "{}"),
      textOrDefault(
        row,
        "reviewability",
        intOrDefault(row, "abstained", 0) === 1 ? "insufficient" : "sufficient"
      ),
      jsonText(
        row,
        "missing_context_json",
        intOrDefault(row, "abstained", 0) === 1 ? '["complete_statement"]' : "[]"
      ),
      jsonText(row, "key_differences_json", "[]"),
      jsonText(row, "refinement_json", '{"action":"none","content":null,"sourceRefs":[]}'),
      intOrDefault(row, "abstained", 0),
      intOrDefault(row, "requires_human", 1),
      intOrDefault(row, "auto_apply_eligible", 0),
      textOrDefault(row, "reviewer_provider", "unknown"),
      textOrDefault(row, "reviewer_model", "unknown"),
      textOrDefault(row, "prompt_version", "unknown"),
      requiredText(row, "input_snapshot_hash"),
      jsonText(row, "input_snapshot_json", "{}"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.aiReviewApplications = await importTable(db, rowsFor(body, "aiReviewApplications"), (row) =>
    db.prepare(
      `INSERT OR IGNORE INTO sb_ai_review_applications (
         id, run_id, object_type, object_id, decision, applied_by,
         application_mode, decision_source, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "run_id"),
      requiredText(row, "object_type"),
      requiredText(row, "object_id"),
      requiredText(row, "decision"),
      textOrDefault(row, "applied_by", "backup_restore"),
      textOrDefault(row, "application_mode", "human"),
      textOrDefault(
        row,
        "decision_source",
        textOrDefault(row, "application_mode", "human") === "human" ? "human" : "deterministic"
      ),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.knowledgeEvolutions = await importTable(db, rowsFor(body, "knowledgeEvolutions"), (row) =>
    db.prepare(
      `${insertVerb(mode)} INTO sb_knowledge_evolutions (
         id, ai_review_run_id, candidate_id, operation, state, generation,
         output_entry_id, output_claim_id, output_generated,
         decision_confidence, evidence_confidence, applied_by, applied_at,
         rolled_back_by, rolled_back_at, rollback_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "ai_review_run_id"),
      requiredText(row, "candidate_id"),
      requiredText(row, "operation"),
      textOrDefault(row, "state", "active"),
      intOrDefault(row, "generation", 1),
      textOrNull(row, "output_entry_id"),
      textOrNull(row, "output_claim_id"),
      intOrDefault(row, "output_generated", 0),
      numberOrDefault(row, "decision_confidence", 0),
      numberOrDefault(row, "evidence_confidence", 0),
      textOrDefault(row, "applied_by", "backup_restore"),
      intOrDefault(row, "applied_at", Date.now()),
      textOrNull(row, "rolled_back_by"),
      numberOrNull(row, "rolled_back_at"),
      textOrNull(row, "rollback_reason"),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.knowledgeEvolutionSources = await importTable(
    db,
    rowsFor(body, "knowledgeEvolutionSources"),
    (row) => db.prepare(
      `${insertVerb(mode)} INTO sb_knowledge_evolution_sources (
         evolution_id, claim_id, entry_id, disposition, previous_claim_status,
         previous_invalid_at, source_order, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "evolution_id"),
      requiredText(row, "claim_id"),
      textOrNull(row, "entry_id"),
      requiredText(row, "disposition"),
      requiredText(row, "previous_claim_status"),
      numberOrNull(row, "previous_invalid_at"),
      intOrDefault(row, "source_order", 0),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.knowledgeEvolutionAssociationSnapshots = await importTable(
    db,
    rowsFor(body, "knowledgeEvolutionAssociationSnapshots"),
    (row) => db.prepare(
      `${insertVerb(mode)} INTO sb_knowledge_evolution_association_snapshots (
         evolution_id, edge_id, source_parent_id, target_parent_id, edge_type,
         weight, provenance, metadata_json, directed, valid_from, valid_to,
         deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "evolution_id"),
      requiredText(row, "edge_id"),
      requiredText(row, "source_parent_id"),
      requiredText(row, "target_parent_id"),
      requiredText(row, "edge_type"),
      numberOrDefault(row, "weight", 0.5),
      textOrDefault(row, "provenance", "system"),
      jsonText(row, "metadata_json", "{}"),
      intOrDefault(row, "directed", 0),
      numberOrNull(row, "valid_from"),
      numberOrNull(row, "valid_to"),
      numberOrNull(row, "deleted_at"),
      intOrDefault(row, "created_at", Date.now()),
      intOrDefault(row, "updated_at", Date.now())
    )
  );

  graph.knowledgeClaimOwnership = await importTable(
    db,
    rowsFor(body, "knowledgeClaimOwnership"),
    (row) => db.prepare(
      `${insertVerb(mode)} INTO sb_knowledge_claim_ownership (
         claim_id, evolution_id, acquired_at
       ) VALUES (?, ?, ?)`
    ).bind(
      requiredText(row, "claim_id"),
      requiredText(row, "evolution_id"),
      intOrDefault(row, "acquired_at", Date.now())
    )
  );

  graph.knowledgeEvolutionHistory = await importTable(
    db,
    rowsFor(body, "knowledgeEvolutionHistory"),
    (row) => db.prepare(
      `${insertVerb(mode)} INTO sb_knowledge_evolution_history (
         id, evolution_id, action, actor_id, reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      requiredText(row, "id"),
      requiredText(row, "evolution_id"),
      requiredText(row, "action"),
      textOrDefault(row, "actor_id", "backup_restore"),
      textOrNull(row, "reason"),
      intOrDefault(row, "created_at", Date.now())
    )
  );

  graph.auditEvents = await importAuditEvents(db, auditImportPlan, (row) =>
    db.prepare(
      `INSERT INTO sb_audit_events (
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
    memoryMutationBackupMode: MEMORY_MUTATION_BACKUP_MODE,
    graph,
    integrity,
  };
}

export async function importMemoryBackup(
  db: D1Database,
  body: Record<string, unknown>,
  options: MemoryBackupImportOptions = {}
): Promise<MemoryBackupImportResult> {
  await ensureEntityResolutionDataModel(db);
  await ensureConflictClaimSchema(db);
  await ensureAssociationDataModel(db);
  await ensureAIReviewDataModel(db);
  await ensureKnowledgeEvolutionDataModel(db);
  for (const statement of MEMORY_MUTATION_SCHEMA_STATEMENTS) await db.exec(statement);

  const ownerId = crypto.randomUUID();
  await acquireAuditImportLock(db, ownerId);
  auditLockHeartbeats.set(db, () => renewAuditImportLock(db, ownerId));
  const useTransaction = options.atomic === true;
  try {
    if (useTransaction) await db.exec("BEGIN IMMEDIATE");
    const result = await importMemoryBackupUnlocked(db, body, options);
    if (useTransaction) await db.exec("COMMIT");
    return result;
  } catch (error) {
    if (useTransaction) {
      try {
        await db.exec("ROLLBACK");
      } catch {
        // Preserve the original restore failure when rollback itself fails.
      }
    }
    throw error;
  } finally {
    auditLockHeartbeats.delete(db);
    await releaseAuditImportLock(db, ownerId);
  }
}
