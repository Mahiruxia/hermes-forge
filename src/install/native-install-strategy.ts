import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "../main/app-paths";
import { resolveActiveHermesHome } from "../main/hermes-home";
import type { RuntimeConfigStore } from "../main/runtime-config";
import { runCommand, streamCommand } from "../process/command-runner";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import type { RuntimeProbeService } from "../runtime/runtime-probe-service";
import { managedHermesEnvironmentEnv, resolveManagedHermesEnvironment } from "../runtime/managed-hermes-environment";
import type { SetupDependencyRepairId } from "../shared/types";
import type { InstallStrategy } from "./install-strategy";
import type {
  InstallOptions,
  InstallPlan,
  InstallPublisher,
  InstallStrategyRepairResult,
  InstallStrategyResult,
  InstallStrategyUpdateResult,
} from "./install-types";
import { installStep } from "./install-types";
import { DEFAULT_PINNED_HERMES_SOURCE, resolveInstallSource, resolveInstallSourceFromOption } from "./install-source";
import type { InstallSource } from "./install-source";
import { AUDITED_HERMES_RELEASE_TAG, MINIMUM_HERMES_VERSION } from "./hermes-version-constants";
import { isAtLeastVersion, parseHermesVersion } from "./hermes-version";
import { ensureManagedHermesEnvironment, readConfiguredHermesExtras, synchronizeHermesDependencies, synchronizeHermesSource, type MaintenanceRunner } from "./hermes-maintenance";
import { MacosInstallStrategy } from "./macos-install-strategy";

const DEFAULT_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const OFFICIAL_WINDOWS_INSTALLER_URL = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${AUDITED_HERMES_RELEASE_TAG}/scripts/install.ps1`;
const COMMUNITY_MIRROR_WINDOWS_INSTALLER_URL = "https://res1.hermesagent.org.cn/install.ps1";

export class NativeInstallStrategy implements InstallStrategy {
  readonly kind = "native" as const;
  private installInFlight?: Promise<InstallStrategyResult>;
  private installAbortController?: AbortController;
  private installPublisher?: InstallPublisher;
  private installStartedAt?: string;
  private readonly macosStrategy?: MacosInstallStrategy;

  constructor(
    private readonly appPaths: AppPaths,
    _hermes: EngineAdapter,
    private readonly configStore: RuntimeConfigStore,
    private readonly runtimeProbeService?: RuntimeProbeService,
    _runtimeAdapterFactory?: RuntimeAdapterFactory,
  ) {
    if (process.platform === "darwin") this.macosStrategy = new MacosInstallStrategy(appPaths, configStore);
  }

  async plan(options: InstallOptions = {}): Promise<InstallPlan> {
    if (this.macosStrategy) return this.macosStrategy.plan();
    const runtime = { mode: "windows" as const, pythonCommand: "python", windowsAgentMode: "hermes_native" as const };
    const probe = await this.runtimeProbeService?.probe({ runtime }).catch(() => undefined);
    const rootPath = await this.resolveInstallRoot(options.rootPath);
    const issues = probe?.issues ?? [];
    return {
      mode: "windows",
      ok: !probe || probe.powershellAvailable,
      summary: probe
        ? "Windows Native install.ps1 安装策略已生成计划。"
        : "Windows Native install.ps1 安装策略已生成 legacy 计划。",
      issues,
      runtimeProbe: probe,
      steps: [
        installStep({
          phase: "plan",
          step: "select-native",
          status: "passed",
          code: "native_selected",
          summary: "已选择 Windows Native install.ps1 安装策略。",
          debugContext: { rootPath },
        }),
        installStep({
          phase: "preflight",
          step: "native-dependencies",
          status: probe ? "passed" : "skipped",
          code: probe ? "runtime_probe" : "legacy_fallback",
          summary: probe ? "依赖状态来自 RuntimeProbe。" : "未注入 RuntimeProbe，安装时将使用 legacy direct checks。",
          detail: probe ? `powershell=${probe.powershellAvailable}, python=${probe.pythonAvailable}, git=${probe.gitAvailable}, winget=${probe.wingetAvailable}` : undefined,
        }),
      ],
    };
  }

  async update(): Promise<InstallStrategyUpdateResult> {
    if (this.macosStrategy) return this.macosStrategy.update();
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const rootPath = await this.resolveInstallRoot(await this.configStore.getEnginePath("hermes"), log);
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `hermes-update-${startedAt.replace(/[:.]/g, "-")}.log`);
    let ok = false;
    let message: string;
    try {
      const config = await this.configStore.read();
      const source = resolveInstallSource(config);
      const run: MaintenanceRunner = (command, args, env) => this.runLogged(command, args, rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS, { env });
      log.push(`Updating in place to ${source.repoUrl}@${source.commit ?? source.branch ?? "main"}; no backup or stash is created.`);
      const commit = await synchronizeHermesSource(source, run);
      const environment = await ensureManagedHermesEnvironment(rootPath, run);
      const extras = await readConfiguredHermesExtras(config, this.appPaths.baseDir());
      await synchronizeHermesDependencies(environment, extras, run);
      const health = await this.checkInstalledHermes(rootPath, log);
      if (!health.available) throw new Error(health.message);
      await this.writeManagedMarker(rootPath, true, source, commit);
      await this.saveHermesRoot(rootPath, source);
      ok = true;
      message = `Hermes 已更新到 ${source.branch ?? commit.slice(0, 12)}（${commit.slice(0, 12)}），受管环境依赖和核心导入检查通过。`;
    } catch (error) {
      message = `Hermes 更新未完成：${error instanceof Error ? error.message : String(error)}。已完成步骤保留，可重新运行更新继续。`;
      log.push(message);
    }
    await this.writeInstallLog(logDir, logPath, message, log);
    return { ok, engineId: "hermes", rootPath, message, log, logPath, plan: await this.plan({ rootPath }) };
  }

  async install(publish?: InstallPublisher, options: InstallOptions = {}): Promise<InstallStrategyResult> {
    if (this.macosStrategy) return this.macosStrategy.install(publish, options);
    if (!this.installInFlight) {
      this.installAbortController = new AbortController();
      this.installPublisher = publish;
      this.installStartedAt = new Date().toISOString();
      this.installInFlight = this.performInstallHermes(publish, options, false, this.installAbortController.signal, this.installStartedAt).finally(() => {
        this.installInFlight = undefined;
        this.installAbortController = undefined;
        this.installPublisher = undefined;
        this.installStartedAt = undefined;
      });
    }
    return await this.installInFlight;
  }

  async cancelInstall(): Promise<{ ok: boolean; message: string }> {
    if (this.macosStrategy) return this.macosStrategy.cancelInstall();
    if (!this.installAbortController) {
      return { ok: false, message: "当前没有正在运行的 Hermes 安装。" };
    }
    const startedAt = this.installStartedAt ?? new Date().toISOString();
    this.installPublisher?.({
      stage: "cancelling",
      progress: 96,
      message: "正在取消 Hermes 安装。",
      detail: "正在终止后台 PowerShell 安装进程...",
      startedAt,
      at: new Date().toISOString(),
    });
    this.installAbortController.abort();
    return { ok: true, message: "已请求取消 Hermes 安装，后台进程正在终止。" };
  }

  async repairDependency(id: SetupDependencyRepairId): Promise<InstallStrategyRepairResult> {
    if (this.macosStrategy) return this.macosStrategy.repairDependency(id);
    switch (id) {
      case "git":
      case "python":
        return await this.repairWithOfficialInstaller(id);
      case "hermes_pyyaml":
        return await this.repairPythonPackage(id, "PyYAML", "PyYAML", "请重新检查 Hermes 状态，确认 yaml 模块已可导入。");
      case "hermes_python_dotenv":
        return await this.repairPythonPackage(id, "python-dotenv", "python-dotenv", "请重新检查 Hermes 状态，确认 dotenv 模块已可导入。");
      case "weixin_aiohttp":
        return await this.repairPythonPackage(id, "aiohttp", "aiohttp");
      case "feishu_lark_oapi":
        return await this.repairPythonPackage(id, "lark-oapi", "lark-oapi", "请重新检查系统状态，确认飞书连接依赖已就绪。");
      case "telegram_bot":
        return await this.repairPythonPackage(id, "python-telegram-bot", "python-telegram-bot[webhooks]", "请重新检查系统状态，确认 Telegram 连接依赖已就绪。");
      case "discord_py":
        return await this.repairPythonPackage(id, "discord.py", "discord.py[voice]", "请重新检查系统状态，确认 Discord 连接依赖已就绪。");
      case "slack_bolt":
        return await this.repairPythonPackage(id, "slack-bolt", "slack-bolt", "请重新检查系统状态，确认 Slack 连接依赖已就绪。");
      default:
        return {
          ok: false,
          id,
          message: "未知依赖修复项。",
          recommendedFix: "请刷新系统状态后重试。",
          plan: await this.plan(),
        };
    }
  }

  private async performInstallHermes(
    publish?: InstallPublisher,
    options: InstallOptions = {},
    _forceRunOfficialInstaller = false,
    signal?: AbortSignal,
    requestedStartedAt?: string,
  ): Promise<InstallStrategyResult> {
    const log: string[] = [];
    const startedAt = requestedStartedAt ?? new Date().toISOString();
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `hermes-install-${startedAt.replace(/[:.]/g, "-")}.log`);
    const scriptPath = path.join(logDir, `hermes-install-${startedAt.replace(/[:.]/g, "-")}.ps1`);
    const config = await this.configStore.read();
    const source = resolveInstallSourceFromOption(config, options.source);
    const rootPath = await this.resolveInstallRoot(options.rootPath ?? config.enginePaths?.hermes, log);
    const hermesHome = this.defaultHermesHomeForInstall(rootPath);
    const emit = (stage: Parameters<InstallPublisher>[0]["stage"], progress: number, message: string, detail?: string) => {
      log.push(`[${stage}] ${message}${detail ? ` | ${detail}` : ""}`);
      publish?.({ stage, progress, message, detail, startedAt, at: new Date().toISOString(), sourceLabel: source.sourceLabel, sourceUrl: source.repoUrl });
    };
    let ok = false;
    let message: string;
    try {
      this.throwIfAborted(signal);
      emit("preflight", 5, "正在检查 Hermes 安装目录与受管环境。", rootPath);
      await fs.mkdir(logDir, { recursive: true });
      const entries = await fs.readdir(rootPath).catch(() => []);
      const hasGit = await this.exists(path.join(rootPath, ".git"));
      if (entries.length && !hasGit) throw new Error("目标目录非空且没有 Git 仓库，请选择空目录或已有 Hermes 仓库；不会移动或覆盖现有文件。");
      if (hasGit && !await this.exists(path.join(rootPath, "pyproject.toml")) && !await this.exists(path.join(rootPath, "run_agent.py"))) {
        const head = await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: rootPath, timeoutMs: 10_000 });
        if (head.exitCode === 0) throw new Error("目标 Git 仓库不是 Hermes 安装，未修改。");
      }
      const urls = this.installerUrlsForSource(source);
      emit("downloading_script", 15, "正在准备官方安装引导工具。", urls[0]);
      const download = await this.downloadOfficialInstallerScript(scriptPath, logDir, log, urls, signal);
      if (!download.ok) throw new Error(this.scriptDownloadFailureMessage(source.sourceLabel));
      await this.patchOfficialInstallerScript(scriptPath, log);
      const script = await fs.readFile(scriptPath, "utf8");
      if (!/\[string\]\s*\$Stage\b/i.test(script) || !/\[switch\]\s*\$NonInteractive\b/i.test(script)) {
        throw new Error("安装脚本不支持官方分阶段安装协议，请切换官方安装源；未运行旧版全量安装器。");
      }
      for (const stage of ["uv", "git"]) {
        this.throwIfAborted(signal);
        emit("running_installer", stage === "uv" ? 25 : 35, `正在准备 ${stage}。`);
        const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Stage", stage, "-NonInteractive", "-SkipSetup", "-HermesHome", hermesHome, "-InstallDir", rootPath];
        const result = await this.runLogged("powershell.exe", args, logDir, log, DEFAULT_INSTALL_TIMEOUT_MS, {
          signal,
          env: this.pythonCommandEnv(),
          onLine: (line) => publish?.({ stage: "running_installer", progress: stage === "uv" ? 25 : 35, message: `正在准备 ${stage}。`, detail: line, logLine: line, startedAt, at: new Date().toISOString() }),
        });
        if (result.exitCode !== 0 || this.officialInstallerReportedFailure(result.stdout, result.stderr)) {
          throw new Error(`官方 ${stage} 阶段失败：${result.stderr || result.stdout}`);
        }
        const frame = result.stdout.split(/\r?\n/).map((line) => { try { return JSON.parse(line) as { stage?: string; ok?: boolean }; } catch { return undefined; } }).find((item) => item?.stage === stage);
        if (frame?.ok !== true) throw new Error(`官方 ${stage} 阶段未返回成功结果。`);
      }
      this.prependProcessPath([path.join(hermesHome, "bin"), path.join(hermesHome, "git", "cmd"), path.join(hermesHome, "git", "bin")]);
      await fs.mkdir(rootPath, { recursive: true });
      if (!hasGit) {
        const init = await this.runLogged("git", ["init"], rootPath, log, 30_000, { signal });
        if (init.exitCode !== 0) throw new Error("无法初始化 Hermes Git 仓库。");
        const remote = await this.runLogged("git", ["remote", "add", "origin", source.repoUrl], rootPath, log, 15_000, { signal });
        if (remote.exitCode !== 0) throw new Error("无法设置 Hermes 安装来源。");
      }
      emit("cloning", 45, "正在同步指定的官方版本。", source.commit ?? source.branch);
      const sync = await this.syncInstalledSourceIfNeeded(rootPath, source, log, signal);
      if (!sync.ok) throw new Error(sync.message);
      emit("installing_dependencies", 65, "正在同步核心、MCP 与已启用功能的依赖。");
      await this.synchronizeManagedDependencies(rootPath, log, signal);
      this.throwIfAborted(signal);
      emit("health_check", 90, "正在检查 Hermes 版本与核心依赖。");
      const health = await this.checkInstalledHermes(rootPath, log);
      if (!health.available) throw new Error(health.message);
      await this.verifyHermesHomeWritable(hermesHome, log);
      await this.recordManagedWindowsTools(hermesHome, log);
      const commit = await this.currentGitCommit(rootPath, log);
      await this.writeManagedMarker(rootPath, true, source, commit);
      await this.saveHermesRoot(rootPath, source);
      ok = true;
      message = "Hermes 已安装完成，版本和受管环境检查通过。";
    } catch (error) {
      message = signal?.aborted ? "Hermes 安装已取消；已完成步骤保留，可重新运行安装继续。" : `Hermes 安装未完成：${error instanceof Error ? error.message : String(error)}`;
    }
    emit(ok ? "completed" : signal?.aborted ? "cancelled" : "failed", 100, message);
    await this.writeInstallLog(logDir, logPath, message, log);
    return { ok, engineId: "hermes", rootPath, message, log, logPath, plan: await this.plan({ rootPath }) };
  }

  private async repairWithOfficialInstaller(id: SetupDependencyRepairId): Promise<InstallStrategyRepairResult> {
    const rootPath = await this.resolveInstallRoot(await this.configStore.getEnginePath("hermes").catch(() => this.defaultInstallRoot()));
    const result = await this.performInstallHermes(undefined, { rootPath, mode: "windows" }, true);
    return {
      ok: result.ok,
      id,
      message: result.ok
        ? "Hermes Windows 安装脚本已重跑完成，请重新检测依赖状态。"
        : `Hermes Windows 安装脚本修复失败：${result.message}`,
      stdout: result.log.join("\n"),
      stderr: result.ok ? "" : result.message,
      logPath: result.logPath,
      recommendedFix: result.ok
        ? "重新打开系统状态页或运行一键诊断确认依赖是否就绪。"
        : "请查看安装日志；如果 winget 或网络策略不可用，请按日志中的手动命令安装缺失依赖。",
      plan: result.plan ?? await this.plan({ rootPath, mode: "windows" }),
    };
  }

  private async downloadOfficialInstallerScript(scriptPath: string, cwd: string, log: string[], urls: string[], signal?: AbortSignal) {
    for (const url of urls) {
      const downloadScript = [
        "$ProgressPreference='SilentlyContinue';",
        `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;`,
        `Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(url)} -OutFile ${psQuote(scriptPath)};`,
      ].join(" ");
      const result = await this.runLogged("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", downloadScript], cwd, log, 120_000, { signal });
      if (result.exitCode === 0 && await this.exists(scriptPath)) {
        const bytes = await fs.readFile(scriptPath);
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        log.push(`Hermes installer downloaded from ${url}.`);
        log.push(`Hermes installer source URL: ${url}`);
        log.push(`Hermes installer content length: ${bytes.byteLength} bytes`);
        log.push(`Hermes installer SHA256: ${sha256}`);
        return { ok: true, url, sha256, contentLength: bytes.byteLength };
      }
      log.push(`Installer download failed from ${url}; trying next configured source if available.`);
    }
    return { ok: false };
  }

  private officialInstallerReportedFailure(stdout: string, stderr: string) {
    const output = `${stdout}\n${stderr}`;
    return /Installation failed:|uv installation failed|Python .* not available|Git not available and auto-install failed|Failed to download repository/i.test(output);
  }

  private scriptDownloadFailureMessage(sourceLabel?: InstallSource["sourceLabel"]) {
    return `Hermes 安装脚本下载失败。${this.sourceFailureHint(sourceLabel)}详情见安装日志。`;
  }

  private sourceFailureHint(sourceLabel?: InstallSource["sourceLabel"]) {
    if (sourceLabel === "official") return "官方 GitHub 源失败时，可改用国内社区镜像重试。";
    if (sourceLabel === "mirror") return "国内社区镜像失败时，请检查网络/镜像可达性，或切回官方 GitHub 源重试。";
    return "请检查网络、仓库地址和安装来源配置。";
  }

  private installerUrlsForSource(source: InstallSource) {
    return source.sourceLabel === "mirror"
      ? [COMMUNITY_MIRROR_WINDOWS_INSTALLER_URL]
      : [OFFICIAL_WINDOWS_INSTALLER_URL];
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("install_cancelled");
  }

  private async syncInstalledSourceIfNeeded(rootPath: string, source: InstallSource, log: string[], signal?: AbortSignal) {
    try {
      const run: MaintenanceRunner = (command, args, env) => this.runLogged(command, args, rootPath, log, 180_000, { env, signal });
      await synchronizeHermesSource(source, run);
      return { ok: true, message: "安装源和实际提交已核验。" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async repairPythonPackage(id: SetupDependencyRepairId, label: string, _packageName: string, successRecommendedFix = "请重新检测依赖状态。"): Promise<InstallStrategyRepairResult> {
    const rootPath = await this.resolveInstallRoot(await this.configStore.getEnginePath("hermes"));
    const log: string[] = [];
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `dependency-${id}-${Date.now()}.log`);
    try {
      const run: MaintenanceRunner = (command, args, env) => this.runLogged(command, args, rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS, { env });
      const environment = await ensureManagedHermesEnvironment(rootPath, run);
      const extras = new Set(await readConfiguredHermesExtras(await this.configStore.read(), this.appPaths.baseDir()));
      const requestedExtra: Partial<Record<SetupDependencyRepairId, string>> = {
        weixin_aiohttp: "messaging", feishu_lark_oapi: "feishu", telegram_bot: "messaging", discord_py: "messaging", slack_bolt: "slack",
      };
      if (requestedExtra[id]) extras.add(requestedExtra[id]!);
      await synchronizeHermesDependencies(environment, [...extras].sort(), run);
      const message = `${label} 已按当前 Hermes 锁文件在受管环境中同步。`;
      await this.writeInstallLog(logDir, logPath, message, log);
      return { ok: true, id, message, stdout: log.join("\n"), logPath, recommendedFix: successRecommendedFix, plan: await this.plan() };
    } catch (error) {
      const message = `${label} 修复未完成：${error instanceof Error ? error.message : String(error)}`;
      await this.writeInstallLog(logDir, logPath, message, log);
      return { ok: false, id, message, stdout: log.join("\n"), logPath, recommendedFix: "修复失败原因后重新运行；未修改系统 Python 包。", plan: await this.plan() };
    }
  }

  private async synchronizeManagedDependencies(rootPath: string, log: string[], signal?: AbortSignal) {
    const run: MaintenanceRunner = (command, args, env) => this.runLogged(command, args, rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS, { env, signal });
    const environment = await ensureManagedHermesEnvironment(rootPath, run);
    const extras = await readConfiguredHermesExtras(await this.configStore.read(), this.appPaths.baseDir());
    await synchronizeHermesDependencies(environment, extras, run);
  }

  private async saveHermesRoot(rootPath: string, installSource?: InstallSource) {
    const config = await this.configStore.read();
    const source = installSource ?? resolveInstallSource(config);
    await this.configStore.write({
      ...config,
      enginePaths: { ...(config.enginePaths ?? {}), hermes: rootPath },
      hermesRuntime: {
        ...(config.hermesRuntime ?? {}),
        mode: "windows",
        distro: undefined,
        managedRoot: rootPath,
        installSource: {
          repoUrl: source.repoUrl,
          branch: source.branch ?? "main",
          commit: source.commit,
          sourceLabel: source.sourceLabel,
        },
      },
    });
  }

  private async runLogged(command: string, args: string[], cwd: string, log: string[], timeoutMs: number, heartbeat?: { heartbeatMs?: number; onHeartbeat?: (elapsedSeconds: number) => void; signal?: AbortSignal; onLine?: (line: string) => void; env?: NodeJS.ProcessEnv }) {
    log.push(`$ ${command} ${args.join(" ")}`);
    const startedAt = Date.now();
    const timer = heartbeat?.heartbeatMs && heartbeat.onHeartbeat ? setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      log.push(`[heartbeat] ${command} still running after ${elapsedSeconds}s`);
      heartbeat.onHeartbeat?.(elapsedSeconds);
    }, heartbeat.heartbeatMs) : undefined;
    try {
      if (!heartbeat?.onLine) {
        const result = await runCommand(command, args, { cwd, timeoutMs, signal: heartbeat?.signal, env: heartbeat?.env });
        if (result.stdout.trim()) log.push(result.stdout.trim());
        if (result.stderr.trim()) log.push(result.stderr.trim());
        log.push(`exit ${result.exitCode ?? "unknown"}`);
        return result;
      }

      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      for await (const event of streamCommand(command, args, { cwd, timeoutMs, signal: heartbeat.signal, env: heartbeat.env })) {
        if (event.type === "stdout" || event.type === "stderr") {
          const line = event.line.trim();
          if (!line) continue;
          if (event.type === "stdout") stdout += `${line}\n`;
          else stderr += `${line}\n`;
          log.push(line);
          heartbeat.onLine(line);
        } else {
          exitCode = event.exitCode;
        }
      }
      log.push(`exit ${exitCode ?? "unknown"}`);
      return { exitCode, stdout, stderr };
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  private async checkInstalledHermes(rootPath: string, log: string[]) {
    const environment = await resolveManagedHermesEnvironment(rootPath);
    if (!environment) return { available: false, message: "Hermes 受管虚拟环境缺失。" };
    const hermesHome = await resolveActiveHermesHome(this.appPaths.hermesDir());
    const env = managedHermesEnvironmentEnv(environment, { HERMES_HOME: hermesHome });
    const result = await this.runLogged(environment.cliPath, ["--version"], rootPath, log, 20_000, { env });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const version = parseHermesVersion(output);
    if (result.exitCode !== 0 || !version || !isAtLeastVersion(version, MINIMUM_HERMES_VERSION)) {
      return { available: false, message: `需要 Hermes ${MINIMUM_HERMES_VERSION}+，当前 CLI 检查失败：${output || "无版本输出"}` };
    }
    const imports = await this.runLogged(environment.pythonPath, ["-c", "from run_agent import AIAgent; from hermes_state import SessionDB; import hermes_logging, mcp; print('hermes-import-ok')"], rootPath, log, 60_000, { env });
    if (imports.exitCode !== 0 || !imports.stdout.includes("hermes-import-ok")) {
      return { available: false, message: `Hermes 核心依赖导入失败：${imports.stderr || imports.stdout}` };
    }
    return { available: true, message: `Hermes ${version} 及核心依赖可用。` };
  }

  private async writeManagedMarker(rootPath: string, editable: boolean, installSource?: InstallSource, installedCommit?: string) {
    const source = installSource ?? DEFAULT_PINNED_HERMES_SOURCE;
    const markerPath = path.join(rootPath, ".zhenghebao-managed-install.json");
    await fs.writeFile(markerPath, JSON.stringify({
      source: "zhenghebao",
      installer: this.installerUrlsForSource(source)[0],
      repoUrl: source.repoUrl,
      branch: source.branch ?? "main",
      commit: source.commit,
      installedCommit,
      sourceLabel: source.sourceLabel,
      editable,
      installedAt: new Date().toISOString(),
    }, null, 2), "utf8");
  }

  private async currentGitCommit(rootPath: string, log: string[]) {
    const result = await this.runLogged("git", ["rev-parse", "HEAD"], rootPath, log, 15_000).catch(() => undefined);
    const commit = result?.exitCode === 0 ? result.stdout.trim() : "";
    if (commit) {
      log.push(`Installed commit: ${commit}`);
      return commit;
    }
    log.push("Installed commit could not be resolved.");
    return undefined;
  }

  private async writeInstallLog(logDir: string, logPath: string, message: string, log: string[]) {
    try {
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(logPath, [message, "", ...log].join("\n"), "utf8");
    } catch {
      // Logging failures should not hide install result.
    }
  }

  private async verifyHermesHomeWritable(hermesHome: string, log: string[]) {
    await fs.mkdir(path.join(hermesHome, "skills"), { recursive: true });
    const probe = path.join(hermesHome, "skills", `.zhenghebao-skill-write-probe-${Date.now()}`);
    await fs.writeFile(probe, "ok", "utf8");
    await fs.unlink(probe);
    await fs.mkdir(path.join(hermesHome, "logs"), { recursive: true });
    log.push(`Hermes home 可写：${hermesHome}`);
  }

  private async recordManagedWindowsTools(hermesHome: string, log: string[]) {
    if (process.platform !== "win32") return;
    const gitRoot = path.join(hermesHome, "git");
    const pathEntries = [
      path.join(gitRoot, "cmd"),
      path.join(gitRoot, "bin"),
      path.join(gitRoot, "usr", "bin"),
    ];
    const existingPathEntries: string[] = [];
    for (const entry of pathEntries) {
      if (await this.exists(entry)) existingPathEntries.push(entry);
    }
    if (existingPathEntries.length) {
      this.prependProcessPath(existingPathEntries);
      log.push(`Added managed Git paths to current process PATH: ${existingPathEntries.join(";")}`);
    }

    const bashCandidates = [
      path.join(gitRoot, "bin", "bash.exe"),
      path.join(gitRoot, "usr", "bin", "bash.exe"),
    ];
    const bashPath = await this.firstExistingPath(bashCandidates);
    if (bashPath) {
      process.env.HERMES_GIT_BASH_PATH = bashPath;
      log.push(`Detected managed Git Bash: ${bashPath}`);
      const persist = await this.runLogged(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `[Environment]::SetEnvironmentVariable('HERMES_GIT_BASH_PATH', ${psQuote(bashPath)}, 'User')`,
        ],
        process.cwd(),
        log,
        15_000,
      ).catch(() => undefined);
      if (persist?.exitCode === 0) log.push("Persisted HERMES_GIT_BASH_PATH for future launches.");
    }
  }

  private defaultInstallRoot() {
    if (process.platform === "win32") {
      return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "hermes", "hermes-agent");
    }
    return path.join(os.homedir(), "Hermes Agent");
  }

  private defaultHermesHomeForInstall(rootPath: string) {
    return this.windowsUsablePath(process.env.HERMES_HOME?.trim())
      || this.windowsUsablePath(process.env.HERMES_AGENT_HOME?.trim())
      || path.dirname(rootPath);
  }

  private async resolveInstallRoot(requestedRoot?: string, log?: string[]) {
    const rootPath = this.windowsUsablePath(requestedRoot?.trim())
      || this.windowsUsablePath(process.env.HERMES_INSTALL_DIR?.trim())
      || this.defaultInstallRoot();
    return await this.normalizeInstallRoot(rootPath, log);
  }

  private windowsUsablePath(candidate?: string) {
    if (!candidate) return undefined;
    if (process.platform === "win32" && isLegacyPosixPath(candidate)) return undefined;
    return candidate;
  }

  private async normalizeInstallRoot(rootPath: string, log?: string[]) {
    if (process.platform !== "win32") return rootPath;
    const normalized = path.resolve(rootPath);
    const childInstall = path.join(normalized, "hermes-agent");
    if (this.samePath(normalized, childInstall)) return rootPath;

    const currentLooksInstall = await this.exists(path.join(normalized, "pyproject.toml"))
      || await this.exists(path.join(normalized, "run_agent.py"))
      || await this.exists(path.join(normalized, "venv", "Scripts", "hermes.exe"))
      || await this.exists(path.join(normalized, ".venv", "Scripts", "hermes.exe"));
    if (currentLooksInstall) return rootPath;

    const childLooksInstall = await this.exists(path.join(childInstall, "pyproject.toml"))
      || await this.exists(path.join(childInstall, "run_agent.py"))
      || await this.exists(path.join(childInstall, "venv", "Scripts", "hermes.exe"))
      || await this.exists(path.join(childInstall, ".venv", "Scripts", "hermes.exe"));
    const currentLooksHome = await this.exists(path.join(normalized, "config.yaml"))
      || await this.exists(path.join(normalized, "state.db"))
      || await this.exists(path.join(normalized, "memories"))
      || await this.exists(path.join(normalized, "skills"))
      || await this.exists(path.join(normalized, "profiles"));
    if (currentLooksHome || childLooksInstall) {
      log?.push(`Install root normalized from Hermes home to agent directory: ${normalized} -> ${childInstall}`);
      return childInstall;
    }
    return rootPath;
  }

  private async patchOfficialInstallerScript(scriptPath: string, log: string[]) {
    const raw = await fs.readFile(scriptPath, "utf8");
    const withoutBom = raw.replace(/^﻿/, "");
    // 不再替换 Start-GatewayIfConfigured，保持官方脚本原样。Forge 通过 hermes gateway run --replace 接管。
    await fs.writeFile(scriptPath, `﻿${withoutBom}`, "utf8");
    log.push("Hermes installer: preserved original script with UTF-8 BOM for Windows PowerShell 5.1 compatibility.");
  }

  private samePath(left: string, right: string) {
    return path.resolve(left).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(right).replace(/[\\/]+$/, "").toLowerCase();
  }

  private pythonCommandEnv(options: {
    pythonPathEntries?: string[];
    hermesHome?: string;
    extra?: Record<string, string | undefined>;
  } = {}): Record<string, string> {
    const pythonPath = this.joinPythonPath([
      ...(options.pythonPathEntries ?? []),
      ...this.pythonSiteCustomizePaths(),
      process.env.PYTHONPATH,
    ]);
    return {
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8:replace",
      PYTHONUNBUFFERED: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
      ...(options.hermesHome ? { HERMES_HOME: options.hermesHome } : {}),
      ...Object.fromEntries(Object.entries(options.extra ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    };
  }

  private pythonSiteCustomizePaths() {
    if (process.platform !== "win32") return [];
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    return [
      path.join(process.cwd(), "resources", "python-sitecustomize"),
      resourcesPath ? path.join(resourcesPath, "python-sitecustomize") : undefined,
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  private joinPythonPath(entries: Array<string | undefined>) {
    const seen = new Set<string>();
    return entries
      .flatMap((entry) => (entry ?? "").split(path.delimiter))
      .map((entry) => entry.trim())
      .filter((entry) => {
        if (!entry) return false;
        const key = path.resolve(entry).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join(path.delimiter);
  }

  private async exists(targetPath: string) {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async firstExistingPath(paths: string[]) {
    for (const candidate of paths) {
      if (await this.exists(candidate)) return candidate;
    }
    return undefined;
  }

  private prependProcessPath(entries: string[]) {
    const key = process.platform === "win32" ? "Path" : "PATH";
    const current = process.env[key] ?? process.env.PATH ?? "";
    const currentItems = current.split(path.delimiter).filter(Boolean);
    const normalized = new Set(currentItems.map((item) => path.resolve(item).toLowerCase()));
    const nextEntries = entries.filter((entry) => !normalized.has(path.resolve(entry).toLowerCase()));
    if (nextEntries.length) {
      process.env[key] = [...nextEntries, ...currentItems].join(path.delimiter);
      if (key !== "PATH") process.env.PATH = process.env[key];
    }
  }
}

function looksLikeFilePath(value: string) {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

function diagnosticHint(code: string) {
  switch (code) {
    case "powershell_unavailable":
      return "PowerShell 不可用或被策略拦截，请确认 powershell.exe 可启动后重试。";
    case "script_download_failed":
      return "安装脚本下载失败，请检查网络、代理或切换安装来源。";
    case "repo_download_failed":
      return "Hermes 仓库下载失败，请检查 GitHub 访问、仓库地址、分支/commit 或代理设置。";
    case "uv_or_venv_failed":
      return "uv 或 Python 虚拟环境创建失败，请检查 Python、磁盘权限和依赖下载网络。";
    case "system_dependency_failed":
      return "Git/Python/winget 等系统依赖安装失败，请手动安装缺失依赖或重启客户端后重试。";
    case "pip_dependency_failed":
      return "Python 依赖安装失败，请检查 pip 网络源、Python 版本和安装目录权限。";
    case "target_directory_blocked":
      return "安装目录被占用或不是可恢复的 Hermes 安装，请更换空目录或清理残留后重试。";
    case "health_check_failed":
      return "Hermes 文件已落地但 CLI 自检失败，请查看日志中的 --version/capabilities 输出。";
    default:
      return "Hermes 安装脚本执行失败，请展开实时日志定位阻塞项。";
  }
}

function installerProgressFromLine(line: string) {
  const text = line.trim();
  if (/checking .*uv|installing uv|uv python install|python 3\.11|checking python|downloading uv|extracting uv/i.test(text)) {
    return { progress: 50, message: "正在准备 uv / Python 环境。" };
  }
  if (/Git not found|PortableGit|MinGit|HERMES_GIT_BASH_PATH|Checking Git|Installing Git|downloading .*Git|extracting.*Git/i.test(text)) {
    return { progress: 56, message: "正在准备 Git / Git Bash 工具链。" };
  }
  if (/Checking Node|Node\.js|Installing Node|Downloading Node|npm|Installing.*browser/i.test(text)) {
    return { progress: 62, message: "正在准备 Node.js 与浏览器工具依赖。" };
  }
  if (/ripgrep|ffmpeg|system packages|winget|chocolatey|scoop|downloading.*package|extracting.*package/i.test(text)) {
    return { progress: 67, message: "正在准备 ripgrep / ffmpeg 等系统工具。" };
  }
  if (/download.*repository|clone|submodule|fetch|checkout|Hermes repository|git.*clone|git.*pull/i.test(text)) {
    return { progress: 72, message: "正在下载或同步 Hermes 仓库。" };
  }
  if (/Installing Hermes|uv sync|pip install|Installing Python dependencies|venv|editable install|pip.*hermes/i.test(text)) {
    return { progress: 78, message: "正在安装 Hermes Python 依赖。" };
  }
  if (/setup wizard|Skipping setup|gateway|Start messaging gateway|setup.*complete/i.test(text)) {
    return { progress: 86, message: "正在完成 Hermes 设置收尾。" };
  }
  if (/Installation complete|successfully|Next steps|Hermes is ready|All done|Enjoy|completed/i.test(text)) {
    return { progress: 90, message: "安装脚本已完成，正在等待 Forge 复检。" };
  }
  if (/error|fail|exception|timeout|cannot|unable|denied|blocked|abort/i.test(text)) {
    return { progress: 55, message: "安装脚本可能遇到问题，正在继续观察。" };
  }
  return { progress: 55, message: "安装脚本正在输出日志。" };
}

function isLegacyPosixPath(value: string) {
  return /^\/(?:root|home|mnt|tmp|var|usr|etc)(?:\/|$)/i.test(value.replace(/\\/g, "/"));
}

function psQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}
