import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { LocalModelDiscoveryResult, ModelConnectionTestResult } from "../../../../shared/types";

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
  modelProfiles: Array<{ id: string; provider: string; model: string; baseUrl?: string; secretRef?: string }>;
  summary?: ModelSummary;
};

type SecretMeta = { ref: string; exists: boolean };
type SourceType = "local_openai" | "openrouter" | "openai" | "custom_gateway";

const SOURCE_CARDS: Array<{ id: SourceType; label: string; detail: string }> = [
  { id: "local_openai", label: "本地 OpenAI 兼容接口", detail: "适合 LM Studio、vLLM、本地中转接口。" },
  { id: "openrouter", label: "OpenRouter", detail: "统一接入多个云模型，重点先把 Key 和模型选清楚。" },
  { id: "openai", label: "OpenAI", detail: "直接配置 OpenAI API Key 和模型名。" },
  { id: "custom_gateway", label: "自定义网关", detail: "用于公司内网网关或第三方兼容 OpenAI 接口。" },
];

export function ModelConfigWizard(props: {
  models: OverviewModels;
  secrets: SecretMeta[];
  onRefresh: () => Promise<void>;
  onSaved: (message: string) => void;
}) {
  const initialSource = deriveInitialSourceType(props.models);
  const initial = deriveStateForSource(props.models, initialSource);
  const [sourceType, setSourceType] = useState<SourceType>(initial.sourceType);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [secretRef, setSecretRef] = useState(initial.secretRef);
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<ModelConnectionTestResult | undefined>();
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<LocalModelDiscoveryResult | undefined>();
  const [busyAction, setBusyAction] = useState<"test" | "save" | undefined>();
  const [expandedSource, setExpandedSource] = useState<SourceType>(initial.sourceType);
  const [showAdvancedSecretRef, setShowAdvancedSecretRef] = useState(false);
  const [editorOpen, setEditorOpen] = useState(!initial.hasExistingConfig);

  useEffect(() => {
    const nextSource = deriveInitialSourceType(props.models);
    const next = deriveStateForSource(props.models, nextSource);
    setSourceType(next.sourceType);
    setExpandedSource(next.sourceType);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setSecretRef(next.secretRef);
    setApiKey("");
    setTestResult(undefined);
    setShowAdvancedSecretRef(false);
    setEditorOpen(!next.hasExistingConfig);
  }, [props.models.defaultProfileId, props.models.modelProfiles]);

  const testOk = Boolean(testResult?.ok);
  const effectiveSecretRef = secretRef.trim() || defaultSecretRefForSource(expandedSource);
  const hasStoredSecret = props.secrets.some((item) => item.ref === effectiveSecretRef && item.exists);
  const activeDraftHasConfig = Boolean(model.trim() || baseUrl.trim() || hasStoredSecret);

  async function discoverLocal() {
    setDiscovering(true);
    try {
      const result = await window.workbenchClient.discoverLocalModelSources();
      setDiscovery(result);
      if (result.recommendedBaseUrl) setBaseUrl(result.recommendedBaseUrl);
      if (result.recommendedModel && !model.trim()) setModel(result.recommendedModel);
    } finally {
      setDiscovering(false);
    }
  }

  async function testConnection(targetSource: SourceType = expandedSource) {
    setBusyAction("test");
    setTestResult(undefined);
    try {
      const ref = await ensureSecretIfNeeded(targetSource);
      const result = await window.workbenchClient.testModelConnection({
        sourceType: targetSource,
        model: model.trim(),
        baseUrl: sourceNeedsBaseUrl(targetSource) ? baseUrl.trim() : undefined,
        secretRef: ref,
      });
      setTestResult(result);
    } finally {
      setBusyAction(undefined);
    }
  }

  async function saveModel(targetSource: SourceType = expandedSource) {
    setBusyAction("save");
    try {
      const ref = await ensureSecretIfNeeded(targetSource);
      const profileId = buildProfileId(targetSource);
      const nextProfile = {
        id: profileId,
        provider: targetSource === "local_openai" || targetSource === "custom_gateway" ? "custom" : targetSource,
        model: model.trim(),
        ...(sourceNeedsBaseUrl(targetSource) ? { baseUrl: baseUrl.trim() } : {}),
        ...(ref ? { secretRef: ref } : {}),
      };
      const nextProfiles = [
        ...props.models.modelProfiles.filter((item) => item.id !== profileId),
        nextProfile,
      ];
      await window.workbenchClient.updateModelConfig({
        defaultProfileId: profileId,
        modelProfiles: nextProfiles,
      });
      await props.onRefresh();
      props.onSaved("模型来源已保存");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function ensureSecretIfNeeded(targetSource: SourceType) {
    const trimmedInput = apiKey.trim();
    const nextRef = secretRef.trim() || defaultSecretRefForSource(targetSource);
    if (trimmedInput) {
      await window.workbenchClient.saveSecret({ ref: nextRef, plainText: trimmedInput });
      setSecretRef(nextRef);
      return nextRef;
    }
    if (sourceNeedsKey(targetSource) && !nextRef) throw new Error("当前来源需要 API Key。");
    return nextRef || undefined;
  }

  const summary = props.models.summary;

  function applySourceDraft(nextSource: SourceType) {
    const next = deriveStateForSource(props.models, nextSource);
    setSourceType(nextSource);
    setExpandedSource(nextSource);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setSecretRef(next.secretRef);
    setApiKey("");
    setTestResult(undefined);
    setDiscovery(undefined);
    setShowAdvancedSecretRef(false);
    setEditorOpen(!next.hasExistingConfig);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200/70 bg-slate-50/70 px-4 py-4 text-[12px] text-slate-600">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">Current default</p>
            <h3 className="mt-2 text-[15px] font-semibold text-slate-900">当前默认模型来源</h3>
          </div>
          <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-slate-500 shadow-sm">
            {summary?.sourceType || "未配置"}
          </span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <SummaryRow label="来源" value={summary?.sourceType || "未配置"} />
          <SummaryRow label="Base URL" value={summary?.baseUrl || "未配置"} mono />
          <SummaryRow label="模型" value={summary?.currentModel || "未配置"} />
          <SummaryRow label="密钥状态" value={summary?.secretStatus || "未知"} />
        </div>
        {summary?.message ? <p className="mt-3">{summary.message}</p> : null}
        {summary?.recommendedFix ? <p className="mt-1 text-[11px] text-slate-500">建议：{summary.recommendedFix}</p> : null}
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">Provider selection</p>
          <h3 className="mt-2 text-[15px] font-semibold text-slate-900">选择模型来源</h3>
          <p className="mt-1 text-[13px] leading-6 text-slate-500">
            先选一个来源卡片，只有当前选中的提供商才会展开设置表单。
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {SOURCE_CARDS.map((source) => {
            const selected = sourceType === source.id;
            const sourceStatus = getSourceCardStatus(props.models, props.secrets, source.id);
            return (
              <button
                key={source.id}
                className={`rounded-2xl border px-4 py-4 text-left transition-all ${
                  selected
                    ? "border-slate-900 bg-slate-900 text-white shadow-[0_12px_32px_rgba(15,23,42,0.12)]"
                    : "border-slate-200/80 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                }`}
                onClick={() => {
                  applySourceDraft(source.id);
                }}
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-semibold">{source.label}</p>
                    <p className={`mt-2 text-[11px] leading-5 ${selected ? "text-white/75" : "text-slate-500"}`}>
                      {source.detail}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <StatusBadge label={sourceStatus.label} tone={selected ? "selected" : sourceStatus.tone} />
                      {sourceStatus.isDefault ? <StatusBadge label="当前默认" tone={selected ? "selected" : "default"} /> : null}
                    </div>
                  </div>
                  <span
                    className={`mt-1 inline-flex h-2.5 w-2.5 rounded-full ${
                      selected
                        ? "bg-white"
                        : sourceStatus.tone === "success"
                          ? "bg-emerald-500"
                          : sourceStatus.tone === "warning"
                            ? "bg-amber-500"
                            : "bg-slate-300"
                    }`}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {(() => {
        const activeStatus = getSourceCardStatus(props.models, props.secrets, expandedSource);
        const summaryTone = getStatusSurfaceTone(activeStatus.tone);
        return (
      <div className="rounded-2xl border border-slate-200/70 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">Provider form</p>
            <h3 className="mt-2 text-[15px] font-semibold text-slate-900">
              {SOURCE_CARDS.find((item) => item.id === expandedSource)?.label}
            </h3>
            <p className="mt-1 text-[13px] leading-6 text-slate-500">
              只展示当前来源需要填写的字段，避免把所有配置项一口气摊开。
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge label={activeStatus.label} tone={activeStatus.tone} />
            {activeStatus.isDefault ? <StatusBadge label="当前默认" tone="default" /> : null}
            <StatusBadge label={editorOpen ? "编辑中" : "摘要模式"} tone={editorOpen ? "default" : "muted"} />
          </div>
        </div>

        <div className={`mt-4 rounded-2xl border px-4 py-4 ${summaryTone}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[12px] font-semibold text-slate-900">当前连接摘要</p>
              <p className="mt-1 text-[12px] leading-6 text-slate-500">
                先确认这一路来源当前的连接状态，需要修改时再展开表单。
              </p>
            </div>
            <button
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
              onClick={() => setEditorOpen((value) => !value)}
              type="button"
            >
              {editorOpen ? "收起编辑" : "编辑连接"}
            </button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <SummaryRow label="来源" value={SOURCE_CARDS.find((item) => item.id === expandedSource)?.label || expandedSource} />
            <SummaryRow label="模型" value={model.trim() || "未填写"} />
            {sourceNeedsBaseUrl(expandedSource) ? <SummaryRow label="Base URL" value={baseUrl.trim() || "未填写"} mono /> : null}
            <SummaryRow label="密钥状态" value={hasStoredSecret ? "已保存到本地保管库" : sourceNeedsKey(expandedSource) ? "需要填写 API Key" : "可选"} />
          </div>

          {!editorOpen ? (
            <div className="mt-4 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-3 text-[12px] text-slate-500">
              {activeDraftHasConfig
                ? "当前来源已经有配置，点“编辑连接”可以继续修改 URL、模型或密钥。"
                : "当前来源还没有完整配置，点“编辑连接”开始填写。"}
            </div>
          ) : null}
        </div>

        {editorOpen ? (
          <>
            {expandedSource === "local_openai" ? (
              <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-4 text-[12px] text-blue-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">自动探测本地接口</p>
                    <p className="mt-1 text-[11px] text-blue-600">先试常见地址，再决定是否手动填写，减少无效试错。</p>
                  </div>
                  <button
                    className="rounded-xl bg-blue-600 px-3 py-2 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                    disabled={discovering}
                    onClick={() => void discoverLocal()}
                    type="button"
                  >
                    <span className="inline-flex items-center gap-2">
                      {discovering ? <Loader2 size={14} className="animate-spin" /> : null}
                      {discovering ? "探测中..." : "自动探测"}
                    </span>
                  </button>
                </div>
                {discovery ? (
                  <div className="mt-3 space-y-2">
                    {discovery.candidates.map((candidate) => (
                      <button
                        key={candidate.baseUrl}
                        className={`block w-full rounded-xl border px-3 py-3 text-left ${
                          candidate.ok ? "border-emerald-200 bg-white text-emerald-700" : "border-slate-200 bg-white text-slate-500"
                        }`}
                        onClick={() => {
                          setBaseUrl(candidate.baseUrl);
                          if (candidate.availableModels[0]) setModel(candidate.availableModels[0]);
                          setSourceType("local_openai");
                          setExpandedSource("local_openai");
                        }}
                        type="button"
                      >
                        <p className="font-medium">{candidate.baseUrl}</p>
                        <p className="mt-1 text-[11px] leading-5">
                          {candidate.ok
                            ? `可用模型：${candidate.availableModels.slice(0, 4).join("、") || "已连通，但服务未返回模型列表"}`
                            : candidate.message}
                        </p>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {(expandedSource === "local_openai" || expandedSource === "custom_gateway") ? (
                <label className="block text-[12px] text-slate-500">
                  <span className="mb-1.5 block">Base URL</span>
                  <input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    className="w-full rounded-xl border border-slate-200/80 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-700 outline-none transition focus:ring-2 focus:ring-blue-500/30"
                    placeholder="例如 http://127.0.0.1:1234/v1"
                  />
                </label>
              ) : null}

              <label className="block text-[12px] text-slate-500">
                <span className="mb-1.5 block">模型名</span>
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className="w-full rounded-xl border border-slate-200/80 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-700 outline-none transition focus:ring-2 focus:ring-blue-500/30"
                  placeholder={expandedSource === "openai" ? "例如 gpt-4.1" : "例如 qwen2.5-coder"}
                />
              </label>
            </div>

            <div className="mt-3">
              <label className="block text-[12px] text-slate-500">
                <span className="mb-1.5 block">API Key{expandedSource === "openai" || expandedSource === "openrouter" ? "" : "（可选）"}</span>
                <input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="w-full rounded-xl border border-slate-200/80 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-700 outline-none transition focus:ring-2 focus:ring-blue-500/30"
                  placeholder={
                    expandedSource === "openai" || expandedSource === "openrouter"
                      ? "输入或粘贴你的 API Key"
                      : "如果你的本地接口或网关需要认证，可在这里填"
                  }
                  type="password"
                />
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                <span className={`inline-flex items-center rounded-full px-2 py-1 font-medium ${hasStoredSecret ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                  {hasStoredSecret ? "已保存密钥" : "尚未保存密钥"}
                </span>
                <span className="font-mono text-[10px] text-slate-400">{effectiveSecretRef}</span>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                这里只需要填一次真实的 API Key。上面的引用名只是内部存储位置，不是第二个 Key；如果重新输入，这次保存会覆盖原来的密钥。
              </p>
              <button
                className="mt-3 text-[12px] font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900"
                onClick={() => setShowAdvancedSecretRef((value) => !value)}
                type="button"
              >
                {showAdvancedSecretRef ? "收起高级设置" : "高级设置：自定义密钥存储引用"}
              </button>
            </div>

            {showAdvancedSecretRef ? (
              <div className="mt-3 rounded-2xl border border-slate-200/80 bg-slate-50/80 px-4 py-4">
                <label className="block text-[12px] text-slate-500">
                  <span className="mb-1.5 block">密钥存储引用（高级）</span>
                  <input
                    value={secretRef}
                    onChange={(event) => setSecretRef(event.target.value)}
                    className="w-full rounded-xl border border-slate-200/80 bg-white px-3 py-2.5 text-[13px] text-slate-700 outline-none transition focus:ring-2 focus:ring-blue-500/30"
                    placeholder={defaultSecretRefForSource(expandedSource)}
                  />
                </label>
                <p className="mt-2 text-[11px] leading-5 text-slate-500">
                  这个字段只决定密钥在本地保管库里的名字。大多数情况下保持默认即可，不需要手动修改。
                </p>
              </div>
            ) : null}
          </>
        ) : null}

        <div className="mt-4 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-[12px] text-amber-700">
          <p className="font-medium">先测试，再保存</p>
          <p className="mt-1 text-[11px] text-amber-600">
            只有测试通过后，才允许“保存并设为默认”，这样问题会在配置阶段就被拦住。
          </p>
        </div>

        {testResult ? (
          <div className={`mt-4 rounded-2xl border px-4 py-3 text-[12px] ${testResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
            <p className="font-medium">{testResult.ok ? "测试通过" : "测试失败"}</p>
            <p className="mt-1 whitespace-pre-wrap leading-6">{testResult.message}</p>
            {testResult.recommendedFix ? <p className="mt-1 text-[11px] opacity-80">建议动作：{testResult.recommendedFix}</p> : null}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            disabled={busyAction === "test"}
            onClick={() => {
              setSourceType(expandedSource);
              void testConnection(expandedSource);
            }}
            type="button"
          >
            <span className="inline-flex items-center gap-2">
              {busyAction === "test" ? <Loader2 size={14} className="animate-spin" /> : null}
              {busyAction === "test" ? "测试中..." : "立即测试"}
            </span>
          </button>
          <button
            className="rounded-xl bg-slate-900 px-4 py-2 text-[13px] font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            disabled={!testOk || busyAction === "save"}
            onClick={() => {
              setSourceType(expandedSource);
              void saveModel(expandedSource);
            }}
            type="button"
          >
            <span className="inline-flex items-center gap-2">
              {busyAction === "save" ? <Loader2 size={14} className="animate-spin" /> : null}
              {busyAction === "save" ? "保存中..." : "保存并设为默认"}
            </span>
          </button>
        </div>
      </div>
        );
      })()}

      {props.models.modelProfiles.some((item) => item.provider === "anthropic") ? (
        <div className="rounded-2xl border border-slate-200/70 bg-slate-50/70 px-4 py-3 text-[12px] text-slate-500">
          <p className="font-medium text-slate-700">已有配置 / 高级兼容项</p>
          <p className="mt-1 leading-6">检测到旧的 Anthropic 或其他历史配置。本轮向导先聚焦 4 类主来源，但旧配置仍然保留，不会丢失。</p>
        </div>
      ) : null}
    </div>
  );
}

function SummaryRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-white/70 bg-white px-3 py-2">
      <p className="text-[11px] text-slate-400">{props.label}</p>
      <p className={`mt-1 text-[12px] font-medium text-slate-700 ${props.mono ? "font-mono text-[11px]" : ""}`}>{props.value}</p>
    </div>
  );
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
  return <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ${className}`}>{props.label}</span>;
}

function getStatusSurfaceTone(tone: "success" | "warning" | "muted" | "default") {
  if (tone === "success") return "border-emerald-200/80 bg-emerald-50/70";
  if (tone === "warning") return "border-amber-200/80 bg-amber-50/70";
  if (tone === "default") return "border-blue-200/80 bg-blue-50/60";
  return "border-slate-200/80 bg-slate-50/70";
}

function deriveInitialSourceType(models: OverviewModels): SourceType {
  const current = models.modelProfiles.find((item) => item.id === models.defaultProfileId) ?? models.modelProfiles[0];
  if (!current) return "local_openai";
  return inferSourceType(current.provider, current.baseUrl);
}

function deriveStateForSource(models: OverviewModels, sourceType: SourceType) {
  const current = models.modelProfiles.find((item) => inferSourceType(item.provider, item.baseUrl) === sourceType);
  if (!current) {
    return {
      sourceType,
      baseUrl: defaultBaseUrlForSource(sourceType),
      model: "",
      secretRef: defaultSecretRefForSource(sourceType),
      hasExistingConfig: false,
    };
  }
  return {
    sourceType,
    baseUrl: current.baseUrl ?? defaultBaseUrlForSource(sourceType),
    model: current.model ?? "",
    secretRef: current.secretRef ?? "",
    hasExistingConfig: Boolean(current.model || current.baseUrl || current.secretRef),
  };
}

function getSourceCardStatus(models: OverviewModels, secrets: SecretMeta[], sourceType: SourceType) {
  const current = models.modelProfiles.find((item) => inferSourceType(item.provider, item.baseUrl) === sourceType);
  const isDefault = current?.id === models.defaultProfileId;
  if (!current) {
    return { label: "未配置", tone: "muted" as const, isDefault };
  }

  const modelReady = Boolean(current.model?.trim());
  const baseUrlReady = !sourceNeedsBaseUrl(sourceType) || Boolean(current.baseUrl?.trim());
  const secretReady = !sourceNeedsKey(sourceType) || secrets.some((item) => item.ref === (current.secretRef || defaultSecretRefForSource(sourceType)) && item.exists);

  if (!modelReady) {
    return { label: "缺模型", tone: "warning" as const, isDefault };
  }
  if (!baseUrlReady) {
    return { label: "缺地址", tone: "warning" as const, isDefault };
  }
  if (!secretReady) {
    return { label: "缺 Key", tone: "warning" as const, isDefault };
  }
  return { label: "已配置", tone: "success" as const, isDefault };
}

function inferSourceType(provider: string, baseUrl?: string): SourceType {
  if (provider === "openrouter") return "openrouter";
  if (provider === "openai") return "openai";
  if (provider === "custom") {
    const text = (baseUrl ?? "").toLowerCase();
    return text.includes("127.0.0.1") || text.includes("localhost") ? "local_openai" : "custom_gateway";
  }
  return "local_openai";
}

function buildProfileId(sourceType: SourceType) {
  return `wizard-${sourceType}`;
}

function defaultSecretRefForSource(sourceType: SourceType) {
  if (sourceType === "openai") return "provider.openai.apiKey";
  if (sourceType === "openrouter") return "provider.openrouter.apiKey";
  if (sourceType === "local_openai") return "provider.local.apiKey";
  return "provider.custom.apiKey";
}

function defaultBaseUrlForSource(sourceType: SourceType) {
  if (sourceType === "openai") return "https://api.openai.com/v1";
  if (sourceType === "openrouter") return "https://openrouter.ai/api/v1";
  return "http://127.0.0.1:1234/v1";
}

function sourceNeedsBaseUrl(sourceType: SourceType) {
  return sourceType === "local_openai" || sourceType === "custom_gateway";
}

function sourceNeedsKey(sourceType: SourceType) {
  return sourceType === "openai" || sourceType === "openrouter";
}
