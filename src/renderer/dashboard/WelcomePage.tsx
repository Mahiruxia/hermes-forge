import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Sparkles, CheckCircle2, AlertCircle, Loader2, ArrowRight, Settings, HelpCircle, Wrench, BookOpen, X, ExternalLink, Terminal, ChevronDown, ChevronUp, Globe, Bot, ScanLine } from "lucide-react";
import { useAppStore } from "../store";
import type { HermesInstallEvent, SetupCheck, SetupDependencyRepairId } from "../../shared/types";
import { InstallSourceDialog, type InstallSourceChoice } from "./components/InstallSourceDialog";

const OFFICIAL_HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent";
const OFFICIAL_HERMES_DOCS_URL = "https://hermes-agent.nousresearch.com/";
export type WelcomeCompleteTarget = "workbench" | "model" | "hermes";

export function WelcomePage(props: { onComplete: (target?: WelcomeCompleteTarget) => void }) {
  const store = useAppStore();
  const [status, setStatus] = useState<"detecting" | "found" | "not-found" | "installing">("detecting");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("正在检测本地 Hermes...");
  const [detail, setDetail] = useState("");
  const [setupChecks, setSetupChecks] = useState<SetupCheck[]>([]);
  const [repairingDependency, setRepairingDependency] = useState<SetupDependencyRepairId | undefined>();
  const [installStartTime, setInstallStartTime] = useState<number | null>(null);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [macRuntime, setMacRuntime] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [showMirrorRetry, setShowMirrorRetry] = useState(false);
  const [nextTarget, setNextTarget] = useState<WelcomeCompleteTarget>("workbench");
  const installRunningRef = useRef(false);
  const lastInstallSourceKindRef = useRef<InstallSourceChoice | undefined>(undefined);
  const logsEndRef = useRef<HTMLDivElement>(null);

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
        setMessage("未检测到可用 Hermes，请选择安装来源。");
        setDetail(probe?.probe?.message ?? "你可以优先使用官方 GitHub；如果 GitHub/uv/Python 下载较慢，可主动选择国内社区镜像。");
      } catch (error) {
        console.error("Hermes detection failed:", error);
        setStatus("not-found");
        const manualMac = await shouldUseManualMacSetup();
        setMessage(manualMac ? "检测失败，请手动选择 macOS Hermes 安装位置。" : "检测失败，请选择 Hermes 安装来源。");
        setDetail(error instanceof Error ? error.message : "未知错误");
      }
    }

    void detectHermes();
  }, []);

  async function completeWelcome(target?: WelcomeCompleteTarget) {
    const nextTarget = target ?? await nextWelcomeTarget();
    store.setFirstLaunch(false);
    props.onComplete(nextTarget);
  }

  async function nextWelcomeTarget(): Promise<WelcomeCompleteTarget> {
    try {
      const summary = await window.workbenchClient.getSetupSummary();
      const primaryIds = new Set(["git", "python", "winget", "hermes", "model", "model-placeholder", "model-secret", "weixin-aiohttp"]);
      setSetupChecks(summary.checks.filter((check) => primaryIds.has(check.id)).slice(0, 8));
      const modelBlocked = summary.blocking.some((check) =>
        check.id === "model" || check.id === "model-secret" || check.fixAction === "configure_model"
      );
      const target = modelBlocked ? "model" : "workbench";
      setNextTarget(target);
      return target;
    } catch {
      return "workbench";
    }
  }

  function applyInstallEvent(event: HermesInstallEvent) {
    const isRunning = event.stage !== "completed" && event.stage !== "failed" && event.stage !== "cancelled";
    installRunningRef.current = isRunning;
    setStatus(event.stage === "completed" ? "found" : event.stage === "failed" || event.stage === "cancelled" ? "not-found" : "installing");
    setProgress((current) => Math.max(current, Math.min(100, event.progress)));
    setMessage(event.message);
    setDetail(event.detail ?? "");
    if (event.logLine) {
      setInstallLogs((prev) => {
        const next = [...prev, event.logLine!];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    }
    if (isRunning && !installStartTime) {
      setInstallStartTime(Date.now());
    }
    if (event.stage === "completed" || event.stage === "failed" || event.stage === "cancelled") {
      setInstallStartTime(null);
      setShowMirrorRetry(event.stage === "failed" && lastInstallSourceKindRef.current === "official");
      void refreshSetupChecks();
    }
  }

  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [installLogs, showLogs]);

  async function refreshSetupChecks() {
    try {
      const summary = await window.workbenchClient.getSetupSummary();
      const primaryIds = new Set(["git", "python", "winget", "hermes", "model", "model-placeholder", "model-secret", "weixin-aiohttp"]);
      setSetupChecks(summary.checks.filter((check) => primaryIds.has(check.id)).slice(0, 8));
      setNextTarget(summary.blocking.some((check) => check.id === "model" || check.id === "model-secret" || check.fixAction === "configure_model") ? "model" : "workbench");
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
      setDetail(result.recommendedFix ?? "");
      await refreshSetupChecks();
    } catch (error) {
      setMessage("依赖修复失败");
      setDetail(error instanceof Error ? error.message : "未知错误");
      await refreshSetupChecks();
    } finally {
      setRepairingDependency(undefined);
    }
  }

  function openInstallSourceDialog() {
    if (installRunningRef.current) return;
    setSourceDialogOpen(true);
  }

  async function handleAutoDeploy() {
    if (await shouldUseManualMacSetup()) {
      setStatus("not-found");
      setProgress(68);
      setMessage("macOS 暂不支持一键自动安装");
      setDetail("请先安装 Hermes Agent，然后点击“手动配置路径”选择 Hermes 根目录。");
      return;
    }
    openInstallSourceDialog();
  }

  async function installWithSource(kind: InstallSourceChoice) {
    if (installRunningRef.current) return;
    setSourceDialogOpen(false);
    lastInstallSourceKindRef.current = kind;
    setShowMirrorRetry(false);
    installRunningRef.current = true;
    setInstallStartTime(Date.now());
    setStatus("installing");
    setProgress((current) => Math.max(current, 12));
    setMessage("正在执行 Hermes 自动安装...");
    setDetail(kind === "mirror"
      ? "正在使用国内社区镜像下载安装脚本；安装过程仍会校验 Hermes 是否可启动。"
      : "正在使用官方 GitHub 安装脚本；如果失败，可手动改用国内社区镜像重试。");
    setInstallLogs([]);
    setShowLogs(false);
    void refreshSetupChecks();

    try {
      const result = await window.workbenchClient.installHermes({ source: { kind } });
      installRunningRef.current = false;
      setMessage(result.message);
      setDetail(result.ok ? result.rootPath ?? "" : kind === "official" ? "官方源安装失败，可改用国内社区镜像重试。" : "镜像安装失败，请检查网络/镜像可达性，或切回官方源重试。");
      setProgress(result.ok ? 100 : 0);
      void refreshSetupChecks();

      if (!result.ok) {
        setStatus("not-found");
        setShowMirrorRetry(kind === "official");
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
      setDetail(kind === "official"
        ? `${error instanceof Error ? error.message : "未知错误"}。可改用国内社区镜像重试。`
        : `${error instanceof Error ? error.message : "未知错误"}。请检查网络/镜像可达性，或切回官方源重试。`);
      setShowMirrorRetry(kind === "official");
      void refreshSetupChecks();
    }
  }

  async function handleCancelInstall() {
    const result = await window.workbenchClient.cancelInstallHermes();
    installRunningRef.current = false;
    setInstallStartTime(null);
    setStatus("not-found");
    setProgress(0);
    setMessage(result.ok ? "正在取消安装" : "取消安装");
    setDetail(result.ok ? result.message : "当前没有可取消的安装进程。你可以重新自动安装，或查看官方文档手动配置路径。");
    setInstallLogs((prev) => [...prev, `[cancelled] ${result.message}`]);
    setShowMirrorRetry(false);
  }

  function handleManualConfig() {
    void completeWelcome("hermes");
  }

  function handleSkip() {
    void completeWelcome("workbench");
  }

  async function shouldUseManualMacSetup() {
    const config = await window.workbenchClient.getRuntimeConfig().catch(() => undefined);
    const isMac = config?.hermesRuntime?.mode === "darwin";
    setMacRuntime(Boolean(isMac));
    return Boolean(isMac);
  }

  return (
    <main id="main-content" tabIndex={-1} className="hermes-welcome-page min-h-screen overflow-y-auto bg-[#f4f5f7] text-slate-900">
      <a className="hermes-skip-link" href="#main-content">跳到主要内容</a>
      <InstallSourceDialog
        busy={installRunningRef.current}
        onClose={() => setSourceDialogOpen(false)}
        onSelect={(kind) => void installWithSource(kind)}
        open={sourceDialogOpen}
      />
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 pb-8 pt-6 sm:px-8 sm:pt-8">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-slate-950 text-white shadow-[0_12px_30px_rgba(15,23,42,0.16)]">
              <Sparkles size={19} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold tracking-[-0.01em] text-slate-950">Hermes Forge</p>
              <p className="text-xs text-slate-500">本地 Agent 工作台</p>
            </div>
          </div>
          <span className="rounded-lg bg-white px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-slate-400 ring-1 ring-slate-200/70">
            v{store.clientInfo?.appVersion || "unknown"}
          </span>
        </header>

        <div className="mt-10 max-w-2xl">
          <p className="text-xs font-semibold tracking-[0.12em] text-slate-500">首次设置</p>
          <h1 className="mt-3 text-balance text-[clamp(2rem,4vw,3.4rem)] font-semibold leading-[1.06] tracking-[-0.045em] text-slate-950">
            让 Hermes 在这台电脑上就绪
          </h1>
          <p className="mt-4 max-w-[62ch] text-pretty text-[15px] leading-7 text-slate-500">
            Forge 会先检查本机环境，再由你确认安装来源。整个过程不会静默安装，也不会在完成后突然跳转。
          </p>
        </div>

        <OnboardingSteps status={status} nextTarget={nextTarget} />

        <div className="mt-6 grid min-h-0 flex-1 items-start gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
          <section className="rounded-[26px] bg-white p-6 shadow-[0_24px_80px_rgba(30,41,59,0.08)] ring-1 ring-slate-200/65 sm:p-8" aria-live="polite">
          {status === "detecting" && (
            <div className="flex min-h-[320px] flex-col justify-center">
              <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-[18px] bg-slate-100 text-slate-700">
                <ScanLine size={25} className="animate-pulse" />
              </div>
              <p className="text-xs font-semibold tracking-[0.12em] text-slate-400">步骤 1 / 3</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-slate-950">正在检查这台电脑</h2>
              <p className="mt-3 max-w-[56ch] text-sm leading-6 text-slate-500">{message}</p>
              <div className="mt-8 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-slate-800 transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-3 text-xs text-slate-400">只读取版本、路径和可用性，不会修改系统配置。</p>
            </div>
          )}

          {status === "found" && (
            <div className="flex min-h-[320px] flex-col justify-center">
              <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-[18px] bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
                <CheckCircle2 size={25} />
              </div>
              <p className="text-xs font-semibold tracking-[0.12em] text-emerald-700">环境连接成功</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-slate-950">Hermes 已就绪</h2>
              <p className="mt-3 max-w-[58ch] text-sm leading-6 text-slate-500">
                {nextTarget === "model"
                  ? "本机 Hermes 已连接。下一步补齐模型来源和 API Key，完成后就能发送第一项任务。"
                  : "Hermes 和默认模型都已可用，可以进入工作台开始第一项任务。"}
              </p>
              {detail ? <p className="mt-3 break-all rounded-xl bg-slate-50 px-3 py-2 font-mono text-xs text-slate-500 ring-1 ring-slate-100">{detail}</p> : null}
              <button
                className="mt-8 inline-flex w-fit items-center justify-center gap-2 rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(15,23,42,0.18)] transition hover:-translate-y-0.5 hover:bg-slate-800 active:translate-y-0"
                onClick={() => {
                  void completeWelcome();
                }}
              >
                {nextTarget === "model" ? "继续配置模型" : "进入工作台"} <ArrowRight size={16} />
              </button>
              <p className="mt-3 text-xs text-slate-400">由你确认后再继续，不会自动跳页。</p>
            </div>
          )}

          {status === "not-found" && (
            <div>
              <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-[18px] bg-amber-50 text-amber-700 ring-1 ring-amber-100">
                <AlertCircle size={25} />
              </div>
              <p className="text-xs font-semibold tracking-[0.12em] text-amber-700">需要你确认</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-slate-950">Hermes 还未就绪</h2>
              <p className="mt-3 max-w-[58ch] text-sm leading-6 text-slate-500">{message}</p>
              {detail ? <p className="mt-3 break-all rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500 ring-1 ring-slate-100">{detail}</p> : null}

              <div className="mt-7 space-y-3">
                {!macRuntime ? (
                  <button
                    className="flex w-full items-center justify-between rounded-xl bg-slate-950 px-4 py-3.5 text-left text-sm font-semibold text-white shadow-[0_12px_28px_rgba(15,23,42,0.18)] transition hover:-translate-y-0.5 hover:bg-slate-800 active:translate-y-0"
                    onClick={() => void handleAutoDeploy()}
                  >
                    <span className="flex items-center gap-2"><Sparkles size={16} /> 选择安装方式</span>
                    <ArrowRight size={16} />
                  </button>
                ) : null}
                {showMirrorRetry && !macRuntime ? (
                  <button
                    className="w-full rounded-xl border border-amber-200 bg-amber-50 px-6 py-3 text-sm font-semibold text-amber-800 transition-all hover:bg-amber-100"
                    onClick={() => void installWithSource("mirror")}
                    type="button"
                  >
                    <span className="flex items-center justify-center gap-2">
                      <Globe size={16} /> 改用国内社区镜像重试
                    </span>
                  </button>
                ) : null}

                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
                    onClick={handleManualConfig}
                  >
                    <Settings size={16} /> 手动配置路径
                  </button>
                  <a
                    href={macRuntime ? OFFICIAL_HERMES_DOCS_URL : OFFICIAL_HERMES_REPO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
                  >
                    <BookOpen size={16} /> {macRuntime ? "官方文档" : "官方 GitHub"}
                  </a>
                </div>

                <button
                  className="w-full rounded-lg px-4 py-2 text-sm text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
                  onClick={handleSkip}
                >
                  <span className="flex items-center justify-center gap-2">
                    <HelpCircle size={15} /> 暂时跳过，稍后在设置中心继续
                  </span>
                </button>
              </div>

              <ManualInstallGuide />
            </div>
          )}

          {status === "installing" && (
            <div className="flex min-h-[320px] flex-col justify-center">
              <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-[18px] bg-slate-100 text-slate-700">
                <Loader2 size={25} className="animate-spin" />
              </div>
              <p className="text-xs font-semibold tracking-[0.12em] text-slate-400">步骤 2 / 3</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-slate-950">{message}</h2>
              {detail ? <p className="mt-3 max-w-[58ch] break-words text-sm leading-6 text-slate-500">{detail}</p> : null}
              <div className="mt-7 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-slate-800 transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-2 flex items-center gap-2 font-mono text-xs tabular-nums text-slate-400">
                <span>{progress}%</span>
                <span>·</span>
                <span>{installStageLabel(progress)}</span>
              </div>
              {installLogs.length > 0 && (
                <div className="mt-3 text-left">
                  <button
                    onClick={() => setShowLogs((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500 transition hover:text-slate-700"
                    type="button"
                  >
                    <Terminal size={12} />
                    {showLogs ? "收起实时日志" : `查看实时日志 (${installLogs.length} 行)`}
                    {showLogs ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  {showLogs && (
                    <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-900 px-3 py-2">
                      <pre className="text-[10px] leading-4 text-slate-300">
                        <code>
                          {installLogs.join("\n")}
                          <div ref={logsEndRef} />
                        </code>
                      </pre>
                    </div>
                  )}
                </div>
              )}
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
                  onClick={() => void handleCancelInstall()}
                  type="button"
                >
                  <X size={14} /> 取消安装
                </button>
                <a
                  href={OFFICIAL_HERMES_DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 hover:underline"
                >
                  <ExternalLink size={12} /> 查看 Nous 官方文档
                </a>
              </div>
            </div>
          )}
          </section>

          <aside className="space-y-4">
            {setupChecks.length ? (
            <DependencyChecklist
              checks={setupChecks}
              repairingDependency={repairingDependency}
              onRepair={handleRepairDependency}
            />
            ) : (
              <div className="rounded-[22px] bg-white p-5 ring-1 ring-slate-200/65">
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-500"><ScanLine size={17} /></span>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">环境检查</p>
                    <p className="mt-0.5 text-xs text-slate-500">检测完成后会列出可修复项。</p>
                  </div>
                </div>
                <div className="mt-5 space-y-2" aria-hidden="true">
                  {[76, 92, 64].map((width) => <div key={width} className="h-10 animate-pulse rounded-xl bg-slate-100" style={{ width: `${width}%` }} />)}
                </div>
              </div>
            )}
            <div className="rounded-[22px] bg-slate-900 p-5 text-slate-100 shadow-[0_20px_60px_rgba(15,23,42,0.16)]">
              <Bot size={18} className="text-slate-300" />
              <p className="mt-4 text-sm font-semibold">本地优先</p>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                工作区内容和密钥默认留在本机。安装来源由你选择，执行进度和日志可随时查看。
              </p>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function OnboardingSteps(props: { status: "detecting" | "found" | "not-found" | "installing"; nextTarget: WelcomeCompleteTarget }) {
  const steps = [
    { label: "检查环境", state: props.status === "detecting" ? "active" : "done" },
    { label: "安装 Hermes", state: props.status === "detecting" ? "upcoming" : props.status === "found" ? "done" : "active" },
    { label: "配置模型", state: props.status === "found" ? (props.nextTarget === "model" ? "active" : "done") : "upcoming" },
  ] as const;
  return (
    <ol className="mt-8 grid gap-2 sm:grid-cols-3" aria-label="首次设置进度">
      {steps.map((step, index) => (
        <li key={step.label} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${step.state === "active" ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-500"}`}>
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg font-mono text-[11px] font-semibold tabular-nums ${step.state === "done" ? "bg-emerald-100 text-emerald-700" : step.state === "active" ? "bg-slate-900 text-white" : "bg-slate-200/70 text-slate-400"}`}>
            {step.state === "done" ? <CheckCircle2 size={14} /> : index + 1}
          </span>
          <span className="text-xs font-semibold">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function DependencyChecklist(props: {
  checks: SetupCheck[];
  repairingDependency?: SetupDependencyRepairId;
  onRepair: (id: SetupDependencyRepairId) => void | Promise<void>;
}) {
  return (
    <div className="rounded-[22px] bg-white p-5 text-left shadow-[0_18px_55px_rgba(30,41,59,0.06)] ring-1 ring-slate-200/65">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.12em] text-slate-400">环境检查</p>
          <p className="mt-1 text-sm font-semibold text-slate-800">{props.checks.some((check) => check.status !== "ok") ? "还有项目需要处理" : "关键依赖已通过"}</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500">
          {props.checks.filter((check) => check.status === "ok").length}/{props.checks.length}
        </span>
      </div>
      <div className="space-y-2">
        {props.checks.map((check) => (
          <div key={check.id} className="rounded-xl bg-slate-50 px-3 py-3 ring-1 ring-slate-100">
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
  if (id === "hermes_python_dotenv") return "修 Hermes";
  if (id === "feishu_lark_oapi") return "修飞书";
  if (id === "telegram_bot") return "修 Telegram";
  if (id === "discord_py") return "修 Discord";
  if (id === "slack_bolt") return "修 Slack";
  return "修微信";
}

function installStageLabel(progress: number) {
  if (progress <= 12) return "环境预检";
  if (progress <= 32) return "下载安装脚本";
  if (progress <= 62) return "执行安装脚本";
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
            <p className="text-xs text-slate-600">Windows Native 是 Hermes Forge 的默认路径。推荐优先使用本页的一键安装；手动安装时请优先参考 Nous 官方文档。国内社区镜像仅作为网络受限时的替代来源。</p>
            <CodeBlock>{`irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex`}</CodeBlock>
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
            官方文档请参考
            <a
              href={OFFICIAL_HERMES_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 font-semibold underline hover:text-indigo-800"
            >
              Nous Hermes Agent
            </a>
            <span className="ml-1">；GitHub 访问慢时可在设置中心手动选择中文社区镜像。</span>
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
