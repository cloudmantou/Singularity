import {
  AIReviewInvalidResponseError,
  AIReviewJobUnavailableError,
  AIReviewObjectUnavailableError,
  type AIReviewEvidenceManifest,
  type AIReviewModelResponse,
  type AIReviewModel,
  type AIReviewRunRecord,
  type AIReviewSnapshotManifest,
  createAIReviewManifest,
  ensureAIReviewDataModel,
  getAIReviewRun,
  hashAIReviewSnapshot,
  loadAIReviewSnapshot,
  modelSafeReviewSnapshot,
  parseAIReviewModelResponse,
  processAIReviewJob,
  revalidateAIAutoApplyRun,
} from "./ai-review";

export const EXTERNAL_EVOLUTION_POLICY_VERSION = "external-evolution-v3";
export const EXTERNAL_EVOLUTION_ALLOWED_DECISIONS = [
  "duplicate",
  "replace",
  "merge",
  "keep_both",
  "uncertain",
] as const;

const MAX_REVIEW_CANDIDATES = 500;
const DEFAULT_LEASE_MS = 5 * 60_000;
const MAX_LEASE_MS = 10 * 60_000;
const MAX_LEASE_PAYLOAD_BYTES = 64 * 1_024;
const EXTERNAL_OWNER_PRIVATE_VAULT_ID = "external:owner-private";
const EXTERNAL_EVOLUTION_POLICY_GLOB = "external-evolution-v[0-9]*";
const EXTERNAL_PRIVATE_SOURCE_CHANNELS = new Set([
  "api",
  "claude-code",
  "codex",
  "mcp",
]);

function isGlobalExternalLeaseIndex(sql: string | null | undefined): boolean {
  return Boolean(
    sql &&
    /CREATE\s+UNIQUE\s+INDEX/i.test(sql) &&
    /ON\s+sb_ai_review_jobs\s*\(\s*\(?1\)?\s*\)/i.test(sql) &&
    /review_policy_version\s+GLOB\s+'external-evolution-v\[0-9\]\*'/i.test(sql) &&
    /status\s+IN\s*\(\s*'processing'\s*,\s*'applying'\s*\)/i.test(sql) &&
    /status\s*=\s*'completed'[\s\S]*lease_owner\s+IS\s+NOT\s+NULL/i.test(sql)
  );
}

async function expireExternalEvolutionLeases(
  db: D1Database,
  now: number
): Promise<void> {
  await db.prepare(
    `UPDATE sb_ai_review_jobs
     SET status = 'failed', error_code = 'external_lease_expired',
         completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
     WHERE review_policy_version GLOB ? AND status = 'processing'
       AND COALESCE(lease_expires_at, 0) <= ?`
  ).bind(now, EXTERNAL_EVOLUTION_POLICY_GLOB, now).run();
  await db.prepare(
    `UPDATE sb_ai_review_jobs
     SET status = 'completed', error_code = 'external_application_lease_expired',
         lease_owner = NULL, lease_expires_at = NULL
     WHERE review_policy_version GLOB ? AND status = 'applying'
       AND COALESCE(lease_expires_at, 0) <= ?`
  ).bind(EXTERNAL_EVOLUTION_POLICY_GLOB, now).run();
  await db.prepare(
    `UPDATE sb_ai_review_jobs
     SET lease_owner = NULL, lease_expires_at = NULL,
         error_code = 'external_completion_lease_expired'
     WHERE review_policy_version GLOB ? AND status = 'completed'
       AND lease_owner IS NOT NULL AND COALESCE(lease_expires_at, 0) <= ?`
  ).bind(EXTERNAL_EVOLUTION_POLICY_GLOB, now).run();
}

async function migrateExternalLeaseIndex(
  db: D1Database,
  now: number
): Promise<void> {
  const rows = await db.prepare(
    `SELECT id
     FROM sb_ai_review_jobs
     WHERE review_policy_version GLOB ?
       AND (status IN ('processing', 'applying') OR
            (status = 'completed' AND lease_owner IS NOT NULL))
     ORDER BY CASE status WHEN 'applying' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
              CASE WHEN review_policy_version = ? THEN 0 ELSE 1 END,
              COALESCE(started_at, created_at) ASC, id ASC`
  ).bind(EXTERNAL_EVOLUTION_POLICY_GLOB, EXTERNAL_EVOLUTION_POLICY_VERSION)
    .all<{ id: string }>();
  const statements = (rows.results ?? []).slice(1).map((row) =>
    db.prepare(
      `UPDATE sb_ai_review_jobs
       SET status = CASE
             WHEN run_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM sb_ai_review_applications application
               WHERE application.run_id = sb_ai_review_jobs.run_id
             ) THEN 'applied'
             WHEN status = 'processing' THEN 'failed'
             ELSE 'completed'
           END,
           error_code = CASE
             WHEN run_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM sb_ai_review_applications application
               WHERE application.run_id = sb_ai_review_jobs.run_id
             ) THEN NULL
             ELSE 'external_parallel_lease_reconciled'
           END,
           completed_at = COALESCE(completed_at, ?),
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ?
         AND (status IN ('processing', 'applying') OR
              (status = 'completed' AND lease_owner IS NOT NULL))`
    ).bind(now, row.id)
  );
  statements.push(
    db.prepare(`DROP INDEX IF EXISTS idx_ai_review_jobs_single_external_lease`),
    db.prepare(
      `CREATE UNIQUE INDEX idx_ai_review_jobs_single_external_lease
       ON sb_ai_review_jobs((1))
       WHERE review_policy_version GLOB 'external-evolution-v[0-9]*'
         AND (
           status IN ('processing', 'applying') OR
           (status = 'completed' AND lease_owner IS NOT NULL)
         )`
    )
  );
  await db.batch(statements);
}

async function ensureExternalEvolutionDataModel(
  db: D1Database,
  now = Date.now()
): Promise<void> {
  await ensureAIReviewDataModel(db);
  await expireExternalEvolutionLeases(db, now);
  const leaseIndex = await db.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'index' AND name = 'idx_ai_review_jobs_single_external_lease'`
  ).first<{ sql: string | null }>();
  if (!isGlobalExternalLeaseIndex(leaseIndex?.sql)) {
    await migrateExternalLeaseIndex(db, now);
  }
}

export class ExternalEvolutionLeaseUnavailableError extends Error {
  constructor(message = "external_evolution_lease_unavailable") {
    super(message);
    this.name = "ExternalEvolutionLeaseUnavailableError";
  }
}

export class ExternalEvolutionSnapshotChangedError extends Error {
  constructor() {
    super("external_evolution_snapshot_changed");
    this.name = "ExternalEvolutionSnapshotChangedError";
  }
}

export class ExternalEvolutionSubmissionConflictError extends Error {
  constructor() {
    super("external_evolution_submission_conflict");
    this.name = "ExternalEvolutionSubmissionConflictError";
  }
}

export interface ExternalEvolutionLease {
  jobId: string;
  leaseToken: string;
  leaseExpiresAt: number;
  objectType: "memory_merge_candidate";
  objectId: string;
  snapshotHash: string;
  reviewPolicyVersion: typeof EXTERNAL_EVOLUTION_POLICY_VERSION;
  allowedDecisions: typeof EXTERNAL_EVOLUTION_ALLOWED_DECISIONS;
  snapshot: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

export interface ExternalEvolutionSubmission {
  jobId: string;
  leaseToken: string;
  snapshotHash: string;
  reviewerId: string;
  reviewerModel: string;
  proposal: unknown;
  now?: number;
}

export interface ExternalEvolutionServices {
  verifier?: AIReviewModel;
  applyRecommendation?: (runId: string) => Promise<unknown>;
  clock?: () => number;
}

export interface ExternalEvolutionLeaseServices {
  reconcileApplication?: (runId: string) => Promise<unknown>;
}

export interface ExternalEvolutionSubmissionResult {
  runId: string;
  objectId: string;
  decision: string;
  status: "recorded" | "applied";
  requiresHuman: boolean;
  autoApplyEligible: boolean;
  idempotent: boolean;
}

interface ExternalJobRow {
  id: string;
  object_type: string;
  object_id: string;
  mode: string;
  status: string;
  requested_by: string;
  review_policy_version: string;
  input_snapshot_hash: string;
  run_id: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)])
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function boundedIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(normalized)) {
    throw new AIReviewInvalidResponseError(`external_evolution_invalid_${field}`);
  }
  return normalized;
}

function boundedModel(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f]/.test(normalized)) {
    throw new AIReviewInvalidResponseError("external_evolution_invalid_reviewer_model");
  }
  return normalized;
}

function leaseIdentity(reviewerId: string, leaseHash: string): string {
  return `external:${reviewerId}:${leaseHash}`;
}

function submittedIdentity(
  reviewerId: string,
  leaseHash: string,
  submissionHash: string
): string {
  return `${leaseIdentity(reviewerId, leaseHash)}:${submissionHash}`;
}

async function externalJob(db: D1Database, jobId: string): Promise<ExternalJobRow | null> {
  return db.prepare(
    `SELECT id, object_type, object_id, mode, status, requested_by,
            review_policy_version, input_snapshot_hash, run_id,
            lease_owner, lease_expires_at
     FROM sb_ai_review_jobs WHERE id = ?`
  ).bind(jobId).first<ExternalJobRow>();
}

function sameResponse(run: AIReviewRunRecord, response: AIReviewModelResponse): boolean {
  if (run.reviewerProvider === "rules") return true;
  return run.decision === response.decision &&
    stableJson(run.evidenceRefs) === stableJson(response.evidenceRefs) &&
    stableJson(run.confidence) === stableJson(response.confidence) &&
    run.abstain === response.abstain &&
    run.reviewability === response.reviewability &&
    stableJson(run.missingContext) === stableJson(response.missingContext) &&
    stableJson(run.keyDifferences) === stableJson(response.keyDifferences) &&
    stableJson(run.refinement) === stableJson(response.refinement) &&
    (run.reason === response.reason || run.reason.startsWith(`${response.reason} Second-pass verification:`));
}

function resultForRun(
  run: AIReviewRunRecord,
  status: string,
  idempotent: boolean
): ExternalEvolutionSubmissionResult {
  return {
    runId: run.id,
    objectId: run.objectId,
    decision: run.decision,
    status: status === "applied" ? "applied" : "recorded",
    requiresHuman: run.requiresHuman,
    autoApplyEligible: run.autoApplyEligible,
    idempotent,
  };
}

function reviewableMergeSnapshot(snapshot: Record<string, unknown>): boolean {
  const evidence = Array.isArray(snapshot.evidence) ? snapshot.evidence : [];
  return evidence.length === 2 && evidence.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return typeof record.content === "string" && record.content.trim().length > 0 &&
      Array.isArray(record.claims) && record.claims.length > 0 &&
      record.claims.every((claim) => {
        if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
        return (claim as Record<string, unknown>).contentTruncated === false;
      });
  });
}

function sameOptionalContext(left: string[], right: string[]): boolean {
  if (left.length === 0 && right.length === 0) return true;
  if (left.length === 0 || right.length === 0) return false;
  return stableJson(left) === stableJson(right);
}

function normalizedManifestValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function trustedPrivateEvidence(item: AIReviewEvidenceManifest): boolean {
  const channels = normalizedManifestValues(item.sourceChannels);
  return channels.length > 0 && channels.every((channel) =>
    EXTERNAL_PRIVATE_SOURCE_CHANNELS.has(channel.toLowerCase())
  );
}

function externallyReviewableManifest(
  manifest: AIReviewSnapshotManifest
): AIReviewSnapshotManifest | null {
  if (manifest.evidence.length !== 2) return null;
  const [left, right] = manifest.evidence;
  const leftProjects = normalizedManifestValues(left.projectIds);
  const rightProjects = normalizedManifestValues(right.projectIds);
  if (!sameOptionalContext(leftProjects, rightProjects)) return null;

  const leftVaults = normalizedManifestValues(left.vaultIds);
  const rightVaults = normalizedManifestValues(right.vaultIds);
  const leftScopes = normalizedManifestValues(left.scopeIds);
  const rightScopes = normalizedManifestValues(right.scopeIds);
  if (!sameOptionalContext(leftVaults, rightVaults) ||
      !sameOptionalContext(leftScopes, rightScopes)) return null;

  const needsDerivedVault = leftVaults.length === 0;
  const needsDerivedScope = leftScopes.length === 0;
  if (needsDerivedVault || needsDerivedScope) {
    if (leftProjects.length === 0 ||
        !trustedPrivateEvidence(left) || !trustedPrivateEvidence(right)) return null;
  }

  const vaultIds = needsDerivedVault
    ? [EXTERNAL_OWNER_PRIVATE_VAULT_ID]
    : leftVaults;
  const scopeIds = needsDerivedScope
    ? leftProjects.map((projectId) => `project-context:${projectId}`)
    : leftScopes;
  return {
    ...manifest,
    evidence: manifest.evidence.map((item) => ({
      ...item,
      projectIds: normalizedManifestValues(item.projectIds),
      vaultIds: [...vaultIds],
      scopeIds: [...scopeIds],
    })),
  };
}

async function appliedJobExists(db: D1Database, run: AIReviewRunRecord): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS applied
     FROM sb_ai_review_jobs job
     JOIN sb_ai_review_applications application ON application.run_id = job.run_id
     WHERE job.id = ? AND job.run_id = ? AND job.status = 'applied'
     LIMIT 1`
  ).bind(run.jobId, run.id).first<{ applied: number }>();
  return Boolean(row);
}

async function reconcileExternalApplication(
  db: D1Database,
  services: ExternalEvolutionLeaseServices,
  now: number
): Promise<boolean> {
  await db.prepare(
    `UPDATE sb_ai_review_jobs
     SET status = 'applied', lease_owner = NULL, lease_expires_at = NULL,
         error_code = NULL
     WHERE review_policy_version GLOB ? AND status IN ('completed', 'applying')
       AND run_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM sb_ai_review_applications application
         WHERE application.run_id = sb_ai_review_jobs.run_id
       )`
  ).bind(EXTERNAL_EVOLUTION_POLICY_GLOB).run();
  const live = await db.prepare(
    `SELECT 1 AS live FROM sb_ai_review_jobs
     WHERE review_policy_version GLOB ?
       AND (status IN ('processing', 'applying') OR
            (status = 'completed' AND lease_owner IS NOT NULL))
       AND COALESCE(lease_expires_at, 0) > ? LIMIT 1`
  ).bind(EXTERNAL_EVOLUTION_POLICY_GLOB, now).first<{ live: number }>();
  if (live) return true;
  const pending = await db.prepare(
    `SELECT job.id AS job_id, job.run_id
     FROM sb_ai_review_jobs job
     JOIN sb_ai_review_runs run ON run.id = job.run_id
     LEFT JOIN sb_ai_review_applications application ON application.run_id = run.id
     WHERE job.review_policy_version = ? AND job.status = 'completed'
       AND job.run_id IS NOT NULL AND run.auto_apply_eligible = 1
       AND application.id IS NULL
     ORDER BY job.completed_at ASC, job.id ASC LIMIT 1`
  ).bind(EXTERNAL_EVOLUTION_POLICY_VERSION).first<{ job_id: string; run_id: string }>();
  if (!pending) return false;
  const run = await getAIReviewRun(db, pending.run_id);
  if (!run) throw new AIReviewJobUnavailableError(pending.run_id);
  if (!revalidateAIAutoApplyRun(run).eligible) {
    const released = await db.prepare(
      `UPDATE sb_ai_review_jobs
       SET status = 'failed', error_code = 'external_auto_apply_revalidation_failed',
           completed_at = COALESCE(completed_at, ?),
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND run_id = ? AND status = 'completed'`
    ).bind(now, pending.job_id, pending.run_id).run();
    if (Number(released.meta?.changes ?? 0) !== 1) {
      throw new AIReviewJobUnavailableError(pending.run_id);
    }
    return false;
  }
  if (!services.reconcileApplication) return true;
  await services.reconcileApplication(pending.run_id);
  if (!await appliedJobExists(db, run)) {
    throw new AIReviewJobUnavailableError(pending.run_id);
  }
  return false;
}

export async function leaseNextExternalEvolutionReview(
  db: D1Database,
  input: {
    reviewerId: string;
    now?: number;
    leaseMs?: number;
  },
  services: ExternalEvolutionLeaseServices = {}
): Promise<ExternalEvolutionLease | null> {
  const now = input.now ?? Date.now();
  await ensureExternalEvolutionDataModel(db, now);
  const reviewerId = boundedIdentity(input.reviewerId, "reviewer_id");
  const leaseMs = Math.max(1, Math.min(input.leaseMs ?? DEFAULT_LEASE_MS, MAX_LEASE_MS));
  if (await reconcileExternalApplication(db, services, now)) return null;
  const live = await db.prepare(
    `SELECT 1 AS live FROM sb_ai_review_jobs
     WHERE review_policy_version GLOB ?
       AND (status IN ('processing', 'applying') OR
            (status = 'completed' AND lease_owner IS NOT NULL))
       AND COALESCE(lease_expires_at, 0) > ? LIMIT 1`
  ).bind(EXTERNAL_EVOLUTION_POLICY_GLOB, now).first<{ live: number }>();
  if (live) return null;

  const rows = await db.prepare(
    `SELECT candidate.id FROM sb_memory_merge_candidates candidate
     WHERE candidate.state = 'pending'
       AND EXISTS (
         SELECT 1
         FROM sb_memories source_claim
         JOIN entries source_entry
           ON source_entry.id = source_claim.entry_id
          AND source_entry.content_hash = source_claim.content_hash
         WHERE source_claim.entry_id = candidate.source_memory_id
           AND source_claim.claim_status IN ('supported', 'confirmed', 'contested')
           AND source_claim.invalid_at IS NULL
           AND source_claim.expired_at IS NULL
       )
       AND EXISTS (
         SELECT 1
         FROM sb_memories target_claim
         JOIN entries target_entry
           ON target_entry.id = target_claim.entry_id
          AND target_entry.content_hash = target_claim.content_hash
         WHERE target_claim.entry_id = candidate.target_memory_id
           AND target_claim.claim_status IN ('supported', 'confirmed', 'contested')
           AND target_claim.invalid_at IS NULL
           AND target_claim.expired_at IS NULL
       )
     ORDER BY candidate.created_at ASC, candidate.id ASC LIMIT ?`
  ).bind(MAX_REVIEW_CANDIDATES).all<{ id: string }>();
  for (const row of rows.results ?? []) {
    let snapshotHash: string | null = null;
    try {
      const snapshot = await loadAIReviewSnapshot(db, "memory_merge_candidate", row.id);
      if (!reviewableMergeSnapshot(snapshot)) continue;
      snapshotHash = await hashAIReviewSnapshot(snapshot);
      const oversized = await db.prepare(
        `SELECT 1 AS skipped FROM sb_ai_review_jobs
         WHERE object_type = 'memory_merge_candidate' AND object_id = ?
           AND review_policy_version = ? AND input_snapshot_hash = ?
           AND status = 'failed' AND error_code = 'external_context_too_large'
         LIMIT 1`
      ).bind(row.id, EXTERNAL_EVOLUTION_POLICY_VERSION, snapshotHash)
        .first<{ skipped: number }>();
      if (oversized) continue;
      const manifest = externallyReviewableManifest(await createAIReviewManifest(snapshot));
      if (!manifest) continue;
      const leaseToken = crypto.randomUUID();
      const leaseHash = await sha256(leaseToken);
      const leaseExpiresAt = now + leaseMs;
      const jobId = crypto.randomUUID();
      const inserted = await db.prepare(
        `INSERT INTO sb_ai_review_jobs (
           id, object_type, object_id, mode, status, requested_by,
           review_policy_version, input_snapshot_hash, input_snapshot_json,
           created_at, started_at, lease_owner, lease_expires_at
         ) VALUES (?, 'memory_merge_candidate', ?, 'auto_low_risk', 'processing', ?,
                   ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        jobId,
        row.id,
        leaseIdentity(reviewerId, leaseHash),
        EXTERNAL_EVOLUTION_POLICY_VERSION,
        snapshotHash,
        stableJson(manifest),
        now,
        now,
        leaseHash,
        leaseExpiresAt
      ).run();
      if (Number(inserted.meta?.changes ?? 0) !== 1) continue;
      const lease: ExternalEvolutionLease = {
        jobId,
        leaseToken,
        leaseExpiresAt,
        objectType: "memory_merge_candidate",
        objectId: row.id,
        snapshotHash,
        reviewPolicyVersion: EXTERNAL_EVOLUTION_POLICY_VERSION,
        allowedDecisions: EXTERNAL_EVOLUTION_ALLOWED_DECISIONS,
        snapshot: modelSafeReviewSnapshot(snapshot),
        manifest: manifest as unknown as Record<string, unknown>,
      };
      if (new TextEncoder().encode(stableJson(lease)).byteLength > MAX_LEASE_PAYLOAD_BYTES) {
        await db.prepare(
          `UPDATE sb_ai_review_jobs
           SET status = 'failed', error_code = 'external_context_too_large',
               completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'processing' AND lease_owner = ?`
        ).bind(now, jobId, leaseHash).run();
        continue;
      }
      return lease;
    } catch (error) {
      if (error instanceof AIReviewObjectUnavailableError) continue;
      const concurrentLease = await db.prepare(
        `SELECT 1 AS live FROM sb_ai_review_jobs
         WHERE review_policy_version GLOB ?
           AND (status IN ('processing', 'applying') OR
                (status = 'completed' AND lease_owner IS NOT NULL))
           AND COALESCE(lease_expires_at, 0) > ? LIMIT 1`
      ).bind(EXTERNAL_EVOLUTION_POLICY_GLOB, now).first<{ live: number }>();
      if (concurrentLease) return null;
      if (!snapshotHash) throw error;
      const active = await db.prepare(
        `SELECT 1 AS active FROM sb_ai_review_jobs
         WHERE object_type = 'memory_merge_candidate' AND object_id = ?
           AND mode = 'auto_low_risk' AND input_snapshot_hash = ?
           AND review_policy_version = ?
           AND status IN ('queued', 'processing', 'completed', 'applying', 'applied')
         LIMIT 1`
      ).bind(row.id, snapshotHash, EXTERNAL_EVOLUTION_POLICY_VERSION)
        .first<{ active: number }>();
      if (!active) throw error;
    }
  }
  return null;
}

export async function submitExternalEvolutionReview(
  db: D1Database,
  input: ExternalEvolutionSubmission,
  services: ExternalEvolutionServices = {}
): Promise<ExternalEvolutionSubmissionResult> {
  const now = input.now ?? Date.now();
  await ensureExternalEvolutionDataModel(db, now);
  const reviewerId = boundedIdentity(input.reviewerId, "reviewer_id");
  const reviewerModel = boundedModel(input.reviewerModel);
  const leaseHash = await sha256(input.leaseToken);
  const expectedLeaseIdentity = leaseIdentity(reviewerId, leaseHash);
  const response = parseAIReviewModelResponse(
    stableJson(input.proposal),
    "memory_merge_candidate",
    ["SOURCE", "TARGET"]
  );
  const submissionHash = await sha256(stableJson({
    proposal: response,
    reviewerModel,
  }));
  const expectedSubmittedIdentity = submittedIdentity(reviewerId, leaseHash, submissionHash);
  const job = await externalJob(db, input.jobId);
  if (
    !job || job.object_type !== "memory_merge_candidate" ||
    job.mode !== "auto_low_risk" ||
    job.review_policy_version !== EXTERNAL_EVOLUTION_POLICY_VERSION
  ) throw new ExternalEvolutionLeaseUnavailableError();
  if (job.run_id && ["completed", "applying", "applied"].includes(job.status)) {
    if (job.requested_by !== expectedSubmittedIdentity) {
      throw new ExternalEvolutionSubmissionConflictError();
    }
    const run = await getAIReviewRun(db, job.run_id);
    if (!run || !sameResponse(run, response)) {
      throw new ExternalEvolutionSubmissionConflictError();
    }
    if (run.autoApplyEligible && job.status !== "applied" && services.applyRecommendation) {
      await services.applyRecommendation(run.id);
      if (!await appliedJobExists(db, run)) {
        throw new AIReviewJobUnavailableError(run.id);
      }
      return resultForRun(run, "applied", true);
    }
    return resultForRun(run, job.status, true);
  }
  if (
    job.status !== "processing" || job.lease_owner !== leaseHash ||
    Number(job.lease_expires_at ?? 0) <= now ||
    ![expectedLeaseIdentity, expectedSubmittedIdentity].includes(job.requested_by)
  ) throw new ExternalEvolutionLeaseUnavailableError();
  if (job.input_snapshot_hash !== input.snapshotHash) {
    throw new ExternalEvolutionSnapshotChangedError();
  }

  let snapshot;
  try {
    snapshot = await loadAIReviewSnapshot(db, "memory_merge_candidate", job.object_id);
  } catch (error) {
    if (error instanceof AIReviewObjectUnavailableError) {
      throw new ExternalEvolutionSnapshotChangedError();
    }
    throw error;
  }
  if (await hashAIReviewSnapshot(snapshot) !== input.snapshotHash) {
    throw new ExternalEvolutionSnapshotChangedError();
  }
  const identified = await db.prepare(
    `UPDATE sb_ai_review_jobs SET requested_by = ?
     WHERE id = ? AND status = 'processing' AND lease_owner = ?
       AND COALESCE(lease_expires_at, 0) > ?
       AND requested_by IN (?, ?)`
  ).bind(
    expectedSubmittedIdentity,
    input.jobId,
    leaseHash,
    now,
    expectedLeaseIdentity,
    expectedSubmittedIdentity
  ).run();
  if (Number(identified.meta?.changes ?? 0) !== 1) {
    throw new ExternalEvolutionSubmissionConflictError();
  }

  const proposalJson = stableJson(response);
  const unavailableVerification = stableJson({
    approved: false,
    decision: response.decision,
    evidenceRefs: ["SOURCE", "TARGET"],
    unsupportedStatements: ["Independent server verification was unavailable."],
    reason: "Independent server verification was unavailable; automatic application is denied.",
  });
  const verifierLabel = services.verifier
    ? `${services.verifier.provider}/${services.verifier.model}`
    : "unavailable";
  const result = await processAIReviewJob(db, input.jobId, {
    provider: "mcp-external-agent",
    model: `${reviewerModel}|verified-by:${verifierLabel}`.slice(0, 320),
    complete: async (messages) => messages.system.includes("second-pass evidence verifier")
      ? services.verifier?.complete(messages) ?? unavailableVerification
      : proposalJson,
  }, {
    existingLeaseOwner: leaseHash,
    preserveLeaseOnCompletion: true,
    clock: services.clock ?? (input.now == null ? undefined : () => input.now!),
  });
  if (result.run.autoApplyEligible && services.applyRecommendation) {
    await services.applyRecommendation(result.run.id);
    if (!await appliedJobExists(db, result.run)) {
      throw new AIReviewJobUnavailableError(result.run.id);
    }
    return resultForRun(result.run, "applied", false);
  }
  await db.prepare(
    `UPDATE sb_ai_review_jobs
     SET lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ? AND run_id = ? AND status = 'completed' AND lease_owner = ?`
  ).bind(input.jobId, result.run.id, leaseHash).run();
  return resultForRun(result.run, result.job.status, false);
}

export function isExternalEvolutionError(error: unknown): boolean {
  return error instanceof ExternalEvolutionLeaseUnavailableError ||
    error instanceof ExternalEvolutionSnapshotChangedError ||
    error instanceof ExternalEvolutionSubmissionConflictError ||
    error instanceof AIReviewInvalidResponseError ||
    error instanceof AIReviewJobUnavailableError ||
    error instanceof AIReviewObjectUnavailableError;
}
