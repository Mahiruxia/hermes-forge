import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Cloud, KeyRound, Loader2, Network, PlugZap, Server } from "lucide-react";
import type { LocalModelDiscoveryResult, ModelConnectionTestResult } from "../../../../shared/types";
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
  modelProfiles: Array<{ id: string; name?: string; provider: string; model: string; baseUrl?: string; secretRef?: string }>;
  summary?: ModelSummary;
};

type SecretMeta = { ref: string; exists: boolean };
type SourceType =
  | "local_openai"
  | "openrouter"
  | "openai"
  | "deepseek"
  | "qwen"
  | "kimi"
  | "volcengine"
  | "volcengine_coding"
  | "tencent_hunyuan"
  | "minimax"
  | "zhipu"
  | "custom_gateway";

type ProviderPreset = {
  id: SourceType;
  label: string;
  badge: string;
  baseUrl: string;
  defaultModel: string;
  modelPlaceholder: string;
  keyMode: "required" | "optional";
  icon: typeof Server;
};

const PROVIDERS: ProviderPreset[] = [
  {
    id: "local_openai",
    label: "本地 OpenAI-Compatible",
    badge: "Local",
    baseUrl: "http://127.0.0.1:1234/v1",
    defaultModel: "",
    modelPlaceholder: "qwen2.5-coder 或本地已加载模型",
    keyMode: "optional",
    icon: Server,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    badge: "Cloud",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4-5",
    modelPlaceholder: "anthropic/claude-sonnet-4-5 或 openai/gpt-5",
    keyMode: "required",
    icon: Network,
  },
  {
    id: "openai",
    label: "OpenAI",
    badge: "Cloud",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    modelPlaceholder: "gpt-5.4 或 gpt-4.1",
    keyMode: "required",
    icon: Cloud,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    badge: "国内",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    modelPlaceholder: "deepseek-chat 或 deepseek-reasoner",
    keyMode: "required",
    icon: Network,
  },
  {
    id: "qwen",
    label: "阿里云百炼 / Qwen",
    badge: "国内",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3-coder-plus",
    modelPlaceholder: "qwen3-coder-plus 或 qwen-max",
    keyMode: "required",
    icon: Cloud,
  },
  {
    id: "kimi",
    label: "Moonshot / Kimi",
    badge: "国内",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.5",
    modelPlaceholder: "kimi-k2.5",
    keyMode: "required",
    icon: Cloud,
  },
  {
    id: "volcengine",
    label: "火山方舟 / 豆包",
    badge: "国内",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seed-1-6-251015",
    modelPlaceholder: "doubao-seed-1-6-251015 或你的方舟模型 ID",
    keyMode: "required",
    icon: Cloud,
  },
  {
    id: "volcengine_coding",
    label: "火山方舟 Coding Plan",
    badge: "Coding Plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    defaultModel: "ark-code-latest",
    modelPlaceholder: "ark-code-latest 或 Coding Plan 可用模型",
    keyMode: "required",
    icon: Cloud,
  },
  {
    id: "tencent_hunyuan",
    label: "腾讯混元",
    badge: "国内",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    defaultModel: "hunyuan-turbos-latest",
    modelPlaceholder: "hunyuan-turbos-latest",
    keyMode: "required",
    icon: Cloud,
  },
  {
    id: "minimax",
    label: "MiniMax",
    badge: "国内",
    baseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.7",
    modelPlaceholder: "MiniMax-M2.7 或 MiniMax-M2.5",
    keyMode: "required",
    icon: Cloud,
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    badge: "国内",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.5",
    modelPlaceholder: "glm-4.5 或 glm-4.5-flash",
    keyMode: "required",
    icon: Cloud,
  },
  {
    id: "custom_gateway",
    label: "自定义兼容网关",
    badge: "Gateway",
    baseUrl: "https://your-gateway.example.com/v1",
    defaultModel: "",
    modelPlaceholder: "你的网关模型 ID",
    keyMode: "optional",
    icon: PlugZap,
  },
];

const PROVIDER_GROUPS: Array<{ label: string; ids: SourceType[] }> = [
  { label: "推荐预设", ids: ["qwen", "kimi", "deepseek", "volcengine_coding", "openrouter", "openai"] },
  { label: "国内厂商", ids: ["volcengine", "tencent_hunyuan", "minimax", "zhipu"] },
  { label: "本地与自定义", ids: ["local_openai", "custom_gateway"] },
];

export function ModelConfigWizard(props: {
  models: OverviewModels;
  secrets: SecretMeta[];
  onRefresh: () => Promise<void>;
  onSaved: (message: string) => void;
}) {
  const currentProfile = props.models.modelProfiles.find((item) => item.id === props.models.defaultProfileId) ?? props.models.modelProfiles[0];
  const initialDraft = draftStateForProfile(props.models, currentProfile?.id);
  const [editingProfileId, setEditingProfileId] = useState<string | undefined>(currentProfile?.id);
  const [sourceType, setSourceType] = useState<SourceType>(initialDraft.sourceType);
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

  const modelOptions = useMemo(
    () => (testResult?.availableModels?.length ? testResult.availableModels : discovery?.recommendedModel ? [discovery.recommendedModel] : []),
    [discovery?.recommendedModel, testResult?.availableModels],
  );

  function updateSource(nextSource: SourceType) {
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

  function createNewProfile(nextSource: SourceType = sourceType) {
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
        sourceType: connectionSourceType(sourceType),
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        secretRef: ref,
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
      const profileId = editingProfileId ?? buildProfileId(sourceType, props.models.modelProfiles);
      const nextProfile = {
        id: profileId,
        name: friendlyProfileName(sourceType, model.trim()),
        provider: sourceType === "openai" || sourceType === "openrouter" ? sourceType : "custom",
        model: model.trim(),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(ref ? { secretRef: ref } : {}),
      };
      const nextProfiles = [
        ...props.models.modelProfiles.filter((item) => item.id !== profileId),
        nextProfile,
      ];
      await window.workbenchClient.updateModelConfig({
        defaultProfileId: props.models.defaultProfileId ?? profileId,
        modelProfiles: nextProfiles,
      });
      await props.onRefresh();
      setEditingProfileId(profileId);
      props.onSaved(props.models.defaultProfileId ? "模型已保存" : "模型已保存，并设为默认");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function setDefaultProfile(profileId: string) {
    await window.workbenchClient.updateModelConfig({
      defaultProfileId: profileId,
      modelProfiles: props.models.modelProfiles,
    });
    await props.onRefresh();
    props.onSaved("默认模型已切换");
  }

  async function deleteProfile(profileId: string) {
    const nextProfiles = props.models.modelProfiles.filter((item) => item.id !== profileId);
    await window.workbenchClient.updateModelConfig({
      defaultProfileId: props.models.defaultProfileId,
      modelProfiles: nextProfiles,
    });
    await props.onRefresh();
    if (editingProfileId === profileId) {
      const fallback = nextProfiles.find((item) => item.id === props.models.defaultProfileId) ?? nextProfiles[0];
      if (fallback) editProfile(fallback.id);
      else createNewProfile("local_openai");
    }
    props.onSaved("模型已删除");
  }

  async function ensureSecretIfNeeded(targetSource: SourceType) {
    const trimmedInput = apiKey.trim();
    const nextRef = secretRef.trim() || defaultSecretRefForSource(targetSource);
    if (trimmedInput) {
      await window.workbenchClient.saveSecret({ ref: nextRef, plainText: trimmedInput });
      setSecretRef(nextRef);
      return nextRef;
    }
    return nextRef || undefined;
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 bg-slate-50/60 px-6 py-10 text-center">
          <div className="mx-auto inline-flex items-center gap-3">
            <span className="text-[28px] font-semibold text-blue-500">1.</span>
            <h3 className="text-[26px] font-semibold tracking-tight text-slate-950">模型 (Models)</h3>
          </div>
          <p className="mt-5 text-[15px] text-slate-600">添加至少 1 个模型，Hermes Forge 才能正常工作</p>
        </div>

        <div className="px-7 py-8">
          <div className="grid gap-3">
            <div className="relative">
              <button
                aria-expanded={providerMenuOpen}
                aria-label="选择模型通道"
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
                    <span className="mt-0.5 block text-[11px] text-slate-400">{provider.badge} · {provider.keyMode === "required" ? "需要 API Key" : "API Key 可选"}</span>
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
                                  {item.badge} · {item.defaultModel || "手动填写模型"}
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
                <span className="text-[11px] text-slate-400">可选择，也可直接输入添加</span>
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

              <button
                className="h-12 w-full border border-slate-200 bg-white px-4 text-[15px] font-semibold text-slate-950 transition hover:bg-slate-50"
                onClick={() => createNewProfile(sourceType)}
                type="button"
              >
                新增模型草稿
              </button>
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
              <p className="text-[14px] text-slate-500">已保存模型</p>
              <p className="mt-1 text-[12px] text-slate-400">支持查看、编辑、删除，并显式切换默认模型。</p>
            </div>
            <button
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
              onClick={() => createNewProfile("local_openai")}
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
                        </div>
                        <p className="mt-1 break-all font-mono text-[12px] text-slate-500">{profile.model}</p>
                        <p className="mt-1 text-[11px] text-slate-400">{profile.baseUrl ?? providerFor(profileSource).baseUrl}</p>
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
                        <button className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-[12px] font-semibold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40" disabled={isDefault} onClick={() => void deleteProfile(profile.id)} type="button">
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
            <h3 className="mt-1 text-[15px] font-semibold text-slate-900">连接参数</h3>
          </div>
          <StatusBadge label={testOk ? "测试通过" : "等待测试"} tone={testOk ? "success" : "muted"} />
        </div>

        <div className="grid gap-3">
          <label className="block text-[12px] font-medium text-slate-500">
            <span className="mb-1.5 block">Base URL</span>
            <input
              value={baseUrl}
              onChange={(event) => updateBaseUrl(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-[13px] text-slate-800 outline-none transition focus:border-slate-300 focus:bg-white focus:ring-2 focus:ring-slate-900/10"
              placeholder={provider.baseUrl}
            />
          </label>

          <label className="block text-[12px] font-medium text-slate-500">
            <span className="mb-1.5 flex items-center justify-between gap-2">
              <span>API Key {provider.keyMode === "optional" ? "（可选）" : ""}</span>
              <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold", hasStoredSecret ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
                <KeyRound size={11} />
                {hasStoredSecret ? "已保存" : "未保存"}
              </span>
            </span>
            <input
              value={apiKey}
              onChange={(event) => updateApiKey(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-800 outline-none transition focus:border-slate-300 focus:bg-white focus:ring-2 focus:ring-slate-900/10"
              placeholder={provider.keyMode === "required" ? "粘贴 API Key" : "本地接口无鉴权可留空"}
              type="password"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            {sourceType === "local_openai" ? (
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
            <label className="block rounded-2xl border border-slate-200 bg-slate-50 p-3 text-[12px] font-medium text-slate-500">
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
            {testResult.recommendedFix ? (
              <div className="mt-2 rounded-xl bg-white/70 px-3 py-2 font-medium">
                建议动作：{testResult.recommendedFix}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mb-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] text-slate-500">
            先测试连接。测试通过后，保存按钮才会启用。
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            disabled={busyAction === "test" || !baseUrl.trim() || !model.trim() || !canUseSavedSecret}
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
              {busyAction === "save" ? "保存中..." : editingProfileId ? "保存模型" : "新增模型"}
            </span>
          </button>
        </div>
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

function providerIntro(sourceType: SourceType) {
  if (sourceType === "local_openai") {
    return "本地 OpenAI-Compatible 适合 LM Studio、vLLM、Ollama 中转或 New API 等本机服务。";
  }
  if (sourceType === "openrouter") {
    return "OpenRouter 适合统一接入多个云模型，建议只填写你常用的模型 ID。";
  }
  if (sourceType === "openai") {
    return "OpenAI 通道需要 API Key 和模型 ID，Base URL 默认使用官方 /v1 地址。";
  }
  if (sourceType === "volcengine") {
    return "火山方舟支持 OpenAI-compatible 调用，适合接入豆包等方舟模型。";
  }
  if (sourceType === "volcengine_coding") {
    return "火山方舟 Coding Plan 适合代码类任务，已预置 Coding Plan 专用接口地址。";
  }
  return "自定义兼容网关适合公司内网、LiteLLM、One API、New API 或其他 OpenAI-compatible 服务。";
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
    return draftStateForNewProfile("local_openai");
  }
  const sourceType = inferSourceType(current.provider, current.baseUrl);
  const preset = providerFor(sourceType);
  return {
    sourceType,
    baseUrl: current.baseUrl ?? preset.baseUrl,
    model: current.model ?? "",
    secretRef: current.secretRef ?? defaultSecretRefForSource(sourceType),
  };
}

function draftStateForNewProfile(sourceType: SourceType) {
  const preset = providerFor(sourceType);
  return {
    sourceType,
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
    secretRef: defaultSecretRefForSource(sourceType),
  };
}

function getSourceCardStatus(models: OverviewModels, secrets: SecretMeta[], sourceType: SourceType) {
  const current = models.modelProfiles.find((item) => inferSourceType(item.provider, item.baseUrl) === sourceType);
  const isDefault = current?.id === models.defaultProfileId;
  if (!current) {
    return { label: "未配置", tone: "muted" as const, isDefault };
  }
  const modelReady = Boolean(current.model?.trim());
  const baseUrlReady = Boolean(current.baseUrl?.trim());
  const secretReady = !sourceNeedsKey(sourceType) || secrets.some((item) => item.ref === (current.secretRef || defaultSecretRefForSource(sourceType)) && item.exists);
  if (!modelReady) return { label: "缺模型", tone: "warning" as const, isDefault };
  if (!baseUrlReady) return { label: "缺地址", tone: "warning" as const, isDefault };
  if (!secretReady) return { label: "缺 Key", tone: "warning" as const, isDefault };
  return { label: "已配置", tone: "success" as const, isDefault };
}

function providerFor(sourceType: SourceType) {
  return PROVIDERS.find((item) => item.id === sourceType) ?? PROVIDERS[0];
}

function inferSourceType(provider: string, baseUrl?: string): SourceType {
  if (provider === "openrouter") return "openrouter";
  if (provider === "openai") return "openai";
  if (provider === "custom") {
    const text = (baseUrl ?? "").toLowerCase();
    if (text.includes("127.0.0.1") || text.includes("localhost")) return "local_openai";
    if (text.includes("deepseek.com")) return "deepseek";
    if (text.includes("dashscope")) return "qwen";
    if (text.includes("moonshot")) return "kimi";
    if (text.includes("ark.cn-beijing.volces.com/api/coding")) return "volcengine_coding";
    if (text.includes("ark.cn-beijing.volces.com")) return "volcengine";
    if (text.includes("hunyuan.cloud.tencent.com")) return "tencent_hunyuan";
    if (text.includes("minimax.io")) return "minimax";
    if (text.includes("bigmodel.cn")) return "zhipu";
    return "custom_gateway";
  }
  return "local_openai";
}

function buildProfileId(sourceType: SourceType, existingProfiles: OverviewModels["modelProfiles"]) {
  const base = `wizard-${sourceType}`;
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

function friendlyProfileName(sourceType: SourceType, model: string) {
  const provider = providerFor(sourceType);
  return model ? `${provider.label} · ${model}` : provider.label;
}

function defaultSecretRefForSource(sourceType: SourceType) {
  if (sourceType === "openai") return "provider.openai.apiKey";
  if (sourceType === "openrouter") return "provider.openrouter.apiKey";
  if (sourceType === "deepseek") return "provider.deepseek.apiKey";
  if (sourceType === "qwen") return "provider.qwen.apiKey";
  if (sourceType === "kimi") return "provider.kimi.apiKey";
  if (sourceType === "volcengine") return "provider.volcengine.apiKey";
  if (sourceType === "volcengine_coding") return "provider.volcengine-coding.apiKey";
  if (sourceType === "tencent_hunyuan") return "provider.tencent-hunyuan.apiKey";
  if (sourceType === "minimax") return "provider.minimax.apiKey";
  if (sourceType === "zhipu") return "provider.zhipu.apiKey";
  if (sourceType === "local_openai") return "provider.local.apiKey";
  return "provider.custom.apiKey";
}

function sourceNeedsKey(sourceType: SourceType) {
  return providerFor(sourceType).keyMode === "required";
}

function connectionSourceType(sourceType: SourceType): "local_openai" | "openrouter" | "openai" | "custom_gateway" {
  if (sourceType === "local_openai" || sourceType === "openrouter" || sourceType === "openai") return sourceType;
  return "custom_gateway";
}
