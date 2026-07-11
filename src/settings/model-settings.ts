/**
 * Control-plane model configuration: presets, merge rules, secret masking.
 * Stored settings override process/env bindings at runtime (no restart).
 */

export interface LlmSettings {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface EmbeddingSettings {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  dimensions: number;
  /** When true, send `dimensions` in embeddings API body (OpenAI / some Qwen). */
  supportsDimensionsParameter?: boolean;
}

export interface ModelSettings {
  llm: LlmSettings;
  /** Desired/current form value. During rebuild this is the pending embedding config. */
  embedding: EmbeddingSettings;
  updatedAt?: number;
  /** Embedding config used by the active vector_ids generation. */
  activeEmbedding?: EmbeddingSettings;
  /** Embedding config used to build pending_vector_ids. */
  pendingEmbedding?: EmbeddingSettings;
  /** Fingerprint of vectors currently in the index. */
  embeddingFingerprint?: string;
  /** Fingerprint of saved config waiting for full reindex. */
  pendingEmbeddingFingerprint?: string;
}

export interface PublicModelSettings {
  llm: Omit<LlmSettings, "apiKey"> & {
    apiKey: string;
    hasApiKey: boolean;
  };
  embedding: Omit<EmbeddingSettings, "apiKey"> & {
    apiKey: string;
    hasApiKey: boolean;
    supportsDimensionsParameter?: boolean;
  };
  updatedAt?: number;
  activeEmbedding?: Omit<EmbeddingSettings, "apiKey"> & {
    apiKey: string;
    hasApiKey: boolean;
    supportsDimensionsParameter?: boolean;
  };
  pendingEmbedding?: Omit<EmbeddingSettings, "apiKey"> & {
    apiKey: string;
    hasApiKey: boolean;
    supportsDimensionsParameter?: boolean;
  };
  embeddingFingerprint?: string;
  pendingEmbeddingFingerprint?: string;
  status: {
    llm: "openai-compatible" | "workers-ai" | "unconfigured";
    embedding: "openai-compatible" | "local-dev" | "workers-ai" | "unconfigured";
    source: "control-plane" | "env" | "mixed" | "default";
    reindexRequired: boolean;
    devEmbeddingWarning: boolean;
  };
  presets: {
    llm: ProviderPresetPublic[];
    embedding: EmbeddingPresetPublic[];
  };
}

export interface ProviderPresetPublic {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  badge: string;
  hint?: string;
  models?: string[];
}

export interface EmbeddingPresetPublic {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  dimensions: number;
  badge: string;
  hint?: string;
  models?: string[];
  supportsDimensionsParameter: boolean;
  fixedDimensions?: number;
  allowedDimensions?: number[];
}

export const LLM_PRESETS: readonly ProviderPresetPublic[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    badge: "DS",
    hint: "推荐 · 分类/摘要",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "minimax",
    label: "MiniMax 国内",
    baseURL: "https://api.minimaxi.com/v1",
    model: "MiniMax-M3",
    badge: "MM",
    hint: "国内 platform.minimaxi.com 密钥",
    models: [
      "MiniMax-M3",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-Text-01",
    ],
  },
  {
    id: "minimax-io",
    label: "MiniMax 国际",
    baseURL: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    badge: "IO",
    hint: "国际 platform.minimax.io 密钥",
    models: [
      "MiniMax-M3",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-Text-01",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    badge: "OA",
    hint: "官方 API",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseURL: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    badge: "硅",
    hint: "国内聚合",
    models: [
      "deepseek-ai/DeepSeek-V3",
      "Qwen/Qwen2.5-7B-Instruct",
      "THUDM/glm-4-9b-chat",
    ],
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    badge: "智",
    hint: "OpenAI 兼容",
    models: ["glm-4-flash", "glm-4-air", "glm-4"],
  },
  {
    id: "kimi",
    label: "Kimi",
    baseURL: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    badge: "K",
    hint: "通用推荐 k2.6",
    models: ["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    badge: "OR",
    hint: "统一网关",
    models: ["openai/gpt-4o-mini", "deepseek/deepseek-chat", "anthropic/claude-3.5-sonnet"],
  },
  {
    id: "mimo",
    label: "MiMo / 自定义网关",
    baseURL: "",
    model: "",
    badge: "M",
    hint: "需填高级配置",
    models: [],
  },
  {
    id: "custom",
    label: "自定义配置",
    baseURL: "",
    model: "",
    badge: "＋",
    hint: "任意 OpenAI 兼容",
    models: [],
  },
];

/**
 * Embedding presets — aligned with domestic chat providers where possible.
 * Note: pure chat APIs (e.g. DeepSeek) often have no /embeddings; those cards
 * open advanced config so users can point at SiliconFlow / TEI / gateways.
 */
export const EMBEDDING_PRESETS: readonly EmbeddingPresetPublic[] = [
  {
    id: "siliconflow",
    label: "硅基流动",
    baseURL: "https://api.siliconflow.cn/v1",
    model: "BAAI/bge-large-zh-v1.5",
    dimensions: 1024,
    badge: "硅",
    hint: "推荐国内 · BGE 固定 1024",
    models: ["BAAI/bge-large-zh-v1.5", "BAAI/bge-m3", "BAAI/bge-small-zh-v1.5"],
    supportsDimensionsParameter: false,
    fixedDimensions: 1024,
  },
  {
    id: "zhipu",
    label: "智谱 Embedding",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "embedding-3",
    dimensions: 1024,
    badge: "智",
    hint: "与 GLM 同 Key",
    models: ["embedding-3", "embedding-2"],
    supportsDimensionsParameter: true,
    allowedDimensions: [256, 512, 1024, 2048],
  },
  {
    id: "minimax",
    label: "MiniMax 国内",
    baseURL: "https://api.minimaxi.com/v1",
    model: "embo-01",
    dimensions: 1536,
    badge: "MM",
    hint: "embo-01 原生向量 · 固定 1536",
    models: ["embo-01"],
    supportsDimensionsParameter: false,
    fixedDimensions: 1536,
  },
  {
    id: "minimax-io",
    label: "MiniMax 国际",
    baseURL: "https://api.minimax.io/v1",
    model: "embo-01",
    dimensions: 1536,
    badge: "IO",
    hint: "embo-01 原生向量 · 固定 1536",
    models: ["embo-01"],
    supportsDimensionsParameter: false,
    fixedDimensions: 1536,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimensions: 384,
    badge: "OA",
    hint: "可调维度 · 常用 384",
    models: ["text-embedding-3-small", "text-embedding-3-large"],
    supportsDimensionsParameter: true,
    allowedDimensions: [384, 512, 768, 1536],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    model: "openai/text-embedding-3-small",
    dimensions: 1536,
    badge: "OR",
    hint: "统一网关向量",
    models: ["openai/text-embedding-3-small", "openai/text-embedding-3-large"],
    supportsDimensionsParameter: true,
    allowedDimensions: [384, 512, 768, 1536],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "",
    model: "",
    dimensions: 384,
    badge: "DS",
    hint: "无官方向量 · 请用硅基/自定义",
    models: [],
    supportsDimensionsParameter: true,
  },
  {
    id: "mimo",
    label: "MiMo / 自定义网关",
    baseURL: "",
    model: "",
    dimensions: 384,
    badge: "M",
    hint: "OpenAI 兼容 · 填高级配置",
    models: [],
    supportsDimensionsParameter: true,
  },
  {
    id: "custom",
    label: "自定义配置",
    baseURL: "",
    model: "",
    dimensions: 384,
    badge: "＋",
    hint: "自建 TEI / 任意兼容",
    models: [],
    supportsDimensionsParameter: true,
  },
  {
    id: "local-hash-dev",
    label: "本地哈希 (仅开发)",
    baseURL: "",
    model: "local-hash",
    dimensions: 384,
    badge: "⚠",
    hint: "需 ALLOW_DEV_EMBEDDING",
    models: [],
    supportsDimensionsParameter: false,
    fixedDimensions: 384,
  },
];

export function emptyModelSettings(): ModelSettings {
  return {
    llm: { provider: "none", baseURL: "", apiKey: "", model: "" },
    embedding: {
      provider: "none",
      baseURL: "",
      apiKey: "",
      model: "",
      dimensions: 384,
      supportsDimensionsParameter: true,
    },
  };
}

export function embeddingFingerprintOf(emb: EmbeddingSettings): string {
  const base = (emb.baseURL || "").replace(/\/+$/, "").toLowerCase();
  return [
    emb.provider || "none",
    emb.model || "",
    String(emb.dimensions || 0),
    base,
  ].join("|");
}

export function cloneEmbeddingSettings(embedding: EmbeddingSettings): EmbeddingSettings {
  return { ...embedding };
}

export function activeEmbeddingOf(settings: ModelSettings): EmbeddingSettings {
  return cloneEmbeddingSettings(settings.activeEmbedding ?? settings.embedding);
}

export function pendingEmbeddingOf(settings: ModelSettings): EmbeddingSettings {
  return cloneEmbeddingSettings(settings.pendingEmbedding ?? settings.embedding);
}

function publicEmbeddingProfile(
  embedding: EmbeddingSettings | undefined
): PublicModelSettings["activeEmbedding"] | undefined {
  if (!embedding) return undefined;
  return {
    provider: embedding.provider,
    baseURL: embedding.baseURL,
    model: embedding.model,
    dimensions: embedding.dimensions,
    supportsDimensionsParameter: embedding.supportsDimensionsParameter,
    apiKey: "",
    hasApiKey: Boolean(embedding.apiKey),
  };
}

export function isDevLocalProvider(provider: string | undefined): boolean {
  const p = (provider || "").toLowerCase();
  return p === "local" || p === "local-hash" || p === "local-hash-dev";
}

export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return "";
  if (secret.length <= 8) return "••••••••";
  return `${secret.slice(0, 3)}••••${secret.slice(-4)}`;
}

export function isMaskedSecret(value: string | undefined): boolean {
  return Boolean(value && value.includes("••"));
}

/**
 * Clean a pasted API key so it is safe for HTTP Authorization headers.
 *
 * Common paste failures (esp. from Chinese docs / IM):
 * - leading `Bearer `
 * - surrounding quotes
 * - fullwidth Latin / punctuation (U+FF01–U+FF5E) → halfwidth ASCII
 * - fullwidth space U+3000, zero-width / BOM chars
 * - newlines / tabs
 *
 * HTTP headers must be ByteString (code points ≤ 255). Non-ASCII leftover
 * characters break fetch with "Cannot convert argument to a ByteString".
 */
export function normalizeApiKey(raw: string): string {
  let k = String(raw ?? "");

  // Normalize newlines early
  k = k.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Fullwidth ASCII (！＂＃…～) → halfwidth (!"#…~)
  k = k.replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  // Fullwidth space → normal space
  k = k.replace(/\u3000/g, " ");

  // Zero-width / BOM / soft hyphen / word joiner
  k = k.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "");

  k = k.trim().replace(/^Bearer\s+/i, "").trim();

  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'")) ||
    (k.startsWith("`") && k.endsWith("`"))
  ) {
    k = k.slice(1, -1).trim();
  }

  // Drop all whitespace (keys never contain spaces once pasted cleanly)
  k = k.replace(/\s+/g, "");

  // Headers cannot carry code points > 255
  if (/[^\x00-\xFF]/.test(k)) {
    const bad = [...k].find((c) => c.charCodeAt(0) > 255);
    const code = bad ? bad.charCodeAt(0) : 0;
    throw new Error(
      `API Key 含非法字符（码点 ${code}，如中文/全角符号）。请从开放平台「接口密钥」页面重新复制纯英文 Key，不要粘贴带说明文字的整段内容。当前长度 ${k.length}`
    );
  }

  // Heuristic: real keys are short; 1000+ chars means paste of a whole page
  if (k.length > 512) {
    throw new Error(
      `API Key 过长（${k.length} 字符）。正常密钥通常几十到两百字符。请只粘贴密钥本身，不要带标题、括号说明或整段文档。`
    );
  }

  return k;
}

/** Soft clean for UI/display — never throws; strips junk best-effort. */
export function sanitizeApiKeyLoose(raw: string): string {
  try {
    return normalizeApiKey(raw);
  } catch {
    // Best-effort strip without throw (for draft form fields)
    return String(raw ?? "")
      .replace(/[\uFF01-\uFF5E]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
      )
      .replace(/\u3000/g, " ")
      .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
      .replace(/\s+/g, "")
      .replace(/^Bearer/i, "")
      .trim();
  }
}

export interface SettingsEnvInput {
  SELFHOST?: string;
  ALLOW_DEV_EMBEDDING?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_PROVIDER?: string;
  EMBEDDING_DIM?: string;
  AI?: unknown;
}

function allowDevEmbedding(env: SettingsEnvInput): boolean {
  return env.ALLOW_DEV_EMBEDDING === "1" || env.ALLOW_DEV_EMBEDDING === "true";
}

export function mergeModelSettings(
  stored: ModelSettings | null | undefined,
  env: SettingsEnvInput
): ModelSettings {
  const s = stored ?? emptyModelSettings();
  const isSelfhost = env.SELFHOST === "1" || env.SELFHOST === "true";

  const llmProvider =
    s.llm.provider && s.llm.provider !== "none"
      ? s.llm.provider
      : env.LLM_BASE_URL && env.LLM_API_KEY
        ? "custom"
        : env.AI && !isSelfhost
          ? "workers"
          : "none";

  let embProvider =
    s.embedding.provider && s.embedding.provider !== "none"
      ? s.embedding.provider
      : env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY
        ? "custom"
        : isDevLocalProvider(env.EMBEDDING_PROVIDER) && allowDevEmbedding(env)
          ? "local-hash-dev"
          : env.AI && !isSelfhost
            ? "workers"
            : "none";

  const preset = EMBEDDING_PRESETS.find((p) => p.id === embProvider);
  const supportsDim =
    s.embedding.supportsDimensionsParameter ??
    preset?.supportsDimensionsParameter ??
    true;

  return {
    llm: {
      provider: llmProvider,
      baseURL: s.llm.baseURL || env.LLM_BASE_URL || "",
      apiKey: s.llm.apiKey || env.LLM_API_KEY || "",
      model: s.llm.model || env.LLM_MODEL || "",
    },
    embedding: {
      provider: embProvider,
      baseURL: s.embedding.baseURL || env.EMBEDDING_BASE_URL || "",
      apiKey: s.embedding.apiKey || env.EMBEDDING_API_KEY || "",
      model: s.embedding.model || env.EMBEDDING_MODEL || "",
      dimensions:
        s.embedding.dimensions ||
        parseInt(env.EMBEDDING_DIM || "384", 10) ||
        384,
      supportsDimensionsParameter: supportsDim,
    },
    updatedAt: s.updatedAt,
    activeEmbedding: s.activeEmbedding ? cloneEmbeddingSettings(s.activeEmbedding) : undefined,
    pendingEmbedding: s.pendingEmbedding ? cloneEmbeddingSettings(s.pendingEmbedding) : undefined,
    embeddingFingerprint: s.embeddingFingerprint,
    pendingEmbeddingFingerprint: s.pendingEmbeddingFingerprint,
  };
}

export function toPublicModelSettings(
  effective: ModelSettings,
  opts: {
    hasStored: boolean;
    hasEnvLlm: boolean;
    hasEnvEmbed: boolean;
    allowDevEmbedding?: boolean;
  }
): PublicModelSettings {
  let source: PublicModelSettings["status"]["source"] = "default";
  if (opts.hasStored && (opts.hasEnvLlm || opts.hasEnvEmbed)) source = "mixed";
  else if (opts.hasStored) source = "control-plane";
  else if (opts.hasEnvLlm || opts.hasEnvEmbed) source = "env";

  const llmStatus: PublicModelSettings["status"]["llm"] =
    effective.llm.baseURL && effective.llm.apiKey
      ? "openai-compatible"
      : effective.llm.provider === "workers"
        ? "workers-ai"
        : "unconfigured";

  const embDev = isDevLocalProvider(effective.embedding.provider);
  const embStatus: PublicModelSettings["status"]["embedding"] = embDev
    ? "local-dev"
    : effective.embedding.baseURL && effective.embedding.apiKey
      ? "openai-compatible"
      : effective.embedding.provider === "workers"
        ? "workers-ai"
        : "unconfigured";

  const currentFp = embeddingFingerprintOf(effective.embedding);
  const active = effective.embeddingFingerprint;
  const pending = effective.pendingEmbeddingFingerprint;
  const reindexRequired = Boolean(
    (pending && pending !== active) ||
      (active && active !== currentFp && !pending)
  );

  // Never return persisted credentials to a browser. The authenticated control
  // plane exposes only presence flags; replacing a key requires a new value.
  return {
    llm: {
      provider: effective.llm.provider,
      baseURL: effective.llm.baseURL,
      model: effective.llm.model,
      apiKey: "",
      hasApiKey: Boolean(effective.llm.apiKey),
    },
    embedding: {
      provider: effective.embedding.provider,
      baseURL: effective.embedding.baseURL,
      model: effective.embedding.model,
      dimensions: effective.embedding.dimensions,
      apiKey: "",
      hasApiKey: Boolean(effective.embedding.apiKey),
      supportsDimensionsParameter: effective.embedding.supportsDimensionsParameter,
    },
    updatedAt: effective.updatedAt,
    activeEmbedding: publicEmbeddingProfile(effective.activeEmbedding),
    pendingEmbedding: publicEmbeddingProfile(effective.pendingEmbedding),
    embeddingFingerprint: effective.embeddingFingerprint,
    pendingEmbeddingFingerprint: effective.pendingEmbeddingFingerprint,
    status: {
      llm: llmStatus,
      embedding: embStatus,
      source,
      reindexRequired,
      devEmbeddingWarning: embDev,
    },
    presets: {
      llm: LLM_PRESETS.map((p) => ({ ...p, models: p.models ? [...p.models] : undefined })),
      embedding: EMBEDDING_PRESETS.map((p) => ({
        ...p,
        models: p.models ? [...p.models] : undefined,
        allowedDimensions: p.allowedDimensions ? [...p.allowedDimensions] : undefined,
      })),
    },
  };
}

export type ModelSettingsPatchBody = {
  llm?: Partial<LlmSettings> & { clearApiKey?: boolean };
  embedding?: Partial<EmbeddingSettings> & { clearApiKey?: boolean };
  /** @deprecated Do not set active fingerprint on ordinary save. */
  acceptEmbeddingFingerprint?: boolean;
};

export function applyModelSettingsPatch(
  previous: ModelSettings,
  body: ModelSettingsPatchBody
): ModelSettings {
  const next = structuredClone(previous);

  if (body.llm) {
    if (body.llm.provider != null) next.llm.provider = String(body.llm.provider);
    if (body.llm.baseURL != null) next.llm.baseURL = String(body.llm.baseURL).trim();
    if (body.llm.model != null) next.llm.model = String(body.llm.model).trim();
    if (body.llm.clearApiKey) {
      next.llm.apiKey = "";
    } else if (body.llm.apiKey != null) {
      const k = String(body.llm.apiKey);
      if (k && !isMaskedSecret(k)) next.llm.apiKey = normalizeApiKey(k);
    }
    const preset = LLM_PRESETS.find((p) => p.id === next.llm.provider);
    if (preset) {
      if (!next.llm.baseURL && preset.baseURL) next.llm.baseURL = preset.baseURL;
      if (!next.llm.model && preset.model) next.llm.model = preset.model;
    }
  }

  if (body.embedding) {
    if (body.embedding.provider != null)
      next.embedding.provider = String(body.embedding.provider);
    if (body.embedding.baseURL != null)
      next.embedding.baseURL = String(body.embedding.baseURL).trim();
    if (body.embedding.model != null)
      next.embedding.model = String(body.embedding.model).trim();
    if (body.embedding.dimensions != null) {
      const d = Number(body.embedding.dimensions);
      if (Number.isFinite(d) && d > 0) next.embedding.dimensions = Math.floor(d);
    }
    if (body.embedding.clearApiKey) {
      next.embedding.apiKey = "";
    } else if (body.embedding.apiKey != null) {
      const k = String(body.embedding.apiKey);
      if (k && !isMaskedSecret(k)) next.embedding.apiKey = normalizeApiKey(k);
    }
    const preset = EMBEDDING_PRESETS.find((p) => p.id === next.embedding.provider);
    if (preset) {
      next.embedding.supportsDimensionsParameter = preset.supportsDimensionsParameter;
      if (isDevLocalProvider(next.embedding.provider)) {
        next.embedding.baseURL = "";
        next.embedding.model = preset.model;
        next.embedding.dimensions = preset.fixedDimensions ?? preset.dimensions;
      } else {
        if (!next.embedding.baseURL && preset.baseURL) next.embedding.baseURL = preset.baseURL;
        if (!next.embedding.model && preset.model) next.embedding.model = preset.model;
        if (preset.fixedDimensions != null) {
          next.embedding.dimensions = preset.fixedDimensions;
        } else if (!next.embedding.dimensions) {
          next.embedding.dimensions = preset.dimensions;
        }
      }
    }
  }

  next.updatedAt = Date.now();
  return next;
}

/** After successful full reindex, promote pending → active. */
export function promoteEmbeddingFingerprint(settings: ModelSettings): ModelSettings {
  const next = structuredClone(settings);
  if (next.pendingEmbeddingFingerprint) {
    next.embeddingFingerprint = next.pendingEmbeddingFingerprint;
    next.pendingEmbeddingFingerprint = undefined;
    next.activeEmbedding = cloneEmbeddingSettings(next.pendingEmbedding ?? next.embedding);
    next.embedding = cloneEmbeddingSettings(next.activeEmbedding);
    next.pendingEmbedding = undefined;
  } else {
    next.embeddingFingerprint = embeddingFingerprintOf(next.embedding);
    next.activeEmbedding = cloneEmbeddingSettings(next.embedding);
  }
  return next;
}
