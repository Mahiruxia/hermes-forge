import { app, ipcMain, type BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { autoUpdater } from "electron-updater";
import { SqliteMemoryIndex } from "../memory/sqlite-memory-index";
import { IpcChannels } from "../shared/ipc";

type SmokeCheck = { id: string; ok: boolean; message: string };

/** Offline package verification. All state is confined to a fresh temporary directory. */
export class PackagedSmokeTest {
  readonly userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-forge-smoke-"));
  private readonly startedAt = new Date().toISOString();
  private readonly checks: SmokeCheck[] = [];
  private readonly errors: string[] = [];
  private readonly idleMs = Math.max(0, Math.min(600_000, Number(process.env.HERMES_FORGE_SMOKE_TEST_IDLE_MS) || 0));
  private readonly processLaunchAttempts: Array<{ api: string; binary: string }> = [];
  private readonly metrics: Record<string, unknown> = {};
  private readonly ipcCallCounts: Record<string, number> = {};
  private readonly timer: ReturnType<typeof setTimeout>;
  private completed = false;
  private window?: BrowserWindow;

  constructor() {
    app.setPath("userData", this.userDataPath);
    app.setPath("sessionData", this.userDataPath);
    app.commandLine.appendSwitch("disable-background-networking");
    app.commandLine.appendSwitch("disable-component-update");
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) => handle(channel, (event, ...args) => {
      this.ipcCallCounts[channel] = (this.ipcCallCounts[channel] ?? 0) + 1;
      return listener(event, ...args);
    });
    for (const method of ["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"] as const) {
      childProcess[method] = ((binary: unknown) => {
        const label = typeof binary === "string" ? path.basename(binary) : "unknown";
        this.processLaunchAttempts.push({ api: method, binary: label });
        throw new Error(`Offline smoke test blocked child_process.${method}: ${label}`);
      }) as never;
    }
    globalThis.fetch = async () => {
      this.errors.push("Unexpected main-process fetch request.");
      throw new Error("Network access is disabled for the packaged smoke test.");
    };
    this.timer = setTimeout(() => this.fail(new Error(`Packaged smoke test timed out after ${this.idleMs + 45_000} milliseconds.`)), this.idleMs + 45_000);
  }

  async run(window: BrowserWindow) {
    this.window = window;
    try {
      if (!app.isPackaged) throw new Error("--smoke-test requires a packaged application.");
      this.checks.push({ id: "isolated-user-data", ok: app.getPath("userData") === this.userDataPath, message: "Fresh temporary application data; startup integrations and official Hermes home linking are disabled." });
      if (typeof autoUpdater.checkForUpdates !== "function") throw new Error("electron-updater runtime dependency failed to load.");
      this.checks.push({ id: "updater-module", ok: true, message: "electron-updater loaded without starting an update check." });

      for (const resource of [
        "sql-wasm.wasm",
        "hermes-windows-mcp-server.py",
        "hermes-windows-agent.py",
        "hermes-forge-gateway.py",
        "resources/weixin-qr-login.py",
        "python-sitecustomize/sitecustomize.py",
      ]) {
        const stat = fs.statSync(path.join(process.resourcesPath, resource));
        if (!stat.isFile() || !stat.size) throw new Error(`Packaged resource is missing or empty: ${resource}`);
      }
      this.checks.push({ id: "copied-resources", ok: true, message: "SQL WASM and all five Python resources are present." });

      const memoryIndex = new SqliteMemoryIndex(path.join(this.userDataPath, "smoke-memory.sqlite"));
      const database = await memoryIndex.open();
      try {
        const result = database.exec("SELECT 6 * 7 AS answer");
        if (result[0]?.values[0]?.[0] !== 42) throw new Error("SQL WASM query returned an unexpected value.");
      } finally {
        database.close();
      }
      this.checks.push({ id: "sql-wasm-runtime", ok: true, message: "The production memory index created its SQLite database and executed a query." });

      window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
        this.errors.push(`Unexpected renderer network request: ${new URL(details.url).origin}`);
        callback({ cancel: true });
      });
      window.webContents.on("preload-error", (_event, _preloadPath, error) => this.errors.push(`Preload failed: ${error.message}`));
      window.webContents.on("render-process-gone", (_event, details) => this.fail(new Error(`Renderer exited: ${details.reason}`)));
      window.webContents.on("console-message", event => {
        if (event.level === "error") this.errors.push(event.message);
      });
      const entryPath = path.join(__dirname, "..", "..", "renderer", "index.html");
      await window.loadFile(entryPath);
      await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 12000;
        while (![...document.querySelectorAll('button')].some(button => button.textContent.trim() === "检测环境")) {
          if (Date.now() > deadline) throw new Error("The first-run welcome interface did not render within 12 seconds");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (!window.workbenchClient) throw new Error("workbenchClient was not exposed on first run");
        await window.workbenchClient.getClientInfo();
        await new Promise(resolve => setTimeout(resolve, 250));
      })()`);
      this.metrics.welcomeReadyMs = Math.round(process.uptime() * 1000);
      await this.captureScreenshot("welcome");
      if (this.errors.length || this.processLaunchAttempts.length) throw new Error("First-run welcome unexpectedly requested a command or produced renderer errors.");
      this.checks.push({ id: "fresh-welcome", ok: true, message: "The actual first-run welcome rendered its manual detection action without launching commands." });
      // Continue through the established workbench path using the same persisted
      // setting written on onboarding completion, followed by a real page reload.
      await window.webContents.executeJavaScript(`localStorage.setItem("hermes-workbench", JSON.stringify({ state: { firstLaunch: false }, version: 0 }));`);
      await window.loadFile(entryPath);
      const result = await window.webContents.executeJavaScript(`(async () => {
        if (!window.workbenchClient) throw new Error("workbenchClient was not exposed by preload");
        const [client, sessions, config] = await Promise.all([
          window.workbenchClient.getClientInfo(),
          window.workbenchClient.listSessions(),
          window.workbenchClient.getRuntimeConfig()
        ]);
        const deadline = Date.now() + 12000;
        while (!document.querySelector('textarea[aria-label="给 Hermes 发送消息"]') || !document.querySelector('button[title="技能与记忆"]')) {
          if (Date.now() > deadline) throw new Error("The real chat interface did not render within 12 seconds");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return {
          appVersion: client.appVersion,
          userDataPath: client.userDataPath,
          rendererMode: client.rendererMode,
          sessions: sessions.length,
          extensions: config.extensionSettings,
          shellVisible: Boolean(document.querySelector('button[title="聊天"]') && document.querySelector('button[title="工作区"]') && document.querySelector('button[aria-label="设置中心"]')),
          nodeIsolated: typeof window.require === "undefined" && typeof window.process === "undefined"
        };
      })()`);
      if (result.userDataPath !== this.userDataPath || result.rendererMode !== "built" || result.appVersion !== app.getVersion() || !result.sessions || !result.nodeIsolated) {
        throw new Error("Preload IPC returned an unexpected application identity, session state, or isolation setting.");
      }
      if (!result.shellVisible) throw new Error("The packaged renderer is missing required navigation controls.");
      if (Object.values(result.extensions ?? {}).some(Boolean) || !result.extensions) throw new Error("Extensions were not disabled for the offline smoke test.");
      this.checks.push({ id: "preload-ipc", ok: true, message: "Real preload calls reached the registered main-process handlers and returned the isolated session/configuration." });
      this.checks.push({ id: "rendered-chat", ok: true, message: "The built React application rendered its chat composer and all primary navigation controls in a hidden window." });
      this.metrics.rendererReadyMs = Math.round(process.uptime() * 1000);
      await this.captureScreenshot("chat");
      this.metrics.atReady = appMemoryMetrics();
      console.log("__HERMES_FORGE_SMOKE_READY__", JSON.stringify(this.metrics));
      if (this.idleMs) {
        await new Promise(resolve => setTimeout(resolve, this.idleMs));
        this.metrics.afterIdle = appMemoryMetrics();
        this.checks.push({ id: "idle-observation", ok: true, message: `Observed the actual hidden application idle for ${this.idleMs} milliseconds.` });
      }
      if (this.processLaunchAttempts.length) throw new Error(`The offline application attempted ${this.processLaunchAttempts.length} external process launches.`);
      const inactiveChannels = [IpcChannels.getGatewayStatus, IpcChannels.startGateway, IpcChannels.restartGateway, IpcChannels.getHermesProbe, IpcChannels.getSetupSummary, IpcChannels.getWebUiOverview, IpcChannels.listSkills, IpcChannels.listMemoryFiles, IpcChannels.listProfiles, IpcChannels.listCronJobs, IpcChannels.listConnectors];
      const unexpectedChannels = inactiveChannels.filter(channel => this.ipcCallCounts[channel]);
      if (unexpectedChannels.length) throw new Error(`Inactive integrations or scans were requested: ${unexpectedChannels.join(", ")}`);
      this.checks.push({ id: "no-background-scans", ok: true, message: "No Gateway, runtime probe, setup scan, overview, or optional panel list IPC calls occurred." });
      this.checks.push({ id: "zero-external-processes", ok: true, message: "No Node child_process spawn/fork/exec calls occurred; no Hermes or Python process was launched." });
      if (this.errors.length) throw new Error(this.errors.join("\n"));
      this.checks.push({ id: "offline-renderer", ok: true, message: "No renderer/preload errors or HTTP/WebSocket requests occurred." });
      this.finish();
    } catch (error) {
      this.fail(error);
    }
  }

  fail(error: unknown) {
    if (this.completed) return;
    this.checks.push({ id: "failure", ok: false, message: error instanceof Error ? error.message : String(error) });
    this.finish();
  }

  private async captureScreenshot(name: string) {
    const directory = process.env.HERMES_FORGE_SMOKE_TEST_SCREENSHOTS;
    if (!directory || !this.window) return;
    fs.mkdirSync(directory, { recursive: true });
    await this.window.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))");
    const screenshot = await this.window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    fs.writeFileSync(path.join(directory, `${name}.png`), screenshot.toPNG());
  }

  private finish() {
    if (this.completed) return;
    this.completed = true;
    clearTimeout(this.timer);
    const report = { ok: this.checks.length > 0 && this.checks.every(check => check.ok), appVersion: app.getVersion(), startedAt: this.startedAt, completedAt: new Date().toISOString(), idleMs: this.idleMs, processLaunchAttempts: this.processLaunchAttempts, ipcCallCounts: this.ipcCallCounts, metrics: this.metrics, checks: this.checks };
    let exitCode = report.ok ? 0 : 1;
    const serialized = JSON.stringify(report, null, 2);
    console.log(`__HERMES_FORGE_SMOKE_TEST_START__\n${serialized}\n__HERMES_FORGE_SMOKE_TEST_END__`);
    try {
      const outputPath = process.env.HERMES_FORGE_SMOKE_TEST_OUTPUT;
      if (outputPath) fs.writeFileSync(outputPath, serialized, "utf8");
    } catch (error) {
      console.error("Failed to write smoke report:", error);
      exitCode = 1;
    }
    this.window?.destroy();
    // Only remove the directory generated by mkdtemp directly under the system temp directory.
    if (path.dirname(path.resolve(this.userDataPath)) === path.resolve(os.tmpdir()) && path.basename(this.userDataPath).startsWith("hermes-forge-smoke-")) {
      try { fs.rmSync(this.userDataPath, { recursive: true, force: true, maxRetries: 1 }); } catch { /* Windows may retain Chromium file handles until app.exit. */ }
    }
    app.exit(exitCode);
  }
}

function appMemoryMetrics() {
  const processes = app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, name: metric.name ?? metric.serviceName, workingSetKB: metric.memory.workingSetSize, peakWorkingSetKB: metric.memory.peakWorkingSetSize, privateKB: metric.memory.privateBytes }));
  return { capturedAt: new Date().toISOString(), totalWorkingSetKB: processes.reduce((total, metric) => total + metric.workingSetKB, 0), processes };
}
