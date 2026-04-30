import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "../main/app-paths";
import { resolveActiveHermesHome } from "../main/hermes-home";
import type { RuntimeConfigStore } from "../main/runtime-config";
import { runCommand } from "../process/command-runner";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import type { RuntimeProbeService } from "../runtime/runtime-probe-service";
import { validateNativeHermesCli } from "../runtime/hermes-cli-resolver";
import {
  defaultWindowsHermesCliPath,
  inferWindowsHermesRootFromCliPath,
  isWindowsHermesExecutable,
  resolveWindowsHermesCliPath,
} from "../runtime/hermes-cli-paths";
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
import { resolveInstallSource } from "./install-source";
import type { InstallSource } from "./install-source";

const DEFAULT_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const OFFICIAL_WINDOWS_INSTALLER_URL = "https://res1.hermesagent.org.cn/install.ps1";
const OFFICIAL_HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";

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
    const rootPath = await this.resolveInstallRoot(options.rootPath);
    const issues = probe?.issues ?? [];
    return {
      mode: "windows",
      ok: !probe || probe.powershellAvailable,
      summary: probe
        ? "Windows Native 官网脚本安装策略已生成计划。"
        : "Windows Native 官网脚本安装策略已生成 legacy 计划。",
      issues,
      runtimeProbe: probe,
      steps: [
        installStep({
          phase: "plan",
          step: "select-native",
          status: "passed",
          code: "native_selected",
          summary: "已选择 Windows Native 官网 install.ps1 安装策略。",
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
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const hermesRoot = await this.resolveInstallRoot(await this.configStore.getEnginePath("hermes"), log);
    const preflight = await this.checkInstalledHermes(hermesRoot, log).catch((error) => ({
      available: false,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (!preflight.available) {
      log.push(`Hermes update preflight failed; reinstalling through official installer. Reason: ${preflight.message}`);
      const reinstall = await this.performInstallHermes(undefined, { rootPath: hermesRoot, mode: "windows" }, true);
      return {
        ok: reinstall.ok,
        engineId: "hermes",
        message: reinstall.ok
          ? "Hermes 安装已修复并通过检查。"
          : `Hermes 修复失败：${reinstall.message}`,
        log: [...log, ...reinstall.log],
        logPath: reinstall.logPath,
        plan: reinstall.plan ?? await this.plan({ rootPath: hermesRoot, mode: "windows" }),
      };
    }

    log.push("Hermes repair preflight passed; running best-effort Windows Native repair.");
    await this.repairVenvBestEffort(hermesRoot, log);

    const launch = await this.hermesMaintenanceLaunch(hermesRoot, ["doctor", "--fix"]);
    log.push(`$ ${launch.command} ${JSON.stringify(launch.args)}`);
    const result = await runCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
      env: launch.env,
      commandId: "install.native.hermes.doctor-fix",
      runtimeKind: launch.runtimeKind,
    });
    if (result.stdout.trim()) log.push(result.stdout.trim());
    if (result.stderr.trim()) log.push(result.stderr.trim());
    if (result.exitCode !== 0) {
      log.push(`Hermes doctor --fix returned exit ${result.exitCode}; continuing with core CLI recheck before deciding whether to reinstall.`);
    }

    const postRepair = await this.checkInstalledHermes(hermesRoot, log).catch((error) => ({
      available: false,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (!postRepair.available) {
      log.push(`Hermes repair left CLI unusable; reinstalling through official installer. Reason: ${postRepair.message}`);
      const reinstall = await this.performInstallHermes(undefined, { rootPath: hermesRoot, mode: "windows" }, true);
      return {
        ok: reinstall.ok,
        engineId: "hermes",
        message: reinstall.ok
          ? "Hermes 已通过官方安装脚本重装修复。"
          : `Hermes 重装修复后仍不可用：${reinstall.message}`,
        log: [...log, ...reinstall.log],
        logPath: reinstall.logPath,
        plan: reinstall.plan ?? await this.plan({ rootPath: hermesRoot, mode: "windows" }),
      };
    }
    const ok = true;
    const message = result.exitCode === 0
      ? "Hermes 一键修复完成，并已通过核心启动检查。"
      : "Hermes 核心可用；doctor --fix 仍有非阻塞输出，请查看日志确认可选项。";
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `hermes-repair-${startedAt.replace(/[:.]/g, "-")}.log`);
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
      case "python":
        return await this.repairWithOfficialInstaller(id);
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
    const hermesHome = await resolveActiveHermesHome(this.appPaths.hermesDir());
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
        pythonArgs: [await this.resolveHermesCliPath(hermesRoot), ...args],
        cwd: hermesRoot,
        env: {
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONPATH: runtimeRoot,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          HERMES_HOME: adapter.toRuntimePath(hermesHome),
        },
      });
    }
    const hermesCli = await this.resolveHermesCliPath(hermesRoot);
    return {
      command: isWindowsHermesExecutable(hermesCli) ? hermesCli : "python",
      args: isWindowsHermesExecutable(hermesCli) ? args : [hermesCli, ...args],
      cwd: hermesRoot,
      env: {
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: `${hermesRoot}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        HERMES_HOME: hermesHome,
      },
      runtimeKind: "windows" as const,
    };
  }

  private async performInstallHermes(publish?: InstallPublisher, options: InstallOptions = {}, forceRunOfficialInstaller = false): Promise<InstallStrategyResult> {
    const log: string[] = [];
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const logPath = path.join(logDir, `hermes-install-${startedAt.replace(/[:.]/g, "-")}.log`);
    const scriptPath = path.join(logDir, `official-install-${startedAt.replace(/[:.]/g, "-")}.ps1`);

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

    try {
      emit("preflight", 5, "正在检测本机环境。");
      const currentHealth = await this.hermes.healthCheck().catch((error) => {
        log.push(`Current Hermes check failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (currentHealth?.available && !forceRunOfficialInstaller) {
        const rootPath = currentHealth.path ?? await this.configStore.getEnginePath("hermes");
        await this.saveHermesRoot(rootPath);
        log.push(`Hermes is already available at ${rootPath}.`);
        return await finish({ ok: true, rootPath, message: `已检测到可用 Hermes：${rootPath}` }, "completed");
      }

      const requestedRoot = options.rootPath?.trim() || process.env.HERMES_INSTALL_DIR?.trim();
      const rootPath = await this.resolveInstallRoot(options.rootPath, log);
      const hermesHome = this.defaultHermesHomeForInstall(rootPath);
      const parentDir = path.dirname(rootPath);
      log.push(`Install target: ${rootPath}`);
      if (requestedRoot && requestedRoot !== rootPath) {
        log.push(`Ignored Windows-incompatible install target: ${requestedRoot}`);
      }
      log.push(`Hermes home: ${hermesHome}`);
      log.push(`Official installer: ${OFFICIAL_WINDOWS_INSTALLER_URL}`);

      await this.assertWritableDirectory(logDir, "安装日志目录", log);
      await this.assertWritableDirectory(parentDir, "Hermes 安装父目录", log);
      await this.assertWritableDirectory(hermesHome, "Hermes home", log);

      const targetState = await this.inspectTargetDirectory(rootPath, log);
      if (targetState.exists && targetState.isEmpty) {
        await fs.rm(rootPath, { recursive: true, force: true });
        log.push(`Removed empty target directory ${rootPath} before official install.`);
      } else if (targetState.exists && !targetState.hasOfficialCli && targetState.recoverable) {
        const stalePath = `${rootPath}.stale-${Date.now()}`;
        await fs.rename(rootPath, stalePath);
        log.push(`Quarantined incomplete Hermes install to ${stalePath}`);
      } else if (targetState.exists && !targetState.hasHermesCli && !targetState.recoverable) {
        return await finish({
          ok: false,
          rootPath,
          message: `目标目录已存在但看起来不是可自动恢复的 Hermes 安装：${rootPath}。请更换安装位置，或手动清理该目录后重试。`,
        }, "failed");
      }

      const powershell = await this.runLogged("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], process.cwd(), log, 15_000);
      if (powershell.exitCode !== 0) {
        return await finish({ ok: false, rootPath, message: "无法自动安装 Hermes：未检测到可用 PowerShell。" }, "failed");
      }

      emit("cloning", 20, "正在下载 Hermes 官方 Windows 安装脚本。", OFFICIAL_WINDOWS_INSTALLER_URL);
      const downloadScript = [
        "$ProgressPreference='SilentlyContinue';",
        `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;`,
        `Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(OFFICIAL_WINDOWS_INSTALLER_URL)} -OutFile ${psQuote(scriptPath)};`,
      ].join(" ");
      const download = await this.runLogged("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", downloadScript], logDir, log, 120_000);
      if (download.exitCode !== 0) {
        return await finish({ ok: false, rootPath, message: `Hermes 官方安装脚本下载失败，详情见安装日志：${logPath}` }, "failed");
      }
      await this.patchOfficialInstallerScript(scriptPath, log);

      emit("installing_dependencies", 45, "正在运行 Hermes 官方 Windows 安装脚本。", rootPath);
      const installerArgs = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-SkipSetup",
        "-WithSystemPackages",
        "-HermesHome",
        hermesHome,
        "-InstallDir",
        rootPath,
      ];
      const install = await this.runLogged("powershell.exe", installerArgs, logDir, log, DEFAULT_INSTALL_TIMEOUT_MS, {
        heartbeatMs: 15_000,
        onHeartbeat: (elapsedSeconds) => emit("installing_dependencies", 55, "官方安装脚本仍在运行，请保持网络连接。", `已等待 ${elapsedSeconds} 秒`),
      });
      if (install.exitCode !== 0) {
        return await finish({ ok: false, rootPath, message: `Hermes 官方安装脚本执行失败，详情见安装日志：${logPath}` }, "failed");
      }

      emit("health_check", 82, "正在校验 Hermes 是否可启动。", rootPath);
      const localHealth = await this.checkInstalledHermes(rootPath, log);
      if (!localHealth.available) {
        return await finish({
          ok: false,
          rootPath,
          message: `Hermes 文件已落地到 ${rootPath}，但本地自检未通过：${localHealth.message}。详情见安装日志：${logPath}`,
        }, "failed");
      }
      await this.repairVenvBestEffort(rootPath, log);

      await this.verifyHermesHomeWritable(hermesHome, log);
      await this.writeManagedMarker(rootPath);
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
      const message = error instanceof Error ? error.message : String(error);
      log.push(`Install crashed: ${message}`);
      return await finish({
        ok: false,
        message: `Hermes 自动安装失败：${message}`,
        rootPath: await this.resolveInstallRoot(options.rootPath).catch(() => this.defaultInstallRoot()),
      }, "failed");
    }
  }

  private async repairWithOfficialInstaller(id: SetupDependencyRepairId): Promise<InstallStrategyRepairResult> {
    const rootPath = await this.resolveInstallRoot(await this.configStore.getEnginePath("hermes").catch(() => this.defaultInstallRoot()));
    const result = await this.performInstallHermes(undefined, { rootPath, mode: "windows" }, true);
    return {
      ok: result.ok,
      id,
      message: result.ok
        ? "Hermes 官方安装脚本已重跑完成，请重新检测依赖状态。"
        : `Hermes 官方安装脚本修复失败：${result.message}`,
      stdout: result.log.join("\n"),
      stderr: result.ok ? "" : result.message,
      logPath: result.logPath,
      recommendedFix: result.ok
        ? "重新打开系统状态页或运行一键诊断确认依赖是否就绪。"
        : "请查看安装日志；如果 winget 或网络策略不可用，请按日志中的手动命令安装缺失依赖。",
      plan: result.plan ?? await this.plan({ rootPath, mode: "windows" }),
    };
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
    const rootPath = await this.resolveInstallRoot(await this.configStore.getEnginePath("hermes").catch(() => this.defaultInstallRoot()));
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
    addCandidate(path.join(rootPath, "venv", "Scripts", "python.exe"), undefined, "venv Python");
    addCandidate(path.join(rootPath, ".venv", "Scripts", "python.exe"), undefined, ".venv Python");
    addCandidate(probe?.commands.python.command, probe?.commands.python.args, probe?.commands.python.label ?? "RuntimeProbe Python");
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
      recommendedFix: `请先重跑 Hermes 官方安装脚本；若仍失败，请在 Hermes venv 中执行 python -m pip install ${packageName}。`,
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

  private async repairVenvBestEffort(rootPath: string, log: string[]) {
    if (await this.hasVenv(rootPath)) {
      log.push("Hermes venv already exists.");
      return;
    }
    log.push("Hermes venv not found; attempting best-effort repair.");
    const uv = await this.runLogged("uv", ["--version"], rootPath, log, 15_000).catch(() => undefined);
    if (uv?.exitCode === 0) {
      const sync = await this.runLogged("uv", ["sync"], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS).catch(() => undefined);
      if (sync?.exitCode === 0 && await this.hasVenv(rootPath)) {
        log.push("Hermes venv repaired through uv sync.");
        return;
      }
      const pip = await this.runLogged("uv", ["pip", "install", "-e", "."], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS).catch(() => undefined);
      if (pip?.exitCode === 0 && await this.hasVenv(rootPath)) {
        log.push("Hermes venv repaired through uv pip install -e .");
        return;
      }
    }
    const python = await this.detectPythonLauncher(log);
    if (!python) {
      log.push("No system Python available for venv repair; leaving source CLI as fallback.");
      return;
    }
    const venvDir = path.join(rootPath, "venv");
    const create = await this.runLogged(python.command, [...python.argsPrefix, "-m", "venv", venvDir], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS).catch(() => undefined);
    if (create?.exitCode !== 0) {
      log.push("python -m venv failed; leaving source CLI as fallback.");
      return;
    }
    const venvPython = path.join(venvDir, "Scripts", "python.exe");
    if (await this.exists(venvPython)) {
      const install = await this.runLogged(venvPython, ["-m", "pip", "install", "-e", "."], rootPath, log, DEFAULT_INSTALL_TIMEOUT_MS).catch(() => undefined);
      if (install?.exitCode === 0) log.push("Hermes venv repaired through python -m venv + pip install -e .");
      else log.push("venv pip install failed; source CLI remains usable when health check passes.");
    }
  }

  private async saveHermesRoot(rootPath: string) {
    const config = await this.configStore.read();
    await this.configStore.write({
      ...config,
      enginePaths: { ...(config.enginePaths ?? {}), hermes: rootPath },
      hermesRuntime: {
        ...(config.hermesRuntime ?? {}),
        mode: "windows",
        distro: undefined,
        managedRoot: rootPath,
        installSource: {
          repoUrl: OFFICIAL_HERMES_REPO_URL,
          branch: "main",
          sourceLabel: "official",
        },
      },
    });
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
      const hasHermesCli = Boolean(await resolveWindowsHermesCliPath(rootPath));
      const hasOfficialCli = await this.exists(path.join(rootPath, "venv", "Scripts", "hermes.exe"))
        || await this.exists(path.join(rootPath, ".venv", "Scripts", "hermes.exe"));
      const marker = await this.exists(path.join(rootPath, ".zhenghebao-managed-install.json"));
      const recoverableSignals = [".git", ".zhenghebao-managed-install.json", "pyproject.toml", "requirements.txt", "README.md"];
      const recoverable = entries.some((entry) => recoverableSignals.includes(entry));
      return { exists: true, isEmpty: entries.length === 0, hasHermesCli, hasOfficialCli, recoverable: marker || recoverable };
    } catch (error) {
      const code = this.errorCode(error);
      if (code === "ENOENT") return { exists: false, isEmpty: true, hasHermesCli: false, hasOfficialCli: false, recoverable: false };
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
    const cliPath = await resolveWindowsHermesCliPath(rootPath) ?? defaultWindowsHermesCliPath(rootPath);
    if (!(await this.exists(cliPath))) return { available: false, message: `未找到 Hermes CLI：${cliPath}` };
    const hermesHome = await resolveActiveHermesHome(this.appPaths.hermesDir());
    const candidates: Array<{ command: string; args: string[] }> = isWindowsHermesExecutable(cliPath)
      ? [{ command: cliPath, args: ["--version"] }]
      : [
          ...(preferredPython ? [{ command: preferredPython.command, args: [...preferredPython.argsPrefix, cliPath, "--version"] }] : []),
          { command: path.join(rootPath, "venv", "Scripts", "python.exe"), args: [cliPath, "--version"] },
          { command: path.join(rootPath, ".venv", "Scripts", "python.exe"), args: [cliPath, "--version"] },
          { command: "python", args: [cliPath, "--version"] },
          { command: "py", args: ["-3", cliPath, "--version"] },
        ];
    let lastMessage = "未找到可用 Python 解释器。";
    for (const candidate of candidates) {
      if (path.isAbsolute(candidate.command) && !(await this.exists(candidate.command))) continue;
      const result = await runCommand(candidate.command, candidate.args, {
        cwd: rootPath,
        timeoutMs: 20_000,
        env: {
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONUNBUFFERED: "1",
          PYTHONPATH: `${rootPath}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          HERMES_HOME: hermesHome,
        },
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      log.push(`Install health via ${candidate.command}: ${output || `exit ${result.exitCode ?? "unknown"}`}`);
      if (result.exitCode === 0 && output.length > 0) {
        if (this.runtimeAdapterFactory) {
          const adapter = this.runtimeAdapterFactory({
            mode: "windows",
            pythonCommand: preferredPython?.command ?? "python3",
            windowsAgentMode: "hermes_native",
          });
          const validation = await validateNativeHermesCli(adapter, cliPath);
          if (!validation.ok) {
            const officialWindowsUsable = validation.kind === "capability_unsupported"
              && validation.capabilities?.cliVersion
              && validation.capabilities.supportsResume === true;
            log.push(`Capability check ${officialWindowsUsable ? "warned" : "failed"}: ${validation.message}`);
            if (!officialWindowsUsable) {
              return {
                available: false,
                message: `已安装 Hermes 但缺少 Forge 任务所需能力。${validation.message}`,
              };
            }
            log.push("Official Windows Hermes is usable for Forge task compatibility; enhanced launch metadata remains a warning.");
            return { available: true, message: `${output}\n${validation.message}` };
          }
          log.push(`Capability check passed: ${validation.capabilities.cliVersion ?? "unknown"}`);
        }
        return { available: true, message: output || "Hermes CLI 可启动。" };
      }
      lastMessage = output || (
        result.exitCode === 0
          ? `${candidate.command} 成功退出但没有输出 Hermes 版本信息，可能只是残留占位文件。`
          : `${candidate.command} 退出码 ${result.exitCode ?? "unknown"}`
      );
    }
    return { available: false, message: lastMessage };
  }

  private async writeManagedMarker(rootPath: string) {
    const markerPath = path.join(rootPath, ".zhenghebao-managed-install.json");
    await fs.writeFile(markerPath, JSON.stringify({
      source: "zhenghebao",
      installer: OFFICIAL_WINDOWS_INSTALLER_URL,
      repoUrl: OFFICIAL_HERMES_REPO_URL,
      branch: "main",
      sourceLabel: "official",
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

  private async resolveHermesCliPath(rootPath: string) {
    return await resolveWindowsHermesCliPath(rootPath) ?? defaultWindowsHermesCliPath(rootPath);
  }

  private async verifyHermesHomeWritable(hermesHome: string, log: string[]) {
    await fs.mkdir(path.join(hermesHome, "skills"), { recursive: true });
    const probe = path.join(hermesHome, "skills", `.zhenghebao-skill-write-probe-${Date.now()}`);
    await fs.writeFile(probe, "ok", "utf8");
    await fs.unlink(probe);
    await fs.mkdir(path.join(hermesHome, "logs"), { recursive: true });
    log.push(`Hermes home 可写：${hermesHome}`);
  }

  private async hasVenv(rootPath: string) {
    return await this.exists(path.join(rootPath, "venv", "Scripts", "python.exe"))
      || await this.exists(path.join(rootPath, ".venv", "Scripts", "python.exe"))
      || await this.exists(path.join(rootPath, "venv", "Scripts", "hermes.exe"))
      || await this.exists(path.join(rootPath, ".venv", "Scripts", "hermes.exe"));
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
    const withoutBom = raw.replace(/^\uFEFF/, "");
    const replacement = '    Write-Info "Hermes Forge 跳过安装器自动启动 Gateway；请在桌面端连接器页面启动。"';
    const patched = withoutBom.replace(/^[ \t]*Start-GatewayIfConfigured\s*$/m, replacement);
    if (patched === withoutBom) {
      log.push("Official installer patch: Start-GatewayIfConfigured was not found; preserving downloaded script.");
    } else {
      log.push("Official installer patch: disabled interactive Gateway startup prompt.");
    }
    await fs.writeFile(scriptPath, `\uFEFF${patched}`, "utf8");
    log.push("Official installer patch: wrote UTF-8 BOM for Windows PowerShell 5.1 compatibility.");
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

function isLegacyPosixPath(value: string) {
  return /^\/(?:root|home|mnt|tmp|var|usr|etc)(?:\/|$)/i.test(value.replace(/\\/g, "/"));
}

function psQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}
