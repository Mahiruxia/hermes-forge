import { app, BrowserWindow, dialog, shell } from "electron";
import path from "node:path";
import { IpcChannels } from "../shared/ipc";
import { AppPaths } from "./app-paths";
import { AutoHotkeyService } from "./autohotkey-service";
import { ensureOfficialHermesHomeLink, resolveActiveHermesHome } from "./hermes-home";
import { registerIpcHandlers } from "./ipc";
import { RuntimeConfigStore } from "./runtime-config";
import { RuntimeEnvResolver } from "./runtime-env-resolver";
import { SessionLog } from "./session-log";
import { ApprovalService } from "./approval-service";
import { EngineInteractionService } from "./engine-interaction-service";
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
import { HermesCoreBridgeService } from "./hermes-core-bridge-service";
import { testModelConnection } from "./model-connection-service";
import { ModelRuntimeProxyService } from "./model-runtime-proxy";
import { MemoryBudgeter } from "../memory/memory-budgeter";
import { SnapshotManager } from "../process/snapshot-manager";
import { TaskPreflightService } from "../process/task-preflight-service";
import { TaskRunner } from "../process/task-runner";
import { WorkspaceLock } from "../process/workspace-lock";
import { EngineProbeService } from "../probes/engine-probe-service";
import { SetupService } from "../setup/setup-service";
import { HermesCompatibilityService } from "../setup/hermes-compatibility-service";
import { ClientAutoUpdateService } from "../updater/client-auto-update-service";
import { UpdateService } from "../updater/update-service";
import { killActiveCommands, runCommand } from "../process/command-runner";
import { resolveEnginePermissions } from "../shared/types";
import { NativeRuntimeAdapter } from "../runtime/native-runtime-adapter";
import { RuntimeProbeService } from "../runtime/runtime-probe-service";
import { RuntimeResolver as HermesRuntimeResolver } from "../runtime/runtime-resolver";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import { ShutdownPipeline } from "../runtime/runtime-diagnostics";
import { InstallOrchestrator } from "../install/install-orchestrator";
import { NativeInstallStrategy } from "../install/native-install-strategy";
import { OneClickDiagnosticsOrchestrator } from "./diagnostics/one-click-diagnostics-orchestrator";
import { LegacyWslMigrationService } from "./legacy-wsl-migration-service";
import { isSafeExternalUrl, isTrustedAppUrl as isTrustedNavigationUrl } from "./navigation-security";
import { PackagedSmokeTest } from "./packaged-smoke-test";
import { nativeToolEnvironment } from "../runtime/native-tool-environment";

const isSmokeTestMode = process.argv.includes("--smoke-test");
const smokeTest = isSmokeTestMode ? new PackagedSmokeTest() : undefined;
if (!isSmokeTestMode) loadDevelopmentEnv();

const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR;
const isPortable = Boolean(portableRoot);
const isDevMode = !isSmokeTestMode && Boolean(process.env.VITE_DEV_SERVER_URL);
const isSystemAuditMode = process.argv.includes("--system-audit") || process.env.HERMES_FORGE_SYSTEM_AUDIT === "1";

let mainWindow: BrowserWindow | undefined;
let shutdownStarted = false;

app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

app.whenReady().then(async () => {
  const singleInstanceLock = isSmokeTestMode || isSystemAuditMode || app.requestSingleInstanceLock();
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

  const userDataPath = smokeTest?.userDataPath ?? (portableRoot ? path.join(portableRoot, "user-data") : app.getPath("userData"));
  app.setName("Hermes Forge");
  app.setPath("userData", userDataPath);
  
  const appPaths = new AppPaths(userDataPath);
  await appPaths.ensureBaseLayout();

  const configStore = new RuntimeConfigStore(appPaths.runtimeConfigPath());
  if (smokeTest) {
    await configStore.write({
      defaultModelProfileId: "smoke-local",
      modelProfiles: [{ id: "smoke-local", provider: "local", model: "offline-smoke", temperature: 0, maxTokens: 1 }],
      providerProfiles: [],
      updateSources: {},
      enginePaths: { hermes: path.join(userDataPath, "uninstalled-runtime") },
      startupWarmupMode: "off",
      startupGatewayAutoStart: false,
      extensionSettings: { connectorsEnabled: false, cronEnabled: false, desktopAutomationEnabled: false },
      hermesRuntime: { mode: process.platform === "darwin" ? "darwin" : "windows", pythonCommand: "__offline_smoke_no_python__", windowsAgentMode: "hermes_native", cliPermissionMode: "guarded", workerMode: "off" },
    });
  }
  const resolveHermesRoot = async () => {
    return configStore.getEnginePath("hermes");
  };
  if (!smokeTest) {
    const toolEnv = nativeToolEnvironment(await resolveHermesRoot());
    process.env.PATH = toolEnv.PATH;
    if (toolEnv.HERMES_GIT_BASH_PATH) process.env.HERMES_GIT_BASH_PATH = toolEnv.HERMES_GIT_BASH_PATH;
  }
  const hermesRuntimeResolver = new HermesRuntimeResolver(appPaths, resolveHermesRoot);
  const approvalService = new ApprovalService(appPaths);
  const engineInteractionService = new EngineInteractionService(approvalService);
  const budgeter = new MemoryBudgeter();
  const autoHotkeyService = new AutoHotkeyService();
  const runtimeProbeService = new RuntimeProbeService(configStore, hermesRuntimeResolver, undefined, fetch);
  const runtimeAdapterFactory: RuntimeAdapterFactory = (runtime) => {
    const mode = process.platform === "darwin" ? "darwin" : "windows";
    return new NativeRuntimeAdapter({ ...runtime, mode, distro: undefined, workerMode: "off" }, hermesRuntimeResolver, runtimeProbeService);
  };
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
  const hermesCoreBridgeService = new HermesCoreBridgeService(appPaths, resolveHermesRoot);
  const workSessionService = new WorkSessionService(appPaths, hermesCoreBridgeService);
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
  const hermesModelSyncService = new HermesModelSyncService(runtimeEnvResolver, () => appPaths.hermesDir());
  // Startup must stay lightweight: model/bridge synchronization can touch Hermes
  // files or local bridge processes, so it is deferred to explicit UI actions
  // and config-save paths.
  const hermesSystemAuditService = new HermesSystemAuditService(
    appPaths,
    hermes,
    runtimeEnvResolver,
    () => configStore.read(),
  );
  const engineProbeService = new EngineProbeService(appPaths, hermes, configStore, runtimeProbeService);
  const nativeInstallStrategy = new NativeInstallStrategy(appPaths, hermes, configStore, runtimeProbeService, runtimeAdapterFactory);
  const installOrchestrator = new InstallOrchestrator(configStore, nativeInstallStrategy);
  const hermesCompatibilityService = new HermesCompatibilityService(configStore, () => resolveActiveHermesHome(appPaths.hermesDir()));
  const setupService = new SetupService(appPaths, hermes, configStore, secretVault, runtimeProbeService, runtimeAdapterFactory, installOrchestrator, hermesCompatibilityService);
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
    async () => buildPermissionOverview({
      config: await configStore.read(),
      bridge: { running: false, capabilities: [] },
      appPaths,
      resolveHermesRoot,
      runtimeAdapterFactory,
    }),
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
    async () => hermesModelSyncService.syncRuntimeConfig(await configStore.read()),
  );
  const legacyWslMigrationService = new LegacyWslMigrationService(appPaths, configStore, secretVault, hermesConnectorService);
  const preflightService = new TaskPreflightService(
    appPaths,
    workspaceLock,
    hermes,
    configStore,
    secretVault,
    runtimeAdapterFactory,
  );

  if (isSystemAuditMode && !smokeTest) {
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
    app.exit(result.ok ? 0 : 1);
    return;
  }

  // System audit mode must not mutate the user's official Hermes home.
  // Link it only during a normal interactive app launch.
  if (!smokeTest) ensureOfficialHermesHomeLink(appPaths.hermesDir()).then((result) => {
    if (!result.linked && result.reason) {
      console.warn("[Hermes Forge] Official Hermes home was left untouched:", result.reason);
    }
  }).catch((error) => {
    console.warn("[Hermes Forge] Failed to link official Hermes home:", error);
  });

  function createWindow() {
    mainWindow = new BrowserWindow({
      show: !isSmokeTestMode,
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
        ...(isSmokeTestMode ? { backgroundThrottling: false, partition: `smoke-${Date.now()}` } : {}),
      },
    });

    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === "media" && isTrustedAppUrl(webContents.getURL())) {
        callback(true);
        return;
      }
      callback(false);
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (openExternalUrl(url)) {
        return { action: "deny" };
      }
      console.warn("[Hermes Forge] Blocked untrusted window open:", url);
      return { action: "deny" };
    });

    const guardMainFrameNavigation = (event: Electron.Event, url: string) => {
      if (isTrustedAppUrl(url)) return;
      event.preventDefault();
      if (!openExternalUrl(url)) {
        console.warn("[Hermes Forge] Blocked untrusted main-frame navigation:", url);
      }
    };
    mainWindow.webContents.on("will-navigate", guardMainFrameNavigation);
    mainWindow.webContents.on("will-redirect", guardMainFrameNavigation);

    if (isDevMode) {
      mainWindow.webContents.openDevTools();
    }

    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  }

  async function loadWindow() {
    if (!mainWindow || smokeTest) return;
    const devServerUrl = isDevMode ? process.env.VITE_DEV_SERVER_URL : undefined;
    if (devServerUrl) await mainWindow.loadURL(devServerUrl);
    else await mainWindow.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
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
    workSessionService,
    engineInteractionService.handle,
  );
  const activeOneClickDiagnosticsOrchestrator = new OneClickDiagnosticsOrchestrator(
    configStore,
    setupService,
    runtimeProbeService,
    hermesConnectorService,
    hermesModelSyncService,
    hermesSystemAuditService,
    diagnosticsService,
    workspaceLock,
    taskRunner,
    hermesCompatibilityService,
    (config) => testModelConnection({
      config,
      secretVault,
      runtimeAdapterFactory,
      resolveHermesRoot,
    }),
    () => resolveActiveHermesHome(appPaths.hermesDir()),
    () => appPaths.hermesDir(),
  );

  registerIpcHandlers(() => mainWindow, {
    appPaths,
    taskRunner,
    snapshotManager,
    fileTreeService,
    workspaceLock,
    sessionLog,
    sessionAgentInsightService,
    workSessionService,
    hermesCoreBridgeService,
    hermes,
    updateService,
    clientAutoUpdateService,
    engineProbeService,
    configStore,
    runtimeEnvResolver,
    secretVault,
    setupService,
    preflightService,
    diagnosticsService,
    hermesWebUiService,
    hermesConnectorService,
    hermesModelSyncService,
    hermesSystemAuditService,
    approvalService,
    engineInteractionService,
    runtimeAdapterFactory,
    legacyWslMigrationService,
    oneClickDiagnosticsOrchestrator: activeOneClickDiagnosticsOrchestrator,
    clientInfo: () => ({
      appVersion: app.getVersion(),
      userDataPath,
      portable: isPortable,
      rendererMode: isDevMode ? "dev" : "built",
    }),
  });

  // The renderer invokes IPC immediately on mount. Register every handler first.
  await loadWindow();

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
        const config = await configStore.read();
        if (!config.startupGatewayAutoStart) {
          return;
        }
        await hermesConnectorService.autoStartIfConfigured();
      } catch (error) {
        console.warn("[Hermes Forge] Gateway auto-start failed:", error);
      }
    })();
  }, 3000);


  if (smokeTest) {
    await smokeTest.run(mainWindow);
    return;
  }

  clientAutoUpdateService.scheduleStartupCheck(30000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      void loadWindow().catch((error) => {
        console.error("[Hermes Forge] Window reload failed:", error);
        dialog.showErrorBox("界面加载失败", "请重新启动 Hermes Forge。如问题持续，请重新安装客户端；本机配置和会话保留在用户数据目录中。");
      });
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
      { id: "hermes-stop", timeoutMs: 10000, run: () => hermes.stop("app-shutdown") },
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
}).catch((error) => {
  if (smokeTest) {
    smokeTest.fail(error);
    return;
  }
  console.error("[Hermes Forge] Startup failed:", error);
  dialog.showErrorBox("Hermes Forge 启动失败", "无法完成本机数据初始化或加载界面。请检查用户数据目录的写入权限和可用磁盘空间后重试。");
  app.exit(1);
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
  return isTrustedNavigationUrl(value, {
    builtEntryPath: path.join(__dirname, "..", "..", "renderer", "index.html"),
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
  });
}

function loadDevelopmentEnv() {
  if (app.isPackaged) return;
  try {
    process.loadEnvFile(path.join(process.cwd(), ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[Hermes Forge] Failed to load development .env:", error);
    }
  }
}

function openExternalUrl(value: string) {
  if (!isSafeExternalUrl(value)) return false;
  shell.openExternal(value).catch((error) => {
    console.warn("[Hermes Forge] Failed to open external URL:", error);
  });
  return true;
}
