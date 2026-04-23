import { app, BrowserWindow } from "electron";
import path from "node:path";
import { AppPaths } from "./app-paths";
import { AutoHotkeyService } from "./autohotkey-service";
import { registerIpcHandlers } from "./ipc";
import { RuntimeConfigStore } from "./runtime-config";
import { RuntimeEnvResolver } from "./runtime-env-resolver";
import { SessionLog } from "./session-log";
import { ApprovalService } from "./approval-service";
import { HermesWindowsBridgeTestService } from "./hermes-windows-bridge-test-service";
import { HermesSystemAuditService } from "./hermes-system-audit-service";
import { SessionAgentInsightService } from "./session-agent-insight-service";
import { WindowsControlBridge } from "./windows-control-bridge";
import { WindowsToolExecutor } from "./windows-tool-executor";
import { WorkSessionService } from "./work-session-service";
import { HermesCliAdapter } from "../adapters/hermes/hermes-cli-adapter";
import { SecretVault } from "../auth/secret-vault";
import { DiagnosticsService } from "../diagnostics/diagnostics-service";
import { FileTreeService } from "../file-manager/file-tree-service";
import { HermesConnectorService } from "./hermes-connector-service";
import { HermesModelSyncService } from "./hermes-model-sync";
import { syncHermesWindowsMcpConfig } from "./hermes-native-mcp-config";
import { HermesWebUiService } from "./hermes-webui-service";
import { ModelRuntimeProxyService } from "./model-runtime-proxy";
import { MemoryBudgeter } from "../memory/memory-budgeter";
import { MemoryBroker } from "../memory/memory-broker";
import { SnapshotManager } from "../process/snapshot-manager";
import { HermesToolLoopRunner } from "../process/hermes-tool-loop-runner";
import { TaskPreflightService } from "../process/task-preflight-service";
import { TaskRunner } from "../process/task-runner";
import { WorkspaceLock } from "../process/workspace-lock";
import { EngineProbeService } from "../probes/engine-probe-service";
import { SetupService } from "../setup/setup-service";
import { ClientAutoUpdateService } from "../updater/client-auto-update-service";
import { UpdateService } from "../updater/update-service";
import { killActiveCommands, runCommand } from "../process/command-runner";
import { resolveEnginePermissions } from "../shared/types";

const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR;
const isPortable = Boolean(portableRoot);
const isDevMode = Boolean(process.env.VITE_DEV_SERVER_URL);
const isSystemAuditMode = process.argv.includes("--system-audit") || process.env.HERMES_FORGE_SYSTEM_AUDIT === "1";

let mainWindow: BrowserWindow | undefined;
let windowsControlBridge: WindowsControlBridge | undefined;

async function resolveWindowsHostForWsl(distro?: string) {
  const args = [
    ...(distro?.trim() ? ["-d", distro.trim()] : []),
    "ip",
    "route",
    "show",
    "default",
  ];
  const result = await runCommand("wsl.exe", args, {
    cwd: process.cwd(),
    timeoutMs: 5000,
  }).catch(() => undefined);
  const host = parseWslHost(result?.stdout ?? "");
  return host || "127.0.0.1";
}

async function syncWindowsBridgeConfig(input: {
  appPaths: AppPaths;
  configStore: RuntimeConfigStore;
  bridge?: WindowsControlBridge;
}) {
  const config = await input.configStore.read();
  const runtime = {
    mode: config.hermesRuntime?.mode ?? "windows",
    distro: config.hermesRuntime?.distro?.trim() || undefined,
    pythonCommand: config.hermesRuntime?.pythonCommand?.trim() || "python3",
    windowsAgentMode: config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
  };
  const permissions = resolveEnginePermissions(config, "hermes");
  const bridge = permissions.enabled && permissions.contextBridge && runtime.windowsAgentMode !== "disabled"
    ? input.bridge
    : undefined;
  if (bridge) {
    await bridge.start();
  }
  const host = runtime.mode === "wsl" ? await resolveWindowsHostForWsl(runtime.distro) : "127.0.0.1";
  return syncHermesWindowsMcpConfig({
    runtime,
    hermesHome: input.appPaths.hermesDir(),
    bridge: bridge?.accessForHost(host),
  });
}

function parseWslHost(stdout: string) {
  const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.includes(" via ")) ?? stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const match = first.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return match?.[0];
}

function scheduleStartupWarmup(input: {
  hermes: HermesCliAdapter;
  configStore: RuntimeConfigStore;
  runtimeEnvResolver: RuntimeEnvResolver;
}) {
  setTimeout(() => {
    void runStartupWarmup(input);
  }, 1200);
}

async function runStartupWarmup(input: {
  hermes: HermesCliAdapter;
  configStore: RuntimeConfigStore;
  runtimeEnvResolver: RuntimeEnvResolver;
}) {
  const config = await input.configStore.read().catch(() => undefined);
  const mode = config?.startupWarmupMode ?? "cheap";
  if (mode === "off") return;

  await input.hermes.healthCheck().catch(() => undefined);
  if (mode === "real_probe") {
    await input.runtimeEnvResolver.resolve(config?.defaultModelProfileId).catch(() => undefined);
  }
}

function scheduleStartupGateway(input: {
  hermesConnectorService: HermesConnectorService;
}) {
  setTimeout(() => {
    void runStartupGateway(input);
  }, 1800);
}

async function runStartupGateway(input: {
  hermesConnectorService: HermesConnectorService;
}) {
  try {
    await input.hermesConnectorService.autoStartIfConfigured();
  } catch (error) {
    console.warn("[Hermes Forge] Gateway auto-start crashed:", error);
  }
}

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
  const approvalService = new ApprovalService(appPaths);
  const budgeter = new MemoryBudgeter();
  const autoHotkeyService = new AutoHotkeyService();
  const windowsToolExecutor = new WindowsToolExecutor(
    async () => resolveEnginePermissions(await configStore.read(), "hermes"),
    autoHotkeyService,
    runCommand,
    async (input) => approvalService.request({
      taskRunId: input.taskRunId,
      title: input.title,
      command: input.command,
      path: input.path,
      patternKey: input.patternKey,
      actionKind: input.actionKind,
      details: input.details,
      risk: input.risk,
    }, input.publish),
  );
  windowsControlBridge = new WindowsControlBridge(
    async () => resolveEnginePermissions(await configStore.read(), "hermes"),
    () => app.getVersion(),
    windowsToolExecutor,
  );
  await windowsControlBridge.start();
  const hermesWindowsBridgeTestService = new HermesWindowsBridgeTestService(
    windowsControlBridge,
    () => configStore.read(),
    fetch,
    runCommand,
    windowsToolExecutor,
  );
  const hermes = new HermesCliAdapter(
    appPaths,
    budgeter,
    () => configStore.getEnginePath("hermes"),
    () => configStore.read(),
    async (distro?: string) => {
      const config = await configStore.read();
      const permissions = resolveEnginePermissions(config, "hermes");
      if (!permissions.contextBridge || !permissions.enabled) {
        return undefined;
      }
      await windowsControlBridge?.start();
      const host = config.hermesRuntime?.mode === "wsl"
        ? await resolveWindowsHostForWsl(distro)
        : "127.0.0.1";
      return windowsControlBridge?.accessForHost(host);
    },
  );
  const memoryBroker = new MemoryBroker(budgeter);
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
  const hermesModelSyncService = new HermesModelSyncService(runtimeEnvResolver, () => appPaths.hermesDir());
  await hermesModelSyncService.syncRuntimeConfig(await configStore.read()).catch((error) => {
    console.warn("[Hermes Forge] Model sync during startup failed:", error);
  });
  await syncWindowsBridgeConfig({ appPaths, configStore, bridge: windowsControlBridge }).catch((error) => {
    console.warn("[Hermes Forge] Windows bridge sync during startup failed:", error);
  });
  const hermesSystemAuditService = new HermesSystemAuditService(
    appPaths,
    hermes,
    runtimeEnvResolver,
    () => configStore.read(),
  );
  const engineProbeService = new EngineProbeService(appPaths, hermes, configStore);
  const setupService = new SetupService(appPaths, hermes, configStore, secretVault);
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
  );
  const hermesWebUiService = new HermesWebUiService(appPaths, () => configStore.getEnginePath("hermes"));
  const hermesConnectorService = new HermesConnectorService(
    appPaths,
    secretVault,
    () => configStore.getEnginePath("hermes"),
    async () => (await configStore.read()).hermesRuntime?.pythonCommand,
  );
  const hermesToolLoopRunner = new HermesToolLoopRunner(hermes, windowsToolExecutor);
  const preflightService = new TaskPreflightService(
    appPaths,
    workspaceLock,
    hermes,
    configStore,
    secretVault,
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
    await windowsControlBridge?.stop();
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
        sandbox: false,
      },
    });

    mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === "media") {
        callback(true);
      } else {
        callback(false);
      }
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

  const taskRunner = new TaskRunner(
    appPaths,
    memoryBroker,
    workspaceLock,
    snapshotManager,
    preflightService,
    runtimeEnvResolver,
    hermes,
    sessionLog,
    sessionAgentInsightService,
    () => mainWindow,
    hermesToolLoopRunner,
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
    windowsControlBridge,
    hermesWindowsBridgeTestService,
    hermesSystemAuditService,
    approvalService,
    clientInfo: () => ({
      appVersion: app.getVersion(),
      userDataPath,
      portable: isPortable,
      rendererMode: isDevMode ? "dev" : "built",
    }),
  });

  scheduleStartupWarmup({ hermes, configStore, runtimeEnvResolver });
  scheduleStartupGateway({ hermesConnectorService });
  clientAutoUpdateService.scheduleStartupCheck(5000);

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

  app.on("before-quit", () => {
    killActiveCommands();
    void hermes.stop("app-shutdown");
    void windowsControlBridge?.stop();
    void hermesConnectorService.shutdown();
    void modelRuntimeProxyService.shutdown();
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
