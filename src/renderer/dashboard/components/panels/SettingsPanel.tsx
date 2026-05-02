import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
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
  Wrench,
  XCircle,
  X,
  ExternalLink,
} from "lucide-react";
import { useAppStore } from "../../../store";
import type {
  BridgeTestStep,
  EngineUpdateStatus,
  HermesInstallEvent,
  HermesPermissionPolicyMode,
  HermesRuntimeConfig,
  HermesWindowsBridgeTestResult,
  PermissionOverview,
  PermissionOverviewBlockReason,
  WindowsAgentMode,
  WindowsBridgeStatus,
} from "../../../../shared/types";
import { POLICY_OPTIONS, bridgeCapabilityRows, enforcementMatrix, policyBlockReason } from "../../permissionModel";
import { usePermissionOverview } from "../../../hooks/usePermissionOverview";
import { buildHermesSetupViewModel, type HermesSetupAction } from "../settings/hermesSetupViewModel";

type Tone = "ok" | "warn" | "danger" | "neutral";

const RECOMMENDED_RUNTIME: HermesRuntimeConfig = {
  mode: "windows",
  pythonCommand: "python",
  windowsAgentMode: "hermes_native",
  cliPermissionMode: "guarded",
  permissionPolicy: "bridge_guarded",
  workerMode: "off",
};

const RUNTIME_OPTIONS = [
  { value: "windows", label: "Windows Native" },
  { value: "darwin", label: "macOS Native" },
] satisfies Array<{ value: HermesRuntimeConfig["mode"]; label: string }>;

export function SettingsPanel(props: {
  onRefresh: () => Promise<unknown>;
  onOpenSettings: () => void;
  onClearSession: () => void;
  onOpenSessionFolder: () => void;
}) {
  const store = useAppStore();
  const [runtime, setRuntime] = useState<HermesRuntimeConfig>(RECOMMENDED_RUNTIME);
  const [rootPath, setRootPath] = useState("");
  const [bridge, setBridge] = useState<WindowsBridgeStatus | undefined>();
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [installingHermes, setInstallingHermes] = useState(false);
  const [importingHermesConfig, setImportingHermesConfig] = useState(false);
  const [installEvent, setInstallEvent] = useState<HermesInstallEvent | undefined>();
  const [installStartTime, setInstallStartTime] = useState<number | null>(null);
  const [testingBridge, setTestingBridge] = useState(false);
  const [bridgeTest, setBridgeTest] = useState<HermesWindowsBridgeTestResult | undefined>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<EngineUpdateStatus | undefined>();
  const permissionOverview = usePermissionOverview({ autoLoad: false });

  useEffect(() => {
    if (!window.workbenchClient || typeof window.workbenchClient.onInstallHermesEvent !== "function") return;
    return window.workbenchClient.onInstallHermesEvent((event) => {
      setInstallEvent(event);
      const isRunning = event.stage !== "completed" && event.stage !== "failed";
      setInstallingHermes(isRunning);
      if (isRunning && !installStartTime) {
        setInstallStartTime(Date.now());
      }
      if (event.stage === "completed" || event.stage === "failed") {
        setInstallStartTime(null);
      }
    });
  }, []);

  useEffect(() => {
    void reloadOverview();
  }, []);

  async function reloadOverview() {
    const [overview, updates] = await Promise.all([
      window.workbenchClient.getConfigOverview().catch(() => undefined),
      window.workbenchClient.checkUpdates().catch(() => [] as EngineUpdateStatus[]),
    ]);
    const nextRuntime = overview?.hermes?.runtime ?? store.runtimeConfig?.hermesRuntime ?? RECOMMENDED_RUNTIME;
    setRuntime(withRuntimeDefaults(nextRuntime));
    setRootPath(overview?.hermes?.rootPath ?? "");
    setBridge(overview?.hermes?.bridge);
    if (overview?.runtimeConfig) store.setRuntimeConfig(overview.runtimeConfig);
    const hermesUpdate = updates.find((u) => u.engineId === "hermes");
    setUpdateStatus(hermesUpdate);
    return hermesUpdate;
  }

  async function refreshAll() {
    setRefreshing(true);
    try {
      const [nextUpdate] = await Promise.all([
        reloadOverview(),
        permissionOverview.refresh(),
        props.onRefresh(),
      ]);
      if (nextUpdate?.updateAvailable) {
        store.info("更新提醒", nextUpdate.message || "Hermes Agent 有更新可用。");
      } else {
        store.success("检测完成", "Hermes 状态已刷新。");
      }
    } catch (error) {
      store.error("检测失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setRefreshing(false);
    }
  }

  async function saveRuntime(nextRuntime = effectiveRuntime(), nextRootPath = rootPath) {
    const previousRuntime = runtime;
    const previousRootPath = rootPath;
    const previousConfig = store.runtimeConfig;
    if (previousConfig) {
      store.setRuntimeConfig({ ...previousConfig, hermesRuntime: nextRuntime });
    }
    setSavingRuntime(true);
    try {
      const saved = await window.workbenchClient.updateHermesConfig({
        rootPath: nextRootPath,
        runtime: nextRuntime,
      });
      store.setRuntimeConfig(saved);
      await reloadOverview();
      void permissionOverview.refresh();
      await props.onRefresh();
      store.success("Hermes 设置已保存", "已应用新的运行环境设置。");
    } catch (error) {
      setRuntime(previousRuntime);
      setRootPath(previousRootPath);
      if (previousConfig) store.setRuntimeConfig(previousConfig);
      store.error("保存失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setSavingRuntime(false);
    }
  }

  async function chooseHermesRoot() {
    const selected = await window.workbenchClient.pickHermesInstallFolder();
    if (selected) setRootPath(selected);
    return selected;
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

  function handleCancelInstall() {
    setInstallingHermes(false);
    setInstallStartTime(null);
    setInstallEvent(undefined);
    store.info("安装已取消", "你可以点击「一键修复」重新安装，或前往官网手动下载安装包。");
  }

  async function installHermes() {
    if (installingHermes) return;
    setInstallingHermes(true);
    setInstallEvent(undefined);
    setInstallStartTime(Date.now());
    try {
      const nextRuntime = effectiveRuntime();
      const saved = await window.workbenchClient.updateHermesConfig({ rootPath, runtime: nextRuntime });
      store.setRuntimeConfig(saved);
      const result = await window.workbenchClient.installHermes(rootPath.trim() ? { rootPath: rootPath.trim() } : undefined);
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
    const next: HermesRuntimeConfig = {
      ...runtime,
      ...RECOMMENDED_RUNTIME,
      mode: runtime.mode === "darwin" ? "darwin" : "windows",
      distro: runtime.distro,
      installSource: runtime.installSource,
    };
    setRuntime(next);
    setMoreOpen(false);
    await saveRuntime(next);
  }

  async function updateHermesAgent() {
    if (installingHermes) return;
    setInstallingHermes(true);
    setInstallEvent(undefined);
    setInstallStartTime(Date.now());
    try {
      const result = await window.workbenchClient.updateHermes();
      const nextUpdate = await reloadOverview();
      await props.onRefresh();
      if (result.ok && !nextUpdate?.updateAvailable) {
        store.success("Hermes Agent 已更新", result.message);
      } else if (result.ok) {
        store.warning("Hermes Agent 仍需处理", nextUpdate?.message || result.message);
      } else {
        store.warning("Hermes Agent 仍需处理", result.message);
      }
    } catch (error) {
      store.error("Hermes Agent 更新失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setInstallingHermes(false);
      setTimeout(() => {
        setInstallEvent(undefined);
        setInstallStartTime(null);
      }, 2500);
    }
  }

  function handlePrimaryAction(action: HermesSetupAction) {
    if (action === "install" || action === "repair") {
      if (runtime.mode === "darwin") {
        void chooseHermesRoot().then((selected) => {
          if (!selected) return;
          void saveRuntime({ ...effectiveRuntime(), managedRoot: selected }, selected);
        });
        return;
      }
      void installHermes();
      return;
    }
    if (action === "update") {
      void updateHermesAgent();
      return;
    }
    if (action === "diagnose") {
      setDetailsOpen(true);
      return;
    }
    if (action === "refresh") {
      void refreshAll();
    }
  }

  async function testBridge() {
    setTestingBridge(true);
    try {
      const result = await window.workbenchClient.testHermesWindowsBridge();
      setBridgeTest(result);
      await reloadOverview();
      if (result.ok) store.success("本机联动正常", result.message);
      else store.warning("本机联动异常", result.message);
    } finally {
      setTestingBridge(false);
    }
  }

  function effectiveRuntime(): HermesRuntimeConfig {
    const mode = runtime.mode === "darwin" ? "darwin" : "windows";
    return {
      ...runtime,
      mode,
      distro: undefined,
      pythonCommand: runtime.pythonCommand?.trim() || (mode === "windows" ? "python" : "python3"),
      windowsAgentMode: runtime.windowsAgentMode ?? "hermes_native",
      cliPermissionMode: runtime.cliPermissionMode ?? "guarded",
      permissionPolicy: runtime.permissionPolicy ?? "bridge_guarded",
      workerMode: "off",
    };
  }

  const status = useMemo(() => buildHermesSetupViewModel({
    runtime,
    rootPath,
    bridge,
    installEvent,
    permissionOverview: permissionOverview.data,
    permissionError: permissionOverview.error,
    hermesAvailable: store.hermesStatus?.engine.available,
    setupBlocking: store.setupSummary?.blocking ?? [],
    setupLoading: refreshing || permissionOverview.loading,
    updateStatus,
    version: store.hermesStatus?.engine.version || updateStatus?.currentVersion,
  }), [
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
    updateStatus,
  ]);

  const matrix = permissionOverview.data ? overviewMatrix(permissionOverview.data) : enforcementMatrix(effectiveRuntime(), bridge);
  const policyBlock = permissionOverview.data?.blockReason ?? policyBlockReason(effectiveRuntime());
  const bridgeCapabilities = permissionOverview.data ? overviewBridgeCapabilities(permissionOverview.data) : bridgeCapabilityRows(bridge, effectiveRuntime());
  return (
    <div className="space-y-3">
      <AgentActionCard
        status={status}
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen((value) => !value)}
        primaryLoading={installingHermes}
        onPrimary={() => handlePrimaryAction(status.primaryAction)}
        secondaryLoading={refreshing}
        onSecondary={refreshAll}
      />

      {status.tone === "danger" || status.tone === "warn" ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <BookOpen size={14} />
          <span>自动安装遇到问题？</span>
          <a
            href={runtime.mode === "darwin" ? "https://hermesagent.org.cn/" : "https://hermesagent.org.cn/docs/getting-started/windows-installation"}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline hover:text-amber-800"
          >
            {runtime.mode === "darwin" ? "查看 Hermes 官网" : "查看手动安装教程"}
          </a>
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
        <SectionHeader
          icon={Settings}
          title="Agent"
          description="安装位置、Hermes home 与本机 Agent 状态。日常只需要关注这里。"
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
                <div className="absolute right-0 z-[25] mt-2 w-44 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
                  <MenuButton label="导入旧配置" loading={importingHermesConfig} onClick={importHermesConfig} />
                  <MenuButton label="恢复推荐设置" onClick={restoreRecommendedSettings} />
                </div>
              ) : null}
            </div>
          )}
        />

        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <FieldLabel label="Agent 安装位置" hint={`Forge 会在这里查找 ${runtimeLabel(runtime.mode)} Hermes Agent。路径不确定时可以更改位置。`} />
                <p className="mt-0.5 break-all font-mono text-sm text-slate-700">{rootPath || "尚未选择安装位置"}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <SecondaryButton icon={Folder} label="更改位置" onClick={chooseHermesRoot} />
                <SecondaryButton icon={Folder} label="打开目录" onClick={openHermesRoot} />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">运行环境：{runtimeLabel(runtime.mode)}</span>
            <SecondaryButton icon={Save} label="保存设置" loading={savingRuntime} onClick={() => void saveRuntime()} />
          </div>
          {installEvent ? (
            <InstallProgressView
              event={installEvent}
              installStartTime={installStartTime}
              onCancel={handleCancelInstall}
            />
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-slate-100 bg-white shadow-sm">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <SectionHeader icon={ShieldCheck} title="高级设置" description="通常不需要修改。遇到权限、联动或启动检查问题时再展开。" compact />
          <ChevronDown size={16} className={cn("shrink-0 text-slate-400 transition-transform", advancedOpen && "rotate-180")} />
        </button>
        {advancedOpen ? (
          <div className="border-t border-slate-100 px-4 py-4">
            <div className="grid gap-3">
              <AdvancedSelect
                label="运行环境"
                tooltip="选择 Hermes Agent 的本机运行方式。Mac 用户应使用 macOS Native。"
                value={runtime.mode === "darwin" ? "darwin" : "windows"}
                onChange={(value) => setRuntime({ ...runtime, mode: value as HermesRuntimeConfig["mode"], distro: undefined, workerMode: "off" })}
                options={RUNTIME_OPTIONS}
              />

              <AdvancedSelect
                label="本机联动方式"
                tooltip="控制 Hermes 是否可以调用本机能力，例如文件、剪贴板、窗口和命令行。推荐保持默认。"
                value={runtime.windowsAgentMode ?? "hermes_native"}
                onChange={(value) => setRuntime({ ...runtime, windowsAgentMode: value as WindowsAgentMode })}
                options={[
                  { value: "hermes_native", label: "Hermes 原生联动（推荐）" },
                  { value: "host_tool_loop", label: "宿主 Tool Loop fallback" },
                  { value: "disabled", label: "关闭 Windows 联动" },
                ]}
              />

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

              <div className="rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">Hermes 源（高级）</span>
                  <SecondaryButton
                    icon={RotateCcw}
                    label="重置为推荐值"
                    onClick={() => {
                      const next = { ...runtime, installSource: undefined };
                      setRuntime(next);
                      void saveRuntime(next);
                    }}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <AdvancedTextInput
                    label="仓库地址"
                    tooltip="Hermes Agent Git 仓库地址。留空则使用默认源。"
                    value={runtime.installSource?.repoUrl ?? ""}
                    placeholder="https://github.com/..."
                    onChange={(value) => {
                      const trimmed = value.trim();
                      if (!trimmed) {
                        setRuntime({ ...runtime, installSource: undefined });
                        return;
                      }
                      setRuntime({
                        ...runtime,
                        installSource: {
                          ...(runtime.installSource ?? { sourceLabel: "fork" as const }),
                          repoUrl: trimmed,
                        },
                      });
                    }}
                  />
                  <AdvancedTextInput
                    label="分支"
                    tooltip="要拉取的分支名称。留空则使用 main。"
                    value={runtime.installSource?.branch ?? ""}
                    placeholder="main"
                    onChange={(value) => {
                      if (!runtime.installSource) return;
                      setRuntime({
                        ...runtime,
                        installSource: {
                          ...runtime.installSource,
                          branch: value.trim() || undefined,
                        },
                      });
                    }}
                  />
                  <AdvancedTextInput
                    label="Commit"
                    tooltip="精确commit hash（7-40位十六进制）。留空则按分支拉取最新。"
                    value={runtime.installSource?.commit ?? ""}
                    placeholder="0537bad..."
                    monospace
                    onChange={(value) => {
                      if (!runtime.installSource) return;
                      setRuntime({
                        ...runtime,
                        installSource: {
                          ...runtime.installSource,
                          commit: value.trim() || undefined,
                        },
                      });
                    }}
                  />
                  <AdvancedSelect
                    label="源标签"
                    tooltip="仅作标记，不影响行为。"
                    value={runtime.installSource?.sourceLabel ?? "fork"}
                    onChange={(value) => {
                      if (!runtime.installSource) return;
                      setRuntime({
                        ...runtime,
                        installSource: {
                          ...runtime.installSource,
                          sourceLabel: value as "official" | "fork" | "pinned",
                        },
                      });
                    }}
                    options={[
                      { value: "official", label: "official" },
                      { value: "fork", label: "fork" },
                      { value: "pinned", label: "pinned" },
                    ]}
                  />
                </div>
                {runtime.installSource?.commit && !/^[0-9a-fA-F]{7,40}$/.test(runtime.installSource.commit) ? (
                  <p className="mt-2 text-xs text-red-600">Commit 应为 7-40 位十六进制字符串。</p>
                ) : null}
                <p className="mt-2 text-xs text-slate-500">
                  这里改完后，下次“更新 Hermes”或“一键修复”会切到新源。
                </p>
              </div>

              {policyBlock ? <PolicyBlockedBanner block={policyBlock} /> : null}

              <div className="flex flex-wrap gap-2">
                <SecondaryButton icon={RotateCcw} label="恢复推荐设置" onClick={restoreRecommendedSettings} />
                <SecondaryButton icon={Network} label="测试本机联动" loading={testingBridge} onClick={testBridge} />
              </div>
              {bridgeTest ? <BridgeTestResultView result={bridgeTest} /> : null}
              <div className="grid gap-3 lg:grid-cols-2">
                <BridgeCapabilityPanel capabilityRows={bridgeCapabilities} />
                <EnforcementMatrixView rows={matrix} />
              </div>
            </div>
          </div>
        ) : null}
      </section>

    </div>
  );
}

function withRuntimeDefaults(runtime: HermesRuntimeConfig): HermesRuntimeConfig {
  const mode = runtime.mode ?? RECOMMENDED_RUNTIME.mode;
  return {
    ...RECOMMENDED_RUNTIME,
    ...runtime,
    pythonCommand: runtime.pythonCommand?.trim() || (mode === "windows" ? "python" : "python3"),
    windowsAgentMode: runtime.windowsAgentMode ?? "hermes_native",
    cliPermissionMode: runtime.cliPermissionMode ?? "guarded",
    permissionPolicy: runtime.permissionPolicy ?? "bridge_guarded",
    workerMode: runtime.workerMode ?? "off",
  };
}

function runtimeLabel(mode?: HermesRuntimeConfig["mode"]) {
  if (mode === "darwin") return "macOS Native";
  return "Windows Native";
}

function AgentActionCard(props: {
  status: ReturnType<typeof buildHermesSetupViewModel>;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  primaryLoading?: boolean;
  onPrimary: () => void;
  secondaryLoading?: boolean;
  onSecondary: () => void;
}) {
  const Icon = props.status.tone === "ok" ? CheckCircle2 : props.status.tone === "danger" ? AlertTriangle : Info;
  const primaryDisabled = props.status.primaryAction === "none";
  const versionRow = props.status.detailRows.find((row) => row.id === "version");
  const latestVersionRow = props.status.detailRows.find((row) => row.id === "latestVersion");
  return (
    <section className={cn(
      "rounded-xl border p-4 shadow-sm",
      props.status.tone === "ok"
        ? "border-emerald-100 bg-emerald-50"
        : props.status.tone === "danger"
          ? "border-rose-100 bg-rose-50"
          : "border-amber-100 bg-amber-50",
    )}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 gap-2.5">
          <div className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
            props.status.tone === "ok"
              ? "bg-emerald-100 text-emerald-700"
              : props.status.tone === "danger"
                ? "bg-rose-100 text-rose-700"
                : "bg-amber-100 text-amber-700",
          )}>
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={cn(
                "text-sm font-semibold",
                props.status.tone === "ok" ? "text-emerald-950" : props.status.tone === "danger" ? "text-rose-950" : "text-amber-950",
              )}>{props.status.title}</h3>
              <span className="rounded-full bg-white/75 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                {props.status.statusPill}
              </span>
              {versionRow ? (
                <span className="rounded-full bg-white/60 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-500">
                  当前 {versionRow.value}
                </span>
              ) : null}
              {latestVersionRow ? (
                <span className="rounded-full bg-white/60 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-500">
                  最新 {latestVersionRow.value}
                </span>
              ) : null}
            </div>
            <p className={cn(
              "mt-0.5 text-xs leading-5",
              props.status.tone === "ok" ? "text-emerald-700" : props.status.tone === "danger" ? "text-rose-700" : "text-amber-700",
            )}>{props.status.detail}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <PrimaryButton icon={Wrench} label={props.status.primaryLabel} loading={props.primaryLoading} disabled={primaryDisabled} onClick={props.onPrimary} highlight={props.status.primaryAction === "update"} />
          <SecondaryButton icon={RefreshCw} label="刷新" loading={props.secondaryLoading} onClick={props.onSecondary} />
          <SecondaryButton icon={Info} label={props.detailsOpen ? "收起详情" : "查看详情"} onClick={props.onToggleDetails} />
        </div>
      </div>
      {props.detailsOpen ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {props.status.detailRows.map((row) => (
            <div key={row.id} className="rounded-lg bg-white/75 px-3 py-2 ring-1 ring-white/70">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-500">{row.label}</span>
                <span className={cn("text-xs font-semibold", toneText(row.tone))}>{row.value}</span>
              </div>
              {row.detail ? <p className="mt-1 break-words text-xs leading-4 text-slate-500">{row.detail}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SectionHeader(props: { icon: typeof Settings; title: string; description: string; action?: React.ReactNode; compact?: boolean }) {
  const Icon = props.icon;
  return (
    <div className={cn("flex min-w-0 items-start justify-between gap-3", props.compact && "flex-1")}>
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600">
          <Icon size={15} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-950">{props.title}</h3>
          <p className="mt-0.5 text-xs leading-4 text-slate-500">{props.description}</p>
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
      <Info size={13} className="text-slate-400" />
      <span className="pointer-events-none absolute left-1/2 top-5 z-20 hidden w-64 -translate-x-1/2 rounded-lg bg-slate-950 px-3 py-2 text-xs leading-5 text-white shadow-lg group-hover:block">
        {props.text}
      </span>
    </span>
  );
}

function AdvancedTextInput(props: { label: string; tooltip: string; value: string; placeholder?: string; monospace?: boolean; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <FieldLabel label={props.label} hint={props.tooltip} />
      <input
        className={cn("rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-800", props.monospace && "font-mono")}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function AdvancedSelect(props: { label: string; tooltip: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void | Promise<void> }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <FieldLabel label={props.label} hint={props.tooltip} />
      <select
        className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-800"
        value={props.value}
        onChange={(event) => void props.onChange(event.target.value)}
      >
        {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function PrimaryButton(props: { icon: typeof Folder; label: string; onClick: () => void; loading?: boolean; disabled?: boolean; highlight?: boolean }) {
  return <ActionButton {...props} variant="primary" />;
}

function SecondaryButton(props: { icon: typeof Folder; label: string; onClick: () => void; loading?: boolean; disabled?: boolean }) {
  return <ActionButton {...props} variant="secondary" />;
}

function ActionButton(props: { icon: typeof Folder; label: string; onClick: () => void; loading?: boolean; disabled?: boolean; variant: "primary" | "secondary"; highlight?: boolean }) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60",
        props.highlight
          ? "bg-amber-500 text-white shadow-md shadow-amber-500/30 hover:bg-amber-600"
          : props.variant === "primary"
            ? "bg-slate-950 text-white hover:bg-slate-800"
            : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
      )}
      onClick={props.onClick}
      disabled={props.loading || props.disabled}
    >
      {props.loading ? <RefreshCw size={14} className="animate-spin" /> : <Icon size={14} />}
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

function InstallProgressView(props: {
  event: HermesInstallEvent;
  installStartTime?: number | null;
  onCancel?: () => void;
}) {
  const progress = Math.max(0, Math.min(100, props.event.progress));
  const isRunning = props.event.stage !== "completed" && props.event.stage !== "failed";
  const elapsedMs = props.installStartTime ? Date.now() - props.installStartTime : 0;
  const stuckAt55 = progress === 55 && elapsedMs > 60_000;

  function stageLabel() {
    if (progress <= 12) return "环境预检";
    if (progress <= 32) return "下载安装脚本";
    if (progress <= 62) return "执行官方安装脚本";
    if (progress <= 82) return "健康检查";
    return "完成";
  }

  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">{props.event.message}</p>
          {props.event.detail ? <p className="mt-0.5 break-words text-xs text-slate-500">{props.event.detail}</p> : null}
        </div>
        <span className="shrink-0 rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-600">{Math.round(progress)}%</span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white">
          <div className="h-full rounded-full bg-slate-950 transition-all duration-200" style={{ width: `${progress}%` }} />
        </div>
        <span className="shrink-0">{stageLabel()}</span>
      </div>
      {stuckAt55 ? (
        <div className="mt-2 rounded-md border border-amber-100 bg-amber-50 px-2.5 py-2">
          <p className="text-[11px] font-medium text-amber-800">为什么卡在 55%？</p>
          <p className="mt-0.5 text-[11px] leading-4 text-amber-700">
            此阶段是 Hermes 官方 PowerShell 安装脚本在后台下载依赖包。如果网络较慢或企业防火墙限制了脚本执行，可能会长时间停留。你可以继续等待，也可以取消后前往官网手动下载。
          </p>
        </div>
      ) : null}
      {isRunning ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={props.onCancel}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
          >
            <X size={12} /> 取消安装
          </button>
          <a
            href="https://hermesagent.org.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-700 hover:underline"
          >
            <ExternalLink size={11} /> 前往 Hermes 官网下载安装包
          </a>
        </div>
      ) : null}
    </div>
  );
}

function PolicyBlockedBanner(props: { block: PermissionOverviewBlockReason }) {
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-rose-800">{props.block.summary}</p>
          <p className="mt-0.5 text-xs leading-4 text-rose-700">{props.block.detail}</p>
          <p className="mt-1 text-xs font-medium leading-4 text-rose-800">修复：{props.block.fixHint}</p>
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
    <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
      <span className="text-sm text-slate-500">{props.label}</span>
      <code className={cn("truncate text-sm text-slate-800", props.monospace && "font-mono")}>{props.value}</code>
    </div>
  );
}

function ClientInfoGrid(props: { appVersion: string; userDataPath: string; rendererMode: string; portable: string }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      <InfoCard label="版本" value={props.appVersion} />
      <InfoCard label="数据路径" value={props.userDataPath} monospace />
      <InfoCard label="模式" value={props.rendererMode} />
      <InfoCard label="便携版" value={props.portable} />
    </div>
  );
}

function BridgeTestResultView(props: { result: HermesWindowsBridgeTestResult }) {
  return (
    <div className={cn("rounded-lg border px-3 py-2", props.result.ok ? "border-emerald-100 bg-emerald-50" : "border-rose-100 bg-rose-50")}>
      <p className={cn("text-sm font-medium", props.result.ok ? "text-emerald-800" : "text-rose-800")}>{props.result.message}</p>
      <div className="mt-2 grid gap-1.5">
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
