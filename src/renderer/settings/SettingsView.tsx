import { lazy, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { HermesInstallEvent, HermesPermissionPolicyMode, HermesRuntimeConfig, OneClickDiagnosticItem, OneClickDiagnosticsReport, HermesWindowsBridgeTestResult, RuntimeConfig, SetupCheck, SetupDependencyRepairId, SetupSummary, WindowsAgentMode, WindowsBridgeStatus } from "../../shared/types";
import { useAppStore } from "../store";
import { usePermissionOverview } from "../hooks/usePermissionOverview";
import { InstallSourceDialog, type InstallSourceChoice } from "../dashboard/components/InstallSourceDialog";
import { ConfigCenterLayout, type ConfigSectionId } from "../dashboard/components/settings/ConfigCenterLayout";
const ModelConfigWizard = lazy(() => import("../dashboard/components/panels/ModelConfigWizard").then(module => ({ default: module.ModelConfigWizard })));
const HermesSettingsPanel = lazy(() => import("../dashboard/components/panels/SettingsPanel").then(module => ({ default: module.SettingsPanel })));
const ExtensionsPanel = lazy(() => import("./ExtensionsPanel").then(module => ({ default: module.ExtensionsPanel })));
const ProfilesPanel = lazy(() => import("../dashboard/components/panels/ProfilesPanel").then(module => ({ default: module.ProfilesPanel })));
export type ConfigOverview = {
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

type StatusMetricTone = "ok" | "warning" | "danger" | "neutral";

function defaultHermesRuntime(): HermesRuntimeConfig {
  return {
    mode: "windows",
    pythonCommand: "python",
    windowsAgentMode: "hermes_native",
    cliPermissionMode: "guarded",
    permissionPolicy: "bridge_guarded",
    workerMode: "off",
    installSource: {
      repoUrl: "https://github.com/NousResearch/hermes-agent.git",
      branch: "main",
      sourceLabel: "official",
    },
  };
}

export function SettingsView(props: {
  overview?: ConfigOverview;
  initialSection?: ConfigSectionId;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onClearSession: () => void;
  onOpenSessionFolder: () => void;
}) {
  const overview = props.overview;
  const store = useAppStore(useShallow(state => ({
    setRuntimeConfig: state.setRuntimeConfig,
  })));
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
  const [installSourceDialogOpen, setInstallSourceDialogOpen] = useState(false);
  const [pendingInstallActionId, setPendingInstallActionId] = useState<string | undefined>();
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
      if (event.stage === "completed" || event.stage === "failed" || event.stage === "cancelled") {
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

  async function refreshAfterMaintenanceAttempt() {
    try {
      await props.onRefresh();
    } catch (error) {
      console.warn("Failed to refresh setup state after maintenance:", error);
    }
  }

  async function installHermesFromSettings(kind: InstallSourceChoice) {
    if (setupActionRunning) return;
    const actionId = pendingInstallActionId ?? "hermes";
    setInstallSourceDialogOpen(false);
    setSetupActionRunning(actionId);
    setInstallEvent(undefined);
    try {
      const saved = await window.workbenchClient.updateHermesConfig({ rootPath, runtime });
      store.setRuntimeConfig(saved);
      const result = await window.workbenchClient.installHermes({
        ...(rootPath.trim() ? { rootPath: rootPath.trim() } : {}),
        source: { kind },
      });
      if (result.rootPath) setRootPath(result.rootPath);
      await props.onRefresh();
      showSaveNotice(result.message);
    } catch (error) {
      showSaveNotice(error instanceof Error ? error.message : "Hermes 自动安装失败");
      await refreshAfterMaintenanceAttempt();
    } finally {
      setSetupActionRunning(undefined);
      setPendingInstallActionId(undefined);
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
      await refreshAfterMaintenanceAttempt();
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
        await refreshAfterMaintenanceAttempt();
      } finally {
        setRepairingDependency(undefined);
      }
      return;
    }

    if (check.fixAction === "install_hermes") {
      setPendingInstallActionId(check.id);
      setInstallSourceDialogOpen(true);
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
        await refreshAfterMaintenanceAttempt();
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

  const diagnosticsOverallMetric = diagnosticOverallStatus(oneClickDiagnostics, overview?.health);
  const diagnosticsIssueMetric = diagnosticIssueStatus(oneClickDiagnostics, overview?.health);
  const diagnosticsResolvedMetric = diagnosticResolvedStatus(oneClickDiagnostics, overview?.health);

  return (
    <ConfigCenterLayout
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      onBack={props.onBack}
      saveNotice={saveNotice}
      title="设置中心"
      description="这里只放最关键、最常用，而且能直接影响是否能正常工作的设置。"
    >
      <InstallSourceDialog
        busy={Boolean(setupActionRunning)}
        onClose={() => {
          setInstallSourceDialogOpen(false);
          setPendingInstallActionId(undefined);
        }}
        onSelect={(kind) => void installHermesFromSettings(kind)}
        open={installSourceDialogOpen}
      />
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
            onStartChat={props.onBack}
          />
        </section>
      ) : null}

      {activeSection === "integrations" ? <ExtensionsPanel onRefresh={props.onRefresh} onOpenEnvironment={() => setActiveSection("general")} /> : null}
      {activeSection === "advanced" ? <ProfilesPanel /> : null}

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
            <StatusMetric label="整体状态" value={diagnosticsOverallMetric.value} tone={diagnosticsOverallMetric.tone} />
            <StatusMetric label="失败 / 警告" value={diagnosticsIssueMetric.value} tone={diagnosticsIssueMetric.tone} />
            <StatusMetric label="已修复 / 未解决" value={diagnosticsResolvedMetric.value} tone={diagnosticsResolvedMetric.tone} />
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

function StatusMetric(props: { label: string; value: string; tone: StatusMetricTone }) {
  const toneClass =
    props.tone === "ok"
      ? "border-emerald-100 bg-emerald-50 text-emerald-700"
      : props.tone === "warning"
        ? "border-amber-100/90 bg-amber-50/70 text-amber-700"
        : props.tone === "danger"
          ? "border-rose-100/80 bg-rose-50/50 text-rose-700"
          : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <div className={`rounded-xl border px-3 py-2 ${toneClass}`}>
      <p className="text-[11px] font-medium opacity-75">{props.label}</p>
      <p className="mt-0.5 truncate text-base font-semibold">{props.value}</p>
    </div>
  );
}

function diagnosticOverallStatus(report: OneClickDiagnosticsReport | undefined, health: SetupSummary | undefined): { value: string; tone: StatusMetricTone } {
  if (report) {
    if (report.summary.failed > 0) return { value: "需关注", tone: "danger" };
    if (report.summary.warnings > 0 || report.summary.unresolved > 0) return { value: "有提醒", tone: "warning" };
    return { value: "通过", tone: "ok" };
  }
  const blockingCount = health?.blocking.length ?? 0;
  const warningCount = setupWarningCount(health);
  if (!health) return { value: "待读取", tone: "neutral" };
  if (health.ready) return { value: "就绪", tone: "ok" };
  if (blockingCount > 0) return { value: "需关注", tone: "warning" };
  if (warningCount > 0) return { value: "有提醒", tone: "warning" };
  return { value: "待检查", tone: "neutral" };
}

function diagnosticIssueStatus(report: OneClickDiagnosticsReport | undefined, health: SetupSummary | undefined): { value: string; tone: StatusMetricTone } {
  if (report) {
    const failed = report.summary.failed;
    const warnings = report.summary.warnings;
    return {
      value: `${failed} / ${warnings}`,
      tone: failed > 0 ? "danger" : warnings > 0 ? "warning" : "neutral",
    };
  }
  const blockingCount = health?.blocking.length ?? 0;
  const warningCount = setupWarningCount(health);
  return {
    value: `${blockingCount} / ${warningCount}`,
    tone: blockingCount > 0 || warningCount > 0 ? "warning" : "neutral",
  };
}

function diagnosticResolvedStatus(report: OneClickDiagnosticsReport | undefined, health: SetupSummary | undefined): { value: string; tone: StatusMetricTone } {
  if (report) {
    const fixed = report.summary.fixed;
    const unresolved = report.summary.unresolved;
    return {
      value: `${fixed} / ${unresolved}`,
      tone: unresolved > 0 ? "warning" : fixed > 0 ? "ok" : "neutral",
    };
  }
  return {
    value: `0 / ${health?.blocking.length ?? 0}`,
    tone: (health?.blocking.length ?? 0) > 0 ? "warning" : "neutral",
  };
}

function setupWarningCount(health: SetupSummary | undefined) {
  return health?.checks.filter((check) => check.status === "warning").length ?? 0;
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

function DiagnosticDetails(props: { details: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
      >
        {open ? "收起详情" : "查看详情（供技术支持使用）"}
      </button>
      {open ? (
        <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950/90 p-2 text-[11px] leading-4 text-slate-100">
          {props.details}
        </pre>
      ) : null}
    </div>
  );
}

function OneClickDiagnosticsResultView(props: { report: OneClickDiagnosticsReport }) {
  return (
    <SettingsPanelCard title="一键诊断结果">
      <div className="space-y-2 text-[12px] text-slate-600">
        <div className={`rounded-lg border px-3 py-2 ${props.report.summary.failed ? "border-rose-100/80 bg-rose-50/45 text-rose-700" : props.report.summary.warnings ? "border-amber-100/90 bg-amber-50/70 text-amber-800" : "border-emerald-100 bg-emerald-50 text-emerald-800"}`}>
          <p className="font-semibold">
            {props.report.summary.failed ? "诊断完成，有项目需要关注。" : props.report.summary.warnings ? "诊断完成，有需要留意的提醒。" : "诊断通过。"}
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
                <DiagnosticDetails details={diagnostic.details} />
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
  if (check.autoFixId === "feishu_lark_oapi") return "修复飞书依赖";
  if (check.autoFixId === "telegram_bot") return "修复 Telegram 依赖";
  if (check.autoFixId === "discord_py") return "修复 Discord 依赖";
  if (check.autoFixId === "slack_bolt") return "修复 Slack 依赖";
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
