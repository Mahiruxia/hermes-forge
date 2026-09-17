import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { AppPaths } from "../main/app-paths";
import { resolveActiveHermesHome } from "../main/hermes-home";
import type { RuntimeConfigStore } from "../main/runtime-config";
import { getDefaultInstallRoot } from "../platform";
import { runCommand, streamCommand } from "../process/command-runner";
import { managedHermesEnvironmentEnv } from "../runtime/managed-hermes-environment";
import { mergeProcessEnvironment, nativeToolEnvironment } from "../runtime/native-tool-environment";
import type { SetupDependencyRepairId } from "../shared/types";
import { resolveInstallSourceFromOption } from "./install-source";
import { MINIMUM_HERMES_VERSION } from "./hermes-version-constants";
import { isAtLeastVersion, parseHermesVersion } from "./hermes-version";
import { ensureManagedHermesEnvironment, findUvCommand, readConfiguredHermesExtras, synchronizeHermesDependencies, synchronizeHermesSource, type MaintenanceRunner } from "./hermes-maintenance";
import type { InstallStrategy } from "./install-strategy";
import type { InstallOptions, InstallPlan, InstallPublisher, InstallStrategyResult, InstallStrategyRepairResult } from "./install-types";

// Official standalone installer, pinned and verified before execution.
const UV_INSTALLER_URL = "https://astral.sh/uv/0.12.15/install.sh";
const UV_INSTALLER_SHA256 = "716a1d6844740756c68770fcec2f79c2013fb9b03869a113f61e15f6f482a6a1";

/** macOS uses native Git and a private uv/Python environment. */
export class MacosInstallStrategy implements InstallStrategy {
  readonly kind = "native" as const;
  private controller?: AbortController;

  constructor(private readonly appPaths: AppPaths, private readonly configStore: RuntimeConfigStore) {}

  async plan(): Promise<InstallPlan> {
    const git = await runCommand("git", ["--version"], { cwd: process.cwd(), timeoutMs: 15_000, env: nativeToolEnvironment(getDefaultInstallRoot("darwin")) });
    return {
      mode: "darwin", ok: git.exitCode === 0,
      summary: git.exitCode === 0 ? "使用 macOS 原生 Git、uv 和受管 Python 环境安装 Hermes。" : "请先安装 Git（xcode-select --install 或 brew install git）。",
      issues: [], steps: [],
    };
  }

  async install(publish?: InstallPublisher, options: InstallOptions = {}) { return this.run(options, publish); }
  async update() { return this.run(); }
  async cancelInstall() {
    if (!this.controller) return { ok: false, message: "当前没有正在执行的 Hermes 维护。" };
    this.controller.abort();
    return { ok: true, message: "已请求取消 Hermes 维护。" };
  }
  async repairDependency(id: SetupDependencyRepairId): Promise<InstallStrategyRepairResult> {
    const result = await this.run({}, undefined, id);
    return { ok: result.ok, id, message: result.message, logPath: result.logPath, stdout: result.log.join("\n"), plan: result.plan };
  }

  private async run(options: InstallOptions = {}, publish?: InstallPublisher, repairId?: SetupDependencyRepairId): Promise<InstallStrategyResult> {
    if (this.controller) throw new Error("Hermes 维护正在进行，请等待完成。");
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const startedAt = new Date().toISOString();
    const log: string[] = [];
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `hermes-native-${Date.now()}.log`);
    let rootPath = getDefaultInstallRoot("darwin");
    let ok = false;
    let message: string;
    let currentStage: Parameters<InstallPublisher>[0]["stage"] = "preflight";
    let currentProgress = 5;
    let currentMessage = "正在检查 macOS 安装环境。";
    const emit = (stage: Parameters<InstallPublisher>[0]["stage"], progress: number, text: string) => {
      currentStage = stage;
      currentProgress = progress;
      currentMessage = text;
      publish?.({ stage, progress, message: text, startedAt, at: new Date().toISOString() });
    };
    try {
      const config = await this.configStore.read();
      const requested = options.rootPath ?? config.enginePaths?.hermes;
      if (requested && !/^[a-z]:[\\/]/i.test(requested)) rootPath = requested;
      const source = resolveInstallSourceFromOption(config, options.source);
      emit("preflight", 5, "正在检查 macOS 安装环境。");
      const run: MaintenanceRunner = async (command, args, env) => {
        signal.throwIfAborted();
        log.push(`$ ${command} ${args.join(" ")}`);
        const report = (line: string) => publish?.({ stage: currentStage, progress: currentProgress, message: currentMessage, detail: line, logLine: line, startedAt, at: new Date().toISOString() });
        const timer = setInterval(() => report("仍在准备运行环境，首次下载可能需要几分钟；可以取消后继续。"), 10_000);
        let stdout = "";
        let stderr = "";
        let exitCode: number | null = null;
        try {
          for await (const event of streamCommand(command, args, { cwd: await fs.stat(rootPath).then(() => rootPath).catch(() => process.cwd()), timeoutMs: 30 * 60_000, env: nativeToolEnvironment(rootPath, mergeProcessEnvironment(env)), signal })) {
            if (event.type === "exit") exitCode = event.exitCode;
            else {
              if (event.type === "stdout") stdout += `${event.line}\n`;
              else stderr += `${event.line}\n`;
              log.push(event.line);
              report(event.line);
            }
          }
          signal.throwIfAborted();
          return { exitCode, stdout, stderr };
        } finally { clearInterval(timer); }
      };
      const git = await run("git", ["--version"]);
      if (git.exitCode !== 0) throw new Error("未找到 Git，请先运行 xcode-select --install 或 brew install git。");
      const entries = await fs.readdir(rootPath).catch(() => []);
      const hasGit = await fs.stat(path.join(rootPath, ".git")).then(() => true).catch(() => false);
      if (!hasGit && entries.length) throw new Error("目标目录非空且不是 Git 仓库，请选择空目录或已有 Hermes 安装。");
      const hasHermes = await fs.stat(path.join(rootPath, "run_agent.py")).then((stat) => stat.isFile()).catch(() => false);
      if (hasGit && !hasHermes && (await run("git", ["rev-parse", "--verify", "HEAD"])).exitCode === 0) {
        throw new Error("目标 Git 仓库不是 Hermes 安装，未修改；请选择空目录或已有 Hermes 安装。");
      }
      const uv = await findUvCommand(run, rootPath).catch(() => undefined);
      signal.throwIfAborted();
      if (!uv) {
        emit("downloading_script", 15, "正在自动准备 uv，无需安装 Homebrew 或系统 Python。");
        await fs.mkdir(logDir, { recursive: true });
        const scriptPath = path.join(logDir, `uv-install-${Date.now()}.sh`);
        const download = await run("/usr/bin/curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "15", "--max-time", "120", "--retry", "2", "--output", scriptPath, UV_INSTALLER_URL]);
        if (download.exitCode !== 0) throw new Error("uv 下载未完成，请检查网络后重试；已完成步骤会保留。");
        const bytes = await fs.readFile(scriptPath);
        const digest = crypto.createHash("sha256").update(bytes).digest("hex");
        if (digest !== UV_INSTALLER_SHA256) throw new Error("uv 安装脚本校验失败，未执行下载的文件。");
        log.push(`Verified ${UV_INSTALLER_URL}: SHA256 ${digest}`);
        emit("running_installer", 22, "正在安装独立 uv 工具。");
        const bootstrap = await run("/bin/sh", [scriptPath], { UV_UNMANAGED_INSTALL: path.join(path.dirname(rootPath), "bin"), UV_NO_MODIFY_PATH: "1" });
        if (bootstrap.exitCode !== 0) throw new Error("uv 安装未完成，请查看日志后重试。");
        await findUvCommand(run, rootPath);
      }
      await fs.mkdir(rootPath, { recursive: true });
      if (!hasGit) {
        if ((await run("git", ["init"])).exitCode !== 0) throw new Error("无法初始化 Hermes 仓库。");
        if ((await run("git", ["remote", "add", "origin", source.repoUrl])).exitCode !== 0) throw new Error("无法设置 Hermes 来源。");
      }
      emit("cloning", 30, "正在同步官方 Hermes 版本。");
      const commit = await synchronizeHermesSource(source, run);
      const environment = await ensureManagedHermesEnvironment(rootPath, run, "darwin");
      const extras = new Set(await readConfiguredHermesExtras(config, this.appPaths.baseDir()));
      const requestedExtras: Partial<Record<SetupDependencyRepairId, string>> = { weixin_aiohttp: "messaging", telegram_bot: "messaging", discord_py: "messaging", slack_bolt: "slack", feishu_lark_oapi: "feishu" };
      if (repairId && requestedExtras[repairId]) extras.add(requestedExtras[repairId]!);
      emit("installing_dependencies", 60, "正在同步核心、MCP 与已启用功能依赖。");
      await synchronizeHermesDependencies(environment, [...extras].sort(), run);
      emit("health_check", 90, "正在校验 Hermes CLI 与核心导入。");
      const env = managedHermesEnvironmentEnv(environment, { HERMES_HOME: await resolveActiveHermesHome(this.appPaths.hermesDir()) });
      const versionResult = await run(environment.cliPath, ["--version"], env);
      const version = parseHermesVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
      if (versionResult.exitCode !== 0 || !version || !isAtLeastVersion(version, MINIMUM_HERMES_VERSION)) throw new Error("Hermes CLI 版本检查失败。");
      const imports = await run(environment.pythonPath, ["-c", "from run_agent import AIAgent; from hermes_state import SessionDB; import hermes_logging, mcp, openai, anthropic; print('hermes-import-ok')"], env);
      if (imports.exitCode !== 0 || !imports.stdout.includes("hermes-import-ok")) throw new Error("Hermes 核心依赖导入失败。");
      await this.configStore.write({ ...config, enginePaths: { ...config.enginePaths, hermes: rootPath }, hermesRuntime: { ...config.hermesRuntime, mode: "darwin", managedRoot: rootPath, pythonCommand: environment.pythonPath, installSource: source } });
      await fs.writeFile(path.join(rootPath, ".zhenghebao-managed-install.json"), JSON.stringify({ repoUrl: source.repoUrl, branch: source.branch, commit: source.commit, installedCommit: commit, sourceLabel: source.sourceLabel, installedAt: new Date().toISOString() }, null, 2));
      ok = true;
      message = `Hermes ${version} 已就绪（${commit.slice(0, 12)}）。`;
    } catch (error) {
      message = signal.aborted ? "Hermes 维护已取消，可重新运行继续。" : `Hermes 维护未完成：${error instanceof Error ? error.message : String(error)}。可重新运行继续。`;
    } finally {
      this.controller = undefined;
    }
    emit(ok ? "completed" : signal.aborted ? "cancelled" : "failed", 100, message);
    try {
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(logPath, [message, ...log].join("\n"));
    } catch {
      // A diagnostic write failure must not replace the installation result.
    }
    return { ok, engineId: "hermes", rootPath, message, log, logPath };
  }
}
