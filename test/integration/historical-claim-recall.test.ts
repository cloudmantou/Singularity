import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase, recallEntries } from "../../src/index";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { getEffectiveModelSettings, resetSettingsCache } from "../../src/settings/store";
import { activeEmbeddingOf, embeddingFingerprintOf } from "../../src/settings/model-settings";
import { makeVectorizeMock } from "../helpers/make-env";

function ctx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

describe("historical Claim recall", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("retrieves an old immutable Claim after the current Entry projection changed", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const effective = (await getEffectiveModelSettings(env)).effective;
      const fingerprint = effective.embeddingFingerprint ?? embeddingFingerprintOf(activeEmbeddingOf(effective));
      db.prepare(
        `INSERT INTO entries (
           id, content, tags, source, created_at, vector_ids, content_hash
         ) VALUES ('entry-1', '当前使用方案 B', '["history"]', 'test', 100, '[]', 'hash-b')`
      ).run();
      db.prepare(
        `INSERT INTO sb_observations (
           id, content, source, content_hash, extraction_status, created_at
         ) VALUES
           ('obs-a', '历史使用方案 A', 'test', 'obs-hash-a', 'succeeded', 100),
           ('obs-b', '当前使用方案 B', 'test', 'obs-hash-b', 'succeeded', 200)`
      ).run();
      db.prepare(
        `INSERT INTO sb_parent_units (
           parent_id, active_version_id, created_at, updated_at
         ) VALUES ('parent-1', 'version-2', 100, 200)`
      ).run();
      db.prepare(
        `INSERT INTO sb_parent_versions (
           version_id, parent_id, version_number, state, summary_vector_ids,
           activated_at, superseded_at, tags_snapshot_json, source_snapshot,
           vault_snapshot, metadata_snapshot_hash, created_at, updated_at
         ) VALUES
           ('version-1', 'parent-1', 1, 'superseded', '[]', 100, 200,
            '["history","version:1"]', 'obsidian-old', 'vault-a', 'metadata-v1', 100, 200),
           ('version-2', 'parent-1', 2, 'active', '[]', 200, NULL,
            '["current"]', 'api-current', 'vault-b', 'metadata-v2', 200, 200)`
      ).run();
      db.prepare(
        `INSERT INTO sb_external_links (
           id, provider, vault_id, external_path, object_type, object_id,
           entry_id, sync_status, created_at, updated_at
         ) VALUES (
           'link-current', 'obsidian', 'vault-b', 'current.md', 'memory', 'entry-1',
           'entry-1', 'synced', 200, 200
         )`
      ).run();
      db.prepare(
        `INSERT INTO sb_memories (
           id, content, kind, entry_id, parent_version_id, claim_status, content_hash,
           observed_at, valid_from, invalid_at, created_at
         ) VALUES
           ('claim-a', '历史使用方案 A', 'semantic', 'entry-1', NULL, 'superseded',
            'hash-a', 100, 100, 200, 100),
           ('claim-b', '当前使用方案 B', 'semantic', 'entry-1', NULL, 'confirmed',
            'hash-b', 200, 200, NULL, 200)`
      ).run();
      db.prepare(
        `INSERT INTO sb_parent_version_claims (
           parent_version_id, memory_id, relation, created_at
         ) VALUES
           ('version-1', 'claim-a', 'supports', 100),
           ('version-2', 'claim-b', 'supports', 200)`
      ).run();
      db.prepare(
        `INSERT INTO sb_memory_sources (
           id, memory_id, observation_id, role, relation, created_at
         ) VALUES
           ('source-a', 'claim-a', 'obs-a', 'supports', 'supports', 100),
           ('source-b', 'claim-b', 'obs-b', 'supports', 'supports', 200)`
      ).run();
      const insertedClaimVectorIds: string[] = [];
      env.VECTORIZE = makeVectorizeMock({
        insert: vi.fn().mockImplementation(async (vectors: VectorizeVector[]) => {
          insertedClaimVectorIds.push(...vectors.map((vector) => vector.id));
          return { mutationId: "claim-backfill" };
        }),
        query: vi.fn()
          .mockRejectedValueOnce(new Error("source metadata index is not ready"))
          .mockImplementation(async () => ({
            matches: [{
              id: "unrelated-entry-vector",
              score: 0.99,
              metadata: { source: "api", parentId: "entry-1" },
            }, {
              id: insertedClaimVectorIds[0],
              score: 0.98,
              metadata: {
                source: "singularity-claim",
                claimId: "claim-a",
                embedding_fingerprint: fingerprint,
              },
            }],
          })),
      });
      const pending: Promise<unknown>[] = [];
      const executionContext = {
        waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      } as unknown as ExecutionContext;

      const result = await recallEntries({
        query: "方案 A",
        topK: 5,
        before: 150,
        kind: "semantic",
        tag: "history",
      }, env, executionContext);
      await Promise.allSettled(pending);

      expect(result.directEvidence).toEqual([
        expect.objectContaining({
          id: "entry-1",
          claimId: "claim-a",
          content: "历史使用方案 A",
          tags: ["history", "version:1", "kind:semantic"],
          source: "obsidian-old",
        }),
      ]);
      expect(result.matches.some((match) => match.content.includes("方案 B"))).toBe(false);
      expect(result.degraded).toBe(true);
      expect(insertedClaimVectorIds).toHaveLength(0);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM sb_claim_vectors`).get())
        .toEqual({ count: 0 });

      const maintenance = await worker.fetch(new Request(
        "http://localhost/maintenance/claim-vectors/backfill",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ limit: 10 }),
        }
      ), env, ctx());
      expect(maintenance.status).toBe(200);
      expect(await maintenance.json()).toMatchObject({
        ok: true,
        queue: { missing: 0 },
      });
      expect(insertedClaimVectorIds.length).toBeGreaterThan(0);

      const status = await worker.fetch(new Request(
        "http://localhost/maintenance/claim-vectors/status",
        { headers: { Authorization: "Bearer test-token" } }
      ), env, ctx());
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        ok: true,
        queue: { missing: 0, succeeded: 2 },
      });

      db.prepare(
        `UPDATE sb_claim_vector_jobs
         SET status = 'failed', attempts = 6, last_error = 'terminal'
         WHERE claim_id = 'claim-a' AND target_fingerprint = ?`
      ).run(fingerprint);
      db.prepare(
        `DELETE FROM sb_claim_vectors
         WHERE claim_id = 'claim-a' AND embedding_fingerprint = ?`
      ).run(fingerprint);
      const retryFailed = await worker.fetch(new Request(
        "http://localhost/maintenance/claim-vectors/retry-failed",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fingerprint, claimId: "claim-a", limit: 1 }),
        }
      ), env, ctx());
      expect(retryFailed.status).toBe(200);
      expect(await retryFailed.json()).toMatchObject({
        ok: true,
        targetFingerprint: fingerprint,
        claimId: "claim-a",
        retried: 1,
        queue: { pending: 1, failed: 0, missing: 1 },
      });

      env.VECTORIZE = makeVectorizeMock({
        query: vi.fn().mockRejectedValue(new Error("vector backend unavailable")),
      });
      const keywordFallback = await recallEntries({
        query: "方案 A",
        topK: 5,
        before: 150,
      }, env, ctx(), null, { allowClaimVectorBackfill: false });
      expect(keywordFallback.directEvidence).toEqual([
        expect.objectContaining({ claimId: "claim-a", content: "历史使用方案 A" }),
      ]);
      expect(keywordFallback.degraded).toBe(true);

      env.VECTORIZE = makeVectorizeMock({
        query: vi.fn().mockResolvedValue({ matches: [] }),
      });
      const empty = await recallEntries({ query: "", topK: 5, before: 150 }, env, ctx(), null, {
        allowClaimVectorBackfill: false,
      });
      expect(empty.matches).toEqual([]);

      db.prepare(`UPDATE entries SET tags = 'not-json' WHERE id = 'entry-1'`).run();
      const malformedTags = await recallEntries({
        query: "方案 A",
        topK: 5,
        before: 150,
      }, env, ctx(), null, { allowClaimVectorBackfill: false });
      const malformedTagEvidence = malformedTags.directEvidence ?? [];
      expect(malformedTagEvidence).toHaveLength(1);
      expect(malformedTagEvidence[0]).toMatchObject({
        claimId: "claim-a",
        tags: ["history", "version:1", "kind:semantic"],
        source: "obsidian-old",
      });

      const historicalVault = await recallEntries({
        query: "方案 A",
        topK: 5,
        before: 150,
        tag: "history",
      }, env, ctx(), "vault-a", { allowClaimVectorBackfill: false });
      expect(historicalVault.directEvidence).toEqual([
        expect.objectContaining({ claimId: "claim-a", source: "obsidian-old" }),
      ]);

      const currentVaultMustNotLeak = await recallEntries({
        query: "方案 A",
        topK: 5,
        before: 150,
      }, env, ctx(), "vault-b", { allowClaimVectorBackfill: false });
      expect(currentVaultMustNotLeak.matches).toEqual([]);

      const wrongVault = await recallEntries({
        query: "方案 A",
        topK: 5,
        before: 150,
      }, env, ctx(), "other-vault", { allowClaimVectorBackfill: false });
      expect(wrongVault.matches).toEqual([]);
    } finally {
      db.close();
    }
  });
});
