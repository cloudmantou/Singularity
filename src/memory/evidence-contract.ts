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
    summary TEXT,
    state TEXT NOT NULL DEFAULT 'building',
    summary_vector_ids TEXT NOT NULL DEFAULT '[]',
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
    state?: ParentVersionState;
    createdAt: number;
  }
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO sb_parent_versions (
       version_id, parent_id, version_number, source_observation_id,
       source_snapshot_hash, summary, state, summary_vector_ids, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, '[]', ?, ?)`
  ).bind(
    input.versionId,
    input.parentId,
    input.versionNumber,
    input.sourceObservationId,
    input.sourceSnapshotHash,
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
       SET state = ?, updated_at = ?
       WHERE parent_id = ?
         AND version_id = ?
         AND state = 'building'`
    ).bind(nextState, input.updatedAt, input.parentId, input.versionId),
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
       SET state = 'superseded', updated_at = ?
       WHERE parent_id = ?
         AND state IN ('active', 'active_degraded')
         AND version_id <> ?
         AND EXISTS (
           SELECT 1
           FROM sb_parent_units
           WHERE parent_id = ?
             AND active_version_id = ?
         )`
    ).bind(input.updatedAt, input.parentId, input.versionId, input.parentId, input.versionId),
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
