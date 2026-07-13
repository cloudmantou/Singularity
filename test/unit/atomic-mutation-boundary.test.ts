import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitAtomicMutationWithProjection,
  mutationActorForSource,
} from "../../src/memory/atomic-mutation";
import { replaceEntryAtomicMemory } from "../../src/memory/atomic";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("Atomic mutation boundary", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    raw.exec(`CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'api',
      content_hash TEXT
    )`);
    await ensureMemoryDataModel(db);
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, content_hash)
       VALUES ('entry-1', 'updated', '[]', 'api', 'hash-1')`
    ).run();
  });

  afterEach(() => raw.close());

  it("keeps a committed knowledge mutation successful when Claim vector projection fails", async () => {
    const committed = vi.fn().mockResolvedValue({ observationId: "obs-1", memoryId: "claim-1" });
    const projected = vi.fn().mockRejectedValue(new Error("queue unavailable"));

    const result = await commitAtomicMutationWithProjection(committed, projected);

    expect(result).toEqual({
      observationId: "obs-1",
      memoryId: "claim-1",
      claimVectorQueued: false,
      warnings: ["claim_vector_enqueue_failed"],
    });
    expect(projected).toHaveBeenCalledWith("claim-1");
  });

  it("persists structured MCP actor provenance instead of treating AI mutations as user evidence", async () => {
    await replaceEntryAtomicMemory(db, {
      entryId: "entry-1",
      content: "updated",
      contentHash: "hash-1",
      source: "mcp",
      actor: mutationActorForSource("mcp"),
      eventType: "update",
      createdAt: 100,
    });

    const observation = raw.prepare(
      `SELECT source_channel, author_type, metadata_json FROM sb_observations LIMIT 1`
    ).get() as { source_channel: string; author_type: string; metadata_json: string };
    expect(observation.source_channel).toBe("mcp");
    expect(observation.author_type).toBe("assistant");
    expect(JSON.parse(observation.metadata_json)).toMatchObject({
      evidence_type: "ai_summary",
      actor_id: "mcp",
    });
    expect(mutationActorForSource("api")).toMatchObject({ authorType: "user" });
    expect(mutationActorForSource("obsidian")).toMatchObject({
      authorType: "user",
      evidenceType: "user_written_note",
    });
    expect(mutationActorForSource("system")).toMatchObject({ authorType: "system" });
  });

  it("does not treat an unknown mutation source as a direct user statement", () => {
    expect(mutationActorForSource("unregistered-connector")).toEqual({
      sourceChannel: "unregistered-connector",
      authorType: "unknown",
      evidenceType: "unknown",
      actorId: "unregistered-connector",
    });
  });
});
