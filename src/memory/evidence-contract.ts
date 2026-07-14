export const CLAIM_STATUSES = [
  "supported",
  "confirmed",
  "contested",
  "superseded",
  "unsupported",
  "deprecated",
] as const;

export const CLAIM_POLARITIES = ["positive", "negative", "neutral"] as const;
export const CLAIM_MODALITIES = ["asserted", "confirmed", "inferred", "hypothetical"] as const;
export const EVIDENCE_AUTHOR_TYPES = ["user", "assistant", "system", "import", "tool", "unknown"] as const;
export const PROVENANCE_RELATIONS = ["supports", "contradicts", "derived_from"] as const;
export const PARENT_VERSION_STATES = ["building", "active", "active_degraded", "superseded", "failed"] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type ClaimPolarity = (typeof CLAIM_POLARITIES)[number];
export type ClaimModality = (typeof CLAIM_MODALITIES)[number];
export type EvidenceAuthorType = (typeof EVIDENCE_AUTHOR_TYPES)[number];
export type ProvenanceRelation = (typeof PROVENANCE_RELATIONS)[number];
export type ParentVersionState = (typeof PARENT_VERSION_STATES)[number];
export type ActiveParentVersionState = Extract<ParentVersionState, "active" | "active_degraded">;

export const EVIDENCE_CONTRACT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_scopes (
    scope_id TEXT PRIMARY KEY,
    parent_scope_id TEXT,
    canonical_name TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    scope_type TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scopes_parent
    ON sb_scopes(parent_scope_id, canonical_name)`,
  `CREATE INDEX IF NOT EXISTS idx_scopes_type
    ON sb_scopes(scope_type, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sb_parent_units (
    parent_id TEXT PRIMARY KEY,
    active_version_id TEXT,
    scope_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_parent_units_active
    ON sb_parent_units(active_version_id)`,
  `CREATE INDEX IF NOT EXISTS idx_parent_units_scope
    ON sb_parent_units(scope_id, updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sb_parent_versions (
    version_id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    source_observation_id TEXT,
    source_snapshot_hash TEXT,
    tags_snapshot_json TEXT NOT NULL DEFAULT '[]',
    source_snapshot TEXT,
    vault_snapshot TEXT,
    metadata_snapshot_hash TEXT,
    metadata_snapshot_source TEXT,
    summary TEXT,
    state TEXT NOT NULL DEFAULT 'building',
    summary_vector_ids TEXT NOT NULL DEFAULT '[]',
    activated_at INTEGER,
    superseded_at INTEGER,
    activation_time_source TEXT,
    superseded_time_source TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (state IN ('building', 'active', 'active_degraded', 'superseded', 'failed')),
    UNIQUE(parent_id, version_number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_parent_versions_parent
    ON sb_parent_versions(parent_id, version_number DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_parent_versions_source
    ON sb_parent_versions(source_observation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_parent_versions_state
    ON sb_parent_versions(state, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_parent_version_claims (
    parent_version_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'supports',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_version_id, memory_id, relation)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_parent_version_claims_memory
    ON sb_parent_version_claims(memory_id, parent_version_id)`,
  `CREATE INDEX IF NOT EXISTS idx_parent_version_claims_parent
    ON sb_parent_version_claims(parent_version_id, relation, created_at DESC)`,
] as const;

export const PARENT_VERSION_TEMPORAL_MIGRATIONS = [
  { column: "activated_at", statement: `ALTER TABLE sb_parent_versions ADD COLUMN activated_at INTEGER` },
  { column: "superseded_at", statement: `ALTER TABLE sb_parent_versions ADD COLUMN superseded_at INTEGER` },
  { column: "activation_time_source", statement: `ALTER TABLE sb_parent_versions ADD COLUMN activation_time_source TEXT` },
  { column: "superseded_time_source", statement: `ALTER TABLE sb_parent_versions ADD COLUMN superseded_time_source TEXT` },
] as const;

export const PARENT_VERSION_METADATA_MIGRATIONS = [
  { column: "tags_snapshot_json", statement: `ALTER TABLE sb_parent_versions ADD COLUMN tags_snapshot_json TEXT NOT NULL DEFAULT '[]'` },
  { column: "source_snapshot", statement: `ALTER TABLE sb_parent_versions ADD COLUMN source_snapshot TEXT` },
  { column: "vault_snapshot", statement: `ALTER TABLE sb_parent_versions ADD COLUMN vault_snapshot TEXT` },
  { column: "metadata_snapshot_hash", statement: `ALTER TABLE sb_parent_versions ADD COLUMN metadata_snapshot_hash TEXT` },
  { column: "metadata_snapshot_source", statement: `ALTER TABLE sb_parent_versions ADD COLUMN metadata_snapshot_source TEXT` },
] as const;

export const PARENT_VERSION_METADATA_BACKFILL_STATEMENTS = [
  `UPDATE sb_parent_versions
   SET metadata_snapshot_source = 'recorded'
   WHERE metadata_snapshot_hash IS NOT NULL
     AND metadata_snapshot_source IS NULL`,
  `UPDATE sb_parent_versions
   SET tags_snapshot_json = COALESCE((
         SELECT CASE
           WHEN json_valid(COALESCE(o.metadata_json, ''))
            AND json_type(o.metadata_json, '$.tags') = 'array'
             THEN json_extract(o.metadata_json, '$.tags')
           WHEN json_valid(COALESCE(o.metadata_json, ''))
            AND json_type(o.metadata_json, '$.properties.tags') = 'array'
             THEN json_extract(o.metadata_json, '$.properties.tags')
           ELSE '[]'
         END
         FROM sb_observations o
         WHERE o.id = sb_parent_versions.source_observation_id
         LIMIT 1
       ), '[]'),
       source_snapshot = (
         SELECT COALESCE(
           NULLIF(o.source_channel, ''),
           NULLIF(o.source, ''),
           CASE WHEN json_valid(COALESCE(o.metadata_json, ''))
             THEN COALESCE(
               json_extract(o.metadata_json, '$.source_channel'),
               json_extract(o.metadata_json, '$.provider'),
               json_extract(o.metadata_json, '$.source')
             ) END
         )
         FROM sb_observations o
         WHERE o.id = sb_parent_versions.source_observation_id
         LIMIT 1
       ),
       vault_snapshot = (
         SELECT CASE WHEN json_valid(COALESCE(o.metadata_json, ''))
           THEN COALESCE(
             json_extract(o.metadata_json, '$.vault_id'),
             json_extract(o.metadata_json, '$.vaultId'),
             json_extract(o.metadata_json, '$.properties.vault_id')
           ) END
         FROM sb_observations o
         WHERE o.id = sb_parent_versions.source_observation_id
         LIMIT 1
       ),
       metadata_snapshot_hash = 'legacy-observation:' || version_id,
       metadata_snapshot_source = 'inferred_from_observation'
   WHERE metadata_snapshot_hash IS NULL
     AND EXISTS (
       SELECT 1 FROM sb_observations o
       WHERE o.id = sb_parent_versions.source_observation_id
     )`,
  `UPDATE sb_parent_versions
   SET tags_snapshot_json = COALESCE((
         SELECT CASE
           WHEN json_valid(COALESCE(r.new_metadata_json, ''))
            AND json_type(r.new_metadata_json, '$.tags') = 'array'
             THEN json_extract(r.new_metadata_json, '$.tags')
           WHEN json_valid(COALESCE(r.new_metadata_json, ''))
            AND json_type(r.new_metadata_json, '$.properties.tags') = 'array'
             THEN json_extract(r.new_metadata_json, '$.properties.tags')
           ELSE '[]'
         END
         FROM sb_memory_revisions r
         WHERE r.memory_id IN (
           sb_parent_versions.parent_id,
           CASE WHEN sb_parent_versions.parent_id LIKE 'entry:%'
             THEN substr(sb_parent_versions.parent_id, 7)
             ELSE sb_parent_versions.parent_id END
         )
           AND r.created_at <= sb_parent_versions.created_at
           AND r.new_metadata_json IS NOT NULL
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 1
       ), '[]'),
       source_snapshot = (
         SELECT CASE WHEN json_valid(COALESCE(r.new_metadata_json, ''))
           THEN COALESCE(
             json_extract(r.new_metadata_json, '$.source_channel'),
             json_extract(r.new_metadata_json, '$.provider'),
             json_extract(r.new_metadata_json, '$.source')
           ) END
         FROM sb_memory_revisions r
         WHERE r.memory_id IN (
           sb_parent_versions.parent_id,
           CASE WHEN sb_parent_versions.parent_id LIKE 'entry:%'
             THEN substr(sb_parent_versions.parent_id, 7)
             ELSE sb_parent_versions.parent_id END
         )
           AND r.created_at <= sb_parent_versions.created_at
           AND r.new_metadata_json IS NOT NULL
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 1
       ),
       vault_snapshot = (
         SELECT CASE WHEN json_valid(COALESCE(r.new_metadata_json, ''))
           THEN COALESCE(
             json_extract(r.new_metadata_json, '$.vault_id'),
             json_extract(r.new_metadata_json, '$.vaultId'),
             json_extract(r.new_metadata_json, '$.properties.vault_id')
           ) END
         FROM sb_memory_revisions r
         WHERE r.memory_id IN (
           sb_parent_versions.parent_id,
           CASE WHEN sb_parent_versions.parent_id LIKE 'entry:%'
             THEN substr(sb_parent_versions.parent_id, 7)
             ELSE sb_parent_versions.parent_id END
         )
           AND r.created_at <= sb_parent_versions.created_at
           AND r.new_metadata_json IS NOT NULL
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 1
       ),
       metadata_snapshot_hash = 'legacy-revision:' || version_id,
       metadata_snapshot_source = 'inferred_from_revision'
   WHERE metadata_snapshot_hash IS NULL
     AND EXISTS (
       SELECT 1 FROM sb_memory_revisions r
       WHERE r.memory_id IN (
         sb_parent_versions.parent_id,
         CASE WHEN sb_parent_versions.parent_id LIKE 'entry:%'
           THEN substr(sb_parent_versions.parent_id, 7)
           ELSE sb_parent_versions.parent_id END
       )
         AND r.created_at <= sb_parent_versions.created_at
         AND r.new_metadata_json IS NOT NULL
     )`,
  `UPDATE sb_parent_versions
   SET tags_snapshot_json = '[]',
       source_snapshot = NULL,
       vault_snapshot = NULL,
       metadata_snapshot_hash = 'legacy-unknown:' || version_id,
       metadata_snapshot_source = 'unknown'
   WHERE metadata_snapshot_hash IS NULL`,
] as const;

export const PARENT_VERSION_TEMPORAL_BACKFILL_STATEMENTS = [
  `UPDATE sb_parent_versions
   SET activated_at = COALESCE(activated_at, created_at),
       activation_time_source = COALESCE(
         activation_time_source,
         CASE WHEN activated_at IS NULL THEN 'inferred' ELSE 'recorded' END
       )
   WHERE state IN ('active', 'active_degraded', 'superseded')
     AND (activated_at IS NULL OR activation_time_source IS NULL)`,
  `UPDATE sb_parent_versions
   SET superseded_time_source = COALESCE(
         superseded_time_source,
         CASE WHEN superseded_at IS NULL THEN 'inferred' ELSE 'recorded' END
       ),
       superseded_at = COALESCE(superseded_at,
         (SELECT MIN(COALESCE(next_version.activated_at, next_version.created_at))
          FROM sb_parent_versions next_version
          WHERE next_version.parent_id = sb_parent_versions.parent_id
            AND next_version.version_number > sb_parent_versions.version_number
            AND next_version.state IN ('active', 'active_degraded', 'superseded')),
         updated_at)
   WHERE state = 'superseded'
     AND (superseded_at IS NULL OR superseded_time_source IS NULL)`,
] as const;

export const OBSERVATION_EVIDENCE_MIGRATIONS = [
  { column: "source_channel", statement: `ALTER TABLE sb_observations ADD COLUMN source_channel TEXT` },
  { column: "source_identity", statement: `ALTER TABLE sb_observations ADD COLUMN source_identity TEXT` },
  { column: "author_type", statement: `ALTER TABLE sb_observations ADD COLUMN author_type TEXT NOT NULL DEFAULT 'unknown'` },
  { column: "source_uri", statement: `ALTER TABLE sb_observations ADD COLUMN source_uri TEXT` },
  { column: "source_timestamp", statement: `ALTER TABLE sb_observations ADD COLUMN source_timestamp INTEGER` },
  { column: "revision", statement: `ALTER TABLE sb_observations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1` },
  { column: "root_evidence_id", statement: `ALTER TABLE sb_observations ADD COLUMN root_evidence_id TEXT` },
  { column: "previous_evidence_id", statement: `ALTER TABLE sb_observations ADD COLUMN previous_evidence_id TEXT` },
] as const;

export const MEMORY_CLAIM_MIGRATIONS = [
  { column: "expired_at", statement: `ALTER TABLE sb_memories ADD COLUMN expired_at INTEGER` },
  { column: "parent_version_id", statement: `ALTER TABLE sb_memories ADD COLUMN parent_version_id TEXT` },
  { column: "claim_subject", statement: `ALTER TABLE sb_memories ADD COLUMN claim_subject TEXT` },
  { column: "claim_predicate", statement: `ALTER TABLE sb_memories ADD COLUMN claim_predicate TEXT` },
  { column: "claim_object", statement: `ALTER TABLE sb_memories ADD COLUMN claim_object TEXT` },
  { column: "scope_id", statement: `ALTER TABLE sb_memories ADD COLUMN scope_id TEXT` },
  { column: "polarity", statement: `ALTER TABLE sb_memories ADD COLUMN polarity TEXT NOT NULL DEFAULT 'positive'` },
  { column: "modality", statement: `ALTER TABLE sb_memories ADD COLUMN modality TEXT NOT NULL DEFAULT 'asserted'` },
  { column: "claim_status", statement: `ALTER TABLE sb_memories ADD COLUMN claim_status TEXT NOT NULL DEFAULT 'supported'` },
  { column: "scores_json", statement: `ALTER TABLE sb_memories ADD COLUMN scores_json TEXT NOT NULL DEFAULT '{}'` },
] as const;

export const MEMORY_SOURCE_PROVENANCE_MIGRATIONS = [
  { column: "relation", statement: `ALTER TABLE sb_memory_sources ADD COLUMN relation TEXT NOT NULL DEFAULT 'derived_from'` },
  { column: "extract_span", statement: `ALTER TABLE sb_memory_sources ADD COLUMN extract_span TEXT` },
  { column: "evidence_score", statement: `ALTER TABLE sb_memory_sources ADD COLUMN evidence_score REAL` },
  { column: "derivation_confidence", statement: `ALTER TABLE sb_memory_sources ADD COLUMN derivation_confidence REAL` },
  { column: "extractor_model", statement: `ALTER TABLE sb_memory_sources ADD COLUMN extractor_model TEXT` },
  { column: "extractor_version", statement: `ALTER TABLE sb_memory_sources ADD COLUMN extractor_version TEXT` },
  { column: "evidence_root_id", statement: `ALTER TABLE sb_memory_sources ADD COLUMN evidence_root_id TEXT` },
] as const;

export const EVIDENCE_CONTRACT_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_parent_versions_active_window
    ON sb_parent_versions(parent_id, activated_at, superseded_at)`,
  `CREATE INDEX IF NOT EXISTS idx_observations_evidence_root
    ON sb_observations(root_evidence_id, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_observations_source_identity
    ON sb_observations(source_channel, source_identity, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_claim_status
    ON sb_memories(claim_status, valid_from, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_scope
    ON sb_memories(scope_id, claim_status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_parent_version
    ON sb_memories(parent_version_id, claim_status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_sources_relation
    ON sb_memory_sources(relation, evidence_score, created_at DESC)`,
] as const;

export function normalizeEvidenceAuthorType(value: unknown): EvidenceAuthorType {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return (EVIDENCE_AUTHOR_TYPES as readonly string[]).includes(normalized)
    ? normalized as EvidenceAuthorType
    : "unknown";
}

export function normalizeClaimStatus(value: unknown): ClaimStatus {
  if (typeof value !== "string") return "supported";
  const normalized = value.trim().toLowerCase();
  return (CLAIM_STATUSES as readonly string[]).includes(normalized)
    ? normalized as ClaimStatus
    : "supported";
}

export function normalizeClaimPolarity(value: unknown): ClaimPolarity {
  if (typeof value !== "string") return "positive";
  const normalized = value.trim().toLowerCase();
  return (CLAIM_POLARITIES as readonly string[]).includes(normalized)
    ? normalized as ClaimPolarity
    : "positive";
}

export function normalizeClaimModality(value: unknown): ClaimModality {
  if (typeof value !== "string") return "asserted";
  const normalized = value.trim().toLowerCase();
  return (CLAIM_MODALITIES as readonly string[]).includes(normalized)
    ? normalized as ClaimModality
    : "asserted";
}

export function normalizeProvenanceRelation(value: unknown): ProvenanceRelation {
  if (typeof value !== "string") return "derived_from";
  const normalized = value.trim().toLowerCase();
  return (PROVENANCE_RELATIONS as readonly string[]).includes(normalized)
    ? normalized as ProvenanceRelation
    : "derived_from";
}

export interface ParentVersionMetadataSnapshot {
  tagsJson: string;
  source: string | null;
  vault: string | null;
  hash: string;
}

function normalizedSnapshotText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function snapshotRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function snapshotTags(value: unknown): string[] {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      candidate = [candidate];
    }
  }
  if (!Array.isArray(candidate)) return [];
  return [...new Set(candidate
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean))].sort();
}

function snapshotHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildParentVersionMetadataSnapshot(input: {
  metadata?: unknown;
  tags?: unknown;
  source?: unknown;
  vault?: unknown;
}): ParentVersionMetadataSnapshot {
  let metadataValue = input.metadata;
  if (typeof metadataValue === "string") {
    try {
      metadataValue = JSON.parse(metadataValue);
    } catch {
      metadataValue = {};
    }
  }
  const metadata = snapshotRecord(metadataValue);
  const properties = snapshotRecord(metadata.properties);
  const tags = snapshotTags(input.tags ?? metadata.tags ?? properties.tags);
  const source = normalizedSnapshotText(
    input.source ?? metadata.source_channel ?? metadata.provider ?? metadata.source
  );
  const vault = normalizedSnapshotText(
    input.vault ?? metadata.vault_id ?? metadata.vaultId ?? properties.vault_id
  );
  const canonical = JSON.stringify({ tags, source, vault });
  return {
    tagsJson: JSON.stringify(tags),
    source,
    vault,
    hash: snapshotHash(canonical),
  };
}

export function defaultClaimScores(input: {
  confidence?: number | null;
  evidenceScore?: number | null;
  humanConfirmed?: boolean;
  conflictState?: string | null;
}): Record<string, unknown> {
  const confidence = typeof input.confidence === "number" ? input.confidence : null;
  const evidenceScore = typeof input.evidenceScore === "number" ? input.evidenceScore : confidence;
  return {
    relevance: null,
    evidenceQuality: evidenceScore,
    derivationConfidence: confidence,
    maturity: null,
    sourceIndependence: null,
    temporalValidity: null,
    humanConfirmation: input.humanConfirmed ? 1 : null,
    conflictState: input.conflictState ?? "none",
  };
}

export function prepareParentUnitInsert(
  db: D1Database,
  input: {
    parentId: string;
    activeVersionId?: string | null;
    scopeId?: string | null;
    createdAt: number;
  }
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO sb_parent_units (
       parent_id, active_version_id, scope_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(parent_id) DO UPDATE SET
       updated_at = excluded.updated_at`
  ).bind(
    input.parentId,
    input.activeVersionId ?? null,
    input.scopeId ?? null,
    input.createdAt,
    input.createdAt
  );
}

export function prepareParentVersionInsert(
  db: D1Database,
  input: {
    versionId: string;
    parentId: string;
    versionNumber: number;
    sourceObservationId: string;
    sourceSnapshotHash: string | null;
    metadataSnapshot?: ParentVersionMetadataSnapshot;
    state?: ParentVersionState;
    createdAt: number;
  }
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO sb_parent_versions (
       version_id, parent_id, version_number, source_observation_id,
       source_snapshot_hash, tags_snapshot_json, source_snapshot, vault_snapshot,
       metadata_snapshot_hash, metadata_snapshot_source, summary, state,
       summary_vector_ids, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', NULL, ?, '[]', ?, ?)`
  ).bind(
    input.versionId,
    input.parentId,
    input.versionNumber,
    input.sourceObservationId,
    input.sourceSnapshotHash,
    input.metadataSnapshot?.tagsJson ?? "[]",
    input.metadataSnapshot?.source ?? null,
    input.metadataSnapshot?.vault ?? null,
    input.metadataSnapshot?.hash ?? null,
    input.state ?? "building",
    input.createdAt,
    input.createdAt
  );
}

export function prepareParentVersionClaimInsert(
  db: D1Database,
  input: {
    parentVersionId: string;
    memoryId: string;
    relation?: ProvenanceRelation | string | null;
    createdAt: number;
  }
): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO sb_parent_version_claims (
       parent_version_id, memory_id, relation, created_at
     ) VALUES (?, ?, ?, ?)`
  ).bind(
    input.parentVersionId,
    input.memoryId,
    normalizeProvenanceRelation(input.relation ?? "supports"),
    input.createdAt
  );
}

export function prepareParentVersionActivation(
  db: D1Database,
  input: {
    parentId: string;
    versionId: string;
    state?: ActiveParentVersionState;
    updatedAt: number;
  }
): D1PreparedStatement[] {
  const nextState = input.state ?? "active";
  return [
    db.prepare(
      `UPDATE sb_parent_versions
       SET state = ?,
           activation_time_source = CASE
             WHEN activated_at IS NULL THEN 'recorded'
             ELSE COALESCE(activation_time_source, 'recorded')
           END,
           activated_at = COALESCE(activated_at, ?),
           superseded_at = NULL,
           superseded_time_source = NULL,
           updated_at = ?
       WHERE parent_id = ?
         AND version_id = ?
         AND state = 'building'`
    ).bind(nextState, input.updatedAt, input.updatedAt, input.parentId, input.versionId),
    db.prepare(
      `UPDATE sb_parent_units
       SET active_version_id = ?, updated_at = ?
       WHERE parent_id = ?
         AND EXISTS (
           SELECT 1
           FROM sb_parent_versions
           WHERE version_id = ?
             AND parent_id = ?
             AND state IN ('active', 'active_degraded')
         )`
    ).bind(input.versionId, input.updatedAt, input.parentId, input.versionId, input.parentId),
    db.prepare(
      `UPDATE sb_parent_versions
       SET state = 'superseded',
           activation_time_source = COALESCE(
             activation_time_source,
             CASE WHEN activated_at IS NULL THEN 'inferred' ELSE 'recorded' END
           ),
           activated_at = COALESCE(activated_at, created_at),
           superseded_time_source = CASE
             WHEN superseded_at IS NULL THEN 'recorded'
             ELSE COALESCE(superseded_time_source, 'recorded')
           END,
           superseded_at = COALESCE(superseded_at, ?),
           updated_at = ?
       WHERE parent_id = ?
         AND state IN ('active', 'active_degraded')
         AND version_id <> ?
         AND EXISTS (
           SELECT 1
           FROM sb_parent_units
           WHERE parent_id = ?
             AND active_version_id = ?
         )`
    ).bind(input.updatedAt, input.updatedAt, input.parentId, input.versionId, input.parentId, input.versionId),
  ];
}

export function prepareParentVersionFailure(
  db: D1Database,
  input: {
    versionId: string;
    updatedAt: number;
  }
): D1PreparedStatement {
  return db.prepare(
    `UPDATE sb_parent_versions
     SET state = 'failed', updated_at = ?
     WHERE version_id = ?
       AND state = 'building'`
  ).bind(input.updatedAt, input.versionId);
}
