import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { IpcChannels } from "../shared/ipc";
import { AppPaths } from "./app-paths";
import { AutoHotkeyService } from "./autohotkey-service";
import { registerIpcHandlers } from "./ipc";
import { RuntimeConfigStore } from "./runtime-config";
import { RuntimeEnvResolver } from "./runtime-env-resolver";
import { SessionLog } from "./session-log";
import { ApprovalService } from "./approval-service";
import { HermesSystemAuditService } from "./hermes-system-audit-service";
import { SessionAgentInsightService } from "./session-agent-insight-service";
import { WorkSessionService } from "./work-session-service";
import { HermesCliAdapter } from "../adapters/hermes/hermes-cli-adapter";
import { SecretVault } from "../auth/secret-vault";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { buildPermissionOverview } from "./permission-overview-service";
import { FileTreeService } from "../file-manager/file-tree-service";
import { HermesConnectorService } from "./hermes-connector-service";
import { HermesModelSyncService } from "./hermes-model-sync";
import { HermesWebUiService } from "./hermes-webui-service";
import { testModelConnection } from "./model-connection-service";
import { ModelRuntimeProxyService } from "./model-runtime-proxy";
import { MemoryBudgeter } from "../memory/memory-budgeter";
import { SnapshotManager } from "../process/snapshot-manager";
import { TaskPreflightService } from "../process/task-preflight-service";
import { TaskRunner } from "../process/task-runner";
import { WorkspaceLock } from "../process/workspace-lock";
import { EngineProbeService } from "../probes/engine-probe-service";
import { SetupService } from "../setup/setup-service";
import { ClientAutoUpdateService } from "../updater/client-auto-update-service";
import { UpdateService } from "../updater/update-service";
import { killActiveCommands, runCommand } from "../process/command-runner";
import { resolveEnginePermissions } from "../shared/types";
import { NativeRuntimeAdapter } from "../runtime/native-runtime-adapter";
import { RuntimeProbeService } from "../runtime/runtime-probe-service";
import { RuntimeResolver as HermesRuntimeResolver } from "../runtime/runtime-resolver";
import { resolveHermesCliForRuntime } from "../runtime/hermes-cli-resolver";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import { ShutdownPipeline } from "../runtime/runtime-diagnostics";
import { WslRuntimeAdapter } from "../runtime/wsl-runtime-adapter";
import { InstallOrchestrator } from "../install/install-orchestrator";
import { ManagedWslInstallStrategy } from "../install/managed-wsl-install-strategy";
import { NativeInstallStrategy } from "../install/native-install-strategy";
import { WslDoctorService } from "../install/wsl-doctor-service";
import { WslDoctorReportService } from "../install/wsl-doctor-report-service";
import { WslDistroService } from "../install/wsl-distro-service";
import { WslHermesInstallService } from "../install/wsl-hermes-install-service";
import { WslRepairService } from "../install/wsl-repair-service";
import { ManagedWslInstallerService } from "../install/managed-wsl-installer-service";
import { OneClickDiagnosticsOrchestrator } from "./diagnostics/one-click-diagnostics-orchestrator";

const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR;
const isPortable = Boolean(portableRoot);
const isDevMode = Boolean(process.env.VITE_DEV_SERVER_URL);
const isSystemAuditMode = process.argv.includes("--system-audit") || process.env.HERMES_FORGE_SYSTEM_AUDIT === "1";

let mainWindow: BrowserWindow | undefined;
let shutdownStarted = false;

app.whenReady().then(async () => {
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  
  const singleInstanceLock = isSystemAuditMode || app.requestSingleInstanceLock();
  if (!singleInstanceLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  const userDataPath = portableRoot ? path.join(portableRoot, "user-data") : app.getPath("userData");
  app.setName("Hermes Forge");
  app.setPath("userData", userDataPath);
  
  const appPaths = new AppPaths(userDataPath);
  await appPaths.ensureBaseLayout();

  const configStore = new RuntimeConfigStore(appPaths.runtimeConfigPath());
  const resolveHermesRoot = async () => {
    const config = await configStore.read();
    const runtime = {
      mode: config.hermesRuntime?.mode ?? "windows",
      distro: config.hermesRuntime?.distro?.trim() || undefined,
      pythonCommand: config.hermesRuntime?.pythonCommand?.trim() || "python3",
      managedRoot: config.hermesRuntime?.managedRoot?.trim() || undefined,
      windowsAgentMode: config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
      cliPermissionMode: config.hermesRuntime?.cliPermissionMode ?? "yolo",
      permissionPolicy: config.hermesRuntime?.permissionPolicy ?? "bridge_guarded",
      workerMode: config.hermesRuntime?.workerMode ?? "off",
      installSource: config.hermesRuntime?.installSource,
    };
    if (runtime.mode === "wsl") {
      return (await resolveHermesCliForRuntime(configStore, runtime)).rootPath;
    }
    return configStore.getEnginePath("hermes");
  };
  const hermesRuntimeResolver = new HermesRuntimeResolver(appPaths, resolveHermesRoot);
  const approvalService = new ApprovalService(appPaths);
  const budgeter = new MemoryBudgeter();
  const autoHotkeyService = new AutoHotkeyService();
  const runtimeProbeService = new RuntimeProbeService(configStore, hermesRuntimeResolver, undefined, fetch);
  const runtimeAdapterFactory: RuntimeAdapterFactory = (runtime) =>
    runtime.mode === "wsl"
      ? new WslRuntimeAdapter(runtime, hermesRuntimeResolver, runtimeProbeService)
      : new NativeRuntimeAdapter(runtime, hermesRuntimeResolver, runtimeProbeService);
  const hermes = new HermesCliAdapter(
    appPaths,
    budgeter,
    resolveHermesRoot,
    () => configStore.read(),
    runtimeAdapterFactory,
    () => hermesModelSyncService,
  );
  const sessionLog = new SessionLog(appPaths);
  const sessionAgentInsightService = new SessionAgentInsightService(appPaths, sessionLog);
  const workSessionService = new WorkSessionService(appPaths);
  await workSessionService.ensureDefault();
  const workspaceLock = new WorkspaceLock();
  const snapshotManager = new SnapshotManager(appPaths);
  const fileTreeService = new FileTreeService();
  const updateService = new UpdateService([hermes]);
  const clientAutoUpdateService = new ClientAutoUpdateService(() => mainWindow);
  const secretVault = new SecretVault(path.join(appPaths.vaultDir(), "secrets.enc"));
  await secretVault.status();
  const modelRuntimeProxyService = new ModelRuntimeProxyService();
  const runtimeEnvResolver = new RuntimeEnvResolver(configStore, secretVault, modelRuntimeProxyService);
  const hermesModelSyncService = new HermesModelSyncService(runtimeEnvResolver, () => appPaths.hermesDir(), runtimeAdapterFactory);
  // Startup must stay lightweight: model/bridge synchronization can touch WSL,
  // Hermes files, or local bridge processes, so it is deferred to explicit UI
  // actions and config-save paths.
  const hermesSystemAuditService = new HermesSystemAuditService(
    appPaths,
    hermes,
    runtimeEnvResolver,
    () => configStore.read(),
  );
  const engineProbeService = new EngineProbeService(appPaths, hermes, configStore, runtimeProbeService);
  const nativeInstallStrategy = new NativeInstallStrategy(appPaths, hermes, configStore, runtimeProbeService, runtimeAdapterFactory);
  const wslDoctorService = new WslDoctorService(configStore, runtimeProbeService, runtimeAdapterFactory);
  const wslRepairService = new WslRepairService(configStore, runtimeProbeService, runtimeAdapterFactory, wslDoctorService);
  const wslDistroService = new WslDistroService(appPaths, configStore, runtimeProbeService, runtimeAdapterFactory, wslDoctorService);
  const wslHermesInstallService = new WslHermesInstallService(appPaths, configStore, runtimeProbeService, runtimeAdapterFactory, wslDoctorService);
  const managedWslInstallerService = new ManagedWslInstallerService(appPaths, wslDoctorService, wslRepairService, wslDistroService, wslHermesInstallService);
  const wslDoctorReportService = new WslDoctorReportService(appPaths, configStore, wslDoctorService, wslRepairService, managedWslInstallerService);
  const managedWslInstallStrategy = new ManagedWslInstallStrategy(managedWslInstallerService);
  const installOrchestrator = new InstallOrchestrator(configStore, nativeInstallStrategy, managedWslInstallStrategy);
  const setupService = new SetupService(appPaths, hermes, configStore, secretVault, runtimeProbeService, runtimeAdapterFactory, installOrchestrator);
  const diagnosticsService = new DiagnosticsService(
    appPaths,
    setupService,
    configStore,
    sessionLog,
    hermes,
    engineProbeService,
    snapshotManager,
    workspaceLock,
    () => ({
      appVersion: app.getVersion(),
      userDataPath,
      portable: isPortable,
      rendererMode: isDevMode ? "dev" : "built",
    }),
    runtimeProbeService,
    wslDoctorReportService,
    async () => buildPermissionOverview({
      config: await configStore.read(),
      bridge: { running: false, capabilities: [] },
      appPaths,
      resolveHermesRoot,
      runtimeAdapterFactory,
    }),
    async () => managedWslInstallerService.getLastInstallReport(),
  );
  const hermesWebUiService = new HermesWebUiService(
    appPaths,
    resolveHermesRoot,
    runtimeAdapterFactory,
    () => configStore.read(),
  );
  const hermesConnectorService = new HermesConnectorService(
    appPaths,
    secretVault,
    resolveHermesRoot,
    async () => (await configStore.read()).hermesRuntime?.pythonCommand,
    runtimeProbeService,
    runtimeAdapterFactory,
    () => configStore.read(),
  );
  const preflightService = new TaskPreflightService(
    appPaths,
    workspaceLock,
    hermes,
    configStore,
    secretVault,
    runtimeAdapterFactory,
  );

  if (isSystemAuditMode) {
    const result = await hermesSystemAuditService.test();
    if (process.env.HERMES_FORGE_SYSTEM_AUDIT_OUTPUT) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(process.env.HERMES_FORGE_SYSTEM_AUDIT_OUTPUT, JSON.stringify(result, null, 2), "utf8");
    }
    console.log("__HERMES_FORGE_SYSTEM_AUDIT_START__");
    console.log(JSON.stringify(result, null, 2));
    console.log("__HERMES_FORGE_SYSTEM_AUDIT_END__");
    await hermes.stop("system-audit");
    await hermesConnectorService.shutdown();
    await modelRuntimeProxyService.shutdown();
    app.quit();
    return;
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 980,
      minHeight: 680,
      title: "Hermes Forge",
      icon: resolveAppIconPath(),
      backgroundColor: "#f5f7f8",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === "media" && isTrustedAppUrl(webContents.getURL())) {
        callback(true);
        return;
      }
      callback(false);
    });

    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      void mainWindow.loadURL(devServerUrl);
    } else {
      void mainWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
    }

    if (isDevMode) {
      mainWindow.webContents.openDevTools();
    }

    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  }

  createWindow();

  if (!mainWindow) {
    throw new Error("主窗口创建失败");
  }

  await configStore.read();
  const recovery = configStore.consumeLastRecovery();
  if (recovery) {
    void dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "配置已自动恢复",
      message: "Hermes Forge 检测到运行时配置损坏，已备份原文件并重置为默认配置。",
      detail: [
        `配置文件：${recovery.configPath}`,
        recovery.backupPath ? `备份文件：${recovery.backupPath}` : "备份文件：创建失败，请查看日志。",
        `原因：${recovery.reason === "invalid_json" ? "JSON 格式无效" : "配置结构校验失败"}`,
      ].join("\n"),
    });
  }

  const taskRunner = new TaskRunner(
    appPaths,
    workspaceLock,
    snapshotManager,
    preflightService,
    runtimeEnvResolver,
    hermes,
    sessionLog,
    sessionAgentInsightService,
    () => mainWindow,
  );
  const activeOneClickDiagnosticsOrchestrator = new OneClickDiagnosticsOrchestrator(
    configStore,
    setupService,
    runtimeProbeService,
    wslDoctorService,
    wslRepairService,
    hermesConnectorService,
    hermesModelSyncService,
    hermesSystemAuditService,
    diagnosticsService,
    workspaceLock,
    taskRunner,
    (config) => testModelConnection({
      config,
      secretVault,
      runtimeAdapterFactory,
      resolveHermesRoot,
    }),
  );

  registerIpcHandlers(mainWindow, {
    appPaths,
    taskRunner,
    snapshotManager,
    fileTreeService,
    workspaceLock,
    sessionLog,
    sessionAgentInsightService,
    workSessionService,
    hermes,
    updateService,
    clientAutoUpdateService,
    engineProbeService,
    configStore,
    runtimeEnvResolver,
    secretVault,
    setupService,
    diagnosticsService,
    hermesWebUiService,
    hermesConnectorService,
    hermesModelSyncService,
    hermesSystemAuditService,
    approvalService,
    runtimeAdapterFactory,
    managedWslInstallerService,
    oneClickDiagnosticsOrchestrator: activeOneClickDiagnosticsOrchestrator,
    clientInfo: () => ({
      appVersion: app.getVersion(),
      userDataPath,
      portable: isPortable,
      rendererMode: isDevMode ? "dev" : "built",
    }),
  });

  const scheduleStartupWarmup = () => {
    setTimeout(() => {
      void (async () => {
        const config = await configStore.read();
        const mode = config.startupWarmupMode ?? "off";
        if (mode === "off" || !hermes.warmup) {
          return;
        }
        const probeKind = mode === "real_probe" ? "real" : "cheap";
        const runtimeEnv = probeKind === "real"
          ? await runtimeEnvResolver.resolve(config.defaultModelProfileId).catch(() => undefined)
          : undefined;
        const result = await hermes.warmup(probeKind, undefined, runtimeEnv);
        console.info("[Hermes Forge] Startup warmup completed:", result);
      })().catch((error) => {
        console.warn("[Hermes Forge] Startup warmup failed:", error);
      });
    }, 4000);
  };

  scheduleStartupWarmup();

  // 启动后尝试自动启动 Gateway（如果已配置连接器）
  setTimeout(() => {
    void (async () => {
      try {
        await hermesConnectorService.autoStartIfConfigured();
      } catch (error) {
        console.warn("[Hermes Forge] Gateway auto-start failed:", error);
      }
    })();
  }, 3000);

  // 启动后延迟检查 Hermes Agent 与 Forge v0.2.0+ 的兼容性（仅 Windows 原生模式）
  setTimeout(() => {
    void (async () => {
      try {
        const check = await setupService.checkHermesAgentCompatibility();
        if (check.status !== "ok" && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannels.hermesAgentCompatibilityWarning, {
            compatible: false,
            message: check.message,
          });
        }
      } catch (error) {
        console.warn("[Hermes Forge] Hermes Agent compatibility check failed:", error);
      }
    })();
  }, 8000);

  clientAutoUpdateService.scheduleStartupCheck(30000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  const shutdownPipeline = new ShutdownPipeline();
  app.on("before-quit", (event) => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    event.preventDefault();
    void shutdownPipeline.run([
      { id: "task-runner-drain", timeoutMs: 5000, run: () => taskRunner.shutdown("app-shutdown") },
      { id: "active-command-kill", timeoutMs: 3000, run: async () => killActiveCommands() },
      { id: "hermes-stop", timeoutMs: 5000, run: () => hermes.stop("app-shutdown") },
      { id: "connector-shutdown", timeoutMs: 8000, run: () => hermesConnectorService.shutdown() },
      { id: "model-runtime-proxy-shutdown", timeoutMs: 5000, run: () => modelRuntimeProxyService.shutdown() },
    ]).then((report) => {
      console.info("[Hermes Forge] Shutdown pipeline completed:", report);
      app.exit(0);
    }).catch((error) => {
      console.warn("[Hermes Forge] Shutdown pipeline crashed:", error);
      app.exit(1);
    });
  });
});

function resolveAppIconPath() {
  const iconName = process.platform === "darwin"
    ? "hermes-workbench.icns"
    : process.platform === "win32"
      ? "hermes-workbench.ico"
      : "hermes-workbench.png";
  return isDevMode
    ? path.join(process.cwd(), "assets", "icons", iconName)
    : path.join(process.resourcesPath, "icons", iconName);
}

function isTrustedAppUrl(value: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return true;
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    return devServerUrl ? url.origin === new URL(devServerUrl).origin : false;
  } catch {
    return false;
  }
}
