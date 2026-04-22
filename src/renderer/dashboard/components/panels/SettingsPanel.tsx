import { useEffect, useState } from "react";
import { CheckCircle2, Folder, MinusCircle, Network, RefreshCw, RotateCcw, Settings, FileCode, Save, Server, Sparkles, XCircle } from "lucide-react";
import { useAppStore } from "../../../store";
import type { BridgeTestStep, HermesInstallEvent, HermesRuntimeConfig, HermesWindowsBridgeTestResult, WindowsAgentMode, WindowsBridgeStatus } from "../../../../shared/types";

export function SettingsPanel(props: {
  onRefresh: () => Promise<unknown>;
  onOpenSettings: () => void;
  onClearSession: () => void;
  onOpenSessionFolder: () => void;
  onExportDiagnostics: () => void;
}) {
  const store = useAppStore();
  const [restarting, setRestarting] = useState(false);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [runtime, setRuntime] = useState<HermesRuntimeConfig>({ mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" });
  const [rootPath, setRootPath] = useState("");
  const [bridge, setBridge] = useState<WindowsBridgeStatus | undefined>();
  const [testingBridge, setTestingBridge] = useState(false);
  const [bridgeTest, setBridgeTest] = useState<HermesWindowsBridgeTestResult | undefined>();
  const [installingHermes, setInstallingHermes] = useState(false);
  const [installEvent, setInstallEvent] = useState<HermesInstallEvent | undefined>();
  const clientInfo = store.clientInfo;

  useEffect(() => {
    let alive = true;
    void window.workbenchClient.getConfigOverview().then((overview) => {
      if (!alive) return;
      setRuntime(overview?.hermes?.runtime ?? { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" });
      setRootPath(overview?.hermes?.rootPath ?? "");
      setBridge(overview?.hermes?.bridge);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!window.workbenchClient || typeof window.workbenchClient.onInstallHermesEvent !== "function") return;
    return window.workbenchClient.onInstallHermesEvent((event) => {
      setInstallEvent(event);
      setInstallingHermes(event.stage !== "completed" && event.stage !== "failed");
    });
  }, []);

  async function handleRestart() {
    setRestarting(true);
    try {
      await window.workbenchClient.restart();
    } finally {
      setRestarting(false);
    }
  }

  async function saveRuntime() {
    setSavingRuntime(true);
    try {
      const next = await window.workbenchClient.updateHermesConfig({
        rootPath,
        runtime,
      });
      store.setRuntimeConfig(next);
      const overview = await window.workbenchClient.getConfigOverview();
      setRuntime(overview?.hermes?.runtime ?? next.hermesRuntime ?? { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" });
      setRootPath(overview?.hermes?.rootPath ?? rootPath);
      setBridge(overview?.hermes?.bridge);
      await props.onRefresh();
    } finally {
      setSavingRuntime(false);
    }
  }

  async function testBridge() {
    setTestingBridge(true);
    try {
      const result = await window.workbenchClient.testHermesWindowsBridge();
      setBridgeTest(result);
      const overview = await window.workbenchClient.getConfigOverview();
      setBridge(overview?.hermes?.bridge);
    } finally {
      setTestingBridge(false);
    }
  }

  async function chooseHermesRoot() {
    const selected = await window.workbenchClient.pickHermesInstallFolder();
    if (selected) setRootPath(selected);
  }

  async function openHermesRoot() {
    if (!rootPath.trim()) {
      store.warning("请先填写 Hermes 根路径");
      return;
    }
    const result = await window.workbenchClient.openPath(rootPath.trim());
    if (result.ok) store.success("已打开 Hermes 路径", result.message);
    else store.error("打开 Hermes 路径失败", result.message);
  }

  async function installHermes() {
    if (installingHermes) return;
    setInstallingHermes(true);
    setInstallEvent(undefined);
    try {
      const result = await window.workbenchClient.installHermes(rootPath.trim() ? { rootPath: rootPath.trim() } : undefined);
      if (result.rootPath) setRootPath(result.rootPath);
      const overview = await window.workbenchClient.getConfigOverview();
      setRootPath(overview?.hermes?.rootPath ?? result.rootPath ?? rootPath);
      setBridge(overview?.hermes?.bridge);
      await props.onRefresh();
      if (result.ok) store.success("Hermes 安装完成", result.message);
      else store.error("Hermes 安装失败", result.message);
    } finally {
      setInstallingHermes(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-indigo-100 to-indigo-200">
            <Settings size={22} className="text-indigo-600" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-900">Hermes Forge</h3>
            <p className="text-sm text-slate-500">为社区共创打造的 Hermes Agent 本地工坊</p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Server size={16} className="text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-900">Hermes 运行环境</h3>
        </div>
        <div className="grid gap-4">
          <label className="grid gap-1 text-sm">
            <span className="text-slate-500">运行位置</span>
            <select
              className="rounded-lg border border-slate-200 px-3 py-2 text-slate-800"
              value={runtime.mode}
              onChange={(event) => setRuntime({ ...runtime, mode: event.target.value === "wsl" ? "wsl" : "windows" })}
            >
              <option value="windows">Windows</option>
              <option value="wsl">WSL</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-slate-500">Windows Agent 模式</span>
            <select
              className="rounded-lg border border-slate-200 px-3 py-2 text-slate-800"
              value={runtime.windowsAgentMode ?? "hermes_native"}
              onChange={(event) => setRuntime({ ...runtime, windowsAgentMode: event.target.value as WindowsAgentMode })}
            >
              <option value="hermes_native">Hermes 原生工具优先</option>
              <option value="host_tool_loop">宿主 Tool Loop fallback</option>
              <option value="disabled">关闭 Windows Agent</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-slate-500">Hermes 根路径</span>
            <input
              className="rounded-lg border border-slate-200 px-3 py-2 font-mono text-slate-800"
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder={runtime.mode === "wsl" ? "~/Hermes Agent" : "%USERPROFILE%\\Hermes Agent"}
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <ActionButton icon={Folder} label="选择 Hermes 路径" onClick={chooseHermesRoot} />
            <ActionButton icon={Folder} label="打开 Hermes 路径" onClick={openHermesRoot} />
            <ActionButton icon={Sparkles} label="安装到此路径" onClick={installHermes} loading={installingHermes} />
          </div>
          {installEvent ? <InstallProgressView event={installEvent} /> : null}
          {runtime.mode === "wsl" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="text-slate-500">WSL 发行版</span>
                <input
                  className="rounded-lg border border-slate-200 px-3 py-2 text-slate-800"
                  value={runtime.distro ?? ""}
                  onChange={(event) => setRuntime({ ...runtime, distro: event.target.value || undefined })}
                  placeholder="默认发行版"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-slate-500">Python 命令</span>
                <input
                  className="rounded-lg border border-slate-200 px-3 py-2 font-mono text-slate-800"
                  value={runtime.pythonCommand ?? "python3"}
                  onChange={(event) => setRuntime({ ...runtime, pythonCommand: event.target.value || "python3" })}
                />
              </label>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoCard label="Bridge 状态" value={bridge?.running ? "已启动" : "未启动"} />
            <InfoCard label="Bridge 端口" value={bridge?.port ? String(bridge.port) : "unknown"} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <ActionButton icon={Save} label="保存 Hermes 运行环境" onClick={saveRuntime} loading={savingRuntime} />
            <ActionButton icon={Network} label="测试 Windows Agent 能力" onClick={testBridge} loading={testingBridge} />
          </div>
          {bridgeTest ? <BridgeTestResultView result={bridgeTest} /> : null}
        </div>
      </section>

      <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold text-slate-900">客户端信息</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <InfoCard label="版本" value={clientInfo?.appVersion || "unknown"} />
          <InfoCard label="数据路径" value={clientInfo?.userDataPath || "unknown"} monospace />
          <InfoCard label="模式" value={clientInfo?.rendererMode || "unknown"} />
          <InfoCard label="便携版" value={clientInfo?.portable ? "是" : "否"} />
        </div>
      </section>

      <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold text-slate-900">快捷操作</h3>
        <div className="space-y-2">
          <ActionButton
            icon={Folder}
            label="打开会话目录"
            onClick={props.onOpenSessionFolder}
          />
          <ActionButton
            icon={RotateCcw}
            label="清空当前会话"
            onClick={props.onClearSession}
          />
          <ActionButton
            icon={RefreshCw}
            label="重启应用"
            onClick={handleRestart}
            loading={restarting}
          />
          <ActionButton
            icon={Settings}
            label="高级设置"
            onClick={props.onOpenSettings}
          />
        </div>
      </section>

      <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold text-slate-900">诊断</h3>
        <div className="space-y-2">
          <ActionButton
            icon={FileCode}
            label="导出诊断信息"
            onClick={props.onExportDiagnostics}
          />
        </div>
      </section>
    </div>
  );
}

function InfoCard(props: { label: string; value: string; monospace?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3">
      <span className="text-sm text-slate-500">{props.label}</span>
      <code className={cn("text-sm", props.monospace && "font-mono")}>{props.value}</code>
    </div>
  );
}

function InstallProgressView(props: { event: HermesInstallEvent }) {
  const progress = Math.max(0, Math.min(100, props.event.progress));
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">{props.event.message}</p>
          {props.event.detail ? <p className="mt-1 break-all text-xs text-slate-500">{props.event.detail}</p> : null}
        </div>
        <span className="shrink-0 rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-600">{Math.round(progress)}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
        <div className="h-full rounded-full bg-slate-950 transition-all duration-200" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function BridgeTestResultView(props: { result: HermesWindowsBridgeTestResult }) {
  return (
    <div className={cn(
      "rounded-lg border px-4 py-3",
      props.result.ok ? "border-emerald-100 bg-emerald-50" : "border-rose-100 bg-rose-50",
    )}>
      <div className="mb-3 flex items-start gap-2">
        {props.result.ok ? (
          <CheckCircle2 size={17} className="mt-0.5 text-emerald-600" />
        ) : (
          <XCircle size={17} className="mt-0.5 text-rose-600" />
        )}
        <div className="min-w-0">
          <p className={cn("text-sm font-medium", props.result.ok ? "text-emerald-800" : "text-rose-800")}>
            {props.result.message}
          </p>
          <p className="mt-1 break-all text-xs text-slate-500">
            mode={props.result.mode}
            {props.result.bridgeUrl ? ` · ${props.result.bridgeUrl}` : ""}
          </p>
        </div>
      </div>
      <div className="grid gap-2">
        {props.result.steps.map((step) => <BridgeTestStepRow key={step.id} step={step} />)}
      </div>
    </div>
  );
}

function BridgeTestStepRow(props: { step: BridgeTestStep }) {
  const Icon = props.step.status === "passed" ? CheckCircle2 : props.step.status === "failed" ? XCircle : MinusCircle;
  return (
    <div className="rounded-lg bg-white/80 px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon size={15} className={cn("mt-0.5 shrink-0", stepTone(props.step.status))} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-800">{props.step.label}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", stepBadge(props.step.status))}>
              {stepLabel(props.step.status)}
            </span>
            {typeof props.step.durationMs === "number" ? (
              <span className="text-[11px] text-slate-400">{props.step.durationMs}ms</span>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-600">{props.step.message}</p>
          {props.step.detail ? (
            <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950/90 p-2 text-[11px] leading-4 text-slate-100">
              {props.step.detail}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActionButton(props: { icon: typeof Folder; label: string; onClick: () => void; loading?: boolean }) {
  const Icon = props.icon;
  return (
    <button
      className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-sm text-slate-700 transition-all hover:bg-slate-50"
      onClick={props.onClick}
      disabled={props.loading}
      type="button"
    >
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100">
        {props.loading ? (
          <RefreshCw size={16} className="animate-spin text-slate-500" />
        ) : (
          <Icon size={16} className="text-slate-500" />
        )}
      </div>
      <span>{props.label}</span>
    </button>
  );
}

function stepLabel(status: BridgeTestStep["status"]) {
  if (status === "passed") return "通过";
  if (status === "failed") return "失败";
  return "跳过";
}

function stepTone(status: BridgeTestStep["status"]) {
  if (status === "passed") return "text-emerald-600";
  if (status === "failed") return "text-rose-600";
  return "text-slate-400";
}

function stepBadge(status: BridgeTestStep["status"]) {
  if (status === "passed") return "bg-emerald-100 text-emerald-700";
  if (status === "failed") return "bg-rose-100 text-rose-700";
  return "bg-slate-100 text-slate-500";
}

function cn(...classNames: Array<string | false | undefined>): string {
  return classNames.filter(Boolean).join(" ");
}
