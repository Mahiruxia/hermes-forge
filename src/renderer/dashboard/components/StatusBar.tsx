import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, DownloadCloud, Loader2, RadioTower, Server, ServerOff, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import type { ClientUpdateEvent, HermesGatewayStatus, HermesProbeSummary, HermesStatusSummary } from "../../../shared/types";
import { useAppStore } from "../../store";
import { cn } from "../DashboardPrimitives";

type ConnectionState = "connected" | "warning" | "disconnected" | "checking";
type BadgeTone = "ok" | "warn" | "error" | "idle";

export function StatusBar() {
  const store = useAppStore();
  const [apiStatus, setApiStatus] = useState<ConnectionState>(store.clientInfo ? "connected" : "checking");
  const [hermesStatus, setHermesStatus] = useState<ConnectionState>(resolveHermesConnection(store.hermesProbe, store.hermesStatus));
  const [gatewayStatus, setGatewayStatus] = useState<HermesGatewayStatus | undefined>();
  const [clientUpdate, setClientUpdate] = useState<ClientUpdateEvent | undefined>();
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  useEffect(() => {
    if (store.clientInfo) {
      setApiStatus("connected");
    }
  }, [store.clientInfo]);

  useEffect(() => {
    setHermesStatus((current) => {
      const resolved = resolveHermesConnection(store.hermesProbe, store.hermesStatus);
      return current === "checking" || current === "disconnected" ? resolved : current;
    });
  }, [store.hermesProbe, store.hermesStatus]);

  const checkApiStatus = useCallback(async () => {
    setApiStatus(store.clientInfo ? "connected" : "checking");

    if (!window.workbenchClient || typeof window.workbenchClient.getClientInfo !== "function") {
      setApiStatus(store.clientInfo ? "connected" : "disconnected");
      return;
    }

    try {
      const result = await window.workbenchClient.getClientInfo();
      setApiStatus(result && typeof result === "object" ? "connected" : "disconnected");
    } catch (error) {
      console.error("API check failed:", error);
      setApiStatus(store.clientInfo ? "connected" : "disconnected");
    }
  }, [store.clientInfo]);

  const checkHermesStatus = useCallback(async () => {
    setHermesStatus(resolveHermesConnection(store.hermesProbe, store.hermesStatus));

    if (!window.workbenchClient || typeof window.workbenchClient.getHermesProbe !== "function") {
      setHermesStatus(resolveHermesConnection(store.hermesProbe, store.hermesStatus));
      return;
    }

    try {
      const probe = await window.workbenchClient.getHermesProbe();
      setHermesStatus(resolveHermesConnection(probe, store.hermesStatus));
    } catch (error) {
      console.error("Hermes check failed:", error);
      setHermesStatus(resolveHermesConnection(store.hermesProbe, store.hermesStatus));
    }
  }, [store.hermesProbe, store.hermesStatus]);

  const checkAllStatus = useCallback(async () => {
    const gateway = await window.workbenchClient?.getGatewayStatus?.().catch(() => undefined);
    setGatewayStatus(gateway);
    await Promise.all([checkApiStatus(), checkHermesStatus()]);
    setLastChecked(new Date().toLocaleTimeString("zh-CN"));
  }, [checkApiStatus, checkHermesStatus]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void checkAllStatus();
    }, 250);
    const interval = window.setInterval(() => {
      void checkAllStatus();
    }, 10000);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [checkAllStatus]);

  useEffect(() => window.workbenchClient?.onClientUpdateEvent?.((event) => setClientUpdate(event)), []);

  const statusItems = useMemo(() => [
    makeStatusItem({
      key: "api",
      shortLabel: "API",
      detail: apiStatus === "connected" ? "API 连接正常" : apiStatus === "disconnected" ? "API 服务不可用" : "正在检查 API",
      tone: connectionTone(apiStatus),
      icon: apiStatus === "connected" ? Wifi : apiStatus === "disconnected" ? WifiOff : Loader2,
      spinning: apiStatus === "checking",
      lastChecked,
      glowing: apiStatus === "connected",
    }),
    makeStatusItem({
      key: "hermes",
      shortLabel: "Hermes",
      detail: hermesDetail(hermesStatus, store.hermesProbe, store.hermesStatus),
      tone: connectionTone(hermesStatus),
      icon: hermesStatus === "connected" ? ShieldCheck : hermesIcon(hermesStatus),
      spinning: hermesStatus === "checking",
      lastChecked,
      glowing: hermesStatus === "connected" || hermesStatus === "warning",
    }),
    makeStatusItem({
      key: "gateway",
      shortLabel: "Gateway",
      detail: gatewayTooltip(gatewayStatus),
      tone: gatewayTone(gatewayStatus),
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
      icon: updateIcon(clientUpdate),
      spinning: clientUpdate?.status === "checking" || clientUpdate?.status === "downloading",
      lastChecked,
      glowing: updateTone(clientUpdate) === "ok" || updateTone(clientUpdate) === "warn",
    }),
  ], [apiStatus, clientUpdate, gatewayStatus, hermesStatus, lastChecked, store.hermesProbe, store.hermesStatus]);

  return (
    <div className="hidden items-center gap-1.5 lg:flex">
      {statusItems.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition",
              toneClass(item.tone),
            )}
            title={`${item.detail}${item.lastChecked ? ` · 最后检查 ${item.lastChecked}` : ""}`}
            aria-label={item.detail}
            type="button"
          >
            <span className={cn("inline-flex h-4 w-4 items-center justify-center", item.spinning && "animate-spin")}>
              <Icon size={11} />
            </span>
            <span>{item.shortLabel}</span>
            <span
              data-testid={`status-light-${item.key}`}
              className={cn("hermes-status-light", statusLightClass(item.tone), !item.glowing && !item.spinning && item.tone !== "error" && "hermes-status-light--idle")}
            >
              <span className="sr-only">{item.tone}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function makeStatusItem(item: {
  key: string;
  shortLabel: string;
  detail: string;
  tone: BadgeTone;
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

function hermesDetail(status: ConnectionState, probe?: HermesProbeSummary, summary?: HermesStatusSummary) {
  if (probe?.probe.message?.trim()) return probe.probe.message;
  if (summary?.engine?.message?.trim()) return summary.engine.message;
  if (status === "connected") return "Hermes 在线";
  if (status === "warning") return "Hermes 可用，但存在警告";
  if (status === "disconnected") return "Hermes 离线";
  return "正在检查 Hermes";
}

function hermesIcon(status: ConnectionState) {
  if (status === "connected") return Server;
  if (status === "warning") return AlertCircle;
  if (status === "disconnected") return ServerOff;
  return Loader2;
}

function gatewayTooltip(status?: HermesGatewayStatus) {
  if (!status) return "正在检查 Gateway";
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
  return "idle";
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
