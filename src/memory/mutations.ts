export type MemoryMutationOperation = "append" | "update";

export type MemoryMutationState =
  | "preparing"
  | "entry_committed"
  | "knowledge_committed"
  | "projection_pending"
  | "completed"
  | "failed";

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
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
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
    lease_owner TEXT,
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_channel, operation, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sb_memory_mutations_state
    ON sb_memory_mutations(state, lease_expires_at, updated_at)`,
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
    now?: number;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const error = input.error.trim().slice(0, 500);
  const result = await db.prepare(
    `UPDATE sb_memory_mutations
     SET state = 'failed', last_error = ?, lease_owner = NULL,
         lease_expires_at = NULL, updated_at = ?
     WHERE mutation_id = ? AND lease_owner = ?`
  ).bind(error, now, input.mutationId, input.leaseOwner).run();
  return changes(result) === 1;
}
