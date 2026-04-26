import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Pause,
  Play,
  QrCode,
  RefreshCw,
  RotateCw,
  Save,
  Settings,
  ShieldCheck,
  StopCircle,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type {
  HermesConnectorConfig,
  HermesConnectorField,
  HermesConnectorListResult,
  HermesConnectorPlatformId,
  HermesConnectorSaveInput,
  HermesGatewayStatus,
  WeixinQrLoginPhase,
  WeixinQrLoginStatus,
} from "../../../../shared/types";
import { NoticeCard } from "../NoticeCard";
import { cn } from "../../DashboardPrimitives";

type FormValues = Record<string, string | boolean | undefined>;
type EmailProviderPresetKey = "gmail" | "outlook" | "qq" | "163" | "icloud";
type ConnectorQuickPreset = {
  key: string;
  label: string;
  description: string;
  apply(values: FormValues): FormValues;
};
type ConnectorEditorConfig = {
  summary: string;
  advancedFieldKeys: string[];
  tips?: string[];
  presets?: ConnectorQuickPreset[];
  forceVisibleFieldKeys?: string[];
  detectedPresetLabel?: string;
};

const EMAIL_PROVIDER_PRESETS: Record<EmailProviderPresetKey, { label: string; imapHost: string; smtpHost: string; match: RegExp }> = {
  gmail: {
    label: "Gmail",
    imapHost: "imap.gmail.com",
    smtpHost: "smtp.gmail.com",
    match: /(?:^|\.)gmail\.com$/i,
  },
  outlook: {
    label: "Outlook",
    imapHost: "outlook.office365.com",
    smtpHost: "smtp.office365.com",
    match: /(?:^|\.)((outlook|hotmail|live)\.com|office365\.com)$/i,
  },
  qq: {
    label: "QQ 邮箱",
    imapHost: "imap.qq.com",
    smtpHost: "smtp.qq.com",
    match: /(?:^|\.)qq\.com$/i,
  },
  "163": {
    label: "163 邮箱",
    imapHost: "imap.163.com",
    smtpHost: "smtp.163.com",
    match: /(?:^|\.)163\.com$/i,
  },
  icloud: {
    label: "iCloud",
    imapHost: "imap.mail.me.com",
    smtpHost: "smtp.mail.me.com",
    match: /(?:^|\.)icloud\.com$/i,
  },
};

const statusLabels: Record<HermesConnectorConfig["status"], string> = {
  unconfigured: "未配置",
  configured: "已配置",
  running: "已配置",
  error: "已配置",
  disabled: "已禁用",
};

const runtimeStatusLabels: Record<HermesConnectorConfig["runtimeStatus"], string> = {
  stopped: "未运行",
  running: "运行中",
  error: "运行异常",
};

const qrSteps: Array<{ phase: WeixinQrLoginPhase; label: string }> = [
  { phase: "fetching_qr", label: "获取二维码" },
  { phase: "waiting_scan", label: "微信扫码" },
  { phase: "waiting_confirm", label: "手机确认" },
  { phase: "saving", label: "保存凭据" },
  { phase: "syncing", label: "同步 .env" },
  { phase: "starting_gateway", label: "启动 Gateway" },
  { phase: "success", label: "完成" },
  { phase: "timeout", label: "超时" },
];

export function ConnectorsPanel() {
  const [data, setData] = useState<HermesConnectorListResult | undefined>();
  const [editingId, setEditingId] = useState<HermesConnectorPlatformId | undefined>();
  const [formValues, setFormValues] = useState<FormValues>({});
  const [formEnabled, setFormEnabled] = useState(true);
  const [showAdvancedEditor, setShowAdvancedEditor] = useState(false);
  const [editorJustOpened, setEditorJustOpened] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [weixinQr, setWeixinQr] = useState<WeixinQrLoginStatus | undefined>();
  const [weixinWizardOpen, setWeixinWizardOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<HermesConnectorPlatformId | undefined>();
  const editorRef = useRef<HTMLElement | null>(null);

  const editing = useMemo(
    () => data?.connectors.find((connector) => connector.platform.id === editingId),
    [data?.connectors, editingId],
  );
  const weixinConnector = data?.connectors.find((connector) => connector.platform.id === "weixin");
  const recommendation = getRecommendation(data);
  const editorConfig = editing ? getConnectorEditorConfig(editing.platform.id, formValues) : undefined;
  const visibleEditingFields = editing
    ? editing.platform.fields.filter((field) => {
      if (showAdvancedEditor) return true;
      if (!editorConfig) return true;
      if (editorConfig.forceVisibleFieldKeys?.includes(field.key)) return true;
      return !editorConfig.advancedFieldKeys.includes(field.key);
    })
    : [];
  const hiddenAdvancedFieldCount = editing && editorConfig
    ? editing.platform.fields.filter((field) => !visibleEditingFields.some((item) => item.key === field.key)).length
    : 0;

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!weixinWizardOpen || !weixinQr || isTerminalQrPhase(weixinQr.phase)) return;
    const timer = window.setInterval(async () => {
      const status = await window.workbenchClient.getWeixinQrLoginStatus();
      setWeixinQr(status);
      if (status.phase === "success") {
        await load();
        setHighlightedId("weixin");
        setMessage(status.message);
        window.setTimeout(() => setHighlightedId(undefined), 4500);
      }
    }, 1300);
    return () => window.clearInterval(timer);
  }, [weixinWizardOpen, weixinQr?.phase]);

  useEffect(() => {
    if (!editingId || !editorRef.current) return;
    editorRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    setEditorJustOpened(true);
    const timer = window.setTimeout(() => setEditorJustOpened(false), 1800);
    return () => window.clearTimeout(timer);
  }, [editingId]);

  async function load() {
    setBusy("refresh");
    setError("");
    try {
      setData(await window.workbenchClient.listConnectors());
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接器列表加载失败。");
    } finally {
      setBusy(undefined);
    }
  }

  function startEditing(connector: HermesConnectorConfig) {
    const values: FormValues = {};
    for (const field of connector.platform.fields) {
      values[field.key] = field.secret
        ? ""
        : connector.values[field.key] ?? (field.type === "boolean" ? false : "");
    }
    const nextValues = withConnectorDefaults(connector.platform.id, values);
    setEditingId(connector.platform.id);
    setFormEnabled(connector.enabled);
    setShowAdvancedEditor(false);
    setFormValues(nextValues);
    setMessage("");
    setError("");
  }

  function updateEditingField(field: HermesConnectorField, value: string | boolean) {
    if (!editing) return;
    setFormValues((current) => withConnectorDefaults(editing.platform.id, {
      ...current,
      [field.key]: value,
    }, field.key));
  }

  function applyQuickPreset(preset: ConnectorQuickPreset) {
    if (!editing) return;
    setFormValues((current) => withConnectorDefaults(editing.platform.id, preset.apply(current)));
    setMessage(`已应用 ${preset.label} 预设。`);
  }

  async function saveEditing() {
    if (!editing) return;
    await runAction("save", async () => {
      const input: HermesConnectorSaveInput = {
        platformId: editing.platform.id,
        enabled: formEnabled,
        values: formValues,
      };
      await window.workbenchClient.saveConnector(input);
      await load();
      setMessage(`${editing.platform.label} 配置已加密保存。`);
      setEditingId(undefined);
    });
  }

  async function disableConnector(connector: HermesConnectorConfig) {
    await runAction(`disable-${connector.platform.id}`, async () => {
      await window.workbenchClient.disableConnector(connector.platform.id);
      await load();
      setMessage(`${connector.platform.label} 已禁用。`);
      if (editingId === connector.platform.id) setEditingId(undefined);
    });
  }

  async function syncEnv() {
    await runAction("sync", async () => {
      const result = await window.workbenchClient.syncConnectorsEnv();
      setData((current) => current ? { ...current, connectors: result.connectors } : current);
      setMessage(result.message);
    });
  }

  async function gatewayAction(action: "start" | "stop" | "restart") {
    await runAction(`gateway-${action}`, async () => {
      const result = action === "start"
        ? await window.workbenchClient.startGateway()
        : action === "stop"
          ? await window.workbenchClient.stopGateway()
          : await window.workbenchClient.restartGateway();
      setData((current) => current ? { ...current, gateway: result.status } : current);
      setMessage(result.message);
      await load();
    });
  }

  async function openWeixinWizard(autoStart: boolean) {
    setWeixinWizardOpen(true);
    setMessage("");
    setError("");
    await runAction("weixin-qr", async () => {
      const current = await window.workbenchClient.getWeixinQrLoginStatus();
      if (autoStart && !current.running && current.phase !== "success") {
        const result = await window.workbenchClient.startWeixinQrLogin();
        setWeixinQr(result.status);
        setMessage(result.message);
        return;
      }
      setWeixinQr(current);
    });
  }

  async function refreshWeixinQr() {
    await runAction("weixin-qr-refresh", async () => {
      if (weixinQr?.running) {
        await window.workbenchClient.cancelWeixinQrLogin();
      }
      const result = await window.workbenchClient.startWeixinQrLogin();
      setWeixinQr(result.status);
      setMessage(result.message);
    });
  }

  async function cancelWeixinQr() {
    await runAction("weixin-qr-cancel", async () => {
      const result = await window.workbenchClient.cancelWeixinQrLogin();
      setWeixinQr(result.status);
      setMessage(result.message);
    });
  }

  async function installWeixinDependency() {
    await runAction("weixin-qr-install", async () => {
      const result = await window.workbenchClient.installWeixinDependency();
      if (result.status) setWeixinQr(result.status);
      setMessage(result.message);
      if (!result.ok && result.recommendedFix) {
        setError(`${result.message} ${result.recommendedFix}`);
      }
    });
  }

  async function runAction(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败。");
    } finally {
      setBusy(undefined);
    }
  }

  const gateway = data?.gateway;
  const configuredCount = data?.connectors.filter((connector) => connector.configured && connector.enabled).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <ExternalLink size={14} />
          <span>管理 Hermes Gateway 平台接入、凭据同步和本地运行状态。</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GatewayButton gateway={gateway} busy={busy} onAction={gatewayAction} />
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-indigo-700 disabled:opacity-60"
            disabled={busy === "sync" || !data}
            onClick={syncEnv}
            type="button"
          >
            {busy === "sync" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            同步到 Hermes
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-all hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60"
            disabled={busy === "refresh"}
            onClick={() => void load()}
            type="button"
          >
            <RefreshCw size={14} className={busy === "refresh" ? "animate-spin" : ""} />
            刷新
          </button>
        </div>
      </div>

      {recommendation ? (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-emerald-900">{recommendation.title}</div>
            <div className="mt-0.5 text-xs text-emerald-700">{recommendation.detail}</div>
          </div>
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
            disabled={Boolean(recommendation.busyKey && busy === recommendation.busyKey)}
            onClick={recommendation.action}
            type="button"
          >
            {recommendation.icon}
            {recommendation.label}
          </button>
        </section>
      ) : null}

      {message ? <NoticeCard text={message} onClose={() => setMessage("")} /> : null}
      {error ? <NoticeCard text={error} onClose={() => setError("")} /> : null}

      <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="已配置平台" value={`${configuredCount}/${data?.connectors.length ?? 0}`} />
          <Metric
            label="Gateway"
            value={gateway?.healthStatus === "running" ? "运行中" : gateway?.healthStatus === "error" ? "异常" : "未运行"}
            tone={gateway?.healthStatus === "running" ? "green" : gateway?.healthStatus === "error" ? "rose" : "slate"}
          />
          <Metric label=".env 路径" value={data?.envPath ?? "加载中..."} compact />
        </div>
        {gateway?.lastError ? (
          <pre className="mt-3 max-h-28 overflow-auto rounded-lg bg-rose-50 p-3 text-xs text-rose-700">{gateway.lastError}</pre>
        ) : gateway?.lastOutput ? (
          <pre className="mt-3 max-h-28 overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-500">{gateway.lastOutput}</pre>
        ) : null}
      </section>

      {editing ? (
        <section
          ref={editorRef}
          className={cn(
            "rounded-xl border bg-white p-4 shadow-sm transition-all",
            editorJustOpened ? "border-emerald-300 ring-2 ring-emerald-100" : "border-indigo-100",
          )}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">配置 {editing.platform.label}</h3>
              <p className="mt-1 text-xs text-slate-500">{editing.platform.description}</p>
            </div>
            <button className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setEditingId(undefined)} type="button">
              关闭
            </button>
          </div>

          <label className="mb-4 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            <input
              checked={formEnabled}
              className="h-4 w-4 accent-indigo-600"
              onChange={(event) => setFormEnabled(event.target.checked)}
              type="checkbox"
            />
            启用并允许同步到 Hermes .env
          </label>

          {editorConfig ? (
            <section className="mb-4 rounded-xl border border-emerald-100 bg-emerald-50/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-emerald-900">快速配置</div>
                  <p className="mt-1 text-xs text-emerald-700">{editorConfig.summary}</p>
                  {editorConfig.detectedPresetLabel ? (
                    <p className="mt-2 text-[11px] font-medium text-emerald-800">已自动识别：{editorConfig.detectedPresetLabel}</p>
                  ) : null}
                </div>
                {editorConfig.advancedFieldKeys.length ? (
                  <button
                    className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
                    onClick={() => setShowAdvancedEditor((current) => !current)}
                    type="button"
                  >
                    <Settings size={14} />
                    {showAdvancedEditor ? "收起高级项" : "显示高级项"}
                  </button>
                ) : null}
              </div>
              {editorConfig.presets?.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {editorConfig.presets.map((preset) => (
                    <button
                      key={preset.key}
                      className="rounded-full border border-emerald-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                      onClick={() => applyQuickPreset(preset)}
                      title={preset.description}
                      type="button"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {editorConfig.tips?.length ? (
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-emerald-800">
                  {editorConfig.tips.map((tip) => (
                    <span key={tip} className="rounded-full bg-white/80 px-2.5 py-1">{tip}</span>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            {visibleEditingFields.map((field) => (
              <FieldEditor
                key={field.key}
                connector={editing}
                field={field}
                value={formValues[field.key]}
                onChange={(value) => updateEditingField(field, value)}
              />
            ))}
          </div>
          {!showAdvancedEditor && hiddenAdvancedFieldCount ? (
            <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              已隐藏 {hiddenAdvancedFieldCount} 个高级字段，常用配置先不用填；需要白名单、回调、Home Channel 等细项时再展开。
            </div>
          ) : null}

          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            {editing.platform.setupHelp.map((line) => <p key={line}>{line}</p>)}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button className="rounded-lg px-4 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100" onClick={() => setEditingId(undefined)} type="button">
              取消
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
              disabled={busy === "save"}
              onClick={saveEditing}
              type="button"
            >
              {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存
            </button>
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {(data?.connectors ?? []).map((connector) => (
          <ConnectorCard
            key={connector.platform.id}
            connector={connector}
            busy={busy}
            gatewayRunning={Boolean(gateway?.running)}
            highlighted={highlightedId === connector.platform.id}
            onEdit={() => startEditing(connector)}
            onDisable={() => void disableConnector(connector)}
            onGatewayStart={() => void gatewayAction("start")}
            onWeixinQr={connector.platform.id === "weixin" ? () => void openWeixinWizard(!connector.configured) : undefined}
          />
        ))}
      </div>

      {!data && !error ? (
        <div className="flex items-center justify-center py-16 text-sm text-slate-400">
          <Loader2 size={16} className="mr-2 animate-spin" />
          正在读取 Hermes Gateway 配置...
        </div>
      ) : null}

      <WeixinQrWizard
        busy={busy}
        connector={weixinConnector}
        open={weixinWizardOpen}
        status={weixinQr}
        onCancel={cancelWeixinQr}
        onClose={() => setWeixinWizardOpen(false)}
        onInstallDependency={installWeixinDependency}
        onRefresh={refreshWeixinQr}
        onStart={() => void openWeixinWizard(true)}
      />
    </div>
  );

  function getRecommendation(current: HermesConnectorListResult | undefined) {
    if (!current) return undefined;
    const weixin = current.connectors.find((connector) => connector.platform.id === "weixin");
    if (weixin && !weixin.configured) {
      return {
        title: "微信尚未接入",
        detail: "扫码后会自动保存凭据、同步 Hermes .env，并启动 Gateway。",
        label: "扫码接入",
        icon: busy === "weixin-qr" ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />,
        busyKey: "weixin-qr",
        action: () => void openWeixinWizard(true),
      };
    }
    if (weixin?.configured && !current.gateway.running) {
      return {
        title: "微信已配置，Gateway 未运行",
        detail: "启动后 Hermes 才会开始监听微信消息。",
        label: "启动 Gateway",
        icon: busy === "gateway-start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />,
        busyKey: "gateway-start",
        action: () => void gatewayAction("start"),
      };
    }
    return undefined;
  }
}

function GatewayButton(props: {
  gateway?: HermesGatewayStatus;
  busy?: string;
  onAction(action: "start" | "stop" | "restart"): Promise<void>;
}) {
  const running = Boolean(props.gateway?.running);
  if (running) {
    return (
      <>
        <button
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:opacity-60"
          disabled={props.busy === "gateway-restart"}
          onClick={() => void props.onAction("restart")}
          type="button"
        >
          {props.busy === "gateway-restart" ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
          重启
        </button>
        <button
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-all hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60"
          disabled={props.busy === "gateway-stop"}
          onClick={() => void props.onAction("stop")}
          type="button"
        >
          {props.busy === "gateway-stop" ? <Loader2 size={14} className="animate-spin" /> : <StopCircle size={14} />}
          停止
        </button>
      </>
    );
  }
  return (
    <button
      className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:opacity-60"
      disabled={props.busy === "gateway-start"}
      onClick={() => void props.onAction("start")}
      type="button"
    >
      {props.busy === "gateway-start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
      启动 Gateway
    </button>
  );
}

function Metric(props: { label: string; value: string; tone?: "green" | "slate" | "rose"; compact?: boolean }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase text-slate-400">{props.label}</div>
      <div className={cn(
        "mt-1 truncate text-sm font-semibold",
        props.tone === "green" ? "text-emerald-600" : props.tone === "rose" ? "text-rose-600" : "text-slate-900",
        props.compact && "font-mono text-xs",
      )}>
        {props.value}
      </div>
    </div>
  );
}

function ConnectorCard(props: {
  connector: HermesConnectorConfig;
  busy?: string;
  gatewayRunning: boolean;
  highlighted?: boolean;
  onEdit(): void;
  onDisable(): void;
  onGatewayStart(): void;
  onWeixinQr?: () => void;
}) {
  const { connector } = props;
  const isWeixin = connector.platform.id === "weixin";
  const statusClass = {
    unconfigured: "bg-slate-100 text-slate-600",
    configured: "bg-blue-50 text-blue-700",
    running: "bg-emerald-50 text-emerald-700",
    error: "bg-rose-50 text-rose-700",
    disabled: "bg-slate-100 text-slate-400",
  }[connector.status];
  const runtimeStatusClass = {
    stopped: "bg-slate-100 text-slate-600",
    running: "bg-emerald-50 text-emerald-700",
    error: "bg-rose-50 text-rose-700",
  }[connector.runtimeStatus];
  const primary = primaryAction(props);

  return (
    <section
      className={cn(
        "rounded-xl border bg-white p-4 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all hover:border-slate-200 hover:shadow-[0_8px_25px_rgba(15,23,42,0.08)]",
        props.highlighted ? "border-emerald-300 ring-2 ring-emerald-100" : "border-slate-100",
        isWeixin && "cursor-pointer",
      )}
      onClick={isWeixin ? props.onWeixinQr : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
            connector.runtimeStatus === "running" ? "bg-emerald-50 text-emerald-600" : "bg-indigo-50 text-indigo-600",
          )}>
            {isWeixin ? <QrCode size={20} /> : connector.runtimeStatus === "running" ? <Wifi size={20} /> : connector.status === "unconfigured" ? <WifiOff size={20} /> : <ExternalLink size={20} />}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">{connector.platform.label}</h3>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", statusClass)}>
                {statusLabels[connector.status]}
              </span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", runtimeStatusClass)}>
                {runtimeStatusLabels[connector.runtimeStatus]}
              </span>
              {connector.platform.category === "advanced" ? (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">高级</span>
              ) : null}
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-slate-500">{connector.platform.description}</p>
          </div>
        </div>
        <div className="flex gap-1" onClick={(event) => event.stopPropagation()}>
          <button
            className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            onClick={props.onEdit}
            title="编辑"
            type="button"
          >
            <Settings size={14} />
          </button>
          <button
            className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
            disabled={!connector.enabled || props.busy === `disable-${connector.platform.id}`}
            onClick={props.onDisable}
            title="禁用"
            type="button"
          >
            <Pause size={14} />
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
        <span className="inline-flex items-center gap-1">
          <KeyRound size={12} />
          {Object.values(connector.secretStatus).filter(Boolean).length}/{Object.keys(connector.secretStatus).length} 个密钥
        </span>
        {connector.lastSyncedAt ? <span>已同步：{formatTime(connector.lastSyncedAt)}</span> : <span>尚未同步</span>}
        {connector.missingRequired.length ? <span className="text-amber-600">缺少：{connector.missingRequired.join("、")}</span> : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2" onClick={(event) => event.stopPropagation()}>
        <p className="min-w-0 truncate text-xs text-slate-500">{connector.message}</p>
        <button
          className={cn(
            "inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium shadow-sm transition-all disabled:opacity-60",
            primary.tone === "green"
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "bg-indigo-600 text-white hover:bg-indigo-700",
          )}
          disabled={primary.disabled}
          onClick={primary.action}
          type="button"
        >
          {primary.icon}
          {primary.label}
        </button>
      </div>
    </section>
  );
}

function primaryAction(props: {
  connector: HermesConnectorConfig;
  busy?: string;
  gatewayRunning: boolean;
  onEdit(): void;
  onGatewayStart(): void;
  onWeixinQr?: () => void;
}) {
  const { connector } = props;
  if (connector.platform.id === "weixin") {
    if (!connector.configured) {
      return {
        label: "扫码接入",
        tone: "green" as const,
        icon: props.busy === "weixin-qr" ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />,
        disabled: props.busy === "weixin-qr",
        action: props.onWeixinQr ?? props.onEdit,
      };
    }
    if (!props.gatewayRunning) {
      return {
        label: "启动 Gateway",
        tone: "green" as const,
        icon: props.busy === "gateway-start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />,
        disabled: props.busy === "gateway-start",
        action: props.onGatewayStart,
      };
    }
    return {
      label: "查看状态",
      tone: "green" as const,
      icon: <CheckCircle2 size={14} />,
      disabled: false,
      action: props.onWeixinQr ?? props.onEdit,
    };
  }
  if (connector.configured && !props.gatewayRunning) {
    return {
      label: "启动 Gateway",
      tone: "green" as const,
      icon: props.busy === "gateway-start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />,
      disabled: props.busy === "gateway-start",
      action: props.onGatewayStart,
    };
  }
  return {
    label: connector.configured ? "编辑" : "快速配置",
    tone: "indigo" as const,
    icon: <Settings size={14} />,
    disabled: false,
    action: props.onEdit,
  };
}

function WeixinQrWizard(props: {
  open: boolean;
  status?: WeixinQrLoginStatus;
  connector?: HermesConnectorConfig;
  busy?: string;
  onStart(): void;
  onRefresh(): Promise<void>;
  onCancel(): Promise<void>;
  onInstallDependency(): Promise<void>;
  onClose(): void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const status = props.status ?? { running: false, phase: "idle" as const, message: "请点击开始扫码获取微信二维码。" };
  const stepIndex = stepIndexFor(status.phase);
  const canCancel = status.running || ["fetching_qr", "waiting_scan", "waiting_confirm"].includes(status.phase);
  const canRetry = isTerminalQrPhase(status.phase) && status.phase !== "success";
  const canAutoRepair = status.recoveryAction === "install_aiohttp";

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl("");
    if (!status.qrUrl) return;
    QRCode.toDataURL(status.qrUrl, {
      width: 320,
      margin: 2,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [status.qrUrl]);

  if (!props.open) return null;

  async function copyQrLink() {
    if (!status.qrUrl) return;
    await navigator.clipboard.writeText(status.qrUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm">
      <section className="w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <QrCode size={18} className="text-emerald-600" />
              <h3 className="text-base font-semibold text-slate-950">微信扫码接入</h3>
            </div>
            <p className="mt-1 text-sm text-slate-500">{status.message}</p>
          </div>
          <button
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            onClick={props.onClose}
            title="关闭"
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid gap-0 md:grid-cols-[1fr_280px]">
          <div className="p-5">
            <div className="flex flex-wrap gap-2">
              {qrSteps.map((step, index) => {
                const active = index === stepIndex;
                const done = index < stepIndex || status.phase === "success";
                return (
                  <div
                    key={step.phase}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                      done ? "bg-emerald-50 text-emerald-700" : active ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-500",
                    )}
                  >
                    {done ? <CheckCircle2 size={12} /> : active && status.running ? <Loader2 size={12} className="animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                    {step.label}
                  </div>
                );
              })}
            </div>

            <div className="mt-5 rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex min-h-[360px] flex-col items-center justify-center rounded-lg bg-white p-5">
                {status.phase === "success" ? (
                  <div className="text-center">
                    <CheckCircle2 size={56} className="mx-auto text-emerald-600" />
                    <h4 className="mt-4 text-base font-semibold text-slate-950">微信已连接</h4>
                    <p className="mt-2 max-w-sm text-sm text-slate-500">{status.message}</p>
                    {status.accountId ? <p className="mt-3 font-mono text-xs text-slate-400">Account ID: {status.accountId}</p> : null}
                  </div>
                ) : status.phase === "failed" || status.phase === "timeout" || status.phase === "cancelled" ? (
                  <div className="text-center">
                    <WifiOff size={54} className="mx-auto text-rose-500" />
                    <h4 className="mt-4 text-base font-semibold text-slate-950">
                      {status.phase === "cancelled" ? "已取消扫码" : status.phase === "timeout" ? "扫码超时" : canAutoRepair ? "扫码环境可修复" : "扫码未完成"}
                    </h4>
                    <p className="mt-2 max-w-sm text-sm text-slate-500">{status.message}</p>
                    {status.failureCode ? <p className="mt-1 text-xs text-slate-400">错误码：{status.failureCode}</p> : null}
                    {status.recommendedFix ? <p className="mt-2 max-w-sm text-xs text-slate-400">{status.recommendedFix}</p> : null}
                  </div>
                ) : qrDataUrl ? (
                  <img alt="微信扫码登录二维码" className="h-80 w-80 rounded-lg border border-slate-100 p-3 shadow-sm" src={qrDataUrl} />
                ) : status.qrUrl ? (
                  <div className="text-center">
                    <QrCode size={56} className="mx-auto text-slate-400" />
                    <p className="mt-3 text-sm text-slate-500">二维码图片生成失败，可复制链接后用微信扫码。</p>
                    <a
                      className="mt-3 max-w-sm break-all font-mono text-xs text-indigo-600 hover:underline"
                      href={status.qrUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {status.qrUrl}
                    </a>
                  </div>
                ) : status.phase === "idle" ? (
                  <div className="text-center">
                    <QrCode size={56} className="mx-auto text-slate-300" />
                    <h4 className="mt-4 text-base font-semibold text-slate-950">请点击开始扫码</h4>
                    <p className="mt-2 max-w-sm text-sm text-slate-500">二维码不会自动生成，点击右侧按钮后才会拉起本次微信扫码流程。</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <Loader2 size={40} className="mx-auto animate-spin text-indigo-500" />
                    <p className="mt-3 text-sm text-slate-500">正在准备微信二维码...</p>
                  </div>
                )}
              </div>

              {status.qrUrl ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span>{status.expiresAt ? `二维码预计过期：${formatTime(status.expiresAt)}` : "请尽快扫码，过期后可刷新。"}</span>
                  <button
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-slate-500 hover:bg-white hover:text-slate-700"
                    onClick={() => void copyQrLink()}
                    type="button"
                  >
                    <Copy size={12} />
                    {copied ? "已复制" : "复制链接"}
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <aside className="border-t border-slate-100 bg-slate-50 p-5 md:border-l md:border-t-0">
            <div className="text-xs font-medium uppercase text-slate-400">当前状态</div>
            <div className="mt-2 rounded-lg bg-white p-3 text-sm text-slate-700 shadow-sm">
              {phaseLabel(status.phase)}
            </div>

            {canAutoRepair ? (
              <div className="mt-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700 shadow-sm">
                <div>
                  <p className="font-medium">当前问题</p>
                  <p className="mt-1">缺少 `aiohttp`，微信扫码运行环境不完整。</p>
                </div>
                <div>
                  <p className="font-medium">修复动作</p>
                  <button
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-60"
                    disabled={props.busy === "weixin-qr-install"}
                    onClick={() => void props.onInstallDependency()}
                    type="button"
                  >
                    {props.busy === "weixin-qr-install" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    一键安装依赖
                  </button>
                </div>
                <div>
                  <p className="font-medium">备用信息</p>
                  {status.runtimePythonLabel ? <p className="mt-1 font-mono text-[11px] text-amber-800">{status.runtimePythonLabel}</p> : null}
                  {status.recoveryCommand ? <p className="mt-1 break-all font-mono text-[11px] text-amber-800">{status.recoveryCommand}</p> : null}
                </div>
              </div>
            ) : null}

            {props.connector ? (
              <div className="mt-4 space-y-2 rounded-lg bg-white p-3 text-xs text-slate-500 shadow-sm">
                <div className="flex justify-between gap-3">
                  <span>配置状态</span>
                  <span className="font-medium text-slate-800">{statusLabels[props.connector.status]}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>密钥</span>
                  <span className="font-medium text-slate-800">
                    {Object.values(props.connector.secretStatus).filter(Boolean).length}/{Object.keys(props.connector.secretStatus).length}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>同步</span>
                  <span className="font-medium text-slate-800">{props.connector.lastSyncedAt ? "已同步" : "未同步"}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>运行环境</span>
                  <span className="font-medium text-slate-800">{status.runtimePythonLabel || "等待检测"}</span>
                </div>
              </div>
            ) : null}

            <div className="mt-5 flex flex-col gap-2">
              {status.phase === "idle" ? (
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
                  disabled={props.busy === "weixin-qr"}
                  onClick={props.onStart}
                  type="button"
                >
                  {props.busy === "weixin-qr" ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />}
                  开始扫码
                </button>
              ) : null}
              <button
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
                disabled={props.busy === "weixin-qr-refresh" || (!canRetry && !status.qrUrl)}
                onClick={() => void props.onRefresh()}
                type="button"
              >
                {props.busy === "weixin-qr-refresh" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {canRetry ? "重新扫码" : "刷新二维码"}
              </button>
              {canCancel ? (
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-white hover:text-slate-700 disabled:opacity-60"
                  disabled={props.busy === "weixin-qr-cancel"}
                  onClick={() => void props.onCancel()}
                  type="button"
                >
                  {props.busy === "weixin-qr-cancel" ? <Loader2 size={14} className="animate-spin" /> : <StopCircle size={14} />}
                  取消扫码
                </button>
              ) : (
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-white hover:text-slate-700"
                  onClick={props.onClose}
                  type="button"
                >
                  关闭
                </button>
              )}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function FieldEditor(props: {
  connector: HermesConnectorConfig;
  field: HermesConnectorField;
  value: string | boolean | undefined;
  onChange(value: string | boolean): void;
}) {
  const { field } = props;
  if (field.type === "boolean") {
    return (
      <label className="flex min-h-[76px] items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm text-slate-600">
        <input
          checked={Boolean(props.value)}
          className="h-4 w-4 accent-indigo-600"
          onChange={(event) => props.onChange(event.target.checked)}
          type="checkbox"
        />
        <span>{field.label}{field.required ? " *" : ""}</span>
      </label>
    );
  }
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-xs font-medium uppercase text-slate-400">
        {field.secret ? <KeyRound size={11} /> : null}
        {field.label}{field.required ? " *" : ""}
      </span>
      <input
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-1 ring-transparent transition-all focus:border-indigo-400 focus:ring-indigo-100"
        placeholder={field.secret && props.connector.secretStatus[field.key] ? "已保存，留空表示不修改" : field.placeholder}
        type={field.type === "password" ? "password" : field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
        value={typeof props.value === "string" ? props.value : ""}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <span className="mt-1 block truncate font-mono text-[11px] text-slate-400">{field.envVar}</span>
    </label>
  );
}

function withConnectorDefaults(platformId: HermesConnectorPlatformId, values: FormValues, changedKey?: string) {
  const next = { ...values };
  if (platformId === "signal" && !stringValue(next.httpUrl)) {
    next.httpUrl = "http://127.0.0.1:8080";
  }
  if (platformId === "homeassistant" && !stringValue(next.url)) {
    next.url = "http://homeassistant.local:8123";
  }
  if (platformId === "wecom_callback" && !stringValue(next.port)) {
    next.port = "8645";
  }
  if (platformId === "matrix" && !stringValue(next.homeserver)) {
    next.homeserver = "https://matrix.org";
  }
  if (platformId === "email") {
    const address = stringValue(next.address);
    const detected = detectEmailPreset(address);
    if (detected && (changedKey === "address" || !stringValue(next.imapHost) || !stringValue(next.smtpHost))) {
      next.imapHost = EMAIL_PROVIDER_PRESETS[detected].imapHost;
      next.smtpHost = EMAIL_PROVIDER_PRESETS[detected].smtpHost;
    }
    if (address && !stringValue(next.homeAddress)) {
      next.homeAddress = address;
    }
  }
  return next;
}

function getConnectorEditorConfig(platformId: HermesConnectorPlatformId, values: FormValues): ConnectorEditorConfig {
  const emailPreset = detectEmailPreset(stringValue(values.address));
  switch (platformId) {
    case "telegram":
      return {
        summary: "Telegram 最小可用只要 Bot Token，允许用户和 Home Channel 后面再补。",
        advancedFieldKeys: ["allowedUsers", "homeChannel"],
        tips: ["先拿到 BotFather token", "建议接入成功后再限制允许用户"],
      };
    case "discord":
      return {
        summary: "Discord 先填 Bot Token 即可，频道白名单和 Home Channel 都可以后置。",
        advancedFieldKeys: ["allowedUsers", "homeChannel"],
        tips: ["先在 Developer Portal 创建 Bot", "Message Content Intent 记得开启"],
      };
    case "slack":
      return {
        summary: "Slack 先填 Bot Token 和 App Token，频道限制先不填也能跑起来。",
        advancedFieldKeys: ["allowedUsers", "homeChannel"],
        tips: ["仍需先在 Slack 后台创建应用", "Socket Mode 开启后体验最好"],
      };
    case "whatsapp":
      return {
        summary: "桌面侧先启用 WhatsApp 即可，白名单不是首次接入必填；后续配对建议单独做扫码流程。",
        advancedFieldKeys: ["allowedUsers"],
        tips: ["建议先启用，再补允许号码", "后续最适合做成和微信类似的扫码接入"],
      };
    case "signal":
      return {
        summary: "Signal 默认使用本机 `signal-cli` HTTP bridge，通常只需要账号和默认本地地址。",
        advancedFieldKeys: ["allowedUsers", "homeChannel"],
        presets: [
          {
            key: "signal-localhost",
            label: "本机默认地址",
            description: "填入常见的本机 signal-cli bridge 地址。",
            apply: (current) => ({ ...current, httpUrl: "http://127.0.0.1:8080" }),
          },
        ],
        tips: ["先确认 signal-cli daemon 已启动", "允许用户和 Home Channel 可后置"],
      };
    case "email":
      return {
        summary: "邮箱接入优先只填邮箱和密码，常见服务商的 IMAP/SMTP 会自动补齐。",
        advancedFieldKeys: ["imapHost", "smtpHost", "allowedUsers", "homeAddress"],
        forceVisibleFieldKeys: emailPreset ? [] : ["imapHost", "smtpHost"],
        detectedPresetLabel: emailPreset ? `${EMAIL_PROVIDER_PRESETS[emailPreset].label} 服务器地址已自动填入` : undefined,
        presets: (Object.entries(EMAIL_PROVIDER_PRESETS) as Array<[EmailProviderPresetKey, typeof EMAIL_PROVIDER_PRESETS[EmailProviderPresetKey]]>).map(([key, preset]) => ({
          key,
          label: preset.label,
          description: `自动填入 ${preset.imapHost} / ${preset.smtpHost}`,
          apply: (current) => ({ ...current, imapHost: preset.imapHost, smtpHost: preset.smtpHost }),
        })),
        tips: emailPreset
          ? ["邮箱地址已识别，服务器地址会自动填写", "发件人限制和 Home Address 可后置"]
          : ["如果不是常见邮箱，请展开或直接填写自定义 IMAP/SMTP", "Gmail/Outlook 建议使用 App Password 或 OAuth"],
      };
    case "matrix":
      return {
        summary: "Matrix 建议先用 homeserver + access token 跑通，房间限制和密码登录放到高级项。",
        advancedFieldKeys: ["userId", "password", "allowedUsers", "homeRoom"],
        presets: [
          {
            key: "matrix-org",
            label: "Matrix.org",
            description: "填入官方 Matrix homeserver。",
            apply: (current) => ({ ...current, homeserver: "https://matrix.org" }),
          },
        ],
        tips: ["默认先走 access token 模式", "如需密码登录再展开高级项"],
      };
    case "mattermost":
      return {
        summary: "Mattermost 只要服务器地址和 Bot Token 就能完成最小配置。",
        advancedFieldKeys: ["allowedUsers", "homeChannel"],
      };
    case "dingtalk":
      return {
        summary: "钉钉最小可用只需要 AppKey 和 AppSecret，用户限制后置。",
        advancedFieldKeys: ["allowedUsers", "homeChannel"],
      };
    case "feishu":
      return {
        summary: "飞书先填 App ID 和 App Secret 即可，访问控制可以后补。",
        advancedFieldKeys: ["allowedUsers", "homeChannel"],
      };
    case "homeassistant":
      return {
        summary: "Home Assistant 先填地址和长期 Token，默认局域网地址可一键带入。",
        advancedFieldKeys: [],
        presets: [
          {
            key: "hass-local",
            label: "默认局域网地址",
            description: "填入常见的本地 Home Assistant 地址。",
            apply: (current) => ({ ...current, url: "http://homeassistant.local:8123" }),
          },
        ],
      };
    case "wecom":
      return {
        summary: "企业微信 AI Bot 首次只需要 Bot ID 和 Secret，允许用户与 Home Channel 后置。",
        advancedFieldKeys: ["allowedUsers", "homeChannel"],
      };
    case "wecom_callback":
      return {
        summary: "企业微信回调模式先填 Corp ID / Secret 即可，回调 Token、AESKey 和端口按需展开。",
        advancedFieldKeys: ["agentId", "token", "aesKey", "port", "allowedUsers"],
        presets: [
          {
            key: "wecom-port",
            label: "默认回调端口",
            description: "填入推荐的回调端口 8645。",
            apply: (current) => ({ ...current, port: "8645" }),
          },
        ],
      };
    case "weixin":
      return {
        summary: "微信优先走扫码接入；这里保留的是手动补充和微调配置，高级项平时不必改。",
        advancedFieldKeys: ["baseUrl", "cdnBaseUrl", "dmPolicy", "allowAllUsers", "allowedUsers", "groupPolicy", "groupAllowedUsers", "homeChannel"],
        tips: ["首次接入推荐继续使用扫码", "这里只适合已接入后的参数微调"],
      };
    case "bluebubbles":
      return {
        summary: "BlueBubbles 先填服务地址和密码，访问控制字段可以后置。",
        advancedFieldKeys: ["allowedUsers", "homeChannel"],
      };
    case "sms":
      return {
        summary: "SMS 适配器依赖 Hermes 侧实现，常用情况下先不填限制字段。",
        advancedFieldKeys: ["homeChannel", "allowedUsers"],
      };
    case "qqbot":
      return {
        summary: "QQ Bot 先跑通适配器，再按需补充允许用户和群聊限制。",
        advancedFieldKeys: ["allowedUsers", "groupAllowedUsers", "homeChannel"],
      };
    default:
      return {
        summary: "先完成最小必填项，更多限制和高级参数可后置。",
        advancedFieldKeys: [],
      };
  }
}

function detectEmailPreset(address: string): EmailProviderPresetKey | undefined {
  const domain = address.split("@")[1]?.trim().toLowerCase();
  if (!domain) return undefined;
  return (Object.entries(EMAIL_PROVIDER_PRESETS) as Array<[EmailProviderPresetKey, typeof EMAIL_PROVIDER_PRESETS[EmailProviderPresetKey]]>)
    .find(([, preset]) => preset.match.test(domain))?.[0];
}

function stringValue(value: string | boolean | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function stepIndexFor(phase: WeixinQrLoginPhase) {
  if (phase === "failed" || phase === "timeout" || phase === "cancelled" || phase === "idle") return 0;
  return Math.max(0, qrSteps.findIndex((step) => step.phase === phase));
}

function isTerminalQrPhase(phase: WeixinQrLoginPhase) {
  return phase === "success" || phase === "failed" || phase === "timeout" || phase === "cancelled";
}

function phaseLabel(phase: WeixinQrLoginPhase) {
  const labels: Record<WeixinQrLoginPhase, string> = {
    idle: "准备开始",
    fetching_qr: "正在获取二维码",
    waiting_scan: "等待微信扫码",
    waiting_confirm: "等待手机确认",
    saving: "正在保存凭据",
    syncing: "正在同步 Hermes .env",
    starting_gateway: "正在启动 Gateway",
    success: "接入成功",
    timeout: "扫码超时",
    failed: "接入失败",
    cancelled: "已取消",
  };
  return labels[phase];
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
