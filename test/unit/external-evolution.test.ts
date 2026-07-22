import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase } from "../../src/index";
import { AIReviewJobUnavailableError } from "../../src/memory/ai-review";
import {
  EXTERNAL_EVOLUTION_POLICY_VERSION,
  ExternalEvolutionLeaseUnavailableError,
  ExternalEvolutionSubmissionConflictError,
  leaseNextExternalEvolutionReview,
  submitExternalEvolutionReview,
} from "../../src/memory/external-evolution";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function seedCandidate(
  db: ReturnType<typeof createSelfhostEnv>["db"],
  id = "external-review"
): Promise<void> {
  const now = 10_000;
  for (const side of ["source", "target"] as const) {
    const content = side === "source"
      ? "Singularity preserves immutable source observations."
      : "Singularity keeps immutable evidence while refining claims.";
    const contentHash = await hash(content);
    const entryId = `${id}-${side}`;
    const observationId = `${entryId}-observation`;
    const parentId = `${entryId}-parent`;
    const versionId = `${parentId}-v1`;
    const claimId = `${entryId}-claim`;
    db.prepare(
      `INSERT INTO entries (
         id, content, tags, source, created_at, vector_ids, content_hash,
         classification_status, classified_at
       ) VALUES (?, ?, '["project/singularity"]', 'obsidian', ?, '[]', ?, 'completed', ?)`
    ).run(entryId, content, now, contentHash, now);
    db.prepare(
      `INSERT INTO sb_observations (
         id, content, source, content_hash, source_channel, source_identity,
         author_type, source_timestamp, revision, root_evidence_id,
         extraction_status, created_at
       ) VALUES (?, ?, 'obsidian', ?, 'obsidian', ?, 'user', ?, 1, ?, 'completed', ?)`
    ).run(
      observationId,
      content,
      contentHash,
      `private-vault/${side}.md`,
      now,
      observationId,
      now
    );
    db.prepare(
      `INSERT INTO sb_parent_units (
         parent_id, active_version_id, scope_id, created_at, updated_at
       ) VALUES (?, ?, 'project/singularity', ?, ?)`
    ).run(parentId, versionId, now, now);
    db.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, source_observation_id,
         source_snapshot_hash, tags_snapshot_json, source_snapshot, vault_snapshot,
         state, activated_at, activation_time_source, created_at, updated_at
       ) VALUES (?, ?, 1, ?, ?, '["project/singularity"]', 'obsidian', 'work-vault',
                 'active', ?, 'recorded', ?, ?)`
    ).run(versionId, parentId, observationId, contentHash, now, now, now);
    db.prepare(
      `INSERT INTO sb_memories (
         id, content, kind, memory_class, confidence, entry_id, parent_version_id,
         scope_id, claim_status, scores_json, content_hash, observed_at,
         entities_json, created_at
       ) VALUES (?, ?, 'semantic', 'fact', 0.95, ?, ?, 'project/singularity',
                 'supported', '{}', ?, ?, '[]', ?)`
    ).run(claimId, content, entryId, versionId, contentHash, now, now);
    db.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, score, relation, evidence_score,
         derivation_confidence, extractor_model, extractor_version,
         evidence_root_id, created_at
       ) VALUES (?, ?, ?, 'supports', 0.95, 'supports', 0.95, 0.95,
                 'seed', '1', ?, ?)`
    ).run(`${claimId}-source`, claimId, observationId, observationId, now);
    db.prepare(
      `INSERT INTO sb_parent_version_claims (
         parent_version_id, memory_id, relation, created_at
       ) VALUES (?, ?, 'supports', ?)`
    ).run(versionId, claimId, now);
  }
  db.prepare(
    `INSERT INTO sb_memory_merge_candidates (
       id, source_memory_id, target_memory_id, similarity,
       suggested_action, state, created_at
     ) VALUES (?, ?, ?, 0.94, 'merge', 'pending', ?)`
  ).run(id, `${id}-source`, `${id}-target`, now);
}

async function seedLegacyPrivateCandidate(
  db: ReturnType<typeof createSelfhostEnv>["db"],
  id: string,
  targetProject = "singularity"
): Promise<void> {
  await seedCandidate(db, id);
  db.prepare(
    `UPDATE entries
     SET source = 'mcp',
         tags = CASE id
           WHEN ? THEN '["project/singularity"]'
           ELSE ?
         END
     WHERE id IN (?, ?)`
  ).run(
    `${id}-source`,
    JSON.stringify([`project/${targetProject}`]),
    `${id}-source`,
    `${id}-target`
  );
  db.prepare(
    `UPDATE sb_observations
     SET source = 'mcp', source_channel = 'mcp', author_type = 'tool'
     WHERE id IN (?, ?)`
  ).run(`${id}-source-observation`, `${id}-target-observation`);
  db.prepare(
    `UPDATE sb_parent_versions
     SET source_snapshot = 'mcp', vault_snapshot = NULL
     WHERE version_id IN (?, ?)`
  ).run(`${id}-source-parent-v1`, `${id}-target-parent-v1`);
  db.prepare(
    `UPDATE sb_memories SET scope_id = NULL WHERE entry_id IN (?, ?)`
  ).run(`${id}-source`, `${id}-target`);
}

function mergeProposal() {
  return {
    decision: "merge",
    reason: "Both claims describe the same evidence-preserving design and can be consolidated.",
    evidenceRefs: ["SOURCE", "TARGET"],
    confidence: { decision: 0.98, evidence: 0.97 },
    abstain: false,
    reviewability: "sufficient",
    missingContext: [],
    keyDifferences: [{
      dimension: "content",
      status: "different",
      summary: "The target adds that refined claims retain their evidence.",
      evidenceRefs: ["SOURCE", "TARGET"],
    }],
    refinement: {
      action: "merge",
      content: "Singularity preserves immutable evidence while refining traceable claims.",
      sourceRefs: ["SOURCE", "TARGET"],
    },
  } as const;
}

function approvedVerification() {
  return {
    approved: true,
    decision: "merge",
    evidenceRefs: ["SOURCE", "TARGET"],
    unsupportedStatements: [],
    reason: "The refinement is fully supported by both supplied claims.",
  } as const;
}

function approvedVerifier() {
  return {
    provider: "server-test",
    model: "verifier-v1",
    complete: vi.fn(async () => JSON.stringify(approvedVerification())),
  };
}

describe("external knowledge evolution review", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("leases one bounded, model-safe candidate and prevents concurrent claims", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db);

      const leased = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 20_000,
        leaseMs: 5_000,
      });

      expect(leased).toMatchObject({
        objectType: "memory_merge_candidate",
        objectId: "external-review",
        allowedDecisions: ["duplicate", "replace", "merge", "keep_both", "uncertain"],
        leaseExpiresAt: 25_000,
      });
      expect(leased?.leaseToken).toMatch(/^[a-f0-9-]{36}$/i);
      expect(leased?.snapshot.evidence).toHaveLength(2);
      expect(JSON.stringify(leased?.snapshot)).toContain("immutable source observations");
      expect(JSON.stringify(leased?.snapshot)).not.toContain("private-vault/source.md");
      expect(JSON.stringify(leased?.snapshot)).not.toContain("source_identity");
      expect(new TextEncoder().encode(JSON.stringify(leased)).byteLength).toBeLessThanOrEqual(64 * 1_024);
      expect(await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-b",
        now: 20_001,
      })).toBeNull();
    } finally {
      db.close();
    }
  });

  it("leases complete reviewable claims instead of silently truncating them", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, "external-complete-claim");
      const content = `Complete implementation evidence: ${"verified diagnostic detail ".repeat(90)}`;
      const contentHash = await hash(content);
      db.prepare(
        `UPDATE entries SET content = ?, content_hash = ? WHERE id = ?`
      ).run(content, contentHash, "external-complete-claim-source");
      db.prepare(
        `UPDATE sb_memories SET content = ?, content_hash = ? WHERE entry_id = ?`
      ).run(content, contentHash, "external-complete-claim-source");
      db.prepare(
        `UPDATE sb_observations SET content = ?, content_hash = ? WHERE id = ?`
      ).run(content, contentHash, "external-complete-claim-source-observation");
      db.prepare(
        `UPDATE sb_parent_versions SET source_snapshot_hash = ? WHERE version_id = ?`
      ).run(contentHash, "external-complete-claim-source-parent-v1");

      const leased = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-complete",
        now: 20_100,
      });
      const evidence = leased?.snapshot.evidence as Array<{
        ref: string;
        claims: Array<{ content: string; contentTruncated: boolean }>;
      }>;
      const source = evidence.find((item) => item.ref === "SOURCE");

      expect(source?.claims[0]).toMatchObject({
        content: content.trim(),
        contentTruncated: false,
      });
      expect(source?.claims[0].content.endsWith("...")).toBe(false);
      expect(new TextEncoder().encode(JSON.stringify(leased)).byteLength)
        .toBeLessThanOrEqual(64 * 1_024);
    } finally {
      db.close();
    }
  });

  it("does not lease a claim whose complete text exceeds the review bound", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, "external-oversized-claim");
      const content = `Oversized evidence: ${"x".repeat(6_100)}`;
      const contentHash = await hash(content);
      db.prepare(
        `UPDATE entries SET content = ?, content_hash = ? WHERE id = ?`
      ).run(content, contentHash, "external-oversized-claim-source");
      db.prepare(
        `UPDATE sb_memories SET content = ?, content_hash = ? WHERE entry_id = ?`
      ).run(content, contentHash, "external-oversized-claim-source");
      db.prepare(
        `UPDATE sb_observations SET content = ?, content_hash = ? WHERE id = ?`
      ).run(content, contentHash, "external-oversized-claim-source-observation");
      db.prepare(
        `UPDATE sb_parent_versions SET source_snapshot_hash = ? WHERE version_id = ?`
      ).run(contentHash, "external-oversized-claim-source-parent-v1");

      await expect(leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-oversized",
        now: 20_200,
      })).resolves.toBeNull();
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_ai_review_jobs WHERE object_id = ?`
      ).get("external-oversized-claim")).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("allows only one global lease when two reviewers race across multiple candidates", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, "external-race-a");
      await seedCandidate(db, "external-race-b");

      const leases = await Promise.all([
        leaseNextExternalEvolutionReview(env.DB, { reviewerId: "codex-a", now: 25_000 }),
        leaseNextExternalEvolutionReview(env.DB, { reviewerId: "codex-b", now: 25_000 }),
      ]);

      expect(leases.filter(Boolean)).toHaveLength(1);
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_ai_review_jobs
         WHERE review_policy_version = ? AND status = 'processing'`
      ).get(EXTERNAL_EVOLUTION_POLICY_VERSION)).toEqual({ count: 1 });
      expect(EXTERNAL_EVOLUTION_POLICY_VERSION).toBe("external-evolution-v3");
      expect(db.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_ai_review_jobs_single_external_lease'`
      ).get()).toEqual(expect.objectContaining({
        sql: expect.stringMatching(/ON sb_ai_review_jobs\s*\(\s*\(?1\)?\s*\)/),
      }));
    } finally {
      db.close();
    }
  });

  it("replaces a non-unique lookalike lease index during runtime migration", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "schema-bootstrap",
        now: 25_050,
      });
      db.exec(`DROP INDEX IF EXISTS idx_ai_review_jobs_single_external_lease`);
      db.exec(
        `CREATE INDEX idx_ai_review_jobs_single_external_lease
         ON sb_ai_review_jobs((1))
         WHERE review_policy_version GLOB 'external-evolution-v[0-9]*'
           AND (
             status IN ('processing', 'applying') OR
             (status = 'completed' AND lease_owner IS NOT NULL)
           )`
      );

      await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "schema-migrator",
        now: 25_100,
      });

      expect(db.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_ai_review_jobs_single_external_lease'`
      ).get()).toEqual(expect.objectContaining({
        sql: expect.stringMatching(/^CREATE UNIQUE INDEX/i),
      }));

      db.exec(`DROP INDEX idx_ai_review_jobs_single_external_lease`);
      db.exec(
        `CREATE UNIQUE INDEX idx_ai_review_jobs_single_external_lease
         ON sb_ai_review_jobs((1))
         WHERE review_policy_version GLOB 'external-evolution-v[0-9]*'
           AND status IN ('processing', 'applying')`
      );
      await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "predicate-migrator",
        now: 25_200,
      });

      expect(db.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_ai_review_jobs_single_external_lease'`
      ).get()).toEqual(expect.objectContaining({
        sql: expect.stringMatching(/status\s*=\s*'completed'[\s\S]*lease_owner\s+IS\s+NOT\s+NULL/i),
      }));
    } finally {
      db.close();
    }
  });

  it("treats a live lease from an older policy generation as globally exclusive", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "schema-bootstrap",
        now: 10_000,
      });
      await seedCandidate(db, "external-cross-policy");
      db.prepare(
        `INSERT INTO sb_ai_review_jobs (
           id, object_type, object_id, mode, status, requested_by,
           review_policy_version, input_snapshot_hash, input_snapshot_json,
           created_at, started_at, lease_owner, lease_expires_at
         ) VALUES (
           'external-v2-live', 'memory_merge_candidate', 'legacy-candidate',
           'auto_low_risk', 'processing', 'external:legacy:lease',
           'external-evolution-v2', 'legacy-snapshot', '{}',
           19000, 19000, 'legacy-lease-hash', 25000
         )`
      ).run();

      await expect(leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-v3",
        now: 20_000,
      })).resolves.toBeNull();
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_ai_review_jobs
         WHERE review_policy_version = ? AND status = 'processing'`
      ).get(EXTERNAL_EVOLUTION_POLICY_VERSION)).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("reclaims expired leases from older policy generations before leasing current work", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "schema-bootstrap",
        now: 10_000,
      });
      await seedCandidate(db, "external-after-expired-policy");
      db.prepare(
        `INSERT INTO sb_ai_review_jobs (
           id, object_type, object_id, mode, status, requested_by,
           review_policy_version, input_snapshot_hash, input_snapshot_json,
           created_at, started_at, lease_owner, lease_expires_at
         ) VALUES (
           'external-v2-expired', 'memory_merge_candidate', 'legacy-candidate',
           'auto_low_risk', 'processing', 'external:legacy:lease',
           'external-evolution-v2', 'legacy-snapshot', '{}',
           18000, 18000, 'legacy-lease-hash', 19999
         )`
      ).run();

      const leased = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-v3",
        now: 20_000,
      });

      expect(leased?.objectId).toBe("external-after-expired-policy");
      expect(db.prepare(
        `SELECT status, error_code, lease_owner, lease_expires_at
         FROM sb_ai_review_jobs WHERE id = 'external-v2-expired'`
      ).get()).toEqual({
        status: "failed",
        error_code: "external_lease_expired",
        lease_owner: null,
        lease_expires_at: null,
      });
    } finally {
      db.close();
    }
  });

  it("reconciles parallel legacy leases while migrating to the global lease index", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "schema-bootstrap",
        now: 10_000,
      });
      db.exec(`DROP INDEX idx_ai_review_jobs_single_external_lease`);
      db.exec(
        `CREATE UNIQUE INDEX idx_ai_review_jobs_single_external_lease
         ON sb_ai_review_jobs(review_policy_version)
         WHERE review_policy_version GLOB 'external-evolution-v[0-9]*'
           AND status = 'processing'`
      );
      const insertLease = db.prepare(
        `INSERT INTO sb_ai_review_jobs (
           id, object_type, object_id, mode, status, requested_by,
           review_policy_version, input_snapshot_hash, input_snapshot_json,
           created_at, started_at, lease_owner, lease_expires_at
         ) VALUES (?, 'memory_merge_candidate', ?, 'auto_low_risk', 'processing', ?,
                   ?, ?, '{}', ?, ?, ?, 25000)`
      );
      insertLease.run(
        "external-v2-parallel",
        "legacy-candidate",
        "external:legacy:lease",
        "external-evolution-v2",
        "legacy-snapshot",
        18_000,
        18_000,
        "legacy-lease-hash"
      );
      insertLease.run(
        "external-v3-parallel",
        "current-candidate",
        "external:current:lease",
        EXTERNAL_EVOLUTION_POLICY_VERSION,
        "current-snapshot",
        19_000,
        19_000,
        "current-lease-hash"
      );

      await expect(leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-v3",
        now: 20_000,
      })).resolves.toBeNull();

      expect(db.prepare(
        `SELECT id, status, error_code FROM sb_ai_review_jobs
         WHERE id IN ('external-v2-parallel', 'external-v3-parallel') ORDER BY id`
      ).all()).toEqual([
        {
          id: "external-v2-parallel",
          status: "failed",
          error_code: "external_parallel_lease_reconciled",
        },
        { id: "external-v3-parallel", status: "processing", error_code: null },
      ]);
      expect(db.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_ai_review_jobs_single_external_lease'`
      ).get()).toEqual(expect.objectContaining({
        sql: expect.stringMatching(/ON sb_ai_review_jobs\s*\(\s*\(?1\)?\s*\)/),
      }));
    } finally {
      db.close();
    }
  });

  it("reclaims an expired lease without allowing the stale token to submit", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db);
      const first = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 30_000,
        leaseMs: 10,
      }))!;
      const second = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-b",
        now: 30_011,
        leaseMs: 10,
      }))!;

      expect(second.objectId).toBe(first.objectId);
      expect(second.jobId).not.toBe(first.jobId);
      await expect(submitExternalEvolutionReview(env.DB, {
        jobId: first.jobId,
        leaseToken: first.leaseToken,
        snapshotHash: first.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal: mergeProposal(),
        now: 30_012,
      })).rejects.toBeInstanceOf(ExternalEvolutionLeaseUnavailableError);
    } finally {
      db.close();
    }
  });

  it("rejects unknown evidence refs and stale snapshots without mutating the candidate", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db);
      const leased = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 40_000,
      }))!;
      const invalid = {
        ...mergeProposal(),
        evidenceRefs: ["SOURCE", "INVENTED"],
      };
      await expect(submitExternalEvolutionReview(env.DB, {
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        snapshotHash: leased.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal: invalid,
        now: 40_001,
      })).rejects.toThrow(/unknown_evidence_ref/);
      expect(db.prepare(
        `SELECT state FROM sb_memory_merge_candidates WHERE id = 'external-review'`
      ).get()).toEqual({ state: "pending" });

      db.prepare(
        `UPDATE entries SET content = 'Changed after lease', content_hash = 'changed-hash'
         WHERE id = 'external-review-source'`
      ).run();
      await expect(submitExternalEvolutionReview(env.DB, {
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        snapshotHash: leased.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal: mergeProposal(),
        now: 40_002,
      })).rejects.toThrow(/snapshot_changed/);
    } finally {
      db.close();
    }
  });

  it("fails closed when the lease expires during server-side verification", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db);
      const leased = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 45_000,
        leaseMs: 10,
      }))!;
      let currentTime = 45_001;
      const apply = vi.fn();
      const verifier = {
        provider: "server-test",
        model: "slow-verifier-v1",
        complete: vi.fn(async () => {
          currentTime = 45_010;
          return JSON.stringify(approvedVerification());
        }),
      };

      await expect(submitExternalEvolutionReview(env.DB, {
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        snapshotHash: leased.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal: mergeProposal(),
        now: 45_001,
      }, {
        verifier,
        applyRecommendation: apply,
        clock: () => currentTime,
      })).rejects.toBeInstanceOf(AIReviewJobUnavailableError);

      expect(apply).not.toHaveBeenCalled();
      expect(db.prepare(
        `SELECT status FROM sb_ai_review_jobs WHERE id = ?`
      ).get(leased.jobId)).toEqual({ status: "failed" });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_ai_review_runs WHERE job_id = ?`
      ).get(leased.jobId)).toEqual({ count: 0 });
      expect(db.prepare(
        `SELECT state FROM sb_memory_merge_candidates WHERE id = 'external-review'`
      ).get()).toEqual({ state: "pending" });
    } finally {
      db.close();
    }
  });

  it("records abstention without applying and idempotently replays the same submission", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db);
      const leased = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 50_000,
      }))!;
      const proposal = {
        decision: "uncertain",
        reason: "The temporal relationship is not available.",
        evidenceRefs: ["SOURCE", "TARGET"],
        confidence: { decision: 0.2, evidence: 0.7 },
        abstain: true,
        reviewability: "partial",
        missingContext: ["temporal_context"],
        keyDifferences: [],
        refinement: { action: "none", content: null, sourceRefs: [] },
      } as const;
      const apply = vi.fn(async () => ({ status: "applied" }));
      const input = {
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        snapshotHash: leased.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal,
        now: 50_001,
      };

      const services = { verifier: approvedVerifier(), applyRecommendation: apply };
      const first = await submitExternalEvolutionReview(env.DB, input, services);
      const replay = await submitExternalEvolutionReview(env.DB, input, services);

      expect(first).toMatchObject({ status: "recorded", idempotent: false });
      expect(replay).toMatchObject({ runId: first.runId, status: "recorded", idempotent: true });
      await expect(submitExternalEvolutionReview(env.DB, {
        ...input,
        proposal: { ...proposal, reason: "A different replay payload." },
      }, services)).rejects.toBeInstanceOf(ExternalEvolutionSubmissionConflictError);
      expect(apply).not.toHaveBeenCalled();
      expect(db.prepare(
        `SELECT state FROM sb_memory_merge_candidates WHERE id = 'external-review'`
      ).get()).toEqual({ state: "pending" });
    } finally {
      db.close();
    }
  });

  it("applies a verified low-risk proposal through the injected coordinator", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db);
      const leased = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 60_000,
      }))!;
      const apply = vi.fn(async (runId: string) => {
        const run = db.prepare(
          `SELECT job_id, object_type, object_id, decision FROM sb_ai_review_runs WHERE id = ?`
        ).get(runId) as {
          job_id: string;
          object_type: string;
          object_id: string;
          decision: string;
        };
        db.prepare(
          `INSERT INTO sb_ai_review_applications (
             id, run_id, object_type, object_id, decision, applied_by,
             application_mode, decision_source, created_at
           ) VALUES (?, ?, ?, ?, ?, 'unit-coordinator', 'deterministic_auto',
                     'guarded_ai', ?)`
        ).run(
          crypto.randomUUID(),
          runId,
          run.object_type,
          run.object_id,
          run.decision,
          60_002
        );
        db.prepare(
          `UPDATE sb_ai_review_jobs SET status = 'applied' WHERE id = ? AND run_id = ?`
        ).run(run.job_id, runId);
        return { runId, status: "applied" };
      });

      const result = await submitExternalEvolutionReview(env.DB, {
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        snapshotHash: leased.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal: mergeProposal(),
        now: 60_001,
      }, {
        verifier: approvedVerifier(),
        applyRecommendation: apply,
      });

      expect(result).toMatchObject({ status: "applied", idempotent: false });
      expect(apply).toHaveBeenCalledOnce();
      expect(db.prepare(
        `SELECT reviewer_provider, reviewer_model, auto_apply_eligible
         FROM sb_ai_review_runs WHERE id = ?`
      ).get(result.runId)).toEqual({
        reviewer_provider: "mcp-external-agent",
        reviewer_model: "gpt-test|verified-by:server-test/verifier-v1+second-pass-verifier",
        auto_apply_eligible: 1,
      });
    } finally {
      db.close();
    }
  });

  it("does not lease the next candidate while an accepted review is entering application", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, "external-apply-a");
      await seedCandidate(db, "external-apply-b");
      const leased = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 70_000,
      }))!;
      let enterApply!: () => void;
      let finishApply!: () => void;
      const applying = new Promise<void>((resolve) => { enterApply = resolve; });
      const finish = new Promise<void>((resolve) => { finishApply = resolve; });
      const apply = vi.fn(async (runId: string) => {
        enterApply();
        await finish;
        const run = db.prepare(
          `SELECT job_id, object_type, object_id, decision FROM sb_ai_review_runs WHERE id = ?`
        ).get(runId) as {
          job_id: string;
          object_type: string;
          object_id: string;
          decision: string;
        };
        db.prepare(
          `INSERT INTO sb_ai_review_applications (
             id, run_id, object_type, object_id, decision, applied_by,
             application_mode, decision_source, created_at
           ) VALUES (?, ?, ?, ?, ?, 'unit-coordinator', 'deterministic_auto',
                     'guarded_ai', ?)`
        ).run(
          crypto.randomUUID(),
          runId,
          run.object_type,
          run.object_id,
          run.decision,
          70_002
        );
        db.prepare(
          `UPDATE sb_ai_review_jobs SET status = 'applied', lease_owner = NULL,
                  lease_expires_at = NULL WHERE id = ? AND run_id = ?`
        ).run(run.job_id, runId);
      });
      const submission = submitExternalEvolutionReview(env.DB, {
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        snapshotHash: leased.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal: mergeProposal(),
        now: 70_001,
      }, {
        verifier: approvedVerifier(),
        applyRecommendation: apply,
      });
      await applying;

      expect(await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-b",
        now: 70_002,
      })).toBeNull();

      finishApply();
      await expect(submission).resolves.toMatchObject({ status: "applied" });
    } finally {
      db.close();
    }
  });

  it("records a semantic proposal without applying when the server verifier is unavailable", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db);
      const leased = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 80_000,
      }))!;
      const apply = vi.fn();

      const result = await submitExternalEvolutionReview(env.DB, {
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        snapshotHash: leased.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal: mergeProposal(),
        now: 80_001,
      }, { applyRecommendation: apply });

      expect(result).toMatchObject({
        status: "recorded",
        requiresHuman: true,
        autoApplyEligible: false,
      });
      expect(apply).not.toHaveBeenCalled();
      expect(db.prepare(
        `SELECT state FROM sb_memory_merge_candidates WHERE id = 'external-review'`
      ).get()).toEqual({ state: "pending" });
    } finally {
      db.close();
    }
  });

  it("reconciles an eligible completed run before issuing the next lease", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, "external-reconcile-a");
      await seedCandidate(db, "external-reconcile-b");
      const leased = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 90_000,
      }))!;
      const recorded = await submitExternalEvolutionReview(env.DB, {
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        snapshotHash: leased.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal: mergeProposal(),
        now: 90_001,
      }, { verifier: approvedVerifier() });
      expect(recorded).toMatchObject({ status: "recorded", autoApplyEligible: true });

      const reconcileApplication = vi.fn(async (runId: string) => {
        const run = db.prepare(
          `SELECT job_id, object_type, object_id, decision FROM sb_ai_review_runs WHERE id = ?`
        ).get(runId) as {
          job_id: string;
          object_type: string;
          object_id: string;
          decision: string;
        };
        db.prepare(
          `INSERT INTO sb_ai_review_applications (
             id, run_id, object_type, object_id, decision, applied_by,
             application_mode, decision_source, created_at
           ) VALUES (?, ?, ?, ?, ?, 'reconciler', 'deterministic_auto',
                     'guarded_ai', ?)`
        ).run(
          crypto.randomUUID(),
          runId,
          run.object_type,
          run.object_id,
          run.decision,
          90_003
        );
        db.prepare(
          `UPDATE sb_ai_review_jobs SET status = 'applied' WHERE id = ? AND run_id = ?`
        ).run(run.job_id, runId);
        db.prepare(
          `UPDATE sb_memory_merge_candidates SET state = 'accepted' WHERE id = ?`
        ).run(run.object_id);
      });

      const next = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-b",
        now: 90_004,
      }, { reconcileApplication });

      expect(reconcileApplication).toHaveBeenCalledOnce();
      expect(next?.objectId).toBe("external-reconcile-b");
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_ai_review_runs WHERE object_id = 'external-reconcile-a'`
      ).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("revalidates a completed run and re-leases it when current policy rejects auto-apply", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, "external-stale-eligibility");
      const leased = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-old-policy",
        now: 90_500,
      }))!;
      const evidence = (leased.manifest.evidence as Array<Record<string, unknown>>).map((item) => ({
        ...item,
        scopeIds: ["project/appflex", "project/itunes"],
      }));
      const staleManifest = { ...leased.manifest, evidence };
      db.prepare(
        `INSERT INTO sb_ai_review_runs (
           id, job_id, object_type, object_id, mode, decision, reason,
           evidence_refs_json, confidence_json, reviewability,
           missing_context_json, key_differences_json, refinement_json,
           abstained, requires_human, auto_apply_eligible,
           reviewer_provider, reviewer_model, prompt_version,
           input_snapshot_hash, input_snapshot_json, created_at
         ) VALUES (
           'stale-auto-run', ?, 'memory_merge_candidate', ?, 'auto_low_risk', 'merge',
           'Previously eligible under an older policy.', '["SOURCE","TARGET"]',
           '{"decision":0.99,"evidence":0.99}', 'sufficient', '[]',
           '[{"dimension":"content","status":"different","summary":"Complementary wording.","evidenceRefs":["SOURCE","TARGET"]}]',
           '{"action":"merge","content":"One merged Claim.","sourceRefs":["SOURCE","TARGET"]}',
           0, 0, 1, 'mcp-external-agent', 'legacy-reviewer', 'knowledge-review-v5',
           ?, ?, 90501
         )`
      ).bind(
        leased.jobId,
        leased.objectId,
        leased.snapshotHash,
        JSON.stringify(staleManifest)
      ).run();
      db.prepare(
        `UPDATE sb_ai_review_jobs
         SET status = 'completed', run_id = 'stale-auto-run', completed_at = 90501,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?`
      ).run(leased.jobId);
      const reconcileApplication = vi.fn(async () => undefined);

      const next = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-current-policy",
        now: 90_502,
      }, { reconcileApplication });

      expect(reconcileApplication).not.toHaveBeenCalled();
      expect(next).toMatchObject({
        objectId: "external-stale-eligibility",
        reviewPolicyVersion: EXTERNAL_EVOLUTION_POLICY_VERSION,
      });
      expect(next?.jobId).not.toBe(leased.jobId);
      expect(db.prepare(
        `SELECT status, error_code FROM sb_ai_review_jobs WHERE id = ?`
      ).get(leased.jobId)).toEqual({
        status: "failed",
        error_code: "external_auto_apply_revalidation_failed",
      });
      expect(db.prepare(
        `SELECT requires_human, auto_apply_eligible
         FROM sb_ai_review_runs WHERE id = 'stale-auto-run'`
      ).get()).toEqual({ requires_human: 0, auto_apply_eligible: 1 });
    } finally {
      db.close();
    }
  });

  it("re-reviews an expired applying run from an older policy instead of auto-applying it", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, "external-legacy-apply-a");
      await seedCandidate(db, "external-legacy-apply-b");
      const leased = (await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 91_000,
      }))!;
      const recorded = await submitExternalEvolutionReview(env.DB, {
        jobId: leased.jobId,
        leaseToken: leased.leaseToken,
        snapshotHash: leased.snapshotHash,
        reviewerId: "codex-a",
        reviewerModel: "gpt-test",
        proposal: mergeProposal(),
        now: 91_001,
      }, { verifier: approvedVerifier() });
      expect(recorded).toMatchObject({ status: "recorded", autoApplyEligible: true });
      db.prepare(
        `UPDATE sb_ai_review_jobs
         SET review_policy_version = 'external-evolution-v2', status = 'applying',
             lease_owner = 'legacy-application', lease_expires_at = 91002
         WHERE id = ?`
      ).run(leased.jobId);

      const reconcileApplication = vi.fn(async (runId: string) => {
        const run = db.prepare(
          `SELECT job_id, object_type, object_id, decision FROM sb_ai_review_runs WHERE id = ?`
        ).get(runId) as {
          job_id: string;
          object_type: string;
          object_id: string;
          decision: string;
        };
        db.prepare(
          `INSERT INTO sb_ai_review_applications (
             id, run_id, object_type, object_id, decision, applied_by,
             application_mode, decision_source, created_at
           ) VALUES (?, ?, ?, ?, ?, 'legacy-reconciler', 'deterministic_auto',
                     'guarded_ai', ?)`
        ).run(
          crypto.randomUUID(),
          runId,
          run.object_type,
          run.object_id,
          run.decision,
          91_004
        );
        db.prepare(
          `UPDATE sb_ai_review_jobs
           SET status = 'applied', lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND run_id = ?`
        ).run(run.job_id, runId);
        db.prepare(
          `UPDATE sb_memory_merge_candidates SET state = 'accepted' WHERE id = ?`
        ).run(run.object_id);
      });

      const next = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-b",
        now: 91_005,
      }, { reconcileApplication });

      expect(reconcileApplication).not.toHaveBeenCalled();
      expect(next).toMatchObject({
        objectId: "external-legacy-apply-a",
        reviewPolicyVersion: EXTERNAL_EVOLUTION_POLICY_VERSION,
      });
      expect(next?.jobId).not.toBe(leased.jobId);
      expect(db.prepare(
        `SELECT status, error_code, lease_owner, lease_expires_at
         FROM sb_ai_review_jobs WHERE id = ?`
      ).get(leased.jobId)).toEqual({
        status: "completed",
        error_code: "external_application_lease_expired",
        lease_owner: null,
        lease_expires_at: null,
      });
    } finally {
      db.close();
    }
  });

  it("skips a stale malformed candidate instead of blocking later work", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.prepare(
        `INSERT INTO sb_memory_merge_candidates (
           id, source_memory_id, target_memory_id, similarity,
           suggested_action, state, created_at
         ) VALUES ('external-missing', 'missing-source', 'missing-target', 1,
                   'merge', 'pending', 1)`
      ).run();
      await seedCandidate(db, "external-valid");

      const leased = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 100_000,
      });

      expect(leased?.objectId).toBe("external-valid");
    } finally {
      db.close();
    }
  });

  it("does not expose cross-context claims through an external lease", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedCandidate(db, "external-cross-context");
      db.prepare(
        `UPDATE sb_parent_versions SET vault_snapshot = 'private-vault'
         WHERE version_id = 'external-cross-context-target-parent-v1'`
      ).run();
      await seedCandidate(db, "external-safe-context");

      const leased = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 110_000,
      });

      expect(leased?.objectId).toBe("external-safe-context");
      expect(JSON.stringify(leased)).not.toContain("private-vault");
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_ai_review_jobs
         WHERE object_id = 'external-cross-context'`
      ).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("derives an owner-private review context for legacy MCP claims in the same project", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedLegacyPrivateCandidate(db, "external-legacy-private");

      const leased = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 120_000,
      });

      expect(leased?.objectId).toBe("external-legacy-private");
      expect(leased?.manifest.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          vaultIds: ["external:owner-private"],
          scopeIds: ["project-context:tag:singularity"],
          projectIds: ["tag:singularity"],
        }),
      ]));
      expect(JSON.stringify(leased?.snapshot)).not.toContain("private-vault");
    } finally {
      db.close();
    }
  });

  it("does not derive review context across different legacy MCP projects", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      await seedLegacyPrivateCandidate(db, "external-legacy-cross-project", "mtzs");

      const leased = await leaseNextExternalEvolutionReview(env.DB, {
        reviewerId: "codex-a",
        now: 130_000,
      });

      expect(leased).toBeNull();
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM sb_ai_review_jobs
         WHERE object_id = 'external-legacy-cross-project'`
      ).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
