import { describe, it, expect, beforeEach, vi } from "vitest";
import { deprecateEntry } from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

describe("deprecateEntry()", () => {
  let db: D1Mock;
  let env: Env;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deleteByIdsMock: any;

  beforeEach(() => {
    db = makeTestDb();
    deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });
  });

  it("returns true, keeps D1 row, updates tags and vector_ids, calls Vectorize deleteByIds", async () => {
    db.entries.push({
      id: "entry-1",
      content: "Some important work content",
      tags: JSON.stringify(["work", "status:canonical"]),
      source: "api",
      created_at: Date.now(),
      vector_ids: JSON.stringify(["v1", "v2"]),
    });
    db.memories.push({
      id: "atomic-1",
      content: "Some important work content",
      entry_id: "entry-1",
      content_hash: "hash",
      valid_to: null,
      invalid_at: null,
      created_at: Date.now(),
    });
    db.entityRelations.push({
      id: "fact-1",
      memory_id: "atomic-1",
      valid_to: null,
      invalid_at: null,
    });

    const result = await deprecateEntry("entry-1", env);

    expect(result).toBe(true);

    // Row must still exist
    const row = db.entries.find((e: any) => e.id === "entry-1");
    expect(row).toBeDefined();

    // Tags: must contain status:deprecated, must NOT contain status:canonical
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("status:deprecated");
    expect(tags).not.toContain("status:canonical");

    // vector_ids must be cleared
    expect(row.vector_ids).toBe("[]");

    // Vectorize deleteByIds must have been called with the original vector IDs
    expect(deleteByIdsMock).toHaveBeenCalledWith(["v1", "v2"]);
    expect(db.memories[0].invalid_at).toEqual(expect.any(Number));
    expect(db.memories[0].expired_at ?? null).toBeNull();
    expect(db.memories[0].valid_to).toBe(db.memories[0].invalid_at);
    expect(db.entityRelations[0].invalid_at).toBe(db.memories[0].invalid_at);
    expect(db.entityRelations[0].expired_at ?? null).toBeNull();
    expect(db.entityRelations[0].valid_to).toBe(db.memories[0].invalid_at);
    expect(db.revisions).toContainEqual(
      expect.objectContaining({
        memory_id: "entry-1",
        event_type: "DEPRECATE",
        old_content: "Some important work content",
        new_content: "Some important work content",
      })
    );
  });

  it("returns false for a missing id", async () => {
    const result = await deprecateEntry("missing-id", env);
    expect(result).toBe(false);
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });
});
