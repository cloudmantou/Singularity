import { getTraceId } from "../telemetry";

export const MERGE_SUGGESTED_ACTIONS = [
  "merge",
  "replace",
  "keep_both",
  "duplicate",
] as const;

export const MERGE_CANDIDATE_STATES = [
  "pending",
  "accepted",
  "rejected",
  "resolved",
] as const;

export const CONFLICT_CASE_STATES = [
  "pending",
  "resolved",
  "dismissed",
] as const;

export const CONFLICT_RESOLUTIONS = [
  "use_old",
  "use_new",
  "keep_both",
  "manual",
  "dismissed",
] as const;

export type MergeSuggestedAction = (typeof MERGE_SUGGESTED_ACTIONS)[number];
export type MergeCandidateState = (typeof MERGE_CANDIDATE_STATES)[number];
export type ConflictCaseState = (typeof CONFLICT_CASE_STATES)[number];
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

export const MEMORY_QUALITY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_memory_merge_candidates (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_merge_candidates_identity
   ON sb_memory_merge_candidates(source_memory_id, target_memory_id, suggested_action)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_merge_candidates_state
   ON sb_memory_merge_candidates(state, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_merge_candidates_source
   ON sb_memory_merge_candidates(source_memory_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_merge_candidates_target
   ON sb_memory_merge_candidates(target_memory_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sb_conflict_cases (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_cases_identity
   ON sb_conflict_cases(old_memory_id, new_memory_id, conflict_type)`,
  `CREATE INDEX IF NOT EXISTS idx_conflict_cases_state
   ON sb_conflict_cases(state, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_conflict_cases_old
   ON sb_conflict_cases(old_memory_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_conflict_cases_new
   ON sb_conflict_cases(new_memory_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sb_audit_events (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_occurred
   ON sb_audit_events(occurred_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_trace
   ON sb_audit_events(trace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_object
   ON sb_audit_events(object_type, object_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_vault
   ON sb_audit_events(vault_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_token
   ON sb_audit_events(token_id, occurred_at DESC)`,
] as const;

export interface MemoryMergeCandidateInput {
  sourceMemoryId: string;
  targetMemoryId: string;
  similarity?: number | null;
  suggestedAction: MergeSuggestedAction;
  reason?: string | null;
  createdAt?: number;
}

export interface ConflictCaseInput {
  oldMemoryId: string;
  newMemoryId: string;
  oldClaimId?: string | null;
  newClaimId?: string | null;
  conflictType: string;
  reason?: string | null;
  confidence?: number | null;
  createdAt?: number;
}

export async function ensureConflictClaimSchema(db: D1Database): Promise<void> {
  const columns = await db.prepare(`PRAGMA table_info(sb_conflict_cases)`).all<{ name: string }>();
  const names = new Set((columns.results ?? []).map((column) => column.name));
  if (!names.has("old_claim_id")) {
    await db.exec(`ALTER TABLE sb_conflict_cases ADD COLUMN old_claim_id TEXT`);
  }
  if (!names.has("new_claim_id")) {
    await db.exec(`ALTER TABLE sb_conflict_cases ADD COLUMN new_claim_id TEXT`);
  }
  const identityIndex = await db.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'index' AND name = 'idx_conflict_cases_identity'
     LIMIT 1`
  ).first<{ sql: string | null }>();
  const identityUsesClaims = identityIndex?.sql?.includes("old_claim_id") === true;
  if (!names.has("old_claim_id") || !names.has("new_claim_id") || !identityUsesClaims) {
    await db.exec(`DROP INDEX IF EXISTS idx_conflict_cases_identity`);
    await db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_cases_identity
       ON sb_conflict_cases(
         COALESCE(old_claim_id, old_memory_id),
         COALESCE(new_claim_id, new_memory_id),
         conflict_type
       )`
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_conflict_cases_old_claim
       ON sb_conflict_cases(old_claim_id, created_at DESC)`
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_conflict_cases_new_claim
       ON sb_conflict_cases(new_claim_id, created_at DESC)`
    );
  }
}

export interface ComplianceAuditEventInput {
  occurredAt?: number;
  traceId?: string | null;
  actorType: string;
  actorId?: string | null;
  tokenId?: string | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  vaultId?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
  success?: boolean;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PreparedComplianceAuditEvent {
  record: {
    id: string;
    occurred_at: number;
    trace_id: string | null;
    actor_type: string;
    actor_id: string | null;
    token_id: string | null;
    action: string;
    object_type: string;
    object_id: string | null;
    vault_id: string | null;
    before_hash: string | null;
    after_hash: string | null;
    success: number;
    error_code: string | null;
    metadata_json: string;
    previous_event_hash: string | null;
    event_hash: string;
  };
  statement: D1PreparedStatement;
}

function boundedText(value: unknown, max = 512): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function boundedRequiredText(value: unknown, field: string, max = 512): string {
  const text = boundedText(value, max);
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function normalizeSimilarity(value: unknown): number | null {
  if (value == null) return null;
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(score, 1));
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = (value as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function latestAuditEventHash(db: D1Database): Promise<string | null> {
  const row = await db.prepare(
    `SELECT event_hash FROM sb_audit_events
     ORDER BY occurred_at DESC, id DESC
     LIMIT 1`
  ).first<{ event_hash: string }>();
  return boundedText(row?.event_hash, 128);
}

export function prepareMemoryMergeCandidate(
  db: D1Database,
  input: MemoryMergeCandidateInput
): { statement: D1PreparedStatement } {
  const sourceMemoryId = boundedRequiredText(input.sourceMemoryId, "sourceMemoryId");
  const targetMemoryId = boundedRequiredText(input.targetMemoryId, "targetMemoryId");
  if (sourceMemoryId === targetMemoryId) {
    throw new Error("Merge candidate endpoints must differ");
  }
  if (!(MERGE_SUGGESTED_ACTIONS as readonly string[]).includes(input.suggestedAction)) {
    throw new Error("Unsupported merge suggested action");
  }
  return {
    statement: db.prepare(
      `INSERT OR IGNORE INTO sb_memory_merge_candidates (
         id, source_memory_id, target_memory_id, similarity,
         suggested_action, reason, state, reviewed_by, reviewed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`
    ).bind(
      crypto.randomUUID(),
      sourceMemoryId,
      targetMemoryId,
      normalizeSimilarity(input.similarity),
      input.suggestedAction,
      boundedText(input.reason, 1000),
      input.createdAt ?? Date.now()
    ),
  };
}

export function prepareConflictCase(
  db: D1Database,
  input: ConflictCaseInput
): { statement: D1PreparedStatement } {
  const oldMemoryId = boundedRequiredText(input.oldMemoryId, "oldMemoryId");
  const newMemoryId = boundedRequiredText(input.newMemoryId, "newMemoryId");
  if (oldMemoryId === newMemoryId) {
    throw new Error("Conflict case endpoints must differ");
  }
  return {
    statement: db.prepare(
      `INSERT OR IGNORE INTO sb_conflict_cases (
         id, old_memory_id, new_memory_id, old_claim_id, new_claim_id, conflict_type, reason,
         confidence, state, resolution, resolved_by, resolved_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)`
    ).bind(
      crypto.randomUUID(),
      oldMemoryId,
      newMemoryId,
      boundedText(input.oldClaimId, 512),
      boundedText(input.newClaimId, 512),
      boundedRequiredText(input.conflictType, "conflictType", 128),
      boundedText(input.reason, 1000),
      normalizeSimilarity(input.confidence),
      input.createdAt ?? Date.now()
    ),
  };
}

export async function prepareComplianceAuditEvent(
  db: D1Database,
  input: ComplianceAuditEventInput
): Promise<PreparedComplianceAuditEvent> {
  const previousEventHash = await latestAuditEventHash(db);
  const record = {
    id: crypto.randomUUID(),
    occurred_at: input.occurredAt ?? Date.now(),
    trace_id: boundedText(input.traceId ?? getTraceId(), 128),
    actor_type: boundedRequiredText(input.actorType, "actorType", 64),
    actor_id: boundedText(input.actorId, 256),
    token_id: boundedText(input.tokenId, 256),
    action: boundedRequiredText(input.action, "action", 128),
    object_type: boundedRequiredText(input.objectType, "objectType", 128),
    object_id: boundedText(input.objectId, 256),
    vault_id: boundedText(input.vaultId, 256),
    before_hash: boundedText(input.beforeHash, 256),
    after_hash: boundedText(input.afterHash, 256),
    success: input.success === false ? 0 : 1,
    error_code: boundedText(input.errorCode, 128),
    metadata_json: stableJson(input.metadata ?? {}),
    previous_event_hash: previousEventHash,
    event_hash: "",
  };
  record.event_hash = await sha256Hex(stableJson(record));
  return {
    record,
    statement: db.prepare(
      `INSERT INTO sb_audit_events (
         id, occurred_at, trace_id, actor_type, actor_id, token_id,
         action, object_type, object_id, vault_id, before_hash, after_hash,
         success, error_code, metadata_json, previous_event_hash, event_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      record.id,
      record.occurred_at,
      record.trace_id,
      record.actor_type,
      record.actor_id,
      record.token_id,
      record.action,
      record.object_type,
      record.object_id,
      record.vault_id,
      record.before_hash,
      record.after_hash,
      record.success,
      record.error_code,
      record.metadata_json,
      record.previous_event_hash,
      record.event_hash
    ),
  };
}

export async function recordComplianceAuditEvent(
  db: D1Database,
  input: ComplianceAuditEventInput
): Promise<void> {
  const prepared = await prepareComplianceAuditEvent(db, input);
  await prepared.statement.run();
}
