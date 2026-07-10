/**
 * Build a Worker-compatible Env from process.env + local SQLite.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Env } from "../index";
import { SqliteD1Database } from "./sqlite-d1";
import { SqliteKVNamespace } from "./sqlite-kv";
import { SqliteVectorizeIndex } from "./sqlite-vectorize";

export interface SelfhostOptions {
  databasePath?: string;
  authToken?: string;
}

export function resolveDatabasePath(explicit?: string): string {
  return (
    explicit ||
    process.env.DATABASE_PATH ||
    path.join(process.cwd(), "data", "memory.db")
  );
}

export function openSqlite(databasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function createSelfhostEnv(options: SelfhostOptions = {}): {
  env: Env;
  db: Database.Database;
  databasePath: string;
} {
  const authToken = options.authToken || process.env.AUTH_TOKEN;
  if (!authToken?.trim()) {
    throw new Error("AUTH_TOKEN is required (set in .env or environment)");
  }

  const databasePath = resolveDatabasePath(options.databasePath);
  const raw = openSqlite(databasePath);
  const d1 = new SqliteD1Database(raw);
  const vectorize = new SqliteVectorizeIndex(raw);
  const kv = new SqliteKVNamespace(raw);

  // Stub Workers AI — createLLM/createEmbedding use OpenAI-compatible APIs when configured.
  const aiStub = {
    run: async () => {
      throw new Error(
        "Workers AI is not available on self-host. Set LLM_BASE_URL + LLM_API_KEY (and embedding env vars)."
      );
    },
  } as unknown as Ai;

  const env: Env = {
    DB: d1 as unknown as D1Database,
    VECTORIZE: vectorize as unknown as VectorizeIndex,
    OAUTH_KV: kv as unknown as KVNamespace,
    AI: aiStub,
    AUTH_TOKEN: authToken.trim(),
    SELFHOST: "1",
    ALLOW_DEV_EMBEDDING: process.env.ALLOW_DEV_EMBEDDING,
    VECTORIZE_GRACE_MS: process.env.VECTORIZE_GRACE_MS,
    PUBLIC_URL: process.env.PUBLIC_URL || process.env.PUBLIC_BASE_URL,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
    LLM_EXTRA_BODY: process.env.LLM_EXTRA_BODY,
    EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
    EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    EMBEDDING_DIM: process.env.EMBEDDING_DIM,
  };

  return { env, db: raw, databasePath };
}

export function createExecutionContext(): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      promise.catch((err) => console.error("[waitUntil]", err));
    },
    passThroughOnException() {
      /* no-op outside Workers */
    },
    props: {},
  } as ExecutionContext;
}
