import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { indexClaimSnapshotVector, initializeDatabase } from "../../src/index";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { activeEmbeddingOf, embeddingFingerprintOf } from "../../src/settings/model-settings";
import { getEffectiveModelSettings, resetSettingsCache } from "../../src/settings/store";
import { makeVectorizeMock } from "../helpers/make-env";

describe("Claim vector mapping CAS", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("cannot recreate an old mapping after activation deletes its leased Job", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const effective = (await getEffectiveModelSettings(env)).effective;
      const fingerprint = effective.embeddingFingerprint ?? embeddingFingerprintOf(activeEmbeddingOf(effective));
      db.exec(`
        INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
        VALUES ('entry-1', 'claim text', '[]', 'api', 1, '[]', 'entry-hash');
        INSERT INTO sb_observations (id, content, source, content_hash, created_at)
        VALUES ('obs-1', 'claim text', 'api', 'obs-hash', 1);
        INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
        VALUES ('parent-1', 'parent-v1', 1, 1);
        INSERT INTO sb_parent_versions (version_id, parent_id, version_number, state, created_at, updated_at)
        VALUES ('parent-v1', 'parent-1', 1, 'active', 1, 1);
        INSERT INTO sb_memories (id, content, entry_id, parent_version_id, content_hash, claim_status, created_at)
        VALUES ('claim-1', 'claim text', 'entry-1', 'parent-v1', 'claim-hash', 'confirmed', 1);
        INSERT INTO sb_memory_sources (id, memory_id, observation_id, role, relation, created_at)
        VALUES ('source-1', 'claim-1', 'obs-1', 'supports', 'supports', 1);
        INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
        VALUES ('parent-v1', 'claim-1', 'supports', 1);
      `);
      db.prepare(
        `INSERT INTO sb_claim_vector_jobs (
           id, claim_id, target_fingerprint, content_hash, parent_version_id,
           status, attempts, lease_owner, lease_expires_at, created_at, updated_at
         ) VALUES ('job-1', 'claim-1', ?, 'claim-hash', 'parent-v1',
                   'processing', 1, 'lease-1', ?, 1, 1)`
      ).run(fingerprint, Date.now() + 60_000);
      const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "cleanup" });
      env.VECTORIZE = makeVectorizeMock({
        insert: vi.fn().mockImplementation(async () => {
          db.prepare(`DELETE FROM sb_claim_vector_jobs WHERE id = 'job-1'`).run();
          return { mutationId: "stale-write" };
        }),
        deleteByIds,
      });

      await expect(indexClaimSnapshotVector(env, {
        jobId: "job-1",
        leaseOwner: "lease-1",
        claimId: "claim-1",
        entryId: "entry-1",
        parentVersionId: "parent-v1",
        content: "claim text",
        contentHash: "claim-hash",
        createdAt: 1,
        targetFingerprint: fingerprint,
        rebuildId: null,
      })).rejects.toThrow("claim_vector_mapping_cas_failed");
      expect(db.prepare(`SELECT COUNT(*) AS count FROM sb_claim_vectors`).get()).toEqual({ count: 0 });
      expect(deleteByIds).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("moves a queued rebuild to building before processing its first claim vector", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.exec(`
        INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
        VALUES ('entry-queued', 'queued claim text', '[]', 'api', 1, '["old-entry-vector"]', 'queued-hash');
        INSERT INTO sb_observations (
          id, content, source, content_hash, root_evidence_id,
          extraction_status, extraction_version, needs_reprocess, created_at
        ) VALUES (
          'obs-queued', 'queued claim text', 'api', 'queued-hash', 'evidence-queued',
          'succeeded', 2, 0, 1
        );
        INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
        VALUES ('parent-queued', 'parent-v-queued', 1, 1);
        INSERT INTO sb_parent_versions (
          version_id, parent_id, version_number, source_observation_id,
          source_snapshot_hash, state, created_at, updated_at
        ) VALUES (
          'parent-v-queued', 'parent-queued', 1, 'obs-queued',
          'queued-hash', 'active', 1, 1
        );
        INSERT INTO sb_memories (
          id, content, entry_id, parent_version_id, content_hash, claim_status, created_at
        ) VALUES (
          'claim-queued', 'queued claim text', 'entry-queued',
          'parent-v-queued', 'queued-hash', 'confirmed', 1
        );
        INSERT INTO sb_memory_sources (
          id, memory_id, observation_id, role, relation, evidence_root_id, created_at
        ) VALUES (
          'source-queued', 'claim-queued', 'obs-queued', 'supports',
          'supports', 'evidence-queued', 1
        );
        INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
        VALUES ('parent-v-queued', 'claim-queued', 'supports', 1);
      `);
      const request = (path: string, body: Record<string, unknown>) => new Request(
        `http://localhost${path}`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );
      const ctx = { waitUntil() {} } as unknown as ExecutionContext;

      const reindexResponse = await worker.fetch(
        request("/settings/models/reindex", {}),
        env,
        ctx
      );
      expect(reindexResponse.status).toBe(200);
      const reindex = await reindexResponse.json() as any;
      expect(db.prepare(
        `SELECT state FROM sb_vector_rebuilds WHERE id = ?`
      ).get(reindex.rebuildId)).toEqual({ state: "queued" });

      const vectorizeResponse = await worker.fetch(
        request("/vectorize-pending", { limit: 5, includeRecent: true }),
        env,
        ctx
      );
      const vectorize = await vectorizeResponse.json() as any;

      expect(vectorizeResponse.status).toBe(200);
      expect(vectorize.failed).toBe(0);
      expect(vectorize.claimVectorProcessing.failed).toBe(0);
      expect(db.prepare(
        `SELECT status, last_error FROM sb_claim_vector_jobs
         WHERE claim_id = 'claim-queued' AND target_fingerprint = ?`
      ).get(reindex.pendingFingerprint)).toEqual({ status: "succeeded", last_error: null });
    } finally {
      db.close();
    }
  });

  it("reports failed legacy Claim vector work as remaining", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      db.exec(`
        INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
        VALUES ('entry-legacy', 'legacy claim text', '[]', 'api', 1, '["entry-vector"]', 'legacy-hash');
        INSERT INTO sb_observations (
          id, content, source, content_hash, root_evidence_id,
          extraction_status, extraction_version, needs_reprocess, created_at
        ) VALUES (
          'obs-legacy', 'legacy claim text', 'api', 'legacy-hash', 'evidence-legacy',
          'succeeded', 2, 0, 1
        );
        INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
        VALUES ('parent-legacy', 'parent-v-legacy', 1, 1);
        INSERT INTO sb_parent_versions (
          version_id, parent_id, version_number, source_observation_id,
          source_snapshot_hash, state, created_at, updated_at
        ) VALUES (
          'parent-v-legacy', 'parent-legacy', 1, 'obs-legacy',
          'legacy-hash', 'active', 1, 1
        );
        INSERT INTO sb_memories (
          id, content, entry_id, parent_version_id, content_hash, claim_status, created_at
        ) VALUES (
          'claim-legacy', 'legacy claim text', 'entry-legacy',
          'parent-v-legacy', 'legacy-hash', 'confirmed', 1
        );
        INSERT INTO sb_memory_sources (
          id, memory_id, observation_id, role, relation, evidence_root_id, created_at
        ) VALUES (
          'source-legacy', 'claim-legacy', 'obs-legacy', 'supports',
          'supports', 'evidence-legacy', 1
        );
        INSERT INTO sb_parent_version_claims (parent_version_id, memory_id, relation, created_at)
        VALUES ('parent-v-legacy', 'claim-legacy', 'supports', 1);
      `);
      env.VECTORIZE = makeVectorizeMock({
        insert: vi.fn().mockRejectedValue(new Error("vector store unavailable")),
      });
      const response = await worker.fetch(
        new Request("http://localhost/vectorize-pending", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ limit: 1 }),
        }),
        env,
        { waitUntil() {} } as unknown as ExecutionContext
      );
      const data = await response.json() as any;

      expect(response.status).toBe(200);
      expect(data.claimVectorProcessing.failed).toBe(1);
      expect(data.claimVectorsRemaining).toBe(1);
      expect(data.remaining).toBe(1);
    } finally {
      db.close();
    }
  });
});
