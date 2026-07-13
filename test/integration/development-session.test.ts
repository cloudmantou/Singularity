import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

function req(body: unknown, authenticated = true) {
  return new Request("http://localhost/integrations/development-session/capture", {
    method: "POST",
    headers: {
      ...(authenticated ? { Authorization: "Bearer test-token" } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function ctx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
}

describe("Development session source adapter", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("stores a raw session as assistant-authored Evidence with stable project provenance", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const body = {
        client: "claude-code",
        repository: "Singularity",
        branch: "main",
        sessionId: "session-123",
        capturedAt: 1234,
        transcript: "User: Keep Fact edges separate.\n\nAssistant: Association links are navigation only.",
      };
      expect((await worker.fetch(req(body, false), env, ctx())).status).toBe(401);

      const response = await worker.fetch(req(body), env, ctx());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        source: "claude-code",
        status: "stored_raw_evidence",
      });

      const observation = db.prepare(
        `SELECT source_channel, source_identity, author_type, root_evidence_id,
                extraction_status, metadata_json
         FROM sb_observations WHERE source_channel = 'claude-code' LIMIT 1`
      ).get() as Record<string, unknown>;
      expect(observation).toMatchObject({
        source_channel: "claude-code",
        source_identity: "claude-code:Singularity:main:session-123",
        author_type: "assistant",
        root_evidence_id: "claude-code:Singularity:main:session-123",
        extraction_status: "succeeded",
      });
      expect(JSON.parse(String(observation.metadata_json))).toMatchObject({
        content_stage: "raw_evidence",
        evidence_type: "conversation_transcript",
        extraction_skipped_reason: "mixed_author_transcript",
        repository: "Singularity",
        branch: "main",
      });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM entries`).get()).toEqual({ count: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM sb_memories`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("links subsequent session revisions to the previous Evidence revision", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      const base = {
        client: "codex",
        repository: "Singularity",
        branch: "main",
        sessionId: "session-revisions",
      };
      expect((await worker.fetch(req({
        ...base,
        revision: 1,
        transcript: "User: First decision.\n\nAssistant: Recorded first decision.",
      }), env, ctx())).status).toBe(200);
      expect((await worker.fetch(req({
        ...base,
        revision: 2,
        transcript: "User: Updated decision.\n\nAssistant: Recorded updated decision.",
      }), env, ctx())).status).toBe(200);

      const rows = db.prepare(
        `SELECT id, revision, root_evidence_id, previous_evidence_id
         FROM sb_observations
         WHERE source_channel = 'codex'
         ORDER BY revision ASC`
      ).all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        revision: 2,
        root_evidence_id: rows[0].root_evidence_id,
        previous_evidence_id: rows[0].id,
      });
    } finally {
      db.close();
    }
  });
});
