-- Run with: wrangler d1 execute second-brain-db --file=schema.sql

CREATE TABLE IF NOT EXISTS sb_schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id               TEXT PRIMARY KEY,
  content          TEXT NOT NULL,
  tags             TEXT NOT NULL DEFAULT '[]',   -- JSON array
  source           TEXT NOT NULL DEFAULT 'api',  -- 'phone', 'browser', 'voice', 'claude', 'api'
  created_at       INTEGER NOT NULL,             -- Unix ms timestamp
  vector_ids       TEXT NOT NULL DEFAULT '[]',   -- JSON array of Vectorize vector IDs
  recall_count         INTEGER DEFAULT 0,
  importance_score     INTEGER DEFAULT 0,
  classification_confidence      REAL,
  classification_status          TEXT NOT NULL DEFAULT 'pending',
  classification_error           TEXT,
  classification_attempts        INTEGER NOT NULL DEFAULT 0,
  classification_next_attempt_at INTEGER,
  classification_started_at      INTEGER,
  classification_version         INTEGER NOT NULL DEFAULT 1,
  classified_at                  INTEGER,
  contradiction_wins   INTEGER DEFAULT 0,
  contradiction_losses INTEGER DEFAULT 0,
  content_hash          TEXT,
  embedding_fingerprint TEXT,
  pending_vector_ids TEXT,
  pending_embedding_fingerprint TEXT,
  pending_content_hash TEXT,
  pending_revision_id TEXT,
  pending_rebuild_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
CREATE INDEX IF NOT EXISTS idx_entries_classification_queue
  ON entries(classification_status, classification_next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_entries_pending_vectors
  ON entries(pending_embedding_fingerprint, pending_vector_ids, created_at);
CREATE INDEX IF NOT EXISTS idx_entries_pending_rebuild
  ON entries(pending_rebuild_id, pending_vector_ids, created_at);

CREATE TABLE IF NOT EXISTS sb_external_links (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_links_identity
  ON sb_external_links(provider, vault_id, external_path, external_block_id, object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_external_links_entry
  ON sb_external_links(entry_id);
CREATE INDEX IF NOT EXISTS idx_external_links_provider_vault
  ON sb_external_links(provider, vault_id, sync_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS sb_external_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  external_path TEXT NOT NULL,
  external_block_id TEXT NOT NULL DEFAULT '',
  current_observation_id TEXT,
  last_content_hash TEXT,
  last_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, vault_id, external_path, external_block_id)
);
CREATE INDEX IF NOT EXISTS idx_external_sources_provider_vault
  ON sb_external_sources(provider, vault_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sb_access_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  vault_id TEXT,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_access_tokens_hash
  ON sb_access_tokens(token_hash);

CREATE TABLE IF NOT EXISTS sb_automation_rules (
  id TEXT PRIMARY KEY,
  vault_id TEXT,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  source_filter_json TEXT NOT NULL DEFAULT '{}',
  extractor_schema_json TEXT NOT NULL DEFAULT '{}',
  tag_rules_json TEXT NOT NULL DEFAULT '{}',
  aggregation_rule_json TEXT NOT NULL DEFAULT '{}',
  output_template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger
  ON sb_automation_rules(trigger_type, enabled, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_rules_vault
  ON sb_automation_rules(vault_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS sb_knowledge_aggregates (
  id TEXT PRIMARY KEY,
  vault_id TEXT,
  aggregate_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_memory_ids_json TEXT NOT NULL DEFAULT '[]',
  generation_rule_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT,
  generated_at INTEGER NOT NULL,
  stale_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_aggregates_stale
  ON sb_knowledge_aggregates(stale_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_aggregates_vault
  ON sb_knowledge_aggregates(vault_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sb_vector_rebuilds (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL UNIQUE DEFAULT 'current',
  state TEXT NOT NULL,
  active_fingerprint TEXT NOT NULL,
  pending_fingerprint TEXT NOT NULL,
  expected_entries INTEGER NOT NULL DEFAULT 0,
  processed_entries INTEGER NOT NULL DEFAULT 0,
  failed_entries INTEGER NOT NULL DEFAULT 0,
  conflict_entries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (slot = 'current'),
  CHECK (
    state IN (
      'queued',
      'building',
      'ready',
      'activating',
      'active',
      'cancelling',
      'cancelled',
      'failed'
    )
  )
);

CREATE TABLE IF NOT EXISTS sb_vector_cleanup_queue (
  id TEXT PRIMARY KEY,
  vector_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  rebuild_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state IN ('ready', 'blocked', 'failed', 'completed'))
);
CREATE INDEX IF NOT EXISTS idx_sb_vector_cleanup_queue_created
  ON sb_vector_cleanup_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_vector_cleanup_due
  ON sb_vector_cleanup_queue(state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS sb_vector_cleanup_batches (
  id TEXT PRIMARY KEY,
  rebuild_id TEXT NOT NULL,
  vector_ids_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state IN ('prepared', 'ready', 'processing', 'failed', 'completed', 'blocked'))
);
CREATE INDEX IF NOT EXISTS idx_vector_cleanup_batches_due
  ON sb_vector_cleanup_batches(state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS sb_memory_relations (
  id             TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL,
  to_memory_id   TEXT NOT NULL,
  relation_type  TEXT NOT NULL,
  score           REAL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  UNIQUE(from_memory_id, to_memory_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_sb_memory_relations_from
  ON sb_memory_relations(from_memory_id, relation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sb_memory_relations_to
  ON sb_memory_relations(to_memory_id, relation_type, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_memory_revisions (
  id                TEXT PRIMARY KEY,
  memory_id         TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  old_content       TEXT,
  new_content       TEXT,
  old_metadata_json TEXT,
  new_metadata_json TEXT,
  reason            TEXT,
  actor             TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sb_memory_revisions_memory
  ON sb_memory_revisions(memory_id, created_at ASC);

CREATE TABLE IF NOT EXISTS sb_memory_merge_candidates (
  id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  similarity REAL,
  suggested_action TEXT NOT NULL,
  reason TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (suggested_action IN ('merge', 'replace', 'keep_both', 'duplicate')),
  CHECK (state IN ('pending', 'accepted', 'rejected', 'resolved'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_merge_candidates_identity
  ON sb_memory_merge_candidates(source_memory_id, target_memory_id, suggested_action);
CREATE INDEX IF NOT EXISTS idx_memory_merge_candidates_state
  ON sb_memory_merge_candidates(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_merge_candidates_source
  ON sb_memory_merge_candidates(source_memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_merge_candidates_target
  ON sb_memory_merge_candidates(target_memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_conflict_cases (
  id TEXT PRIMARY KEY,
  old_memory_id TEXT NOT NULL,
  new_memory_id TEXT NOT NULL,
  old_claim_id TEXT,
  new_claim_id TEXT,
  conflict_type TEXT NOT NULL,
  reason TEXT,
  confidence REAL,
  state TEXT NOT NULL DEFAULT 'pending',
  resolution TEXT,
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (state IN ('pending', 'resolved', 'dismissed')),
  CHECK (resolution IS NULL OR resolution IN ('use_old', 'use_new', 'keep_both', 'manual', 'dismissed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_cases_identity
  ON sb_conflict_cases(
    COALESCE(old_claim_id, old_memory_id),
    COALESCE(new_claim_id, new_memory_id),
    conflict_type
  );
CREATE INDEX IF NOT EXISTS idx_conflict_cases_state
  ON sb_conflict_cases(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conflict_cases_old
  ON sb_conflict_cases(old_memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conflict_cases_new
  ON sb_conflict_cases(new_memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conflict_cases_old_claim
  ON sb_conflict_cases(old_claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conflict_cases_new_claim
  ON sb_conflict_cases(new_claim_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_audit_events (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  trace_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  token_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  vault_id TEXT,
  before_hash TEXT,
  after_hash TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_audit_events_occurred
  ON sb_audit_events(occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_trace
  ON sb_audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_object
  ON sb_audit_events(object_type, object_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_vault
  ON sb_audit_events(vault_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_token
  ON sb_audit_events(token_id, occurred_at DESC);

-- Atomic memory layer (Observation → Memory → Source)
CREATE TABLE IF NOT EXISTS sb_observations (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT,
  source_channel TEXT,
  source_identity TEXT,
  author_type TEXT NOT NULL DEFAULT 'unknown',
  source_uri TEXT,
  source_timestamp INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  root_evidence_id TEXT,
  previous_evidence_id TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extraction_version INTEGER NOT NULL DEFAULT 1,
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  extraction_error TEXT,
  next_attempt_at INTEGER,
  processing_started_at INTEGER,
  processed_at INTEGER,
  needs_reprocess INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sb_observations_created
  ON sb_observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sb_observations_hash
  ON sb_observations(content_hash);
CREATE INDEX IF NOT EXISTS idx_sb_observations_extraction_queue
  ON sb_observations(extraction_status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_observations_evidence_root
  ON sb_observations(root_evidence_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_observations_source_identity
  ON sb_observations(source_channel, source_identity, revision DESC);

CREATE TABLE IF NOT EXISTS sb_scopes (
  scope_id TEXT PRIMARY KEY,
  parent_scope_id TEXT,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  scope_type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scopes_parent
  ON sb_scopes(parent_scope_id, canonical_name);
CREATE INDEX IF NOT EXISTS idx_scopes_type
  ON sb_scopes(scope_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS sb_parent_units (
  parent_id TEXT PRIMARY KEY,
  active_version_id TEXT,
  scope_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parent_units_active
  ON sb_parent_units(active_version_id);
CREATE INDEX IF NOT EXISTS idx_parent_units_scope
  ON sb_parent_units(scope_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sb_parent_versions (
  version_id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  source_observation_id TEXT,
  source_snapshot_hash TEXT,
  summary TEXT,
  state TEXT NOT NULL DEFAULT 'building',
  summary_vector_ids TEXT NOT NULL DEFAULT '[]',
  activated_at INTEGER,
  superseded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state IN ('building', 'active', 'active_degraded', 'superseded', 'failed')),
  UNIQUE(parent_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_parent_versions_parent
  ON sb_parent_versions(parent_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_parent_versions_source
  ON sb_parent_versions(source_observation_id);
CREATE INDEX IF NOT EXISTS idx_parent_versions_state
  ON sb_parent_versions(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_parent_versions_active_window
  ON sb_parent_versions(parent_id, activated_at, superseded_at);

CREATE TABLE IF NOT EXISTS sb_parent_version_claims (
  parent_version_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'supports',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (parent_version_id, memory_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_parent_version_claims_memory
  ON sb_parent_version_claims(memory_id, parent_version_id);
CREATE INDEX IF NOT EXISTS idx_parent_version_claims_parent
  ON sb_parent_version_claims(parent_version_id, relation, created_at DESC);

-- Non-authoritative Parent-to-Parent navigation graph.
-- Association edges expand context only; they never support Fact/Claim truth.
CREATE TABLE IF NOT EXISTS sb_association_edges (
  id TEXT PRIMARY KEY,
  source_parent_id TEXT NOT NULL,
  target_parent_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  provenance TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_parent_id, target_parent_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_association_edges_target
  ON sb_association_edges(target_parent_id, weight DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS sb_memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  kind TEXT,
  memory_class TEXT,
  importance REAL,
  confidence REAL,
  entry_id TEXT,
  parent_version_id TEXT,
  claim_subject TEXT,
  claim_predicate TEXT,
  claim_object TEXT,
  scope_id TEXT,
  polarity TEXT NOT NULL DEFAULT 'positive',
  modality TEXT NOT NULL DEFAULT 'asserted',
  claim_status TEXT NOT NULL DEFAULT 'supported',
  scores_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT,
  observed_at INTEGER,
  valid_from INTEGER,
  valid_to INTEGER,
  reference_time INTEGER,
  invalid_at INTEGER,
  expired_at INTEGER,
  entities_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sb_memories_entry ON sb_memories(entry_id);
CREATE INDEX IF NOT EXISTS idx_sb_memories_hash ON sb_memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_sb_memories_created ON sb_memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_claim_status
  ON sb_memories(claim_status, valid_from, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_scope
  ON sb_memories(scope_id, claim_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_parent_version
  ON sb_memories(parent_version_id, claim_status, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_memory_sources (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'derived_from',
  score REAL,
  relation TEXT NOT NULL DEFAULT 'derived_from',
  extract_span TEXT,
  evidence_score REAL,
  derivation_confidence REAL,
  extractor_model TEXT,
  extractor_version TEXT,
  evidence_root_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, observation_id, role)
);
CREATE INDEX IF NOT EXISTS idx_sb_memory_sources_memory ON sb_memory_sources(memory_id);
CREATE INDEX IF NOT EXISTS idx_sb_memory_sources_observation ON sb_memory_sources(observation_id);
CREATE INDEX IF NOT EXISTS idx_memory_sources_relation
  ON sb_memory_sources(relation, evidence_score, created_at DESC);

-- Entity + temporal fact graph
CREATE TABLE IF NOT EXISTS sb_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  entity_type TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  mention_count INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  merged_into_entity_id TEXT,
  merged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (lifecycle_state IN ('active', 'merged')),
  UNIQUE(name_normalized)
);
CREATE INDEX IF NOT EXISTS idx_sb_entities_name ON sb_entities(name_normalized);
CREATE INDEX IF NOT EXISTS idx_sb_entities_type ON sb_entities(entity_type, updated_at DESC);
CREATE TABLE IF NOT EXISTS sb_entity_aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  source_observation_id TEXT,
  confidence REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(entity_id, alias_normalized)
);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_lookup ON sb_entity_aliases(alias_normalized, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity ON sb_entity_aliases(entity_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS sb_entity_alias_sources (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'supports',
  created_at INTEGER NOT NULL,
  UNIQUE(alias_id, observation_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_entity_alias_sources_alias ON sb_entity_alias_sources(alias_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_alias_sources_observation ON sb_entity_alias_sources(observation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_entity_external_ids (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_observation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(entity_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_external_ids_lookup ON sb_entity_external_ids(provider, external_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_external_ids_identity ON sb_entity_external_ids(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_entity_external_ids_entity ON sb_entity_external_ids(entity_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS sb_entity_external_id_sources (
  id TEXT PRIMARY KEY,
  external_id_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'supports',
  created_at INTEGER NOT NULL,
  UNIQUE(external_id_id, observation_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_entity_external_id_sources_external ON sb_entity_external_id_sources(external_id_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_external_id_sources_observation ON sb_entity_external_id_sources(observation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_entity_embeddings (
  entity_id TEXT NOT NULL,
  embedding_fingerprint TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(entity_id, embedding_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_entity_embeddings_profile ON sb_entity_embeddings(embedding_fingerprint, updated_at DESC);

CREATE TABLE IF NOT EXISTS sb_entity_merge_candidates (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  matched_by TEXT NOT NULL,
  score REAL,
  reason_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'pending',
  source_observation_id TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state IN ('pending', 'accepted', 'rejected', 'merged')),
  UNIQUE(source_entity_id, target_entity_id, state)
);
CREATE INDEX IF NOT EXISTS idx_entity_merge_candidates_state ON sb_entity_merge_candidates(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_merge_candidates_source ON sb_entity_merge_candidates(source_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_merge_candidates_target ON sb_entity_merge_candidates(target_entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_entity_merge_history (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  candidate_id TEXT,
  actor_type TEXT NOT NULL,
  reason TEXT,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_merge_history_source ON sb_entity_merge_history(source_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_merge_history_target ON sb_entity_merge_history(target_entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_memory_entities (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'mentions',
  score REAL,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_sb_memory_entities_memory ON sb_memory_entities(memory_id);
CREATE INDEX IF NOT EXISTS idx_sb_memory_entities_entity ON sb_memory_entities(entity_id);

CREATE TABLE IF NOT EXISTS sb_entity_relations (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  fact TEXT,
  fact_hash TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  memory_id TEXT,
  observation_id TEXT,
  score REAL,
  valid_from INTEGER,
  valid_to INTEGER,
  invalid_at INTEGER,
  expired_at INTEGER,
  reference_time INTEGER,
  scope_id TEXT,
  polarity TEXT NOT NULL DEFAULT 'positive',
  modality TEXT NOT NULL DEFAULT 'asserted',
  resolution_type TEXT NOT NULL DEFAULT 'coexists',
  resolution_state TEXT NOT NULL DEFAULT 'active',
  supersedes_relation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_from
  ON sb_entity_relations(from_entity_id, relation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_to
  ON sb_entity_relations(to_entity_id, relation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_memory ON sb_entity_relations(memory_id);
CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_fact_hash
  ON sb_entity_relations(from_entity_id, to_entity_id, relation_type, fact_hash);
CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_resolution
  ON sb_entity_relations(from_entity_id, relation_type, scope_id, resolution_state, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_fact_resolutions (
  id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL,
  target_relation_id TEXT,
  resolution_type TEXT NOT NULL,
  confidence REAL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  requires_review INTEGER NOT NULL DEFAULT 0,
  applied_invalidation INTEGER NOT NULL DEFAULT 0,
  source_memory_id TEXT,
  target_memory_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK (resolution_type IN ('duplicate', 'supports', 'elaborates', 'coexists', 'supersedes', 'contradicts', 'uncertain'))
);
CREATE INDEX IF NOT EXISTS idx_fact_resolutions_relation ON sb_fact_resolutions(relation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_resolutions_target ON sb_fact_resolutions(target_relation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_resolutions_review ON sb_fact_resolutions(requires_review, created_at DESC);

CREATE TABLE IF NOT EXISTS sb_fact_sources (
  id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL,
  memory_id TEXT,
  observation_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(relation_id, memory_id, observation_id)
);
CREATE INDEX IF NOT EXISTS idx_sb_fact_sources_relation ON sb_fact_sources(relation_id);
CREATE INDEX IF NOT EXISTS idx_sb_fact_sources_memory ON sb_fact_sources(memory_id);
DELETE FROM sb_fact_sources
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM sb_fact_sources
  GROUP BY
    relation_id,
    COALESCE(memory_id, ''),
    COALESCE(observation_id, '')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_sources_identity
  ON sb_fact_sources (
    relation_id,
    COALESCE(memory_id, ''),
    COALESCE(observation_id, '')
  );
