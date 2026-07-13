import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareParentVersionActivation } from "../../src/memory/evidence-contract";
import { ensureMemoryDataModel } from "../../src/memory/schema";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("Parent version temporal lifecycle", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(async () => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    await ensureMemoryDataModel(db);
    raw.prepare(
      `INSERT INTO sb_parent_units (parent_id, active_version_id, created_at, updated_at)
       VALUES ('parent-1', 'version-1', 100, 100)`
    ).run();
    raw.prepare(
      `INSERT INTO sb_parent_versions (
         version_id, parent_id, version_number, state, summary_vector_ids,
         created_at, updated_at
       ) VALUES
         ('version-1', 'parent-1', 1, 'active', '[]', 100, 100),
         ('version-2', 'parent-1', 2, 'building', '[]', 200, 200)`
    ).run();
  });

  afterEach(() => raw.close());

  it("atomically closes the legacy active window and opens the new one", async () => {
    const results = await db.batch(prepareParentVersionActivation(db, {
      parentId: "parent-1",
      versionId: "version-2",
      updatedAt: 200,
    }));

    expect(results.map((result) => result.meta.changes)).toEqual([1, 1, 1]);
    expect(raw.prepare(
      `SELECT version_id, state, activated_at, superseded_at
       FROM sb_parent_versions ORDER BY version_number`
    ).all()).toEqual([
      {
        version_id: "version-1",
        state: "superseded",
        activated_at: 100,
        superseded_at: 200,
      },
      {
        version_id: "version-2",
        state: "active",
        activated_at: 200,
        superseded_at: null,
      },
    ]);
    expect(raw.prepare(
      `SELECT active_version_id FROM sb_parent_units WHERE parent_id = 'parent-1'`
    ).get()).toEqual({ active_version_id: "version-2" });
  });
});
