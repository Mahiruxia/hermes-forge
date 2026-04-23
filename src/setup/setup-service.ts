import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { EngineAdapter } from "../adapters/engine-adapter";
import { runCommand } from "../process/command-runner";
import type {
  EngineMaintenanceResult,
  HermesInstallEvent,
  HermesInstallResult,
  RuntimeConfig,
  SetupCheck,
  SetupDependencyRepairId,
  SetupDependencyRepairResult,
  SetupSummary,
} from "../shared/types";
import { missingSecretMessage, normalizeOpenAiCompatibleBaseUrl, requiresStoredSecret } from "../shared/model-config";

const DEFAULT_HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

type InstallPublisher = (event: HermesInstallEvent) => void;
type PythonLauncher = { command: string; argsPrefix: string[]; label: string };
export type HermesInstallOptions = {
  rootPath?: string;
};

export class SetupService {
  private installInFlight?: Promise<HermesInstallResult>;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly hermes: EngineAdapter,
    private readonly configStore: RuntimeConfigStore,
    private readonly secretVault: SecretVault,
  ) {}

  async getSummary(workspacePath?: string): Promise<SetupSummary> {
    const config = await this.configStore.read();
    const checks: SetupCheck[] = [
      await this.checkCommand("git", ["--version"], "git", "Git", {
        statusOnFailure: "missing",
        description: "Hermes 首次自动安装需要 Git 拉取核心仓库；已安装 Hermes 的用户不一定受影响。",
        recommendedAction: "点击一键安装 Git，或手动安装 Git for Windows 后重启客户端。",
        fixAction: "install_git",
        autoFixId: "git",
        blocking: false,
      }),
      await this.checkCommand("node", ["--version"], "node", "Node.js"),
      await this.checkCommand("python", ["--version"], "python", "Python", {
        statusOnFailure: "missing",
        description: "Hermes CLI、微信连接器和部分本地桥接能力依赖 Python 运行环境。",
        recommendedAction: "点击一键安装 Python 3.12，或手动安装后确保 python 命令在 PATH 中可用。",
        fixAction: "install_python",
        autoFixId: "python",
        blocking: false,
      }),
      await this.checkWinget(),
      await this.checkHermes(),
      await this.checkPythonPackage("hermes-pyyaml", "Hermes 配置依赖", "yaml", "PyYAML", {
        description: "Hermes CLI 读取 config.yaml 时需要 PyYAML；缺失时会出现 No module named 'yaml'。",
        recommendedAction: "点击修复 Hermes 依赖，或手动执行 python -m pip install --upgrade PyYAML。",
        fixAction: "install_hermes_dependency",
        autoFixId: "hermes_pyyaml",
        blocking: true,
      }),
      await this.checkPythonPackage("weixin-aiohttp", "微信连接依赖", "aiohttp", "aiohttp"),
      await this.checkModelConfig(config),
      await this.checkWritable("user-data", "用户数据目录", this.appPaths.baseDir()),
    ];

    if (workspacePath?.trim()) {
      checks.push(await this.checkWritable("workspace", "当前工作区", workspacePath));
    }

    const suggestions = this.buildSuggestions(checks);
    const suggestionChecks = suggestions.map((message, index) => ({
      id: `suggestion-${index + 1}`,
      label: "建议",
      status: "warning" as const,
      message,
      blocking: false,
    }));
    const mergedChecks = [...checks, ...suggestionChecks];
    const blocking = mergedChecks.filter((check) =>
      check.blocking !== false && (check.status === "missing" || check.status === "failed"),
    );
    return { ready: blocking.length === 0, blocking, checks: mergedChecks };
  }

  private buildSuggestions(checks: SetupCheck[]) {
    const suggestions: string[] = [];
    const git = checks.find((check) => check.id === "git");
    const python = checks.find((check) => check.id === "python");
    const hermes = checks.find((check) => check.id === "hermes");
    const weixin = checks.find((check) => check.id === "weixin-aiohttp");
    const model = checks.find((check) => check.id === "model" || check.id === "model-placeholder" || check.id === "model-secret");
    if (git?.status !== "ok") {
      suggestions.push("首次自动安装 Hermes 需要 Git；如果客户机器没有 Git，请在系统状态页一键安装或改用手动 Hermes 路径。");
    }
    if (python?.status !== "ok") {
      suggestions.push("建议优先修复 Python 环境，否则 Hermes CLI 与更新动作可能无法正常运行。");
    }
    if (hermes?.status !== "ok") {
      suggestions.push("建议先完成 Hermes 路径和 CLI 自检，再进行真实任务执行。");
    }
    if (weixin?.status !== "ok") {
      suggestions.push("微信端需要 Python aiohttp 依赖；未安装时桌面聊天仍可用，但微信扫码/网关可能失败。");
    }
    if (model?.status !== "ok") {
      suggestions.push("建议先确认默认模型与密钥配置，避免任务启动后才失败。");
    }
    return suggestions;
  }

  async updateHermes(): Promise<EngineMaintenanceResult> {
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const hermesRoot = await this.configStore.getEnginePath("hermes");
    const hermesCli = path.join(hermesRoot, "hermes");
    log.push(`$ python ${hermesCli} update`);
    const result = await runCommand("python", [hermesCli, "update"], {
      cwd: hermesRoot,
      timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
      env: {
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: `${hermesRoot}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
        NO_COLOR: "1",
      },
    });
    if (result.stdout.trim()) log.push(result.stdout.trim());
    if (result.stderr.trim()) log.push(result.stderr.trim());
    const ok = result.exitCode === 0;
    const message = ok ? "Hermes 更新完成。" : `Hermes 更新失败：exit ${result.exitCode}`;
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `hermes-update-${startedAt.replace(/[:.]/g, "-")}.log`);
    await fs.writeFile(logPath, [message, "", ...log].join("\n"), "utf8");
    return { ok, engineId: "hermes", message, log, logPath };
  }

  async installHermes(publish?: InstallPublisher, options: HermesInstallOptions = {}): Promise<HermesInstallResult> {
    if (!this.installInFlight) {
      this.installInFlight = this.performInstallHermes(publish, options).finally(() => {
        this.installInFlight = undefined;
      });
    }
    return await this.installInFlight;
  }

  async repairDependency(id: SetupDependencyRepairId): Promise<SetupDependencyRepairResult> {
    switch (id) {
      case "git":
        return await this.repairWithWinget(id, "Git", "Git.Git");
      case "python":
        return await this.repairWithWinget(id, "Python", "Python.Python.3.12");
      case "hermes_pyyaml":
        return await this.repairPythonPackage(id, "PyYAML", "PyYAML", "请重新检查 Hermes 状态，确认 yaml 模块已可导入。");
      case "weixin_aiohttp":
        return await this.repairPythonPackage(id, "aiohttp", "aiohttp");
      default:
        return {
          ok: false,
          id,
          message: "未知依赖修复项。",
          recommendedFix: "请刷新系统状态后重试。",
        };
    }
  }

  private async performInstallHermes(publish?: InstallPublisher, options: HermesInstallOptions = {}): Promise<HermesInstallResult> {
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `hermes-install-${startedAt.replace(/[:.]/g, "-")}.log`);

    const emit = (stage: HermesInstallEvent["stage"], progress: number, message: string, detail?: string) => {
      const line = `[${stage}] ${message}${detail ? ` | ${detail}` : ""}`;
      log.push(line);
      publish?.({
        stage,
        message,
        detail,
        progress,
        startedAt,
        at: new Date().toISOString(),
      });
    };

    const finish = async (
      result: Omit<HermesInstallResult, "engineId" | "log" | "logPath">,
      stage: HermesInstallEvent["stage"],
    ) => {
      if (stage === "completed" || stage === "failed") {
        emit(stage, stage === "completed" ? 100 : 100, result.message, result.rootPath);
      }
      await this.writeInstallLog(logDir, logPath, result.message, log);
      return { ...result, engineId: "hermes" as const, log, logPath };
    };

    let stagingPath: string | undefined;
    let quarantinedPath: string | undefined;

    try {
      emit("preflight", 5, "正在检测本机环境。");
      const currentHealth = await this.hermes.healthCheck().catch((error) => {
        log.push(`Current Hermes check failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (currentHealth?.available) {
        const rootPath = currentHealth.path ?? await this.configStore.getEnginePath("hermes");
        await this.saveHermesRoot(rootPath);
        log.push(`Hermes is already available at ${rootPath}.`);
        return await finish({ ok: true, rootPath, message: `已检测到可用 Hermes：${rootPath}` }, "completed");
      }

      const repoUrl = process.env.HERMES_INSTALL_REPO_URL?.trim() || DEFAULT_HERMES_REPO_URL;
      const rootPath = options.rootPath?.trim() || process.env.HERMES_INSTALL_DIR?.trim() || this.defaultInstallRoot();
      const parentDir = path.dirname(rootPath);
      const managedDefaultPath = this.samePath(rootPath, this.defaultInstallRoot());
      log.push(`Install target: ${rootPath}`);
      log.push(`Repository: ${repoUrl}`);

      await this.assertWritableDirectory(logDir, "安装日志目录", log);
      await this.assertWritableDirectory(parentDir, "Hermes 安装父目录", log);

      const gitReady = await this.ensureGitAvailable(log, emit);
      if (!gitReady.ok) {
        return await finish({
          ok: false,
          rootPath,
          message: gitReady.message,
        }, "failed");
      }

      const pythonReady = await this.ensurePythonAvailable(log, emit);
      if (!pythonReady.ok) {
        return await finish({
          ok: false,
          rootPath,
          message: pythonReady.message,
        }, "failed");
      }
      const python = pythonReady.python;

      const targetState = await this.inspectTargetDirectory(rootPath, log);
      if (targetState.exists && targetState.hasHermesCli) {
        log.push("Target directory already contains Hermes CLI; skipping clone.");
      } else {
        if (targetState.exists && !targetState.isEmpty) {
          if (!managedDefaultPath || !targetState.recoverable) {
            return await finish({
              ok: false,
              rootPath,
              message: `目标目录已存在但看起来不是可自动恢复的 Hermes 安装：${rootPath}。请在设置里改用空目录，或手动清理后重试。`,
            }, "failed");
          }
          emit("recovering", 18, "检测到上次残留的 Hermes 安装目录，正在自动迁移旧残留。", rootPath);
          quarantinedPath = `${rootPath}.stale-${Date.now()}`;
          await fs.rename(rootPath, quarantinedPath);
          log.push(`Quarantined stale install to ${quarantinedPath}`);
        } else if (targetState.exists && targetState.isEmpty) {
          await fs.rm(rootPath, { recursive: true, force: true });
          log.push(`Removed empty target directory ${rootPath} before staging install.`);
        }

        emit("cloning", 32, "正在下载 Hermes 核心文件。", repoUrl);
        stagingPath = path.join(parentDir, `.hermes-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const clone = await this.runLogged("git", ["clone", "--depth", "1", repoUrl, stagingPath], parentDir, log, DEFAULT_INSTALL_TIMEOUT_MS, {
          heartbeatMs: 15_000,
          onHeartbeat: (elapsedSeconds) => emit("cloning", 34, "仍在下载 Hermes 核心文件，请保持网络连接。", `已等待 ${elapsedSeconds} 秒，源：${repoUrl}`),
        });
        if (clone.exitCode !== 0) {
          await this.cleanupDirectory(stagingPath, log);
          return await finish({ ok: false, rootPath, message: `Hermes 下载失败，详情见安装日志：${logPath}` }, "failed");
        }

        await fs.rename(stagingPath, rootPath);
        log.push(`Promoted staged install from ${stagingPath} to ${rootPath}`);
        stagingPath = undefined;
      }

      emit("installing_dependencies", 62, "正在安装 Hermes 运行依赖。", rootPath);
      await this.installPythonDependencies(rootPath, log, python, emit);

      emit("health_check", 82, "正在校验 Hermes 是否可启动。", rootPath);
      const localHealth = await this.checkInstalledHermes(rootPath, log, python);
      if (!localHealth.available) {
        return await finish({
          ok: false,
          rootPath,
          message: `Hermes 文件已落地到 ${rootPath}，但本地自检未通过：${localHealth.message}。详情见安装日志：${logPath}`,
        }, "failed");
      }

      await this.writeManagedMarker(rootPath, repoUrl);
      const previousHermesRoot = (await this.configStore.read()).enginePaths?.hermes;
      await this.saveHermesRoot(rootPath);

      const adapterHealth = await this.hermes.healthCheck().catch((error) => {
        log.push(`Post-install adapter health check threw: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (!adapterHealth?.available) {
        await this.restoreHermesRoot(previousHermesRoot);
        return await finish({
          ok: false,
          rootPath,
          message: `Hermes 已安装到 ${rootPath}，但客户端复检仍未通过：${adapterHealth?.message ?? "未知错误"}。详情见安装日志：${logPath}`,
        }, "failed");
      }

      return await finish({ ok: true, rootPath, message: `Hermes 已自动安装完成并通过检查：${rootPath}` }, "completed");
    } catch (error) {
      if (stagingPath) {
        await this.cleanupDirectory(stagingPath, log);
      }
      const message = error instanceof Error ? error.message : String(error);
      log.push(`Install crashed: ${message}`);
      return await finish({
        ok: false,
        message: `Hermes 自动安装失败：${message}`,
        rootPath: quarantinedPath ? path.dirname(quarantinedPath) : undefined,
      }, "failed");
    }
  }

  private async repairWithWinget(
    id: SetupDependencyRepairId,
    label: string,
    packageId: string,
  ): Promise<SetupDependencyRepairResult> {
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `dependency-${id}-${startedAt.replace(/[:.]/g, "-")}.log`);

    try {
      const winget = await this.runLogged("winget", ["--version"], process.cwd(), log, 15_000);
      if (winget.exitCode !== 0) {
        const message = "未检测到 Windows 包管理器 winget，无法自动安装系统依赖。";
        await this.writeInstallLog(logDir, logPath, message, log);
        return {
          ok: false,
          id,
          message,
          stdout: winget.stdout,
          stderr: winget.stderr,
          logPath,
          recommendedFix: `请手动安装 ${label}，安装后重启 Hermes Forge。`,
        };
      }

      const args = [
        "install",
        "--id",
        packageId,
        "-e",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ];
      const result = await this.runLogged("winget", args, process.cwd(), log, DEFAULT_INSTALL_TIMEOUT_MS);
      const ok = result.exitCode === 0;
      const message = ok
        ? `${label} 安装命令已执行完成，请重启 Hermes Forge 后重新检测。`
        : `${label} 自动安装失败，详情见修复日志：${logPath}`;
      await this.writeInstallLog(logDir, logPath, message, log);
      return {
        ok,
        id,
        message,
        command: `winget ${args.join(" ")}`,
        stdout: result.stdout,
        stderr: result.stderr,
        logPath,
        recommendedFix: ok ? "重启客户端并重新打开系统状态页确认依赖是否就绪。" : `请手动安装 ${label} 后重试。`,
      };
    } catch (error) {
      const message = `${label} 自动修复流程异常：${error instanceof Error ? error.message : String(error)}`;
      log.push(message);
      await this.writeInstallLog(logDir, logPath, message, log);
      return {
        ok: false,
        id,
        message,
        logPath,
        recommendedFix: `请手动安装 ${label} 后重启客户端。`,
      };
    }
  }

  private async repairPythonPackage(
    id: SetupDependencyRepairId,
    label: string,
    packageName: string,
    successRecommendedFix = "请重新尝试微信扫码或刷新系统状态确认依赖已就绪。",
  ): Promise<SetupDependencyRepairResult> {
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `dependency-${id}-${startedAt.replace(/[:.]/g, "-")}.log`);
    const candidates: Array<{ command: string; args: string[] }> = [
      { command: "python", args: ["-m", "pip", "install", "--upgrade", packageName] },
      { command: "py", args: ["-3", "-m", "pip", "install", "--upgrade", packageName] },
    ];

    let lastResult: Awaited<ReturnType<typeof runCommand>> | undefined;
    let lastCommand = "";
    for (const candidate of candidates) {
      lastCommand = `${candidate.command} ${candidate.args.join(" ")}`;
      const result = await this.runLogged(candidate.command, candidate.args, process.cwd(), log, DEFAULT_INSTALL_TIMEOUT_MS);
      lastResult = result;
      if (result.exitCode === 0) {
        const message = `${label} 已安装或更新完成。`;
        await this.writeInstallLog(logDir, logPath, message, log);
        return {
          ok: true,
          id,
          message,
          command: lastCommand,
          stdout: result.stdout,
          stderr: result.stderr,
          logPath,
          recommendedFix: successRecommendedFix,
        };
      }
    }

    const message = `${label} 自动安装失败，详情见修复日志：${logPath}`;
    await this.writeInstallLog(logDir, logPath, message, log);
    return {
      ok: false,
      id,
      message,
      command: lastCommand,
      stdout: lastResult?.stdout ?? "",
      stderr: lastResult?.stderr ?? "",
      logPath,
      recommendedFix: `请在终端手动执行 python -m pip install ${packageName}，或先修复 Python/pip 环境。`,
    };
  }

  private async checkHermes(): Promise<SetupCheck> {
    const health = await this.hermes.healthCheck();
    if (!health.available) {
      if (/No module named ['"]?yaml|ModuleNotFoundError.*yaml|PyYAML/i.test(health.message)) {
        return {
          id: "hermes",
          label: "Hermes",
          status: "missing",
          message: `Hermes 未完全就绪：${health.message}`,
          description: "Hermes CLI 已存在，但当前 Python 环境缺少 PyYAML，导致读取 config.yaml 时崩溃。",
          recommendedAction: "点击修复 Hermes 依赖，或手动执行 python -m pip install --upgrade PyYAML。",
          fixAction: "install_hermes_dependency",
          autoFixId: "hermes_pyyaml",
          canAutoFix: true,
          blocking: true,
        };
      }
      return {
        id: "hermes",
        label: "Hermes",
        status: "missing",
        message: `Hermes 未完全就绪：${health.message}`,
        description: "核心 Agent 未就绪时，桌面端可以打开配置页，但无法可靠执行真实任务。",
        recommendedAction: "优先点击自动安装 Hermes；如果已经手动安装，请在常规设置里指定 Hermes 根目录。",
        fixAction: "install_hermes",
        blocking: true,
      };
    }

    const memoryDir = path.join(os.homedir(), ".hermes", "memories");
    await fs.mkdir(memoryDir, { recursive: true }).catch(() => undefined);
    return {
      id: "hermes",
      label: "Hermes",
      status: "ok",
      message: `${health.message} 记忆目录：${memoryDir}`,
      blocking: false,
    };
  }

  private async checkModelConfig(config: RuntimeConfig): Promise<SetupCheck> {
    const profile = config.modelProfiles.find((item) => item.id === config.defaultModelProfileId) ?? config.modelProfiles[0];
    if (!profile) {
      return {
        id: "model",
        label: "模型配置",
        status: "missing",
        message: "尚未配置默认模型。",
        fixAction: "configure_model",
        blocking: true,
      };
    }
    if (profile.provider === "local" && profile.model === "mock-model") {
      return {
        id: "model-placeholder",
        label: "模型配置",
        status: "warning",
        message: "当前默认模型仍是示例占位配置 mock-model，请在设置中改成真实可用模型。",
        fixAction: "configure_model",
        blocking: false,
      };
    }
    if (profile.provider === "custom") {
      try {
        normalizeOpenAiCompatibleBaseUrl(profile.baseUrl);
      } catch {
        return {
          id: "model",
          label: "模型配置",
          status: "missing",
          message: "本地/自定义模型缺少有效 Base URL，请填写例如 http://127.0.0.1:1234/v1。",
          fixAction: "configure_model",
          blocking: true,
        };
      }
    }
    if (requiresStoredSecret(profile) && (!profile.secretRef || !(await this.secretVault.hasSecret(profile.secretRef)))) {
      return {
        id: "model-secret",
        label: "模型密钥",
        status: "missing",
        message: missingSecretMessage(profile),
        fixAction: "configure_model",
        blocking: true,
      };
    }
    return {
      id: "model",
      label: "模型配置",
      status: "ok",
      message: `默认模型：${profile.provider}/${profile.model}`,
      blocking: false,
    };
  }

  private async checkWritable(id: string, label: string, targetPath: string): Promise<SetupCheck> {
    try {
      await fs.mkdir(targetPath, { recursive: true });
      const probe = path.join(targetPath, `.zhenghebao-write-test-${Date.now()}`);
      await fs.writeFile(probe, "ok", "utf8");
      await fs.unlink(probe);
      return { id, label, status: "ok", message: `${targetPath} 可写。`, blocking: false };
    } catch (error) {
      return {
        id,
        label,
        status: "failed",
        message: `${targetPath} 不可写：${error instanceof Error ? error.message : "未知错误"}`,
        fixAction: "open_settings",
        blocking: true,
      };
    }
  }

  private async ensureGitAvailable(log: string[], emit: (stage: HermesInstallEvent["stage"], progress: number, message: string, detail?: string) => void) {
    const git = await this.runLogged("git", ["--version"], process.cwd(), log, 15_000);
    if (git.exitCode === 0) {
      return { ok: true, message: "Git 可用。" };
    }

    emit("repairing_dependencies", 12, "未检测到 Git，正在尝试自动安装 Git。", "将通过 winget 安装 Git.Git。");
    const repair = await this.repairWithWinget("git", "Git", "Git.Git");
    log.push(`Git repair result: ${repair.message}`);
    if (!repair.ok) {
      return {
        ok: false,
        message: `无法自动安装 Hermes：未检测到可用 Git，且自动安装 Git 失败。${repair.recommendedFix ?? "请手动安装 Git for Windows 后重启客户端。"}`,
      };
    }

    emit("preflight", 18, "Git 安装命令已完成，正在重新检测。", repair.recommendedFix);
    const recheck = await this.runLogged("git", ["--version"], process.cwd(), log, 15_000);
    if (recheck.exitCode === 0) {
      return { ok: true, message: "Git 已可用。" };
    }
    return {
      ok: false,
      message: "Git 安装命令已执行，但当前进程仍未检测到 git 命令。请重启 Hermes Forge，或手动确认 Git 已加入 PATH。",
    };
  }

  private async ensurePythonAvailable(log: string[], emit: (stage: HermesInstallEvent["stage"], progress: number, message: string, detail?: string) => void): Promise<{ ok: true; python: PythonLauncher; message: string } | { ok: false; message: string; python?: undefined }> {
    const detected = await this.detectPythonLauncher(log);
    if (detected) {
      return { ok: true, python: detected, message: `${detected.label} 可用。` };
    }

    emit("repairing_dependencies", 20, "未检测到 Python，正在尝试自动安装 Python。", "将通过 winget 安装 Python.Python.3.12。");
    const repair = await this.repairWithWinget("python", "Python", "Python.Python.3.12");
    log.push(`Python repair result: ${repair.message}`);
    if (!repair.ok) {
      return {
        ok: false,
        message: `无法自动安装 Hermes：未检测到可用 Python，且自动安装 Python 失败。${repair.recommendedFix ?? "请手动安装 Python 后重启客户端。"}`,
      };
    }

    emit("preflight", 26, "Python 安装命令已完成，正在重新检测。", repair.recommendedFix);
    const recheck = await this.detectPythonLauncher(log);
    if (recheck) {
      return { ok: true, python: recheck, message: `${recheck.label} 已可用。` };
    }
    return {
      ok: false,
      message: "Python 安装命令已执行，但当前进程仍未检测到 python/py 命令。请重启 Hermes Forge，或手动确认 Python 已加入 PATH。",
    };
  }

  private async detectPythonLauncher(log: string[]): Promise<PythonLauncher | undefined> {
    const candidates: PythonLauncher[] = [
      { command: "python", argsPrefix: [], label: "python" },
      { command: "py", argsPrefix: ["-3"], label: "py -3" },
    ];
    for (const candidate of candidates) {
      const result = await this.runLogged(candidate.command, [...candidate.argsPrefix, "--version"], process.cwd(), log, 15_000);
      if (result.exitCode === 0) {
        return candidate;
      }
    }
    return undefined;
  }

  private async installPythonDependencies(
    rootPath: string,
    log: string[],
    python: PythonLauncher,
    emit?: (stage: HermesInstallEvent["stage"], progress: number, message: string, detail?: string) => void,
  ) {
    if (await this.exists(path.join(rootPath, "pyproject.toml"))) {
      const result = await this.runLogged(python.command, [...python.argsPrefix, "-m", "pip", "install", "-e", "."], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS, {
        heartbeatMs: 15_000,
        onHeartbeat: (elapsedSeconds) => emit?.("installing_dependencies", 68, "仍在安装 Hermes Python 依赖。", `已等待 ${elapsedSeconds} 秒，使用 ${python.label}`),
      });
      if (result.exitCode !== 0) {
        log.push("Editable pip install failed; continuing to health check so the user gets a precise runtime error.");
      }
      return;
    }
    if (await this.exists(path.join(rootPath, "requirements.txt"))) {
      const result = await this.runLogged(python.command, [...python.argsPrefix, "-m", "pip", "install", "-r", "requirements.txt"], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS, {
        heartbeatMs: 15_000,
        onHeartbeat: (elapsedSeconds) => emit?.("installing_dependencies", 68, "仍在安装 Hermes Python 依赖。", `已等待 ${elapsedSeconds} 秒，使用 ${python.label}`),
      });
      if (result.exitCode !== 0) {
        log.push("requirements.txt pip install failed; continuing to health check so the user gets a precise runtime error.");
      }
    }
  }

  private async saveHermesRoot(rootPath: string) {
    const config = await this.configStore.read();
    await this.configStore.write({
      ...config,
      enginePaths: {
        ...(config.enginePaths ?? {}),
        hermes: rootPath,
      },
    });
  }

  private async restoreHermesRoot(previousRootPath?: string) {
    const config = await this.configStore.read();
    const nextEnginePaths = { ...(config.enginePaths ?? {}) };
    if (previousRootPath?.trim()) {
      nextEnginePaths.hermes = previousRootPath;
    } else {
      delete nextEnginePaths.hermes;
    }
    await this.configStore.write({
      ...config,
      enginePaths: nextEnginePaths,
    });
  }

  private async runLogged(
    command: string,
    args: string[],
    cwd: string,
    log: string[],
    timeoutMs: number,
    heartbeat?: { heartbeatMs: number; onHeartbeat: (elapsedSeconds: number) => void },
  ) {
    log.push(`$ ${command} ${args.join(" ")}`);
    const startedAt = Date.now();
    const timer = heartbeat
      ? setInterval(() => {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          log.push(`[heartbeat] ${command} still running after ${elapsedSeconds}s`);
          heartbeat.onHeartbeat(elapsedSeconds);
        }, heartbeat.heartbeatMs)
      : undefined;
    const result = await runCommand(command, args, { cwd, timeoutMs });
    if (timer) {
      clearInterval(timer);
    }
    if (result.stdout.trim()) log.push(result.stdout.trim());
    if (result.stderr.trim()) log.push(result.stderr.trim());
    log.push(`exit ${result.exitCode ?? "unknown"}`);
    return result;
  }

  private async checkCommand(
    id: string,
    args: string[],
    checkId: string,
    label: string,
    options: {
      statusOnFailure?: SetupCheck["status"];
      description?: string;
      recommendedAction?: string;
      fixAction?: SetupCheck["fixAction"];
      autoFixId?: SetupDependencyRepairId;
      blocking?: boolean;
    } = {},
  ): Promise<SetupCheck> {
    const result = await runCommand(id, args, { cwd: process.cwd(), timeoutMs: 8000 });
    const ok = result.exitCode === 0;
    return {
      id: checkId,
      label,
      status: ok ? "ok" : options.statusOnFailure ?? "warning",
      message:
        ok
          ? (result.stdout || result.stderr).trim() || `${label} 可用。`
          : `${label} 检测失败：${result.stderr || result.stdout}。建议先修复该基础环境后再运行 Hermes 任务。`,
      description: options.description,
      recommendedAction: ok ? undefined : options.recommendedAction,
      fixAction: ok ? undefined : options.fixAction,
      canAutoFix: ok ? undefined : Boolean(options.autoFixId),
      autoFixId: ok ? undefined : options.autoFixId,
      blocking: options.blocking ?? false,
    };
  }

  private async checkWinget(): Promise<SetupCheck> {
    if (process.platform !== "win32") {
      return {
        id: "winget",
        label: "Windows 包管理器",
        status: "ok",
        message: "当前不是 Windows 打包环境，跳过 winget 检测。",
        description: "winget 仅用于 Windows 客户端的一键安装 Git/Python。",
        blocking: false,
      };
    }

    const result = await runCommand("winget", ["--version"], { cwd: process.cwd(), timeoutMs: 8000 });
    const ok = result.exitCode === 0;
    return {
      id: "winget",
      label: "Windows 包管理器",
      status: ok ? "ok" : "warning",
      message: ok
        ? (result.stdout || result.stderr).trim() || "winget 可用。"
        : `winget 检测失败：${result.stderr || result.stdout || "系统未返回详细信息"}`,
      description: "Git/Python 的一键修复依赖 winget；没有 winget 时仍可手动安装依赖。",
      recommendedAction: ok ? undefined : "请在 Microsoft Store 更新“应用安装程序”，或手动安装 Git/Python。",
      blocking: false,
    };
  }

  private async checkPythonPackage(
    id: string,
    label: string,
    moduleName: string,
    packageName: string,
    options: Partial<Pick<SetupCheck, "description" | "recommendedAction" | "fixAction" | "autoFixId" | "blocking">> = {},
  ): Promise<SetupCheck> {
    const script = `import ${moduleName}; print("${packageName} ok")`;
    const result = await runCommand("python", ["-c", script], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      env: {
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        NO_COLOR: "1",
      },
    });
    const ok = result.exitCode === 0;
    return {
      id,
      label,
      status: ok ? "ok" : "warning",
      message: ok
        ? (result.stdout || result.stderr).trim() || `${label} 可用。`
        : `${label} 缺失或不可用：${result.stderr || result.stdout || "Python 无法导入该模块"}`,
      description: options.description ?? "微信二维码登录与本地网关的部分异步 HTTP 能力依赖该 Python 包。",
      recommendedAction: ok ? undefined : options.recommendedAction ?? `点击修复微信依赖，或手动执行 python -m pip install ${packageName}。`,
      fixAction: ok ? undefined : options.fixAction ?? "install_weixin_dependency",
      canAutoFix: ok ? undefined : true,
      autoFixId: ok ? undefined : options.autoFixId ?? "weixin_aiohttp",
      blocking: options.blocking ?? false,
    };
  }

  private async inspectTargetDirectory(rootPath: string, log: string[]) {
    try {
      const entries = await fs.readdir(rootPath);
      const hasHermesCli = await this.exists(path.join(rootPath, "hermes"));
      const marker = await this.exists(path.join(rootPath, ".zhenghebao-managed-install.json"));
      const recoverableSignals = [
        ".git",
        ".zhenghebao-managed-install.json",
        "pyproject.toml",
        "requirements.txt",
        "README.md",
      ];
      const recoverable = entries.some((entry) => recoverableSignals.includes(entry));
      return {
        exists: true,
        isEmpty: entries.length === 0,
        hasHermesCli,
        recoverable: marker || recoverable,
      };
    } catch (error) {
      const code = this.errorCode(error);
      if (code === "ENOENT") {
        return { exists: false, isEmpty: true, hasHermesCli: false, recoverable: false };
      }
      throw new Error(`无法访问安装目录 ${rootPath}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async assertWritableDirectory(targetPath: string, label: string, log: string[]) {
    try {
      await fs.mkdir(targetPath, { recursive: true });
      const probe = path.join(targetPath, `.zhenghebao-install-probe-${Date.now()}`);
      await fs.writeFile(probe, "ok", "utf8");
      await fs.unlink(probe);
      log.push(`${label} 可写：${targetPath}`);
    } catch (error) {
      throw new Error(`${label} 不可写：${targetPath}。${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  private async checkInstalledHermes(rootPath: string, log: string[], preferredPython?: PythonLauncher) {
    const cliPath = path.join(rootPath, "hermes");
    if (!(await this.exists(cliPath))) {
      return { available: false, message: `未找到 Hermes CLI：${cliPath}` };
    }

    const candidates: Array<{ command: string; args: string[] }> = [
      ...(preferredPython ? [{ command: preferredPython.command, args: [...preferredPython.argsPrefix, cliPath, "--version"] }] : []),
      { command: "python", args: [cliPath, "--version"] },
      { command: "py", args: ["-3", cliPath, "--version"] },
    ];
    let lastMessage = "未找到可用 Python 解释器。";
    for (const candidate of candidates) {
      const result = await runCommand(candidate.command, candidate.args, {
        cwd: rootPath,
        timeoutMs: 20_000,
        env: {
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONPATH: `${rootPath}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
          NO_COLOR: "1",
        },
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      log.push(`Install health via ${candidate.command}: ${output || `exit ${result.exitCode ?? "unknown"}`}`);
      if (result.exitCode === 0) {
        return { available: true, message: output || "Hermes CLI 可启动。" };
      }
      lastMessage = output || `${candidate.command} 退出码 ${result.exitCode ?? "unknown"}`;
    }
    return { available: false, message: lastMessage };
  }

  private async writeManagedMarker(rootPath: string, repoUrl: string) {
    const markerPath = path.join(rootPath, ".zhenghebao-managed-install.json");
    await fs.writeFile(markerPath, JSON.stringify({
      source: "zhenghebao",
      repoUrl,
      installedAt: new Date().toISOString(),
    }, null, 2), "utf8");
  }

  private async writeInstallLog(logDir: string, logPath: string, message: string, log: string[]) {
    try {
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(logPath, [message, "", ...log].join("\n"), "utf8");
    } catch {
      // 日志写入失败不应吞掉主流程结果
    }
  }

  private async cleanupDirectory(targetPath: string, log: string[]) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      log.push(`Cleaned up ${targetPath}`);
    } catch (error) {
      log.push(`Failed to clean up ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private defaultInstallRoot() {
    return path.join(os.homedir(), "Hermes Agent");
  }

  private samePath(left: string, right: string) {
    return path.resolve(left).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(right).replace(/[\\/]+$/, "").toLowerCase();
  }

  private errorCode(error: unknown) {
    return typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  }

  private async exists(targetPath: string) {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}

type SecretVault = {
  hasSecret(ref: string): Promise<boolean>;
};
