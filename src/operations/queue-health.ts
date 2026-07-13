import { ATOMIC_EXTRACTION_VERSION } from "../memory/atomic";

export const EXTRACTION_MAX_ATTEMPTS = 3;
export const EXTRACTION_LEASE_MS = 5 * 60_000;
export const CLASSIFICATION_MAX_ATTEMPTS = 3;
export const CLASSIFICATION_LEASE_MS = 10 * 60_000;
export const CURRENT_CLASSIFICATION_VERSION = 2;

export interface QueueSnapshot {
  due: number;
  deferred: number;
  exhausted: number;
}

function count(value: { count: number } | null): number {
  return Math.max(0, Number(value?.count ?? 0));
}

export function classificationDueWhereSql(now: number, leaseCutoff: number): string {
  return (
    `tags NOT LIKE '%"status:deprecated"%' ` +
    `AND (` +
      `(` +
        `COALESCE(classification_attempts, 0) < ${CLASSIFICATION_MAX_ATTEMPTS} ` +
        `AND (` +
          `classification_status IS NULL OR classification_status = 'pending' ` +
          `OR (classification_status = 'retryable_error' AND COALESCE(classification_next_attempt_at, 0) <= ${now}) ` +
          `OR (classification_status = 'processing' AND COALESCE(classification_started_at, 0) <= ${leaseCutoff})` +
        `)` +
      `)` +
      ` OR (` +
        `classification_status = 'succeeded' ` +
        `AND COALESCE(classification_version, 0) < ${CURRENT_CLASSIFICATION_VERSION}` +
      `)` +
    `)`
  );
}

export async function readClassificationQueueSnapshot(
  db: D1Database,
  now = Date.now()
): Promise<QueueSnapshot> {
  const dueWhere = classificationDueWhereSql(now, now - CLASSIFICATION_LEASE_MS);
  const [due, deferred, exhausted] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as count FROM entries WHERE ${dueWhere}`).first<{ count: number }>(),
    db.prepare(
      `SELECT COUNT(*) as count FROM entries
       WHERE classification_status = 'retryable_error'
         AND COALESCE(classification_attempts, 0) < ?
         AND classification_next_attempt_at > ?`
    ).bind(CLASSIFICATION_MAX_ATTEMPTS, now).first<{ count: number }>(),
    db.prepare(
      `SELECT COUNT(*) as count FROM entries
       WHERE classification_status = 'terminal_error'`
    ).first<{ count: number }>(),
  ]);
  return { due: count(due), deferred: count(deferred), exhausted: count(exhausted) };
}

export async function readExtractionQueueSnapshot(
  db: D1Database,
  now = Date.now()
): Promise<QueueSnapshot> {
  const leaseCutoff = now - EXTRACTION_LEASE_MS;
  const [due, deferred, exhausted] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) as count FROM sb_observations
       WHERE COALESCE(extraction_attempts, 0) < ?
         AND (
           extraction_status = 'pending'
           OR (extraction_status = 'retryable_error' AND COALESCE(next_attempt_at, 0) <= ?)
           OR (extraction_status = 'processing' AND COALESCE(processing_started_at, 0) <= ?)
           OR (extraction_status = 'fallback' AND COALESCE(needs_reprocess, 0) = 1)
           OR (extraction_status = 'partial_error' AND COALESCE(needs_reprocess, 0) = 1)
           OR COALESCE(extraction_version, 0) < ?
         )`
    ).bind(
      EXTRACTION_MAX_ATTEMPTS,
      now,
      leaseCutoff,
      ATOMIC_EXTRACTION_VERSION
    ).first<{ count: number }>(),
    db.prepare(
      `SELECT COUNT(*) as count FROM sb_observations
       WHERE extraction_status = 'retryable_error'
         AND COALESCE(extraction_attempts, 0) < ?
         AND COALESCE(next_attempt_at, 0) > ?`
    ).bind(EXTRACTION_MAX_ATTEMPTS, now).first<{ count: number }>(),
    db.prepare(
      `SELECT COUNT(*) as count FROM sb_observations
       WHERE extraction_status = 'terminal_error'`
    ).first<{ count: number }>(),
  ]);
  return { due: count(due), deferred: count(deferred), exhausted: count(exhausted) };
}

export function queueAttentionCount(snapshot: QueueSnapshot): number {
  return snapshot.due + snapshot.deferred + snapshot.exhausted;
}
