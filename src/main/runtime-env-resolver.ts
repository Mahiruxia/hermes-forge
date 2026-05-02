import type { SecretVault } from "../auth/secret-vault";
import type { RuntimeConfigStore } from "./runtime-config";
import type { EngineRuntimeEnv, ModelProfile, ModelRole, RuntimeConfig } from "../shared/types";
import { normalizeModelIdForSource, normalizeOpenAiCompatibleBaseUrl, normalizeSourceTypeForProfile } from "../shared/model-config";
import type { ModelRuntimeProxyService } from "./model-runtime-proxy";

export class RuntimeEnvResolver {
  private cache = new Map<string, { env: EngineRuntimeEnv; expiresAt: number }>();

  constructor(
    private readonly configStore: RuntimeConfigStore,
    private readonly secretVault: SecretVault,
    private readonly modelRuntimeProxy?: Pick<ModelRuntimeProxyService, "resolve">,
  ) {}

  readConfig() {
    return this.configStore.read();
  }

  async resolve(modelProfileId?: string): Promise<EngineRuntimeEnv> {
    const config = await this.configStore.read();
    return this.resolveFromConfig(config, modelProfileId);
  }

  async resolveRole(role: ModelRole): Promise<EngineRuntimeEnv> {
    const config = await this.configStore.read();
    return this.resolveRoleFromConfig(config, role);
  }

  async resolveRoleFromConfig(config: RuntimeConfig, role: ModelRole): Promise<EngineRuntimeEnv> {
    const profileId = config.modelRoleAssignments?.[role] ?? (role === "chat" ? config.defaultModelProfileId : undefined);
    if (!profileId && role !== "chat") {
      throw new Error(`${role} 角色尚未分配模型。`);
    }
    return this.resolveFromConfig(config, profileId, role);
  }

  async resolveFromConfig(config: RuntimeConfig, modelProfileId?: string, role?: ModelRole): Promise<EngineRuntimeEnv> {
    const requestedProfileId = modelProfileId ?? config.defaultModelProfileId;
    const profile =
      config.modelProfiles.find((item) => item.id === requestedProfileId) ??
      (role && role !== "chat" ? undefined : config.modelProfiles[0]);

    if (!profile) {
      throw new Error("缺少模型配置，无法生成运行环境。");
    }

    const cacheKey = this.buildCacheKey(config, profile, role);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.env;
    }

    const secret = profile.secretRef ? await this.secretVault.readSecret(profile.secretRef) : undefined;
    const providerProfile = config.providerProfiles?.find((item) => item.provider === profile.provider || item.id === profile.id);
    const baseUrl = normalizeOpenAiCompatibleBaseUrl(profile.baseUrl ?? providerProfile?.baseUrl);
    const sourceType = normalizeSourceTypeForProfile({ sourceType: profile.sourceType, baseUrl, model: profile.model });
    const normalizedProfile = {
      ...profile,
      sourceType,
      model: normalizeModelIdForSource(sourceType, profile.model),
      ...(baseUrl ? { baseUrl } : {}),
    };
    const runtime = {
      profileId: profile.id,
      provider: profile.provider,
      model: normalizedProfile.model,
      role,
      sourceType: normalizedProfile.sourceType,
      baseUrl,
      providerProfileId: providerProfile?.id,
      env: this.toEnv(normalizedProfile, secret),
    };
    const result = this.modelRuntimeProxy ? await this.modelRuntimeProxy.resolve(runtime) : runtime;
    this.cache.set(cacheKey, { env: result, expiresAt: Date.now() + 10_000 });
    return result;
  }

  private buildCacheKey(config: RuntimeConfig, profile: ModelProfile, role?: ModelRole): string {
    return [
      role ?? "",
      profile.id,
      profile.provider,
      profile.model,
      profile.baseUrl ?? "",
      profile.sourceType ?? "",
      JSON.stringify(profile.settingsConfig ?? {}),
      config.providerProfiles?.map((p) => `${p.id}:${p.provider}:${p.baseUrl ?? ""}`).join(",") ?? "",
    ].join("|");
  }

  private toEnv(profile: ModelProfile, secret?: string): Record<string, string> {
    if (usesProviderSpecificRuntimeEnv(profile.sourceType)) {
      return this.legacyToEnv(profile, secret);
    }
    // CC Switch 直接模式：settingsConfig 存在时直接透传，不再走 legacy 分支转换
    if (profile.settingsConfig?.env) {
      return applyTemplateValues(profile.settingsConfig.env, {
        api_key: secret ?? "",
        base_url: profile.baseUrl ?? "",
        model: profile.model ?? "",
      });
    }
    return this.legacyToEnv(profile, secret);
  }

  private legacyToEnv(profile: ModelProfile, secret?: string): Record<string, string> {
    const env: Record<string, string> = {
      AI_PROVIDER: profile.provider,
      AI_MODEL: profile.model,
    };

    if (profile.baseUrl) {
      env.AI_BASE_URL = profile.baseUrl;
      env.OPENAI_BASE_URL = profile.baseUrl;
      env.ANTHROPIC_BASE_URL = profile.baseUrl;
    }

    if (profile.sourceType) {
      env.HERMES_FORGE_MODEL_SOURCE_TYPE = profile.sourceType;
    }

    if (profile.sourceType === "kimi_coding_api_key") {
      env.AI_PROVIDER = "custom";
      // Hermes Agent's Kimi route auto-detects api.kimi.com/coding as the
      // Anthropic Messages protocol, and the Anthropic SDK appends /v1/messages
      // to the base URL.  Stripping the trailing /v1 prevents Hermes from
      // building the broken https://api.kimi.com/coding/v1/v1/messages path
      // (which returns HTTP 404).  The OpenAI Chat Completions route still
      // works against /coding/v1/chat/completions for clients that hit it
      // directly, but Hermes only ever uses the Anthropic Messages protocol
      // for this endpoint per its api_mode auto-detection.
      const userBaseUrl = profile.baseUrl ?? "https://api.kimi.com/coding/v1";
      env.KIMI_BASE_URL = stripTrailingV1(userBaseUrl);
      if (secret) {
        env.KIMI_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "minimax_token_plan_api_key") {
      const anthropicBaseUrl = toMiniMaxAnthropicBaseUrl(profile.baseUrl);
      env.AI_PROVIDER = "custom";
      env.MINIMAX_BASE_URL = anthropicBaseUrl;
      env.AI_BASE_URL = anthropicBaseUrl;
      env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
      delete env.OPENAI_BASE_URL;
      if (secret) {
        env.MINIMAX_API_KEY = secret;
        env.ANTHROPIC_API_KEY = secret;
        env.ANTHROPIC_AUTH_TOKEN = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "minimax_api_key") {
      env.AI_PROVIDER = "custom";
      env.MINIMAX_BASE_URL = profile.baseUrl ?? "https://api.minimax.chat/v1";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://api.minimax.chat/v1";
      if (secret) {
        env.MINIMAX_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "zhipu_coding_api_key") {
      env.AI_PROVIDER = "custom";
      env.GLM_BASE_URL = profile.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4";
      if (secret) {
        env.GLM_API_KEY = secret;
        env.ZAI_API_KEY = secret;
        env.ZHIPU_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "dashscope_coding_api_key") {
      env.AI_PROVIDER = "custom";
      env.DASHSCOPE_BASE_URL = profile.baseUrl ?? "https://coding-intl.dashscope.aliyuncs.com/v1";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://coding-intl.dashscope.aliyuncs.com/v1";
      if (secret) {
        env.DASHSCOPE_API_KEY = secret;
        env.ALIBABA_CODING_PLAN_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "baidu_qianfan_coding_api_key") {
      env.AI_PROVIDER = "custom";
      env.QIANFAN_BASE_URL = profile.baseUrl ?? "https://qianfan.baidubce.com/v2/coding";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://qianfan.baidubce.com/v2/coding";
      if (secret) {
        env.QIANFAN_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "tencent_token_plan_api_key") {
      env.AI_PROVIDER = "custom";
      env.TENCENT_BASE_URL = profile.baseUrl ?? "https://api.lkeap.cloud.tencent.com/coding/v3";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://api.lkeap.cloud.tencent.com/coding/v3";
      if (secret) {
        env.TENCENT_API_KEY = secret;
        env.TENCENT_CODING_PLAN_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "tencent_hunyuan_token_plan_api_key") {
      env.AI_PROVIDER = "custom";
      env.TENCENT_HY_BASE_URL = profile.baseUrl ?? "https://tokenhub.tencentmaas.com/v1";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://tokenhub.tencentmaas.com/v1";
      if (secret) {
        env.TENCENT_HY_API_KEY = secret;
        env.TENCENT_TOKENHUB_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "mimo_api_key") {
      env.AI_PROVIDER = "custom";
      env.MIMO_BASE_URL = profile.baseUrl ?? "https://api.xiaomimimo.com/v1";
      env.XIAOMI_BASE_URL = profile.baseUrl ?? "https://api.xiaomimimo.com/v1";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://api.xiaomimimo.com/v1";
      env.AI_BASE_URL = profile.baseUrl ?? "https://api.xiaomimimo.com/v1";
      if (secret) {
        env.MIMO_API_KEY = secret;
        env.XIAOMI_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "mimo_token_plan_api_key") {
      env.AI_PROVIDER = "custom";
      env.MIMO_BASE_URL = profile.baseUrl ?? "https://token-plan-cn.xiaomimimo.com/v1";
      env.XIAOMI_BASE_URL = profile.baseUrl ?? "https://token-plan-cn.xiaomimimo.com/v1";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://token-plan-cn.xiaomimimo.com/v1";
      env.AI_BASE_URL = profile.baseUrl ?? "https://token-plan-cn.xiaomimimo.com/v1";
      if (secret) {
        env.MIMO_API_KEY = secret;
        env.XIAOMI_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.sourceType === "volcengine_coding_api_key") {
      env.AI_PROVIDER = "custom";
      env.VOLCENGINE_BASE_URL = profile.baseUrl ?? "https://ark.cn-beijing.volces.com/api/coding/v3";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://ark.cn-beijing.volces.com/api/coding/v3";
      if (secret) {
        env.VOLCENGINE_API_KEY = secret;
        env.OPENAI_API_KEY = secret;
        env.AI_API_KEY = secret;
      }
      return env;
    }

    if (profile.provider === "local") {
      return env;
    }

    if (profile.sourceType === "baidu_wenxin_api_key") {
      if (secret) {
        env.HERMES_FORGE_BAIDU_CREDENTIAL = secret;
        env.AI_API_KEY = "hermes-forge-local-proxy-key";
        env.OPENAI_API_KEY = "hermes-forge-local-proxy-key";
      }
      env.AI_PROVIDER = "custom";
      return env;
    }

    if (profile.provider === "custom") {
      const apiKey = secret || "lm-studio";
      env.OPENAI_API_KEY = apiKey;
      env.AI_API_KEY = apiKey;
      env.AI_PROVIDER = "custom";
    } else if (!secret) {
      return env;
    } else if (profile.provider === "openrouter") {
      env.OPENROUTER_API_KEY = secret;
      env.OPENAI_API_KEY = secret;
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://openrouter.ai/api/v1";
      env.AI_API_KEY = secret;
      env.AI_BASE_URL = env.OPENAI_BASE_URL;
      env.AI_PROVIDER = "openrouter";
    } else if (profile.provider === "gemini") {
      env.GOOGLE_API_KEY = secret;
      env.GEMINI_API_KEY = secret;
      env.AI_API_KEY = secret;
      env.AI_PROVIDER = "gemini";
    } else if (profile.provider === "deepseek") {
      env.DEEPSEEK_API_KEY = secret;
      env.OPENAI_API_KEY = secret;
      env.AI_API_KEY = secret;
      env.AI_PROVIDER = "deepseek";
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://api.deepseek.com/v1";
      env.AI_BASE_URL = env.OPENAI_BASE_URL;
    } else if (profile.provider === "huggingface") {
      env.HF_TOKEN = secret;
      env.AI_API_KEY = secret;
      env.AI_PROVIDER = "huggingface";
      env.OPENAI_API_KEY = secret;
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://router.huggingface.co/v1";
      env.AI_BASE_URL = env.OPENAI_BASE_URL;
    } else if (profile.provider === "copilot") {
      env.COPILOT_GITHUB_TOKEN = secret;
      env.AI_API_KEY = secret;
      env.AI_PROVIDER = "copilot";
    } else if (profile.provider === "copilot_acp") {
      env.AI_API_KEY = secret;
      env.AI_PROVIDER = "copilot-acp";
    } else if (profile.provider === "openai") {
      env.OPENAI_API_KEY = secret;
    } else if (profile.provider === "anthropic") {
      env.ANTHROPIC_API_KEY = secret;
    } else {
      env.AI_API_KEY = secret;
    }

    return env;
  }
}

/** CC Switch 式模板变量替换：将 env 对象中的 ${var} 占位符替换为实际值 */
function applyTemplateValues(
  env: Record<string, string>,
  values: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, template] of Object.entries(env)) {
    result[key] = template.replace(/\$\{(\w+)\}/g, (_match, varName) =>
      values[varName] !== undefined ? values[varName] : _match,
    );
  }
  return result;
}

function stripTrailingV1(url: string) {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function usesProviderSpecificRuntimeEnv(sourceType: ModelProfile["sourceType"] | undefined) {
  return Boolean(sourceType && [
    "baidu_wenxin_api_key",
    "volcengine_coding_api_key",
    "dashscope_coding_api_key",
    "zhipu_coding_api_key",
    "baidu_qianfan_coding_api_key",
    "tencent_token_plan_api_key",
    "tencent_hunyuan_token_plan_api_key",
    "mimo_api_key",
    "mimo_token_plan_api_key",
    "minimax_token_plan_api_key",
    "kimi_coding_api_key",
  ].includes(sourceType));
}

function toMiniMaxAnthropicBaseUrl(baseUrl?: string) {
  const raw = baseUrl?.trim() || "https://api.minimaxi.com/anthropic";
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host === "api.minimaxi.com" || host === "api.minimax.io") {
      parsed.pathname = "/anthropic";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    }
  } catch {
    return stripTrailingV1(raw);
  }
  return stripTrailingV1(raw);
}
