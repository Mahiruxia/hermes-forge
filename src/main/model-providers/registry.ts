import type { ModelProfile, ModelProviderGroup, ModelRole, ModelSourceDefinition, ModelSourceType, RuntimeCompatibility } from "../../shared/types";
import { AnthropicLocalCredentialsProvider, AnthropicProvider } from "./anthropic-provider";
import { GithubCopilotProvider } from "./credential-openai-provider";
import { GeminiProvider } from "./gemini-provider";
import { ManualActionProvider } from "./manual-provider";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider";
import { BaichuanProvider } from "./adapters/baichuan-provider";
import { BaiduWenxinProvider } from "./adapters/baidu-wenxin-provider";
import { DashScopeProvider } from "./adapters/dashscope-provider";
import { HunyuanProvider } from "./adapters/hunyuan-provider";
import { MiniMaxProvider } from "./adapters/minimax-provider";
import { MoonshotProvider } from "./adapters/moonshot-provider";
import { SiliconFlowProvider } from "./adapters/siliconflow-provider";
import { SparkProvider } from "./adapters/spark-provider";
import { VolcengineArkProvider } from "./adapters/volcengine-provider";
import { VolcengineCodingProvider } from "./adapters/volcengine-coding-provider";
import { YiProvider } from "./adapters/yi-provider";
import { ZhipuProvider } from "./adapters/zhipu-provider";
import { BaseProvider } from "./base-provider";
import {
  BaiduQianfanCodingProvider,
  DashScopeCodingProvider,
  KimiCodingProvider,
  MiniMaxTokenPlanProvider,
  TencentHunyuanTokenPlanProvider,
  TencentTokenPlanProvider,
  ZhipuCodingProvider,
} from "./adapters/coding-plan-providers";

const builtinDefinitions = {
  openrouter_api_key: {
    sourceType: "openrouter_api_key",
    family: "api_key",
    authMode: "api_key",
    label: "OpenRouter",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelPlaceholder: "anthropic/claude-sonnet-4-5 或 openai/gpt-5",
    presetModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"],
  },
  anthropic_api_key: {
    sourceType: "anthropic_api_key",
    family: "api_key",
    authMode: "api_key",
    label: "Anthropic",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    modelPlaceholder: "claude-sonnet-4-5 或 claude-opus-4",
    presetModels: ["claude-sonnet-4-5", "claude-opus-4"],
  },
  gemini_api_key: {
    sourceType: "gemini_api_key",
    family: "api_key",
    authMode: "api_key",
    label: "Gemini API Key",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelPlaceholder: "gemini-2.5-pro 或 gemini-2.5-flash",
    presetModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  deepseek_api_key: {
    sourceType: "deepseek_api_key",
    family: "api_key",
    authMode: "api_key",
    label: "DeepSeek",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    modelPlaceholder: "deepseek-v4-pro 或 deepseek-v4-flash",
    presetModels: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  },
  huggingface_api_key: {
    sourceType: "huggingface_api_key",
    family: "api_key",
    authMode: "api_key",
    label: "Hugging Face",
    provider: "huggingface",
    baseUrl: "https://router.huggingface.co/v1",
    modelPlaceholder: "你在 Hugging Face Router 上可用的模型 ID",
  },
  gemini_oauth: {
    sourceType: "gemini_oauth",
    family: "oauth_or_local_credentials",
    authMode: "oauth",
    label: "Gemini OAuth",
    provider: "gemini",
    modelPlaceholder: "gemini-2.5-pro 或 gemini-2.5-flash",
    presetModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  anthropic_local_credentials: {
    sourceType: "anthropic_local_credentials",
    family: "oauth_or_local_credentials",
    authMode: "local_credentials",
    label: "Anthropic 本地凭据",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    modelPlaceholder: "claude-sonnet-4-5 或 claude-opus-4",
    presetModels: ["claude-sonnet-4-5", "claude-opus-4"],
  },
  github_copilot: {
    sourceType: "github_copilot",
    family: "oauth_or_local_credentials",
    authMode: "local_credentials",
    label: "GitHub Copilot",
    provider: "copilot",
    baseUrl: "https://models.github.ai/inference/v1",
    modelPlaceholder: "gpt-4.1 / claude / gemini 等 GitHub Models 模型 ID",
  },
  github_copilot_acp: {
    sourceType: "github_copilot_acp",
    family: "oauth_or_local_credentials",
    authMode: "external_process",
    label: "GitHub Copilot ACP",
    provider: "copilot_acp",
    modelPlaceholder: "由 ACP server 暴露的模型 ID",
  },
  ollama: local("ollama", "Ollama", "http://127.0.0.1:11434/v1", "ollama 中已拉取的模型名"),
  vllm: local("vllm", "vLLM", "http://127.0.0.1:8000/v1", "vLLM 提供的模型 ID"),
  sglang: local("sglang", "SGLang", "http://127.0.0.1:30000/v1", "SGLang 提供的模型 ID"),
  lm_studio: local("lm_studio", "LM Studio", "http://127.0.0.1:1234/v1", "LM Studio 中已加载模型"),
  openai_compatible: local("openai_compatible", "OpenAI-compatible", "http://127.0.0.1:8080/v1", "兼容 /v1/chat/completions 的模型 ID"),
  legacy: local("legacy", "Legacy", undefined, "legacy"),
} satisfies Partial<Record<ModelSourceType, ModelSourceDefinition>>;

/**
 * Registry for provider adapters.
 *
 * New providers are added by registering an adapter; core connection testing
 * calls only the registry and the `BaseProvider` interface.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ModelSourceType, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.sourceType, provider);
  }

  get(sourceType: ModelSourceType): BaseProvider {
    return this.providers.get(sourceType) ?? this.providers.get("openai_compatible")!;
  }

  getByModelOrUrl(model: string, baseUrl?: string): BaseProvider {
    const text = `${baseUrl ?? ""} ${model}`.toLowerCase();
    for (const provider of this.providers.values()) {
      if (provider.urlPatterns.some((pattern) => pattern.test(text))) return provider;
    }
    for (const provider of this.providers.values()) {
      if (provider.modelPatterns.some((pattern) => pattern.test(model))) return provider;
    }
    return this.get(portFallback(baseUrl));
  }

  has(sourceType: string | undefined): sourceType is ModelSourceType {
    return Boolean(sourceType && this.providers.has(sourceType as ModelSourceType));
  }

  definitions() {
    return [...this.providers.values()].map((provider) => normalizeDefinition(provider.definition));
  }

  discoverableCustomProviders() {
    return ["lm_studio", "ollama", "vllm", "sglang", "openai_compatible"]
      .map((sourceType) => this.get(sourceType as ModelSourceType))
      .filter((provider) => provider.definition.baseUrl);
  }
}

/** Creates the default provider registry used by the desktop app. */
export function createDefaultProviderRegistry() {
  const registry = new ProviderRegistry();
  registry.register(new OpenAiCompatibleProvider(builtinDefinitions.openrouter_api_key, { urlPatterns: [/openrouter\.ai/i] }));
  registry.register(new AnthropicProvider(builtinDefinitions.anthropic_api_key));
  registry.register(new GeminiProvider(builtinDefinitions.gemini_api_key));
  registry.register(new OpenAiCompatibleProvider(builtinDefinitions.deepseek_api_key, { urlPatterns: [/deepseek\.com/i], modelPatterns: [/^deepseek-/i] }));
  registry.register(new OpenAiCompatibleProvider(builtinDefinitions.huggingface_api_key, { urlPatterns: [/huggingface\.co/i] }));
  registry.register(new ManualActionProvider(builtinDefinitions.gemini_oauth, "Gemini OAuth 需要 Hermes CLI / 本机浏览器侧完成 OAuth，本版桌面端只做接入校验入口，不直接代做 OAuth。", "请先在原版 Hermes CLI 中完成 Gemini OAuth，本地凭据就绪后再回来测试/保存。"));
  registry.register(new AnthropicLocalCredentialsProvider(builtinDefinitions.anthropic_local_credentials));
  registry.register(new GithubCopilotProvider(builtinDefinitions.github_copilot));
  registry.register(new ManualActionProvider(builtinDefinitions.github_copilot_acp, "GitHub Copilot ACP 需要本机已有 ACP server 或外部进程。", "请先完成本机 provider 登录/凭据配置，然后再回来测试。"));
  registry.register(new OpenAiCompatibleProvider(builtinDefinitions.ollama, { urlPatterns: [/:11434\b/i, /ollama/i] }));
  registry.register(new OpenAiCompatibleProvider(builtinDefinitions.vllm, { urlPatterns: [/:8000\b/i, /vllm/i] }));
  registry.register(new OpenAiCompatibleProvider(builtinDefinitions.sglang, { urlPatterns: [/:30000\b/i, /sglang/i] }));
  registry.register(new OpenAiCompatibleProvider(builtinDefinitions.lm_studio, { urlPatterns: [/:1234\b/i, /lmstudio|lm-studio/i] }));
  registry.register(new OpenAiCompatibleProvider(builtinDefinitions.openai_compatible));
  registry.register(new OpenAiCompatibleProvider(builtinDefinitions.legacy));
  registry.register(new DashScopeCodingProvider());
  registry.register(new ZhipuCodingProvider());
  registry.register(new BaiduQianfanCodingProvider());
  registry.register(new TencentTokenPlanProvider());
  registry.register(new TencentHunyuanTokenPlanProvider());
  registry.register(new MiniMaxTokenPlanProvider());
  registry.register(new KimiCodingProvider());
  registry.register(new DashScopeProvider());
  registry.register(new BaiduWenxinProvider());
  registry.register(new ZhipuProvider());
  registry.register(new SparkProvider());
  registry.register(new MoonshotProvider());
  registry.register(new BaichuanProvider());
  registry.register(new MiniMaxProvider());
  registry.register(new YiProvider());
  registry.register(new HunyuanProvider());
  registry.register(new SiliconFlowProvider());
  registry.register(new VolcengineCodingProvider());
  registry.register(new VolcengineArkProvider());
  return registry;
}

export function providerFromProfile(provider: ModelProfile["provider"], baseUrl?: string, registry = defaultProviderRegistry) {
  if (provider === "openrouter") return registry.get("openrouter_api_key");
  if (provider === "anthropic") return registry.get("anthropic_api_key");
  if (provider === "gemini") return registry.get("gemini_api_key");
  if (provider === "deepseek") return registry.get("deepseek_api_key");
  if (provider === "huggingface") return registry.get("huggingface_api_key");
  if (provider === "copilot") return registry.get("github_copilot");
  if (provider === "copilot_acp") return registry.get("github_copilot_acp");
  return registry.getByModelOrUrl("", baseUrl);
}

export const defaultProviderRegistry = createDefaultProviderRegistry();

function local(sourceType: ModelSourceType, label: string, baseUrl: string | undefined, modelPlaceholder: string): ModelSourceDefinition {
  return {
    sourceType,
    family: "custom_endpoint",
    authMode: "optional_api_key",
    label,
    provider: "custom",
    baseUrl,
    keyOptional: true,
    modelPlaceholder,
  };
}

function normalizeDefinition(definition: ModelSourceDefinition): ModelSourceDefinition {
  const group = definition.group ?? inferGroup(definition);
  const roleCapabilities = definition.roleCapabilities ?? inferRoleCapabilities(definition);
  const runtimeCompatibility = definition.runtimeCompatibility ?? inferRuntimeCompatibility(definition);
  return {
    ...definition,
    group,
    description: definition.description ?? inferDescription(definition, runtimeCompatibility),
    keywords: definition.keywords ?? inferKeywords(definition),
    badge: definition.badge ?? (isCodingPlanSource(definition.sourceType) ? "Coding Plan" : undefined),
    requiredAuthFields: definition.requiredAuthFields ?? inferRequiredAuthFields(definition),
    roleCapabilities,
    runtimeCompatibility,
  };
}

function inferGroup(definition: ModelSourceDefinition): ModelProviderGroup {
  if (definition.sourceType === "openai_compatible") return "recommended";
  if (["ollama", "vllm", "sglang", "lm_studio", "legacy"].includes(definition.sourceType)) return "local";
  if (["dashscope_api_key", "baidu_wenxin_api_key", "zhipu_api_key", "spark_api_key", "moonshot_api_key", "baichuan_api_key", "minimax_api_key", "yi_api_key", "hunyuan_api_key", "siliconflow_api_key", "volcengine_ark_api_key", "volcengine_coding_api_key", "dashscope_coding_api_key", "zhipu_coding_api_key", "baidu_qianfan_coding_api_key", "tencent_token_plan_api_key", "tencent_hunyuan_token_plan_api_key", "minimax_token_plan_api_key", "kimi_coding_api_key", "deepseek_api_key"].includes(definition.sourceType)) return "china";
  return "international";
}

function inferRoleCapabilities(definition: ModelSourceDefinition): ModelRole[] {
  if (isCodingPlanSource(definition.sourceType)) return ["coding_plan"];
  if (inferRuntimeCompatibility(definition) === "connection_only") return [];
  return ["chat"];
}

function inferRuntimeCompatibility(definition: ModelSourceDefinition): RuntimeCompatibility {
  if (definition.sourceType === "baidu_wenxin_api_key") return "proxy";
  if (["spark_api_key", "baichuan_api_key", "minimax_api_key", "yi_api_key", "hunyuan_api_key"].includes(definition.sourceType)) return "connection_only";
  if (definition.authMode === "external_process") return "connection_only";
  return "runtime";
}

function inferDescription(definition: ModelSourceDefinition, runtimeCompatibility: RuntimeCompatibility) {
  if (isCodingPlanSource(definition.sourceType)) return `${definition.label} 专用入口，使用独立 base URL。`;
  if (runtimeCompatibility === "proxy") return `${definition.label}，运行时通过本地 OpenAI 兼容代理转换协议。`;
  if (runtimeCompatibility === "connection_only") return `${definition.label} 当前可测试和保存，运行态适配待补齐。`;
  return definition.family === "custom_endpoint" ? "兼容 OpenAI /v1/chat/completions 的模型服务。" : `${definition.label} 官方或兼容接口。`;
}

function inferKeywords(definition: ModelSourceDefinition) {
  return [
    definition.label,
    definition.sourceType.replace(/_/g, " "),
    definition.provider,
    definition.baseUrl,
    definition.presetModels?.join(" "),
  ].filter((item): item is string => Boolean(item?.trim()));
}

function inferRequiredAuthFields(definition: ModelSourceDefinition): Array<"api_key" | "secret_key" | "api_password"> {
  if (definition.sourceType === "baidu_wenxin_api_key") return ["api_key", "secret_key"];
  if (definition.sourceType === "spark_api_key") return ["api_password"];
  if (definition.authMode === "api_key") return ["api_key"];
  return [];
}

function isCodingPlanSource(sourceType: ModelSourceType) {
  return [
    "volcengine_coding_api_key",
    "dashscope_coding_api_key",
    "zhipu_coding_api_key",
    "baidu_qianfan_coding_api_key",
    "tencent_token_plan_api_key",
    "tencent_hunyuan_token_plan_api_key",
    "minimax_token_plan_api_key",
    "kimi_coding_api_key",
  ].includes(sourceType);
}

function portFallback(baseUrl?: string): ModelSourceType {
  const text = (baseUrl ?? "").toLowerCase();
  if (text.includes(":11434")) return "ollama";
  if (text.includes(":1234")) return "lm_studio";
  if (text.includes(":8000")) return "vllm";
  if (text.includes(":30000")) return "sglang";
  return "openai_compatible";
}
