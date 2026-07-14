import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vectorStillReferenced } from "../../src/memory/vector-references";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";

describe("vectorStillReferenced", () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    raw = new Database(":memory:");
    db = new SqliteD1Database(raw) as unknown as D1Database;
    raw.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        vector_ids TEXT NOT NULL DEFAULT '[]',
        pending_vector_ids TEXT
      );
      CREATE TABLE sb_claim_vectors (
        claim_id TEXT NOT NULL,
        embedding_fingerprint TEXT NOT NULL,
        vector_ids_json TEXT NOT NULL,
        PRIMARY KEY (claim_id, embedding_fingerprint)
      );
    `);
  });

  afterEach(() => raw.close());

  it("protects vectors referenced only by a Claim mapping", async () => {
    raw.prepare(
      `INSERT INTO sb_claim_vectors (claim_id, embedding_fingerprint, vector_ids_json)
       VALUES ('claim-1', 'fp-1', '["claim-vector-1"]')`
    ).run();

    expect(await vectorStillReferenced(db, "claim-vector-1")).toBe(true);
    expect(await vectorStillReferenced(db, "orphan-vector")).toBe(false);
  });
});
