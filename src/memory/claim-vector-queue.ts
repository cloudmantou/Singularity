export const CLAIM_VECTOR_QUEUE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_claim_vector_jobs (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL,
    target_fingerprint TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    parent_version_id TEXT,
    rebuild_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(claim_id, target_fingerprint),
    CHECK (status IN ('pending', 'processing', 'retryable_error', 'succeeded', 'failed'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_claim_vector_jobs_due
    ON sb_claim_vector_jobs(target_fingerprint, status, next_attempt_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_claim_vector_jobs_rebuild
    ON sb_claim_vector_jobs(rebuild_id, status, updated_at DESC)`,
] as const;

export interface ClaimVectorJobWorkItem {
  jobId: string;
  leaseOwner: string;
  claimId: string;
  entryId: string;
  parentVersionId: string | null;
  content: string;
  contentHash: string;
  createdAt: number;
  targetFingerprint: string;
  rebuildId: string | null;
}

interface ClaimVectorJobRow {
  id: string;
  claim_id: string;
  target_fingerprint: string;
  content_hash: string;
  parent_version_id: string | null;
  rebuild_id: string | null;
  attempts: number;
}

interface IndexableClaimRow {
  id: string;
  entry_id: string;
  parent_version_id: string | null;
  content: string;
  content_hash: string;
  created_at: number;
}

export interface ClaimVectorQueueStatus {
  fingerprint: string;
  pending: number;
  processing: number;
  retryable_error: number;
  succeeded: number;
  failed: number;
  missing: number;
  missing_retryable: number;
  terminal_failed: number;
}

const MAX_ATTEMPTS = 6;
export const DEFAULT_CLAIM_VECTOR_LEASE_MS = 5 * 60_000;

export function claimVectorActivationBlock(
  status: Pick<ClaimVectorQueueStatus, "terminal_failed">
): "claim_vector_terminal_failures" | undefined {
  return status.terminal_failed > 0 ? "claim_vector_terminal_failures" : undefined;
}

function boundedLimit(value: number, maximum = 200): number {
  return Math.min(Math.max(Math.trunc(value) || 1, 1), maximum);
}

function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 2_000 * (2 ** Math.min(Math.max(attempts, 0), 10)));
}

export function indexableClaimPredicate(memoryRef: string): string {
  return `${memoryRef}.entry_id IS NOT NULL
    AND ${memoryRef}.content_hash IS NOT NULL
    AND ${memoryRef}.claim_status <> 'unsupported'
    AND EXISTS (
      SELECT 1
      FROM sb_memory_sources ms_vector
      JOIN sb_observations o_vector ON o_vector.id = ms_vector.observation_id
      WHERE ms_vector.memory_id = ${memoryRef}.id
        AND (
          ms_vector.relation IN ('supports', 'derived_from')
          OR ms_vector.role IN ('supports', 'derived_from')
        )
        AND o_vector.content_hash IS NOT NULL
    )
    AND EXISTS (
      SELECT 1
      FROM sb_parent_version_claims pvc_vector
      JOIN sb_parent_versions pv_vector
        ON pv_vector.version_id = pvc_vector.parent_version_id
      WHERE pvc_vector.memory_id = ${memoryRef}.id
        AND pvc_vector.relation = 'supports'
        AND pv_vector.state IN ('active', 'active_degraded', 'superseded')
    )`;
}

async function listMissingClaims(
  db: D1Database,
  targetFingerprint: string,
  limit: number
): Promise<IndexableClaimRow[]> {
  const { results } = await db.prepare(
    `SELECT m.id, m.entry_id, m.parent_version_id, m.content, m.content_hash, m.created_at
     FROM sb_memories m
     WHERE ${indexableClaimPredicate("m")}
       AND NOT EXISTS (
         SELECT 1
         FROM sb_claim_vectors cv
         WHERE cv.claim_id = m.id
           AND cv.embedding_fingerprint = ?
           AND cv.content_hash = m.content_hash
       )
       AND NOT EXISTS (
         SELECT 1
         FROM sb_claim_vector_jobs failed_job
         WHERE failed_job.claim_id = m.id
           AND failed_job.target_fingerprint = ?
           AND failed_job.content_hash = m.content_hash
           AND failed_job.status = 'failed'
       )
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT ?`
  ).bind(targetFingerprint, targetFingerprint, boundedLimit(limit)).all<IndexableClaimRow>();
  return results ?? [];
}

export async function enqueueMissingClaimVectorJobs(
  db: D1Database,
  input: {
    targetFingerprint: string;
    rebuildId?: string | null;
    now?: number;
    limit?: number;
  }
): Promise<number> {
  const now = input.now ?? Date.now();
  const claims = await listMissingClaims(db, input.targetFingerprint, input.limit ?? 100);
  if (!claims.length) return 0;
  const results = await db.batch(claims.map((claim) => db.prepare(
    `INSERT INTO sb_claim_vector_jobs (
       id, claim_id, target_fingerprint, content_hash, parent_version_id,
       rebuild_id, status, attempts, next_attempt_at, lease_owner,
       lease_expires_at, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(claim_id, target_fingerprint) DO UPDATE SET
       content_hash = excluded.content_hash,
       parent_version_id = excluded.parent_version_id,
       rebuild_id = COALESCE(excluded.rebuild_id, sb_claim_vector_jobs.rebuild_id),
       status = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded'
         THEN 'pending'
         ELSE sb_claim_vector_jobs.status
       END,
       attempts = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded' THEN 0
         ELSE sb_claim_vector_jobs.attempts
       END,
       next_attempt_at = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded'
         THEN excluded.next_attempt_at
         ELSE sb_claim_vector_jobs.next_attempt_at
       END,
       lease_owner = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded' THEN NULL
         ELSE sb_claim_vector_jobs.lease_owner
       END,
       lease_expires_at = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded' THEN NULL
         ELSE sb_claim_vector_jobs.lease_expires_at
       END,
       last_error = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded' THEN NULL
         ELSE sb_claim_vector_jobs.last_error
       END,
       updated_at = excluded.updated_at
     WHERE sb_claim_vector_jobs.status != 'failed'
       OR sb_claim_vector_jobs.content_hash != excluded.content_hash`
  ).bind(
    crypto.randomUUID(),
    claim.id,
    input.targetFingerprint,
    claim.content_hash,
    claim.parent_version_id,
    input.rebuildId ?? null,
    now,
    now,
    now
  )));
  return results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
}

export async function enqueueClaimVectorJob(
  db: D1Database,
  input: {
    claimId: string;
    targetFingerprint: string;
    rebuildId?: string | null;
    now?: number;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const claim = await db.prepare(
    `SELECT m.id, m.entry_id, m.parent_version_id, m.content, m.content_hash, m.created_at
     FROM sb_memories m
     WHERE m.id = ?
       AND ${indexableClaimPredicate("m")}
       AND NOT EXISTS (
         SELECT 1 FROM sb_claim_vectors cv
         WHERE cv.claim_id = m.id
           AND cv.embedding_fingerprint = ?
           AND cv.content_hash = m.content_hash
       )
     LIMIT 1`
  ).bind(input.claimId, input.targetFingerprint).first<IndexableClaimRow>();
  if (!claim) return false;
  const result = await db.prepare(
    `INSERT INTO sb_claim_vector_jobs (
       id, claim_id, target_fingerprint, content_hash, parent_version_id,
       rebuild_id, status, attempts, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT(claim_id, target_fingerprint) DO UPDATE SET
       content_hash = excluded.content_hash,
       parent_version_id = excluded.parent_version_id,
       rebuild_id = COALESCE(excluded.rebuild_id, sb_claim_vector_jobs.rebuild_id),
       status = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded'
         THEN 'pending'
         ELSE sb_claim_vector_jobs.status
       END,
       attempts = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded' THEN 0
         ELSE sb_claim_vector_jobs.attempts
       END,
       next_attempt_at = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded'
         THEN excluded.next_attempt_at
         ELSE sb_claim_vector_jobs.next_attempt_at
       END,
       lease_owner = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded' THEN NULL
         ELSE sb_claim_vector_jobs.lease_owner
       END,
       lease_expires_at = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded' THEN NULL
         ELSE sb_claim_vector_jobs.lease_expires_at
       END,
       last_error = CASE
         WHEN sb_claim_vector_jobs.content_hash != excluded.content_hash
           OR sb_claim_vector_jobs.status = 'succeeded' THEN NULL
         ELSE sb_claim_vector_jobs.last_error
       END,
       updated_at = excluded.updated_at
     WHERE sb_claim_vector_jobs.status != 'failed'
       OR sb_claim_vector_jobs.content_hash != excluded.content_hash`
  ).bind(
    crypto.randomUUID(),
    claim.id,
    input.targetFingerprint,
    claim.content_hash,
    claim.parent_version_id,
    input.rebuildId ?? null,
    now,
    now,
    now
  ).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function getClaimVectorQueueStatus(
  db: D1Database,
  targetFingerprint: string,
  now = Date.now()
): Promise<ClaimVectorQueueStatus> {
  const { results } = await db.prepare(
    `SELECT status, COUNT(*) AS count
     FROM sb_claim_vector_jobs
     WHERE target_fingerprint = ?
     GROUP BY status`
  ).bind(targetFingerprint).all<{ status: string; count: number }>();
  const counts = new Map((results ?? []).map((row) => [row.status, Number(row.count ?? 0)]));
  const missing = await db.prepare(
    `SELECT COUNT(*) AS count
     FROM sb_memories m
     WHERE ${indexableClaimPredicate("m")}
       AND NOT EXISTS (
         SELECT 1 FROM sb_claim_vectors cv
         WHERE cv.claim_id = m.id
           AND cv.embedding_fingerprint = ?
           AND cv.content_hash = m.content_hash
       )`
  ).bind(targetFingerprint).first<{ count: number }>();
  const terminalFailed = await db.prepare(
    `SELECT COUNT(*) AS count
     FROM sb_memories m
     JOIN sb_claim_vector_jobs failed_job
       ON failed_job.claim_id = m.id
      AND failed_job.target_fingerprint = ?
      AND failed_job.content_hash = m.content_hash
      AND failed_job.status = 'failed'
     WHERE ${indexableClaimPredicate("m")}
       AND NOT EXISTS (
         SELECT 1 FROM sb_claim_vectors cv
         WHERE cv.claim_id = m.id
           AND cv.embedding_fingerprint = ?
           AND cv.content_hash = m.content_hash
       )`
  ).bind(targetFingerprint, targetFingerprint).first<{ count: number }>();
  void now;
  const missingCount = Number(missing?.count ?? 0);
  const terminalFailedCount = Number(terminalFailed?.count ?? 0);
  return {
    fingerprint: targetFingerprint,
    pending: counts.get("pending") ?? 0,
    processing: counts.get("processing") ?? 0,
    retryable_error: counts.get("retryable_error") ?? 0,
    succeeded: counts.get("succeeded") ?? 0,
    failed: counts.get("failed") ?? 0,
    missing: missingCount,
    missing_retryable: Math.max(0, missingCount - terminalFailedCount),
    terminal_failed: terminalFailedCount,
  };
}

export async function retryFailedClaimVectorJobs(
  db: D1Database,
  input: {
    targetFingerprint: string;
    claimId?: string | null;
    now?: number;
    limit?: number;
  }
): Promise<number> {
  const now = input.now ?? Date.now();
  const claimClause = input.claimId ? "AND claim_id = ?" : "";
  const bindings: Array<string | number> = [input.targetFingerprint];
  if (input.claimId) bindings.push(input.claimId);
  bindings.push(boundedLimit(input.limit ?? 25));
  const result = await db.prepare(
    `UPDATE sb_claim_vector_jobs
     SET status = 'pending', attempts = 0, next_attempt_at = ?,
         lease_owner = NULL, lease_expires_at = NULL, last_error = NULL,
         updated_at = ?
     WHERE id IN (
       SELECT id FROM sb_claim_vector_jobs
       WHERE target_fingerprint = ?
         AND status = 'failed'
         ${claimClause}
       ORDER BY updated_at ASC, id ASC
       LIMIT ?
     )`
  ).bind(now, now, ...bindings).run();
  return Number(result.meta?.changes ?? 0);
}

export async function listClaimVectorIdsForFingerprint(
  db: D1Database,
  fingerprint: string
): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT vector_ids_json
     FROM sb_claim_vectors
     WHERE embedding_fingerprint = ?`
  ).bind(fingerprint).all<{ vector_ids_json: string }>();
  const ids = (results ?? []).flatMap((row) => {
    try {
      const parsed = JSON.parse(row.vector_ids_json);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  });
  return [...new Set(ids)];
}

export async function processClaimVectorJobs(
  db: D1Database,
  input: {
    targetFingerprint?: string;
    rebuildId?: string | null;
    limit?: number;
    now?: number;
    leaseMs?: number;
    index: (job: ClaimVectorJobWorkItem) => Promise<void>;
  }
): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }> {
  const now = input.now ?? Date.now();
  const leaseOwner = crypto.randomUUID();
  const clauses = [
    `(status IN ('pending', 'retryable_error')
      AND COALESCE(next_attempt_at, 0) <= ?
     ) OR (
      status = 'processing'
      AND COALESCE(lease_expires_at, 0) <= ?
     )`,
  ];
  const bindings: Array<string | number> = [now, now];
  if (input.targetFingerprint) {
    clauses.push("target_fingerprint = ?");
    bindings.push(input.targetFingerprint);
  }
  if (input.rebuildId) {
    clauses.push("rebuild_id = ?");
    bindings.push(input.rebuildId);
  }
  bindings.push(boundedLimit(input.limit ?? 20, 100));
  const { results } = await db.prepare(
    `SELECT id, claim_id, target_fingerprint, content_hash,
            parent_version_id, rebuild_id, attempts
     FROM sb_claim_vector_jobs
     WHERE (${clauses[0]})
       ${clauses.slice(1).map((clause) => `AND ${clause}`).join("\n       ")}
     ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC
     LIMIT ?`
  ).bind(...bindings).all<ClaimVectorJobRow>();

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of results ?? []) {
    const leased = await db.prepare(
      `UPDATE sb_claim_vector_jobs
       SET status = 'processing',
           attempts = attempts + 1,
           lease_owner = ?,
           lease_expires_at = ?,
           updated_at = ?
       WHERE id = ?
         AND (
           (status IN ('pending', 'retryable_error') AND COALESCE(next_attempt_at, 0) <= ?)
           OR (status = 'processing' AND COALESCE(lease_expires_at, 0) <= ?)
         )`
    ).bind(
      leaseOwner,
      now + (input.leaseMs ?? DEFAULT_CLAIM_VECTOR_LEASE_MS),
      now,
      row.id,
      now,
      now
    ).run();
    if (Number(leased.meta?.changes ?? 0) !== 1) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    const claim = await db.prepare(
      `SELECT m.id, m.entry_id, m.parent_version_id, m.content, m.content_hash, m.created_at
       FROM sb_memories m
       WHERE m.id = ?
         AND m.content_hash = ?
         AND ${indexableClaimPredicate("m")}
       LIMIT 1`
    ).bind(row.claim_id, row.content_hash).first<IndexableClaimRow>();
    if (!claim) {
      await db.prepare(
        `UPDATE sb_claim_vector_jobs
         SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
             last_error = 'claim_snapshot_ineligible_or_changed', updated_at = ?
         WHERE id = ? AND lease_owner = ?`
      ).bind(now, row.id, leaseOwner).run();
      failed += 1;
      continue;
    }
    try {
      await input.index({
        jobId: row.id,
        leaseOwner,
        claimId: claim.id,
        entryId: claim.entry_id,
        parentVersionId: claim.parent_version_id,
        content: claim.content,
        contentHash: claim.content_hash,
        createdAt: Number(claim.created_at),
        targetFingerprint: row.target_fingerprint,
        rebuildId: row.rebuild_id,
      });
      const completed = await db.prepare(
        `UPDATE sb_claim_vector_jobs
         SET status = 'succeeded', next_attempt_at = NULL, lease_owner = NULL,
             lease_expires_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND lease_owner = ?
           AND EXISTS (
             SELECT 1 FROM sb_claim_vectors cv
             WHERE cv.claim_id = sb_claim_vector_jobs.claim_id
               AND cv.embedding_fingerprint = sb_claim_vector_jobs.target_fingerprint
               AND cv.content_hash = sb_claim_vector_jobs.content_hash
           )`
      ).bind(now, row.id, leaseOwner).run();
      if (Number(completed.meta?.changes ?? 0) !== 1) {
        throw new Error("claim_vector_mapping_missing_after_index");
      }
      succeeded += 1;
    } catch (error) {
      const attempts = Number(row.attempts ?? 0) + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await db.prepare(
        `UPDATE sb_claim_vector_jobs
         SET status = ?, next_attempt_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ?`
      ).bind(
        terminal ? "failed" : "retryable_error",
        terminal ? null : now + retryDelayMs(attempts),
        message,
        now,
        row.id,
        leaseOwner
      ).run();
      failed += 1;
    }
  }
  return { attempted, succeeded, failed, skipped };
}
