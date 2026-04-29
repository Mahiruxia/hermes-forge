import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import type {
  LocalModelDiscoveryCandidate,
  LocalModelDiscoveryResult,
  ModelConnectionTestResult,
  ModelProfile,
  ModelSourceType,
  RuntimeConfig,
} from "../shared/types";
import type { SecretVault } from "../auth/secret-vault";
import { defaultProviderRegistry, providerFromProfile } from "./model-providers/registry";
import { OpenAiCompatibleProvider } from "./model-providers/openai-compatible-provider";
import type { ModelConnectionDraft, ModelSourceDefinition } from "./model-providers/types";

export type { ModelConnectionDraft, ModelSourceDefinition };
export { BaseProvider } from "./model-providers/base-provider";
export { ProviderRegistry } from "./model-providers/registry";

const DEFAULT_REGISTRY = defaultProviderRegistry;

/**
 * Tests the selected or draft model profile against its provider adapter.
 *
 * The public signature is intentionally stable for IPC and tests. Internally,
 * the provider is resolved through `ProviderRegistry`, so adding a provider no
 * longer requires editing this orchestration function.
 */
export async function testModelConnection(input: {
  draft?: ModelConnectionDraft;
  config: RuntimeConfig;
  secretVault: SecretVault;
  runtimeAdapterFactory: RuntimeAdapterFactory;
  resolveHermesRoot: () => Promise<string>;
}): Promise<ModelConnectionTestResult> {
  const profile = input.draft
    ? draftToModelProfile(input.draft)
    : selectProfile(input.config, undefined);
  if (!profile) {
    return { ok: false, message: "尚未配置模型。请先选择 provider family。" };
  }
  const sourceType = normalizeSourceType(profile.sourceType ?? inferSourceType(profile.provider, profile.baseUrl));
  return DEFAULT_REGISTRY.get(sourceType).testConnection({
    profile: { ...profile, sourceType },
    sourceType,
    config: input.config,
    secretVault: input.secretVault,
    runtimeAdapterFactory: input.runtimeAdapterFactory,
    resolveHermesRoot: input.resolveHermesRoot,
  });
}

/**
 * Discovers local OpenAI-compatible endpoints with a concurrency limit of 3.
 */
export async function discoverCustomEndpointSources(): Promise<LocalModelDiscoveryResult> {
  const providers = DEFAULT_REGISTRY.discoverableCustomProviders();
  const results = await runLimited(providers, 3, async (provider) => {
    const baseUrl = provider.definition.baseUrl!;
    const discoveryProvider = provider instanceof OpenAiCompatibleProvider
      ? provider
      : new OpenAiCompatibleProvider(provider.definition);
    const outcome = await discoveryProvider.discoverModels(baseUrl);
    const record: LocalModelDiscoveryCandidate & { sourceType: ModelSourceType } = {
      baseUrl,
      ok: outcome.ok,
      availableModels: outcome.availableModels,
      message: outcome.message,
      failureCategory: outcome.failureCategory,
      sourceType: provider.sourceType,
    };
    return record;
  });
  const firstOk = results.find((item) => item.ok);
  return {
    ok: Boolean(firstOk),
    candidates: results,
    recommendedBaseUrl: firstOk?.baseUrl,
    recommendedModel: firstOk?.availableModels[0],
    message: firstOk ? `已发现可用本地/兼容接口：${firstOk.baseUrl}` : "没有发现可直接使用的本地或兼容接口，请手动填写地址。",
  };
}

/** Returns the provider family configured for a source type. */
export function providerFamilyFor(sourceType: ModelSourceType): ModelConnectionTestResult["providerFamily"] {
  return sourceDefinition(sourceType).family;
}

/** Returns the auth mode configured for a source type. */
export function authModeFor(sourceType: ModelSourceType): NonNullable<ModelConnectionTestResult["authMode"]> {
  return sourceDefinition(sourceType).authMode;
}

/** Returns provider metadata for UI and draft-profile construction. */
export function sourceDefinition(sourceType: ModelSourceType): ModelSourceDefinition {
  return DEFAULT_REGISTRY.get(normalizeSourceType(sourceType)).definition;
}

/**
 * Converts an unsaved UI draft into the same profile shape used by runtime config.
 */
export function draftToModelProfile(draft: ModelConnectionDraft): ModelProfile {
  const sourceType = normalizeSourceType(draft.sourceType);
  const definition = sourceDefinition(sourceType);
  return {
    id: draft.profileId ?? `draft-${sourceType}`,
    provider: definition.provider,
    sourceType,
    authMode: definition.authMode,
    model: draft.model?.trim() ?? "",
    baseUrl: draft.baseUrl?.trim() || definition.baseUrl,
    secretRef: draft.secretRef?.trim() || (definition.keyOptional ? undefined : defaultSecretRefForSource(sourceType)),
    maxTokens: draft.maxTokens,
  };
}

/**
 * Infers a model source from provider and URL.
 *
 * Domain/provider-specific matches are preferred; legacy port heuristics are
 * kept only as a fallback for local OpenAI-compatible servers.
 */
export function inferSourceType(provider: ModelProfile["provider"], baseUrl?: string): ModelSourceType {
  return providerFromProfile(provider, baseUrl, DEFAULT_REGISTRY).sourceType;
}

/** Returns the default secret reference used for a provider source. */
export function defaultSecretRefForSource(sourceType: ModelSourceType) {
  switch (sourceType) {
    case "openrouter_api_key": return "provider.openrouter.apiKey";
    case "anthropic_api_key": return "provider.anthropic.apiKey";
    case "gemini_api_key": return "provider.gemini.apiKey";
    case "deepseek_api_key": return "provider.deepseek.apiKey";
    case "huggingface_api_key": return "provider.huggingface.apiKey";
    case "dashscope_api_key": return "provider.dashscope.apiKey";
    case "baidu_wenxin_api_key": return "provider.baidu-wenxin.apiKeySecret";
    case "zhipu_api_key": return "provider.zhipu.apiKey";
    case "spark_api_key": return "provider.spark.apiPassword";
    case "moonshot_api_key": return "provider.moonshot.apiKey";
    case "baichuan_api_key": return "provider.baichuan.apiKey";
    case "minimax_api_key": return "provider.minimax.apiKey";
    case "yi_api_key": return "provider.yi.apiKey";
    case "hunyuan_api_key": return "provider.hunyuan.apiKey";
    case "siliconflow_api_key": return "provider.siliconflow.apiKey";
    case "mimo_api_key": return "provider.mimo.apiKey";
    case "volcengine_ark_api_key": return "provider.volcengine-ark.apiKey";
    case "volcengine_coding_api_key": return "provider.volcengine-coding.apiKey";
    case "dashscope_coding_api_key": return "provider.dashscope-coding.apiKey";
    case "zhipu_coding_api_key": return "provider.zhipu-coding.apiKey";
    case "baidu_qianfan_coding_api_key": return "provider.baidu-qianfan-coding.apiKey";
    case "tencent_token_plan_api_key": return "provider.tencent-token-plan.apiKey";
    case "tencent_hunyuan_token_plan_api_key": return "provider.tencent-hy-token-plan.apiKey";
    case "mimo_token_plan_api_key": return "provider.mimo-token-plan.apiKey";
    case "minimax_token_plan_api_key": return "provider.minimax-token-plan.apiKey";
    case "kimi_coding_api_key": return "provider.kimi-coding.apiKey";
    case "github_copilot": return "provider.copilot.token";
    case "github_copilot_acp": return "provider.copilot-acp.token";
    case "ollama": return "provider.ollama.apiKey";
    case "vllm": return "provider.vllm.apiKey";
    case "sglang": return "provider.sglang.apiKey";
    case "lm_studio": return "provider.lmstudio.apiKey";
    case "openai_compatible": return "provider.custom.apiKey";
    case "gemini_oauth": return "provider.gemini.oauth";
    case "anthropic_local_credentials": return "provider.anthropic.local";
    default: return "provider.custom.apiKey";
  }
}

function normalizeSourceType(sourceType?: string): ModelSourceType {
  return DEFAULT_REGISTRY.has(sourceType) ? sourceType : "openai_compatible";
}

function selectProfile(config: RuntimeConfig, profileId?: string) {
  return config.modelProfiles.find((item) => item.id === (profileId ?? config.defaultModelProfileId)) ?? config.modelProfiles[0];
}

async function runLimited<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results: R[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}
