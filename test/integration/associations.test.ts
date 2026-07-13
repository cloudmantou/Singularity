import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { initializeDatabase } from "../../src/index";
import { createSelfhostEnv } from "../../src/selfhost/env";
import { resetSettingsCache } from "../../src/settings/store";

function request(path: string, init: RequestInit = {}, authenticated = true) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(authenticated ? { Authorization: "Bearer test-token" } : {}),
      "Content-Type": "application/json",
    },
  });
}

function ctx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;
}

describe("Association Graph API", () => {
  beforeEach(() => {
    resetSettingsCache();
    vi.stubEnv("ALLOW_DEV_EMBEDDING", "true");
    vi.stubEnv("EMBEDDING_PROVIDER", "local-hash-dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSettingsCache();
  });

  it("links, lists, and unlinks active Parent associations with auth", async () => {
    const { env, db } = createSelfhostEnv({ databasePath: ":memory:", authToken: "test-token" });
    try {
      await initializeDatabase(env);
      seed(db, "entry-a", "parent-a", "A", 100);
      seed(db, "entry-b", "parent-b", "B", 110);

      const unauthorized = await worker.fetch(request("/link", {
        method: "POST",
        body: JSON.stringify({ sourceId: "entry-a", targetId: "entry-b", type: "related_to" }),
      }, false), env, ctx());
      expect(unauthorized.status).toBe(401);

      const linked = await worker.fetch(request("/link", {
        method: "POST",
        body: JSON.stringify({
          sourceId: "entry-a",
          targetId: "entry-b",
          type: "related_to",
          metadata: { reason: "same project" },
        }),
      }), env, ctx());
      expect(linked.status).toBe(200);
      expect(await linked.json()).toMatchObject({
        ok: true,
        association: {
          sourceParentId: "parent-a",
          targetParentId: "parent-b",
          edgeType: "related_to",
          provenance: "manual",
        },
      });

      const connections = await worker.fetch(
        request("/connections?id=entry-a"),
        env,
        ctx()
      );
      expect(await connections.json()).toMatchObject({
        ok: true,
        connections: [{ entryId: "entry-b", edgeType: "related_to" }],
      });

      const unlinked = await worker.fetch(request("/unlink", {
        method: "POST",
        body: JSON.stringify({ sourceId: "entry-b", targetId: "entry-a", type: "related_to" }),
      }), env, ctx());
      expect(await unlinked.json()).toEqual({ ok: true, deleted: 1 });
    } finally {
      db.close();
    }
  });

  function seed(
    db: ReturnType<typeof createSelfhostEnv>["db"],
    entryId: string,
    parentId: string,
    content: string,
    createdAt: number
  ) {
    const versionId = `${parentId}:v1`;
    const observationId = `${parentId}:obs`;
    const memoryId = `${parentId}:claim`;
    const hash = `${parentId}:hash`;
    db.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, content_hash)
       VALUES (?, ?, '[]', 'test', ?, '[]', ?)`
    ).run(entryId, content, createdAt, hash);
    db.prepare(
      `INSERT INTO sb_observations (id, content, source, content_hash, extraction_status, created_at)
       VALUES (?, ?, 'test', ?, 'succeeded', ?)`
    ).run(observationId, content, hash, createdAt);
    db.prepare(
      `INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    ).run(parentId, versionId, createdAt, createdAt);
    db.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, state, summary_vector_ids,
         activated_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'active', '[]', ?, ?, ?)`
    ).run(versionId, parentId, createdAt, createdAt, createdAt);
    db.prepare(
      `INSERT INTO sb_memories (
         id, content, entry_id, parent_version_id, claim_status, content_hash, created_at
       ) VALUES (?, ?, ?, ?, 'confirmed', ?, ?)`
    ).run(memoryId, content, entryId, versionId, hash, createdAt);
    db.prepare(
      `INSERT INTO sb_parent_version_claims VALUES (?, ?, 'supports', ?)`
    ).run(versionId, memoryId, createdAt);
    db.prepare(
      `INSERT INTO sb_memory_sources (
         id, memory_id, observation_id, role, relation, created_at
       ) VALUES (?, ?, ?, 'supports', 'supports', ?)`
    ).run(`${memoryId}:source`, memoryId, observationId, createdAt);
  }
});
