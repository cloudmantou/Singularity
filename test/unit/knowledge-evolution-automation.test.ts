import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase } from "../../src/index";
import {
  claimNextKnowledgeEvolutionItem,
  completeKnowledgeEvolutionItem,
  getKnowledgeEvolutionAutomationStatus,
  startKnowledgeEvolutionAutomation,
} from "../../src/memory/knowledge-evolution-automation";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

function seedPendingMemoryCandidates(
  db: ReturnType<typeof createSelfhostEnv>["db"],
  count: number
): void {
  for (let index = 0; index < count; index += 1) {
    db.prepare(
      `INSERT INTO sb_memory_merge_candidates (
         id, source_memory_id, target_memory_id, similarity,
         suggested_action, state, created_at
       ) VALUES (?, ?, ?, 0.95, 'merge', 'pending', ?)`
    ).run(`candidate-${index}`, `source-${index}`, `target-${index}`, 100 + index);
  }
}

describe("knowledge evolution automation", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("processes a persisted snapshot one item at a time and reports progress", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      seedPendingMemoryCandidates(db, 2);

      const started = await startKnowledgeEvolutionAutomation(env.DB, {
        requestedBy: "owner",
        objectType: "memory_merge_candidate",
        now: 1_000,
      });
      expect(started).toMatchObject({ state: "running", total: 2, processed: 0, percent: 0 });
      const runId = started.runId!;

      const first = await claimNextKnowledgeEvolutionItem(env.DB, {
        runId,
        workerId: "worker-a",
        now: 1_001,
        leaseMs: 100,
      });
      expect(first).toMatchObject({ objectType: "memory_merge_candidate" });
      expect(await claimNextKnowledgeEvolutionItem(env.DB, {
        runId,
        workerId: "worker-b",
        now: 1_002,
        leaseMs: 100,
      })).toBeNull();

      await completeKnowledgeEvolutionItem(env.DB, {
        runId,
        objectType: first!.objectType,
        objectId: first!.objectId,
        workerId: "worker-a",
        outcome: "applied",
        now: 1_003,
      });
      expect(await getKnowledgeEvolutionAutomationStatus(env.DB)).toMatchObject({
        state: "running",
        total: 2,
        processed: 1,
        applied: 1,
        percent: 50,
        current: null,
      });

      const second = await claimNextKnowledgeEvolutionItem(env.DB, {
        runId,
        workerId: "worker-a",
        now: 1_004,
        leaseMs: 100,
      });
      expect(second?.objectId).not.toBe(first?.objectId);
      await completeKnowledgeEvolutionItem(env.DB, {
        runId,
        objectType: second!.objectType,
        objectId: second!.objectId,
        workerId: "worker-a",
        outcome: "failed",
        error: "model_timeout",
        now: 1_005,
      });

      expect(await getKnowledgeEvolutionAutomationStatus(env.DB)).toMatchObject({
        state: "completed",
        total: 2,
        processed: 2,
        applied: 1,
        failed: 1,
        percent: 100,
        lastError: "model_timeout",
      });
    } finally {
      db.close();
    }
  });

  it("reclaims only an expired current item instead of starting another item", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      seedPendingMemoryCandidates(db, 2);
      const started = await startKnowledgeEvolutionAutomation(env.DB, {
        requestedBy: "system",
        objectType: "memory_merge_candidate",
        now: 2_000,
      });
      const runId = started.runId!;
      const first = await claimNextKnowledgeEvolutionItem(env.DB, {
        runId,
        workerId: "worker-a",
        now: 2_001,
        leaseMs: 10,
      });

      expect(await claimNextKnowledgeEvolutionItem(env.DB, {
        runId,
        workerId: "worker-b",
        now: 2_005,
        leaseMs: 10,
      })).toBeNull();
      expect(await claimNextKnowledgeEvolutionItem(env.DB, {
        runId,
        workerId: "worker-b",
        now: 2_012,
        leaseMs: 10,
      })).toMatchObject({ objectId: first!.objectId, reclaimed: true });
      expect(await claimNextKnowledgeEvolutionItem(env.DB, {
        runId,
        workerId: "worker-c",
        now: 2_023,
        leaseMs: 10,
      })).toMatchObject({ objectId: first!.objectId, attempts: 3, reclaimed: true });
      const next = await claimNextKnowledgeEvolutionItem(env.DB, {
        runId,
        workerId: "worker-d",
        now: 2_034,
        leaseMs: 10,
      });
      expect(next).toMatchObject({ objectType: "memory_merge_candidate", reclaimed: false });
      expect(next?.objectId).not.toBe(first?.objectId);
      expect(await getKnowledgeEvolutionAutomationStatus(env.DB)).toMatchObject({
        state: "running",
        processed: 1,
        failed: 1,
        lastError: "lease_retry_exhausted",
      });
    } finally {
      db.close();
    }
  });

  it("does not let a shadow run suppress a later automatic run", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      seedPendingMemoryCandidates(db, 1);
      const shadow = await startKnowledgeEvolutionAutomation(env.DB, {
        requestedBy: "owner",
        objectType: "memory_merge_candidate",
        mode: "shadow",
        now: 3_000,
      });
      const item = await claimNextKnowledgeEvolutionItem(env.DB, {
        runId: shadow.runId!,
        workerId: "worker-shadow",
        now: 3_001,
      });
      await completeKnowledgeEvolutionItem(env.DB, {
        runId: shadow.runId!,
        objectType: item!.objectType,
        objectId: item!.objectId,
        workerId: "worker-shadow",
        outcome: "skipped",
        now: 3_002,
      });

      const automatic = await startKnowledgeEvolutionAutomation(env.DB, {
        requestedBy: "owner",
        objectType: "memory_merge_candidate",
        mode: "auto_low_risk",
        now: 3_003,
      });
      expect(automatic).toMatchObject({
        state: "running",
        mode: "auto_low_risk",
        total: 1,
        processed: 0,
      });
    } finally {
      db.close();
    }
  });
});
