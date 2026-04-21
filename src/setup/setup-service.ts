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
  SetupSummary,
} from "../shared/types";
import { missingSecretMessage, normalizeOpenAiCompatibleBaseUrl, requiresStoredSecret } from "../shared/model-config";

const DEFAULT_HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

type InstallPublisher = (event: HermesInstallEvent) => void;

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
      await this.checkCommand("git", ["--version"], "git", "Git"),
      await this.checkCommand("node", ["--version"], "node", "Node.js"),
      await this.checkCommand("python", ["--version"], "python", "Python"),
      await this.checkHermes(),
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
    const blocking = mergedChecks.filter((check) => check.status === "missing" || check.status === "failed");
    return { ready: blocking.length === 0, blocking, checks: mergedChecks };
  }

  private buildSuggestions(checks: SetupCheck[]) {
    const suggestions: string[] = [];
    const python = checks.find((check) => check.id === "python");
    const hermes = checks.find((check) => check.id === "hermes");
    const model = checks.find((check) => check.id === "model" || check.id === "model-placeholder" || check.id === "model-secret");
    if (python?.status !== "ok") {
      suggestions.push("建议优先修复 Python 环境，否则 Hermes CLI 与更新动作可能无法正常运行。");
    }
    if (hermes?.status !== "ok") {
      suggestions.push("建议先完成 Hermes 路径和 CLI 自检，再进行真实任务执行。");
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

  async installHermes(publish?: InstallPublisher): Promise<HermesInstallResult> {
    if (!this.installInFlight) {
      this.installInFlight = this.performInstallHermes(publish).finally(() => {
        this.installInFlight = undefined;
      });
    }
    return await this.installInFlight;
  }

  private async performInstallHermes(publish?: InstallPublisher): Promise<HermesInstallResult> {
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
      const rootPath = process.env.HERMES_INSTALL_DIR?.trim() || this.defaultInstallRoot();
      const parentDir = path.dirname(rootPath);
      const managedDefaultPath = this.samePath(rootPath, this.defaultInstallRoot());
      log.push(`Install target: ${rootPath}`);
      log.push(`Repository: ${repoUrl}`);

      await this.assertWritableDirectory(logDir, "安装日志目录", log);
      await this.assertWritableDirectory(parentDir, "Hermes 安装父目录", log);

      const git = await this.runLogged("git", ["--version"], process.cwd(), log, 15000);
      if (git.exitCode !== 0) {
        return await finish({
          ok: false,
          rootPath,
          message: "无法自动安装 Hermes：未检测到可用 Git。请先安装 Git，或在设置里手动指定 Hermes 路径。",
        }, "failed");
      }

      const python = await this.runLogged("python", ["--version"], process.cwd(), log, 15000);
      if (python.exitCode !== 0) {
        return await finish({
          ok: false,
          rootPath,
          message: "无法自动安装 Hermes：未检测到可用 Python。请先安装 Python，或在设置里手动指定 Hermes 路径。",
        }, "failed");
      }

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
        const clone = await this.runLogged("git", ["clone", "--depth", "1", repoUrl, stagingPath], parentDir, log, DEFAULT_INSTALL_TIMEOUT_MS);
        if (clone.exitCode !== 0) {
          await this.cleanupDirectory(stagingPath, log);
          return await finish({ ok: false, rootPath, message: `Hermes 下载失败，详情见安装日志：${logPath}` }, "failed");
        }

        await fs.rename(stagingPath, rootPath);
        log.push(`Promoted staged install from ${stagingPath} to ${rootPath}`);
        stagingPath = undefined;
      }

      emit("installing_dependencies", 62, "正在安装 Hermes 运行依赖。", rootPath);
      await this.installPythonDependencies(rootPath, log);

      emit("health_check", 82, "正在校验 Hermes 是否可启动。", rootPath);
      const localHealth = await this.checkInstalledHermes(rootPath, log);
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

  private async checkHermes(): Promise<SetupCheck> {
    const health = await this.hermes.healthCheck();
    if (!health.available) {
      return {
        id: "hermes",
        label: "Hermes",
        status: "warning",
        message: `Hermes 未完全就绪：${health.message}`,
        fixAction: "configure_hermes",
        blocking: false,
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

  private async installPythonDependencies(rootPath: string, log: string[]) {
    if (await this.exists(path.join(rootPath, "pyproject.toml"))) {
      const result = await this.runLogged("python", ["-m", "pip", "install", "-e", "."], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS);
      if (result.exitCode !== 0) {
        log.push("Editable pip install failed; continuing to health check so the user gets a precise runtime error.");
      }
      return;
    }
    if (await this.exists(path.join(rootPath, "requirements.txt"))) {
      const result = await this.runLogged("python", ["-m", "pip", "install", "-r", "requirements.txt"], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS);
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

  private async runLogged(command: string, args: string[], cwd: string, log: string[], timeoutMs: number) {
    log.push(`$ ${command} ${args.join(" ")}`);
    const result = await runCommand(command, args, { cwd, timeoutMs });
    if (result.stdout.trim()) log.push(result.stdout.trim());
    if (result.stderr.trim()) log.push(result.stderr.trim());
    log.push(`exit ${result.exitCode ?? "unknown"}`);
    return result;
  }

  private async checkCommand(id: string, args: string[], checkId: string, label: string): Promise<SetupCheck> {
    const result = await runCommand(id, args, { cwd: process.cwd(), timeoutMs: 8000 });
    return {
      id: checkId,
      label,
      status: result.exitCode === 0 ? "ok" : "warning",
      message:
        result.exitCode === 0
          ? (result.stdout || result.stderr).trim() || `${label} 可用。`
          : `${label} 检测失败：${result.stderr || result.stdout}。建议先修复该基础环境后再运行 Hermes 任务。`,
      blocking: false,
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

  private async checkInstalledHermes(rootPath: string, log: string[]) {
    const cliPath = path.join(rootPath, "hermes");
    if (!(await this.exists(cliPath))) {
      return { available: false, message: `未找到 Hermes CLI：${cliPath}` };
    }

    const candidates: Array<{ command: string; args: string[] }> = [
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
