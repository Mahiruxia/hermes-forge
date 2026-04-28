import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import { runCommand } from "../process/command-runner";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import type { RuntimeProbeService } from "../runtime/runtime-probe-service";
import { validateNativeHermesCli } from "../runtime/hermes-cli-resolver";
import type { HermesRuntimeConfig, RuntimeConfig, SetupDependencyRepairId } from "../shared/types";
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
import { buildRepoSyncSteps, resolveInstallSource } from "./install-source";
import type { InstallSource } from "./install-source";

const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

type PythonLauncher = { command: string; argsPrefix: string[]; label: string };

export class NativeInstallStrategy implements InstallStrategy {
  readonly kind = "native" as const;
  private installInFlight?: Promise<InstallStrategyResult>;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly hermes: EngineAdapter,
    private readonly configStore: RuntimeConfigStore,
    private readonly runtimeProbeService?: RuntimeProbeService,
    private readonly runtimeAdapterFactory?: RuntimeAdapterFactory,
  ) {}

  async plan(options: InstallOptions = {}): Promise<InstallPlan> {
    const runtime = { mode: "windows" as const, pythonCommand: "python3", windowsAgentMode: "hermes_native" as const };
    const probe = await this.runtimeProbeService?.probe({ runtime }).catch(() => undefined);
    const rootPath = options.rootPath?.trim() || process.env.HERMES_INSTALL_DIR?.trim() || this.defaultInstallRoot();
    const issues = probe?.issues ?? [];
    return {
      mode: "windows",
      ok: !probe || (probe.pythonAvailable && (probe.gitAvailable || probe.hermesCliExists)),
      summary: probe
        ? "Windows Native 安装策略已生成计划。"
        : "Windows Native 安装策略已生成 legacy 计划。",
      issues,
      runtimeProbe: probe,
      steps: [
        installStep({
          phase: "plan",
          step: "select-native",
          status: "passed",
          code: "native_selected",
          summary: "已选择 Windows Native 安装策略。",
          debugContext: { rootPath },
        }),
        installStep({
          phase: "preflight",
          step: "native-dependencies",
          status: probe ? "passed" : "skipped",
          code: probe ? "runtime_probe" : "legacy_fallback",
          summary: probe ? "依赖状态来自 RuntimeProbe。" : "未注入 RuntimeProbe，安装时将使用 legacy direct checks。",
          detail: probe ? `python=${probe.pythonAvailable}, git=${probe.gitAvailable}, winget=${probe.wingetAvailable}` : undefined,
        }),
      ],
    };
  }

  async update(): Promise<InstallStrategyUpdateResult> {
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const hermesRoot = await this.configStore.getEnginePath("hermes");
    const source = resolveInstallSource(await this.configStore.read());
    const mismatch = await this.detectSourceMismatch(hermesRoot, source);
    if (mismatch.stale) {
      log.push(mismatch.reason!);
      const reinstall = await this.performInstallHermes(undefined, { rootPath: hermesRoot });
      return {
        ok: reinstall.ok,
        engineId: "hermes",
        message: reinstall.message,
        log: [...log, ...reinstall.log],
        logPath: reinstall.logPath,
        plan: reinstall.plan,
      };
    }
    const launch = await this.hermesMaintenanceLaunch(hermesRoot, ["update"]);
    log.push(`$ ${launch.command} ${JSON.stringify(launch.args)}`);
    const result = await runCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
      env: launch.env,
      commandId: "install.native.hermes.update",
      runtimeKind: launch.runtimeKind,
    });
    if (result.stdout.trim()) log.push(result.stdout.trim());
    if (result.stderr.trim()) log.push(result.stderr.trim());
    const ok = result.exitCode === 0;
    const message = ok ? "Hermes 更新完成。" : `Hermes 更新失败：exit ${result.exitCode}`;
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `hermes-update-${startedAt.replace(/[:.]/g, "-")}.log`);
    await fs.writeFile(logPath, [message, "", ...log].join("\n"), "utf8");
    return { ok, engineId: "hermes", message, log, logPath, plan: await this.plan({ mode: "windows" }) };
  }

  async install(publish?: InstallPublisher, options: InstallOptions = {}): Promise<InstallStrategyResult> {
    if (!this.installInFlight) {
      this.installInFlight = this.performInstallHermes(publish, options).finally(() => {
        this.installInFlight = undefined;
      });
    }
    return await this.installInFlight;
  }

  async repairDependency(id: SetupDependencyRepairId): Promise<InstallStrategyRepairResult> {
    switch (id) {
      case "git":
        return await this.repairWithWinget(id, "Git", "Git.Git");
      case "python":
        return await this.repairWithWinget(id, "Python", "Python.Python.3.12");
      case "hermes_pyyaml":
        return await this.repairPythonPackage(id, "PyYAML", "PyYAML", "请重新检查 Hermes 状态，确认 yaml 模块已可导入。");
      case "hermes_python_dotenv":
        return await this.repairPythonPackage(id, "python-dotenv", "python-dotenv", "请重新检查 Hermes 状态，确认 dotenv 模块已可导入。");
      case "weixin_aiohttp":
        return await this.repairPythonPackage(id, "aiohttp", "aiohttp");
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

  private async hermesMaintenanceLaunch(hermesRoot: string, args: string[]) {
    if (this.runtimeAdapterFactory) {
      const config = await this.configStore.read();
      const runtime = {
        mode: "windows" as const,
        distro: config.hermesRuntime?.distro?.trim() || undefined,
        pythonCommand: config.hermesRuntime?.pythonCommand?.trim() || "python3",
        windowsAgentMode: config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
      } satisfies NonNullable<RuntimeConfig["hermesRuntime"]>;
      const adapter = this.runtimeAdapterFactory(runtime);
      const runtimeRoot = adapter.toRuntimePath(hermesRoot);
      return await adapter.buildHermesLaunch({
        runtime,
        rootPath: runtimeRoot,
        pythonArgs: [path.join(hermesRoot, "hermes"), ...args],
        cwd: hermesRoot,
        env: {
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONPATH: runtimeRoot,
          NO_COLOR: "1",
        },
      });
    }
    const hermesCli = path.join(hermesRoot, "hermes");
    return {
      command: "python",
      args: [hermesCli, ...args],
      cwd: hermesRoot,
      env: {
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: `${hermesRoot}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
        NO_COLOR: "1",
      },
      runtimeKind: "windows" as const,
    };
  }

  private async performInstallHermes(publish?: InstallPublisher, options: InstallOptions = {}): Promise<InstallStrategyResult> {
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `hermes-install-${startedAt.replace(/[:.]/g, "-")}.log`);

    const emit = (stage: Parameters<InstallPublisher>[0]["stage"], progress: number, message: string, detail?: string) => {
      const line = `[${stage}] ${message}${detail ? ` | ${detail}` : ""}`;
      log.push(line);
      publish?.({ stage, message, detail, progress, startedAt, at: new Date().toISOString() });
    };

    const finish = async (
      result: Omit<InstallStrategyResult, "engineId" | "log" | "logPath" | "plan">,
      stage: Parameters<InstallPublisher>[0]["stage"],
    ) => {
      if (stage === "completed" || stage === "failed") {
        emit(stage, 100, result.message, result.rootPath);
      }
      await this.writeInstallLog(logDir, logPath, result.message, log);
      return { ...result, engineId: "hermes" as const, log, logPath, plan: await this.plan({ rootPath: result.rootPath, mode: "windows" }) };
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
        const currentSource = resolveInstallSource(await this.configStore.read());
        const mismatch = await this.detectSourceMismatch(rootPath, currentSource);
        if (mismatch.stale) {
          log.push(mismatch.reason!);
          quarantinedPath = `${rootPath}.stale-${Date.now()}`;
          await fs.rename(rootPath, quarantinedPath);
          log.push(`Quarantined stale install to ${quarantinedPath}`);
          // Fall through to reinstall
        } else {
          await this.saveHermesRoot(rootPath);
          log.push(`Hermes is already available at ${rootPath}.`);
          return await finish({ ok: true, rootPath, message: `已检测到可用 Hermes：${rootPath}` }, "completed");
        }
      }

      const source = resolveInstallSource(await this.configStore.read());
      const rootPath = options.rootPath?.trim() || process.env.HERMES_INSTALL_DIR?.trim() || this.defaultInstallRoot();
      const parentDir = path.dirname(rootPath);
      const managedDefaultPath = this.samePath(rootPath, this.defaultInstallRoot());
      log.push(`Install target: ${rootPath}`);
      log.push(`Source: ${source.sourceLabel} ${source.commit ?? source.branch ?? source.repoUrl}`);

      await this.assertWritableDirectory(logDir, "安装日志目录", log);
      await this.assertWritableDirectory(parentDir, "Hermes 安装父目录", log);

      const gitReady = await this.ensureGitAvailable(log, emit);
      if (!gitReady.ok) return await finish({ ok: false, rootPath, message: gitReady.message }, "failed");

      const pythonReady = await this.ensurePythonAvailable(log, emit);
      if (!pythonReady.ok) return await finish({ ok: false, rootPath, message: pythonReady.message }, "failed");
      const python = pythonReady.python;

      const targetState = await this.inspectTargetDirectory(rootPath, log);
      if (!targetState.exists || !targetState.hasHermesCli) {
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

        emit("cloning", 32, "正在下载 Hermes 核心文件。", source.repoUrl);
        stagingPath = path.join(parentDir, `.hermes-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const syncSteps = buildRepoSyncSteps({ root: stagingPath, repoUrl: source.repoUrl, branch: source.branch, commit: source.commit, existing: false });
        for (const step of syncSteps) {
          const result = await this.runLogged(step.program, step.args, step.cwd ?? parentDir, log, DEFAULT_INSTALL_TIMEOUT_MS, {
            heartbeatMs: 15_000,
            onHeartbeat: (elapsedSeconds) => emit("cloning", 34, "仍在下载 Hermes 核心文件，请保持网络连接。", `已等待 ${elapsedSeconds} 秒，源：${source.repoUrl}`),
          });
          if (result.exitCode !== 0) {
            await this.cleanupDirectory(stagingPath, log);
            return await finish({ ok: false, rootPath, message: `Hermes 下载失败，详情见安装日志：${logPath}` }, "failed");
          }
        }
        await fs.rename(stagingPath, rootPath);
        log.push(`Promoted staged install from ${stagingPath} to ${rootPath}`);
        stagingPath = undefined;
      } else {
        log.push("Target directory already contains Hermes CLI; skipping clone.");
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

      await this.writeManagedMarker(rootPath, source);
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
      if (stagingPath) await this.cleanupDirectory(stagingPath, log);
      const message = error instanceof Error ? error.message : String(error);
      log.push(`Install crashed: ${message}`);
      return await finish({
        ok: false,
        message: `Hermes 自动安装失败：${message}`,
        rootPath: quarantinedPath ? path.dirname(quarantinedPath) : undefined,
      }, "failed");
    }
  }

  private async repairWithWinget(id: SetupDependencyRepairId, label: string, packageId: string): Promise<InstallStrategyRepairResult> {
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `dependency-${id}-${startedAt.replace(/[:.]/g, "-")}.log`);
    try {
      const winget = await this.runLogged("winget", ["--version"], process.cwd(), log, 15_000);
      if (winget.exitCode !== 0) {
        const message = "未检测到 Windows 包管理器 winget，无法自动安装系统依赖。";
        await this.writeInstallLog(logDir, logPath, message, log);
        return { ok: false, id, message, stdout: winget.stdout, stderr: winget.stderr, logPath, recommendedFix: `请手动安装 ${label}，安装后重启 Hermes Forge。`, plan: await this.plan() };
      }
      const args = ["install", "--id", packageId, "-e", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements"];
      const result = await this.runLogged("winget", args, process.cwd(), log, DEFAULT_INSTALL_TIMEOUT_MS);
      const ok = result.exitCode === 0;
      const message = ok ? `${label} 安装命令已执行完成，请重启 Hermes Forge 后重新检测。` : `${label} 自动安装失败，详情见修复日志：${logPath}`;
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
        plan: await this.plan(),
      };
    } catch (error) {
      const message = `${label} 自动修复流程异常：${error instanceof Error ? error.message : String(error)}`;
      log.push(message);
      await this.writeInstallLog(logDir, logPath, message, log);
      return { ok: false, id, message, logPath, recommendedFix: `请手动安装 ${label} 后重启客户端。`, plan: await this.plan() };
    }
  }

  private async repairPythonPackage(id: SetupDependencyRepairId, label: string, packageName: string, successRecommendedFix = "请重新尝试微信扫码或刷新系统状态确认依赖已就绪。"): Promise<InstallStrategyRepairResult> {
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `dependency-${id}-${startedAt.replace(/[:.]/g, "-")}.log`);
    const config = await this.configStore.read().catch(() => undefined);
    const rootPath = await this.configStore.getEnginePath("hermes").catch(() => this.defaultInstallRoot());
    const runtime: HermesRuntimeConfig = {
      mode: "windows" as const,
      pythonCommand: config?.hermesRuntime?.pythonCommand?.trim() || "python3",
      windowsAgentMode: config?.hermesRuntime?.windowsAgentMode ?? "hermes_native",
    };
    const probe = await this.runtimeProbeService?.probe({ runtime }).catch(() => undefined);
    const candidates: Array<{ command: string; args: string[]; label: string }> = [];
    const addCandidate = (command: string | undefined, argsPrefix: string[] | undefined, label: string) => {
      if (!command?.trim()) return;
      const args = [...(argsPrefix ?? []), "-m", "pip", "install", "--upgrade", packageName];
      if (!candidates.some((candidate) => candidate.command === command && candidate.args.join("\0") === args.join("\0"))) {
        candidates.push({ command, args, label });
      }
    };
    addCandidate(probe?.commands.python.command, probe?.commands.python.args, probe?.commands.python.label ?? "RuntimeProbe Python");
    addCandidate(runtime.pythonCommand, undefined, runtime.pythonCommand ?? "python3");
    addCandidate(path.join(rootPath, ".venv", "Scripts", "python.exe"), undefined, ".venv Python");
    addCandidate(path.join(rootPath, "venv", "Scripts", "python.exe"), undefined, "venv Python");
    for (const fallback of [
      { command: "python", args: ["-m", "pip", "install", "--upgrade", packageName] },
      { command: "py", args: ["-3", "-m", "pip", "install", "--upgrade", packageName] },
    ]) {
      if (!candidates.some((candidate) => candidate.command === fallback.command && candidate.args.join("\0") === fallback.args.join("\0"))) {
        candidates.push({ ...fallback, label: fallback.command === "py" ? "py -3" : fallback.command });
      }
    }
    let lastResult: Awaited<ReturnType<typeof runCommand>> | undefined;
    let lastCommand = "";
    for (const candidate of candidates) {
      if (looksLikeFilePath(candidate.command) && !(await this.exists(candidate.command))) {
        log.push(`${candidate.label}: 文件不存在，跳过。`);
        continue;
      }
      lastCommand = `${candidate.command} ${candidate.args.join(" ")}`;
      const result = await this.runLogged(candidate.command, candidate.args, rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS);
      lastResult = result;
      if (result.exitCode === 0) {
        const message = `${label} 已安装或更新完成。`;
        await this.writeInstallLog(logDir, logPath, message, log);
        return { ok: true, id, message, command: lastCommand, stdout: result.stdout, stderr: result.stderr, logPath, recommendedFix: successRecommendedFix, plan: await this.plan() };
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
      plan: await this.plan(),
    };
  }

  private async ensureGitAvailable(log: string[], emit: (stage: Parameters<InstallPublisher>[0]["stage"], progress: number, message: string, detail?: string) => void) {
    const probe = await this.runtimeProbeService?.probe({ runtime: { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" } }).catch(() => undefined);
    if (probe?.gitAvailable) {
      log.push(`RuntimeProbe Git: ${probe.commands.git.message}`);
      return { ok: true, message: "Git 可用。" };
    }
    const git = await this.runLogged("git", ["--version"], process.cwd(), log, 15_000);
    if (git.exitCode === 0) return { ok: true, message: "Git 可用。" };
    emit("repairing_dependencies", 12, "未检测到 Git，正在尝试自动安装 Git。", "将通过 winget 安装 Git.Git。");
    const repair = await this.repairWithWinget("git", "Git", "Git.Git");
    log.push(`Git repair result: ${repair.message}`);
    if (!repair.ok) {
      return { ok: false, message: `无法自动安装 Hermes：未检测到可用 Git，且自动安装 Git 失败。${repair.recommendedFix ?? "请手动安装 Git for Windows 后重启客户端。"}` };
    }
    emit("preflight", 18, "Git 安装命令已完成，正在重新检测。", repair.recommendedFix);
    const recheck = await this.runLogged("git", ["--version"], process.cwd(), log, 15_000);
    return recheck.exitCode === 0
      ? { ok: true, message: "Git 已可用。" }
      : { ok: false, message: "Git 安装命令已执行，但当前进程仍未检测到 git 命令。请重启 Hermes Forge，或手动确认 Git 已加入 PATH。" };
  }

  private async ensurePythonAvailable(log: string[], emit: (stage: Parameters<InstallPublisher>[0]["stage"], progress: number, message: string, detail?: string) => void): Promise<{ ok: true; python: PythonLauncher; message: string } | { ok: false; message: string; python?: undefined }> {
    const probe = await this.runtimeProbeService?.probe({ runtime: { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" } }).catch(() => undefined);
    if (probe?.runtimeMode === "windows" && probe.commands.python.available && probe.commands.python.command) {
      const python = { command: probe.commands.python.command, argsPrefix: probe.commands.python.args ?? [], label: probe.commands.python.label ?? probe.commands.python.command };
      log.push(`RuntimeProbe Python: ${probe.commands.python.message}`);
      return { ok: true, python, message: `${python.label} 可用。` };
    }
    const detected = await this.detectPythonLauncher(log);
    if (detected) return { ok: true, python: detected, message: `${detected.label} 可用。` };
    emit("repairing_dependencies", 20, "未检测到 Python，正在尝试自动安装 Python。", "将通过 winget 安装 Python.Python.3.12。");
    const repair = await this.repairWithWinget("python", "Python", "Python.Python.3.12");
    log.push(`Python repair result: ${repair.message}`);
    if (!repair.ok) {
      return { ok: false, message: `无法自动安装 Hermes：未检测到可用 Python，且自动安装 Python 失败。${repair.recommendedFix ?? "请手动安装 Python 后重启客户端。"}` };
    }
    emit("preflight", 26, "Python 安装命令已完成，正在重新检测。", repair.recommendedFix);
    const recheck = await this.detectPythonLauncher(log);
    return recheck
      ? { ok: true, python: recheck, message: `${recheck.label} 已可用。` }
      : { ok: false, message: "Python 安装命令已执行，但当前进程仍未检测到 python/py 命令。请重启 Hermes Forge，或手动确认 Python 已加入 PATH。" };
  }

  private async detectPythonLauncher(log: string[]): Promise<PythonLauncher | undefined> {
    const candidates: PythonLauncher[] = [{ command: "python", argsPrefix: [], label: "python" }, { command: "py", argsPrefix: ["-3"], label: "py -3" }];
    for (const candidate of candidates) {
      const result = await this.runLogged(candidate.command, [...candidate.argsPrefix, "--version"], process.cwd(), log, 15_000);
      if (result.exitCode === 0) return candidate;
    }
    return undefined;
  }

  private async installPythonDependencies(rootPath: string, log: string[], python: PythonLauncher, emit?: (stage: Parameters<InstallPublisher>[0]["stage"], progress: number, message: string, detail?: string) => void) {
    if (await this.exists(path.join(rootPath, "pyproject.toml"))) {
      const result = await this.runLogged(python.command, [...python.argsPrefix, "-m", "pip", "install", "-e", "."], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS, {
        heartbeatMs: 15_000,
        onHeartbeat: (elapsedSeconds) => emit?.("installing_dependencies", 68, "仍在安装 Hermes Python 依赖。", `已等待 ${elapsedSeconds} 秒，使用 ${python.label}`),
      });
      if (result.exitCode !== 0) log.push("Editable pip install failed; continuing to health check so the user gets a precise runtime error.");
      return;
    }
    if (await this.exists(path.join(rootPath, "requirements.txt"))) {
      const result = await this.runLogged(python.command, [...python.argsPrefix, "-m", "pip", "install", "-r", "requirements.txt"], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS, {
        heartbeatMs: 15_000,
        onHeartbeat: (elapsedSeconds) => emit?.("installing_dependencies", 68, "仍在安装 Hermes Python 依赖。", `已等待 ${elapsedSeconds} 秒，使用 ${python.label}`),
      });
      if (result.exitCode !== 0) log.push("requirements.txt pip install failed; continuing to health check so the user gets a precise runtime error.");
    }
  }

  private async saveHermesRoot(rootPath: string) {
    const config = await this.configStore.read();
    await this.configStore.write({ ...config, enginePaths: { ...(config.enginePaths ?? {}), hermes: rootPath } });
  }

  private async restoreHermesRoot(previousRootPath?: string) {
    const config = await this.configStore.read();
    const nextEnginePaths = { ...(config.enginePaths ?? {}) };
    if (previousRootPath?.trim()) nextEnginePaths.hermes = previousRootPath;
    else delete nextEnginePaths.hermes;
    await this.configStore.write({ ...config, enginePaths: nextEnginePaths });
  }

  private async runLogged(command: string, args: string[], cwd: string, log: string[], timeoutMs: number, heartbeat?: { heartbeatMs: number; onHeartbeat: (elapsedSeconds: number) => void }) {
    log.push(`$ ${command} ${args.join(" ")}`);
    const startedAt = Date.now();
    const timer = heartbeat ? setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      log.push(`[heartbeat] ${command} still running after ${elapsedSeconds}s`);
      heartbeat.onHeartbeat(elapsedSeconds);
    }, heartbeat.heartbeatMs) : undefined;
    const result = await runCommand(command, args, { cwd, timeoutMs });
    if (timer) clearInterval(timer);
    if (result.stdout.trim()) log.push(result.stdout.trim());
    if (result.stderr.trim()) log.push(result.stderr.trim());
    log.push(`exit ${result.exitCode ?? "unknown"}`);
    return result;
  }

  private async inspectTargetDirectory(rootPath: string, log: string[]) {
    try {
      const entries = await fs.readdir(rootPath);
      const hasHermesCli = await this.exists(path.join(rootPath, "hermes"));
      const marker = await this.exists(path.join(rootPath, ".zhenghebao-managed-install.json"));
      const recoverableSignals = [".git", ".zhenghebao-managed-install.json", "pyproject.toml", "requirements.txt", "README.md"];
      const recoverable = entries.some((entry) => recoverableSignals.includes(entry));
      return { exists: true, isEmpty: entries.length === 0, hasHermesCli, recoverable: marker || recoverable };
    } catch (error) {
      const code = this.errorCode(error);
      if (code === "ENOENT") return { exists: false, isEmpty: true, hasHermesCli: false, recoverable: false };
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

  private async detectSourceMismatch(rootPath: string, currentSource: InstallSource): Promise<{ stale: boolean; reason?: string }> {
    const markerPath = path.join(rootPath, ".zhenghebao-managed-install.json");
    const raw = await fs.readFile(markerPath, "utf8").catch(() => undefined);
    if (!raw) return { stale: false };
    try {
      const marker = JSON.parse(raw) as { repoUrl?: string; commit?: string };
      const repoMismatch = marker.repoUrl && marker.repoUrl !== currentSource.repoUrl;
      const commitMismatch = Boolean(currentSource.commit) && marker.commit !== currentSource.commit;
      if (repoMismatch || commitMismatch) {
        return {
          stale: true,
          reason: `Detected stale install: source moved from ${marker.repoUrl ?? "unknown"}@${marker.commit ?? "unknown"} to ${currentSource.repoUrl}@${currentSource.commit ?? currentSource.branch ?? "main"}`,
        };
      }
      return { stale: false };
    } catch {
      return { stale: false };
    }
  }

  private async checkInstalledHermes(rootPath: string, log: string[], preferredPython?: PythonLauncher) {
    const cliPath = path.join(rootPath, "hermes");
    if (!(await this.exists(cliPath))) return { available: false, message: `未找到 Hermes CLI：${cliPath}` };
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
        env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONPATH: `${rootPath}${path.delimiter}${process.env.PYTHONPATH ?? ""}`, NO_COLOR: "1" },
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      log.push(`Install health via ${candidate.command}: ${output || `exit ${result.exitCode ?? "unknown"}`}`);
      if (result.exitCode === 0) {
        if (this.runtimeAdapterFactory) {
          const adapter = this.runtimeAdapterFactory({
            mode: "windows",
            pythonCommand: preferredPython?.command ?? "python3",
            windowsAgentMode: "hermes_native",
          });
          const validation = await validateNativeHermesCli(adapter, cliPath);
          if (!validation.ok) {
            log.push(`Capability check failed: ${validation.message}`);
            return {
              available: false,
              message: `已安装 Hermes 但缺少 Forge 所需 launch-metadata/resume capability。${validation.message}`,
            };
          }
          log.push(`Capability check passed: ${validation.capabilities.cliVersion ?? "unknown"}`);
        }
        return { available: true, message: output || "Hermes CLI 可启动。" };
      }
      lastMessage = output || `${candidate.command} 退出码 ${result.exitCode ?? "unknown"}`;
    }
    return { available: false, message: lastMessage };
  }

  private async writeManagedMarker(rootPath: string, source: InstallSource) {
    const markerPath = path.join(rootPath, ".zhenghebao-managed-install.json");
    await fs.writeFile(markerPath, JSON.stringify({
      source: "zhenghebao",
      repoUrl: source.repoUrl,
      branch: source.branch,
      commit: source.commit,
      sourceLabel: source.sourceLabel,
      installedAt: new Date().toISOString(),
    }, null, 2), "utf8");
  }

  private async writeInstallLog(logDir: string, logPath: string, message: string, log: string[]) {
    try {
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(logPath, [message, "", ...log].join("\n"), "utf8");
    } catch {
      // Logging failures should not hide install result.
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

function looksLikeFilePath(value: string) {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}
