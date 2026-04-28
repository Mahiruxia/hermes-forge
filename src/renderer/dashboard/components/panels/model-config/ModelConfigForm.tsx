import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { LocalModelDiscoveryResult } from "../../../../../shared/types";
import { cn } from "../../../DashboardPrimitives";
import { defaultSecretRefForSource, isCodingPlanSourceType } from "./modelConfigUtils";
import type { BusyAction, ConnectionDraft } from "./types";

type InputMode = "json" | "form";

/**
 * Template-style model input panel.
 *
 * Users can paste a compact JSON config or use the form fields; both paths
 * feed the same backend draft, secret-save, connection-test, and Hermes sync
 * flow.
 */
export function ModelConfigForm(props: {
  draft: ConnectionDraft;
  busyAction?: BusyAction;
  canTestConnection: boolean;
  canSaveModel: boolean;
  canSaveAsAuxiliary?: boolean;
  testPassed?: boolean;
  willCreateNewProfile: boolean;
  formBlockingHint?: string;
  onModelChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onApiSecretChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onSecretRefChange: (value: string) => void;
  onTest: () => void;
  onSave: () => void;
  onSaveAsAuxiliary?: () => void;
  onDiscover: () => void;
  onCreateDraft: () => void;
  onApplyDiscovery: (candidate: LocalModelDiscoveryResult["candidates"][number]) => void;
}) {
  const supportsSettingsConfig = Boolean(props.draft.provider.settingsConfig);
  const [mode, setMode] = useState<InputMode>(supportsSettingsConfig ? "form" : "json");
  const [jsonText, setJsonText] = useState(() => buildJsonTemplate(props.draft));
  const [jsonError, setJsonError] = useState<string | undefined>();
  const isBaidu = props.draft.sourceType === "baidu_wenxin_api_key";
  const isCodingPlan = isCodingPlanSourceType(props.draft.sourceType);
  const canDiscover = ["ollama", "vllm", "sglang", "lm_studio", "openai_compatible"].includes(props.draft.sourceType);
  const modelSuggestions = useMemo(() => props.draft.modelOptions.slice(0, 12), [props.draft.modelOptions]);

  useEffect(() => {
    setJsonText(buildJsonTemplate(props.draft));
    setJsonError(undefined);
  }, [props.draft.sourceType, props.draft.provider.label, props.draft.baseUrl, props.draft.model]);

  function applyJsonConfig(text = jsonText) {
    try {
      const parsed = JSON.parse(text) as {
        base_url?: unknown;
        api_key?: unknown;
        secret_key?: unknown;
        model?: unknown;
      };
      if (typeof parsed.base_url === "string" && parsed.base_url !== "baseurl") props.onBaseUrlChange(parsed.base_url);
      if (typeof parsed.api_key === "string" && parsed.api_key !== "your-api-key-here") props.onApiKeyChange(parsed.api_key);
      if (typeof parsed.secret_key === "string" && parsed.secret_key !== "your-secret-key-here") props.onApiSecretChange(parsed.secret_key);
      const model = typeof parsed.model === "string"
        ? parsed.model
        : parsed.model && typeof parsed.model === "object" && "id" in parsed.model && typeof parsed.model.id === "string"
          ? parsed.model.id
          : undefined;
      if (model && model !== "model_id") props.onModelChange(model);
      setJsonError(undefined);
      return true;
    } catch {
      setJsonError("JSON 格式不正确，请检查引号、逗号和括号。");
      return false;
    }
  }

  function saveFromCurrentMode() {
    if (mode === "json") {
      if (!applyJsonConfig()) return;
      window.setTimeout(() => props.onSave(), 0);
      return;
    }
    props.onSave();
  }

  function testFromCurrentMode() {
    if (mode === "json") {
      if (!applyJsonConfig()) return;
      window.setTimeout(() => props.onTest(), 0);
      return;
    }
    props.onTest();
  }

  return (
    <section className="rounded-[26px] bg-white shadow-[0_18px_60px_rgba(15,23,42,0.045)] ring-1 ring-slate-200/55">
      <div className="m-3 grid grid-cols-2 rounded-2xl bg-slate-100/80 p-1">
        <ModeButton active={mode === "json"} onClick={() => setMode("json")}>JSON 输入</ModeButton>
        <ModeButton active={mode === "form"} onClick={() => setMode("form")}>表单输入</ModeButton>
      </div>

      <div className="px-4 pb-4 pt-1">
        {mode === "json" ? (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-[24px] bg-[#111315] shadow-[0_24px_70px_rgba(15,23,42,0.16)] ring-1 ring-white/10">
              <div className="flex h-10 items-center justify-between border-b border-white/10 px-4">
                <span className="font-mono text-[11px] text-slate-400">model.config.json</span>
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-slate-400">JSON</span>
              </div>
              <textarea
                aria-label="JSON 输入"
                className="h-[286px] w-full resize-none bg-transparent p-5 font-mono text-[14px] leading-7 text-slate-200 caret-slate-100 outline-none placeholder:text-slate-600"
                onBlur={() => applyJsonConfig()}
                onChange={(event) => {
                  setJsonText(event.target.value);
                  setJsonError(undefined);
                }}
                spellCheck={false}
                value={jsonText}
              />
            </div>
            {jsonError ? <InlineAlert tone="error">{jsonError}</InlineAlert> : null}
          </div>
        ) : (
          <div className="grid gap-4">
            {props.draft.provider.badge === "Coding Plan" ? (
              <div className="rounded-2xl bg-amber-50/80 px-4 py-3 text-[12px] leading-5 text-amber-800 ring-1 ring-amber-200/70">
                <p className="font-semibold">Forge 不会直接测试此 provider 的连接。</p>
                <p className="mt-1">请填入 Coding Plan API Key 和模型 ID。保存后会同步到 Hermes 的 Coding Plan 专用环境变量，实际可用性由 Hermes 在运行时直接验证。</p>
              </div>
            ) : null}

            <Field label={isBaidu ? "百度 API Key" : props.draft.provider.keyMode === "required" ? "API Key" : "API Key（可选）"}>
              <input
                className={inputClassName}
                onChange={(event) => props.onApiKeyChange(event.target.value)}
                placeholder={props.draft.provider.keyMode === "required" ? "your-api-key-here" : "本地模型可留空"}
                type="password"
                value={props.draft.apiKey}
              />
            </Field>
            {isBaidu ? (
              <Field label="百度 Secret Key">
                <input className={inputClassName} onChange={(event) => props.onApiSecretChange(event.target.value)} placeholder="your-secret-key-here" type="password" value={props.draft.apiSecret} />
              </Field>
            ) : null}
            <Field label="Base URL">
              <input className={inputClassName} onChange={(event) => props.onBaseUrlChange(event.target.value)} placeholder={props.draft.provider.baseUrl ?? "https://example.com/v1"} value={props.draft.baseUrl} />
            </Field>
            <Field label="Model ID">
              <input
                aria-label="添加模型名称"
                className={inputClassName}
                list="model-config-options"
                onChange={(event) => props.onModelChange(event.target.value)}
                placeholder={props.draft.provider.modelPlaceholder}
                value={props.draft.model}
              />
              <datalist id="model-config-options">
                {props.draft.modelOptions.map((item) => <option key={item} value={item} />)}
              </datalist>
            </Field>
            <Field label="密钥引用">
              <input className={inputClassName} onChange={(event) => props.onSecretRefChange(event.target.value)} placeholder={defaultSecretRefForSource(props.draft.sourceType)} value={props.draft.secretRef} />
            </Field>
            {modelSuggestions.length ? (
              <div className="flex flex-wrap gap-2">
                {modelSuggestions.map((item) => (
                  <button className="rounded-full bg-slate-50 px-3 py-1.5 font-mono text-[11px] text-slate-500 ring-1 ring-slate-200/70 transition hover:bg-slate-100 hover:text-slate-950 active:translate-y-px" key={item} onClick={() => props.onModelChange(item)} type="button">
                    {item}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}

        {props.draft.discovery ? <DiscoveryPanel discovery={props.draft.discovery} onApply={props.onApplyDiscovery} /> : null}

        <div className="mt-5 grid gap-3">
          {props.formBlockingHint ? <InlineAlert tone="warning">{props.formBlockingHint}</InlineAlert> : null}
          <button
            className="h-12 rounded-2xl bg-slate-900 text-[15px] font-semibold text-white shadow-[0_16px_38px_rgba(15,23,42,0.18)] transition hover:bg-slate-800 active:translate-y-px disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
            disabled={!props.canSaveModel}
            onClick={saveFromCurrentMode}
            title={props.canSaveModel ? (props.testPassed ? "" : isCodingPlan ? "保存后会将配置同步到 Hermes，由 Hermes 在运行时直接验证。" : "会先自动执行连接测试，通过后再保存。") : "请填写必填字段后再保存。"}
            type="button"
          >
            {props.busyAction === "save"
              ? "保存中..."
              : props.busyAction === "test"
                ? "测试中..."
                : props.canSaveModel && !props.testPassed
                  ? isCodingPlan
                    ? "保存并同步到 Hermes"
                    : "测试并添加为默认"
                  : "添加为默认"}
          </button>
          {props.canSaveAsAuxiliary && props.onSaveAsAuxiliary ? (
            <button
              className="h-10 rounded-xl border border-slate-200 bg-white text-[13px] font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 active:translate-y-px"
              disabled={Boolean(props.busyAction)}
              onClick={props.onSaveAsAuxiliary}
              type="button"
            >
              {props.busyAction === "save" ? "保存中..." : "仅保存为辅助模型（不用于主任务）"}
            </button>
          ) : null}
          <div className="flex flex-wrap justify-between gap-2">
            <button className="rounded-xl px-3 py-2 text-[12px] font-semibold text-slate-500 transition hover:bg-slate-50 hover:text-slate-950 active:translate-y-px" onClick={props.onCreateDraft} type="button">新增模型草稿</button>
            <div className="flex gap-2">
              {canDiscover ? <button className="rounded-xl bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-600 ring-1 ring-slate-200/70 transition hover:bg-slate-100 hover:text-slate-950 active:translate-y-px disabled:opacity-50" disabled={Boolean(props.busyAction)} onClick={props.onDiscover} type="button">{props.busyAction === "discover" ? "探测中..." : "自动探测"}</button> : null}
              <button className="rounded-xl bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-600 ring-1 ring-slate-200/70 transition hover:bg-slate-100 hover:text-slate-950 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45" disabled={!props.canTestConnection} onClick={testFromCurrentMode} type="button">
                {props.busyAction === "test" ? <Loader2 size={13} className="inline animate-spin" /> : null} 立即测试
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ModeButton(props: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      className={cn("h-11 rounded-xl text-[14px] font-semibold transition active:translate-y-px", props.active ? "bg-white text-slate-950 shadow-[0_8px_22px_rgba(15,23,42,0.08)]" : "text-slate-500 hover:text-slate-950")}
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="block text-[12px] font-medium text-slate-500">
      <span className="mb-2 block">{props.label}</span>
      {props.children}
    </label>
  );
}

function DiscoveryPanel(props: { discovery: LocalModelDiscoveryResult; onApply: (candidate: LocalModelDiscoveryResult["candidates"][number]) => void }) {
  const hasLocalhost = props.discovery.candidates.some((c) => /127\.0\.0\.1|localhost/.test(c.baseUrl));
  return (
    <div className="mt-4 rounded-[22px] bg-slate-50/80 p-4 text-[12px] text-slate-600 ring-1 ring-slate-200/70">
      <p className="font-semibold text-slate-900">{props.discovery.ok ? "发现可用本地接口" : "未发现本地接口"}</p>
      {hasLocalhost ? (
        <p className="mt-2 rounded-xl bg-amber-50/70 px-3 py-2 text-amber-800 ring-1 ring-amber-200/60">
          检测到 localhost 地址。如果你使用 WSL 模式，请确认该服务已绑定到 0.0.0.0，否则 Hermes 可能无法连接。
        </p>
      ) : null}
      <div className="mt-2 grid gap-2">
        {props.discovery.candidates.map((candidate) => (
          <button key={candidate.baseUrl} className="rounded-2xl bg-white px-3 py-2.5 text-left text-[12px] text-slate-600 shadow-[0_8px_22px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/60 transition hover:bg-slate-50 active:translate-y-px" onClick={() => props.onApply(candidate)} type="button">
            <span className="block font-mono text-slate-800">{candidate.baseUrl}</span>
            <span className="mt-0.5 block">{candidate.availableModels.slice(0, 4).join("、") || candidate.message}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function InlineAlert(props: { tone: "warning" | "error"; children: ReactNode }) {
  return (
    <div className={cn(
      "flex items-start gap-2 rounded-2xl px-3.5 py-3 text-[12px] font-medium leading-5 shadow-[0_10px_26px_rgba(15,23,42,0.035)] ring-1",
      props.tone === "error" ? "bg-rose-50/80 text-rose-700 ring-rose-200/70" : "bg-amber-50/80 text-amber-800 ring-amber-200/70",
    )}>
      <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", props.tone === "error" ? "bg-rose-500" : "bg-amber-500")} />
      <span>{props.children}</span>
    </div>
  );
}

function buildJsonTemplate(draft: ConnectionDraft) {
  return JSON.stringify({
    provider: draft.provider.label,
    base_url: draft.baseUrl || draft.provider.baseUrl || "baseurl",
    api: "API协议",
    api_key: draft.apiKey || "your-api-key-here",
    ...(draft.sourceType === "baidu_wenxin_api_key" ? { secret_key: draft.apiSecret || "your-secret-key-here" } : {}),
    model: {
      id: draft.model || "model_id",
      name: draft.model || "model_name",
    },
  }, null, 2);
}

const inputClassName = "h-11 w-full rounded-2xl bg-slate-50/80 px-4 font-mono text-[13px] text-slate-900 outline-none ring-1 ring-slate-200/75 transition placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-500/25";
