import type { AIReviewMode, AIReviewObjectType } from "./ai-review";

export const KNOWLEDGE_EVOLUTION_AUTOMATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sb_knowledge_evolution_runs (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    object_type TEXT,
    mode TEXT NOT NULL DEFAULT 'auto_low_risk',
    requested_by TEXT NOT NULL,
    total_items INTEGER NOT NULL DEFAULT 0,
    processed_items INTEGER NOT NULL DEFAULT 0,
    applied_items INTEGER NOT NULL DEFAULT 0,
    skipped_items INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL,
    CHECK (state IN ('running', 'completed')),
    CHECK (object_type IS NULL OR object_type IN (
      'conflict_case', 'entity_merge_candidate', 'memory_merge_candidate'
    ))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_evolution_single_running
   ON sb_knowledge_evolution_runs(state) WHERE state = 'running'`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evolution_runs_recent
   ON sb_knowledge_evolution_runs(updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sb_knowledge_evolution_run_items (
    run_id TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    worker_id TEXT,
    lease_expires_at INTEGER,
    error_code TEXT,
    source_created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, object_type, object_id),
    CHECK (state IN ('queued', 'processing', 'applied', 'skipped', 'failed'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evolution_run_items_queue
   ON sb_knowledge_evolution_run_items(run_id, state, source_created_at, object_id)`,
] as const;

export type KnowledgeEvolutionRunState = "idle" | "running" | "completed";
export type KnowledgeEvolutionItemOutcome = "applied" | "skipped" | "failed";

export interface KnowledgeEvolutionAutomationStatus {
  runId: string | null;
  state: KnowledgeEvolutionRunState;
  objectType: AIReviewObjectType | null;
  mode: AIReviewMode;
  requestedBy: string | null;
  total: number;
  processed: number;
  applied: number;
  skipped: number;
  failed: number;
  percent: number;
  current: {
    objectType: AIReviewObjectType;
    objectId: string;
    attempts: number;
  } | null;
  lastError: string | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number | null;
}

export interface KnowledgeEvolutionRunItem {
  objectType: AIReviewObjectType;
  objectId: string;
  attempts: number;
  reclaimed: boolean;
}

const initializedDatabases = new WeakSet<object>();
const RUN_ITEM_LIMIT_PER_TYPE = 500;
const RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ITEM_ATTEMPTS = 3;

export async function ensureKnowledgeEvolutionAutomationDataModel(
  db: D1Database
): Promise<void> {
  if (initializedDatabases.has(db as object)) return;
  for (const statement of KNOWLEDGE_EVOLUTION_AUTOMATION_SCHEMA_STATEMENTS) {
    await db.exec(statement);
  }
  initializedDatabases.add(db as object);
}

function percent(processed: number, total: number, state: KnowledgeEvolutionRunState): number {
  if (total <= 0) return state === "completed" ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
}

async function statusForRun(
  db: D1Database,
  runId: string
): Promise<KnowledgeEvolutionAutomationStatus | null> {
  const run = await db.prepare(
    `SELECT id, state, object_type, mode, requested_by, total_items, processed_items,
            applied_items, skipped_items, failed_items, last_error,
            started_at, completed_at, updated_at
     FROM sb_knowledge_evolution_runs WHERE id = ?`
  ).bind(runId).first<Record<string, unknown>>();
  if (!run) return null;
  const current = await db.prepare(
    `SELECT object_type, object_id, attempts
     FROM sb_knowledge_evolution_run_items
     WHERE run_id = ? AND state = 'processing'
     ORDER BY started_at ASC, object_id ASC LIMIT 1`
  ).bind(runId).first<{
    object_type: AIReviewObjectType;
    object_id: string;
    attempts: number;
  }>();
  const state = String(run.state) as Exclude<KnowledgeEvolutionRunState, "idle">;
  const total = Number(run.total_items ?? 0);
  const processed = Number(run.processed_items ?? 0);
  return {
    runId: String(run.id),
    state,
    objectType: run.object_type == null ? null : run.object_type as AIReviewObjectType,
    mode: String(run.mode) as AIReviewMode,
    requestedBy: String(run.requested_by),
    total,
    processed,
    applied: Number(run.applied_items ?? 0),
    skipped: Number(run.skipped_items ?? 0),
    failed: Number(run.failed_items ?? 0),
    percent: percent(processed, total, state),
    current: current ? {
      objectType: current.object_type,
      objectId: current.object_id,
      attempts: Number(current.attempts),
    } : null,
    lastError: run.last_error == null ? null : String(run.last_error),
    startedAt: Number(run.started_at),
    completedAt: run.completed_at == null ? null : Number(run.completed_at),
    updatedAt: Number(run.updated_at),
  };
}

export async function getKnowledgeEvolutionAutomationStatus(
  db: D1Database
): Promise<KnowledgeEvolutionAutomationStatus> {
  await ensureKnowledgeEvolutionAutomationDataModel(db);
  const row = await db.prepare(
    `SELECT id FROM sb_knowledge_evolution_runs
     ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`
  ).first<{ id: string }>();
  const status = row ? await statusForRun(db, row.id) : null;
  return status ?? {
    runId: null,
    state: "idle",
    objectType: null,
    mode: "auto_low_risk",
    requestedBy: null,
    total: 0,
    processed: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    percent: 0,
    current: null,
    lastError: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
  };
}

export async function startKnowledgeEvolutionAutomation(
  db: D1Database,
  input: {
    requestedBy: string;
    objectType?: AIReviewObjectType | null;
    mode?: AIReviewMode;
    now?: number;
  }
): Promise<KnowledgeEvolutionAutomationStatus> {
  await ensureKnowledgeEvolutionAutomationDataModel(db);
  const existing = await db.prepare(
    `SELECT id FROM sb_knowledge_evolution_runs WHERE state = 'running' LIMIT 1`
  ).first<{ id: string }>();
  if (existing) return (await statusForRun(db, existing.id))!;

  const runId = crypto.randomUUID();
  const now = input.now ?? Date.now();
  const mode = input.mode ?? "auto_low_risk";
  const retentionCutoff = now - RUN_RETENTION_MS;
  await db.batch([
    db.prepare(
      `DELETE FROM sb_knowledge_evolution_run_items
       WHERE run_id IN (
         SELECT id FROM sb_knowledge_evolution_runs
         WHERE state = 'completed' AND updated_at < ?
       )`
    ).bind(retentionCutoff),
    db.prepare(
      `DELETE FROM sb_knowledge_evolution_runs
       WHERE state = 'completed' AND updated_at < ?`
    ).bind(retentionCutoff),
  ]);
  const selectedTypes = input.objectType
    ? [input.objectType]
    : ["conflict_case", "entity_merge_candidate", "memory_merge_candidate"] as const;
  const sources: Record<AIReviewObjectType, { table: string; createdAt: string }> = {
    conflict_case: { table: "sb_conflict_cases", createdAt: "created_at" },
    entity_merge_candidate: { table: "sb_entity_merge_candidates", createdAt: "created_at" },
    memory_merge_candidate: { table: "sb_memory_merge_candidates", createdAt: "created_at" },
  };
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO sb_knowledge_evolution_runs (
         id, state, object_type, mode, requested_by, started_at, updated_at
       ) VALUES (?, 'running', ?, ?, ?, ?, ?)`
    ).bind(runId, input.objectType ?? null, mode, input.requestedBy, now, now),
  ];
  for (const objectType of selectedTypes) {
    const source = sources[objectType];
    const available = await db.prepare(
      `SELECT 1 AS available FROM sqlite_master
       WHERE type = 'table' AND name = ? LIMIT 1`
    ).bind(source.table).first<{ available: number }>();
    if (!available) continue;
    statements.push(db.prepare(
      `INSERT INTO sb_knowledge_evolution_run_items (
         run_id, object_type, object_id, state, source_created_at, updated_at
       )
       SELECT ?, ?, id, 'queued', ${source.createdAt}, ?
       FROM ${source.table} candidate
       WHERE state = 'pending'
         AND NOT EXISTS (
           SELECT 1
           FROM sb_knowledge_evolution_run_items previous
           JOIN sb_knowledge_evolution_runs previous_run ON previous_run.id = previous.run_id
           WHERE previous.object_type = ? AND previous.object_id = candidate.id
             AND previous_run.mode = ?
             AND previous.state IN ('applied', 'skipped', 'failed')
             AND previous.updated_at > ?
         )
       ORDER BY candidate.${source.createdAt} ASC, candidate.id ASC
       LIMIT ?`
    ).bind(
      runId,
      objectType,
      now,
      objectType,
      mode,
      now - RETRY_COOLDOWN_MS,
      RUN_ITEM_LIMIT_PER_TYPE
    ));
  }
  statements.push(db.prepare(
    `UPDATE sb_knowledge_evolution_runs
     SET total_items = (
       SELECT COUNT(*) FROM sb_knowledge_evolution_run_items WHERE run_id = ?
     ),
     state = CASE WHEN EXISTS (
       SELECT 1 FROM sb_knowledge_evolution_run_items WHERE run_id = ?
     ) THEN 'running' ELSE 'completed' END,
     completed_at = CASE WHEN EXISTS (
       SELECT 1 FROM sb_knowledge_evolution_run_items WHERE run_id = ?
     ) THEN NULL ELSE ? END,
     updated_at = ?
     WHERE id = ?`
  ).bind(runId, runId, runId, now, now, runId));
  try {
    await db.batch(statements);
  } catch (error) {
    const concurrent = await db.prepare(
      `SELECT id FROM sb_knowledge_evolution_runs WHERE state = 'running' LIMIT 1`
    ).first<{ id: string }>();
    if (concurrent) return (await statusForRun(db, concurrent.id))!;
    throw error;
  }
  return (await statusForRun(db, runId))!;
}

export async function claimNextKnowledgeEvolutionItem(
  db: D1Database,
  input: { runId: string; workerId: string; now?: number; leaseMs?: number }
): Promise<KnowledgeEvolutionRunItem | null> {
  await ensureKnowledgeEvolutionAutomationDataModel(db);
  const now = input.now ?? Date.now();
  const leaseMs = Math.max(1, Math.min(input.leaseMs ?? 60_000, 10 * 60_000));
  const exhausted = await db.prepare(
    `UPDATE sb_knowledge_evolution_run_items
     SET state = 'failed', error_code = 'lease_retry_exhausted',
         completed_at = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE run_id = ? AND state = 'processing' AND COALESCE(lease_expires_at, 0) <= ?
       AND attempts >= ?`
  ).bind(now, now, input.runId, now, MAX_ITEM_ATTEMPTS).run();
  if (Number(exhausted.meta?.changes ?? 0) > 0) {
    await db.prepare(
      `UPDATE sb_knowledge_evolution_runs
       SET processed_items = (
             SELECT COUNT(*) FROM sb_knowledge_evolution_run_items
             WHERE run_id = ? AND state IN ('applied', 'skipped', 'failed')
           ),
           failed_items = (
             SELECT COUNT(*) FROM sb_knowledge_evolution_run_items
             WHERE run_id = ? AND state = 'failed'
           ),
           last_error = 'lease_retry_exhausted',
           state = CASE WHEN EXISTS (
             SELECT 1 FROM sb_knowledge_evolution_run_items
             WHERE run_id = ? AND state IN ('queued', 'processing')
           ) THEN 'running' ELSE 'completed' END,
           completed_at = CASE WHEN EXISTS (
             SELECT 1 FROM sb_knowledge_evolution_run_items
             WHERE run_id = ? AND state IN ('queued', 'processing')
           ) THEN NULL ELSE ? END,
           updated_at = ?
       WHERE id = ? AND state = 'running'`
    ).bind(
      input.runId,
      input.runId,
      input.runId,
      input.runId,
      now,
      now,
      input.runId
    ).run();
  }
  const expired = await db.prepare(
    `SELECT object_type, object_id, attempts
     FROM sb_knowledge_evolution_run_items
     WHERE run_id = ? AND state = 'processing' AND COALESCE(lease_expires_at, 0) <= ?
       AND attempts < ?
     ORDER BY started_at ASC, object_id ASC LIMIT 1`
  ).bind(input.runId, now, MAX_ITEM_ATTEMPTS).first<{
    object_type: AIReviewObjectType;
    object_id: string;
    attempts: number;
  }>();
  if (expired) {
    const reclaimed = await db.prepare(
      `UPDATE sb_knowledge_evolution_run_items
       SET worker_id = ?, lease_expires_at = ?, attempts = attempts + 1,
           started_at = ?, updated_at = ?
       WHERE run_id = ? AND object_type = ? AND object_id = ?
         AND state = 'processing' AND COALESCE(lease_expires_at, 0) <= ?`
    ).bind(
      input.workerId,
      now + leaseMs,
      now,
      now,
      input.runId,
      expired.object_type,
      expired.object_id,
      now
    ).run();
    if (Number(reclaimed.meta?.changes ?? 0) === 1) {
      return {
        objectType: expired.object_type,
        objectId: expired.object_id,
        attempts: expired.attempts + 1,
        reclaimed: true,
      };
    }
  }
  const live = await db.prepare(
    `SELECT 1 AS live FROM sb_knowledge_evolution_run_items
     WHERE run_id = ? AND state = 'processing' AND COALESCE(lease_expires_at, 0) > ?
     LIMIT 1`
  ).bind(input.runId, now).first<{ live: number }>();
  if (live) return null;
  const next = await db.prepare(
    `SELECT object_type, object_id, attempts
     FROM sb_knowledge_evolution_run_items
     WHERE run_id = ? AND state = 'queued'
     ORDER BY source_created_at ASC, object_id ASC LIMIT 1`
  ).bind(input.runId).first<{
    object_type: AIReviewObjectType;
    object_id: string;
    attempts: number;
  }>();
  if (!next) return null;
  const claimed = await db.prepare(
    `UPDATE sb_knowledge_evolution_run_items
     SET state = 'processing', attempts = attempts + 1, worker_id = ?,
         lease_expires_at = ?, started_at = ?, updated_at = ?
     WHERE run_id = ? AND object_type = ? AND object_id = ? AND state = 'queued'`
  ).bind(
    input.workerId,
    now + leaseMs,
    now,
    now,
    input.runId,
    next.object_type,
    next.object_id
  ).run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) return null;
  await db.prepare(
    `UPDATE sb_knowledge_evolution_runs SET updated_at = ?
     WHERE id = ? AND state = 'running'`
  ).bind(now, input.runId).run();
  return {
    objectType: next.object_type,
    objectId: next.object_id,
    attempts: next.attempts + 1,
    reclaimed: false,
  };
}

export async function completeKnowledgeEvolutionItem(
  db: D1Database,
  input: {
    runId: string;
    objectType: AIReviewObjectType;
    objectId: string;
    workerId: string;
    outcome: KnowledgeEvolutionItemOutcome;
    error?: string | null;
    now?: number;
  }
): Promise<KnowledgeEvolutionAutomationStatus> {
  await ensureKnowledgeEvolutionAutomationDataModel(db);
  const now = input.now ?? Date.now();
  const completed = await db.prepare(
    `UPDATE sb_knowledge_evolution_run_items
     SET state = ?, error_code = ?, completed_at = ?, updated_at = ?,
         worker_id = NULL, lease_expires_at = NULL
     WHERE run_id = ? AND object_type = ? AND object_id = ?
       AND state = 'processing' AND worker_id = ?`
  ).bind(
    input.outcome,
    input.error?.slice(0, 256) ?? null,
    now,
    now,
    input.runId,
    input.objectType,
    input.objectId,
    input.workerId
  ).run();
  if (Number(completed.meta?.changes ?? 0) !== 1) {
    throw new Error("knowledge_evolution_item_lease_lost");
  }
  await db.prepare(
    `UPDATE sb_knowledge_evolution_runs
     SET processed_items = (
           SELECT COUNT(*) FROM sb_knowledge_evolution_run_items
           WHERE run_id = ? AND state IN ('applied', 'skipped', 'failed')
         ),
         applied_items = (
           SELECT COUNT(*) FROM sb_knowledge_evolution_run_items
           WHERE run_id = ? AND state = 'applied'
         ),
         skipped_items = (
           SELECT COUNT(*) FROM sb_knowledge_evolution_run_items
           WHERE run_id = ? AND state = 'skipped'
         ),
         failed_items = (
           SELECT COUNT(*) FROM sb_knowledge_evolution_run_items
           WHERE run_id = ? AND state = 'failed'
         ),
         last_error = CASE WHEN ? IS NULL THEN last_error ELSE ? END,
         state = CASE WHEN EXISTS (
           SELECT 1 FROM sb_knowledge_evolution_run_items
           WHERE run_id = ? AND state IN ('queued', 'processing')
         ) THEN 'running' ELSE 'completed' END,
         completed_at = CASE WHEN EXISTS (
           SELECT 1 FROM sb_knowledge_evolution_run_items
           WHERE run_id = ? AND state IN ('queued', 'processing')
         ) THEN NULL ELSE ? END,
         updated_at = ?
     WHERE id = ?`
  ).bind(
    input.runId,
    input.runId,
    input.runId,
    input.runId,
    input.error ?? null,
    input.error?.slice(0, 256) ?? null,
    input.runId,
    input.runId,
    now,
    now,
    input.runId
  ).run();
  return (await statusForRun(db, input.runId))!;
}
