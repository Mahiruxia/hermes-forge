import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRight, ChevronDown, DownloadCloud, Loader2, RadioTower, Server, ServerOff, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { ClientUpdateEvent, HermesGatewayStatus, HermesProbeSummary, HermesStatusSummary } from "../../../shared/types";
import { useAppStore } from "../../store";
import { cn } from "../DashboardPrimitives";

type ConnectionState = "connected" | "warning" | "disconnected" | "checking";
type BadgeTone = "ok" | "warn" | "error" | "idle";
type StatusLevel = BadgeTone | "checking" | "notice";

export function StatusBar(props: { onOpenHealth?: () => void } = {}) {
  const statusSource = useAppStore(useShallow((state) => ({
    clientInfo: state.clientInfo,
    hermesProbe: state.hermesProbe,
    hermesStatus: state.hermesStatus,
    hermesRuntimeMode: state.runtimeConfig?.hermesRuntime?.mode,
  })));
  const [apiStatus, setApiStatus] = useState<ConnectionState>(statusSource.clientInfo ? "connected" : "checking");
  const [hermesStatus, setHermesStatus] = useState<ConnectionState>(resolveHermesConnection(statusSource.hermesProbe, statusSource.hermesStatus));
  const [gatewayStatus, setGatewayStatus] = useState<HermesGatewayStatus | undefined>();
  const [clientUpdate, setClientUpdate] = useState<ClientUpdateEvent | undefined>();
  const [open, setOpen] = useState(false);
  const [lastChecked] = useState<string | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const hermesUpdate = statusSource.hermesStatus?.update;

  useEffect(() => {
    if (statusSource.clientInfo) {
      setApiStatus("connected");
    }
  }, [statusSource.clientInfo]);

  useEffect(() => {
    setHermesStatus(resolveHermesConnection(statusSource.hermesProbe, statusSource.hermesStatus));
  }, [statusSource.hermesProbe, statusSource.hermesStatus]);

  useEffect(() => window.workbenchClient?.onClientUpdateEvent?.((event) => setClientUpdate(event)), []);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const status = await window.workbenchClient.getGatewayStatus();
        if (!cancelled) setGatewayStatus(status);
      } catch {
        if (!cancelled) setGatewayStatus(undefined);
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event: MouseEvent) {
      if (statusRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const statusItems = useMemo(() => [
    makeStatusItem({
      key: "api",
      shortLabel: "API",
      detail: apiStatus === "connected" ? "API 连接正常" : apiStatus === "disconnected" ? "API 服务不可用" : "正在检查 API",
      tone: connectionTone(apiStatus),
      level: apiStatus === "checking" ? "checking" : connectionTone(apiStatus),
      icon: apiStatus === "connected" ? Wifi : apiStatus === "disconnected" ? WifiOff : Loader2,
      spinning: apiStatus === "checking",
      lastChecked,
      glowing: apiStatus === "connected",
    }),
    makeStatusItem({
      key: "hermes",
      shortLabel: hermesUpdate?.updateAvailable ? "Hermes 更新" : "Hermes",
      detail: hermesUpdate?.updateAvailable
        ? hermesUpdate.message
        : hermesDetail(hermesStatus, statusSource.hermesProbe, statusSource.hermesStatus, statusSource.hermesRuntimeMode),
      tone: hermesUpdate?.updateAvailable ? "warn" : connectionTone(hermesStatus),
      level: hermesUpdate?.updateAvailable ? "notice" : hermesStatus === "checking" ? "checking" : connectionTone(hermesStatus),
      icon: hermesUpdate?.updateAvailable ? DownloadCloud : hermesStatus === "connected" ? ShieldCheck : hermesIcon(hermesStatus),
      spinning: hermesStatus === "checking",
      lastChecked,
      glowing: hermesUpdate?.updateAvailable || hermesStatus === "connected" || hermesStatus === "warning",
    }),
    makeStatusItem({
      key: "gateway",
      shortLabel: "Gateway",
      detail: gatewayTooltip(gatewayStatus),
      tone: gatewayTone(gatewayStatus),
      level: gatewayStatus?.autoStartState === "starting" ? "checking" : gatewayTone(gatewayStatus),
      icon: gatewayIcon(gatewayStatus),
      spinning: gatewayStatus?.autoStartState === "starting",
      lastChecked,
      glowing: gatewayTone(gatewayStatus) === "ok" || gatewayTone(gatewayStatus) === "warn",
    }),
    makeStatusItem({
      key: "update",
      shortLabel: updateShortLabel(clientUpdate),
      detail: clientUpdate?.message ?? "客户端更新状态",
      tone: updateTone(clientUpdate),
      level: updateLevel(clientUpdate),
      icon: updateIcon(clientUpdate),
      spinning: clientUpdate?.status === "checking" || clientUpdate?.status === "downloading",
      lastChecked,
      glowing: updateTone(clientUpdate) === "ok" || updateTone(clientUpdate) === "warn",
    }),
  ], [apiStatus, clientUpdate, gatewayStatus, hermesStatus, hermesUpdate, lastChecked, statusSource.hermesProbe, statusSource.hermesRuntimeMode, statusSource.hermesStatus]);
  const overall = summarizeStatus(statusItems);
  const OverallIcon = overall.icon;
  const needsHealthAction = statusItems.some((item) =>
    ["api", "hermes", "gateway"].includes(item.key) && (item.level === "error" || item.level === "warn")
  );

  return (
    <div ref={statusRef} className="relative">
      <button
        aria-expanded={open}
        aria-label={`${overall.label}：${overall.detail}`}
        className={cn(
          "hermes-status-summary inline-flex h-8 max-w-[168px] items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold shadow-[0_8px_22px_rgba(15,23,42,0.045)] transition hover:-translate-y-px hover:bg-white hover:shadow-[0_12px_28px_rgba(15,23,42,0.075)] max-sm:w-8 max-sm:justify-center max-sm:px-0",
          toneClass(overall.tone),
        )}
        onClick={() => setOpen((value) => !value)}
        title={overall.detail}
        type="button"
      >
        <span className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center", overall.spinning && "animate-spin")}>
          <OverallIcon size={12} />
        </span>
        <span className="min-w-0 truncate max-sm:hidden">{overall.label}</span>
        <span data-testid="status-summary-light" className={cn("hermes-status-light max-sm:hidden", statusLightClass(overall.tone), overall.tone === "idle" && "hermes-status-light--idle")}>
          <span className="sr-only">{overall.tone}</span>
        </span>
        <ChevronDown size={12} className={cn("shrink-0 text-slate-400 transition max-sm:hidden", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="hermes-popover absolute right-0 top-[calc(100%+10px)] z-[45] w-72 rounded-2xl border border-slate-200/80 bg-white p-2 shadow-[0_18px_45px_rgba(15,23,42,0.12)]">
          <div className="px-2 pb-2 pt-1">
            <p className="text-[13px] font-semibold text-slate-900">{overall.label}</p>
            <p className="mt-0.5 break-words text-[11px] leading-4 text-slate-400">{overall.detail}</p>
          </div>
        {statusItems.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.key}
              className={cn(
                "hermes-status-detail-row flex items-start gap-2 rounded-xl px-2.5 py-2 text-left transition",
                item.level === "error" && "bg-rose-50 text-rose-700",
                (item.level === "warn" || item.level === "notice" || item.level === "checking") && "bg-amber-50/75 text-amber-700",
                (item.level === "ok" || item.level === "idle") && "text-slate-500",
              )}
              title={`${item.detail}${item.lastChecked ? ` · 最后检查 ${item.lastChecked}` : ""}`}
            >
              <span className={cn("mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/75", item.spinning && "animate-spin")}>
                <Icon size={12} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-semibold">{item.shortLabel}</span>
                <span className="mt-0.5 block break-words text-[11px] leading-4 opacity-75">{item.detail}</span>
              </span>
              <span
                data-testid={`status-light-${item.key}`}
                className={cn("hermes-status-light mt-2 shrink-0", statusLightClass(item.tone), !item.glowing && !item.spinning && item.tone !== "error" && "hermes-status-light--idle")}
              >
                <span className="sr-only">{item.tone}</span>
              </span>
            </div>
          );
        })}
        {needsHealthAction && props.onOpenHealth ? (
          <button
            className="mt-1 flex w-full items-center justify-between rounded-xl bg-slate-950 px-3 py-2.5 text-left text-[12px] font-semibold text-white transition hover:bg-slate-800"
            onClick={() => {
              setOpen(false);
              props.onOpenHealth?.();
            }}
            type="button"
          >
            打开健康检查 <ArrowRight size={13} />
          </button>
        ) : null}
        </div>
      ) : null}
    </div>
  );
}

function makeStatusItem(item: {
  key: string;
  shortLabel: string;
  detail: string;
  tone: BadgeTone;
  level: StatusLevel;
  icon: typeof Wifi;
  spinning?: boolean;
  lastChecked: string | null;
  glowing?: boolean;
}) {
  return item;
}

function resolveHermesConnection(probe?: HermesProbeSummary, status?: HermesStatusSummary): ConnectionState {
  if (probe?.probe.status === "healthy") return "connected";
  if (probe?.probe.status === "warning") return "warning";
  if (probe?.probe.status === "offline") return "disconnected";
  if (status?.engine?.available) return "connected";
  return "checking";
}

function connectionTone(status: ConnectionState): BadgeTone {
  if (status === "connected") return "ok";
  if (status === "warning") return "warn";
  if (status === "disconnected") return "error";
  return "warn";
}

function hermesDetail(status: ConnectionState, probe?: HermesProbeSummary, summary?: HermesStatusSummary, runtimeMode?: "windows" | "wsl" | "darwin") {
  const runtimeLabel = runtimeMode === "wsl" ? "WSL" : runtimeMode === "windows" ? "Windows" : runtimeMode === "darwin" ? "macOS" : undefined;
  const probeMessage = probe?.probe.message?.trim();
  const probeDetail = isBridgeNoise(probeMessage) ? undefined : probeMessage;
  const base = probeDetail
    || summary?.engine?.message?.trim()
    || (status === "connected" ? "Hermes 在线" : status === "warning" ? "Hermes 可用，但存在警告" : status === "disconnected" ? "Hermes 离线" : "正在检查 Hermes");
  return runtimeLabel ? `${base} · 当前运行：${runtimeLabel}` : base;
}

function isBridgeNoise(message?: string) {
  return Boolean(message && /Windows Control Bridge 不可达|Bridge 本机 health 不可访问|Windows Control Bridge 未启动|Bridge access 信息不可用/i.test(message));
}

function hermesIcon(status: ConnectionState) {
  if (status === "connected") return Server;
  if (status === "warning") return AlertCircle;
  if (status === "disconnected") return ServerOff;
  return Loader2;
}

function gatewayTooltip(status?: HermesGatewayStatus) {
  if (!status) return "Gateway 状态未刷新";
  return status.autoStartMessage || status.message || "Gateway 状态未知";
}

function gatewayIcon(status?: HermesGatewayStatus) {
  if (status?.autoStartState === "starting") return Loader2;
  if (status?.running) return RadioTower;
  return ServerOff;
}

function gatewayTone(status?: HermesGatewayStatus): BadgeTone {
  if (!status) return "idle";
  if (status.autoStartState === "starting") return "warn";
  if (status.running || status.healthStatus === "running") return "ok";
  if (status.healthStatus === "error" || status.autoStartState === "failed") return "error";
  return "idle";
}

function updateShortLabel(event?: ClientUpdateEvent) {
  if (!event) return "更新";
  if (event.status === "available") return "新版本";
  if (event.status === "downloading") return `${Math.round(event.percent ?? 0)}%`;
  if (event.status === "downloaded") return "待重启";
  if (event.status === "skipped") return "已跳过";
  if (event.status === "checking") return "检查中";
  if (event.status === "error") return "更新异常";
  return "已最新";
}

function updateIcon(event?: ClientUpdateEvent) {
  if (event?.status === "checking" || event?.status === "downloading") return Loader2;
  if (event?.status === "error") return AlertCircle;
  return DownloadCloud;
}

function updateTone(event?: ClientUpdateEvent): BadgeTone {
  if (event?.status === "available" || event?.status === "downloaded") return "ok";
  if (event?.status === "checking" || event?.status === "downloading") return "warn";
  if (event?.status === "error") return "error";
  if (event?.status === "skipped") return "idle";
  return "idle";
}

function updateLevel(event?: ClientUpdateEvent): StatusLevel {
  if (event?.status === "available" || event?.status === "downloaded") return "notice";
  if (event?.status === "checking" || event?.status === "downloading") return "checking";
  if (event?.status === "error") return "error";
  return "idle";
}

function summarizeStatus(items: ReturnType<typeof makeStatusItem>[]) {
  if (items.some((item) => item.level === "error")) {
    return {
      label: "环境需处理",
      detail: firstDetail(items, "error"),
      tone: "error" as BadgeTone,
      icon: AlertCircle,
      spinning: false,
    };
  }
  if (items.some((item) => item.level === "warn" || item.level === "notice")) {
    return {
      label: "有提醒",
      detail: firstDetail(items, "warn", "notice"),
      tone: "warn" as BadgeTone,
      icon: AlertCircle,
      spinning: false,
    };
  }
  if (items.some((item) => item.level === "checking")) {
    return {
      label: "检查中",
      detail: firstDetail(items, "checking"),
      tone: "warn" as BadgeTone,
      icon: Loader2,
      spinning: true,
    };
  }
  return {
    label: "环境就绪",
    detail: "API、Hermes 与本地能力处于可用状态",
    tone: "ok" as BadgeTone,
    icon: ShieldCheck,
    spinning: false,
  };
}

function firstDetail(items: ReturnType<typeof makeStatusItem>[], ...levels: StatusLevel[]) {
  return items.find((item) => levels.includes(item.level))?.detail ?? "状态需要关注";
}

function toneClass(tone: BadgeTone) {
  return cn(
    "border-slate-200 bg-white text-slate-500 shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
    tone === "ok" && "border-emerald-100 bg-[var(--hermes-online-soft)] text-emerald-700",
    tone === "warn" && "border-orange-100 bg-[var(--hermes-warn-soft)] text-orange-700",
    tone === "error" && "border-rose-100 bg-rose-50 text-rose-700",
  );
}

function statusLightClass(tone: BadgeTone) {
  return cn(
    tone === "ok" && "hermes-status-light--ok",
    tone === "warn" && "hermes-status-light--warn",
    tone === "error" && "hermes-status-light--error",
    tone === "idle" && "hermes-status-light--idle",
  );
}
