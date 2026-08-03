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
  Gauge,
  Keyboard,
  Terminal,
} from "lucide-react";
import { useAppStore } from "../../../store";
import type {
  BridgeTestStep,
  EngineUpdateStatus,
  HermesInstallEvent,
  HermesPermissionPolicyMode,
  HermesRuntimeConfig,
  HermesWebUiSettings,
  HermesWindowsBridgeTestResult,
  PermissionOverview,
  PermissionOverviewBlockReason,
  WindowsAgentMode,
  WindowsBridgeStatus,
} from "../../../../shared/types";
import { POLICY_OPTIONS, bridgeCapabilityRows, enforcementMatrix, policyBlockReason } from "../../permissionModel";
import { usePermissionOverview } from "../../../hooks/usePermissionOverview";
import { buildHermesSetupViewModel, type HermesSetupAction } from "../settings/hermesSetupViewModel";
import { InstallSourceDialog, type InstallSourceChoice } from "../InstallSourceDialog";

type Tone = "ok" | "warn" | "danger" | "neutral";
type InstallSourceKind = "official" | "mirror" | "custom";

const OFFICIAL_HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";
const OFFICIAL_HERMES_DOCS_URL = "https://hermes-agent.nousresearch.com/";
const COMMUNITY_MIRROR_URL = "https://hermesagent.org.cn/";

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
  const [installLogLines, setInstallLogLines] = useState<string[]>([]);
  const [installLogOpen, setInstallLogOpen] = useState(false);
  const [installStartTime, setInstallStartTime] = useState<number | null>(null);
  const [testingBridge, setTestingBridge] = useState(false);
  const [bridgeTest, setBridgeTest] = useState<HermesWindowsBridgeTestResult | undefined>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<EngineUpdateStatus | undefined>();
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [lastInstallSourceKind, setLastInstallSourceKind] = useState<InstallSourceChoice | undefined>();
  const [savingPreference, setSavingPreference] = useState<string | undefined>();
  const permissionOverview = usePermissionOverview({ autoLoad: false });

  useEffect(() => {
    if (!window.workbenchClient || typeof window.workbenchClient.onInstallHermesEvent !== "function") return;
    return window.workbenchClient.onInstallHermesEvent((event) => {
      setInstallEvent(event);
      if (event.logLine) {
        setInstallLogLines((lines) => [...lines.slice(-79), event.logLine!]);
      }
      const isRunning = !["completed", "failed", "cancelled"].includes(event.stage);
      setInstallingHermes(isRunning);
      if (isRunning && !installStartTime) {
        setInstallStartTime(Date.now());
      }
      if (event.stage === "completed" || event.stage === "failed" || event.stage === "cancelled") {
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

  async function handleCancelInstall() {
    const result = await window.workbenchClient.cancelInstallHermes();
    if (result.ok) store.info("正在取消安装", result.message);
    else store.warning("取消安装", result.message);
  }

  async function installHermes(kind: InstallSourceChoice) {
    if (installingHermes) return;
    setSourceDialogOpen(false);
    setLastInstallSourceKind(kind);
    setInstallingHermes(true);
    setInstallEvent(undefined);
    setInstallLogLines([]);
    setInstallLogOpen(false);
    setInstallStartTime(Date.now());
    try {
      const nextRuntime = effectiveRuntime();
      const saved = await window.workbenchClient.updateHermesConfig({ rootPath, runtime: nextRuntime });
      store.setRuntimeConfig(saved);
      const result = await window.workbenchClient.installHermes({
        ...(rootPath.trim() ? { rootPath: rootPath.trim() } : {}),
        source: { kind },
      });
      if (result.rootPath) setRootPath(result.rootPath);
      await reloadOverview();
      await props.onRefresh();
      if (result.ok) store.success("Hermes 已准备好", result.message);
      else if (result.message.includes("已取消")) store.info("Hermes 安装已取消", result.message);
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

  async function updateWorkbenchPreference(input: Partial<HermesWebUiSettings>, savingKeyValue: string, successMessage: string) {
    setSavingPreference(savingKeyValue);
    try {
      const nextSettings = await window.workbenchClient.saveWebUiSettings(input);
      store.setWebUiOverview(store.webUiOverview ? { ...store.webUiOverview, settings: nextSettings } : undefined);
      store.success("设置已保存", successMessage);
    } catch (error) {
      store.error("设置保存失败", error instanceof Error ? error.message : "无法保存工作台偏好。");
    } finally {
      setSavingPreference(undefined);
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
      setSourceDialogOpen(true);
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
  const webSettings = store.webUiOverview?.settings;
  return (
    <div className="space-y-3">
      <InstallSourceDialog
        busy={installingHermes}
        onClose={() => setSourceDialogOpen(false)}
        onSelect={(kind) => void installHermes(kind)}
        open={sourceDialogOpen}
      />
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
            href={runtime.mode === "darwin" ? OFFICIAL_HERMES_DOCS_URL : "https://github.com/NousResearch/hermes-agent"}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold underline hover:text-amber-800"
          >
            {runtime.mode === "darwin" ? "查看 Hermes 官方文档" : "查看官方 GitHub"}
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
              logLines={installLogLines}
              logOpen={installLogOpen}
              onToggleLog={() => setInstallLogOpen((value) => !value)}
              installStartTime={installStartTime}
              onCancel={() => void handleCancelInstall()}
              onRetryMirror={() => void installHermes("mirror")}
              showMirrorRetry={installEvent.stage === "failed" && lastInstallSourceKind === "official"}
            />
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
        <SectionHeader
          icon={Keyboard}
          title="工作台偏好"
          description="对话输入、Token 用量和 CLI 会话显示。这里改完会立即保存。"
        />
        <div className="mt-4 divide-y divide-slate-100">
          <PreferenceRow
            icon={Keyboard}
            title="发送快捷键"
            description="选择 Enter 直接发送，或 Ctrl+Enter 发送、Enter 换行。"
            control={(
              <SendKeyPreferenceSegment
                value={webSettings?.sendKey ?? "enter"}
                saving={savingPreference === "sendKey"}
                onChange={(sendKey) => void updateWorkbenchPreference(
                  { sendKey, sendKeyHintDismissed: true },
                  "sendKey",
                  sendKey === "enter" ? "已切换为 Enter 发送。" : "已切换为 Ctrl+Enter 发送。",
                )}
              />
            )}
          />
          <PreferenceRow
            icon={Gauge}
            title="Token 用量"
            description="在对话里显示每轮输入、输出和上下文用量。"
            control={(
              <PreferenceSwitch
                label="显示 Token 用量"
                checked={webSettings?.showUsage !== false}
                saving={savingPreference === "showUsage"}
                onChange={(value) => void updateWorkbenchPreference({ showUsage: value }, "showUsage", "Token 用量显示已更新。")}
              />
            )}
          />
          <PreferenceRow
            icon={Terminal}
            title="CLI 会话"
            description="显示 Hermes CLI 会话信息，方便排查本机任务运行。"
            control={(
              <PreferenceSwitch
                label="显示 CLI 会话"
                checked={webSettings?.showCliSessions !== false}
                saving={savingPreference === "showCliSessions"}
                onChange={(value) => void updateWorkbenchPreference({ showCliSessions: value }, "showCliSessions", "CLI 会话显示已更新。")}
              />
            )}
          />
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

              <AdvancedSelect
                label="启动时自动运行 Gateway"
                tooltip="仅在已经配置并启用连接器时生效。关闭后仍可在连接器页面手动启动。"
                value={store.runtimeConfig?.startupGatewayAutoStart ? "on" : "off"}
                onChange={async (value) => {
                  const config = await window.workbenchClient.getRuntimeConfig();
                  const enabled = value === "on";
                  const next = await window.workbenchClient.saveRuntimeConfig({ ...config, startupGatewayAutoStart: enabled });
                  store.setRuntimeConfig(next);
                  store.success("Gateway 启动设置已更新", enabled ? "下次启动时会自动运行已配置的 Gateway。" : "下次启动时不会自动运行 Gateway。");
                }}
                options={[
                  { value: "off", label: "关闭（推荐）" },
                  { value: "on", label: "开启" },
                ]}
              />

              <InstallSourceSettings
                runtime={runtime}
                setRuntime={setRuntime}
                onSave={(next) => void saveRuntime(next)}
              />

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

function PreferenceRow(props: { icon: typeof Settings; title: string; description: string; control: React.ReactNode }) {
  const Icon = props.icon;
  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-500 ring-1 ring-slate-100">
          <Icon size={16} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-slate-900">{props.title}</p>
          <p className="mt-1 text-[12px] leading-5 text-slate-500">{props.description}</p>
        </div>
      </div>
      <div className="shrink-0 md:pl-4">{props.control}</div>
    </div>
  );
}

function SendKeyPreferenceSegment(props: { value: HermesWebUiSettings["sendKey"]; saving: boolean; onChange: (value: HermesWebUiSettings["sendKey"]) => void }) {
  return (
    <div className="inline-grid h-9 grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
      <SendKeyPreferenceButton label="Enter 发送" active={props.value === "enter"} saving={props.saving} onClick={() => props.onChange("enter")} />
      <SendKeyPreferenceButton label="Ctrl+Enter 发送" active={props.value === "mod-enter"} saving={props.saving} onClick={() => props.onChange("mod-enter")} />
    </div>
  );
}

function SendKeyPreferenceButton(props: { label: string; active: boolean; saving: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        "h-7 rounded-lg px-3 text-[12px] font-semibold transition disabled:cursor-wait",
        props.active ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:bg-white/70 hover:text-slate-800",
      )}
      aria-pressed={props.active}
      disabled={props.saving}
      onClick={props.onClick}
      type="button"
    >
      {props.label}
    </button>
  );
}

function PreferenceSwitch(props: { label: string; checked: boolean; saving: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.saving}
      onClick={() => props.onChange(!props.checked)}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 rounded-full p-0.5 transition disabled:cursor-wait disabled:opacity-60",
        props.checked ? "bg-slate-900" : "bg-slate-200",
      )}
    >
      <span
        className={cn(
          "h-6 w-6 rounded-full bg-white shadow-[0_1px_2px_rgba(15,23,42,0.18)] transition-all",
          props.checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
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

function sourceKind(runtime: HermesRuntimeConfig): InstallSourceKind {
  const label = runtime.installSource?.sourceLabel;
  if (label === "mirror") return "mirror";
  if (label === "custom" || label === "fork" || label === "pinned") return "custom";
  return "official";
}

function runtimeForSourceKind(runtime: HermesRuntimeConfig, kind: InstallSourceKind): HermesRuntimeConfig {
  if (kind === "official") {
    return {
      ...runtime,
      installSource: {
        repoUrl: OFFICIAL_HERMES_REPO_URL,
        branch: "main",
        sourceLabel: "official",
      },
    };
  }
  if (kind === "mirror") {
    return {
      ...runtime,
      installSource: {
        repoUrl: OFFICIAL_HERMES_REPO_URL,
        branch: "main",
        sourceLabel: "mirror",
      },
    };
  }
  return {
    ...runtime,
    installSource: {
      repoUrl: runtime.installSource?.repoUrl && runtime.installSource.repoUrl !== OFFICIAL_HERMES_REPO_URL ? runtime.installSource.repoUrl : "",
      branch: runtime.installSource?.branch ?? "main",
      commit: runtime.installSource?.commit,
      sourceLabel: "custom",
    },
  };
}

function InstallSourceSettings(props: {
  runtime: HermesRuntimeConfig;
  setRuntime: (runtime: HermesRuntimeConfig) => void;
  onSave: (runtime: HermesRuntimeConfig) => void;
}) {
  const kind = sourceKind(props.runtime);
  const custom = kind === "custom";
  const source = props.runtime.installSource;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <span className="text-sm font-medium text-slate-700">安装来源</span>
          <p className="mt-0.5 text-xs text-slate-500">默认使用 Nous 官方 GitHub；国内镜像为中文社区提供，非 Nous 官方。</p>
        </div>
        <SecondaryButton
          icon={RotateCcw}
          label="恢复官方源"
          onClick={() => {
            const next = runtimeForSourceKind(props.runtime, "official");
            props.setRuntime(next);
            props.onSave(next);
          }}
        />
      </div>
      <AdvancedSelect
        label="来源类型"
        tooltip="官方 GitHub 最可信；国内社区镜像可在 GitHub 下载慢时手动选择；自定义仓库适合测试 fork 或指定 commit。"
        value={kind}
        onChange={(value) => props.setRuntime(runtimeForSourceKind(props.runtime, value as InstallSourceKind))}
        options={[
          { value: "official", label: "官方 GitHub（推荐）" },
          { value: "mirror", label: "国内社区镜像（非官方）" },
          { value: "custom", label: "自定义仓库" },
        ]}
      />
      <div className="mt-2 rounded-md border border-slate-100 bg-white px-2.5 py-2 text-xs leading-5 text-slate-600">
        {kind === "official" ? (
          <span>安装脚本来自 GitHub Raw，仓库为 NousResearch/hermes-agent。</span>
        ) : kind === "mirror" ? (
          <span>安装脚本来自中文社区镜像，仓库仍对齐官方 NousResearch/hermes-agent。</span>
        ) : (
          <span>安装脚本仍来自官方 GitHub；安装完成后会同步到你填写的仓库/分支/commit。</span>
        )}
        <span className="ml-2 inline-flex gap-2">
          <a className="font-medium text-indigo-600 hover:underline" href={OFFICIAL_HERMES_REPO_URL.replace(/\.git$/, "")} target="_blank" rel="noopener noreferrer">官方 GitHub</a>
          <a className="font-medium text-indigo-600 hover:underline" href={OFFICIAL_HERMES_DOCS_URL} target="_blank" rel="noopener noreferrer">Nous 文档</a>
          {kind === "mirror" ? <a className="font-medium text-slate-500 hover:underline" href={COMMUNITY_MIRROR_URL} target="_blank" rel="noopener noreferrer">中文社区镜像</a> : null}
        </span>
      </div>
      {custom ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <AdvancedTextInput
            label="仓库地址"
            tooltip="自定义 Hermes Agent Git 仓库地址。"
            value={source?.repoUrl ?? ""}
            placeholder="https://github.com/your/hermes-agent.git"
            onChange={(value) => props.setRuntime({
              ...props.runtime,
              installSource: {
                ...(source ?? { sourceLabel: "custom" as const }),
                repoUrl: value.trim(),
                sourceLabel: "custom",
              },
            })}
          />
          <AdvancedTextInput
            label="分支"
            tooltip="要同步的分支名称。留空则使用 main。"
            value={source?.branch ?? ""}
            placeholder="main"
            onChange={(value) => props.setRuntime({
              ...props.runtime,
              installSource: {
                ...(source ?? { repoUrl: "", sourceLabel: "custom" as const }),
                branch: value.trim() || undefined,
                sourceLabel: "custom",
              },
            })}
          />
          <AdvancedTextInput
            label="Commit"
            tooltip="精确 commit hash（7-40 位十六进制）。留空则按分支同步。"
            value={source?.commit ?? ""}
            placeholder="0537bad..."
            monospace
            onChange={(value) => props.setRuntime({
              ...props.runtime,
              installSource: {
                ...(source ?? { repoUrl: "", sourceLabel: "custom" as const }),
                commit: value.trim() || undefined,
                sourceLabel: "custom",
              },
            })}
          />
          {source?.commit && !/^[0-9a-fA-F]{7,40}$/.test(source.commit) ? (
            <p className="self-end text-xs text-red-600">Commit 应为 7-40 位十六进制字符串。</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
  const [open, setOpen] = useState(false);
  const selected = props.options.find((option) => option.value === props.value) ?? props.options[0];
  return (
    <div className="relative grid gap-1.5 text-sm">
      <FieldLabel label={props.label} hint={props.tooltip} />
      <button
        aria-expanded={open}
        aria-label={props.label}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 text-left text-sm text-slate-800 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-200"
        onClick={() => setOpen((value) => !value)}
        role="combobox"
        type="button"
      >
        <span className="truncate">{selected?.label ?? props.label}</span>
        <ChevronDown size={14} className={cn("shrink-0 text-slate-400 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="absolute left-0 top-[calc(100%+6px)] z-30 max-h-64 w-full overflow-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-[0_18px_45px_rgba(15,23,42,0.12)]">
          {props.options.map((option) => {
            const active = option.value === props.value;
            return (
              <button
                aria-selected={active}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] transition",
                  active ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-50 hover:text-slate-950",
                )}
                key={option.value}
                onClick={() => {
                  setOpen(false);
                  void props.onChange(option.value);
                }}
                role="option"
                type="button"
              >
                <span className="truncate">{option.label}</span>
                {active ? <CheckCircle2 size={13} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
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
  logLines: string[];
  logOpen: boolean;
  onToggleLog: () => void;
  installStartTime?: number | null;
  onCancel?: () => void;
  onRetryMirror?: () => void;
  showMirrorRetry?: boolean;
}) {
  const progress = Math.max(0, Math.min(100, props.event.progress));
  const isRunning = !["completed", "failed", "cancelled"].includes(props.event.stage);
  const elapsedMs = props.installStartTime ? Date.now() - props.installStartTime : 0;
  const slowInstall = elapsedMs > 120_000 || (props.event.elapsedSeconds ?? 0) > 120;
  const latestLines = props.logLines.slice(-6);

  function stageLabel() {
    if (props.event.stage === "cancelled") return "已取消";
    if (props.event.stage === "downloading_script") return "下载安装脚本";
    if (props.event.stage === "running_installer") return "执行安装脚本";
    if (props.event.stage === "health_check") return "健康检查";
    if (progress <= 12) return "环境预检";
    if (progress <= 32) return "下载安装脚本";
    if (progress <= 70) return "执行安装脚本";
    if (progress <= 90) return "健康检查";
    return "完成";
  }

  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">{props.event.message}</p>
          {props.event.detail ? <p className="mt-0.5 break-words text-xs text-slate-500">{props.event.detail}</p> : null}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            {props.event.sourceLabel ? <span>来源：{sourceLabelText(props.event.sourceLabel)}</span> : null}
            {props.event.elapsedSeconds ? <span>已运行 {props.event.elapsedSeconds} 秒</span> : null}
            {props.event.diagnosticCode ? <span>诊断：{props.event.diagnosticCode}</span> : null}
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-white px-2 py-1 text-xs font-semibold text-slate-600">{Math.round(progress)}%</span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white">
          <div className="h-full rounded-full bg-slate-950 transition-all duration-200" style={{ width: `${progress}%` }} />
        </div>
        <span className="shrink-0">{stageLabel()}</span>
      </div>
      {latestLines.length ? (
        <div className="mt-2 rounded-md border border-slate-100 bg-white px-2.5 py-2">
          <button
            type="button"
            className="flex w-full items-center justify-between text-left text-[11px] font-medium text-slate-600"
            onClick={props.onToggleLog}
          >
            <span>实时日志</span>
            <span>{props.logOpen ? "收起" : "展开"}</span>
          </button>
          <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-slate-500">
            {(props.logOpen ? props.logLines : latestLines).join("\n")}
          </pre>
        </div>
      ) : null}
      {slowInstall && isRunning ? (
        <div className="mt-2 rounded-md border border-amber-100 bg-amber-50 px-2.5 py-2">
          <p className="text-[11px] font-medium text-amber-800">安装脚本运行时间较长</p>
          <p className="mt-0.5 text-[11px] leading-4 text-amber-700">
            这通常发生在下载 GitHub 仓库、uv/Python 依赖或 winget 系统依赖时。可以展开日志定位阻塞项；如果是 GitHub 网络较慢，可以取消后在安装来源里切换国内社区镜像。
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
            href={OFFICIAL_HERMES_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-700 hover:underline"
          >
            <ExternalLink size={11} /> 查看 Nous 官方文档
          </a>
        </div>
      ) : null}
      {props.showMirrorRetry ? (
        <div className="mt-2 rounded-md border border-amber-100 bg-amber-50 px-2.5 py-2">
          <p className="text-[11px] leading-4 text-amber-700">
            官方 GitHub 源安装失败。可由你确认后改用国内社区镜像重试，不会静默切换来源。
          </p>
          <button
            type="button"
            onClick={props.onRetryMirror}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-1 text-[11px] font-semibold text-amber-800 transition hover:bg-amber-100"
          >
            <Network size={12} /> 改用国内社区镜像重试
          </button>
        </div>
      ) : null}
    </div>
  );
}

function sourceLabelText(label: NonNullable<HermesInstallEvent["sourceLabel"]>) {
  if (label === "official") return "官方 GitHub";
  if (label === "mirror") return "国内社区镜像";
  if (label === "custom" || label === "fork") return "自定义仓库";
  return "固定版本";
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
