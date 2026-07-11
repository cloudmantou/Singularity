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
  content_hash          TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_content_hash ON entries(content_hash);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
CREATE INDEX IF NOT EXISTS idx_entries_classification_queue
  ON entries(classification_status, classification_next_attempt_at, created_at);

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
