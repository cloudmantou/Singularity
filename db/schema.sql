-- Run with: wrangler d1 execute second-brain-db --file=schema.sql

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
  pending_content_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
CREATE INDEX IF NOT EXISTS idx_entries_classification_queue
  ON entries(classification_status, classification_next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_entries_pending_vectors
  ON entries(pending_embedding_fingerprint, pending_vector_ids, created_at);

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

-- Atomic memory layer (Observation → Memory → Source)
CREATE TABLE IF NOT EXISTS sb_observations (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'api',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT,
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

CREATE TABLE IF NOT EXISTS sb_memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  kind TEXT,
  memory_class TEXT,
  importance REAL,
  confidence REAL,
  entry_id TEXT,
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

CREATE TABLE IF NOT EXISTS sb_memory_sources (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'derived_from',
  score REAL,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, observation_id, role)
);
CREATE INDEX IF NOT EXISTS idx_sb_memory_sources_memory ON sb_memory_sources(memory_id);
CREATE INDEX IF NOT EXISTS idx_sb_memory_sources_observation ON sb_memory_sources(observation_id);

-- Entity + temporal fact graph
CREATE TABLE IF NOT EXISTS sb_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  entity_type TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  mention_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(name_normalized)
);
CREATE INDEX IF NOT EXISTS idx_sb_entities_name ON sb_entities(name_normalized);
CREATE INDEX IF NOT EXISTS idx_sb_entities_type ON sb_entities(entity_type, updated_at DESC);

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
  memory_id TEXT,
  observation_id TEXT,
  score REAL,
  valid_from INTEGER,
  valid_to INTEGER,
  invalid_at INTEGER,
  expired_at INTEGER,
  reference_time INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_from
  ON sb_entity_relations(from_entity_id, relation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_to
  ON sb_entity_relations(to_entity_id, relation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sb_entity_relations_memory ON sb_entity_relations(memory_id);
