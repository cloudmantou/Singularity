/**
 * Persist model settings in the same SQLite/D1 database as memories.
 * Key-value table keeps the control plane independent of the entries schema.
 */

import {
  emptyModelSettings,
  isDevLocalProvider,
  mergeModelSettings,
  type ModelSettings,
  type SettingsEnvInput,
} from "./model-settings";

const SETTINGS_KEY = "model_settings";

let tableReady = false;
let cache: ModelSettings | null | undefined = undefined; // undefined = not loaded

export async function ensureSettingsTable(db: D1Database): Promise<void> {
  if (tableReady) return;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sb_app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  tableReady = true;
}

/** Reset module state (tests). */
export function resetSettingsCache(): void {
  tableReady = false;
  cache = undefined;
}

export async function loadStoredModelSettings(
  db: D1Database
): Promise<ModelSettings | null> {
  await ensureSettingsTable(db);
  if (cache !== undefined) return cache;

  const row = await db
    .prepare(`SELECT value FROM sb_app_settings WHERE key = ?`)
    .bind(SETTINGS_KEY)
    .first<{ value: string }>();

  if (!row?.value) {
    cache = null;
    return null;
  }
  try {
    cache = JSON.parse(row.value) as ModelSettings;
    return cache;
  } catch {
    cache = null;
    return null;
  }
}

export async function saveStoredModelSettings(
  db: D1Database,
  settings: ModelSettings
): Promise<void> {
  await ensureSettingsTable(db);
  const now = settings.updatedAt ?? Date.now();
  settings.updatedAt = now;
  await db
    .prepare(
      `INSERT INTO sb_app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(SETTINGS_KEY, JSON.stringify(settings), now)
    .run();
  cache = settings;
}

export async function getEffectiveModelSettings(
  env: SettingsEnvInput & { DB: D1Database }
): Promise<{ effective: ModelSettings; stored: ModelSettings | null }> {
  const stored = await loadStoredModelSettings(env.DB);
  return { effective: mergeModelSettings(stored, env), stored };
}

/**
 * ProviderEnv fields derived from control-plane + env for createLLM/createEmbedding.
 */
export async function resolveProviderEnv<T extends SettingsEnvInput & { DB?: D1Database }>(
  env: T
): Promise<T> {
  if (!env.DB) return env;

  const { effective } = await getEffectiveModelSettings(
    env as SettingsEnvInput & { DB: D1Database }
  );

  const embLocal = isDevLocalProvider(effective.embedding.provider);
  const embOpenAI =
    !embLocal &&
    effective.embedding.provider !== "none" &&
    effective.embedding.provider !== "workers" &&
    Boolean(effective.embedding.baseURL && effective.embedding.apiKey);

  return {
    ...env,
    LLM_BASE_URL: effective.llm.baseURL || undefined,
    LLM_API_KEY: effective.llm.apiKey || undefined,
    LLM_MODEL: effective.llm.model || undefined,
    EMBEDDING_BASE_URL: embLocal
      ? undefined
      : effective.embedding.baseURL || env.EMBEDDING_BASE_URL || undefined,
    EMBEDDING_API_KEY: embLocal
      ? undefined
      : effective.embedding.apiKey || env.EMBEDDING_API_KEY || undefined,
    EMBEDDING_MODEL: embLocal
      ? undefined
      : effective.embedding.model || env.EMBEDDING_MODEL || undefined,
    EMBEDDING_PROVIDER: embLocal
      ? "local-hash-dev"
      : embOpenAI
        ? effective.embedding.provider
        : env.EMBEDDING_PROVIDER,
    EMBEDDING_DIM: String(effective.embedding.dimensions || 384),
    EMBEDDING_SEND_DIMENSIONS:
      effective.embedding.supportsDimensionsParameter === false ? "0" : "1",
    ALLOW_DEV_EMBEDDING: embLocal
      ? env.ALLOW_DEV_EMBEDDING || "true"
      : env.ALLOW_DEV_EMBEDDING,
    SELFHOST: env.SELFHOST,
  } as T;
}

/** Build a one-off env overlay from a candidate config without writing to DB. */
export function overlayProviderEnvFromSettings<T extends SettingsEnvInput>(
  env: T,
  candidate: ModelSettings
): T {
  const embLocal = isDevLocalProvider(candidate.embedding.provider);
  return {
    ...env,
    LLM_BASE_URL: candidate.llm.baseURL || undefined,
    LLM_API_KEY: candidate.llm.apiKey || undefined,
    LLM_MODEL: candidate.llm.model || undefined,
    EMBEDDING_BASE_URL: embLocal ? undefined : candidate.embedding.baseURL || undefined,
    EMBEDDING_API_KEY: embLocal ? undefined : candidate.embedding.apiKey || undefined,
    EMBEDDING_MODEL: embLocal ? undefined : candidate.embedding.model || undefined,
    EMBEDDING_PROVIDER: embLocal ? "local-hash-dev" : candidate.embedding.provider,
    EMBEDDING_DIM: String(candidate.embedding.dimensions || 384),
    EMBEDDING_SEND_DIMENSIONS:
      candidate.embedding.supportsDimensionsParameter === false ? "0" : "1",
    ALLOW_DEV_EMBEDDING: embLocal ? "true" : env.ALLOW_DEV_EMBEDDING,
  };
}
