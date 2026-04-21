import { useAppStore } from "../../store";
import { cn } from "../DashboardPrimitives";
import { Wifi, WifiOff, Server, ServerOff, CheckCircle2, AlertCircle, Loader2, RefreshCw, RadioTower, DownloadCloud } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import type { ClientUpdateEvent, HermesGatewayStatus } from "../../../shared/types";

export function StatusBar() {
  const store = useAppStore();
  const [apiStatus, setApiStatus] = useState<"connected" | "disconnected" | "checking">("checking");
  const [hermesStatus, setHermesStatus] = useState<"connected" | "disconnected" | "checking">("checking");
  const [gatewayStatus, setGatewayStatus] = useState<HermesGatewayStatus | undefined>();
  const [clientUpdate, setClientUpdate] = useState<ClientUpdateEvent | undefined>();
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  const checkApiStatus = useCallback(async () => {
    setApiStatus("checking");
    
    if (!window.workbenchClient || typeof window.workbenchClient.getClientInfo !== "function") {
      setApiStatus("disconnected");
      return;
    }

    try {
      const result = await window.workbenchClient.getClientInfo();
      // 真正验证 API 是否正常工作
      if (result && typeof result === "object") {
        setApiStatus("connected");
      } else {
        setApiStatus("disconnected");
      }
    } catch (error) {
      console.error("API check failed:", error);
      setApiStatus("disconnected");
    }
  }, []);

  const checkHermesStatus = useCallback(async () => {
    setHermesStatus("checking");

    // 尝试调用 Hermes 相关 API 来验证
    if (!window.workbenchClient || typeof window.workbenchClient.getHermesProbe !== "function") {
      // 回退到检查 store 中的状态
      const hermes = store.hermesStatus;
      setHermesStatus(hermes?.engine?.available ? "connected" : "disconnected");
      return;
    }

    try {
      const probe = await window.workbenchClient.getHermesProbe();
      if (probe?.probe?.status === "healthy") {
        setHermesStatus("connected");
      } else {
        setHermesStatus("disconnected");
      }
    } catch (error) {
      console.error("Hermes check failed:", error);
      // 回退到检查 store 中的状态
      const hermes = store.hermesStatus;
      setHermesStatus(hermes?.engine?.available ? "connected" : "disconnected");
    }
  }, [store.hermesStatus]);

  const checkAllStatus = useCallback(async () => {
    const gateway = await window.workbenchClient?.getGatewayStatus?.().catch(() => undefined);
    setGatewayStatus(gateway);
    await Promise.all([checkApiStatus(), checkHermesStatus()]);
    setLastChecked(new Date().toLocaleTimeString("zh-CN"));
  }, [checkApiStatus, checkHermesStatus]);

  useEffect(() => {
    // 初始检查
    const initialTimer = setTimeout(checkAllStatus, 500);
    
    // 每10秒自动检查一次
    const interval = setInterval(checkAllStatus, 10000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [checkAllStatus]);

  useEffect(() => {
    return window.workbenchClient?.onClientUpdateEvent?.((event) => {
      setClientUpdate(event);
    });
  }, []);

  const handleRefresh = () => {
    checkAllStatus();
  };

  const statusItems = [
    {
      key: "api",
      label: "API",
      icon: apiStatus === "connected" ? Wifi : apiStatus === "disconnected" ? WifiOff : Loader2,
      status: apiStatus,
      color: apiStatus === "connected" ? "text-emerald-600" : apiStatus === "disconnected" ? "text-rose-600" : "text-slate-400",
      bgColor: apiStatus === "connected" ? "bg-emerald-50" : apiStatus === "disconnected" ? "bg-rose-50" : "bg-slate-50",
      tooltip: apiStatus === "connected" ? "API 服务正常" : apiStatus === "disconnected" ? "API 服务不可用" : "正在检查 API...",
    },
    {
      key: "hermes",
      label: "Hermes",
      icon: hermesStatus === "connected" ? Server : hermesStatus === "disconnected" ? ServerOff : Loader2,
      status: hermesStatus,
      color: hermesStatus === "connected" ? "text-emerald-600" : hermesStatus === "disconnected" ? "text-rose-600" : "text-slate-400",
      bgColor: hermesStatus === "connected" ? "bg-emerald-50" : hermesStatus === "disconnected" ? "bg-rose-50" : "bg-slate-50",
      tooltip: hermesStatus === "connected" ? "Hermes 已连接" : hermesStatus === "disconnected" ? "Hermes 未连接或不可用" : "正在检查 Hermes...",
    },
    {
      key: "gateway",
      label: gatewayLabel(gatewayStatus),
      icon: gatewayIcon(gatewayStatus),
      status: gatewayBadgeStatus(gatewayStatus),
      color: gatewayColor(gatewayStatus),
      bgColor: gatewayBgColor(gatewayStatus),
      tooltip: gatewayTooltip(gatewayStatus),
    },
    {
      key: "update",
      label: updateLabel(clientUpdate),
      icon: updateIcon(clientUpdate),
      status: updateBadgeStatus(clientUpdate),
      color: updateColor(clientUpdate),
      bgColor: updateBgColor(clientUpdate),
      tooltip: clientUpdate?.message ?? "客户端自动更新已就绪",
    },
  ];

  return (
    <div className="flex items-center gap-3">
      {statusItems.map((item) => {
        const Icon = item.icon;
        return (
          <div
            key={item.key}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1",
              item.bgColor
            )}
            title={`${item.tooltip}${lastChecked ? ` (最后检查: ${lastChecked})` : ""}`}
          >
            <Icon size={12} className={cn(item.color, item.status === "checking" && "animate-spin")} />
            <span className={cn("text-[11px] font-medium", item.color)}>
              {item.label}
              {item.status === "checking" && " ..."}
            </span>
            {item.status !== "checking" && (
              item.status === "connected"
                ? <CheckCircle2 size={10} className={item.color} />
                : <AlertCircle size={10} className={item.color} />
            )}
          </div>
        );
      })}
      
      <button
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        onClick={() => {
          handleRefresh();
          void window.workbenchClient?.checkClientUpdate?.().then(setClientUpdate).catch((error) => {
            setClientUpdate({
              status: "error",
              message: error instanceof Error ? error.message : "客户端更新检查失败。",
              at: new Date().toISOString(),
            });
          });
        }}
        type="button"
        title="刷新状态并检查客户端更新"
      >
        <RefreshCw size={10} />
        刷新
      </button>
    </div>
  );
}

function gatewayBadgeStatus(status?: HermesGatewayStatus): "connected" | "disconnected" | "checking" {
  if (status?.autoStartState === "starting") return "checking";
  if (status?.running) return "connected";
  return status?.healthStatus === "error" || status?.autoStartState === "failed" ? "disconnected" : "disconnected";
}

function gatewayLabel(status?: HermesGatewayStatus) {
  if (status?.autoStartState === "starting") return "Gateway 启动中";
  if (status?.running) return "Gateway 已启动";
  if (status?.healthStatus === "error" || status?.autoStartState === "failed") return "Gateway 异常";
  return "Gateway 未启动";
}

function gatewayTooltip(status?: HermesGatewayStatus) {
  if (!status) return "正在检查 Gateway...";
  return status.autoStartMessage || status.message || "Gateway 状态未知";
}

function gatewayIcon(status?: HermesGatewayStatus) {
  if (status?.autoStartState === "starting") return Loader2;
  if (status?.running) return RadioTower;
  return ServerOff;
}

function gatewayColor(status?: HermesGatewayStatus) {
  if (status?.autoStartState === "starting") return "text-amber-600";
  if (status?.running) return "text-emerald-600";
  if (status?.healthStatus === "error" || status?.autoStartState === "failed") return "text-rose-600";
  return "text-slate-500";
}

function gatewayBgColor(status?: HermesGatewayStatus) {
  if (status?.autoStartState === "starting") return "bg-amber-50";
  if (status?.running) return "bg-emerald-50";
  if (status?.healthStatus === "error" || status?.autoStartState === "failed") return "bg-rose-50";
  return "bg-slate-50";
}

function updateBadgeStatus(event?: ClientUpdateEvent): "connected" | "disconnected" | "checking" {
  if (event?.status === "checking" || event?.status === "downloading") return "checking";
  if (event?.status === "error") return "disconnected";
  return "connected";
}

function updateLabel(event?: ClientUpdateEvent) {
  if (!event) return "更新";
  if (event.status === "available") return "发现新版本";
  if (event.status === "downloading") return `${Math.round(event.percent ?? 0)}%`;
  if (event.status === "downloaded") return "待重启更新";
  if (event.status === "checking") return "检查更新";
  if (event.status === "error") return "更新异常";
  return "已是新版";
}

function updateIcon(event?: ClientUpdateEvent) {
  if (event?.status === "checking" || event?.status === "downloading") return Loader2;
  if (event?.status === "error") return AlertCircle;
  return DownloadCloud;
}

function updateColor(event?: ClientUpdateEvent) {
  if (event?.status === "available" || event?.status === "downloaded") return "text-sky-600";
  if (event?.status === "checking" || event?.status === "downloading") return "text-amber-600";
  if (event?.status === "error") return "text-rose-600";
  return "text-slate-500";
}

function updateBgColor(event?: ClientUpdateEvent) {
  if (event?.status === "available" || event?.status === "downloaded") return "bg-sky-50";
  if (event?.status === "checking" || event?.status === "downloading") return "bg-amber-50";
  if (event?.status === "error") return "bg-rose-50";
  return "bg-slate-50";
}
