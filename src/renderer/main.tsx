import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ActivityLog,
  ConversationHistoryEntry,
  EngineEvent,
  HermesInstallEvent,
  HermesPermissionPolicyMode,
  HermesRuntimeConfig,
  OneClickDiagnosticItem,
  OneClickDiagnosticsReport,
  HermesWindowsBridgeTestResult,
  HermesWebUiOverview,
  HermesWebUiSettings,
  RuntimeConfig,
  SecretVaultStatus,
  SetupCheck,
  SetupDependencyRepairId,
  SetupSummary,
  TaskRunStatus,
  TaskEventEnvelope,
  TaskType,
  WindowsAgentMode,
  WindowsBridgeStatus,
  WorkSession,
} from "../shared/types";
import { DashboardView } from "./dashboard/DashboardView";
import { SupportView } from "./dashboard/SupportView";
import { WelcomePage } from "./dashboard/WelcomePage";
import { ToastContainer } from "./dashboard/ToastNotification";
import { PageLoader } from "./dashboard/LoadingIndicator";
import { ModelConfigWizard } from "./dashboard/components/panels/ModelConfigWizard";
import { SettingsPanel as HermesSettingsPanel } from "./dashboard/components/panels/SettingsPanel";
import { ConfigCenterLayout, type ConfigSectionId } from "./dashboard/components/settings/ConfigCenterLayout";
import { ToggleSwitch } from "./dashboard/components/settings/ToggleSwitch";
import { usePermissionOverview } from "./hooks/usePermissionOverview";
import { targetSessionForTaskEvent } from "./session-routing";
import { useAppStore, type RecentWorkspace } from "./store";
import { safePromiseWithFallback } from "./utils/safePromise";
import { hasInlineLocalFilePath } from "../shared/local-file-paths";
import "./styles.css";

const RECENT_WORKSPACES_KEY = "zhenghebao.hermes.recentWorkspaces";

type ConfigOverview = {
  runtimeConfig: RuntimeConfig;
  hermes: {
    rootPath: string;
    warmupMode: string;
    runtime?: HermesRuntimeConfig;
    bridge?: WindowsBridgeStatus;
    permissions: {
      enabled: boolean;
      workspaceRead: boolean;
      fileWrite: boolean;
      commandRun: boolean;
      memoryRead: boolean;
      contextBridge: boolean;
    };
  };
  models: {
    defaultProfileId?: string;
    providerProfiles: Array<{ id: string; provider: string; label: string; apiKeySecretRef?: string }>;
    modelProfiles: Array<{ id: string; name?: string; provider: string; model: string; baseUrl?: string; secretRef?: string }>;
    summary?: {
      sourceType?: string;
      currentModel?: string;
      baseUrl?: string;
      secretStatus?: string;
      message?: string;
      recommendedFix?: string;
    };
  };
  secrets: Array<{ ref: string; exists: boolean; createdAt?: string; updatedAt?: string; lastUsedAt?: string }>;
  health?: SetupSummary;
};

type FixTarget = "model" | "hermes" | "health" | "diagnostics" | "workspace";

function defaultHermesRuntime(): HermesRuntimeConfig {
  return {
    mode: "windows",
    pythonCommand: "python",
    windowsAgentMode: "hermes_native",
    cliPermissionMode: "yolo",
    permissionPolicy: "bridge_guarded",
    workerMode: "off",
  };
}

function SettingsView(props: {
  overview?: ConfigOverview;
  initialSection?: ConfigSectionId;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onClearSession: () => void;
  onOpenSessionFolder: () => void;
}) {
  const overview = props.overview;
  const store = useAppStore();
  const permissionOverview = usePermissionOverview({ autoLoad: false });
  const [activeSection, setActiveSection] = useState<ConfigSectionId>(props.initialSection ?? "general");
  const [rootPath, setRootPath] = useState(overview?.hermes.rootPath ?? "");
  const [warmupMode, setWarmupMode] = useState(overview?.hermes.warmupMode ?? "cheap");
  const [runtime, setRuntime] = useState<HermesRuntimeConfig>(overview?.hermes.runtime ?? defaultHermesRuntime());
  const [bridge, setBridge] = useState<WindowsBridgeStatus | undefined>(overview?.hermes.bridge);
  const [permissions, setPermissions] = useState(overview?.hermes.permissions ?? {
    enabled: true,
    workspaceRead: true,
    fileWrite: true,
    commandRun: true,
    memoryRead: true,
    contextBridge: true,
  });
  const [secretRef, setSecretRef] = useState(overview?.secrets[0]?.ref ?? "");
  const [secretValue, setSecretValue] = useState("");
  const [saveNotice, setSaveNotice] = useState<string>("");
  const [repairingDependency, setRepairingDependency] = useState<SetupDependencyRepairId | undefined>();
  const [setupActionRunning, setSetupActionRunning] = useState<string | undefined>();
  const [installEvent, setInstallEvent] = useState<HermesInstallEvent | undefined>();
  const [testingBridge, setTestingBridge] = useState(false);
  const [bridgeTest, setBridgeTest] = useState<HermesWindowsBridgeTestResult | undefined>();
  const [oneClickDiagnosticsRunning, setOneClickDiagnosticsRunning] = useState(false);
  const [diagnosticsExporting, setDiagnosticsExporting] = useState(false);
  const [oneClickDiagnostics, setOneClickDiagnostics] = useState<OneClickDiagnosticsReport | undefined>();
  const [importingHermesConfig, setImportingHermesConfig] = useState(false);
  const [migrationPreview, setMigrationPreview] = useState<Awaited<ReturnType<Window["workbenchClient"]["legacyWslMigrationDetect"]>> | undefined>();
  const [scanningMigration, setScanningMigration] = useState(false);
  const [importingLegacyWsl, setImportingLegacyWsl] = useState(false);

  function showSaveNotice(message: string) {
    setSaveNotice(message);
    window.setTimeout(() => {
      setSaveNotice((current) => (current === message ? "" : current));
    }, 2200);
  }

  useEffect(() => {
    setSecretRef(overview?.secrets[0]?.ref ?? "");
  }, [overview?.secrets]);


  useEffect(() => {
    if (props.initialSection) setActiveSection(props.initialSection);
  }, [props.initialSection]);

  useEffect(() => {
    if (!window.workbenchClient || typeof window.workbenchClient.onInstallHermesEvent !== "function") return;
    return window.workbenchClient.onInstallHermesEvent((event) => {
      setInstallEvent(event);
      if (event.stage === "completed" || event.stage === "failed") {
        setSetupActionRunning(undefined);
      }
    });
  }, []);

  useEffect(() => {
    if (!props.overview) {
      void props.onRefresh();
    }
  }, []);

  async function saveSecretSettings() {
    if (!secretRef.trim() || !secretValue.trim()) return;
    await window.workbenchClient.saveSecret({ ref: secretRef.trim(), plainText: secretValue.trim() });
    setSecretValue("");
    await props.onRefresh();
    showSaveNotice(`密钥已保存：${secretRef.trim()}`);
  }

  async function removeSecret(ref: string) {
    await window.workbenchClient.deleteSecret(ref);
    await props.onRefresh();
    showSaveNotice(`密钥已删除：${ref}`);
  }


  useEffect(() => {
    setRootPath(overview?.hermes.rootPath ?? "");
    setWarmupMode(overview?.hermes.warmupMode ?? "cheap");
    setRuntime(overview?.hermes.runtime ?? defaultHermesRuntime());
    setBridge(overview?.hermes.bridge);
    setPermissions(overview?.hermes.permissions ?? {
      enabled: true,
      workspaceRead: true,
      fileWrite: true,
      commandRun: true,
      memoryRead: true,
      contextBridge: true,
    });
  }, [overview]);

  async function saveHermesSettings() {
    await window.workbenchClient.updateHermesConfig({
      rootPath,
      warmupMode,
      permissions,
      runtime,
    });
    await permissionOverview.refresh();
    await props.onRefresh();
    showSaveNotice("Hermes 设置已保存");
  }


  async function chooseHermesRoot() {
    const selected = await window.workbenchClient.pickHermesInstallFolder();
    if (selected) setRootPath(selected);
  }

  async function openHermesRoot() {
    if (!rootPath.trim()) {
      showSaveNotice("请先填写 Hermes 根路径");
      return;
    }
    const result = await window.workbenchClient.openPath(rootPath.trim());
    showSaveNotice(result.message);
  }

  async function installHermesToCurrentPath() {
    if (setupActionRunning) return;
    setSetupActionRunning("hermes");
    setInstallEvent(undefined);
    try {
      const result = await window.workbenchClient.installHermes(rootPath.trim() ? { rootPath: rootPath.trim() } : undefined);
      if (result.rootPath) setRootPath(result.rootPath);
      await props.onRefresh();
      showSaveNotice(result.message);
    } catch (error) {
      showSaveNotice(error instanceof Error ? error.message : "Hermes 自动安装失败");
    } finally {
      setSetupActionRunning(undefined);
    }
  }

  async function importHermesConfig() {
    if (importingHermesConfig) return;
    setImportingHermesConfig(true);
    try {
      const result = await window.workbenchClient.importExistingHermesConfig();
      await permissionOverview.refresh();
      await props.onRefresh();
      showSaveNotice(result.warnings.length ? `${result.message}；${result.warnings.join("；")}` : result.message);
    } catch (error) {
      showSaveNotice(error instanceof Error ? error.message : "导入 Hermes 配置失败");
    } finally {
      setImportingHermesConfig(false);
    }
  }

  async function testBridge() {
    setTestingBridge(true);
    try {
      const result = await window.workbenchClient.testHermesWindowsBridge();
      setBridgeTest(result);
      await props.onRefresh();
      showSaveNotice(result.message);
    } catch (error) {
      showSaveNotice(error instanceof Error ? error.message : "Windows Agent 能力测试失败");
    } finally {
      setTestingBridge(false);
    }
  }

  async function runOneClickDiagnostics(autoFix = false) {
    setOneClickDiagnosticsRunning(true);
    try {
      const workspacePath = useAppStore.getState().workspacePath || undefined;
      const result = await window.workbenchClient.runOneClickDiagnostics({ autoFix, workspacePath });
      setOneClickDiagnostics(result);
      await props.onRefresh();
      showSaveNotice(autoFix ? "一键修复已完成并完成二次验证" : "一键诊断已完成");
    } catch (error) {
      showSaveNotice(error instanceof Error ? error.message : "一键诊断失败");
    } finally {
      setOneClickDiagnosticsRunning(false);
    }
  }

  async function exportOneClickDiagnostics() {
    if (diagnosticsExporting) return;
    setDiagnosticsExporting(true);
    try {
      const workspacePath = useAppStore.getState().workspacePath || undefined;
      const result = await window.workbenchClient.exportOneClickDiagnostics(workspacePath);
      const targetPath = result.diagnosticsPath || result.path;
      if (result.ok && targetPath) {
        showSaveNotice("诊断报告已导出，已打开所在位置。这个文件夹已脱敏，可附到 issue 或发给维护者排查。");
        void window.workbenchClient.openPath(targetPath);
      } else {
        showSaveNotice(result.message);
      }
    } catch (error) {
      showSaveNotice(error instanceof Error ? error.message : "导出诊断报告失败");
    } finally {
      setDiagnosticsExporting(false);
    }
  }

  async function handleSetupFix(check: SetupCheck) {
    if (repairingDependency || setupActionRunning) return;

    if (check.autoFixId) {
      setRepairingDependency(check.autoFixId);
      try {
        const result = await window.workbenchClient.repairSetupDependency(check.autoFixId);
        await props.onRefresh();
        showSaveNotice(result.message);
      } catch (error) {
        showSaveNotice(error instanceof Error ? error.message : "依赖修复失败");
      } finally {
        setRepairingDependency(undefined);
      }
      return;
    }

    if (check.fixAction === "install_hermes") {
      setSetupActionRunning(check.id);
      setInstallEvent(undefined);
      try {
        const result = await window.workbenchClient.installHermes(rootPath.trim() ? { rootPath: rootPath.trim() } : undefined);
        if (result.rootPath) setRootPath(result.rootPath);
        await props.onRefresh();
        showSaveNotice(result.message);
      } catch (error) {
        showSaveNotice(error instanceof Error ? error.message : "Hermes 自动安装失败");
      } finally {
        setSetupActionRunning(undefined);
      }
      return;
    }

    if (check.fixAction === "update_hermes") {
      setSetupActionRunning(check.id);
      try {
        const result = await window.workbenchClient.updateHermes();
        await props.onRefresh();
        showSaveNotice(result.message);
      } catch (error) {
        showSaveNotice(error instanceof Error ? error.message : "Hermes 更新失败");
      } finally {
        setSetupActionRunning(undefined);
      }
      return;
    }

    if (check.fixAction === "configure_model") {
      setActiveSection("providers");
      showSaveNotice("请在模型提供商中补齐默认模型配置");
      return;
    }

    if (check.fixAction === "configure_hermes" || check.fixAction === "open_settings") {
      setActiveSection("general");
      showSaveNotice("请在常规设置中检查 Hermes 路径和运行权限");
    }
  }

  async function scanLegacyWsl() {
    setScanningMigration(true);
    try {
      const preview = await window.workbenchClient.legacyWslMigrationDetect();
      setMigrationPreview(preview);
      showSaveNotice(preview.message);
    } catch (error) {
      showSaveNotice(error instanceof Error ? error.message : "扫描旧数据失败");
    } finally {
      setScanningMigration(false);
    }
  }

  async function importLegacyWsl() {
    setImportingLegacyWsl(true);
    try {
      const result = await window.workbenchClient.legacyWslMigrationImport();
      await props.onRefresh();
      showSaveNotice(result.message);
    } catch (error) {
      showSaveNotice(error instanceof Error ? error.message : "导入旧数据失败");
    } finally {
      setImportingLegacyWsl(false);
    }
  }

  function openWorkbenchPanel(panel: "skills" | "connectors") {
    store.setActivePanel(panel);
    store.setView("home");
  }

  return (
    <ConfigCenterLayout
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      onBack={props.onBack}
      saveNotice={saveNotice}
      title="设置中心"
      description="这里只放最关键、最常用，而且能直接影响是否能正常工作的设置。"
    >
      {activeSection === "general" ? (
        <HermesSettingsPanel
          onRefresh={props.onRefresh}
          onOpenSettings={() => setActiveSection("general")}
          onClearSession={props.onClearSession}
          onOpenSessionFolder={props.onOpenSessionFolder}
        />
      ) : null}

      {activeSection === "providers" ? (
        <section className="space-y-4">
          <SettingsSectionHeader
            label="Model"
            title="模型连接"
            description="选来源、测试连接、保存默认模型。其他细节先交给向导处理。"
          />
          <ModelConfigWizard
            models={overview?.models ?? { defaultProfileId: undefined, providerProfiles: [], modelProfiles: [] }}
            secrets={overview?.secrets ?? []}
            onRefresh={props.onRefresh}
            onSaved={showSaveNotice}
          />
        </section>
      ) : null}

      {activeSection === "integrations" ? (
        <section className="space-y-4">
          <SettingsSectionHeader
            label="Skills & Connectors"
            title="技能与连接器"
            description="这里保留状态和入口；详细编辑继续在工作台里的 Skills 与连接器面板完成。"
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <StatusMetric label="Skills" value={`${store.webUiOverview?.skills.length ?? 0}`} tone={(store.webUiOverview?.skills.length ?? 0) > 0 ? "ok" : "neutral"} />
            <StatusMetric label="连接器" value="Windows Native" tone="ok" />
            <StatusMetric label="Gateway" value={store.setupSummary?.blocking.some((check) => check.id.includes("gateway")) ? "需检查" : "按需启动"} tone={store.setupSummary?.blocking.some((check) => check.id.includes("gateway")) ? "warning" : "neutral"} />
          </div>
          <SettingsPanelCard title="管理入口">
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:bg-slate-50"
                onClick={() => openWorkbenchPanel("skills")}
                type="button"
              >
                <span className="block text-[13px] font-semibold text-slate-900">打开 Skills</span>
                <span className="mt-1 block text-[12px] leading-5 text-slate-500">查看、上传、启用或编辑 Windows Hermes home 下的 skills。</span>
              </button>
              <button
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:bg-slate-50"
                onClick={() => openWorkbenchPanel("connectors")}
                type="button"
              >
                <span className="block text-[13px] font-semibold text-slate-900">打开连接器</span>
                <span className="mt-1 block text-[12px] leading-5 text-slate-500">配置微信、邮箱等连接器，并同步 Windows Hermes .env。</span>
              </button>
            </div>
          </SettingsPanelCard>
          <SettingsPanelCard title="兼容说明">
            <p className="text-[12px] leading-5 text-slate-500">
              Skills 与连接器继续使用现有数据和 IPC。旧 WSL 数据只通过 Diagnostics 里的导入流程迁移，不会作为运行环境启动。
            </p>
          </SettingsPanelCard>
        </section>
      ) : null}

      {activeSection === "secrets" ? (
        <section className="space-y-4">
          <SettingsSectionHeader
            label="Secrets"
            title="本地密钥"
            description="这里只显示保存状态；真实内容不会回显。"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <StatusMetric label="已记录条目" value={`${overview?.secrets.length ?? 0}`} tone={(overview?.secrets.length ?? 0) > 0 ? "ok" : "neutral"} />
            <StatusMetric label="存储方式" value="本机保管库" tone="ok" />
          </div>
          <SettingsPanelCard title="保存或更新密钥">
            <label className="block text-[12px] text-slate-500">
              <span className="mb-1 block">密钥引用</span>
              <input value={secretRef} onChange={(event) => setSecretRef(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700 outline-none" placeholder="例如 provider.openrouter.apiKey" />
            </label>
            <label className="block text-[12px] text-slate-500">
              <span className="mb-1 block">密钥内容</span>
              <input value={secretValue} onChange={(event) => setSecretValue(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700 outline-none" placeholder="输入 API Key（不会显示明文到 Renderer 之外）" type="password" />
            </label>
            <div className="flex justify-end">
              <button className="rounded-xl bg-slate-950 px-4 py-2 text-[13px] font-semibold text-white hover:bg-slate-800" onClick={() => void saveSecretSettings()} type="button">
                保存密钥
              </button>
            </div>
          </SettingsPanelCard>

          <SettingsPanelCard title="已保存引用">
            <div className="space-y-2">
              {(overview?.secrets ?? []).slice(0, 6).map((secret) => (
                <div key={secret.ref} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-800">{secret.ref}</p>
                      <p className="mt-0.5">{secret.exists ? "已配置" : "未配置"}</p>
                      {secret.updatedAt ? <p className="mt-0.5 text-slate-400">更新于：{new Date(secret.updatedAt).toLocaleString("zh-CN")}</p> : null}
                    </div>
                    <button className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-rose-600 hover:bg-rose-50" onClick={() => void removeSecret(secret.ref)} type="button">
                      删除
                    </button>
                  </div>
                </div>
              ))}
              {!(overview?.secrets.length) ? <p className="text-[12px] text-slate-400">暂无密钥元信息。</p> : null}
            </div>
          </SettingsPanelCard>
        </section>
      ) : null}

      {activeSection === "health" ? (
        <section className="space-y-4">
          <SettingsSectionHeader
            label="Diagnostics"
            title="一键诊断与修复"
            description="统一检查当前运行环境、Hermes、Gateway、模型和任务锁；低风险问题可一键修复并自动复查。"
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <StatusMetric label="整体状态" value={oneClickDiagnostics ? (oneClickDiagnostics.summary.failed ? "需处理" : oneClickDiagnostics.summary.warnings ? "有提醒" : "通过") : overview?.health?.ready ? "就绪" : "需处理"} tone={oneClickDiagnostics ? oneClickDiagnostics.summary.failed ? "danger" : oneClickDiagnostics.summary.warnings ? "warning" : "ok" : overview?.health?.ready ? "ok" : "danger"} />
            <StatusMetric label="失败 / 警告" value={oneClickDiagnostics ? `${oneClickDiagnostics.summary.failed} / ${oneClickDiagnostics.summary.warnings}` : `${overview?.health?.blocking.length ?? 0} / 0`} tone={oneClickDiagnostics ? oneClickDiagnostics.summary.failed ? "danger" : oneClickDiagnostics.summary.warnings ? "warning" : "ok" : (overview?.health?.blocking.length ?? 0) > 0 ? "danger" : "ok"} />
            <StatusMetric label="已修复 / 未解决" value={oneClickDiagnostics ? `${oneClickDiagnostics.summary.fixed} / ${oneClickDiagnostics.summary.unresolved}` : `0 / ${overview?.health?.blocking.length ?? 0}`} tone={oneClickDiagnostics?.summary.unresolved ? "warning" : "neutral"} />
          </div>
          <SettingsPanelCard title="先修这些问题">
            {(overview?.health?.blocking.length ?? 0) > 0 ? (
              <div className="space-y-3">
                  {(overview?.health?.blocking ?? []).map((check, index) => (
                    <SetupCheckCard
                      key={`blocking-${check.id}-${index}`}
                      check={check}
                      onFix={handleSetupFix}
                      busy={Boolean((check.autoFixId && repairingDependency === check.autoFixId) || setupActionRunning === check.id)}
                    />
                  ))}
              </div>
            ) : (
              <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-[13px] font-medium text-emerald-700">
                当前没有阻塞任务启动的问题。
              </div>
            )}
          </SettingsPanelCard>

          <SettingsPanelCard title="诊断操作">
            <div className="flex flex-wrap gap-2">
              <button className="rounded-xl bg-slate-950 px-4 py-2 text-[13px] font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60" disabled={oneClickDiagnosticsRunning} onClick={() => void runOneClickDiagnostics(false)} type="button">
                {oneClickDiagnosticsRunning ? "处理中" : "一键诊断（推荐）"}
              </button>
              <button className="rounded-xl bg-emerald-700 px-4 py-2 text-[13px] font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60" disabled={oneClickDiagnosticsRunning} onClick={() => void runOneClickDiagnostics(true)} type="button">
                一键修复
              </button>
              <button className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60" disabled={diagnosticsExporting} onClick={() => void exportOneClickDiagnostics()} type="button">
                {diagnosticsExporting ? "正在导出..." : "导出诊断报告"}
              </button>
              <button className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50" onClick={() => void props.onRefresh()} type="button">
                重新读取当前状态
              </button>
            </div>
            <p className="text-[12px] leading-5 text-slate-500">
              普通诊断不会静默执行跨目录写入测试；深度审计能力已保留给后续显式入口。
            </p>
          </SettingsPanelCard>
          <SettingsPanelCard title="旧 WSL 数据导入">
            <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-slate-900">只导入旧数据，不启用 WSL 运行环境</p>
                  <p className="mt-1 text-[12px] leading-5 text-slate-500">
                    {migrationPreview?.source
                      ? `发现 ${migrationPreview.source.distro ?? "旧目录"}：skills ${migrationPreview.source.skillsCount} 个，配置文件 ${migrationPreview.source.hasConfig || migrationPreview.source.hasEnv ? "可导入" : "未发现"}。`
                      : migrationPreview
                        ? migrationPreview.message
                        : "可迁移旧 WSL Hermes 的 config.yaml、.env 与 skills 到当前 Windows Hermes home。"}
                  </p>
                  {migrationPreview?.source ? <p className="mt-1 break-all font-mono text-[11px] text-slate-400">{migrationPreview.source.homePath}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60" disabled={scanningMigration} onClick={() => void scanLegacyWsl()} type="button">
                    {scanningMigration ? "扫描中" : "扫描旧数据"}
                  </button>
                  <button className="rounded-xl bg-slate-950 px-3 py-2 text-[12px] font-semibold text-white hover:bg-slate-800 disabled:opacity-60" disabled={importingLegacyWsl} onClick={() => void importLegacyWsl()} type="button">
                    {importingLegacyWsl ? "导入中" : "导入"}
                  </button>
                </div>
              </div>
            </div>
          </SettingsPanelCard>
          {oneClickDiagnostics ? <OneClickDiagnosticsResultView report={oneClickDiagnostics} /> : null}

          <SettingsPanelCard title="详细检查结果">
            <div className="space-y-3">
              {(overview?.health?.checks ?? []).map((check, index) => (
                <SetupCheckCard
                  key={`${check.id}-${index}`}
                  check={check}
                  onFix={handleSetupFix}
                  busy={Boolean((check.autoFixId && repairingDependency === check.autoFixId) || setupActionRunning === check.id)}
                />
              ))}
              {!(overview?.health?.checks.length) ? <p className="text-[12px] text-slate-400">暂无健康检查信息。</p> : null}
            </div>
          </SettingsPanelCard>
        </section>
      ) : null}
    </ConfigCenterLayout>
  );
}

function SettingsSectionHeader(props: { label: string; title: string; description: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">{props.label}</p>
      <h2 className="mt-2 text-[20px] font-semibold tracking-[-0.01em] text-slate-950">{props.title}</h2>
      <p className="mt-1 text-[13px] leading-6 text-slate-500">{props.description}</p>
    </div>
  );
}

function SettingsPanelCard(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200/70 bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <h3 className="mb-2 text-[13px] font-semibold text-slate-900">{props.title}</h3>
      <div className="space-y-2">{props.children}</div>
    </section>
  );
}

function StatusMetric(props: { label: string; value: string; tone: "ok" | "warning" | "danger" | "neutral" }) {
  const toneClass =
    props.tone === "ok"
      ? "border-emerald-100 bg-emerald-50 text-emerald-700"
      : props.tone === "warning"
        ? "border-amber-100 bg-amber-50 text-amber-700"
        : props.tone === "danger"
          ? "border-rose-100 bg-rose-50 text-rose-700"
          : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <div className={`rounded-xl border px-3 py-2 ${toneClass}`}>
      <p className="text-[11px] font-medium opacity-75">{props.label}</p>
      <p className="mt-0.5 truncate text-base font-semibold">{props.value}</p>
    </div>
  );
}

function SetupCheckCard(props: {
  check: SetupCheck;
  onFix: (check: SetupCheck) => void | Promise<void>;
  busy?: boolean;
}) {
  const tone = setupStatusTone(props.check.status);
  const danger = props.check.status === "failed" || props.check.status === "missing";
  const warning = props.check.status === "warning";
  const fixLabel = setupFixButtonLabel(props.check);
  const cardClass = danger
    ? "border-rose-200 bg-rose-50/80 text-rose-700"
    : warning
      ? "border-amber-200 bg-amber-50/80 text-amber-700"
      : "border-slate-200/70 bg-slate-50/70 text-slate-600";

  return (
    <div className={`rounded-xl border px-3 py-3 text-[12px] ${cardClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot tone={tone} pulse={props.check.status === "running"} />
            <p className="font-medium text-slate-900">{props.check.label}</p>
          </div>
          {props.check.description ? (
            <p className="mt-1 leading-4 text-slate-500">{props.check.description}</p>
          ) : null}
        </div>
        <span className="shrink-0 rounded-full bg-white/80 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.08em]">
          {setupStatusLabel(props.check.status)}
        </span>
      </div>
      <p className="mt-1.5 break-words leading-5 [overflow-wrap:anywhere]">{props.check.message}</p>
      {props.check.recommendedAction ? (
        <p className="mt-1.5 rounded-lg bg-white/65 px-2.5 py-1.5 leading-4 text-slate-600">
          建议：{props.check.recommendedAction}
        </p>
      ) : null}
      {fixLabel ? (
        <button
          type="button"
          onClick={() => void props.onFix(props.check)}
          disabled={props.busy}
          className="mt-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {props.busy ? "处理中..." : fixLabel}
        </button>
      ) : null}
    </div>
  );
}

function OneClickDiagnosticsResultView(props: { report: OneClickDiagnosticsReport }) {
  return (
    <SettingsPanelCard title="一键诊断结果">
      <div className="space-y-2 text-[12px] text-slate-600">
        <div className={`rounded-lg border px-3 py-2 ${props.report.summary.failed ? "border-rose-100 bg-rose-50 text-rose-800" : props.report.summary.warnings ? "border-amber-100 bg-amber-50 text-amber-800" : "border-emerald-100 bg-emerald-50 text-emerald-800"}`}>
          <p className="font-semibold">
            {props.report.summary.failed ? "诊断完成，但仍有失败项。" : props.report.summary.warnings ? "诊断完成，有需要留意的提醒。" : "诊断通过。"}
          </p>
          <p className="mt-1 text-[11px] opacity-80">
            通过 {props.report.summary.passed}，警告 {props.report.summary.warnings}，失败 {props.report.summary.failed}，已修复 {props.report.summary.fixed}，未解决 {props.report.summary.unresolved}
          </p>
        </div>
        <div className="space-y-2">
          {props.report.items.map((diagnostic) => (
            <div key={diagnostic.id} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot tone={oneClickStatusTone(diagnostic.status)} />
                <span className="font-semibold text-slate-800">{diagnostic.title}</span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">{oneClickStatusLabel(diagnostic.status)}</span>
                {diagnostic.source ? <span className="text-[11px] text-slate-400">{diagnostic.source}</span> : null}
              </div>
              <p className="mt-1 leading-5">{diagnostic.summary}</p>
              {diagnostic.suggestedActions?.length ? (
                <div className="mt-2 rounded-xl bg-white/70 px-3 py-2 leading-5 text-slate-600">
                  建议：{diagnostic.suggestedActions.join("；")}
                </div>
              ) : null}
              {diagnostic.details ? (
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950/90 p-2 text-[11px] leading-4 text-slate-100">
                  {diagnostic.details}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </SettingsPanelCard>
  );
}

function oneClickStatusTone(status: OneClickDiagnosticItem["status"]): "ok" | "warning" | "error" | "neutral" {
  if (status === "fail") return "error";
  if (status === "warn") return "warning";
  if (status === "skipped") return "neutral";
  return "ok";
}

function oneClickStatusLabel(status: OneClickDiagnosticItem["status"]) {
  const labels: Record<OneClickDiagnosticItem["status"], string> = {
    pass: "通过",
    warn: "提醒",
    fail: "失败",
    fixed: "已修复",
    skipped: "跳过",
  };
  return labels[status];
}

function setupStatusTone(status: SetupCheck["status"]): "ok" | "warning" | "error" | "neutral" {
  if (status === "failed" || status === "missing") return "error";
  if (status === "warning") return "warning";
  if (status === "running") return "neutral";
  return "ok";
}

function setupStatusLabel(status: SetupCheck["status"]) {
  const labels: Record<SetupCheck["status"], string> = {
    ok: "正常",
    missing: "缺失",
    warning: "注意",
    running: "检测中",
    failed: "失败",
  };
  return labels[status];
}

function setupFixButtonLabel(check: SetupCheck) {
  if (check.autoFixId === "git") return "一键安装 Git";
  if (check.autoFixId === "python") return "一键安装 Python";
  if (check.autoFixId === "hermes_pyyaml") return "修复 Hermes 依赖";
  if (check.autoFixId === "hermes_python_dotenv") return "修复 Hermes 依赖";
  if (check.autoFixId === "weixin_aiohttp") return "修复微信依赖";
  if (check.fixAction === "install_hermes") return "自动安装 Hermes";
  if (check.fixAction === "update_hermes") return "更新 Hermes Agent";
  if (check.fixAction === "configure_model") return "打开模型配置";
  if (check.fixAction === "configure_hermes" || check.fixAction === "open_settings") return "打开常规设置";
  return "";
}

function StatusDot(props: {
  tone: "ok" | "warning" | "error" | "neutral";
  pulse?: boolean;
}) {
  const toneClass =
    props.tone === "ok"
      ? "bg-emerald-500"
      : props.tone === "warning"
        ? "bg-amber-500"
        : props.tone === "error"
          ? "bg-rose-500"
          : "bg-slate-400";

  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
      {props.pulse ? <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-30 ${toneClass}`} /> : null}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${toneClass}`} />
    </span>
  );
}

function App() {
  const [configOverview, setConfigOverview] = useState<ConfigOverview | undefined>();
  const [settingsInitialSection, setSettingsInitialSection] = useState<ConfigSectionId>("general");
  const sessionLoadSeq = useRef(0);
  const store = useAppStore();

  async function loadConfigOverview(workspacePath?: string) {
    const overview = await safePromiseWithFallback(
      window.workbenchClient.getConfigOverview(workspacePath),
      undefined,
      { errorMessage: "加载配置概览失败" }
    );
    setConfigOverview(overview);
    if (overview?.runtimeConfig) {
      store.setRuntimeConfig(overview.runtimeConfig);
    }
    void window.workbenchClient.getPermissionOverview?.().then((permissionOverview) => store.setPermissionOverview(permissionOverview)).catch(() => undefined);
    return overview;
  }

  async function loadWebUiOverview() {
    const overview = await safePromiseWithFallback(
      window.workbenchClient.getWebUiOverview(),
      undefined,
      { errorMessage: "加载 WebUI 概览失败" }
    );
    store.setWebUiOverview(overview);
    return overview;
  }

  useEffect(() => {
    applyTheme(store.webUiOverview?.settings.theme ?? "green-light");
  }, [store.webUiOverview?.settings.theme]);

  useEffect(() => {
    void bootstrap();
    if (!window.workbenchClient || typeof window.workbenchClient.onTaskEvent !== "function") {
      console.warn("workbenchClient.onTaskEvent not available, skipping event listener");
      return;
    }
    let pendingEvents: TaskEventEnvelope[] = [];
    let rafId: number | null = null;
    const MAX_PENDING_EVENTS = 100;

    function handleAuxiliaryEvent(event: TaskEventEnvelope) {
      if (event.event.type !== "approval") return;
      if (event.event.outcome === "requested") {
        store.upsertApprovalCard(event.event.request);
        return;
      }
      store.resolveApprovalCard(event.event.request.id, event.event.request.status);
    }

    function isTerminalTaskEvent(event: TaskEventEnvelope) {
      if (event.event.type === "result") return true;
      if (event.event.type !== "lifecycle") return false;
      return ["completed", "failed", "cancelled", "restored"].includes(event.event.stage);
    }

    function releaseTaskLockForTerminalEvent(event: TaskEventEnvelope) {
      if (!isTerminalTaskEvent(event)) return;
      const currentState = useAppStore.getState();
      if (currentState.runningSessionId === event.taskRunId) {
        store.setRunningSessionId(undefined);
      }
      if (currentState.runningTaskRunId === event.taskRunId) {
        store.setRunningTaskRunId(undefined);
      }
      void refreshWorkspaceSafety();
      window.setTimeout(() => {
        void reconcileLockStateAfterTerminalEvent(event.taskRunId);
      }, 1500);
    }

    async function reconcileLockStateAfterTerminalEvent(taskRunId: string) {
      await refreshWorkspaceSafety();
      const latest = useAppStore.getState();
      const projection = latest.taskRunProjectionsById[taskRunId];
      if (projection && isTerminalTaskStatus(projection.status)) {
        if (latest.runningTaskRunId === taskRunId) store.setRunningTaskRunId(undefined);
        if (latest.runningSessionId === taskRunId) store.setRunningSessionId(undefined);
        const staleOwnLocks = latest.locks.filter((lock) => lock.sessionId !== taskRunId);
        if (staleOwnLocks.length !== latest.locks.length) {
          store.setLocks(staleOwnLocks);
        }
      }
    }

    function flushEvents() {
      rafId = null;
      const events = pendingEvents;
      pendingEvents = [];
      for (const event of events) {
        store.applyTaskEvent(event);
        handleAuxiliaryEvent(event);
        if (event.event.type === "result") {
          const currentState = useAppStore.getState();
          store.pushActivityLog({
            id: `result-${event.taskRunId}-${event.event.at}`,
            engineId: "hermes",
            type: activityTypeFromTask(currentState.taskType),
            status: event.event.success ? "success" : "failed",
            timestamp: event.event.at,
            summary: `${event.event.title}：${event.event.detail}`,
          });
          const targetSessionId = targetSessionForTaskEvent(event, currentState);
          if (targetSessionId && currentState.runningTaskRunId === event.taskRunId) {
            void window.workbenchClient
              .updateSession({
                id: targetSessionId,
                status: event.event.success ? "completed" : "failed",
                lastMessagePreview: event.event.detail.slice(0, 120),
              })
              .then((session) => store.upsertSession(session));
          }
        }
        releaseTaskLockForTerminalEvent(event);
      }
    }

    const unsubscribe = window.workbenchClient.onTaskEvent((event) => {
      const isTerminal = event.event.type === "result" || event.event.type === "lifecycle";
      if (isTerminal) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        const events = pendingEvents;
        pendingEvents = [];
        for (const e of events) {
          store.applyTaskEvent(e);
          handleAuxiliaryEvent(e);
        }
        store.applyTaskEvent(event);
        handleAuxiliaryEvent(event);
        if (event.event.type === "result") {
          const currentState = useAppStore.getState();
          store.pushActivityLog({
            id: `result-${event.taskRunId}-${event.event.at}`,
            engineId: "hermes",
            type: activityTypeFromTask(currentState.taskType),
            status: event.event.success ? "success" : "failed",
            timestamp: event.event.at,
            summary: `${event.event.title}：${event.event.detail}`,
          });
          const targetSessionId = targetSessionForTaskEvent(event, currentState);
          if (targetSessionId && currentState.runningTaskRunId === event.taskRunId) {
            void window.workbenchClient
              .updateSession({
                id: targetSessionId,
                status: event.event.success ? "completed" : "failed",
                lastMessagePreview: event.event.detail.slice(0, 120),
              })
              .then((session) => store.upsertSession(session));
          }
        }
        releaseTaskLockForTerminalEvent(event);
      } else {
        pendingEvents.push(event);
        if (pendingEvents.length >= MAX_PENDING_EVENTS) {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          flushEvents();
        } else if (rafId === null) {
          rafId = requestAnimationFrame(flushEvents);
        }
      }
    });
    return () => {
      unsubscribe();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    if (!window.workbenchClient || typeof window.workbenchClient.onHermesAgentCompatibilityWarning !== "function") {
      return;
    }
    const unsubscribe = window.workbenchClient.onHermesAgentCompatibilityWarning((event) => {
      if (!event.compatible) {
        if (useAppStore.getState().view === "settings") return;
        store.warning("Hermes Agent 需要处理", event.message);
      }
    });
    return () => unsubscribe();
  }, []);

  async function bootstrap() {
    store.startLoading("bootstrap");
    try {
      // 强制设置默认状态，确保启动时显示聊天界面
      store.setInspectorOpen(false);
      store.setActivePanel("chat");
      store.setWorkspaceDrawerOpen(false);
      
      // 检查 workbenchClient 是否可用
      const workbenchClient = window.workbenchClient;
      if (!workbenchClient) {
        console.error("workbenchClient not available, running in offline mode");
        store.stopLoading("bootstrap");
        return;
      }
      
      // ========== 第一阶段：关键数据优先加载（UI必需） ==========
      const [clientInfo, sessions] = await Promise.all([
        safePromiseWithFallback(
          workbenchClient.getClientInfo(),
          { appVersion: "unknown", userDataPath: "", portable: false, rendererMode: "built" as const },
          { errorMessage: "获取客户端信息失败" }
        ),
        safePromiseWithFallback(
          workbenchClient.listSessions(),
          [],
          { errorMessage: "获取会话列表失败" }
        ),
      ]);
      
      store.setClientInfo(clientInfo);
      store.setSessions(sessions);
      store.setRecentWorkspaces(readRecentWorkspaces());
      
      // 快速选择会话，提前进入主界面
      const activeSession = sessions.find((session: WorkSession) => session.status !== "archived") ?? sessions[0];
      
      if (activeSession) {
        store.upsertSession(activeSession);
        store.setActiveSession(activeSession.id);
        store.setSessionFilesPath(activeSession.sessionFilesPath);
        store.setWorkspacePath(activeSession.workspacePath ?? "");
        const requestId = ++sessionLoadSeq.current;
        void loadSelectedSessionData(activeSession, requestId);
      } else {
        const newSession = await safePromiseWithFallback(
          workbenchClient.createSession("新的会话"),
          undefined,
          { errorMessage: "创建新会话失败" }
        );
        if (newSession) {
          store.upsertSession(newSession);
          store.setActiveSession(newSession.id);
          store.setSessionFilesPath(newSession.sessionFilesPath);
          const requestId = ++sessionLoadSeq.current;
          void loadSelectedSessionData(newSession, requestId);
        }
      }
      
      // ========== 第二阶段：仅加载轻量本地状态 ==========
      // Startup must not fan out into RuntimeProbe, capabilities --json,
      // Gateway status/start, or WebUI file scans. Those remain explicit
      // refresh actions after the shell is interactive.
      Promise.all([
        // 密钥状态
        safePromiseWithFallback(
          workbenchClient.getSecretStatus(),
          { available: false, mode: "safe-storage", path: "", message: "密钥状态暂不可用。" } satisfies SecretVaultStatus,
          { errorMessage: "获取密钥状态失败" }
        ).then((status) => {
          store.setSecretStatus(status);
        }),
        
        // 运行时配置（后备）
        safePromiseWithFallback(
          workbenchClient.getRuntimeConfig(),
          { defaultModelProfileId: undefined, modelProfiles: [], updateSources: {}, enginePermissions: {} } satisfies RuntimeConfig,
          { errorMessage: "获取运行时配置失败" }
          ).then((config) => {
            store.setRuntimeConfig(config);
          }),
      ]).then(() => {
        store.info("欢迎使用 Hermes 工作台", "已完成初始化");
      }).catch(() => {
        // 后台加载失败不影响主流程
      });
      
    } finally {
      store.stopLoading("bootstrap");
    }
  }

  async function selectSession(sessionOrId: WorkSession | string) {
    const current = useAppStore.getState();
    let session = typeof sessionOrId === "string"
      ? current.sessions.find((item) => item.id === sessionOrId)
      : sessionOrId;
    
    if (!session) {
      session = await safePromiseWithFallback(
        window.workbenchClient.createSession("新的会话"),
        undefined,
        { errorMessage: "创建新会话失败" }
      );
      if (!session) return;
    }
    
    store.setActiveSession(session.id);
    store.setSessionFilesPath(session.sessionFilesPath);
    store.setWorkspacePath(session.workspacePath ?? "");
    store.clearSelectedFiles();
    store.clearAttachments();
    store.setSessionAgentInsight(undefined);
    const requestId = ++sessionLoadSeq.current;
    await loadSelectedSessionData(session, requestId);

    // 非关键数据：后台异步加载
    Promise.all([
      refreshWorkspaceSafety(),
      refreshHermesStatus(),
      refreshSetupSummary(),
    ]).catch(() => {
      // 后台加载失败不影响主流程
    });
  }

  async function loadSelectedSessionData(session: WorkSession, requestId: number) {
    // 关键数据：纯聊天会话从 sessionFilesPath 恢复事件；工作区只是可选上下文。
    const eventSourcePath = session.workspacePath || session.sessionFilesPath;
    const [events, fileTree, insight] = await Promise.all([
      eventSourcePath
        ? safePromiseWithFallback(
          window.workbenchClient.getRecentTaskEvents(eventSourcePath, session.id),
          [],
          { errorMessage: "获取任务事件失败" }
        )
        : [],
      session.workspacePath
        ? safePromiseWithFallback(
            window.workbenchClient.getFileTree(session.workspacePath),
            undefined,
            { errorMessage: "获取文件树失败" }
          )
        : undefined,
      eventSourcePath
        ? safePromiseWithFallback(
            window.workbenchClient.getSessionAgentInsight(session.id, eventSourcePath),
            undefined,
            { errorMessage: "获取 Agent 面板恢复数据失败" }
          )
        : undefined,
    ]);

    const latest = useAppStore.getState();
    if (sessionLoadSeq.current !== requestId || latest.activeSessionId !== session.id) {
      return;
    }

    store.setEvents(events);
    store.rebuildSessionProjections(session.id, events);
    store.setFileTree(fileTree);
    store.setSessionAgentInsight(insight);
  }

  async function createSession() {
    const session = await safePromiseWithFallback(
      window.workbenchClient.createSession("新的会话"),
      undefined,
      { errorMessage: "创建会话失败" }
    );
    if (!session) return;
    store.upsertSession(session);
    await selectSession(session);
    store.success("会话已创建", "新会话已准备就绪");
  }

  async function deleteSession(session: WorkSession) {
    const current = useAppStore.getState();
    const deletedWasActive = current.activeSessionId === session.id;
    
    const result = await safePromiseWithFallback(
      window.workbenchClient.deleteSession(session.id),
      { ok: false, message: "删除失败", deletedId: "" },
      { errorMessage: "删除会话失败" }
    );
    
    if (!result.ok) return;
    
    const remaining = useAppStore.getState().sessions.filter((item) => item.id !== result.deletedId);
    store.setSessions(remaining);
    store.clearSessionData(session.id);
    if (deletedWasActive) {
      store.setSessionAgentInsight(undefined);
    }
    store.info("会话已删除", `已删除会话：${session.title}`);
    
    if (!deletedWasActive) return;
    
    const nextSession = remaining[0] ?? await safePromiseWithFallback(
      window.workbenchClient.createSession("新的会话"),
      undefined,
      { errorMessage: "创建新会话失败" }
    );
    
    if (!nextSession) return;
    if (!remaining[0]) store.upsertSession(nextSession);
    await selectSession(nextSession);
  }

  async function renameActiveSession(title: string) {
    const current = useAppStore.getState();
    if (!current.activeSessionId) return;
    const session = await window.workbenchClient.updateSession({ id: current.activeSessionId, title });
    store.upsertSession(session);
  }

  async function openActiveSessionFolder() {
    const current = useAppStore.getState();
    if (!current.activeSessionId) return;
    await window.workbenchClient.openSessionFolder(current.activeSessionId);
  }

  async function clearActiveSession() {
    const current = useAppStore.getState();
    if (!current.activeSessionId) return;
    const result = await window.workbenchClient.clearSessionFiles(current.activeSessionId);
    store.upsertSession(result.session);
    store.clearSessionData(current.activeSessionId);
    store.setSessionAgentInsight(undefined);
    store.clearAttachments();
  }

  async function pickWorkspace() {
    const workspacePath = await window.workbenchClient.pickWorkspaceFolder();
    if (!workspacePath) return;
    await selectWorkspace(workspacePath);
  }

  async function selectWorkspace(workspacePath: string) {
    const current = useAppStore.getState();
    store.setWorkspacePath(workspacePath);
    store.rememberWorkspace(workspacePath);
    store.clearSelectedFiles();
    store.clearAttachments();
    writeRecentWorkspaces(useAppStore.getState().recentWorkspaces);
    if (current.activeSessionId) {
      const session = await window.workbenchClient.updateSession({ id: current.activeSessionId, workspacePath, workspaceStatus: "ready" });
      store.upsertSession(session);
    }
    await Promise.all([refreshHermesStatus(), refreshSetupSummary(), refreshFileTree(), refreshWorkspaceSafety(), loadConfigOverview(workspacePath), loadWebUiOverview()]);
  }

  async function updateActiveSessionMeta(patch: Partial<Pick<WorkSession, "pinned" | "tags" | "status">> & { projectId?: string | null }) {
    const current = useAppStore.getState();
    if (!current.activeSessionId) return;
    const session = await window.workbenchClient.updateSession({ id: current.activeSessionId, ...patch });
    store.upsertSession(session);
  }

  async function updateSessionMeta(sessionId: string, patch: Partial<Pick<WorkSession, "pinned" | "tags" | "status">> & { projectId?: string | null }) {
    const session = await window.workbenchClient.updateSession({ id: sessionId, ...patch });
    store.upsertSession(session);
  }

  async function duplicateSession(session: WorkSession) {
    const copy = await window.workbenchClient.duplicateSession(session.id);
    store.upsertSession(copy);
    await selectSession(copy);
  }

  async function exportSession(session: WorkSession, format: "json" | "markdown") {
    const result = await window.workbenchClient.exportSession({ id: session.id, format });
    store.pushEvent({
      taskRunId: "session-export",
      workSessionId: session.id,
      sessionId: "session-export",
      engineId: "hermes",
      event: { type: "status", level: result.ok ? "success" : "warning", message: result.message, at: new Date().toISOString() },
    });
  }

  async function importSession() {
    const session = await window.workbenchClient.importSession();
    if (!session) return;
    store.upsertSession(session);
    await selectSession(session);
  }

  async function startTask() {
    const current = useAppStore.getState();
    
    if (!window.workbenchClient || typeof window.workbenchClient.startTask !== "function") {
      store.pushEvent({
        taskRunId: "client",
        workSessionId: current.activeSessionId,
        sessionId: "client",
        engineId: "hermes",
        event: { type: "status", level: "error", message: "Hermes 客户端未就绪，请检查连接状态。", at: new Date().toISOString() },
      });
      store.error("发送失败", "Hermes 客户端未就绪，请检查连接状态");
      return;
    }
    
    const prompt = current.userInput.trim() || (current.attachments.length ? "请查看我上传的附件，并根据附件内容给出分析或处理建议。" : "");
    if (!prompt) {
      store.pushEvent({
        taskRunId: "client",
        workSessionId: current.activeSessionId,
        sessionId: "client",
        engineId: "hermes",
        event: { type: "status", level: "warning", message: "请先写清楚要让 Hermes 做什么。", at: new Date().toISOString() },
      });
      return;
    }

    let activeSessionId = current.activeSessionId;
    let sessionFilesPath = current.sessionFilesPath;

    if (!activeSessionId) {
      const newSession = await safePromiseWithFallback(
        window.workbenchClient.createSession(prompt.slice(0, 40)),
        undefined,
        { errorMessage: "自动创建会话失败" }
      );
      if (newSession) {
        store.upsertSession(newSession);
        store.setActiveSession(newSession.id);
        activeSessionId = newSession.id;
        sessionFilesPath = newSession.sessionFilesPath || newSession.id;
        store.setSessionFilesPath(sessionFilesPath);
      } else {
        activeSessionId = `local-${Date.now()}`;
        sessionFilesPath = activeSessionId;
        store.setActiveSession(activeSessionId);
        store.setSessionFilesPath(sessionFilesPath);
      }
    }

    const taskType = current.workspacePath.trim() ? inferTaskType(prompt, current.taskType) : "custom";
    const workSessionId = activeSessionId || "local-session";
    const conversationHistory = buildConversationHistory(current, workSessionId);
    const clientTaskId = createClientTaskId();
    const createdAt = new Date().toISOString();
    store.beginTaskRun({ workSessionId, taskRunId: clientTaskId, userInput: prompt, createdAt });
    store.setUserInput("");
    let result;
    try {
      result = await window.workbenchClient.startTask({
        clientTaskId,
        userInput: prompt,
        sessionId: activeSessionId,
        conversationHistory,
        taskType,
        workspacePath: current.workspacePath || undefined,
        sessionFilesPath: sessionFilesPath || activeSessionId || "default",
        selectedFiles: current.selectedFiles,
        attachments: current.attachments,
        modelProfileId: current.runtimeConfig?.defaultModelProfileId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Hermes 启动前检查失败。";
      store.finalizeTaskRun(clientTaskId, { status: "failed", content: humanizeStartFailure(message) });
      store.pushEvent({
        taskRunId: "preflight",
        workSessionId: activeSessionId,
        sessionId: "preflight",
        engineId: "hermes",
        event: { type: "status", level: "error", message, at: new Date().toISOString() },
      });
      await refreshSetupSummary();
      openFixTarget(fixTargetForFailure(message, useAppStore.getState().setupSummary?.blocking[0]?.fixAction));
      return;
    }

    if (!current.workspacePath.trim() && promptNeedsWorkspace(prompt, current.selectedFiles)) {
      store.warning("请先选择项目目录", "这类请求需要真实工作区，Forge 才能像原版 CLI 一样读取项目文件。");
      store.setWorkspaceDrawerOpen(true);
      return;
    }
    store.clearAttachments();
    if (result.taskRunId !== clientTaskId) store.rebindTaskRunId(clientTaskId, result.taskRunId);
    const resultProjection = useAppStore.getState().taskRunProjectionsById[result.taskRunId];
    if (!isTerminalTaskStatus(resultProjection?.status)) {
      store.setRunningSessionId(result.taskRunId);
      store.setRunningTaskRunId(result.taskRunId);
    }
    store.updateTaskRunMeta(result.taskRunId, {
      engineId: "hermes",
      actualEngine: "hermes",
      runtimeMode: result.runtime.runtimeMode,
      providerId: result.runtime.providerId,
      modelId: result.runtime.modelId,
    });
    store.setContextBundle(result.contextBundle);
    store.setSessionAgentInsight({
      sessionId: activeSessionId || workSessionId,
      latestRuntime: {
        taskRunId: result.taskRunId,
        status: "running",
        providerId: result.runtime.providerId,
        modelId: result.runtime.modelId,
        runtimeMode: result.runtime.runtimeMode,
        updatedAt: new Date().toISOString(),
      },
      memory: {
        bundleId: result.contextBundle.id,
        usedCharacters: result.contextBundle.usedCharacters,
        maxCharacters: result.contextBundle.maxCharacters,
        summary: result.contextBundle.summary,
        updatedAt: result.contextBundle.createdAt,
      },
    });
    store.pushActivityLog({
      id: `start-${result.taskRunId}`,
      engineId: "hermes",
      type: activityTypeFromTask(taskType),
      status: "running",
      timestamp: new Date().toISOString(),
      summary: prompt,
    });
    if (current.activeSessionId) {
      const updated = await window.workbenchClient.updateSession({
        id: current.activeSessionId,
        title: sessionTitleFromPrompt(prompt),
        status: "running",
        lastMessagePreview: prompt.slice(0, 120),
        workspacePath: current.workspacePath || undefined,
        workspaceStatus: current.workspacePath ? "ready" : "unselected",
      });
      store.upsertSession(updated);
    }
    await Promise.all([refreshWorkspaceSafety(), refreshSetupSummary(), refreshHermesStatus(), loadConfigOverview(current.workspacePath || undefined)]);
  }

  async function cancelTask() {
    const current = useAppStore.getState();
    if (!current.runningTaskRunId) return;
    await window.workbenchClient.cancelTask(current.runningTaskRunId);
    store.finalizeTaskRun(current.runningTaskRunId, { status: "cancelled", content: "Hermes 任务已取消。" });
    store.setRunningSessionId(undefined);
    store.setRunningTaskRunId(undefined);
    await refreshWorkspaceSafety();
    store.warning("任务已取消", "当前任务已终止");
  }

  async function restoreSnapshot() {
    const current = useAppStore.getState();
    const target = current.workspacePath || current.sessionFilesPath;
    if (!target) return;
    const result = await window.workbenchClient.restoreLatestSnapshot(target);
    store.pushEvent({
      taskRunId: "snapshot",
      workSessionId: current.activeSessionId,
      sessionId: "snapshot",
      engineId: "hermes",
      event: { type: "status", level: result.restored ? "success" : "warning", message: result.message, at: new Date().toISOString() },
    });
    await refreshWorkspaceSafety();
    if (result.restored) {
      store.success("快照已恢复", result.message);
    } else {
      store.warning("快照恢复失败", result.message);
    }
  }

  async function refreshFileTree() {
    const current = useAppStore.getState();
    if (!current.workspacePath.trim()) {
      store.setFileTree(undefined);
      return;
    }
    const fileTree = await safePromiseWithFallback(
      window.workbenchClient.getFileTree(current.workspacePath),
      undefined,
      { errorMessage: "获取文件树失败" }
    );
    store.setFileTree(fileTree);
  }

  async function refreshWorkspaceSafety() {
    const current = useAppStore.getState();
    const target = current.workspacePath || current.sessionFilesPath;
    if (!target) {
      store.setLocks([]);
      store.setSnapshots([]);
      return;
    }
    const [locks, snapshots] = await Promise.all([
      safePromiseWithFallback(
        window.workbenchClient.listActiveLocks(target),
        [],
        { errorMessage: "获取文件锁失败" }
      ),
      safePromiseWithFallback(
        window.workbenchClient.listSnapshots(target),
        [],
        { errorMessage: "获取快照列表失败" }
      ),
    ]);
    store.setLocks(locks);
    store.setSnapshots(snapshots);
  }

  async function refreshHermesStatus() {
    const current = useAppStore.getState();
    const [status, probe] = await Promise.all([
      safePromiseWithFallback(
        window.workbenchClient.getHermesStatus(current.workspacePath || undefined),
        undefined,
        { errorMessage: "获取 Hermes 状态失败" }
      ),
      safePromiseWithFallback(
        window.workbenchClient.getHermesProbe(current.workspacePath || undefined),
        undefined,
        { errorMessage: "获取 Hermes 探测失败" }
      ),
    ]);
    if (status) store.setHermesStatus(status);
    if (probe) store.setHermesProbe(probe);
  }

  async function refreshSetupSummary() {
    const current = useAppStore.getState();
    const summary = await safePromiseWithFallback(
      window.workbenchClient.getSetupSummary(current.workspacePath || undefined),
      undefined,
      { errorMessage: "获取设置摘要失败" }
    );
    if (summary) {
      store.setSetupSummary(summary);
    }
  }

  function openFixTarget(target: FixTarget) {
    if (target === "workspace") {
      store.setView("home");
      store.setActivePanel("chat");
      store.setWorkspaceDrawerOpen(true);
      return;
    }
    const section: ConfigSectionId = target === "model" ? "providers" : target === "hermes" ? "general" : "health";
    setSettingsInitialSection(section);
    store.setView("settings");
  }

  if (store.firstLaunch) {
    return <WelcomePage onComplete={() => store.setFirstLaunch(false)} />;
  }

  return (
    <>
      {store.isLoading("bootstrap") && <PageLoader />}
      {store.view === "support" ? (
        <SupportView onBack={() => store.setView("home")} />
      ) : store.view === "settings" ? (
        <SettingsView
          overview={configOverview}
          initialSection={settingsInitialSection}
          onBack={() => store.setView("home")}
          onRefresh={async () => {
            const workspacePath = useAppStore.getState().workspacePath || undefined;
            await Promise.all([
              loadConfigOverview(workspacePath),
              refreshSetupSummary(),
              refreshHermesStatus(),
            ]);
          }}
          onClearSession={clearActiveSession}
          onOpenSessionFolder={openActiveSessionFolder}
        />
      ) : (
        <DashboardView
          onPickWorkspace={pickWorkspace}
          onSelectWorkspace={selectWorkspace}
          onCreateSession={createSession}
          onSelectSession={selectSession}
          onDeleteSession={deleteSession}
          onDuplicateSession={duplicateSession}
          onExportSession={exportSession}
          onImportSession={importSession}
          onRenameSession={renameActiveSession}
          onUpdateActiveSessionMeta={updateActiveSessionMeta}
          onUpdateSessionMeta={updateSessionMeta}
          onOpenSessionFolder={openActiveSessionFolder}
          onOpenSupport={() => store.setView("support")}
          onClearSession={clearActiveSession}
          onStartTask={startTask}
          onCancelTask={cancelTask}
          onRestoreSnapshot={restoreSnapshot}
          onRefreshFileTree={refreshFileTree}
          onOpenFix={openFixTarget}
          onRefreshWebUiOverview={loadWebUiOverview}
        />
      )}
      <ToastContainer toasts={store.toasts} onClose={store.removeToast} />
    </>
  );
}

function createClientTaskId() {
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function requiresWorkspace(taskType: TaskType) {
  return taskType !== "custom";
}

function inferTaskType(input: string, fallback: TaskType): TaskType {
  const text = input.toLowerCase();
  if (/修复|报错|错误|bug|failed|error/.test(text)) return "fix_error";
  if (/生成.*网页|做.*页面|网站|前端|react|ui/.test(text)) return "generate_web";
  if (/分析.*项目|目录|架构|依赖|启动方式/.test(text)) return "analyze_project";
  if (/整理|归类|移动|重命名/.test(text)) return "organize_files";
  return fallback;
}

function activityTypeFromTask(taskType: TaskType): ActivityLog["type"] {
  if (taskType === "fix_error") return "fix";
  if (taskType === "analyze_project") return "analyze";
  return "generate";
}

function sessionTitleFromPrompt(prompt: string) {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 32) || "新的会话";
}

function applyTheme(theme: "green-light" | "light" | "slate" | "oled") {
  const resolved = theme === "oled" ? "slate" : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  document.body.setAttribute("data-theme", resolved);
}

function withThemeOverview(
  overview: HermesWebUiOverview | undefined,
  settings: HermesWebUiSettings,
): HermesWebUiOverview {
  if (overview) {
    return { ...overview, settings };
  }
  return {
    settings,
    projects: [],
    spaces: [],
    skills: [],
    memory: [],
    crons: [],
    profiles: [],
    slashCommands: [],
  };
}

function promptNeedsWorkspace(input: string, selectedFiles: string[]) {
  if (hasInlineLocalFilePath(input)) return false;
  if (selectedFiles.length > 0) return true;
  const text = input.trim().toLowerCase();
  if (!text) return false;
  return (
    /读取|读一下|查看|分析|检查|搜索|打开|遍历|修复|修改|编辑|重构|定位|查找/.test(text) &&
    /文件|代码|项目|目录|仓库|源码|模块|package\.json|readme|tsconfig|src\b|文件夹|工作区/.test(text)
  );
}

function buildConversationHistory(state: ReturnType<typeof useAppStore.getState>, workSessionId: string): ConversationHistoryEntry[] {
  const order = state.taskRunOrderBySession[workSessionId] ?? [];
  return order
    .map((taskRunId) => state.taskRunProjectionsById[taskRunId])
    .filter((run): run is NonNullable<typeof run> => Boolean(run) && run.workSessionId === workSessionId)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .flatMap<ConversationHistoryEntry>((run) => {
      const entries: ConversationHistoryEntry[] = [];
      if (run.userMessage?.content.trim()) {
        entries.push({
          role: "user",
          content: run.userMessage.content.trim(),
          createdAt: run.userMessage.createdAt,
          taskRunId: run.taskRunId,
        });
      }
      if (run.assistantMessage.content.trim() && run.status === "complete") {
        entries.push({
          role: "assistant",
          content: run.assistantMessage.content.trim(),
          createdAt: run.assistantMessage.createdAt,
          taskRunId: run.taskRunId,
        });
      }
      return entries;
    })
    .slice(-24);
}

function humanizeStartFailure(message: string) {
  if (/MODEL_NOT_CONFIGURED|缺少模型|API Key|密钥/i.test(message)) return `Hermes 模型配置还没准备好：${message}`;
  if (/WORKSPACE_LOCKED|占用/i.test(message)) return "当前工作区正在被 Hermes 使用。请等待任务完成，或先停止当前任务。";
  if (/SNAPSHOT_FAILED|快照/i.test(message)) return `Hermes 建立安全快照失败：${message}`;
  return message;
}

function isTerminalTaskStatus(status?: TaskRunStatus) {
  return status === "complete" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function fixTargetForFailure(message: string, action?: string): FixTarget {
  if (action === "configure_model") return "model";
  if (action === "configure_hermes" || action === "open_settings") return "hermes";
  if (/模型|密钥|API Key|auth|model/i.test(message)) return "model";
  if (/Hermes 路径|Hermes 根路径|权限|控制台|Python|CLI|NoConsoleScreenBuffer/i.test(message)) return "hermes";
  if (/诊断|退出码|unknown|未知/i.test(message)) return "diagnostics";
  return "health";
}

function readRecentWorkspaces(): RecentWorkspace[] {
  try {
    const raw = localStorage.getItem(RECENT_WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentWorkspace[];
    return Array.isArray(parsed) ? parsed.filter((item) => item.path && item.name) : [];
  } catch {
    return [];
  }
}

function writeRecentWorkspaces(workspaces: RecentWorkspace[]) {
  localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(workspaces.slice(0, 12)));
}

try {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    console.error("Root element not found");
    throw new Error("Root element not found");
  }
  createRoot(rootElement).render(<App />);
} catch (error) {
  console.error("Failed to render app:", error);
  const rootElement = document.getElementById("root");
  if (rootElement) {
    rootElement.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background: #f5f7f8; padding: 20px;">
        <div style="background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); max-width: 500px;">
          <h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin-bottom: 16px;">应用启动失败</h1>
          <p style="font-size: 14px; color: #6b7280; margin-bottom: 24px;">
            抱歉，应用启动时遇到了错误。请尝试重新启动应用。
          </p>
          <pre style="background: #f3f4f6; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #374151; max-height: 200px; overflow-y: auto;">
${error instanceof Error ? error.message : String(error)}
          </pre>
          <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">
            如果问题持续存在，请检查控制台获取更多详细信息。
          </p>
        </div>
      </div>
    `;
  }
}
