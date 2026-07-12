import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteD1Database } from "../../src/selfhost/sqlite-d1";
import {
  applyModelSettingsPatch,
  emptyModelSettings,
  embeddingConfigSignatureOf,
  embeddingFingerprintOf,
  maskSecret,
  mergeModelSettings,
  normalizeApiKey,
  toPublicModelSettings,
} from "../../src/settings/model-settings";
import {
  loadStoredModelSettings,
  resetSettingsCache,
  resolveProviderEnv,
  saveStoredModelSettings,
  getEffectiveModelSettings,
} from "../../src/settings/store";

describe("model-settings helpers", () => {
  it("masks secrets", () => {
    expect(maskSecret("sk-abcdefghij")).toMatch(/^sk-•+ghij$/);
    expect(maskSecret("short")).toBe("••••••••");
  });

  it("normalizes pasted API keys", () => {
    expect(normalizeApiKey("  Bearer sk-abc  ")).toBe("sk-abc");
    expect(normalizeApiKey('"sk-quoted"')).toBe("sk-quoted");
    expect(normalizeApiKey("sk-plain\n")).toBe("sk-plain");
    // Fullwidth Latin → halfwidth (common when copying from CN docs)
    expect(normalizeApiKey("ｓｋ－ａｂｃ")).toBe("sk-abc");
    // Fullwidth parens must not remain (ByteString crash)
    expect(() => normalizeApiKey("sk-abc（说明）")).toThrow(/非法字符|码点/);
    expect(() => normalizeApiKey("x".repeat(600))).toThrow(/过长/);
  });

  it("minimax CN preset uses minimaxi.com", async () => {
    const { LLM_PRESETS } = await import("../../src/settings/model-settings");
    const cn = LLM_PRESETS.find((p) => p.id === "minimax");
    const io = LLM_PRESETS.find((p) => p.id === "minimax-io");
    expect(cn?.baseURL).toContain("minimaxi.com");
    expect(io?.baseURL).toContain("minimax.io");
  });

  it("merge prefers stored over env", () => {
    const stored = emptyModelSettings();
    stored.llm = {
      provider: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "stored-key",
      model: "deepseek-v4-flash",
    };
    const merged = mergeModelSettings(stored, {
      LLM_BASE_URL: "https://env.example/v1",
      LLM_API_KEY: "env-key",
      LLM_MODEL: "env-model",
    });
    expect(merged.llm.apiKey).toBe("stored-key");
    expect(merged.llm.baseURL).toContain("deepseek");
  });

  it("self-host does not auto-enable local hash without ALLOW_DEV_EMBEDDING", () => {
    const merged = mergeModelSettings(null, { SELFHOST: "1" });
    expect(merged.embedding.provider).toBe("none");
  });

  it("patch keeps previous apiKey when masked", () => {
    const prev = emptyModelSettings();
    prev.llm.apiKey = "sk-real-secret-key";
    prev.llm.baseURL = "https://api.deepseek.com/v1";
    prev.llm.model = "deepseek-chat";
    prev.llm.provider = "deepseek";

    const next = applyModelSettingsPatch(prev, {
      llm: { apiKey: "sk-••••key", model: "deepseek-reasoner" },
    });
    expect(next.llm.apiKey).toBe("sk-real-secret-key");
    expect(next.llm.model).toBe("deepseek-reasoner");
  });

  it("public view never returns stored API keys", () => {
    const effective = emptyModelSettings();
    effective.llm = {
      provider: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-super-secret-value",
      model: "deepseek-chat",
    };
    effective.embedding.apiKey = "embedding-super-secret";
    const pub = toPublicModelSettings(effective, {
      hasStored: true,
      hasEnvLlm: false,
      hasEnvEmbed: false,
    });
    expect(pub.llm.apiKey).toBe("");
    expect(pub.llm.hasApiKey).toBe(true);
    expect(pub.embedding.apiKey).toBe("");
    expect(pub.embedding.hasApiKey).toBe(true);
    expect(pub.presets.llm.length).toBeGreaterThan(0);
  });

  it("embedding presets cover domestic providers like chat", async () => {
    const { EMBEDDING_PRESETS, LLM_PRESETS } = await import(
      "../../src/settings/model-settings"
    );
    const embIds = new Set(EMBEDDING_PRESETS.map((p) => p.id));
    for (const id of ["siliconflow", "zhipu", "minimax", "minimax-io", "openai", "mimo", "deepseek"]) {
      expect(embIds.has(id)).toBe(true);
    }
    expect(LLM_PRESETS.some((p) => p.id === "minimax")).toBe(true);
    expect(maskSecret("sk-super-secret-value")).not.toContain("super-secret");
  });

  it("uses a short embedding fingerprint suitable for Vectorize string metadata indexes", () => {
    const embedding = {
      provider: "custom",
      baseURL: "https://very-long-gateway.example.com/openai/compatible/v1/tenant/project/environment",
      apiKey: "secret",
      model: "vendor/very-long-multilingual-embedding-model-name-that-would-exceed-sixty-four-bytes",
      dimensions: 1536,
      supportsDimensionsParameter: true,
    };

    const fingerprint = embeddingFingerprintOf(embedding);

    expect(fingerprint).toMatch(/^ep2_[0-9a-f]{32}$/);
    expect(new TextEncoder().encode(fingerprint).byteLength).toBeLessThanOrEqual(64);
    expect(embeddingConfigSignatureOf(embedding)).toContain("very-long-gateway");
    expect(fingerprint).not.toContain("very-long-gateway");
  });
});

describe("settings store (sqlite)", () => {
  let dbPath: string;
  let raw: Database.Database;
  let d1: SqliteD1Database;

  beforeEach(() => {
    resetSettingsCache();
    dbPath = path.join(os.tmpdir(), `sb-settings-${Date.now()}.db`);
    raw = new Database(dbPath);
    d1 = new SqliteD1Database(raw);
  });

  afterEach(() => {
    resetSettingsCache();
    raw.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  it("saves and loads model settings", async () => {
    const db = d1 as unknown as D1Database;
    const settings = emptyModelSettings();
    settings.llm = {
      provider: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      model: "deepseek-chat",
    };
    await saveStoredModelSettings(db, settings);
    resetSettingsCache();
    const loaded = await loadStoredModelSettings(db);
    expect(loaded?.llm.model).toBe("deepseek-chat");
    expect(loaded?.llm.apiKey).toBe("sk-test");
  });

  it("getEffective merges store + env", async () => {
    const db = d1 as unknown as D1Database;
    const settings = emptyModelSettings();
    settings.llm = {
      provider: "custom",
      baseURL: "https://llm.example/v1",
      apiKey: "k1",
      model: "m1",
    };
    await saveStoredModelSettings(db, settings);

    const { effective } = await getEffectiveModelSettings({
      DB: db,
      LLM_BASE_URL: "https://env/v1",
      LLM_API_KEY: "env",
    });
    expect(effective.llm.baseURL).toBe("https://llm.example/v1");
  });

  it("resolves active and pending embedding profiles separately", async () => {
    const db = d1 as unknown as D1Database;
    const settings = emptyModelSettings();
    settings.activeEmbedding = {
      provider: "custom",
      baseURL: "https://embed-old.example/v1",
      apiKey: "old-key",
      model: "old-embedding",
      dimensions: 384,
      supportsDimensionsParameter: true,
    };
    settings.pendingEmbedding = {
      provider: "custom",
      baseURL: "https://embed-new.example/v1",
      apiKey: "new-key",
      model: "new-embedding",
      dimensions: 768,
      supportsDimensionsParameter: false,
    };
    settings.embedding = { ...settings.pendingEmbedding };
    settings.embeddingFingerprint = embeddingFingerprintOf(settings.activeEmbedding);
    settings.pendingEmbeddingFingerprint = embeddingFingerprintOf(settings.pendingEmbedding);
    await saveStoredModelSettings(db, settings);

    const activeEnv = await resolveProviderEnv({ DB: db }, "active") as any;
    const pendingEnv = await resolveProviderEnv({ DB: db }, "pending") as any;

    expect(activeEnv.EMBEDDING_BASE_URL).toBe("https://embed-old.example/v1");
    expect(activeEnv.EMBEDDING_API_KEY).toBe("old-key");
    expect(activeEnv.EMBEDDING_MODEL).toBe("old-embedding");
    expect(activeEnv.EMBEDDING_DIM).toBe("384");
    expect(activeEnv.EMBEDDING_SEND_DIMENSIONS).toBe("1");

    expect(pendingEnv.EMBEDDING_BASE_URL).toBe("https://embed-new.example/v1");
    expect(pendingEnv.EMBEDDING_API_KEY).toBe("new-key");
    expect(pendingEnv.EMBEDDING_MODEL).toBe("new-embedding");
    expect(pendingEnv.EMBEDDING_DIM).toBe("768");
    expect(pendingEnv.EMBEDDING_SEND_DIMENSIONS).toBe("0");
  });
});
