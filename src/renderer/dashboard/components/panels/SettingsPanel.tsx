import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Folder,
  Info,
  MoreHorizontal,
  Network,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import { useAppStore } from "../../../store";
import type {
  BridgeTestStep,
  HermesInstallEvent,
  HermesPermissionPolicyMode,
  HermesRuntimeConfig,
  HermesWindowsBridgeTestResult,
  PermissionOverview,
  PermissionOverviewBlockReason,
  WindowsAgentMode,
  WindowsBridgeStatus,
} from "../../../../shared/types";
import { ManagedWslInstallerPanel } from "./ManagedWslInstallerPanel";
import { POLICY_OPTIONS, bridgeCapabilityRows, enforcementMatrix, policyBlockReason } from "../../permissionModel";
import { usePermissionOverview } from "../../../hooks/usePermissionOverview";

type RuntimeChoice = "auto" | "wsl" | "windows";
type InstallState = "installed" | "missing" | "broken" | "checking";
type ConnectionState = "normal" | "error" | "unknown";
type HealthState = "passed" | "error" | "checking";
type Tone = "ok" | "warn" | "danger" | "neutral";

const RECOMMENDED_RUNTIME: HermesRuntimeConfig = {
  mode: "wsl",
  pythonCommand: "python3",
  windowsAgentMode: "hermes_native",
  cliPermissionMode: "guarded",
  permissionPolicy: "bridge_guarded",
};

export function SettingsPanel(props: {
  onRefresh: () => Promise<unknown>;
  onOpenSettings: () => void;
  onClearSession: () => void;
  onOpenSessionFolder: () => void;
  onExportDiagnostics: () => void;
}) {
  const store = useAppStore();
  const [runtimeChoice, setRuntimeChoice] = useState<RuntimeChoice>("auto");
  const [runtime, setRuntime] = useState<HermesRuntimeConfig>(RECOMMENDED_RUNTIME);
  const [rootPath, setRootPath] = useState("");
  const [bridge, setBridge] = useState<WindowsBridgeStatus | undefined>();
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [installingHermes, setInstallingHermes] = useState(false);
  const [importingHermesConfig, setImportingHermesConfig] = useState(false);
  const [installEvent, setInstallEvent] = useState<HermesInstallEvent | undefined>();
  const [testingBridge, setTestingBridge] = useState(false);
  const [bridgeTest, setBridgeTest] = useState<HermesWindowsBridgeTestResult | undefined>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const permissionOverview = usePermissionOverview({ autoLoad: false });

  useEffect(() => {
    if (!window.workbenchClient || typeof window.workbenchClient.onInstallHermesEvent !== "function") return;
    return window.workbenchClient.onInstallHermesEvent((event) => {
      setInstallEvent(event);
      setInstallingHermes(event.stage !== "completed" && event.stage !== "failed");
    });
  }, []);

  async function reloadOverview() {
    const overview = await window.workbenchClient.getConfigOverview().catch(() => undefined);
    const nextRuntime = overview?.hermes?.runtime ?? store.runtimeConfig?.hermesRuntime ?? RECOMMENDED_RUNTIME;
    setRuntime(withRuntimeDefaults(nextRuntime));
    setRuntimeChoice(nextRuntime.mode === "windows" ? "windows" : "auto");
    setRootPath(overview?.hermes?.rootPath ?? "");
    setBridge(overview?.hermes?.bridge);
    if (overview?.runtimeConfig) store.setRuntimeConfig(overview.runtimeConfig);
  }

  async function refreshAll() {
    setRefreshing(true);
    try {
      await Promise.all([
        reloadOverview(),
        permissionOverview.refresh(),
        props.onRefresh(),
      ]);
      store.success("检测完成", "Hermes 状态已刷新。");
    } catch (error) {
      store.error("检测失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setRefreshing(false);
    }
  }

  async function saveRuntime(nextRuntime = effectiveRuntime()) {
    setSavingRuntime(true);
    try {
      const saved = await window.workbenchClient.updateHermesConfig({
        rootPath,
        runtime: nextRuntime,
      });
      store.setRuntimeConfig(saved);
      await reloadOverview();
      void permissionOverview.refresh();
      await props.onRefresh();
      store.success("Hermes 设置已保存", "已应用新的运行环境设置。");
    } catch (error) {
      store.error("保存失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setSavingRuntime(false);
    }
  }

  async function chooseHermesRoot() {
    const selected = await window.workbenchClient.pickHermesInstallFolder();
    if (selected) setRootPath(selected);
  }

  async function openHermesRoot() {
    if (!rootPath.trim()) {
      store.warning("请先填写安装位置");
      return;
    }
    const result = await window.workbenchClient.openPath(rootPath.trim());
    if (result.ok) store.success("已打开安装目录", result.message);
    else store.error("打开目录失败", result.message);
  }

  async function installHermes() {
    if (installingHermes) return;
    setInstallingHermes(true);
    setInstallEvent(undefined);
    try {
      const nextRuntime = effectiveRuntime();
      const saved = await window.workbenchClient.updateHermesConfig({
        rootPath: nextRuntime.mode === "windows" ? rootPath : undefined,
        runtime: nextRuntime,
      });
      store.setRuntimeConfig(saved);
      const result = await window.workbenchClient.installHermes(
        nextRuntime.mode === "windows" && rootPath.trim() ? { rootPath: rootPath.trim() } : undefined,
      );
      if (result.rootPath) setRootPath(result.rootPath);
      await reloadOverview();
      await props.onRefresh();
      if (result.ok) store.success("Hermes 已准备好", result.message);
      else store.error("Hermes 安装失败", result.message);
    } finally {
      setInstallingHermes(false);
    }
  }

  async function importHermesConfig() {
    if (importingHermesConfig) return;
    setImportingHermesConfig(true);
    setMoreOpen(false);
    try {
      const result = await window.workbenchClient.importExistingHermesConfig();
      await reloadOverview();
      void permissionOverview.refresh();
      await props.onRefresh();
      if (result.ok) {
        store.success("已导入旧配置", result.warnings.length ? `${result.message}；${result.warnings.join("；")}` : result.message);
      } else {
        store.warning("没有发现可导入配置", result.warnings.join("；") || result.message);
      }
    } catch (error) {
      store.error("导入旧配置失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setImportingHermesConfig(false);
    }
  }

  async function restoreRecommendedSettings() {
    const next = {
      ...runtime,
      ...RECOMMENDED_RUNTIME,
      distro: runtime.distro,
      installSource: runtime.installSource,
    };
    setRuntime(next);
    setRuntimeChoice("auto");
    setMoreOpen(false);
    await saveRuntime(next);
  }

  async function testBridge() {
    setTestingBridge(true);
    try {
      const result = await window.workbenchClient.testHermesWindowsBridge();
      setBridgeTest(result);
      await reloadOverview();
      if (result.ok) store.success("Windows 联动正常", result.message);
      else store.warning("Windows 联动异常", result.message);
    } finally {
      setTestingBridge(false);
    }
  }

  function effectiveRuntime(): HermesRuntimeConfig {
    if (runtimeChoice === "auto") {
      return {
        ...runtime,
        mode: "wsl",
        pythonCommand: runtime.pythonCommand?.trim() || "python3",
        windowsAgentMode: runtime.windowsAgentMode ?? "hermes_native",
        cliPermissionMode: runtime.cliPermissionMode ?? "guarded",
        permissionPolicy: runtime.permissionPolicy ?? "bridge_guarded",
      };
    }
    return {
      ...runtime,
      mode: runtimeChoice,
      pythonCommand: runtime.pythonCommand?.trim() || "python3",
    };
  }

  const status = useMemo(() => computeStatus({
    runtimeChoice,
    runtime,
    rootPath,
    bridge,
    installEvent,
    permissionOverview: permissionOverview.data,
    permissionError: permissionOverview.error,
    hermesAvailable: store.hermesStatus?.engine.available,
    setupBlockingCount: store.setupSummary?.blocking.length ?? 0,
    setupLoading: refreshing || permissionOverview.loading,
  }), [
    runtimeChoice,
    runtime,
    rootPath,
    bridge,
    installEvent,
    permissionOverview.data,
    permissionOverview.error,
    store.hermesStatus,
    store.setupSummary,
    refreshing,
    permissionOverview.loading,
  ]);

  const matrix = permissionOverview.data ? overviewMatrix(permissionOverview.data) : enforcementMatrix(effectiveRuntime(), bridge);
  const policyBlock = permissionOverview.data?.blockReason ?? policyBlockReason(effectiveRuntime());
  const bridgeCapabilities = permissionOverview.data ? overviewBridgeCapabilities(permissionOverview.data) : bridgeCapabilityRows(bridge, effectiveRuntime());
  const installingWsl = effectiveRuntime().mode === "wsl";
  const installActionLabel = installingHermes
    ? "正在处理..."
    : installingWsl
      ? "一键安装 / 修复 WSL Hermes"
    : status.install.state === "missing"
      ? "安装到此位置"
      : status.install.state === "broken"
        ? "修复安装"
        : "重新安装";

  return (
    <div className="space-y-5">
      <HeroStatus
        title={status.summaryTitle}
        description={status.summaryDetail}
        tone={status.summaryTone}
        primaryLabel={status.summaryTone === "ok" ? installActionLabel : "一键修复"}
        primaryLoading={installingHermes}
        onPrimary={installHermes}
        secondaryLabel="刷新状态"
        secondaryLoading={refreshing}
        onSecondary={refreshAll}
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatusCard title="运行环境" value={status.runtime.value} detail={status.runtime.detail} tone={status.runtime.tone} />
        <StatusCard title="安装状态" value={status.install.value} detail={status.install.detail} tone={status.install.tone} />
        <StatusCard title="连接状态" value={status.connection.value} detail={status.connection.detail} tone={status.connection.tone} />
        <StatusCard title="健康检查" value={status.health.value} detail={status.health.detail} tone={status.health.tone} />
      </section>

      <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
        <SectionHeader
          icon={Settings}
          title="基础设置"
          description="日常使用只需要关注这里。推荐保持自动选择。"
          action={(
            <div className="relative">
              <button
                type="button"
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setMoreOpen((value) => !value)}
              >
                <MoreHorizontal size={15} />
                更多
              </button>
              {moreOpen ? (
                <div className="absolute right-0 z-10 mt-2 w-44 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
                  <MenuButton label="导入旧配置" loading={importingHermesConfig} onClick={importHermesConfig} />
                  <MenuButton label="恢复推荐设置" onClick={restoreRecommendedSettings} />
                </div>
              ) : null}
            </div>
          )}
        />

        <div className="mt-5 space-y-5">
          <div>
            <FieldLabel label="运行环境" hint="自动选择会优先使用更稳定的 WSL 环境，普通用户推荐保持此项。" />
            <SegmentedControl
              value={runtimeChoice}
              options={[
                { value: "auto", label: "自动选择（推荐）" },
                { value: "wsl", label: "WSL" },
                { value: "windows", label: "Windows" },
              ]}
              onChange={(value) => setRuntimeChoice(value)}
            />
            <p className="mt-2 text-xs leading-5 text-slate-500">
              {runtimeChoice === "auto"
                ? `Forge 会自动选择运行方式。当前推荐：${runtime.mode === "windows" ? "Windows" : "WSL"}。`
                : runtimeChoice === "wsl"
                  ? "推荐。Hermes 会在 WSL 内运行，更接近原生 Linux 环境。"
                  : "仅在不使用 WSL 时选择。部分能力可能不如 WSL 稳定。"}
            </p>
          </div>

          <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <FieldLabel label="安装位置" hint="Forge 会在这里查找或安装 Hermes Agent。路径不确定时可以直接点一键修复。" />
                <p className="mt-1 break-all font-mono text-sm text-slate-700">{rootPath || "尚未选择安装位置"}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <SecondaryButton icon={Folder} label="更改位置" onClick={chooseHermesRoot} />
                <SecondaryButton icon={Folder} label="打开目录" onClick={openHermesRoot} />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <PrimaryButton icon={Sparkles} label={installActionLabel} loading={installingHermes} onClick={installHermes} />
            <SecondaryButton icon={Save} label="保存基础设置" loading={savingRuntime} onClick={() => void saveRuntime()} />
          </div>
          {installEvent ? <InstallProgressView event={installEvent} /> : null}
        </div>
      </section>

      <section className="rounded-xl border border-slate-100 bg-white shadow-sm">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <SectionHeader icon={ShieldCheck} title="高级设置" description="通常不需要修改。遇到权限、联动或启动检查问题时再展开。" compact />
          <ChevronDown size={18} className={cn("shrink-0 text-slate-400 transition-transform", advancedOpen && "rotate-180")} />
        </button>
        {advancedOpen ? (
          <div className="border-t border-slate-100 px-5 py-5">
            <div className="grid gap-4">
              {runtimeChoice !== "windows" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <AdvancedTextInput
                    label="WSL 发行版"
                    tooltip="只在你安装了多个 WSL 发行版时需要填写。留空会使用系统默认发行版。"
                    value={runtime.distro ?? ""}
                    placeholder="默认发行版"
                    onChange={(value) => setRuntime({ ...runtime, distro: value || undefined })}
                  />
                  <AdvancedTextInput
                    label="Python 命令"
                    tooltip="Hermes 在 WSL 内使用的 Python 命令。推荐保持 python3。"
                    value={runtime.pythonCommand ?? "python3"}
                    onChange={(value) => setRuntime({ ...runtime, pythonCommand: value || "python3" })}
                    monospace
                  />
                </div>
              ) : null}

              {runtimeChoice === "windows" ? (
                <AdvancedSelect
                  label="Windows 联动方式"
                  tooltip="控制 Hermes 是否可以调用 Windows 本机能力，例如文件、剪贴板、窗口和 PowerShell。推荐保持默认。"
                  value={runtime.windowsAgentMode ?? "hermes_native"}
                  onChange={(value) => setRuntime({ ...runtime, windowsAgentMode: value as WindowsAgentMode })}
                  options={[
                    { value: "hermes_native", label: "Hermes 原生联动（推荐）" },
                    { value: "host_tool_loop", label: "宿主 Tool Loop fallback" },
                    { value: "disabled", label: "关闭 Windows 联动" },
                  ]}
                />
              ) : null}

              <AdvancedSelect
                label="文件访问保护"
                tooltip="用于避免任务同时修改同一个工作区。推荐开启。"
                value={runtime.permissionPolicy ?? "bridge_guarded"}
                onChange={(value) => setRuntime({ ...runtime, permissionPolicy: value as HermesPermissionPolicyMode })}
                options={POLICY_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
              />

              <AdvancedSelect
                label="命令审批方式"
                tooltip="控制 Hermes 执行命令前是否需要确认。普通用户建议使用推荐模式。"
                value={runtime.cliPermissionMode ?? "guarded"}
                onChange={(value) => setRuntime({ ...runtime, cliPermissionMode: value as HermesRuntimeConfig["cliPermissionMode"] })}
                options={[
                  { value: "guarded", label: "推荐模式" },
                  { value: "safe", label: "谨慎模式" },
                  { value: "yolo", label: "宽松模式" },
                ]}
              />

              <AdvancedSelect
                label="启动前检查强度"
                tooltip="检查越完整，启动前越能发现问题，但可能稍慢。推荐保持标准。"
                value={store.runtimeConfig?.startupWarmupMode ?? "cheap"}
                onChange={async (value) => {
                  const config = await window.workbenchClient.getRuntimeConfig();
                  const next = await window.workbenchClient.saveRuntimeConfig({ ...config, startupWarmupMode: value as "off" | "cheap" | "real_probe" });
                  store.setRuntimeConfig(next);
                  store.success("启动前检查已更新", "新的检查强度会在下次启动或检测时生效。");
                }}
                options={[
                  { value: "cheap", label: "标准（推荐）" },
                  { value: "real_probe", label: "完整检查" },
                  { value: "off", label: "关闭" },
                ]}
              />

              {policyBlock ? <PolicyBlockedBanner block={policyBlock} /> : null}
              {runtimeChoice !== "windows" ? (
                <ManagedWslInstallerPanel
                  title="Managed WSL 安装链路"
                  onAfterAction={props.onRefresh}
                  onExportDiagnostics={props.onExportDiagnostics}
                  onNotice={(message, detail, tone) => {
                    if (tone === "error") store.error(message, detail);
                    else if (tone === "warning") store.warning(message, detail);
                    else store.success(message, detail);
                  }}
                />
              ) : null}

              <div className="flex flex-wrap gap-2">
                <SecondaryButton icon={RotateCcw} label="恢复推荐设置" onClick={restoreRecommendedSettings} />
                <SecondaryButton icon={Network} label="测试 Windows 联动" loading={testingBridge} onClick={testBridge} />
                <PrimaryButton icon={Save} label="保存高级设置" loading={savingRuntime} onClick={() => void saveRuntime()} />
              </div>
              {bridgeTest ? <BridgeTestResultView result={bridgeTest} /> : null}
            </div>
          </div>
        ) : null}
      </section>

    </div>
  );
}

function withRuntimeDefaults(runtime: HermesRuntimeConfig): HermesRuntimeConfig {
  return {
    ...RECOMMENDED_RUNTIME,
    ...runtime,
    pythonCommand: runtime.pythonCommand?.trim() || "python3",
    windowsAgentMode: runtime.windowsAgentMode ?? "hermes_native",
    cliPermissionMode: runtime.cliPermissionMode ?? "guarded",
    permissionPolicy: runtime.permissionPolicy ?? "bridge_guarded",
  };
}

function computeStatus(input: {
  runtimeChoice: RuntimeChoice;
  runtime: HermesRuntimeConfig;
  rootPath: string;
  bridge?: WindowsBridgeStatus;
  installEvent?: HermesInstallEvent;
  permissionOverview?: PermissionOverview;
  permissionError?: string;
  hermesAvailable?: boolean;
  setupBlockingCount: number;
  setupLoading: boolean;
}) {
  const installState: InstallState = input.installEvent && input.installEvent.stage !== "completed" && input.installEvent.stage !== "failed"
    ? "checking"
    : input.hermesAvailable === true
      ? "installed"
      : input.rootPath.trim()
        ? "broken"
        : "missing";
  const connectionState: ConnectionState = input.permissionError || input.permissionOverview?.blocked
    ? "error"
    : input.bridge?.running || input.hermesAvailable
      ? "normal"
      : "unknown";
  const healthState: HealthState = input.setupLoading
    ? "checking"
    : input.setupBlockingCount > 0 || input.permissionOverview?.blocked
      ? "error"
      : "passed";
  const hasError = installState === "missing" || installState === "broken" || connectionState === "error" || healthState === "error";
  return {
    summaryTone: hasError ? "danger" as Tone : "ok" as Tone,
    summaryTitle: hasError ? "Hermes 需要处理" : "Hermes 已准备好",
    summaryDetail: hasError
      ? "检测到安装、连接或健康检查存在问题。可以点击一键修复，让 Forge 自动处理。"
      : "当前环境可以正常使用。普通用户保持推荐设置即可。",
    runtime: {
      value: input.runtimeChoice === "auto" ? "自动" : input.runtimeChoice === "wsl" ? "WSL" : "Windows",
      detail: input.runtimeChoice === "auto" ? `当前推荐：${input.runtime.mode === "windows" ? "Windows" : "WSL"}` : "手动选择",
      tone: "ok" as Tone,
    },
    install: installStatus(installState),
    connection: connectionStatus(connectionState),
    health: healthStatus(healthState),
  };
}

function installStatus(state: InstallState) {
  if (state === "installed") return { state, value: "已安装", detail: "Hermes Agent 已找到。", tone: "ok" as Tone };
  if (state === "checking") return { state, value: "检测中", detail: "正在处理安装状态。", tone: "neutral" as Tone };
  if (state === "broken") return { state, value: "安装损坏", detail: "路径存在但 Hermes 不可用。", tone: "danger" as Tone };
  return { state, value: "未安装", detail: "可以一键安装。", tone: "danger" as Tone };
}

function connectionStatus(state: ConnectionState) {
  if (state === "normal") return { value: "正常", detail: "可以连接 Hermes。", tone: "ok" as Tone };
  if (state === "error") return { value: "异常", detail: "需要检查路径或运行环境。", tone: "danger" as Tone };
  return { value: "未检测", detail: "点击重新检测。", tone: "neutral" as Tone };
}

function healthStatus(state: HealthState) {
  if (state === "passed") return { value: "通过", detail: "暂无阻塞项。", tone: "ok" as Tone };
  if (state === "checking") return { value: "检测中", detail: "正在刷新状态。", tone: "neutral" as Tone };
  return { value: "异常", detail: "存在需要修复的问题。", tone: "danger" as Tone };
}

function HeroStatus(props: {
  title: string;
  description: string;
  tone: Tone;
  primaryLabel: string;
  primaryLoading?: boolean;
  onPrimary: () => void;
  secondaryLabel: string;
  secondaryLoading?: boolean;
  onSecondary: () => void;
}) {
  const Icon = props.tone === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <section className={cn("rounded-xl border p-5 shadow-sm", props.tone === "ok" ? "border-emerald-100 bg-emerald-50" : "border-amber-100 bg-amber-50")}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-lg", props.tone === "ok" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>
            <Icon size={21} />
          </div>
          <div className="min-w-0">
            <h3 className={cn("text-base font-semibold", props.tone === "ok" ? "text-emerald-950" : "text-amber-950")}>{props.title}</h3>
            <p className={cn("mt-1 text-sm leading-6", props.tone === "ok" ? "text-emerald-700" : "text-amber-700")}>{props.description}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <PrimaryButton icon={Wrench} label={props.primaryLabel} loading={props.primaryLoading} onClick={props.onPrimary} />
          <SecondaryButton icon={RefreshCw} label={props.secondaryLabel} loading={props.secondaryLoading} onClick={props.onSecondary} />
        </div>
      </div>
    </section>
  );
}

function StatusCard(props: { title: string; value: string; detail: string; tone: Tone }) {
  const Icon = props.tone === "ok" ? CheckCircle2 : props.tone === "danger" ? XCircle : props.tone === "warn" ? AlertTriangle : Info;
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{props.title}</p>
        <Icon size={17} className={toneText(props.tone)} />
      </div>
      <p className="mt-3 text-lg font-semibold text-slate-950">{props.value}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{props.detail}</p>
    </div>
  );
}

function SectionHeader(props: { icon: typeof Settings; title: string; description: string; action?: React.ReactNode; compact?: boolean }) {
  const Icon = props.icon;
  return (
    <div className={cn("flex min-w-0 items-start justify-between gap-3", props.compact && "flex-1")}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600">
          <Icon size={17} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-950">{props.title}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">{props.description}</p>
        </div>
      </div>
      {props.action}
    </div>
  );
}

function FieldLabel(props: { label: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-slate-800">{props.label}</span>
      {props.hint ? <Tooltip text={props.hint} /> : null}
    </div>
  );
}

function Tooltip(props: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <Info size={14} className="text-slate-400" />
      <span className="pointer-events-none absolute left-1/2 top-6 z-20 hidden w-64 -translate-x-1/2 rounded-lg bg-slate-950 px-3 py-2 text-xs leading-5 text-white shadow-lg group-hover:block">
        {props.text}
      </span>
    </span>
  );
}

function SegmentedControl(props: {
  value: RuntimeChoice;
  options: Array<{ value: RuntimeChoice; label: string }>;
  onChange: (value: RuntimeChoice) => void;
}) {
  return (
    <div className="mt-3 grid rounded-lg bg-slate-100 p-1 sm:grid-cols-3">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(
            "rounded-md px-3 py-2 text-sm font-medium transition",
            props.value === option.value ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800",
          )}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function AdvancedTextInput(props: { label: string; tooltip: string; value: string; placeholder?: string; monospace?: boolean; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-2 text-sm">
      <FieldLabel label={props.label} hint={props.tooltip} />
      <input
        className={cn("rounded-lg border border-slate-200 px-3 py-2 text-slate-800", props.monospace && "font-mono")}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function AdvancedSelect(props: { label: string; tooltip: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void | Promise<void> }) {
  return (
    <label className="grid gap-2 text-sm">
      <FieldLabel label={props.label} hint={props.tooltip} />
      <select
        className="rounded-lg border border-slate-200 px-3 py-2 text-slate-800"
        value={props.value}
        onChange={(event) => void props.onChange(event.target.value)}
      >
        {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function PrimaryButton(props: { icon: typeof Folder; label: string; onClick: () => void; loading?: boolean }) {
  return <ActionButton {...props} variant="primary" />;
}

function SecondaryButton(props: { icon: typeof Folder; label: string; onClick: () => void; loading?: boolean }) {
  return <ActionButton {...props} variant="secondary" />;
}

function ActionButton(props: { icon: typeof Folder; label: string; onClick: () => void; loading?: boolean; variant: "primary" | "secondary" }) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60",
        props.variant === "primary"
          ? "bg-slate-950 text-white hover:bg-slate-800"
          : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
      )}
      onClick={props.onClick}
      disabled={props.loading}
    >
      {props.loading ? <RefreshCw size={15} className="animate-spin" /> : <Icon size={15} />}
      {props.label}
    </button>
  );
}

function MenuButton(props: { label: string; onClick: () => void; loading?: boolean }) {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-between px-3 py-2 text-left text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      onClick={props.onClick}
      disabled={props.loading}
    >
      <span>{props.label}</span>
      {props.loading ? <RefreshCw size={13} className="animate-spin" /> : null}
    </button>
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

function PolicyBlockedBanner(props: { block: PermissionOverviewBlockReason }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={17} className="mt-0.5 shrink-0 text-rose-600" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-rose-800">{props.block.summary}</p>
          <p className="mt-1 text-xs leading-5 text-rose-700">{props.block.detail}</p>
          <p className="mt-2 text-xs font-medium leading-5 text-rose-800">修复：{props.block.fixHint}</p>
        </div>
      </div>
    </div>
  );
}

function BridgeCapabilityPanel(props: { capabilityRows: ReturnType<typeof bridgeCapabilityRows> }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-white px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <Network size={16} className="text-slate-500" />
        <h4 className="text-sm font-semibold text-slate-900">Bridge Capability</h4>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <InfoCard label="Bridge" value={props.capabilityRows.enabled ? (props.capabilityRows.running ? "enabled / running" : "enabled / stopped") : "disabled"} />
        <InfoCard label="Capabilities" value={String(props.capabilityRows.capabilities.length)} />
      </div>
      <CapabilityList title="当前 capabilities" items={props.capabilityRows.capabilities} empty="后端未报告 capability" />
      <CapabilityList title="受审批/Bridge 控制" items={props.capabilityRows.approvalControlled} empty="暂无可识别的审批型 capability" />
      <CapabilityList title="已禁用" items={props.capabilityRows.disabledCapabilities} empty="未显式禁用" />
    </div>
  );
}

function CapabilityList(props: { title: string; items: string[]; empty: string }) {
  return (
    <div className="mt-3">
      <p className="mb-2 text-xs font-semibold text-slate-600">{props.title}</p>
      {props.items.length ? (
        <div className="flex flex-wrap gap-1.5">
          {props.items.map((item) => (
            <span key={item} className="rounded-full bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600 ring-1 ring-slate-200">{item}</span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-400">{props.empty}</p>
      )}
    </div>
  );
}

function EnforcementMatrixView(props: { rows: ReturnType<typeof enforcementMatrix> }) {
  const groups = [
    { id: "hard-enforceable", label: "已强制保护", tone: "emerald" },
    { id: "soft-guarded", label: "软性保护", tone: "amber" },
    { id: "not-enforceable-yet", label: "暂未强制", tone: "rose" },
  ] as const;
  return (
    <div className="rounded-lg border border-slate-100 bg-white px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck size={16} className="text-slate-500" />
        <h4 className="text-sm font-semibold text-slate-900">权限边界矩阵</h4>
      </div>
      <div className="grid gap-3">
        {groups.map((group) => (
          <div key={group.id}>
            <p className={cn("mb-2 text-xs font-semibold", matrixTone(group.tone))}>{group.label}</p>
            <div className="grid gap-2">
              {props.rows.filter((row) => row.category === group.id).map((row) => (
                <div key={row.id} className="rounded-lg bg-slate-50 px-3 py-2">
                  <p className="text-xs font-semibold text-slate-800">{row.label}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{row.detail}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function InfoCard(props: { label: string; value: string; monospace?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-4 py-3">
      <span className="text-sm text-slate-500">{props.label}</span>
      <code className={cn("truncate text-sm text-slate-800", props.monospace && "font-mono")}>{props.value}</code>
    </div>
  );
}

function ClientInfoGrid(props: { appVersion: string; userDataPath: string; rendererMode: string; portable: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <InfoCard label="版本" value={props.appVersion} />
      <InfoCard label="数据路径" value={props.userDataPath} monospace />
      <InfoCard label="模式" value={props.rendererMode} />
      <InfoCard label="便携版" value={props.portable} />
    </div>
  );
}

function BridgeTestResultView(props: { result: HermesWindowsBridgeTestResult }) {
  return (
    <div className={cn("rounded-lg border px-4 py-3", props.result.ok ? "border-emerald-100 bg-emerald-50" : "border-rose-100 bg-rose-50")}>
      <p className={cn("text-sm font-medium", props.result.ok ? "text-emerald-800" : "text-rose-800")}>{props.result.message}</p>
      <div className="mt-3 grid gap-2">
        {props.result.steps.map((step) => <BridgeTestStepRow key={step.id} step={step} />)}
      </div>
    </div>
  );
}

function BridgeTestStepRow(props: { step: BridgeTestStep }) {
  const Icon = props.step.status === "passed" ? CheckCircle2 : props.step.status === "failed" ? XCircle : Info;
  return (
    <div className="rounded-lg bg-white/80 px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon size={15} className={cn("mt-0.5 shrink-0", stepTone(props.step.status))} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-800">{props.step.label}</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">{props.step.message}</p>
        </div>
      </div>
    </div>
  );
}

function overviewMatrix(overview: PermissionOverview): ReturnType<typeof enforcementMatrix> {
  return [
    ...overview.enforcement.hardEnforceable.map((detail, index) => ({
      id: `overview-hard-${index}`,
      label: boundaryLabel(detail),
      category: "hard-enforceable" as const,
      detail,
    })),
    ...overview.enforcement.softGuarded.map((detail, index) => ({
      id: `overview-soft-${index}`,
      label: boundaryLabel(detail),
      category: "soft-guarded" as const,
      detail,
    })),
    ...overview.enforcement.notEnforceableYet.map((detail, index) => ({
      id: `overview-missing-${index}`,
      label: boundaryLabel(detail),
      category: "not-enforceable-yet" as const,
      detail,
    })),
  ];
}

function overviewBridgeCapabilities(overview: PermissionOverview): ReturnType<typeof bridgeCapabilityRows> {
  return {
    enabled: overview.bridge.enabled,
    running: overview.bridge.running,
    capabilities: overview.bridge.capabilities,
    approvalControlled: overview.bridge.capabilities.filter((capability) => /powershell|keyboard|mouse|ahk|window|screenshot|clipboard|files/i.test(capability)),
    disabledCapabilities: overview.bridge.enabled ? (overview.bridge.reportedByBackend ? [] : ["后端未报告 capability"]) : ["all bridge capabilities"],
  };
}

function boundaryLabel(detail: string) {
  return detail.split(":")[0]?.trim() || detail.slice(0, 32);
}

function toneText(tone: Tone) {
  if (tone === "ok") return "text-emerald-600";
  if (tone === "danger") return "text-rose-600";
  if (tone === "warn") return "text-amber-600";
  return "text-slate-400";
}

function stepTone(status: BridgeTestStep["status"]) {
  if (status === "passed") return "text-emerald-600";
  if (status === "failed") return "text-rose-600";
  return "text-slate-400";
}

function matrixTone(tone: "emerald" | "amber" | "rose") {
  if (tone === "emerald") return "text-emerald-700";
  if (tone === "amber") return "text-amber-700";
  return "text-rose-700";
}

function cn(...classNames: Array<string | false | undefined>): string {
  return classNames.filter(Boolean).join(" ");
}
