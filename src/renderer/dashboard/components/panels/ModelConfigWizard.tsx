import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Cloud, KeyRound, Loader2, Network, PlugZap, Server, ShieldCheck, Sparkles } from "lucide-react";
import type { LocalModelDiscoveryResult, ModelCapabilityRole, ModelConnectionTestResult, ModelSourceType } from "../../../../shared/types";
import { stableModelProfileId } from "../../../../shared/model-config";
import { cn } from "../../DashboardPrimitives";

type ModelSummary = {
  sourceType?: string;
  currentModel?: string;
  baseUrl?: string;
  secretStatus?: string;
  message?: string;
  recommendedFix?: string;
};

type OverviewModels = {
  defaultProfileId?: string;
  providerProfiles: Array<{ id: string; provider: string; label: string; apiKeySecretRef?: string }>;
  modelProfiles: Array<{
    id: string;
    name?: string;
    provider: string;
    model: string;
    baseUrl?: string;
    secretRef?: string;
    sourceType?: ModelSourceType;
    authMode?: string;
    agentRole?: ModelCapabilityRole;
    supportsTools?: boolean;
    supportsVision?: boolean;
    maxTokens?: number;
    lastHealthSummary?: string;
    lastHealthStatus?: string;
  }>;
  summary?: ModelSummary;
};

type SecretMeta = { ref: string; exists: boolean };

type ProviderPreset = {
  id: ModelSourceType;
  label: string;
  family: "API Key 型" | "OAuth / 本地凭据型" | "Custom Endpoint 型";
  authHint: string;
  baseUrl?: string;
  defaultModel?: string;
  modelPlaceholder: string;
  keyMode: "required" | "optional";
  icon: typeof Server;
  providerMode: "select" | "manual";
  modelOptions?: string[];
  description: string;
  authModeToStore: "api_key" | "oauth" | "local_credentials" | "external_process" | "optional_api_key";
};

const PROVIDERS: ProviderPreset[] = [
  {
    id: "openai_compatible",
    label: "OpenAI-compatible",
    family: "Custom Endpoint 型",
    authHint: "兼容 /v1/chat/completions",
    baseUrl: "http://127.0.0.1:8080/v1",
    modelPlaceholder: "填写兼容网关模型 ID",
    keyMode: "optional",
    icon: PlugZap,
    providerMode: "manual",
    description: "适合 MiniMax、DeepSeek、通义、Kimi、智谱、硅基流动和各类 OpenAI 兼容网关。",
    authModeToStore: "optional_api_key",
  },
  {
    id: "openrouter_api_key",
    label: "OpenRouter",
    family: "API Key 型",
    authHint: "需要 API Key",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4-5",
    modelOptions: ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"],
    modelPlaceholder: "选择或填写 OpenRouter 模型 ID",
    keyMode: "required",
    icon: Network,
    providerMode: "select",
    description: "统一接多个云模型，适合主模型。",
    authModeToStore: "api_key",
  },
  {
    id: "anthropic_api_key",
    label: "Anthropic API Key",
    family: "API Key 型",
    authHint: "需要 API Key",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-5",
    modelOptions: ["claude-sonnet-4-5", "claude-opus-4"],
    modelPlaceholder: "选择或填写 Anthropic 模型 ID",
    keyMode: "required",
    icon: Cloud,
    providerMode: "select",
    description: "Anthropic 官方 API。",
    authModeToStore: "api_key",
  },
  {
    id: "gemini_api_key",
    label: "Gemini API Key",
    family: "API Key 型",
    authHint: "需要 API Key",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-pro",
    modelOptions: ["gemini-2.5-pro", "gemini-2.5-flash"],
    modelPlaceholder: "选择或填写 Gemini 模型 ID",
    keyMode: "required",
    icon: Cloud,
    providerMode: "select",
    description: "Google AI Studio / Gemini API。",
    authModeToStore: "api_key",
  },
  {
    id: "deepseek_api_key",
    label: "DeepSeek API Key",
    family: "API Key 型",
    authHint: "需要 API Key",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    modelOptions: ["deepseek-chat", "deepseek-reasoner"],
    modelPlaceholder: "选择或填写 DeepSeek 模型 ID",
    keyMode: "required",
    icon: Network,
    providerMode: "select",
    description: "DeepSeek 官方 API。",
    authModeToStore: "api_key",
  },
  {
    id: "huggingface_api_key",
    label: "Hugging Face API Key",
    family: "API Key 型",
    authHint: "需要 HF_TOKEN",
    baseUrl: "https://router.huggingface.co/v1",
    modelPlaceholder: "填写 Hugging Face 模型 ID",
    keyMode: "required",
    icon: Cloud,
    providerMode: "manual",
    description: "Hugging Face Router。",
    authModeToStore: "api_key",
  },
  {
    id: "gemini_oauth",
    label: "Gemini OAuth",
    family: "OAuth / 本地凭据型",
    authHint: "依赖本机 OAuth",
    defaultModel: "gemini-2.5-pro",
    modelOptions: ["gemini-2.5-pro", "gemini-2.5-flash"],
    modelPlaceholder: "选择模型",
    keyMode: "optional",
    icon: PlugZap,
    providerMode: "select",
    description: "依赖本机已有 Gemini OAuth，不按 API Key 处理。",
    authModeToStore: "oauth",
  },
  {
    id: "anthropic_local_credentials",
    label: "Anthropic 本地凭据",
    family: "OAuth / 本地凭据型",
    authHint: "依赖本机凭据",
    defaultModel: "claude-sonnet-4-5",
    modelOptions: ["claude-sonnet-4-5", "claude-opus-4"],
    modelPlaceholder: "选择模型",
    keyMode: "optional",
    icon: PlugZap,
    providerMode: "select",
    description: "依赖本机已有 Anthropic / Claude 凭据。",
    authModeToStore: "local_credentials",
  },
  {
    id: "github_copilot",
    label: "GitHub Copilot / Models",
    family: "OAuth / 本地凭据型",
    authHint: "依赖本机 GitHub token",
    baseUrl: "https://models.github.ai/inference/v1",
    modelPlaceholder: "填写 GitHub Models 模型 ID",
    keyMode: "optional",
    icon: PlugZap,
    providerMode: "manual",
    description: "优先检查本机 GH_TOKEN / COPILOT_GITHUB_TOKEN。",
    authModeToStore: "local_credentials",
  },
  {
    id: "github_copilot_acp",
    label: "GitHub Copilot ACP",
    family: "OAuth / 本地凭据型",
    authHint: "依赖 ACP 外部进程",
    modelPlaceholder: "填写 ACP 暴露的模型 ID",
    keyMode: "optional",
    icon: PlugZap,
    providerMode: "manual",
    description: "不再按普通 API Key provider 处理。",
    authModeToStore: "external_process",
  },
  {
    id: "ollama",
    label: "Ollama",
    family: "Custom Endpoint 型",
    authHint: "API Key 可空",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelPlaceholder: "填写 Ollama 模型名",
    keyMode: "optional",
    icon: Server,
    providerMode: "manual",
    description: "会检查 localhost 在 WSL 中是否可达。",
    authModeToStore: "optional_api_key",
  },
  {
    id: "vllm",
    label: "vLLM",
    family: "Custom Endpoint 型",
    authHint: "API Key 可空",
    baseUrl: "http://127.0.0.1:8000/v1",
    modelPlaceholder: "填写 vLLM 模型 ID",
    keyMode: "optional",
    icon: Server,
    providerMode: "manual",
    description: "会检查 context length 与 tool calling。",
    authModeToStore: "optional_api_key",
  },
  {
    id: "sglang",
    label: "SGLang",
    family: "Custom Endpoint 型",
    authHint: "API Key 可空",
    baseUrl: "http://127.0.0.1:30000/v1",
    modelPlaceholder: "填写 SGLang 模型 ID",
    keyMode: "optional",
    icon: Server,
    providerMode: "manual",
    description: "会检查 context length 与 tool calling。",
    authModeToStore: "optional_api_key",
  },
  {
    id: "lm_studio",
    label: "LM Studio",
    family: "Custom Endpoint 型",
    authHint: "API Key 可空",
    baseUrl: "http://127.0.0.1:1234/v1",
    modelPlaceholder: "填写 LM Studio 已加载模型",
    keyMode: "optional",
    icon: Server,
    providerMode: "manual",
    description: "支持自动探测。",
    authModeToStore: "optional_api_key",
  },
];

const PROVIDER_GROUPS: Array<{ label: string; ids: ModelSourceType[] }> = [
  { label: "推荐 / 通用", ids: ["openai_compatible"] },
  { label: "API Key 型", ids: ["openrouter_api_key", "anthropic_api_key", "gemini_api_key", "deepseek_api_key", "huggingface_api_key"] },
  { label: "OAuth / 本地凭据型", ids: ["gemini_oauth", "anthropic_local_credentials", "github_copilot", "github_copilot_acp"] },
  { label: "本地 / 自托管", ids: ["ollama", "vllm", "sglang", "lm_studio"] },
];

const MIN_AGENT_CONTEXT = 16000;
const DEFAULT_MAX_CONTEXT = 256_000;

export function ModelConfigWizard(props: {
  models: OverviewModels;
  secrets: SecretMeta[];
  onRefresh: () => Promise<void>;
  onSaved: (message: string) => void;
}) {
  const currentProfile = props.models.modelProfiles.find((item) => item.id === props.models.defaultProfileId) ?? props.models.modelProfiles[0];
  const initialDraft = draftStateForProfile(props.models, currentProfile?.id);
  const [editingProfileId, setEditingProfileId] = useState<string | undefined>(currentProfile?.id);
  const [sourceType, setSourceType] = useState<ModelSourceType>(initialDraft.sourceType);
  const [baseUrl, setBaseUrl] = useState(initialDraft.baseUrl);
  const [model, setModel] = useState(initialDraft.model);
  const [secretRef, setSecretRef] = useState(initialDraft.secretRef);
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<ModelConnectionTestResult | undefined>();
  const [discovery, setDiscovery] = useState<LocalModelDiscoveryResult | undefined>();
  const [busyAction, setBusyAction] = useState<"discover" | "test" | "save" | undefined>();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);

  useEffect(() => {
    const nextCurrent = props.models.modelProfiles.find((item) => item.id === editingProfileId)
      ?? props.models.modelProfiles.find((item) => item.id === props.models.defaultProfileId)
      ?? props.models.modelProfiles[0];
    const next = draftStateForProfile(props.models, nextCurrent?.id);
    setEditingProfileId(nextCurrent?.id);
    setSourceType(next.sourceType);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setSecretRef(next.secretRef);
    setApiKey("");
    setTestResult(undefined);
    setDiscovery(undefined);
    setShowAdvanced(false);
    setProviderMenuOpen(false);
  }, [props.models.defaultProfileId, props.models.modelProfiles]);

  const provider = providerFor(sourceType);
  const effectiveSecretRef = secretRef.trim() || defaultSecretRefForSource(sourceType);
  const hasStoredSecret = props.secrets.some((item) => item.ref === effectiveSecretRef && item.exists);
  const testOk = Boolean(testResult?.ok);
  const canUseSavedSecret = hasStoredSecret || Boolean(apiKey.trim()) || !sourceNeedsKey(sourceType);
  const shouldAutoDiscover = ["ollama", "vllm", "sglang", "lm_studio", "openai_compatible"].includes(sourceType);
  const currentEditingProfile = editingProfileId ? props.models.modelProfiles.find((item) => item.id === editingProfileId) : undefined;
  const pendingProviderId = providerIdForSource(sourceType);
  const pendingProfileIsCurrent = Boolean(currentEditingProfile && sameModelIdentity(currentEditingProfile, {
    provider: pendingProviderId,
    model: model.trim(),
    baseUrl: baseUrl.trim(),
  }));
  const willCreateNewProfile = !editingProfileId || !pendingProfileIsCurrent;

  const modelOptions = useMemo(
    () => {
      const discovered = testResult?.availableModels?.length ? testResult.availableModels : discovery?.recommendedModel ? [discovery.recommendedModel] : [];
      const preset = provider.modelOptions ?? [];
      return Array.from(new Set([...preset, ...discovered].filter(Boolean)));
    },
    [discovery?.recommendedModel, provider.modelOptions, testResult?.availableModels],
  );

  function updateSource(nextSource: ModelSourceType) {
    const next = draftStateForNewProfile(nextSource);
    setSourceType(nextSource);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setSecretRef(next.secretRef);
    setApiKey("");
    setDiscovery(undefined);
    setTestResult(undefined);
    setShowAdvanced(false);
    setProviderMenuOpen(false);
  }

  function createNewProfile(nextSource: ModelSourceType = sourceType) {
    const next = draftStateForNewProfile(nextSource);
    setEditingProfileId(undefined);
    setSourceType(next.sourceType);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setSecretRef(next.secretRef);
    setApiKey("");
    setDiscovery(undefined);
    setTestResult(undefined);
    setShowAdvanced(false);
    setProviderMenuOpen(false);
  }

  function editProfile(profileId: string) {
    const next = draftStateForProfile(props.models, profileId);
    setEditingProfileId(profileId);
    setSourceType(next.sourceType);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setSecretRef(next.secretRef);
    setApiKey("");
    setDiscovery(undefined);
    setTestResult(undefined);
    setShowAdvanced(false);
    setProviderMenuOpen(false);
  }

  function updateBaseUrl(value: string) {
    setBaseUrl(value);
    setTestResult(undefined);
  }

  function updateModel(value: string) {
    setModel(value);
    setTestResult(undefined);
  }

  function updateApiKey(value: string) {
    setApiKey(value);
    setTestResult(undefined);
  }

  async function discoverLocal() {
    setBusyAction("discover");
    try {
      const result = await window.workbenchClient.discoverLocalModelSources();
      setDiscovery(result);
      if (result.recommendedBaseUrl) updateBaseUrl(result.recommendedBaseUrl);
      if (result.recommendedModel && !model.trim()) updateModel(result.recommendedModel);
    } finally {
      setBusyAction(undefined);
    }
  }

  async function testConnection() {
    setBusyAction("test");
    setTestResult(undefined);
    try {
      const ref = await ensureSecretIfNeeded(sourceType);
      const result = await window.workbenchClient.testModelConnection({
        sourceType,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        secretRef: ref,
        maxTokens: DEFAULT_MAX_CONTEXT,
      });
      setTestResult(result);
    } finally {
      setBusyAction(undefined);
    }
  }

  async function saveModel() {
    setBusyAction("save");
    try {
      const ref = await ensureSecretIfNeeded(sourceType);
      const health = await window.workbenchClient.testModelConnection({
        sourceType,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        secretRef: ref,
        maxTokens: DEFAULT_MAX_CONTEXT,
      });
      setTestResult(health);
      const nextProviderId = providerIdForSource(sourceType);
      const profileId = editingProfileId && sameModelIdentity(currentEditingProfile, {
        provider: nextProviderId,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
      }) ? editingProfileId : buildProfileId({
        provider: nextProviderId,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        existingProfiles: props.models.modelProfiles,
      });
      const nextProfile = {
        id: profileId,
        name: friendlyProfileName(sourceType, model.trim()),
        provider: nextProviderId,
        sourceType,
        authMode: provider.authModeToStore,
        model: model.trim(),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(ref ? { secretRef: ref } : {}),
        maxTokens: health.contextWindow ?? DEFAULT_MAX_CONTEXT,
        ...(health.agentRole ? { agentRole: health.agentRole } : {}),
        ...(typeof health.supportsTools === "boolean" ? { supportsTools: health.supportsTools } : {}),
        ...(typeof health.supportsVision === "boolean" ? { supportsVision: health.supportsVision } : {}),
        lastHealthCheckAt: new Date().toISOString(),
        lastHealthStatus: health.ok ? "ready" : "warning",
        lastHealthSummary: health.message,
      };
      const nextProfiles = [
        ...props.models.modelProfiles.filter((item) => item.id !== profileId),
        nextProfile,
      ];
      const nextDefaultProfileId = health.agentRole === "primary_agent"
        ? (props.models.defaultProfileId ?? profileId)
        : props.models.defaultProfileId;
      await window.workbenchClient.updateModelConfig({
        defaultProfileId: nextDefaultProfileId,
        modelProfiles: nextProfiles,
      });
      await props.onRefresh();
      setEditingProfileId(profileId);
      props.onSaved(health.agentRole === "primary_agent"
        ? (props.models.defaultProfileId ? "模型已保存" : "模型已保存，并设为默认")
        : "模型已保存为辅助/待确认来源，未自动设为默认");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function setDefaultProfile(profileId: string) {
    const profile = props.models.modelProfiles.find((item) => item.id === profileId);
    console.info("[Hermes Forge] default model click", {
      clickedModel: profile,
      clickedModelId: profileId,
      previousDefaultModelId: props.models.defaultProfileId,
    });
    if (!profileId?.trim()) {
      setTestResult({
        ok: false,
        profileId: "",
        sourceType: "legacy",
        message: "这个模型缺少稳定 ID，无法设为默认。请先重新保存一次模型配置。",
        failureCategory: "manual_action_required",
        recommendedFix: "点击编辑并保存模型，系统会补齐稳定 ID。",
      });
      return;
    }
    if (!profile) {
      setTestResult({
        ok: false,
        profileId,
        sourceType: "legacy",
        message: "模型列表里没有找到这个配置，无法设为默认。",
        failureCategory: "manual_action_required",
        recommendedFix: "请重新检测配置或重新导入旧配置。",
      });
      return;
    }
    const result = await window.workbenchClient.setDefaultModel(profileId);
    if (!result.success) {
      setTestResult({
        ok: false,
        profileId,
        sourceType: profile.sourceType ?? inferSourceType(profile.provider, profile.baseUrl),
        message: result.message ?? "默认模型切换失败。",
        failureCategory: "manual_action_required",
        recommendedFix: result.code === "HERMES_SYNC_FAILED"
          ? "配置已保存但 Hermes 同步失败，请重新检测环境或重启 Gateway。"
          : "请重新检测配置后再试。",
      });
      return;
    }
    await props.onRefresh();
    props.onSaved(result.message ?? "默认模型已切换");
  }

  async function deleteProfile(profileId: string) {
    const nextProfiles = props.models.modelProfiles.filter((item) => item.id !== profileId);
    await window.workbenchClient.updateModelConfig({
      defaultModelId: props.models.defaultProfileId === profileId ? nextProfiles[0]?.id : props.models.defaultProfileId,
      modelProfiles: nextProfiles,
    });
    await props.onRefresh();
    if (editingProfileId === profileId) {
      const fallback = nextProfiles.find((item) => item.id === props.models.defaultProfileId) ?? nextProfiles[0];
      if (fallback) editProfile(fallback.id);
      else createNewProfile("openai_compatible");
    }
    props.onSaved("模型已删除");
  }

  async function ensureSecretIfNeeded(targetSource: ModelSourceType) {
    const trimmedInput = apiKey.trim();
    const nextRef = secretRef.trim() || defaultSecretRefForSource(targetSource);
    if (trimmedInput) {
      await window.workbenchClient.saveSecret({ ref: nextRef, plainText: trimmedInput });
      setSecretRef(nextRef);
      return nextRef;
    }
    if (!sourceNeedsKey(targetSource) && !hasStoredSecret) {
      return undefined;
    }
    return nextRef || undefined;
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 bg-slate-50/60 px-6 py-10 text-center">
          <div className="mx-auto inline-flex items-center gap-3">
            <span className="text-[28px] font-semibold text-blue-500">1.</span>
            <h3 className="text-[26px] font-semibold tracking-tight text-slate-950">模型接入</h3>
          </div>
          <p className="mt-5 text-[15px] text-slate-600">先选 provider family，再选或填写模型；保存后会自动做 health check。</p>
        </div>

        <div className="px-7 py-8">
          <div className="mb-6 grid gap-3 rounded-2xl border border-slate-200/70 bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <Sparkles size={15} className="text-slate-500" />
              <p className="text-[13px] font-semibold text-slate-900">新增 provider / 认证</p>
            </div>
            <p className="text-[12px] leading-6 text-slate-500">这里用来新增来源、填 API Key、接 OAuth/本地凭据、测试连通性。底部“已保存模型”区域只负责切换默认模型。</p>
          </div>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">当前使用模型</p>
              {currentProfile ? (
                <>
                  <p className="mt-1 truncate text-[14px] font-semibold text-slate-950">{currentProfile.name ?? currentProfile.model}</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{currentProfile.baseUrl ?? providerFor(inferSourceType(currentProfile.provider, currentProfile.baseUrl)).baseUrl ?? "本地/内置来源"}</p>
                </>
              ) : (
                <p className="mt-1 text-[13px] font-semibold text-amber-700">尚未保存模型</p>
              )}
            </div>
            {currentProfile ? <StatusBadge label={currentProfile.id === props.models.defaultProfileId || !props.models.defaultProfileId ? "默认" : "已保存"} tone="default" /> : <StatusBadge label="待配置" tone="warning" />}
          </div>

          <div className="grid gap-3">
            <div className="relative">
              <button
                aria-expanded={providerMenuOpen}
                aria-label="选择 provider family"
                className="flex min-h-14 w-full items-center justify-between gap-3 border border-slate-200 bg-white px-4 text-left transition hover:bg-slate-50 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                onClick={() => setProviderMenuOpen((value) => !value)}
                type="button"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">
                    <provider.icon size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold text-slate-950">{provider.label}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-400">{provider.family} · {provider.authHint}</span>
                  </span>
                </span>
                <ChevronDown size={18} className={cn("shrink-0 text-slate-400 transition-transform", providerMenuOpen && "rotate-180")} />
              </button>

              {providerMenuOpen ? (
                <div className="absolute left-0 right-0 z-30 mt-2 max-h-[420px] overflow-auto border border-slate-200 bg-white p-2 shadow-[0_22px_70px_rgba(15,23,42,0.14)]">
                  {PROVIDER_GROUPS.map((group) => (
                    <div key={group.label} className="mb-2 last:mb-0">
                      <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{group.label}</p>
                      <div className="grid gap-1">
                        {group.ids.map((id) => {
                          const item = providerFor(id);
                          const configured = getSourceCardStatus(props.models, props.secrets, id);
                          const Icon = item.icon;
                          const selected = sourceType === id;
                          return (
                            <button
                              key={id}
                              className={cn(
                                "flex items-center gap-3 rounded-xl px-3 py-3 text-left transition",
                                selected ? "bg-slate-950 text-white" : "text-slate-700 hover:bg-slate-50",
                              )}
                              onClick={() => updateSource(id)}
                              type="button"
                            >
                              <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", selected ? "bg-white/12" : "bg-slate-100 text-slate-500")}>
                                <Icon size={16} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-semibold">{item.label}</span>
                                <span className={cn("mt-0.5 block text-[11px]", selected ? "text-white/65" : "text-slate-400")}>
                                  {item.family} · {item.description}
                                </span>
                              </span>
                              <StatusBadge label={configured.isDefault ? "默认" : configured.label} tone={selected ? "selected" : configured.tone} />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
                <span className="text-[12px] font-medium text-slate-500">模型名称 / Model ID</span>
                <span className="text-[11px] text-slate-400">{provider.providerMode === "select" ? "建议先从列表选，再按需手填" : "优先从测试结果选择，也可手填"}</span>
              </div>
              <input
                aria-label="添加模型名称"
                list="hermes-model-options"
                value={model}
                onChange={(event) => updateModel(event.target.value)}
                className="h-12 w-full bg-white px-4 font-mono text-[15px] text-slate-900 outline-none transition focus:bg-slate-50"
                placeholder={provider.modelPlaceholder}
              />
              <datalist id="hermes-model-options">
                {modelOptions.map((item) => <option key={item} value={item} />)}
              </datalist>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-[12px] font-medium text-slate-500">
                <span className="mb-1.5 block">Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(event) => updateBaseUrl(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-[13px] text-slate-800 outline-none transition focus:border-slate-300 focus:bg-white focus:ring-2 focus:ring-slate-900/10"
                  placeholder={provider.baseUrl ?? "某些 OAuth / 本地凭据来源不必手填"}
                />
              </label>

              <label className="block text-[12px] font-medium text-slate-500">
                <span className="mb-1.5 flex items-center justify-between gap-2">
                  <span>{provider.family === "OAuth / 本地凭据型" ? "凭据 / Token（可选）" : `API Key ${provider.keyMode === "optional" ? "（可选）" : ""}`}</span>
                  <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold", hasStoredSecret ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
                    <KeyRound size={11} />
                    {hasStoredSecret ? "已保存" : "未保存"}
                  </span>
                </span>
                <input
                  value={apiKey}
                  onChange={(event) => updateApiKey(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-800 outline-none transition focus:border-slate-300 focus:bg-white focus:ring-2 focus:ring-slate-900/10"
                  placeholder={provider.family === "OAuth / 本地凭据型" ? "本机已有凭据可留空；若你有 token，也可填" : provider.keyMode === "required" ? "粘贴 API Key" : "本地接口无鉴权可留空；云接口请填写"}
                  type="password"
                />
              </label>
            </div>

            <button
              className="h-12 w-full border border-slate-200 bg-white px-4 text-[15px] font-semibold text-slate-950 transition hover:bg-slate-50"
              onClick={() => createNewProfile(sourceType)}
              type="button"
            >
              新增模型草稿
            </button>

            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
              <button
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                disabled={busyAction === "test" || (provider.family !== "OAuth / 本地凭据型" && !baseUrl.trim()) || !model.trim() || !canUseSavedSecret}
                onClick={() => void testConnection()}
                type="button"
              >
                <span className="inline-flex items-center gap-2">
                  {busyAction === "test" ? <Loader2 size={14} className="animate-spin" /> : null}
                  {busyAction === "test" ? "测试中..." : "立即测试"}
                </span>
              </button>
              <button
                className="rounded-xl bg-slate-950 px-4 py-2 text-[13px] font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                disabled={!testOk || busyAction === "save"}
                onClick={() => void saveModel()}
                type="button"
              >
                <span className="inline-flex items-center gap-2">
                  {busyAction === "save" ? <Loader2 size={14} className="animate-spin" /> : null}
                  {busyAction === "save" ? "保存中..." : willCreateNewProfile ? "新增并复检" : "保存并复检"}
                </span>
              </button>
            </div>
          </div>

          <p className="mt-5 text-[14px] leading-7 text-slate-500">
            {providerIntro(sourceType)}
            <a className="ml-1 font-medium text-blue-600 underline decoration-blue-200 underline-offset-4" href="https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/" rel="noreferrer" target="_blank">
              查看标准说明
            </a>
          </p>
        </div>

        <div className="border-t border-slate-100 px-7 py-8">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-[14px] text-slate-500">已配置模型 / 切换默认模型</p>
              <p className="mt-1 text-[12px] text-slate-400">这里和“新增 provider / 认证”分开；主模型切换只在这里做。</p>
            </div>
            <button
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
              onClick={() => createNewProfile("openai_compatible")}
              type="button"
            >
              添加模型
            </button>
          </div>
          {props.models.modelProfiles.length ? (
            <div className="grid gap-3">
              {props.models.modelProfiles.map((profile) => {
                const profileSource = inferSourceType(profile.provider, profile.baseUrl);
                const isDefault = profile.id === props.models.defaultProfileId || (!props.models.defaultProfileId && profile.id === currentProfile?.id);
                const isEditing = profile.id === editingProfileId;
                return (
                  <div key={profile.id} className={cn("rounded-2xl border px-4 py-3", isEditing ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white")}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-[14px] font-semibold text-slate-900">{profile.name ?? profile.model}</p>
                          {isDefault ? <StatusBadge label="默认" tone="default" /> : null}
                          <StatusBadge label={providerFor(profileSource).label} tone="muted" />
                          {profile.agentRole ? <StatusBadge label={roleLabel(profile.agentRole)} tone={profile.agentRole === "primary_agent" ? "success" : "warning"} /> : null}
                        </div>
                        <p className="mt-1 break-all font-mono text-[12px] text-slate-500">{profile.model}</p>
                        <p className="mt-1 text-[11px] text-slate-400">{profile.baseUrl ?? providerFor(profileSource).baseUrl}</p>
                        {profile.lastHealthSummary ? <p className="mt-2 text-[11px] text-slate-500">{profile.lastHealthSummary}</p> : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {!isDefault ? (
                          <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 hover:bg-slate-50" onClick={() => void setDefaultProfile(profile.id)} type="button">
                            设为默认
                          </button>
                        ) : null}
                        <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 hover:bg-slate-50" onClick={() => editProfile(profile.id)} type="button">
                          编辑
                        </button>
                        <button className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-[12px] font-semibold text-rose-600 hover:bg-rose-50" onClick={() => void deleteProfile(profile.id)} type="button">
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-[180px] place-items-center text-center">
              <div>
                <div className="mx-auto mb-5 grid h-16 w-16 place-items-center text-slate-300">
                  <Server size={54} strokeWidth={1.2} />
                </div>
                <p className="text-[16px] font-semibold text-slate-950">还没有已保存模型</p>
                <p className="mt-2 max-w-sm text-[12px] leading-5 text-slate-400">先在上方选择来源、测试连接，再保存成模型配置。</p>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Connection</p>
            <h3 className="mt-1 text-[15px] font-semibold text-slate-900">接入与 Health Check</h3>
          </div>
          <StatusBadge label={testOk ? "测试通过" : "等待测试"} tone={testOk ? "success" : "muted"} />
        </div>

        <div className="grid gap-3">
          <div className="flex flex-wrap gap-2">
            {shouldAutoDiscover ? (
              <button
                className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-[12px] font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-60"
                disabled={busyAction === "discover"}
                onClick={() => void discoverLocal()}
                type="button"
              >
                {busyAction === "discover" ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
                自动探测
              </button>
            ) : null}
            <button
              className="text-[12px] font-medium text-slate-500 underline decoration-slate-300 underline-offset-4 hover:text-slate-900"
              onClick={() => setShowAdvanced((value) => !value)}
              type="button"
            >
              {showAdvanced ? "收起高级项" : "高级项：密钥引用名"}
            </button>
          </div>

          {showAdvanced ? (
            <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-[12px] font-medium text-slate-500">
              <label className="block">
                <span className="mb-1.5 block">Secret Ref</span>
                <input
                  value={secretRef}
                  onChange={(event) => {
                    setSecretRef(event.target.value);
                    setTestResult(undefined);
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 font-mono text-[13px] text-slate-800 outline-none"
                  placeholder={defaultSecretRefForSource(sourceType)}
                />
              </label>
            </div>
          ) : null}
        </div>

        {discovery ? (
          <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50 p-3 text-[12px] text-blue-700">
            <p className="font-semibold">{discovery.ok ? "发现可用本地接口" : "未发现本地接口"}</p>
            <div className="mt-2 grid gap-2">
              {discovery.candidates.map((candidate) => (
                <button
                  key={candidate.baseUrl}
                  className="rounded-xl bg-white px-3 py-2 text-left text-[12px] text-slate-600"
                  onClick={() => {
                    updateBaseUrl(candidate.baseUrl);
                    if (candidate.availableModels[0]) updateModel(candidate.availableModels[0]);
                  }}
                  type="button"
                >
                  <span className="block font-mono text-slate-800">{candidate.baseUrl}</span>
                  <span className="mt-0.5 block">{candidate.availableModels.slice(0, 4).join("、") || candidate.message}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {testResult ? (
          <div className={cn("mb-3 rounded-2xl border px-4 py-3 text-[12px]", testResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700")}>
            <div className="flex items-center gap-2 font-semibold">
              {testResult.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
              {testResult.ok ? "测试通过" : "测试失败"}
            </div>
            <p className="mt-2 whitespace-pre-wrap leading-6">{testResult.message}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              {testResult.providerFamily ? <StatusBadge label={testResult.providerFamily} tone="muted" /> : null}
              {testResult.authMode ? <StatusBadge label={`auth:${testResult.authMode}`} tone="muted" /> : null}
              {testResult.agentRole ? <StatusBadge label={roleLabel(testResult.agentRole)} tone={testResult.agentRole === "primary_agent" ? "success" : "warning"} /> : null}
              {typeof testResult.contextWindow === "number" ? <StatusBadge label={`ctx:${testResult.contextWindow}`} tone={testResult.contextWindow >= MIN_AGENT_CONTEXT ? "success" : "warning"} /> : null}
              {typeof testResult.supportsTools === "boolean" ? <StatusBadge label={testResult.supportsTools ? "tool calling 可用" : "tool calling 未通过"} tone={testResult.supportsTools ? "success" : "warning"} /> : null}
              {typeof testResult.wslReachable === "boolean" ? <StatusBadge label={testResult.wslReachable ? "WSL 可达" : "WSL 不可达"} tone={testResult.wslReachable ? "success" : "warning"} /> : null}
            </div>
            {testResult.healthChecks?.length ? (
              <div className="mt-3 space-y-2">
                {testResult.healthChecks.map((item) => (
                  <div key={item.id} className="rounded-xl bg-white/70 px-3 py-2 text-[11px]">
                    <p className="font-semibold text-slate-700">{healthStepLabel(item.id)} · {item.ok ? "通过" : "失败"}</p>
                    <p className="mt-1 text-slate-600">{item.message}</p>
                    {item.detail ? <p className="mt-1 text-slate-500">{item.detail}</p> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {testResult.recommendedFix ? (
              <div className="mt-2 rounded-xl bg-white/70 px-3 py-2 font-medium">
                建议动作：{testResult.recommendedFix}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mb-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] text-slate-500">
            先测试连接。测试会检查 auth、模型发现、最小 chat、agent 能力，以及 WSL 到模型服务的可达性。
          </div>
        )}

      </section>
    </div>
  );
}

function SummaryTile(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-medium text-slate-400">{props.label}</p>
      <p className="mt-1 truncate text-[12px] font-semibold text-slate-700">{props.value}</p>
    </div>
  );
}

function providerIntro(sourceType: ModelSourceType) {
  const provider = providerFor(sourceType);
  return `${provider.description} 保存时会自动重跑 health check，并区分“可接入 provider”“可作主模型”“仅辅助模型”。`;
}

function StatusBadge(props: { label: string; tone: "success" | "warning" | "muted" | "default" | "selected" }) {
  const className =
    props.tone === "success"
      ? "bg-emerald-50 text-emerald-700"
      : props.tone === "warning"
        ? "bg-amber-50 text-amber-700"
        : props.tone === "default"
          ? "bg-blue-50 text-blue-700"
          : props.tone === "selected"
            ? "bg-white/15 text-white"
            : "bg-slate-100 text-slate-600";
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${className}`}>{props.label}</span>;
}

function draftStateForProfile(models: OverviewModels, profileId?: string) {
  const current = profileId ? models.modelProfiles.find((item) => item.id === profileId) : undefined;
  if (!current) {
    return draftStateForNewProfile("openai_compatible");
  }
  const sourceType = current.sourceType ?? inferSourceType(current.provider, current.baseUrl);
  const preset = providerFor(sourceType);
  return {
    sourceType,
    baseUrl: current.baseUrl ?? preset.baseUrl ?? "",
    model: current.model ?? "",
    secretRef: current.secretRef ?? defaultSecretRefForSource(sourceType),
    maxTokens: current.maxTokens,
  };
}

function draftStateForNewProfile(sourceType: ModelSourceType) {
  const preset = providerFor(sourceType);
  return {
    sourceType,
    baseUrl: preset.baseUrl ?? "",
    model: preset.defaultModel ?? "",
    secretRef: defaultSecretRefForSource(sourceType),
    maxTokens: undefined,
  };
}

function getSourceCardStatus(models: OverviewModels, secrets: SecretMeta[], sourceType: ModelSourceType) {
  const current = models.modelProfiles.find((item) => (item.sourceType ?? inferSourceType(item.provider, item.baseUrl)) === sourceType);
  const isDefault = current?.id === models.defaultProfileId;
  if (!current) {
    return { label: "未配置", tone: "muted" as const, isDefault };
  }
  const modelReady = Boolean(current.model?.trim());
  const baseUrlReady = providerFor(sourceType).family === "OAuth / 本地凭据型" ? true : Boolean(current.baseUrl?.trim());
  const secretReady = !sourceNeedsKey(sourceType) || secrets.some((item) => item.ref === (current.secretRef || defaultSecretRefForSource(sourceType)) && item.exists);
  if (!modelReady) return { label: "缺模型", tone: "warning" as const, isDefault };
  if (!baseUrlReady) return { label: "缺地址", tone: "warning" as const, isDefault };
  if (!secretReady) return { label: "缺 Key", tone: "warning" as const, isDefault };
  if (current.agentRole && current.agentRole !== "primary_agent") return { label: "辅助模型", tone: "warning" as const, isDefault };
  return { label: "已配置", tone: "success" as const, isDefault };
}

function providerFor(sourceType: ModelSourceType) {
  return PROVIDERS.find((item) => item.id === sourceType) ?? PROVIDERS[0];
}

function inferSourceType(provider: string, baseUrl?: string): ModelSourceType {
  if (provider === "openrouter") return "openrouter_api_key";
  if (provider === "anthropic") return "anthropic_api_key";
  if (provider === "gemini") return "gemini_api_key";
  if (provider === "deepseek") return "deepseek_api_key";
  if (provider === "huggingface") return "huggingface_api_key";
  if (provider === "copilot") return "github_copilot";
  if (provider === "copilot_acp") return "github_copilot_acp";
  if (provider === "custom") {
    const text = (baseUrl ?? "").toLowerCase();
    if (text.includes(":11434")) return "ollama";
    if (text.includes(":1234")) return "lm_studio";
    if (text.includes(":8000")) return "vllm";
    if (text.includes(":30000")) return "sglang";
    return "openai_compatible";
  }
  return "openai_compatible";
}

function buildProfileId(input: { provider: ReturnType<typeof providerIdForSource>; model: string; baseUrl?: string; existingProfiles: OverviewModels["modelProfiles"] }) {
  const base = stableModelProfileId({ provider: input.provider, model: input.model, baseUrl: input.baseUrl });
  const existingProfiles = input.existingProfiles;
  if (!existingProfiles.some((item) => item.id === base)) {
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existingProfiles.some((item) => item.id === candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

function sameModelIdentity(
  existing: Pick<OverviewModels["modelProfiles"][number], "provider" | "model" | "baseUrl"> | undefined,
  next: { provider: ReturnType<typeof providerIdForSource>; model: string; baseUrl?: string },
) {
  if (!existing) return false;
  return existing.provider === next.provider &&
    existing.model.trim() === next.model.trim() &&
    normalizeIdentityBaseUrl(existing.baseUrl) === normalizeIdentityBaseUrl(next.baseUrl);
}

function normalizeIdentityBaseUrl(value?: string) {
  return value?.trim().replace(/\/$/, "") ?? "";
}

function friendlyProfileName(sourceType: ModelSourceType, model: string) {
  const provider = providerFor(sourceType);
  return model ? `${provider.label} · ${model}` : provider.label;
}

function defaultSecretRefForSource(sourceType: ModelSourceType) {
  switch (sourceType) {
    case "openrouter_api_key": return "provider.openrouter.apiKey";
    case "anthropic_api_key": return "provider.anthropic.apiKey";
    case "gemini_api_key": return "provider.gemini.apiKey";
    case "deepseek_api_key": return "provider.deepseek.apiKey";
    case "huggingface_api_key": return "provider.huggingface.apiKey";
    case "github_copilot": return "provider.copilot.token";
    case "github_copilot_acp": return "provider.copilot-acp.token";
    case "gemini_oauth": return "provider.gemini.oauth";
    case "anthropic_local_credentials": return "provider.anthropic.local";
    case "ollama": return "provider.ollama.apiKey";
    case "vllm": return "provider.vllm.apiKey";
    case "sglang": return "provider.sglang.apiKey";
    case "lm_studio": return "provider.lmstudio.apiKey";
    default: return "provider.custom.apiKey";
  }
}

function sourceNeedsKey(sourceType: ModelSourceType) {
  return providerFor(sourceType).keyMode === "required";
}

function providerIdForSource(sourceType: ModelSourceType) {
  switch (sourceType) {
    case "openrouter_api_key": return "openrouter" as const;
    case "anthropic_api_key":
    case "anthropic_local_credentials": return "anthropic" as const;
    case "gemini_api_key":
    case "gemini_oauth": return "gemini" as const;
    case "deepseek_api_key": return "deepseek" as const;
    case "huggingface_api_key": return "huggingface" as const;
    case "github_copilot": return "copilot" as const;
    case "github_copilot_acp": return "copilot_acp" as const;
    default: return "custom" as const;
  }
}

function roleLabel(role: ModelCapabilityRole) {
  if (role === "primary_agent") return "可作主模型";
  if (role === "auxiliary_model") return "辅助模型";
  return "仅接入 provider";
}

function healthStepLabel(stepId: NonNullable<ModelConnectionTestResult["healthChecks"]>[number]["id"]) {
  if (stepId === "auth") return "鉴权";
  if (stepId === "models") return "模型发现";
  if (stepId === "chat") return "最小 Chat";
  if (stepId === "agent_capability") return "Agent 能力";
  return "WSL 可达性";
}
