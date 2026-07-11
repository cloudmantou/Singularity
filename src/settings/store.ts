/**
 * Persist model settings in the same SQLite/D1 database as memories.
 * Key-value table keeps the control plane independent of the entries schema.
 */

import {
  activeEmbeddingOf,
  emptyModelSettings,
  isDevLocalProvider,
  mergeModelSettings,
  pendingEmbeddingOf,
  type EmbeddingSettings,
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
  const saved = normalizeStoredModelSettings(settings);
  await prepareStoredModelSettingsSave(db, saved).run();
  cache = saved;
}

export function prepareStoredModelSettingsSave(
  db: D1Database,
  settings: ModelSettings
): D1PreparedStatement {
  const saved = normalizeStoredModelSettings(settings);
  return db
    .prepare(
      `INSERT INTO sb_app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(SETTINGS_KEY, JSON.stringify(saved), saved.updatedAt);
}

export function setStoredModelSettingsCache(settings: ModelSettings | null): void {
  cache = settings;
}

function normalizeStoredModelSettings(settings: ModelSettings): ModelSettings {
  return {
    ...settings,
    updatedAt: settings.updatedAt ?? Date.now(),
  };
}

export async function getEffectiveModelSettings(
  env: SettingsEnvInput & { DB: D1Database }
): Promise<{ effective: ModelSettings; stored: ModelSettings | null }> {
  const stored = await loadStoredModelSettings(env.DB);
  return { effective: mergeModelSettings(stored, env), stored };
}

export type EmbeddingProfileRole = "active" | "pending" | "current";

function overlayEmbeddingProfile<T extends SettingsEnvInput>(
  env: T,
  embedding: EmbeddingSettings
): T {
  const embLocal = isDevLocalProvider(embedding.provider);
  const embOpenAI =
    !embLocal &&
    embedding.provider !== "none" &&
    embedding.provider !== "workers" &&
    Boolean(embedding.baseURL && embedding.apiKey);
  return {
    ...env,
    EMBEDDING_BASE_URL: embLocal
      ? undefined
      : embedding.baseURL || env.EMBEDDING_BASE_URL || undefined,
    EMBEDDING_API_KEY: embLocal
      ? undefined
      : embedding.apiKey || env.EMBEDDING_API_KEY || undefined,
    EMBEDDING_MODEL: embLocal
      ? undefined
      : embedding.model || env.EMBEDDING_MODEL || undefined,
    EMBEDDING_PROVIDER: embLocal
      ? "local-hash-dev"
      : embOpenAI
        ? embedding.provider
        : env.EMBEDDING_PROVIDER,
    EMBEDDING_DIM: String(embedding.dimensions || 384),
    EMBEDDING_SEND_DIMENSIONS:
      embedding.supportsDimensionsParameter === false ? "0" : "1",
    ALLOW_DEV_EMBEDDING: embLocal
      ? env.ALLOW_DEV_EMBEDDING || "true"
      : env.ALLOW_DEV_EMBEDDING,
  } as T;
}

/**
 * ProviderEnv fields derived from control-plane + env for createLLM/createEmbedding.
 */
export async function resolveProviderEnv<T extends SettingsEnvInput & { DB?: D1Database }>(
  env: T,
  embeddingRole: EmbeddingProfileRole = "active"
): Promise<T> {
  if (!env.DB) return env;

  const { effective } = await getEffectiveModelSettings(
    env as SettingsEnvInput & { DB: D1Database }
  );
  const embedding =
    embeddingRole === "pending"
      ? pendingEmbeddingOf(effective)
      : embeddingRole === "current"
        ? effective.embedding
        : activeEmbeddingOf(effective);

  return overlayEmbeddingProfile({
    ...env,
    LLM_BASE_URL: effective.llm.baseURL || undefined,
    LLM_API_KEY: effective.llm.apiKey || undefined,
    LLM_MODEL: effective.llm.model || undefined,
    SELFHOST: env.SELFHOST,
  } as T, embedding);
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
