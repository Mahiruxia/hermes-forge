import type { ModelProfile, ModelRole, ModelSourceType, ProviderId, RuntimeConfig } from "./types";

/**
 * Coding Plan / 特殊路由 sourceType → Hermes Agent 内部 provider 名映射。
 *
 * Hermes Agent 在 CLI 命令 (`--provider X`) 与 AIAgent 构造函数
 * (`provider="X"`) 上只接受它内置注册过的 provider 名，例如
 * `kimi-coding`、`minimax-cn`、`xiaomi`。
 * Forge 默认让所有 Coding Plan profile 的 `provider` 字段挂在 `custom` 上，
 * 但只有 Hermes 已内置的特殊 provider 才能翻译；其它 OpenAI-compatible
 * Coding Plan 不能强行造 alias，否则 `hermes chat --provider ...` 会直接
 * argparse 退出 2。
 */
export function mapSourceTypeToHermesProvider(sourceType?: ModelSourceType | string): string | undefined {
  switch (sourceType) {
    case "kimi_coding_api_key":
      return "kimi-coding";
    case "kimi_coding_cn_api_key":
      return "kimi-coding-cn";
    case "stepfun_coding_api_key":
      return "stepfun";
    case "minimax_coding_api_key":
      return "minimax";
    case "minimax_token_plan_api_key":
    case "minimax_cn_token_plan_api_key":
      return "minimax-cn";
    case "mimo_api_key":
    case "mimo_token_plan_api_key":
      return "xiaomi";
    default:
      return undefined;
  }
}

/**
 * 给 Hermes Agent 用的 provider 名解析。
 *
 * 优先使用 sourceType 映射（覆盖所有 Coding Plan profile），其次按 ProviderId
 * 做兼容翻译。当 ProviderId === "custom" 且没有 sourceType 映射时，仍然返回
 * `custom`，由 Hermes Agent 走 OpenAI-compatible 自动识别。
 */
export function resolveHermesProvider(input: { provider: string; sourceType?: ModelSourceType | string }): string {
  const mapped = mapSourceTypeToHermesProvider(input.sourceType);
  if (mapped) return mapped;
  if (input.provider === "openai") return "openrouter";
  if (input.provider === "copilot_acp") return "copilot-acp";
  return input.provider;
}

const CANONICAL_MODELS_BY_SOURCE: Partial<Record<ModelSourceType, string[]>> = {
  mimo_api_key: ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2.5-flash"],
  mimo_token_plan_api_key: ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2.5-flash"],
  kimi_coding_api_key: ["kimi-for-coding", "k2p6", "k2p5", "kimi-k2-thinking"],
  dashscope_coding_api_key: [
    "qwen3-coder-plus",
    "qwen3-max-2026-01-23",
    "qwen3-coder-next",
    "qwen3.6-plus",
    "qwen3.5-plus",
    "kimi-k2.5",
    "glm-5",
    "glm-4.7",
    "MiniMax-M2.5",
  ],
  zhipu_coding_api_key: [
    "glm-5",
    "glm-5.1",
    "glm-5-turbo",
    "glm-5v-turbo",
    "glm-4.7",
    "glm-4.7-flash",
    "glm-4.7-flashx",
    "glm-4.6",
    "glm-4.6v",
    "glm-4.6v-flash",
    "glm-4.5",
    "glm-4.5-air",
    "glm-4.5v",
    "glm-4.5-flash",
  ],
  tencent_token_plan_api_key: [
    "kimi-k2.5",
    "glm-5",
    "minimax-m2.5",
    "hunyuan-turbos",
    "hunyuan-t1",
    "hunyuan-2.0-thinking",
    "hunyuan-2.0-instruct",
    "tc-code-latest",
  ],
  tencent_hunyuan_token_plan_api_key: ["hy3-preview", "n-2.0-thinking-202511", "n-2.0-instruct-202511"],
  minimax_token_plan_api_key: [
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "MiniMax-M2.1",
    "MiniMax-M2",
  ],
};

export function normalizeSourceTypeForProfile(input: { sourceType?: ModelSourceType | string; baseUrl?: string; model?: string }): ModelSourceType | undefined {
  const current = normalizeSourceType(input.sourceType);
  const inferred = inferSourceTypeFromEndpoint(input.baseUrl);
  if (inferred && (!current || current === "openai_compatible" || current === "legacy")) {
    return inferred;
  }
  return current;
}

export function normalizeModelIdForSource(sourceType: ModelSourceType | string | undefined, model: string) {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  const canonical = sourceType && CANONICAL_MODELS_BY_SOURCE[sourceType as ModelSourceType]
    ?.find((item) => item.toLowerCase() === trimmed.toLowerCase());
  return canonical ?? trimmed;
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl?: string) {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;

  const parsed = new URL(trimmed);
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/v1";
  }
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString().replace(/\/$/, "");
}

export function requiresStoredSecret(profile: ModelProfile) {
  if (profile.provider === "local") return false;
  if (profile.provider === "custom") return Boolean(profile.secretRef?.trim());
  return true;
}

export function missingSecretMessage(profile: ModelProfile) {
  if (profile.provider === "custom") {
    return "当前配置填写了密钥引用，但对应密钥尚未保存或已失效。";
  }
  return `${profile.provider} 模型缺少可用密钥。`;
}

type LegacyModelProfile = Partial<ModelProfile> & {
  providerId?: unknown;
  defaultModel?: unknown;
  default_model?: unknown;
};

type LegacyRuntimeConfig = Partial<RuntimeConfig> & {
  defaultModelId?: unknown;
  defaultModel?: unknown;
  default_model?: unknown;
  default_model_id?: unknown;
  models?: unknown;
};

const PROVIDERS: ProviderId[] = ["openai", "anthropic", "openrouter", "gemini", "deepseek", "huggingface", "copilot", "copilot_acp", "local", "custom"];

export function stableModelProfileId(input: Pick<ModelProfile, "provider" | "model"> & { baseUrl?: string }) {
  const key = modelIdentityKey(input.provider, input.model, input.baseUrl);
  return `model-${stableHash(key)}`;
}

export function migrateRuntimeConfigModels<T extends Partial<RuntimeConfig>>(input: T | LegacyRuntimeConfig): T & Pick<RuntimeConfig, "modelProfiles"> & { defaultModelProfileId?: string; modelRoleAssignments?: RuntimeConfig["modelRoleAssignments"] } {
  const raw = (input ?? {}) as LegacyRuntimeConfig;
  const rawProfiles = Array.isArray(raw.modelProfiles)
    ? raw.modelProfiles
    : Array.isArray(raw.models)
      ? raw.models
      : [];
  const modelProfiles = dedupeProfiles(rawProfiles
    .map((item) => normalizeLegacyModelProfile(item))
    .filter((item): item is ModelProfile => Boolean(item)));
  const rawDefault = firstString(
    raw.defaultModelId,
    raw.defaultModelProfileId,
    raw.modelRoleAssignments?.chat,
    raw.default_model_id,
    raw.default_model,
    raw.defaultModel,
  );
  const defaultModelProfileId = resolveDefaultModelProfileId(rawDefault, modelProfiles);
  const modelRoleAssignments = normalizeRoleAssignments(raw.modelRoleAssignments, defaultModelProfileId, modelProfiles);
  return {
    ...input,
    modelProfiles,
    defaultModelProfileId,
    modelRoleAssignments,
  } as T & Pick<RuntimeConfig, "modelProfiles"> & { defaultModelProfileId?: string };
}

export function resolveDefaultModelProfileId(rawDefault: string | undefined, profiles: ModelProfile[]) {
  if (!profiles.length) return undefined;
  const wanted = rawDefault?.trim();
  if (!wanted) return profiles[0].id;
  return (
    profiles.find((item) => item.id === wanted)?.id ??
    profiles.find((item) => modelIdentityKey(item.provider, item.model, item.baseUrl) === wanted)?.id ??
    profiles.find((item) => stableModelProfileId(item) === wanted)?.id ??
    profiles.find((item) => `${item.provider}:${item.model}` === wanted)?.id ??
    profiles.find((item) => item.model === wanted)?.id ??
    profiles.find((item) => item.model.toLowerCase() === wanted.toLowerCase())?.id ??
    profiles.find((item) => item.name === wanted)?.id ??
    profiles[0].id
  );
}

function normalizeLegacyModelProfile(input: unknown): ModelProfile | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as LegacyModelProfile;
  const rawModel = firstString(raw.model, raw.defaultModel, raw.default_model, raw.name);
  if (!rawModel) return undefined;
  const provider = normalizeProvider(firstString(raw.provider, raw.providerId), raw.baseUrl);
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : undefined;
  const sourceType = normalizeSourceTypeForProfile({
    sourceType: typeof raw.sourceType === "string" ? raw.sourceType : undefined,
    baseUrl,
    model: rawModel,
  });
  const model = normalizeModelIdForSource(sourceType, rawModel);
  const profile: ModelProfile = {
    ...raw,
    id: typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : stableModelProfileId({ provider, model, baseUrl }),
    provider,
    model,
    ...(sourceType ? { sourceType } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
  return profile;
}

function inferSourceTypeFromEndpoint(baseUrl: unknown): ModelSourceType | undefined {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (host === "token-plan-cn.xiaomimimo.com" || /^token-plan-[a-z0-9-]+\.xiaomimimo\.com$/.test(host)) {
    return "mimo_token_plan_api_key";
  }
  if (host === "api.xiaomimimo.com" || host === "api.mimo-v2.com") {
    return "mimo_api_key";
  }
  if (host === "api.kimi.com" && pathname.includes("/coding")) {
    return "kimi_coding_api_key";
  }
  if (host === "api.minimaxi.com" || host === "api.minimax.io") {
    return "minimax_token_plan_api_key";
  }
  if (host === "coding-intl.dashscope.aliyuncs.com") {
    return "dashscope_coding_api_key";
  }
  if (host === "open.bigmodel.cn" && pathname.includes("/coding")) {
    return "zhipu_coding_api_key";
  }
  if (host === "qianfan.baidubce.com" && pathname.includes("/coding")) {
    return "baidu_qianfan_coding_api_key";
  }
  if (host === "api.lkeap.cloud.tencent.com" && pathname.includes("/coding")) {
    return "tencent_token_plan_api_key";
  }
  if (host === "tokenhub.tencentmaas.com") {
    return "tencent_hunyuan_token_plan_api_key";
  }
  if (host === "ark.cn-beijing.volces.com" && pathname.includes("/coding")) {
    return "volcengine_coding_api_key";
  }
  return undefined;
}

function normalizeSourceType(sourceType: ModelSourceType | string | undefined): ModelSourceType | undefined {
  if (!sourceType) return undefined;
  const normalized = sourceType.trim() as ModelSourceType;
  return normalized ? normalized : undefined;
}

function normalizeRoleAssignments(raw: unknown, defaultModelProfileId: string | undefined, profiles: ModelProfile[]) {
  const ids = new Set(profiles.map((profile) => profile.id));
  const next: Partial<Record<ModelRole, string>> = {};
  if (raw && typeof raw === "object") {
    for (const role of ["chat", "coding_plan", "apply", "autocomplete"] as const) {
      const value = (raw as Partial<Record<ModelRole, unknown>>)[role];
      if (typeof value === "string" && ids.has(value)) next[role] = value;
    }
  }
  if (!next.chat && defaultModelProfileId && ids.has(defaultModelProfileId)) next.chat = defaultModelProfileId;
  if (!next.chat && profiles[0]) next.chat = profiles[0].id;
  return Object.keys(next).length ? next : undefined;
}

function dedupeProfiles(profiles: ModelProfile[]) {
  const byId = new Map<string, ModelProfile>();
  for (const profile of profiles) {
    byId.set(profile.id, profile);
  }
  return [...byId.values()];
}

function normalizeProvider(provider: string | undefined, baseUrl: unknown): ProviderId {
  const normalized = provider?.trim().toLowerCase().replace(/-/g, "_");
  if (normalized && PROVIDERS.includes(normalized as ProviderId)) return normalized as ProviderId;
  const url = typeof baseUrl === "string" ? baseUrl.toLowerCase() : "";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.openai.com")) return "openai";
  if (url.includes("anthropic.com")) return "anthropic";
  if (url.includes("generativelanguage.googleapis.com")) return "gemini";
  if (url.includes("deepseek.com")) return "deepseek";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "custom";
  return "custom";
}

function modelIdentityKey(provider: string, model: string, baseUrl?: string) {
  return `${provider.trim().toLowerCase()}:${model.trim()}:${baseUrl?.trim().replace(/\/$/, "") ?? ""}`;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
