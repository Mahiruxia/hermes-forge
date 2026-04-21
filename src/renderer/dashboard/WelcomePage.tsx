import { useEffect, useRef, useState } from "react";
import { Sparkles, CheckCircle2, AlertCircle, Loader2, ArrowRight, Settings, HelpCircle } from "lucide-react";
import { useAppStore } from "../store";
import type { HermesInstallEvent } from "../../shared/types";

export function WelcomePage(props: { onComplete: () => void }) {
  const store = useAppStore();
  const [status, setStatus] = useState<"detecting" | "found" | "not-found" | "installing">("detecting");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("正在检测本地 Hermes...");
  const [detail, setDetail] = useState("");
  const autoInstallAttemptedRef = useRef(false);
  const installRunningRef = useRef(false);

  useEffect(() => {
    const unsubscribe = window.workbenchClient?.onInstallHermesEvent?.((event) => {
      applyInstallEvent(event);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    async function detectHermes() {
      setStatus("detecting");
      setProgress(20);

      try {
        if (!window.workbenchClient || typeof window.workbenchClient.getHermesProbe !== "function") {
          throw new Error("Hermes client not available");
        }

        const probe = await window.workbenchClient.getHermesProbe();
        setProgress(68);

        if (probe?.probe?.status === "healthy") {
          setStatus("found");
          setMessage("检测到本地 Hermes，正在载入工作台...");
          setDetail(probe.probe.secondaryMetric);
          setProgress(100);
          return;
        }

        setStatus("not-found");
        setMessage("未检测到可用 Hermes，正在准备自动安装...");
        setDetail(probe?.probe?.message ?? "将自动尝试部署 Hermes。");

        if (!autoInstallAttemptedRef.current) {
          autoInstallAttemptedRef.current = true;
          void handleAutoDeploy();
        }
      } catch (error) {
        console.error("Hermes detection failed:", error);
        setStatus("not-found");
        setMessage("检测失败，正在尝试自动安装 Hermes...");
        setDetail(error instanceof Error ? error.message : "未知错误");
        if (!autoInstallAttemptedRef.current) {
          autoInstallAttemptedRef.current = true;
          void handleAutoDeploy();
        }
      }
    }

    const timer = setTimeout(() => {
      void detectHermes();
    }, 400);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (status !== "found") return;
    const timer = window.setTimeout(() => {
      store.setFirstLaunch(false);
      props.onComplete();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [props, status, store]);

  function applyInstallEvent(event: HermesInstallEvent) {
    installRunningRef.current = event.stage !== "completed" && event.stage !== "failed";
    setStatus(event.stage === "completed" ? "found" : event.stage === "failed" ? "not-found" : "installing");
    setProgress(Math.max(0, Math.min(100, event.progress)));
    setMessage(event.message);
    setDetail(event.detail ?? "");
  }

  async function handleAutoDeploy() {
    if (installRunningRef.current) return;
    installRunningRef.current = true;
    setStatus("installing");
    setProgress((current) => Math.max(current, 12));
    setMessage("正在执行 Hermes 自动安装...");
    setDetail("首次进入会自动检测环境、下载 Hermes、安装依赖并完成健康检查。");

    try {
      const result = await window.workbenchClient.installHermes();
      installRunningRef.current = false;
      setMessage(result.message);
      setDetail(result.logPath ? `安装日志：${result.logPath}` : detail);
      setProgress(result.ok ? 100 : 0);

      if (!result.ok) {
        setStatus("not-found");
        return;
      }

      const probe = await window.workbenchClient.getHermesProbe();
      if (probe.probe.status !== "healthy") {
        setStatus("not-found");
        setMessage("Hermes 已安装，但客户端复检未通过");
        setDetail(probe.probe.message);
        return;
      }

      setStatus("found");
      setProgress(100);
      setDetail(probe.probe.secondaryMetric);
    } catch (error) {
      installRunningRef.current = false;
      setStatus("not-found");
      setProgress(0);
      setMessage("Hermes 自动安装失败，请改用手动配置或重试");
      setDetail(error instanceof Error ? error.message : "未知错误");
    }
  }

  function handleManualConfig() {
    store.setFirstLaunch(false);
    props.onComplete();
  }

  function handleSkip() {
    store.setFirstLaunch(false);
    props.onComplete();
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-rose-50">
      <div className="w-full max-w-md px-6">
        <div className="text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/25">
            <Sparkles size={32} className="text-white" />
          </div>

          <h1 className="text-2xl font-bold text-slate-900">欢迎使用 Hermes Forge</h1>
          <p className="mt-2 text-slate-500">本地优先的 Hermes Agent 桌面工坊</p>
        </div>

        <div className="mt-8 rounded-2xl bg-white p-6 shadow-lg shadow-slate-200/50">
          {status === "detecting" && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-50">
                <Loader2 size={28} className="animate-spin text-indigo-600" />
              </div>
              <p className="text-slate-600">{message}</p>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {status === "found" && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-50">
                <CheckCircle2 size={28} className="text-green-600" />
              </div>
              <h3 className="text-lg font-semibold text-slate-900">Hermes 已就绪</h3>
              <p className="mt-2 text-sm text-slate-500">客户端已经连上本机 Hermes，可以继续完成模型配置并开始使用。</p>
              {detail ? <p className="mt-2 break-all text-xs text-slate-400">{detail}</p> : null}
              <button
                className="mt-6 w-full rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-indigo-700 hover:shadow-md active:scale-[0.98]"
                onClick={() => {
                  store.setFirstLaunch(false);
                  props.onComplete();
                }}
              >
                <span className="flex items-center justify-center gap-2">
                  进入工作台 <ArrowRight size={16} />
                </span>
              </button>
            </div>
          )}

          {status === "not-found" && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-50">
                <AlertCircle size={28} className="text-amber-600" />
              </div>
              <h3 className="text-lg font-semibold text-slate-900">Hermes 还未就绪</h3>
              <p className="mt-2 text-sm text-slate-500">{message}</p>
              {detail ? <p className="mt-2 break-all text-xs leading-5 text-slate-400">{detail}</p> : null}

              <div className="mt-6 space-y-3">
                <button
                  className="w-full rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-indigo-700 hover:shadow-md active:scale-[0.98]"
                  onClick={() => void handleAutoDeploy()}
                >
                  <span className="flex items-center justify-center gap-2">
                    <Sparkles size={16} /> 重新自动安装 Hermes
                  </span>
                </button>

                <button
                  className="w-full rounded-xl border border-slate-200 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition-all hover:bg-slate-50"
                  onClick={handleManualConfig}
                >
                  <span className="flex items-center justify-center gap-2">
                    <Settings size={16} /> 手动配置路径
                  </span>
                </button>

                <button
                  className="w-full rounded-xl px-6 py-3 text-sm text-slate-500 transition-colors hover:text-slate-700"
                  onClick={handleSkip}
                >
                  <span className="flex items-center justify-center gap-2">
                    <HelpCircle size={16} /> 跳过，稍后配置
                  </span>
                </button>
              </div>
            </div>
          )}

          {status === "installing" && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-50">
                <Loader2 size={28} className="animate-spin text-indigo-600" />
              </div>
              <p className="text-slate-600">{message}</p>
              {detail ? <p className="mt-2 break-all text-xs leading-5 text-slate-400">{detail}</p> : null}
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-slate-400">{progress}%</p>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Hermes Forge v{store.clientInfo?.appVersion || "unknown"}
        </p>
      </div>
    </div>
  );
}
