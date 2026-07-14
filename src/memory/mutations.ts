export type MemoryMutationOperation = "append" | "update";

export type MemoryMutationState =
  | "preparing"
  | "entry_committed"
  | "knowledge_committed"
  | "projection_pending"
  | "completed"
  | "failed";

export type MemoryMutationFailureClass = "retryable" | "terminal";

export interface MemoryMutationRecord {
  mutationId: string;
  idempotencyKey: string;
  sourceChannel: string;
  operation: MemoryMutationOperation;
  entryId: string;
  requestHash: string;
  state: MemoryMutationState;
  resultContent: string | null;
  resultContentHash: string | null;
  resultVectorCount: number | null;
  observationId: string | null;
  claimId: string | null;
  warnings: string[];
  lastError: string | null;
  retryCount: number;
  nextRetryAt: number | null;
  failureClass: MemoryMutationFailureClass | null;
  terminal: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type BeginMemoryMutationResult =
  | { status: "started" | "resumed"; mutation: MemoryMutationRecord; leaseOwner: string }
  | { status: "replay" | "conflict" | "in_progress"; mutation: MemoryMutationRecord; leaseOwner?: undefined };

interface MemoryMutationRow {
  mutation_id: string;
  idempotency_key: string;
  source_channel: string;
  operation: MemoryMutationOperation;
  entry_id: string;
  request_hash: string;
  state: MemoryMutationState;
  result_content: string | null;
  result_content_hash: string | null;
  result_vector_count: number | null;
  observation_id: string | null;
  claim_id: string | null;
  warnings_json: string;
  last_error: string | null;
  retry_count: number;
  next_retry_at: number | null;
  failure_class: MemoryMutationFailureClass | null;
  terminal: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryMutationHealth {
  preparing: number;
  entry_committed: number;
  knowledge_committed: number;
  projection_pending: number;
  failed: number;
  completed: number;
  incomplete: number;
  stale_incomplete: number;
  retryable_failed: number;
  terminal_failed: number;
}

const MUTATION_LEASE_MS = 5 * 60 * 1000;

export const MEMORY_MUTATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_memory_mutations (
    mutation_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    source_channel TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('append', 'update')),
    entry_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'preparing',
      'entry_committed',
      'knowledge_committed',
      'projection_pending',
      'completed',
      'failed'
    )),
    result_content TEXT,
    result_content_hash TEXT,
    result_vector_count INTEGER,
    observation_id TEXT,
    claim_id TEXT,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    last_error TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    failure_class TEXT,
    terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
    lease_owner TEXT,
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_channel, operation, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_mutations_state
    ON sb_memory_mutations(state, terminal, next_retry_at, lease_expires_at, updated_at)`,
] as const;

export const MEMORY_MUTATION_COLUMN_MIGRATIONS = [
  { column: "retry_count", statement: "ALTER TABLE sb_memory_mutations ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0" },
  { column: "next_retry_at", statement: "ALTER TABLE sb_memory_mutations ADD COLUMN next_retry_at INTEGER" },
  { column: "failure_class", statement: "ALTER TABLE sb_memory_mutations ADD COLUMN failure_class TEXT" },
  { column: "terminal", statement: "ALTER TABLE sb_memory_mutations ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0" },
] as const;

export const MEMORY_MUTATION_RECOVERY_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_mutations_recovery
   ON sb_memory_mutations(state, terminal, next_retry_at, updated_at)`,
] as const;

function changes(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0);
}

function parseWarnings(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toRecord(row: MemoryMutationRow): MemoryMutationRecord {
  return {
    mutationId: row.mutation_id,
    idempotencyKey: row.idempotency_key,
    sourceChannel: row.source_channel,
    operation: row.operation,
    entryId: row.entry_id,
    requestHash: row.request_hash,
    state: row.state,
    resultContent: row.result_content,
    resultContentHash: row.result_content_hash,
    resultVectorCount: row.result_vector_count,
    observationId: row.observation_id,
    claimId: row.claim_id,
    warnings: parseWarnings(row.warnings_json),
    lastError: row.last_error,
    retryCount: Number(row.retry_count ?? 0),
    nextRetryAt: row.next_retry_at,
    failureClass: row.failure_class,
    terminal: Number(row.terminal ?? 0) === 1,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findMutation(
  db: D1Database,
  sourceChannel: string,
  operation: MemoryMutationOperation,
  idempotencyKey: string
): Promise<MemoryMutationRecord> {
  const row = await db.prepare(
    `SELECT * FROM sb_memory_mutations
     WHERE source_channel = ? AND operation = ? AND idempotency_key = ?`
  ).bind(sourceChannel, operation, idempotencyKey).first<MemoryMutationRow>();
  if (!row) throw new Error("memory_mutation_not_found");
  return toRecord(row);
}

export async function loadMemoryMutation(
  db: D1Database,
  mutationId: string
): Promise<MemoryMutationRecord | null> {
  const row = await db.prepare(
    `SELECT * FROM sb_memory_mutations WHERE mutation_id = ?`
  ).bind(mutationId).first<MemoryMutationRow>();
  return row ? toRecord(row) : null;
}

function mutationLimit(value: number): number {
  return Math.min(Math.max(Math.trunc(value) || 1, 1), 200);
}

export async function getMemoryMutationHealth(
  db: D1Database,
  now = Date.now(),
  staleAfterMs = 15 * 60_000
): Promise<MemoryMutationHealth> {
  const { results } = await db.prepare(
    `SELECT state, COUNT(*) AS count
     FROM sb_memory_mutations
     GROUP BY state`
  ).all<{ state: MemoryMutationState; count: number }>();
  const counts = new Map((results ?? []).map((row) => [row.state, Number(row.count ?? 0)]));
  const stale = await db.prepare(
    `SELECT COUNT(*) AS count
     FROM sb_memory_mutations
     WHERE state IN ('preparing', 'entry_committed', 'knowledge_committed', 'projection_pending')
       AND updated_at <= ?`
  ).bind(now - Math.max(0, staleAfterMs)).first<{ count: number }>();
  const preparing = counts.get("preparing") ?? 0;
  const entryCommitted = counts.get("entry_committed") ?? 0;
  const knowledgeCommitted = counts.get("knowledge_committed") ?? 0;
  const projectionPending = counts.get("projection_pending") ?? 0;
  const failed = counts.get("failed") ?? 0;
  const retryableFailed = await db.prepare(
    `SELECT COUNT(*) AS count FROM sb_memory_mutations
     WHERE state = 'failed' AND COALESCE(terminal, 0) = 0`
  ).first<{ count: number }>();
  const terminalFailed = await db.prepare(
    `SELECT COUNT(*) AS count FROM sb_memory_mutations
     WHERE state = 'failed' AND COALESCE(terminal, 0) = 1`
  ).first<{ count: number }>();
  return {
    preparing,
    entry_committed: entryCommitted,
    knowledge_committed: knowledgeCommitted,
    projection_pending: projectionPending,
    failed,
    completed: counts.get("completed") ?? 0,
    incomplete: preparing + entryCommitted + knowledgeCommitted + projectionPending,
    stale_incomplete: Number(stale?.count ?? 0),
    retryable_failed: Number(retryableFailed?.count ?? 0),
    terminal_failed: Number(terminalFailed?.count ?? 0),
  };
}

export async function listRecoverableMemoryMutations(
  db: D1Database,
  input: { now?: number; limit?: number } = {}
): Promise<MemoryMutationRecord[]> {
  const now = input.now ?? Date.now();
  const { results } = await db.prepare(
    `SELECT * FROM sb_memory_mutations
     WHERE (
       state IN ('preparing', 'entry_committed', 'knowledge_committed', 'projection_pending')
       OR (state = 'failed' AND COALESCE(terminal, 0) = 0 AND COALESCE(next_retry_at, 0) <= ?)
     )
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
     ORDER BY updated_at ASC, mutation_id ASC
     LIMIT ?`
  ).bind(now, now, mutationLimit(input.limit ?? 25)).all<MemoryMutationRow>();
  return (results ?? []).map(toRecord);
}

export async function claimMemoryMutationLease(
  db: D1Database,
  input: { mutationId: string; now?: number; leaseMs?: number }
): Promise<{ mutation: MemoryMutationRecord; leaseOwner: string } | null> {
  const now = input.now ?? Date.now();
  const leaseOwner = crypto.randomUUID();
  const leaseExpiresAt = now + Math.max(1_000, input.leaseMs ?? MUTATION_LEASE_MS);
  const result = await db.prepare(
    `UPDATE sb_memory_mutations
     SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
     WHERE mutation_id = ?
       AND (
         state IN ('preparing', 'entry_committed', 'knowledge_committed', 'projection_pending')
         OR (state = 'failed' AND COALESCE(terminal, 0) = 0 AND COALESCE(next_retry_at, 0) <= ?)
       )
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`
  ).bind(leaseOwner, leaseExpiresAt, now, input.mutationId, now, now).run();
  if (changes(result) !== 1) return null;
  const mutation = await loadMemoryMutation(db, input.mutationId);
  return mutation ? { mutation, leaseOwner } : null;
}

export async function memoryMutationKnowledgeProjectionExists(
  db: D1Database,
  mutation: Pick<MemoryMutationRecord, "entryId" | "observationId" | "claimId" | "resultContentHash">
): Promise<boolean> {
  if (!mutation.observationId || !mutation.claimId || !mutation.resultContentHash) return false;
  const row = await db.prepare(
    `SELECT 1 AS ok
     FROM sb_memories projected_claim
     JOIN sb_memory_sources projected_source
       ON projected_source.memory_id = projected_claim.id
      AND projected_source.observation_id = ?
     JOIN sb_parent_version_claims projected_link
       ON projected_link.memory_id = projected_claim.id
      AND projected_link.relation = 'supports'
     JOIN sb_parent_versions projected_version
       ON projected_version.version_id = projected_link.parent_version_id
      AND projected_version.state IN ('active', 'active_degraded')
     JOIN sb_parent_units projected_parent
       ON projected_parent.parent_id = projected_version.parent_id
      AND projected_parent.active_version_id = projected_version.version_id
     WHERE projected_claim.id = ?
       AND projected_claim.entry_id = ?
       AND projected_claim.content_hash = ?
     LIMIT 1`
  ).bind(
    mutation.observationId,
    mutation.claimId,
    mutation.entryId,
    mutation.resultContentHash
  ).first<{ ok: number }>();
  return Number(row?.ok ?? 0) === 1;
}

export async function beginMemoryMutation(
  db: D1Database,
  input: {
    idempotencyKey: string;
    sourceChannel: string;
    operation: MemoryMutationOperation;
    entryId: string;
    requestHash: string;
    now?: number;
  }
): Promise<BeginMemoryMutationResult> {
  const now = input.now ?? Date.now();
  const mutationId = crypto.randomUUID();
  const leaseOwner = crypto.randomUUID();
  const leaseExpiresAt = now + MUTATION_LEASE_MS;
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO sb_memory_mutations (
       mutation_id, idempotency_key, source_channel, operation, entry_id,
       request_hash, state, lease_owner, lease_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?)`
  ).bind(
    mutationId,
    input.idempotencyKey,
    input.sourceChannel,
    input.operation,
    input.entryId,
    input.requestHash,
    leaseOwner,
    leaseExpiresAt,
    now,
    now
  ).run();

  if (changes(inserted) === 1) {
    const mutation = await findMutation(db, input.sourceChannel, input.operation, input.idempotencyKey);
    return { status: "started", mutation, leaseOwner };
  }

  const existing = await findMutation(db, input.sourceChannel, input.operation, input.idempotencyKey);
  if (existing.entryId !== input.entryId || existing.requestHash !== input.requestHash) {
    return { status: "conflict", mutation: existing };
  }
  if (existing.state === "failed" && existing.terminal) {
    return { status: "conflict", mutation: existing };
  }
  if (existing.state === "completed") {
    const projection = existing.resultContent != null && existing.resultContentHash != null
      ? await db.prepare(
          `SELECT content, content_hash FROM entries WHERE id = ?`
        ).bind(existing.entryId).first<{ content: string; content_hash: string | null }>()
      : null;
    if (
      projection?.content !== existing.resultContent ||
      projection.content_hash !== existing.resultContentHash
    ) {
      return { status: "conflict", mutation: existing };
    }
    return { status: "replay", mutation: existing };
  }

  const acquired = await db.prepare(
    `UPDATE sb_memory_mutations
     SET state = CASE
           WHEN state IN ('failed', 'entry_committed')
             AND observation_id IS NOT NULL
             AND claim_id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM sb_memories projected_claim
               JOIN sb_memory_sources projected_source
                 ON projected_source.memory_id = projected_claim.id
                AND projected_source.observation_id = sb_memory_mutations.observation_id
               JOIN sb_parent_version_claims projected_link
                 ON projected_link.memory_id = projected_claim.id
                AND projected_link.relation = 'supports'
               JOIN sb_parent_versions projected_version
                 ON projected_version.version_id = projected_link.parent_version_id
                AND projected_version.state IN ('active', 'active_degraded')
               JOIN sb_parent_units projected_parent
                 ON projected_parent.parent_id = projected_version.parent_id
                AND projected_parent.active_version_id = projected_version.version_id
               WHERE projected_claim.id = sb_memory_mutations.claim_id
                 AND projected_claim.entry_id = sb_memory_mutations.entry_id
                 AND projected_claim.content_hash = sb_memory_mutations.result_content_hash
             ) THEN 'knowledge_committed'
           WHEN state IN ('failed', 'preparing')
             AND result_content IS NOT NULL
             AND result_content_hash IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM entries projected_entry
               WHERE projected_entry.id = sb_memory_mutations.entry_id
                 AND projected_entry.content = sb_memory_mutations.result_content
                 AND projected_entry.content_hash = sb_memory_mutations.result_content_hash
             ) THEN 'entry_committed'
           WHEN state = 'failed' THEN 'preparing'
           WHEN state = 'projection_pending' THEN 'knowledge_committed'
           ELSE state
         END,
         lease_owner = ?, lease_expires_at = ?, last_error = NULL, updated_at = ?
     WHERE mutation_id = ?
       AND state != 'completed'
       AND (state != 'failed' OR COALESCE(terminal, 0) = 0)
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`
  ).bind(leaseOwner, leaseExpiresAt, now, existing.mutationId, now).run();
  if (changes(acquired) !== 1) return { status: "in_progress", mutation: existing };

  const mutation = await loadMemoryMutation(db, existing.mutationId);
  if (!mutation) throw new Error("memory_mutation_not_found_after_lease");
  return { status: "resumed", mutation, leaseOwner };
}

export async function stageMemoryMutationEntryIntent(
  db: D1Database,
  input: {
    mutationId: string;
    leaseOwner: string;
    resultContent: string;
    resultContentHash: string;
    resultVectorCount: number;
    now?: number;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await db.prepare(
    `UPDATE sb_memory_mutations
     SET result_content = ?, result_content_hash = ?, result_vector_count = ?, updated_at = ?
     WHERE mutation_id = ? AND lease_owner = ? AND state = 'preparing'
       AND lease_expires_at > ?`
  ).bind(
    input.resultContent,
    input.resultContentHash,
    input.resultVectorCount,
    now,
    input.mutationId,
    input.leaseOwner,
    now
  ).run();
  return changes(result) === 1;
}

export async function stageMemoryMutationKnowledgeIntent(
  db: D1Database,
  input: {
    mutationId: string;
    leaseOwner: string;
    observationId: string;
    claimId: string;
    now?: number;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await db.prepare(
    `UPDATE sb_memory_mutations
     SET observation_id = ?, claim_id = ?, updated_at = ?
     WHERE mutation_id = ? AND lease_owner = ? AND state = 'entry_committed'
       AND lease_expires_at > ?`
  ).bind(
    input.observationId,
    input.claimId,
    now,
    input.mutationId,
    input.leaseOwner,
    now
  ).run();
  return changes(result) === 1;
}

export async function markMemoryMutationEntryCommitted(
  db: D1Database,
  input: {
    mutationId: string;
    leaseOwner: string;
    resultContent: string;
    resultContentHash: string;
    resultVectorCount: number;
    requireEntryProjection?: boolean;
    now?: number;
  }
): Promise<boolean> {
  const result = await prepareMemoryMutationEntryCommit(db, input).run();
  return changes(result) === 1;
}

export async function markMemoryMutationKnowledgeCommitted(
  db: D1Database,
  input: {
    mutationId: string;
    leaseOwner: string;
    observationId: string;
    claimId: string;
    now?: number;
  }
): Promise<boolean> {
  return changes(await prepareMemoryMutationKnowledgeCommit(db, {
    ...input,
    requireKnowledgeProjection: true,
  }).run()) === 1;
}

export async function reopenMemoryMutationProjection(
  db: D1Database,
  input: { mutationId: string; leaseOwner: string; now?: number }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await db.prepare(
    `UPDATE sb_memory_mutations
     SET state = 'knowledge_committed', last_error = NULL, updated_at = ?
     WHERE mutation_id = ? AND lease_owner = ? AND state = 'projection_pending'
       AND lease_expires_at > ?`
  ).bind(now, input.mutationId, input.leaseOwner, now).run();
  return changes(result) === 1;
}

export async function reopenFailedMemoryMutation(
  db: D1Database,
  input: {
    mutationId: string;
    leaseOwner: string;
    state: Exclude<MemoryMutationState, "failed" | "completed">;
    now?: number;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await db.prepare(
    `UPDATE sb_memory_mutations
     SET state = ?, failure_class = NULL, terminal = 0,
         next_retry_at = NULL, last_error = NULL, updated_at = ?
     WHERE mutation_id = ? AND lease_owner = ? AND state = 'failed'
       AND COALESCE(terminal, 0) = 0`
  ).bind(input.state, now, input.mutationId, input.leaseOwner).run();
  return changes(result) === 1;
}

export function prepareMemoryMutationEntryCommit(
  db: D1Database,
  input: {
    mutationId: string;
    leaseOwner: string;
    resultContent: string;
    resultContentHash: string;
    resultVectorCount: number;
    requireEntryProjection?: boolean;
    now?: number;
  }
): D1PreparedStatement {
  const now = input.now ?? Date.now();
  const projectionGuard = input.requireEntryProjection
    ? `AND EXISTS (
         SELECT 1 FROM entries entry_projection
         WHERE entry_projection.id = sb_memory_mutations.entry_id
           AND entry_projection.content = ?
           AND entry_projection.content_hash = ?
       )`
    : "";
  const bindings: unknown[] = [
    input.resultContent,
    input.resultContentHash,
    input.resultVectorCount,
    now,
    input.mutationId,
    input.leaseOwner,
    now,
  ];
  if (input.requireEntryProjection) {
    bindings.push(input.resultContent, input.resultContentHash);
  }
  return db.prepare(
    `UPDATE sb_memory_mutations
     SET state = 'entry_committed', result_content = ?, result_content_hash = ?,
         result_vector_count = ?, last_error = NULL, updated_at = ?
     WHERE mutation_id = ? AND lease_owner = ? AND state = 'preparing'
       AND lease_expires_at > ?
       ${projectionGuard}`
  ).bind(...bindings);
}

export function prepareMemoryMutationKnowledgeCommit(
  db: D1Database,
  input: {
    mutationId: string;
    leaseOwner: string;
    observationId: string;
    claimId: string;
    requireKnowledgeProjection?: boolean;
    now?: number;
  }
): D1PreparedStatement {
  const now = input.now ?? Date.now();
  const projectionGuard = input.requireKnowledgeProjection
    ? `AND EXISTS (SELECT 1 FROM sb_observations WHERE id = ?)
       AND EXISTS (SELECT 1 FROM sb_memories WHERE id = ?)`
    : "";
  const bindings: unknown[] = [
    input.observationId,
    input.claimId,
    now,
    input.mutationId,
    input.leaseOwner,
    now,
  ];
  if (input.requireKnowledgeProjection) {
    bindings.push(input.observationId, input.claimId);
  }
  return db.prepare(
    `UPDATE sb_memory_mutations
     SET state = 'knowledge_committed', observation_id = ?, claim_id = ?,
         last_error = NULL, updated_at = ?
     WHERE mutation_id = ? AND lease_owner = ? AND state = 'entry_committed'
       AND lease_expires_at > ?
       ${projectionGuard}`
  ).bind(...bindings);
}

export async function markMemoryMutationProjectionResult(
  db: D1Database,
  input: {
    mutationId: string;
    leaseOwner: string;
    warnings: string[];
    now?: number;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const state: MemoryMutationState = input.warnings.length > 0 ? "projection_pending" : "completed";
  const result = await db.prepare(
    `UPDATE sb_memory_mutations
     SET state = ?, warnings_json = ?, lease_owner = NULL, lease_expires_at = NULL,
         last_error = NULL, updated_at = ?
     WHERE mutation_id = ? AND lease_owner = ? AND state = 'knowledge_committed'
       AND lease_expires_at > ?`
  ).bind(
    state,
    JSON.stringify([...input.warnings]),
    now,
    input.mutationId,
    input.leaseOwner,
    now
  ).run();
  return changes(result) === 1;
}

export async function markMemoryMutationFailed(
  db: D1Database,
  input: {
    mutationId: string;
    leaseOwner: string;
    error: string;
    failureClass?: MemoryMutationFailureClass;
    now?: number;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const error = input.error.trim().slice(0, 500);
  const failureClass = input.failureClass ?? classifyMemoryMutationFailure(error);
  const terminal = failureClass === "terminal";
  const retryCount = await db.prepare(
    `SELECT retry_count FROM sb_memory_mutations WHERE mutation_id = ?`
  ).bind(input.mutationId).first<{ retry_count: number }>();
  const nextRetryCount = Number(retryCount?.retry_count ?? 0) + 1;
  const nextRetryAt = terminal ? null : now + mutationRetryDelayMs(nextRetryCount);
  const result = await db.prepare(
    `UPDATE sb_memory_mutations
     SET state = 'failed', last_error = ?, retry_count = ?,
         next_retry_at = ?, failure_class = ?, terminal = ?,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE mutation_id = ? AND lease_owner = ?`
  ).bind(
    error,
    nextRetryCount,
    nextRetryAt,
    failureClass,
    terminal ? 1 : 0,
    now,
    input.mutationId,
    input.leaseOwner
  ).run();
  return changes(result) === 1;
}

function mutationRetryDelayMs(attempt: number): number {
  return Math.min(60 * 60 * 1000, 5_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 8)));
}

export function classifyMemoryMutationFailure(error: string): MemoryMutationFailureClass {
  return /entry_projection_is_stale|missing_(entry|recovery|entry_intent)|projection_missing|hash_mismatch|content changed|tags changed/i.test(error)
    ? "terminal"
    : "retryable";
}
