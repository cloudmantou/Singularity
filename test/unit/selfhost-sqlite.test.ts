import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import { SqliteVectorizeIndex } from "../../src/selfhost/sqlite-vectorize";
import { SqliteKVNamespace } from "../../src/selfhost/sqlite-kv";
import { initializeDatabase, type Env } from "../../src/index";

describe("SqliteD1Database", () => {
  let dbPath: string;
  let raw: Database.Database;
  let d1: SqliteD1Database;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sb-d1-${Date.now()}-${Math.random()}.db`);
    raw = new Database(dbPath);
    d1 = new SqliteD1Database(raw);
  });

  afterEach(() => {
    raw.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("supports exec + prepare/bind/first/all/run", async () => {
    await d1.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)`);
    await d1.prepare(`INSERT INTO t (id, n) VALUES (?, ?)`).bind("a", 1).run();
    await d1.prepare(`INSERT INTO t (id, n) VALUES (?, ?)`).bind("b", 2).run();

    const row = await d1.prepare(`SELECT n FROM t WHERE id = ?`).bind("a").first<{ n: number }>();
    expect(row?.n).toBe(1);

    const { results } = await d1.prepare(`SELECT id FROM t ORDER BY n`).all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("supports json_each like the Worker queries", async () => {
    await d1.exec(`CREATE TABLE entries (id TEXT, tags TEXT)`);
    await d1
      .prepare(`INSERT INTO entries (id, tags) VALUES (?, ?)`)
      .bind("1", JSON.stringify(["work", "second-brain"]))
      .run();

    const { results } = await d1
      .prepare(`SELECT DISTINCT value FROM entries, json_each(entries.tags) ORDER BY value`)
      .all<{ value: string }>();
    expect(results.map((r) => r.value)).toEqual(["second-brain", "work"]);
  });

  it("adds durable classification state columns idempotently", async () => {
    const env = { DB: d1 as unknown as D1Database } as Env;
    await initializeDatabase(env);
    await initializeDatabase(env);
    const columns = raw.prepare(`PRAGMA table_info('entries')`).all() as Array<{
      name: string;
      dflt_value: string | number | null;
    }>;
    const byName = new Map(columns.map(column => [column.name, column]));
    expect([...byName.keys()]).toEqual(expect.arrayContaining([
      "classification_confidence",
      "classification_status",
      "classification_error",
      "classification_attempts",
      "classification_next_attempt_at",
      "classification_started_at",
      "classification_version",
      "classified_at",
      "pending_revision_id",
    ]));
    expect(byName.get("classification_status")?.dflt_value).toContain("pending");
    expect(byName.get("classification_attempts")?.dflt_value).toBe("0");
    const indexes = raw.prepare(`PRAGMA index_list('entries')`).all() as Array<{ name: string }>;
    expect(indexes.map(index => index.name)).toContain("idx_entries_classification_queue");
  });

  it("backfills legacy kind-tagged rows into durable successful classification state", async () => {
    raw.exec(`CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'api',
      created_at INTEGER NOT NULL,
      vector_ids TEXT NOT NULL DEFAULT '[]'
    )`);
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("legacy-kind", "Legacy fact", '["work","kind:semantic"]', "api", 1234, "[]");
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("legacy-status-only", "Needs kind", '["status:draft"]', "api", 1235, "[]");
    raw.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "legacy-conflicting-kinds",
      "Conflicting legacy kinds",
      '["kind:semantic","kind:episodic"]',
      "api",
      1236,
      "[]"
    );

    await initializeDatabase({ DB: d1 as unknown as D1Database } as Env);

    expect(raw.prepare(`SELECT * FROM entries WHERE id = ?`).get("legacy-kind")).toMatchObject({
      classification_status: "succeeded",
      classification_confidence: 0.5,
      classification_attempts: 1,
      classified_at: 1234,
    });
    expect(raw.prepare(`SELECT * FROM entries WHERE id = ?`).get("legacy-status-only")).toMatchObject({
      classification_status: "pending",
      classification_confidence: null,
      classification_attempts: 0,
    });
    expect(raw.prepare(`SELECT * FROM entries WHERE id = ?`).get("legacy-conflicting-kinds")).toMatchObject({
      classification_status: "pending",
      classification_confidence: null,
      classification_attempts: 0,
    });
  });

});

describe("SqliteVectorizeIndex", () => {
  let dbPath: string;
  let raw: Database.Database;
  let vec: SqliteVectorizeIndex;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sb-vec-${Date.now()}-${Math.random()}.db`);
    raw = new Database(dbPath);
    vec = new SqliteVectorizeIndex(raw);
  });

  afterEach(() => {
    raw.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("inserts, queries by cosine, getByIds, deleteByIds", async () => {
    await vec.insert([
      { id: "v1", values: [1, 0, 0], metadata: { parentId: "p1" } },
      { id: "v2", values: [0, 1, 0], metadata: { parentId: "p2" } },
      { id: "v3", values: [0.9, 0.1, 0], metadata: { parentId: "p3" } },
    ]);

    const { matches } = await vec.query([1, 0, 0], { topK: 2, returnMetadata: "all" });
    expect(matches).toHaveLength(2);
    expect(matches[0].id).toBe("v1");
    expect(matches[0].score).toBeCloseTo(1, 5);
    expect((matches[0] as any).metadata.parentId).toBe("p1");

    const got = await vec.getByIds(["v2"]);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe("v2");

    await vec.deleteByIds(["v1"]);
    const after = await vec.query([1, 0, 0], { topK: 5 });
    expect(after.matches.find((m) => m.id === "v1")).toBeUndefined();
  });

  it("applies metadata filters before pure vector scoring", async () => {
    await vec.insert([
      { id: "keep-a", values: [1, 0], metadata: { parentId: "keep", source: "api" } },
      { id: "drop-a", values: [0.99, 0.01], metadata: { parentId: "drop", source: "api" } },
      { id: "keep-b", values: [0.8, 0.2], metadata: { parentId: "keep", source: "api" } },
    ]);

    const { matches } = await vec.query([1, 0], {
      topK: 5,
      filter: { parentId: "keep" },
    } as any);

    expect(matches.map((match) => match.id)).toEqual(["keep-a", "keep-b"]);
  });

  it("mirrors vectors into sqlite-vec vec0 tables when the extension is available", async () => {
    await vec.insert([
      { id: "d2-a", values: [1, 0], metadata: { parentId: "p2a" } },
      { id: "d2-b", values: [0, 1], metadata: { parentId: "p2b" } },
      { id: "d3-a", values: [1, 0, 0], metadata: { parentId: "p3a" } },
    ]);

    const details = await vec.describe() as any;
    if (details.config.backend !== "sqlite-vec") {
      expect(details.config.backend).toBe("json-cosine");
      return;
    }

    const rows = raw
      .prepare(`SELECT id, vec_rowid, vector_dim FROM sb_vectors ORDER BY id`)
      .all() as Array<{ id: string; vec_rowid: number | null; vector_dim: number | null }>;
    expect(rows).toEqual([
      expect.objectContaining({ id: "d2-a", vec_rowid: expect.any(Number), vector_dim: 2 }),
      expect.objectContaining({ id: "d2-b", vec_rowid: expect.any(Number), vector_dim: 2 }),
      expect.objectContaining({ id: "d3-a", vec_rowid: expect.any(Number), vector_dim: 3 }),
    ]);
    expect(
      raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'sb_vectors_vec_2'`).get()
    ).toBeTruthy();
    expect(
      raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'sb_vectors_vec_3'`).get()
    ).toBeTruthy();

    const { matches } = await vec.query([1, 0], { topK: 2 });
    expect(matches.map((match) => match.id)).toEqual(["d2-a", "d2-b"]);
  });

  it("falls back to JSON cosine when a dimension is not fully mirrored into vec0", async () => {
    await vec.insert([
      { id: "indexed", values: [0, 1], metadata: { parentId: "indexed" } },
      { id: "json-only", values: [1, 0], metadata: { parentId: "json-only" } },
    ]);
    const vecTable = raw.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sb_vectors_vec_2'`
    ).get();
    if (vecTable) {
      raw
        .prepare(`DELETE FROM sb_vectors_vec_2 WHERE rowid = (SELECT vec_rowid FROM sb_vectors WHERE id = ?)`)
        .run("json-only");
    } else {
      raw
        .prepare(`UPDATE sb_vectors SET vec_rowid = NULL WHERE id = ?`)
        .run("json-only");
    }

    const { matches } = await vec.query([1, 0], { topK: 1 });
    expect(matches[0].id).toBe("json-only");
  });

  it("keeps queryText out of vector KNN and exposes lexical recall separately", async () => {
    const ftsTable = raw.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = 'sb_vector_fts'`
    ).get() as { name: string; sql: string } | undefined;
    if (!ftsTable) {
      expect(ftsTable).toBeUndefined();
      return;
    }
    expect(ftsTable.sql).toMatch(/trigram|unicode61/i);

    await vec.insert([
      {
        id: "semantic-only",
        values: [1, 0],
        metadata: { parentId: "semantic", content: "unrelated runtime note" },
      },
      {
        id: "lexical-hit",
        values: [0, 1],
        metadata: { parentId: "lexical", content: "sqlite vector profile rebuild" },
      },
    ]);

    const { matches } = await vec.query([1, 0], {
      topK: 1,
      returnMetadata: "all",
      queryText: ftsTable.sql.includes("trigram") ? "lite vec" : "sqlite vector",
    } as any);
    const lexicalIds = vec.queryLexical(
      ftsTable.sql.includes("trigram") ? "lite vec" : "sqlite vector",
      10
    );

    expect(matches[0].id).toBe("semantic-only");
    expect(matches.map((match) => match.id)).not.toContain("lexical-hit");
    expect(lexicalIds).toContain("lexical-hit");
  });
});

describe("SqliteKVNamespace", () => {
  let dbPath: string;
  let raw: Database.Database;
  let kv: SqliteKVNamespace;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sb-kv-${Date.now()}-${Math.random()}.db`);
    raw = new Database(dbPath);
    kv = new SqliteKVNamespace(raw);
  });

  afterEach(() => {
    raw.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("put/get/delete/list", async () => {
    await kv.put("a", "1");
    await kv.put("ab", "2");
    expect(await kv.get("a")).toBe("1");
    const listed = await kv.list({ prefix: "a" });
    expect(listed.keys.map((k) => k.name).sort()).toEqual(["a", "ab"]);
    const firstPage = await kv.list({ prefix: "a", limit: 1 });
    expect(firstPage).toMatchObject({
      keys: [{ name: "a" }],
      list_complete: false,
      cursor: "a",
    });
    const secondPage = await kv.list({
      prefix: "a",
      limit: 1,
      cursor: firstPage.cursor,
    });
    expect(secondPage).toMatchObject({
      keys: [{ name: "ab" }],
      list_complete: true,
    });
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  it("expires inactive OAuth clients after 30 days and renews active clients", async () => {
    let now = 1_700_000_000_000;
    kv = new SqliteKVNamespace(raw, { now: () => now });
    await kv.put(
      "client:test",
      JSON.stringify({ clientId: "test" }),
      { expirationTtl: 2_160 * 60 * 60 }
    );
    const initial = raw
      .prepare("SELECT expires_at FROM sb_kv WHERE key = ?")
      .get("client:test") as { expires_at: number };
    expect(initial.expires_at).toBe(now + 30 * 24 * 60 * 60 * 1000);

    now += 29 * 24 * 60 * 60 * 1000;
    expect(await kv.get("client:test", { type: "json" })).toEqual({ clientId: "test" });
    const renewed = raw
      .prepare("SELECT expires_at FROM sb_kv WHERE key = ?")
      .get("client:test") as { expires_at: number };
    expect(renewed.expires_at).toBe(now + 30 * 24 * 60 * 60 * 1000);

    now += 31 * 24 * 60 * 60 * 1000;
    expect(await kv.get("client:test")).toBeNull();
  });

  it("assigns the idle expiry to legacy OAuth clients", () => {
    raw.exec(`
      INSERT INTO sb_kv (key, value, expires_at)
      VALUES ('client:legacy', '{"clientId":"legacy"}', NULL)
    `);
    const now = 1_800_000_000_000;
    kv = new SqliteKVNamespace(raw, { now: () => now });
    const migrated = raw
      .prepare("SELECT expires_at FROM sb_kv WHERE key = ?")
      .get("client:legacy") as { expires_at: number };
    expect(migrated.expires_at).toBe(now + 30 * 24 * 60 * 60 * 1000);
  });
});
