import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Sparkles, CheckCircle2, AlertCircle, Loader2, ArrowRight, Settings, HelpCircle, Wrench, BookOpen, X, ExternalLink } from "lucide-react";
import { useAppStore } from "../store";
import type { HermesInstallEvent, SetupCheck, SetupDependencyRepairId } from "../../shared/types";

export function WelcomePage(props: { onComplete: () => void }) {
  const store = useAppStore();
  const [status, setStatus] = useState<"detecting" | "found" | "not-found" | "installing">("detecting");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("正在检测本地 Hermes...");
  const [detail, setDetail] = useState("");
  const [setupChecks, setSetupChecks] = useState<SetupCheck[]>([]);
  const [repairingDependency, setRepairingDependency] = useState<SetupDependencyRepairId | undefined>();
  const [installStartTime, setInstallStartTime] = useState<number | null>(null);
  const [macRuntime, setMacRuntime] = useState(false);
  const autoInstallAttemptedRef = useRef(false);
  const installRunningRef = useRef(false);

  useEffect(() => {
    const unsubscribe = window.workbenchClient?.onInstallHermesEvent?.((event) => {
      applyInstallEvent(event);
    });
    return () => unsubscribe?.();
  }, []);

  async function runPreflightThenDeploy() {
    if (await shouldUseManualMacSetup()) {
      setStatus("not-found");
      setProgress(68);
      setMessage("未检测到可用 Hermes，请选择 macOS Hermes Agent 安装位置。");
      setDetail("macOS 暂不使用 Windows 自动安装脚本。请先安装 Hermes Agent，然后在设置中选择 Hermes 根目录。");
      return;
    }
    void handleAutoDeploy();
  }

  useEffect(() => {
    async function detectHermes() {
      setStatus("detecting");
      setProgress(20);
      void refreshSetupChecks();

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
        setMessage("未检测到可用 Hermes，正在准备下一步...");
        setDetail(probe?.probe?.message ?? "将根据当前运行环境选择安装方式。");

        if (!autoInstallAttemptedRef.current) {
          autoInstallAttemptedRef.current = true;
          await runPreflightThenDeploy();
        }
      } catch (error) {
        console.error("Hermes detection failed:", error);
        setStatus("not-found");
        const manualMac = await shouldUseManualMacSetup();
        setMessage(manualMac ? "检测失败，请手动选择 macOS Hermes 安装位置。" : "检测失败，正在尝试自动安装 Hermes...");
        setDetail(error instanceof Error ? error.message : "未知错误");
        if (!manualMac && !autoInstallAttemptedRef.current) {
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
    const isRunning = event.stage !== "completed" && event.stage !== "failed";
    installRunningRef.current = isRunning;
    setStatus(event.stage === "completed" ? "found" : event.stage === "failed" ? "not-found" : "installing");
    setProgress(Math.max(0, Math.min(100, event.progress)));
    setMessage(event.message);
    setDetail(event.detail ?? "");
    if (isRunning && !installStartTime) {
      setInstallStartTime(Date.now());
    }
    if (event.stage === "completed" || event.stage === "failed") {
      setInstallStartTime(null);
      void refreshSetupChecks();
    }
  }

  async function refreshSetupChecks() {
    try {
      const summary = await window.workbenchClient.getSetupSummary();
      const primaryIds = new Set(["git", "python", "winget", "hermes", "model", "model-placeholder", "model-secret", "weixin-aiohttp"]);
      setSetupChecks(summary.checks.filter((check) => primaryIds.has(check.id)).slice(0, 8));
    } catch (error) {
      console.warn("Failed to load setup summary:", error);
    }
  }

  async function handleRepairDependency(id: SetupDependencyRepairId) {
    if (repairingDependency || installRunningRef.current) return;
    setRepairingDependency(id);
    try {
      const result = await window.workbenchClient.repairSetupDependency(id);
      setMessage(result.message);
      setDetail(result.recommendedFix ?? result.logPath ?? "");
      await refreshSetupChecks();
    } catch (error) {
      setMessage("依赖修复失败");
      setDetail(error instanceof Error ? error.message : "未知错误");
    } finally {
      setRepairingDependency(undefined);
    }
  }

  async function handleAutoDeploy() {
    if (await shouldUseManualMacSetup()) {
      setStatus("not-found");
      setProgress(68);
      setMessage("macOS 暂不支持一键自动安装");
      setDetail("请先安装 Hermes Agent，然后点击“手动配置路径”选择 Hermes 根目录。");
      return;
    }
    if (installRunningRef.current) return;
    installRunningRef.current = true;
    setInstallStartTime(Date.now());
    setStatus("installing");
    setProgress((current) => Math.max(current, 12));
    setMessage("正在执行 Hermes 自动安装...");
    setDetail("首次进入会自动检测环境、下载 Hermes、安装依赖并完成健康检查。");
    void refreshSetupChecks();

    try {
      const result = await window.workbenchClient.installHermes();
      installRunningRef.current = false;
      setMessage(result.message);
      setDetail(result.logPath ? `安装日志：${result.logPath}` : detail);
      setProgress(result.ok ? 100 : 0);
      void refreshSetupChecks();

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

  function handleCancelInstall() {
    installRunningRef.current = false;
    setInstallStartTime(null);
    setStatus("not-found");
    setProgress(0);
    setMessage("安装已取消");
    setDetail("你可以点击「重新自动安装」重试，或点击下方链接前往官网手动下载安装包。");
  }

  function handleManualConfig() {
    store.setFirstLaunch(false);
    props.onComplete();
  }

  function handleSkip() {
    store.setFirstLaunch(false);
    props.onComplete();
  }

  async function shouldUseManualMacSetup() {
    const config = await window.workbenchClient.getRuntimeConfig().catch(() => undefined);
    const isMac = config?.hermesRuntime?.mode === "darwin";
    setMacRuntime(Boolean(isMac));
    return Boolean(isMac);
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
                {!macRuntime ? (
                  <button
                    className="w-full rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-indigo-700 hover:shadow-md active:scale-[0.98]"
                    onClick={() => void handleAutoDeploy()}
                  >
                    <span className="flex items-center justify-center gap-2">
                      <Sparkles size={16} /> 重新自动安装 Hermes
                    </span>
                  </button>
                ) : null}

                <a
                  href={macRuntime ? "https://hermesagent.org.cn/" : "https://hermesagent.org.cn/docs/getting-started/windows-installation"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition-all hover:bg-slate-50"
                >
                  <BookOpen size={16} /> {macRuntime ? "查看 Hermes 官网" : "查看手动安装教程"}
                </a>

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

              <ManualInstallGuide />
            </div>
          )}

          {status === "installing" && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-50">
                <Loader2 size={28} className="animate-spin text-indigo-600" />
              </div>
              <p className="text-slate-600">{message}</p>
              {detail ? <p className="mt-2 break-words text-xs leading-5 text-slate-400">{detail}</p> : null}
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-center gap-2 text-xs text-slate-400">
                <span>{progress}%</span>
                <span>·</span>
                <span>{installStageLabel(progress)}</span>
              </div>
              {progress === 55 && installStartTime && Date.now() - installStartTime > 60_000 ? (
                <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-left">
                  <p className="text-[11px] font-medium text-amber-800">为什么卡在 55%？</p>
                  <p className="mt-1 text-[11px] leading-4 text-amber-700">
                    此阶段是 Hermes 官方 PowerShell 安装脚本在后台下载依赖包。如果网络较慢或企业防火墙限制了 PowerShell 脚本执行，可能会长时间停留在此处。你可以继续等待，也可以取消后前往官网手动下载安装包。
                  </p>
                </div>
              ) : null}
              <div className="mt-4 flex flex-col gap-2">
                <button
                  className="mx-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50"
                  onClick={handleCancelInstall}
                  type="button"
                >
                  <X size={14} /> 取消安装
                </button>
                <a
                  href="https://hermesagent.org.cn/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 hover:underline"
                >
                  <ExternalLink size={12} /> 前往 Hermes 官网下载安装包
                </a>
              </div>
            </div>
          )}

          {setupChecks.length ? (
            <DependencyChecklist
              checks={setupChecks}
              repairingDependency={repairingDependency}
              onRepair={handleRepairDependency}
            />
          ) : null}
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Hermes Forge v{store.clientInfo?.appVersion || "unknown"}
        </p>
      </div>
    </div>
  );
}

function DependencyChecklist(props: {
  checks: SetupCheck[];
  repairingDependency?: SetupDependencyRepairId;
  onRepair: (id: SetupDependencyRepairId) => void | Promise<void>;
}) {
  return (
    <div className="mt-6 border-t border-slate-100 pt-4 text-left">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Preflight</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">首次运行体检</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500">
          {props.checks.filter((check) => check.status === "ok").length}/{props.checks.length}
        </span>
      </div>
      <div className="space-y-2">
        {props.checks.map((check) => (
          <div key={check.id} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${welcomeSetupDotClass(check.status)}`} />
                  <p className="text-xs font-semibold text-slate-800">{check.label}</p>
                </div>
                <p className="mt-1 break-words text-[11px] leading-4 text-slate-500 [overflow-wrap:anywhere]">{check.message}</p>
              </div>
              {check.autoFixId ? (
                <button
                  type="button"
                  onClick={() => void props.onRepair(check.autoFixId!)}
                  disabled={props.repairingDependency === check.autoFixId}
                  className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-indigo-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="inline-flex items-center gap-1">
                    <Wrench size={12} />
                    {props.repairingDependency === check.autoFixId ? "修复中" : welcomeSetupFixLabel(check.autoFixId)}
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function welcomeSetupDotClass(status: SetupCheck["status"]) {
  if (status === "ok") return "bg-emerald-500";
  if (status === "warning") return "bg-amber-500";
  if (status === "running") return "bg-slate-400";
  return "bg-rose-500";
}

function welcomeSetupFixLabel(id: SetupDependencyRepairId) {
  if (id === "git") return "装 Git";
  if (id === "python") return "装 Python";
  if (id === "hermes_pyyaml") return "修 Hermes";
  return "修微信";
}

function installStageLabel(progress: number) {
  if (progress <= 12) return "环境预检";
  if (progress <= 32) return "下载安装脚本";
  if (progress <= 62) return "执行官方安装脚本";
  if (progress <= 82) return "健康检查";
  return "完成";
}

function ManualInstallGuide(props: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-slate-700"
      >
        <span className="flex items-center gap-2">
          <BookOpen size={16} />
          手动安装向导（推荐自动安装失败时使用）
        </span>
        <span className="text-xs text-slate-400">{open ? "收起" : "展开"}</span>
      </button>
      {open ? (
        <div className="space-y-4 px-4 pb-4">
          <Step number={1} title="在 PowerShell 中安装 Hermes Agent">
            <p className="text-xs text-slate-600">Windows Native 是 Hermes Forge 的默认路径。推荐优先使用本页的一键安装；手动安装时请使用 Hermes 官方 Windows 脚本。</p>
            <CodeBlock>{`irm https://res1.hermesagent.org.cn/install.ps1 | iex`}</CodeBlock>
          </Step>

          <Step number={2} title="确认 hermes 命令可用">
            <p className="text-xs text-slate-600">重新打开 PowerShell 后运行：</p>
            <CodeBlock>{`hermes --version
hermes capabilities --json`}</CodeBlock>
          </Step>

          <Step number={3} title="继续配置模型">
            <CodeBlock>{`hermes model
hermes setup`}</CodeBlock>
            <p className="text-xs text-slate-600">按提示选择模型提供商、填写 API Key 并保存为默认模型。</p>
          </Step>

          <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
            更详细的图文教程请参考
            <a
              href="https://hermesagent.org.cn/docs/getting-started/windows-installation"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 font-semibold underline hover:text-indigo-800"
            >
              Windows 安装指南
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Step(props: { number: number; title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-indigo-600 text-[10px] font-bold text-white">
          {props.number}
        </span>
        <p className="text-xs font-semibold text-slate-800">{props.title}</p>
      </div>
      <div className="pl-7">{props.children}</div>
    </div>
  );
}

function CodeBlock(props: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[11px] leading-5 text-slate-100">
      <code>{props.children}</code>
    </pre>
  );
}
