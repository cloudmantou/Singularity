import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexClaimSnapshotVector, initializeDatabase } from "../../src/index";
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
});
