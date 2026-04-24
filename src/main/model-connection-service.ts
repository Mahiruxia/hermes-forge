import { runCommand } from "../process/command-runner";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import { normalizeOpenAiCompatibleBaseUrl } from "../shared/model-config";
import type {
  LocalModelDiscoveryCandidate,
  LocalModelDiscoveryResult,
  ModelCapabilityRole,
  ModelConnectionTestResult,
  ModelHealthCheckStep,
  ModelProfile,
  ModelSourceType,
  RuntimeConfig,
} from "../shared/types";
import type { SecretVault } from "../auth/secret-vault";

const MIN_AGENT_CONTEXT = 16_000;
const LOCALHOST_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export type ModelConnectionDraft = {
  sourceType: ModelSourceType;
  profileId?: string;
  provider?: ModelProfile["provider"];
  baseUrl?: string;
  model?: string;
  secretRef?: string;
  maxTokens?: number;
};

type ModelSourceDefinition = {
  sourceType: ModelSourceType;
  family: ModelConnectionTestResult["providerFamily"];
  authMode: NonNullable<ModelConnectionTestResult["authMode"]>;
  label: string;
  provider: ModelProfile["provider"];
  baseUrl?: string;
  keyOptional?: boolean;
  modelPlaceholder: string;
  presetModels?: string[];
};

const SOURCE_DEFINITIONS: Record<ModelSourceType, ModelSourceDefinition> = {
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
    modelPlaceholder: "deepseek-chat 或 deepseek-reasoner",
    presetModels: ["deepseek-chat", "deepseek-reasoner"],
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
  ollama: {
    sourceType: "ollama",
    family: "custom_endpoint",
    authMode: "optional_api_key",
    label: "Ollama",
    provider: "custom",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyOptional: true,
    modelPlaceholder: "ollama 中已拉取的模型名",
  },
  vllm: {
    sourceType: "vllm",
    family: "custom_endpoint",
    authMode: "optional_api_key",
    label: "vLLM",
    provider: "custom",
    baseUrl: "http://127.0.0.1:8000/v1",
    keyOptional: true,
    modelPlaceholder: "vLLM 提供的模型 ID",
  },
  sglang: {
    sourceType: "sglang",
    family: "custom_endpoint",
    authMode: "optional_api_key",
    label: "SGLang",
    provider: "custom",
    baseUrl: "http://127.0.0.1:30000/v1",
    keyOptional: true,
    modelPlaceholder: "SGLang 提供的模型 ID",
  },
  lm_studio: {
    sourceType: "lm_studio",
    family: "custom_endpoint",
    authMode: "optional_api_key",
    label: "LM Studio",
    provider: "custom",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyOptional: true,
    modelPlaceholder: "LM Studio 中已加载模型",
  },
  openai_compatible: {
    sourceType: "openai_compatible",
    family: "custom_endpoint",
    authMode: "optional_api_key",
    label: "OpenAI-compatible",
    provider: "custom",
    baseUrl: "http://127.0.0.1:8080/v1",
    keyOptional: true,
    modelPlaceholder: "兼容 /v1/chat/completions 的模型 ID",
  },
  legacy: {
    sourceType: "legacy",
    family: "custom_endpoint",
    authMode: "optional_api_key",
    label: "Legacy",
    provider: "custom",
    modelPlaceholder: "legacy",
  },
};

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
  const definition = SOURCE_DEFINITIONS[sourceType];
  if (!profile.model.trim()) {
    return failure({
      profile,
      sourceType,
      family: definition.family,
      authMode: definition.authMode,
      category: "model_not_found",
      message: "模型还没选，请先从可用模型中选择，或手动填写模型 ID。",
      fix: "先选 provider family，再选择或填写模型。",
      steps: [step("models", false, "模型 ID 为空")],
    });
  }

  if (definition.family === "oauth_or_local_credentials") {
    return testCredentialBackedProvider({ profile, sourceType, definition, runtimeConfig: input.config });
  }

  if (definition.family === "api_key") {
    return testApiKeyProvider({ profile, sourceType, definition, secretVault: input.secretVault, runtimeConfig: input.config });
  }

  return testCustomEndpoint({
    profile,
    sourceType,
    definition,
    secretVault: input.secretVault,
    runtimeConfig: input.config,
    runtimeAdapterFactory: input.runtimeAdapterFactory,
    resolveHermesRoot: input.resolveHermesRoot,
  });
}

export async function discoverCustomEndpointSources(): Promise<LocalModelDiscoveryResult> {
  const candidates = [
    { baseUrl: SOURCE_DEFINITIONS.lm_studio.baseUrl!, sourceType: "lm_studio" as const },
    { baseUrl: SOURCE_DEFINITIONS.ollama.baseUrl!, sourceType: "ollama" as const },
    { baseUrl: SOURCE_DEFINITIONS.vllm.baseUrl!, sourceType: "vllm" as const },
    { baseUrl: SOURCE_DEFINITIONS.sglang.baseUrl!, sourceType: "sglang" as const },
    { baseUrl: SOURCE_DEFINITIONS.openai_compatible.baseUrl!, sourceType: "openai_compatible" as const },
  ];
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const outcome = await fetchOpenAiCompatibleModels(candidate.baseUrl, undefined);
      const record: LocalModelDiscoveryCandidate = {
        baseUrl: candidate.baseUrl,
        ok: outcome.ok,
        availableModels: outcome.availableModels,
        message: outcome.message,
        failureCategory: outcome.failureCategory,
      };
      return { ...record, sourceType: candidate.sourceType };
    }),
  );
  const firstOk = results.find((item) => item.ok);
  return {
    ok: Boolean(firstOk),
    candidates: results,
    recommendedBaseUrl: firstOk?.baseUrl,
    recommendedModel: firstOk?.availableModels[0],
    message: firstOk ? `已发现可用本地/兼容接口：${firstOk.baseUrl}` : "没有发现可直接使用的本地或兼容接口，请手动填写地址。",
  };
}

export function providerFamilyFor(sourceType: ModelSourceType): ModelConnectionTestResult["providerFamily"] {
  return SOURCE_DEFINITIONS[sourceType].family;
}

export function authModeFor(sourceType: ModelSourceType): NonNullable<ModelConnectionTestResult["authMode"]> {
  return SOURCE_DEFINITIONS[sourceType].authMode;
}

export function sourceDefinition(sourceType: ModelSourceType) {
  return SOURCE_DEFINITIONS[sourceType];
}

export function draftToModelProfile(draft: ModelConnectionDraft): ModelProfile {
  const sourceType = normalizeSourceType(draft.sourceType);
  const definition = SOURCE_DEFINITIONS[sourceType];
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

export function inferSourceType(provider: ModelProfile["provider"], baseUrl?: string): ModelSourceType {
  if (provider === "openrouter") return "openrouter_api_key";
  if (provider === "openai") return "openai_compatible";
  if (provider === "anthropic") return "anthropic_api_key";
  if (provider === "gemini") return "gemini_api_key";
  if (provider === "deepseek") return "deepseek_api_key";
  if (provider === "huggingface") return "huggingface_api_key";
  if (provider === "copilot") return "github_copilot";
  if (provider === "copilot_acp") return "github_copilot_acp";
  const text = (baseUrl ?? "").toLowerCase();
  if (text.includes(":11434")) return "ollama";
  if (text.includes(":1234")) return "lm_studio";
  if (text.includes(":8000")) return "vllm";
  if (text.includes(":30000")) return "sglang";
  return "openai_compatible";
}

export function defaultSecretRefForSource(sourceType: ModelSourceType) {
  switch (sourceType) {
    case "openrouter_api_key": return "provider.openrouter.apiKey";
    case "anthropic_api_key": return "provider.anthropic.apiKey";
    case "gemini_api_key": return "provider.gemini.apiKey";
    case "deepseek_api_key": return "provider.deepseek.apiKey";
    case "huggingface_api_key": return "provider.huggingface.apiKey";
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
  return sourceType && sourceType in SOURCE_DEFINITIONS
    ? sourceType as ModelSourceType
    : "openai_compatible";
}

function selectProfile(config: RuntimeConfig, profileId?: string) {
  return config.modelProfiles.find((item) => item.id === (profileId ?? config.defaultModelProfileId)) ?? config.modelProfiles[0];
}

async function testApiKeyProvider(input: {
  profile: ModelProfile;
  sourceType: ModelSourceType;
  definition: ModelSourceDefinition;
  secretVault: SecretVault;
  runtimeConfig: RuntimeConfig;
}): Promise<ModelConnectionTestResult> {
  if (!input.profile.secretRef) {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: input.definition.family,
      authMode: input.definition.authMode,
      category: "auth_missing",
      message: "这个 provider family 需要 API Key，但当前还没有保存。",
      fix: "先完成 provider 认证，再测试连接。",
      steps: [step("auth", false, "缺少 API Key")],
    });
  }
  if (!(await input.secretVault.hasSecret(input.profile.secretRef))) {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: input.definition.family,
      authMode: input.definition.authMode,
      category: "auth_missing",
      message: "已配置密钥引用，但当前密钥内容不存在或已失效。",
      fix: "请重新保存对应 provider 的 API Key。",
      steps: [step("auth", false, "密钥引用存在，但密钥不可用")],
    });
  }
  const apiKey = (await input.secretVault.readSecret(input.profile.secretRef)) || "";
  if (input.sourceType === "anthropic_api_key") {
    return testAnthropicProvider(input.profile, input.sourceType, apiKey);
  }
  if (input.sourceType === "gemini_api_key") {
    return testGeminiApiProvider(input.profile, input.sourceType, apiKey);
  }
  const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(input.profile.baseUrl ?? input.definition.baseUrl);
  if (!normalizedBaseUrl) {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: input.definition.family,
      authMode: input.definition.authMode,
      category: "invalid_url",
      message: "Base URL 无效，无法测试当前 provider。",
      fix: "请检查 provider 地址格式。",
      steps: [step("models", false, "Base URL 无效")],
    });
  }
  return await testOpenAiCompatibleFlow({
    profile: { ...input.profile, baseUrl: normalizedBaseUrl },
    sourceType: input.sourceType,
    authMode: input.definition.authMode,
    apiKey,
    runtimeConfig: input.runtimeConfig,
  });
}

async function testCredentialBackedProvider(input: {
  profile: ModelProfile;
  sourceType: ModelSourceType;
  definition: ModelSourceDefinition;
  runtimeConfig: RuntimeConfig;
}): Promise<ModelConnectionTestResult> {
  if (input.sourceType === "github_copilot") {
    const token = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) {
      return failure({
        profile: input.profile,
        sourceType: input.sourceType,
        family: input.definition.family,
        authMode: input.definition.authMode,
        category: "manual_action_required",
        message: "没有发现 GitHub Copilot / GitHub Models 本地凭据。",
        fix: "请先在本机完成 GitHub 凭据登录，或设置 COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN。",
        steps: [step("auth", false, "未发现本地 GitHub 凭据")],
      });
    }
    return await testOpenAiCompatibleFlow({
      profile: { ...input.profile, baseUrl: input.profile.baseUrl?.trim() || input.definition.baseUrl },
      sourceType: input.sourceType,
      authMode: input.definition.authMode,
      apiKey: token,
      runtimeConfig: input.runtimeConfig,
    });
  }
  if (input.sourceType === "anthropic_local_credentials") {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_TOKEN;
    if (!token) {
      return failure({
        profile: input.profile,
        sourceType: input.sourceType,
        family: input.definition.family,
        authMode: input.definition.authMode,
        category: "manual_action_required",
        message: "没有发现可用于 Anthropic 的本地凭据。",
        fix: "请先在本机完成 Anthropic 登录，或提供 ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN。",
        steps: [step("auth", false, "未发现本地 Anthropic 凭据")],
      });
    }
    return testAnthropicProvider(input.profile, input.sourceType, token);
  }
  if (input.sourceType === "gemini_oauth") {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: input.definition.family,
      authMode: input.definition.authMode,
      category: "manual_action_required",
      message: "Gemini OAuth 需要 Hermes CLI / 本机浏览器侧完成 OAuth，本版桌面端只做接入校验入口，不直接代做 OAuth。",
      fix: "请先在原版 Hermes CLI 中完成 Gemini OAuth，本地凭据就绪后再回来测试/保存。",
      steps: [
        step("auth", false, "需要先完成 OAuth"),
        step("models", false, "OAuth 完成前无法列出模型"),
      ],
    });
  }
  return failure({
    profile: input.profile,
    sourceType: input.sourceType,
    family: input.definition.family,
    authMode: input.definition.authMode,
    category: "manual_action_required",
    message: `${input.definition.label} 需要本机已有凭据或外部进程，本版桌面端不会把它当成普通 API key provider。`,
    fix: "请先完成本机 provider 登录/凭据配置，然后再回来测试。",
    steps: [step("auth", false, "需要本机已有凭据或外部进程")],
  });
}

async function testCustomEndpoint(input: {
  profile: ModelProfile;
  sourceType: ModelSourceType;
  definition: ModelSourceDefinition;
  secretVault: SecretVault;
  runtimeConfig: RuntimeConfig;
  runtimeAdapterFactory: RuntimeAdapterFactory;
  resolveHermesRoot: () => Promise<string>;
}): Promise<ModelConnectionTestResult> {
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(input.profile.baseUrl ?? input.definition.baseUrl) ?? "";
  } catch {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: input.definition.family,
      authMode: input.definition.authMode,
      category: "invalid_url",
      message: "Base URL 格式不正确。",
      fix: "请检查地址格式，建议填写到 /v1，例如 http://127.0.0.1:1234/v1。",
      steps: [step("models", false, "Base URL 无效")],
    });
  }
  if (!normalizedBaseUrl) {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: input.definition.family,
      authMode: input.definition.authMode,
      category: "invalid_url",
      message: "还没有填写模型服务地址。",
      fix: "请先填写 Base URL。",
      steps: [step("models", false, "Base URL 为空")],
    });
  }
  if (input.profile.secretRef && !(await input.secretVault.hasSecret(input.profile.secretRef))) {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: input.definition.family,
      authMode: input.definition.authMode,
      category: "auth_missing",
      message: "配置里引用了 API Key，但这个密钥当前不可用。",
      fix: "请重新保存 API Key，或清空这个可选密钥引用。",
      steps: [step("auth", false, "密钥引用存在，但密钥不可用")],
    });
  }
  const secret = input.profile.secretRef ? await input.secretVault.readSecret(input.profile.secretRef) : undefined;
  return await testOpenAiCompatibleFlow({
    profile: { ...input.profile, baseUrl: normalizedBaseUrl },
    sourceType: input.sourceType,
    authMode: input.definition.authMode,
    apiKey: secret,
    runtimeConfig: input.runtimeConfig,
    runtimeAdapterFactory: input.runtimeAdapterFactory,
    resolveHermesRoot: input.resolveHermesRoot,
  });
}

async function testOpenAiCompatibleFlow(input: {
  profile: ModelProfile;
  sourceType: ModelSourceType;
  authMode: NonNullable<ModelConnectionTestResult["authMode"]>;
  apiKey?: string;
  runtimeConfig: RuntimeConfig;
  runtimeAdapterFactory?: RuntimeAdapterFactory;
  resolveHermesRoot?: () => Promise<string>;
}): Promise<ModelConnectionTestResult> {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.profile.baseUrl) ?? input.profile.baseUrl ?? "";
  const steps: ModelHealthCheckStep[] = [];
  const modelInfo = await fetchOpenAiCompatibleModels(baseUrl, input.apiKey);
  steps.push(step("auth", modelInfo.authResolved, modelInfo.authResolved ? "鉴权已通过" : modelInfo.message));
  steps.push(step("models", modelInfo.ok, modelInfo.message));
  if (!modelInfo.ok) {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: providerFamilyFor(input.sourceType),
      authMode: input.authMode,
      category: modelInfo.failureCategory ?? "unknown",
      message: modelInfo.message,
      fix: modelInfo.recommendedFix,
      steps,
      normalizedBaseUrl: baseUrl,
      availableModels: modelInfo.availableModels,
      authResolved: modelInfo.authResolved,
    });
  }
  if (modelInfo.availableModels.length > 0 && !modelInfo.availableModels.includes(input.profile.model)) {
    steps.push(step("models", false, `当前 provider family 不包含模型 ${input.profile.model}`));
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: providerFamilyFor(input.sourceType),
      authMode: input.authMode,
      category: "provider_mismatch",
      message: `当前来源能连通，但模型“${input.profile.model}”不属于这组 provider / endpoint。`,
      fix: "请从返回的模型列表里重新选择，或切换到正确的 provider family。",
      steps,
      normalizedBaseUrl: baseUrl,
      availableModels: modelInfo.availableModels,
      authResolved: modelInfo.authResolved,
    });
  }
  const chat = await testOpenAiCompatibleChat(baseUrl, input.profile.model, input.apiKey);
  steps.push(step("chat", chat.ok, chat.message));
  if (!chat.ok) {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: providerFamilyFor(input.sourceType),
      authMode: input.authMode,
      category: chat.failureCategory ?? "unknown",
      message: chat.message,
      fix: chat.recommendedFix,
      steps,
      normalizedBaseUrl: baseUrl,
      availableModels: modelInfo.availableModels,
      authResolved: modelInfo.authResolved,
    });
  }
  const toolCheck = await testOpenAiCompatibleToolCalling(baseUrl, input.profile.model, input.apiKey);
  const contextWindow = input.profile.maxTokens ?? inferContextWindow(input.profile.model, modelInfo.rawModelPayload);
  const agentRole = classifyAgentRole({
    contextWindow,
    supportsTools: toolCheck.ok,
  });
  steps.push(step(
    "agent_capability",
    agentRole === "primary_agent",
    agentRole === "primary_agent"
      ? "满足 Hermes agent 主模型要求"
      : toolCheck.ok
        ? `上下文窗口只有 ${contextWindow ?? 0}，更适合作为辅助模型`
        : "tool calling 未通过，不能直接作为 Hermes 主模型",
  ));
  let wslReachable = true;
  let wslProbeUrl: string | undefined;
  let wslFix: string | undefined;
  if (input.runtimeConfig.hermesRuntime?.mode === "wsl" && input.runtimeAdapterFactory && input.resolveHermesRoot) {
    const wsl = await probeWslReachability({
      baseUrl,
      runtime: input.runtimeConfig.hermesRuntime,
      runtimeAdapterFactory: input.runtimeAdapterFactory,
      resolveHermesRoot: input.resolveHermesRoot,
    });
    wslReachable = wsl.ok;
    wslProbeUrl = wsl.testedUrl;
    wslFix = wsl.fixHint;
    steps.push(step("wsl_network", wsl.ok, wsl.message, wsl.detail));
    if (!wsl.ok) {
      return failure({
        profile: input.profile,
        sourceType: input.sourceType,
        family: providerFamilyFor(input.sourceType),
        authMode: input.authMode,
        category: "wsl_unreachable",
        message: wsl.message,
        fix: wsl.fixHint,
        steps,
        normalizedBaseUrl: baseUrl,
        availableModels: modelInfo.availableModels,
        authResolved: modelInfo.authResolved,
        contextWindow,
        supportsTools: toolCheck.ok,
        agentRole,
        wslReachable,
        wslProbeUrl,
      });
    }
  }
  if (!toolCheck.ok) {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: providerFamilyFor(input.sourceType),
      authMode: input.authMode,
      category: "tool_calling_unavailable",
      message: "这个模型服务能聊天，但 tool calling 没通过，不能直接作为 Hermes agent 主模型。",
      fix: toolCheck.recommendedFix ?? "请开启工具调用能力，或把它只作为辅助模型保存。",
      steps,
      normalizedBaseUrl: baseUrl,
      availableModels: modelInfo.availableModels,
      authResolved: modelInfo.authResolved,
      contextWindow,
      supportsTools: false,
      agentRole,
      wslReachable,
      wslProbeUrl,
    });
  }
  if (!contextWindow || contextWindow < MIN_AGENT_CONTEXT) {
    return failure({
      profile: input.profile,
      sourceType: input.sourceType,
      family: providerFamilyFor(input.sourceType),
      authMode: input.authMode,
      category: "context_too_low",
      message: `模型服务可以聊天，也支持 tool calling，但上下文窗口只有 ${contextWindow ?? 0}，不适合作为 Hermes 主模型。`,
      fix: "请填写真实的 context length（至少 16000），或把它只作为辅助模型保存。",
      steps,
      normalizedBaseUrl: baseUrl,
      availableModels: modelInfo.availableModels,
      authResolved: modelInfo.authResolved,
      contextWindow,
      supportsTools: true,
      agentRole,
      wslReachable,
      wslProbeUrl,
    });
  }
  return success({
    profile: input.profile,
    sourceType: input.sourceType,
    family: providerFamilyFor(input.sourceType),
    authMode: input.authMode,
    message: `连接成功；鉴权、模型发现、最小 chat、tool calling、${input.runtimeConfig.hermesRuntime?.mode === "wsl" ? "WSL 可达性、" : ""}agent 能力检查均已通过。`,
    steps,
    normalizedBaseUrl: baseUrl,
    availableModels: modelInfo.availableModels,
    authResolved: modelInfo.authResolved,
    contextWindow,
    supportsTools: true,
    agentRole,
    wslReachable,
    wslProbeUrl,
    recommendedFix: wslFix,
  });
}

async function testAnthropicProvider(profile: ModelProfile, sourceType: ModelSourceType, apiKey: string): Promise<ModelConnectionTestResult> {
  const baseUrl = (profile.baseUrl?.trim() || SOURCE_DEFINITIONS.anthropic_api_key.baseUrl!).replace(/\/$/, "");
  const steps: ModelHealthCheckStep[] = [];
  const modelsUrl = `${baseUrl}/v1/models`;
  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(15000),
    });
    steps.push(step("auth", response.ok, response.ok ? "鉴权已通过" : `鉴权失败（HTTP ${response.status}）`));
    if (!response.ok) {
      return failure({
        profile,
        sourceType,
        family: "api_key",
        authMode: "api_key",
        category: response.status === 401 || response.status === 403 ? "auth_invalid" : "server_error",
        message: `Anthropic 鉴权或模型发现失败（HTTP ${response.status}）。`,
        fix: "请确认 API Key 正确，并检查当前模型是否属于 Anthropic。",
        steps,
        normalizedBaseUrl: baseUrl,
      });
    }
    const payload = await response.json().catch(() => undefined) as { data?: Array<{ id?: string; context_window?: number }> } | undefined;
    const availableModels = payload?.data?.map((item) => item.id).filter((item): item is string => Boolean(item)) ?? [];
    steps.push(step("models", true, availableModels.length ? `发现 ${availableModels.length} 个模型` : "模型列表为空，继续做最小消息测试"));
    if (availableModels.length > 0 && !availableModels.includes(profile.model)) {
      return failure({
        profile,
        sourceType,
        family: "api_key",
        authMode: "api_key",
        category: "provider_mismatch",
        message: `Anthropic 当前返回的模型里没有 ${profile.model}。`,
        fix: "请从 Anthropic 可用模型里重新选择。",
        steps,
        normalizedBaseUrl: baseUrl,
        availableModels,
      });
    }
    const chatResponse = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: profile.model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    steps.push(step("chat", chatResponse.ok, chatResponse.ok ? "最小消息请求通过" : `最小消息请求失败（HTTP ${chatResponse.status}）`));
    if (!chatResponse.ok) {
      return failure({
        profile,
        sourceType,
        family: "api_key",
        authMode: "api_key",
        category: chatResponse.status === 401 || chatResponse.status === 403 ? "auth_invalid" : "server_error",
        message: `Anthropic 最小消息请求失败（HTTP ${chatResponse.status}）。`,
        fix: "请确认模型 ID、账号权限和 API Key 都正确。",
        steps,
        normalizedBaseUrl: baseUrl,
        availableModels,
      });
    }
    const toolResponse = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: profile.model,
        max_tokens: 32,
        tools: [{ name: "ping", description: "ping", input_schema: { type: "object", properties: {} } }],
        messages: [{ role: "user", content: "Call the ping tool." }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const supportsTools = toolResponse.ok;
    const contextWindow = profile.maxTokens ?? payload?.data?.find((item) => item.id === profile.model)?.context_window;
    const agentRole = classifyAgentRole({ contextWindow, supportsTools });
    steps.push(step("agent_capability", agentRole === "primary_agent", supportsTools ? "tool calling 可用" : "tool calling 不可用"));
    if (!supportsTools || !contextWindow || contextWindow < MIN_AGENT_CONTEXT) {
      return failure({
        profile,
        sourceType,
        family: "api_key",
        authMode: "api_key",
        category: !supportsTools ? "tool_calling_unavailable" : "context_too_low",
        message: !supportsTools ? "Anthropic 模型能聊天，但 tool calling 校验未通过。" : `Anthropic 模型上下文窗口只有 ${contextWindow ?? 0}。`,
        fix: !supportsTools ? "请改用支持工具调用的 Anthropic 模型。" : "请改用上下文更高的模型，或把它只作为辅助模型保存。",
        steps,
        normalizedBaseUrl: baseUrl,
        availableModels,
        contextWindow,
        supportsTools,
        agentRole,
        authResolved: true,
      });
    }
    return success({
      profile,
      sourceType,
      family: "api_key",
      authMode: "api_key",
      message: `Anthropic 连接成功，模型 ${profile.model} 可作为 Hermes 主模型。`,
      steps,
      normalizedBaseUrl: baseUrl,
      availableModels,
      contextWindow,
      supportsTools,
      agentRole,
      authResolved: true,
    });
  } catch (error) {
    return failure({
      profile,
      sourceType,
      family: "api_key",
      authMode: "api_key",
      category: "network_unreachable",
      message: `连不上 Anthropic 接口 ${modelsUrl}。`,
      fix: error instanceof Error ? error.message : "请检查网络、代理和 API 地址。",
      steps,
      normalizedBaseUrl: baseUrl,
    });
  }
}

async function testGeminiApiProvider(profile: ModelProfile, sourceType: ModelSourceType, apiKey: string): Promise<ModelConnectionTestResult> {
  const baseUrl = (profile.baseUrl?.trim() || SOURCE_DEFINITIONS.gemini_api_key.baseUrl!).replace(/\/$/, "");
  const steps: ModelHealthCheckStep[] = [];
  const modelsUrl = `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });
    steps.push(step("auth", response.ok, response.ok ? "鉴权已通过" : `鉴权失败（HTTP ${response.status}）`));
    if (!response.ok) {
      return failure({
        profile,
        sourceType,
        family: "api_key",
        authMode: "api_key",
        category: response.status === 401 || response.status === 403 ? "auth_invalid" : "server_error",
        message: `Gemini 模型列表请求失败（HTTP ${response.status}）。`,
        fix: "请确认 API Key 正确，且 Base URL 指向 Google AI Studio / Gemini 接口。",
        steps,
        normalizedBaseUrl: baseUrl,
      });
    }
    const payload = await response.json().catch(() => undefined) as { models?: Array<{ name?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }> } | undefined;
    const availableModels = payload?.models?.map((item) => item.name?.replace(/^models\//, "")).filter((item): item is string => Boolean(item)) ?? [];
    steps.push(step("models", true, availableModels.length ? `发现 ${availableModels.length} 个 Gemini 模型` : "模型列表为空，继续做最小 chat 测试"));
    if (availableModels.length > 0 && !availableModels.includes(profile.model)) {
      return failure({
        profile,
        sourceType,
        family: "api_key",
        authMode: "api_key",
        category: "provider_mismatch",
        message: `Gemini 当前返回的模型里没有 ${profile.model}。`,
        fix: "请从 Gemini 可用模型里重新选择。",
        steps,
        normalizedBaseUrl: baseUrl,
        availableModels,
      });
    }
    const chatUrl = `${baseUrl}/models/${profile.model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const chatResponse = await fetch(chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    steps.push(step("chat", chatResponse.ok, chatResponse.ok ? "最小生成请求通过" : `最小生成请求失败（HTTP ${chatResponse.status}）`));
    if (!chatResponse.ok) {
      return failure({
        profile,
        sourceType,
        family: "api_key",
        authMode: "api_key",
        category: "server_error",
        message: `Gemini 最小生成请求失败（HTTP ${chatResponse.status}）。`,
        fix: "请确认模型 ID 属于 Gemini，可用区域和账号权限也正确。",
        steps,
        normalizedBaseUrl: baseUrl,
        availableModels,
      });
    }
    const matched = payload?.models?.find((item) => item.name?.replace(/^models\//, "") === profile.model);
    const contextWindow = profile.maxTokens ?? matched?.inputTokenLimit;
    const supportsTools = Boolean(matched?.supportedGenerationMethods?.includes("generateContent"));
    const agentRole = classifyAgentRole({ contextWindow, supportsTools });
    steps.push(
      step(
        "agent_capability",
        agentRole === "primary_agent",
        agentRole === "primary_agent" ? "满足主模型要求" : "Gemini 当前只建议作为辅助模型",
      ),
    );
    if (agentRole !== "primary_agent") {
      return failure({
        profile,
        sourceType,
        family: "api_key",
        authMode: "api_key",
        category: !contextWindow || contextWindow < MIN_AGENT_CONTEXT ? "context_too_low" : "tool_calling_unavailable",
        message: "Gemini 当前能接入，但为了避免误当成全能 agent 主模型，本版默认只标记为辅助模型。",
        fix: "可继续保存为辅助模型；若要作为主模型，请确认 tool calling 和上下文窗口都满足要求。",
        steps,
        normalizedBaseUrl: baseUrl,
        availableModels,
        contextWindow,
        supportsTools,
        agentRole,
        authResolved: true,
      });
    }
    return success({
      profile,
      sourceType,
      family: "api_key",
      authMode: "api_key",
      message: `Gemini 连接成功，模型 ${profile.model} 已通过接入检查。`,
      steps,
      normalizedBaseUrl: baseUrl,
      availableModels,
      contextWindow,
      supportsTools,
      agentRole,
      authResolved: true,
    });
  } catch (error) {
    return failure({
      profile,
      sourceType,
      family: "api_key",
      authMode: "api_key",
      category: "network_unreachable",
      message: `连不上 Gemini 接口 ${modelsUrl}。`,
      fix: error instanceof Error ? error.message : "请检查网络、代理和 Google API 地址。",
      steps,
      normalizedBaseUrl: baseUrl,
    });
  }
}

async function fetchOpenAiCompatibleModels(baseUrl: string, apiKey?: string): Promise<{
  ok: boolean;
  message: string;
  failureCategory?: NonNullable<ModelConnectionTestResult["failureCategory"]>;
  recommendedFix?: string;
  availableModels: string[];
  rawModelPayload?: Array<{ id?: string; context_length?: number; context_window?: number }>;
  authResolved: boolean;
}> {
  const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : { authorization: "Bearer lm-studio" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (isOptionalModelDiscoveryStatus(response.status)) {
        return {
          ok: true,
          message: `模型列表端点不可用（HTTP ${response.status}），已跳过发现并使用手动模型名继续测试。`,
          availableModels: [] as string[],
          authResolved: true,
        };
      }
      return {
        ok: false,
        message: httpFailureMessage(response.status, response.statusText, baseUrl),
        failureCategory: httpFailureCategory(response.status),
        recommendedFix: httpFailureFix(response.status, baseUrl),
        availableModels: [] as string[],
        authResolved: !(response.status === 401 || response.status === 403),
      };
    }
    const payload = await response.json().catch(() => undefined) as { data?: Array<{ id?: string; context_length?: number; context_window?: number }> } | undefined;
    const availableModels = payload?.data?.map((item) => item.id).filter((item): item is string => Boolean(item)) ?? [];
    return {
      ok: true,
      message: availableModels.length ? `模型发现成功，共 ${availableModels.length} 个模型。` : "模型发现成功，但服务端未返回模型列表。",
      availableModels,
      rawModelPayload: payload?.data,
      authResolved: true,
    };
  } catch (error) {
    return {
      ok: false,
      message: `连不上模型服务 ${modelsUrl}。`,
      failureCategory: error instanceof Error && error.message.includes("Invalid URL") ? "invalid_url" : "network_unreachable",
      recommendedFix: error instanceof Error && error.message.includes("Invalid URL")
        ? "请检查 Base URL 格式，建议填写到 /v1。"
        : "请确认服务已经启动，而且 Base URL 指向实际监听端口和 /v1 接口。",
      availableModels: [] as string[],
      authResolved: false,
    };
  }
}

function isOptionalModelDiscoveryStatus(status: number) {
  return status === 404 || status === 405 || status === 501;
}

async function testOpenAiCompatibleChat(baseUrl: string, model: string, apiKey?: string) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey || "lm-studio"}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(15000),
    });
    return response.ok
      ? { ok: true, message: "最小 chat 请求通过。" }
      : {
        ok: false,
        message: `最小 chat 请求失败（HTTP ${response.status}）。`,
        failureCategory: httpFailureCategory(response.status),
        recommendedFix: httpFailureFix(response.status, baseUrl),
      };
  } catch (error) {
    return {
      ok: false,
      message: `连不上聊天接口 ${url}。`,
      failureCategory: "network_unreachable" as const,
      recommendedFix: error instanceof Error ? error.message : "请检查服务地址和网络。",
    };
  }
}

async function testOpenAiCompatibleToolCalling(baseUrl: string, model: string, apiKey?: string) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey || "lm-studio"}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Call the ping tool." }],
        tools: [{
          type: "function",
          function: {
            name: "ping",
            description: "ping",
            parameters: { type: "object", properties: {} },
          },
        }],
        tool_choice: {
          type: "function",
          function: { name: "ping" },
        },
        max_tokens: 32,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `tool calling 探测失败（HTTP ${response.status}）。`,
        recommendedFix: "请确认模型服务开启了 tool calling / function calling，或改用支持工具调用的模型。",
      };
    }
    const payload = await response.json().catch(() => undefined) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> } | undefined;
    const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
    return Array.isArray(toolCalls) && toolCalls.length > 0
      ? { ok: true, message: "tool calling 可用。" }
      : {
        ok: false,
        message: "接口能返回 chat，但没有返回 tool call。",
        recommendedFix: "请确认本地模型/服务端显式开启了工具调用能力。",
      };
  } catch (error) {
    return {
      ok: false,
      message: "tool calling 探测失败。",
      recommendedFix: error instanceof Error ? error.message : "请检查模型服务是否支持工具调用。",
    };
  }
}

async function probeWslReachability(input: {
  baseUrl: string;
  runtime: NonNullable<RuntimeConfig["hermesRuntime"]>;
  runtimeAdapterFactory: RuntimeAdapterFactory;
  resolveHermesRoot: () => Promise<string>;
}) {
  const adapter = input.runtimeAdapterFactory(input.runtime);
  const rootPath = input.runtime.mode === "wsl"
    ? adapter.toRuntimePath(await input.resolveHermesRoot())
    : await input.resolveHermesRoot();
  const parsed = new URL(input.baseUrl);
  const candidates = [parsed.toString().replace(/\/$/, "")];
  if (LOCALHOST_HOSTS.has(parsed.hostname)) {
    const host = await adapter.getBridgeAccessHost();
    parsed.hostname = host;
    candidates.push(parsed.toString().replace(/\/$/, ""));
  }
  for (const candidate of candidates) {
    const script = [
      "import sys, urllib.error, urllib.request",
      "url = sys.argv[1].rstrip('/') + '/models'",
      "req = urllib.request.Request(url, headers={'Authorization': 'Bearer lm-studio'})",
      "try:",
      "    with urllib.request.urlopen(req, timeout=8) as resp:",
      "        sys.exit(0 if resp.status < 500 else 3)",
      "except urllib.error.HTTPError as exc:",
      "    sys.exit(0 if exc.code < 500 else 3)",
      "except Exception:",
      "    sys.exit(2)",
    ].join("\n");
    const launch = await adapter.buildPythonLaunch({
      runtime: input.runtime,
      rootPath,
      pythonArgs: ["-c", script, candidate],
      cwd: rootPath,
      env: {
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
      },
    });
    const result = await runCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      timeoutMs: 12_000,
      env: launch.env,
      detached: launch.detached,
    });
    if (result.exitCode === 0) {
      return {
        ok: true,
        message: `WSL 可以访问模型服务：${candidate}`,
        testedUrl: candidate,
      };
    }
  }
  const isLocalhost = LOCALHOST_HOSTS.has(new URL(input.baseUrl).hostname);
  return {
    ok: false,
    message: isLocalhost
      ? "当前 Windows 宿主机上的模型服务，WSL 内 Hermes 访问不到。"
      : "WSL 内 Hermes 暂时访问不到这个模型服务地址。",
    detail: isLocalhost
      ? "这通常发生在你把模型服务绑在 localhost，但 Hermes 正跑在 WSL 里。"
      : "这通常是 WSL 网络、代理、DNS 或证书环境导致的。HTTP 4xx 会被视为服务可达，只有网络异常或 5xx 才会失败。",
    testedUrl: candidates.at(-1),
    fixHint: isLocalhost
      ? "请把模型服务绑定到 0.0.0.0，或改用 Windows host IP；若仍失败，请检查防火墙和端口监听。"
      : "请确认 WSL 内可访问公网 HTTPS，并检查代理、DNS、证书和防火墙设置。",
  };
}

function inferContextWindow(model: string, payload?: Array<{ id?: string; context_length?: number; context_window?: number }>) {
  const match = payload?.find((item) => item.id === model);
  return match?.context_length ?? match?.context_window;
}

function classifyAgentRole(input: { contextWindow?: number; supportsTools?: boolean }): ModelCapabilityRole {
  if (!input.supportsTools) {
    return "auxiliary_model";
  }
  if (!input.contextWindow || input.contextWindow < MIN_AGENT_CONTEXT) {
    return "auxiliary_model";
  }
  return "primary_agent";
}

function success(input: {
  profile: ModelProfile;
  sourceType: ModelSourceType;
  family: ModelConnectionTestResult["providerFamily"];
  authMode: ModelConnectionTestResult["authMode"];
  message: string;
  steps: ModelHealthCheckStep[];
  normalizedBaseUrl?: string;
  availableModels?: string[];
  authResolved?: boolean;
  contextWindow?: number;
  supportsTools?: boolean;
  agentRole?: ModelCapabilityRole;
  wslReachable?: boolean;
  wslProbeUrl?: string;
  recommendedFix?: string;
}): ModelConnectionTestResult {
  return {
    ok: true,
    profileId: input.profile.id,
    message: input.message,
    sourceType: input.sourceType,
    providerFamily: input.family,
    authMode: input.authMode,
    normalizedBaseUrl: input.normalizedBaseUrl,
    availableModels: input.availableModels,
    healthChecks: input.steps,
    authResolved: input.authResolved,
    contextWindow: input.contextWindow,
    supportsTools: input.supportsTools,
    agentRole: input.agentRole,
    wslReachable: input.wslReachable,
    wslProbeUrl: input.wslProbeUrl,
    recommendedFix: input.recommendedFix,
  };
}

function failure(input: {
  profile: ModelProfile;
  sourceType: ModelSourceType;
  family: ModelConnectionTestResult["providerFamily"];
  authMode: ModelConnectionTestResult["authMode"];
  category: NonNullable<ModelConnectionTestResult["failureCategory"]>;
  message: string;
  fix?: string;
  steps: ModelHealthCheckStep[];
  normalizedBaseUrl?: string;
  availableModels?: string[];
  authResolved?: boolean;
  contextWindow?: number;
  supportsTools?: boolean;
  agentRole?: ModelCapabilityRole;
  wslReachable?: boolean;
  wslProbeUrl?: string;
}): ModelConnectionTestResult {
  return {
    ok: false,
    profileId: input.profile.id,
    message: input.message,
    sourceType: input.sourceType,
    providerFamily: input.family,
    authMode: input.authMode,
    normalizedBaseUrl: input.normalizedBaseUrl,
    availableModels: input.availableModels,
    healthChecks: input.steps,
    authResolved: input.authResolved,
    contextWindow: input.contextWindow,
    supportsTools: input.supportsTools,
    agentRole: input.agentRole ?? "provider_only",
    wslReachable: input.wslReachable,
    wslProbeUrl: input.wslProbeUrl,
    failureCategory: input.category,
    recommendedFix: input.fix,
  };
}

function step(id: ModelHealthCheckStep["id"], ok: boolean, message: string, detail?: string): ModelHealthCheckStep {
  return { id, label: id, ok, message, detail };
}

function httpFailureCategory(status: number): NonNullable<ModelConnectionTestResult["failureCategory"]> {
  if (status === 401 || status === 403) return "auth_invalid";
  if (status === 404) return "path_invalid";
  if (status >= 500) return "server_error";
  return "unknown";
}

function httpFailureFix(status: number, baseUrl: string) {
  if (status === 401 || status === 403) return "请确认 provider 和 API Key 对得上。";
  if (status === 404) return `请确认地址是否指向兼容接口：${baseUrl}`;
  if (status >= 500) return "服务端当前异常，请确认模型服务已经完整启动。";
  return "请重新检查地址、模型名和鉴权方式。";
}

function httpFailureMessage(status: number, statusText: string, baseUrl: string) {
  if (status === 404) return `已经连到服务器，但接口路径不对（HTTP 404）：${baseUrl}`;
  return `模型服务返回 HTTP ${status}${statusText ? ` ${statusText}` : ""}。`;
}
