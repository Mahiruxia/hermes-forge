import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfigStore } from "../main/runtime-config";
import { isAtLeastVersion, parseHermesVersion } from "../install/hermes-version";
import { RESUME_SUPPORT_VERSION } from "../install/hermes-version-constants";
import { runCommand, type CommandResult } from "../process/command-runner";
import type { HermesCompatibilityReport, RuntimeConfig } from "../shared/types";
import {
  defaultWindowsHermesCliPath,
  isWindowsHermesExecutable,
  resolveWindowsHermesCliPath,
} from "../runtime/hermes-cli-paths";
import { parseCommandLine } from "../runtime/runtime-resolver";

const DEFAULT_TIMEOUT_MS = 20_000;

type PythonCandidate = { command: string; args: string[]; label: string };

export class HermesCompatibilityService {
  constructor(
    private readonly configStore: RuntimeConfigStore,
    private readonly hermesHomeProvider?: () => Promise<string> | string,
  ) {}

  async inspect(): Promise<HermesCompatibilityReport> {
    const config = await this.configStore.read().catch(() => ({ modelProfiles: [], updateSources: {} }) as RuntimeConfig);
    const rootPath = await this.configStore.getEnginePath("hermes").catch(() => undefined);
    if (!rootPath?.trim()) {
      return this.empty("Hermes 安装路径未配置。");
    }

    const cliPath = await resolveWindowsHermesCliPath(rootPath) ?? defaultWindowsHermesCliPath(rootPath);
    if (!(await exists(cliPath))) {
      return this.empty(`未找到 Hermes CLI：${cliPath}`, rootPath, cliPath);
    }

    const launch = await this.detectLaunch(rootPath, cliPath, config);
    if (!launch.versionResult || launch.versionResult.exitCode !== 0 || !outputText(launch.versionResult).trim()) {
      return this.empty(
        `Hermes CLI 不可启动或没有版本输出：${outputText(launch.versionResult).trim() || `exit ${launch.versionResult?.exitCode ?? "unknown"}`}`,
        rootPath,
        cliPath,
      );
    }

    const versionOutput = outputText(launch.versionResult);
    const version = parseHermesVersion(versionOutput) ?? versionOutput.trim().split(/\r?\n/)[0]?.trim();
    const venvStatus = await hasVenv(rootPath) ? "present" : "missing";
    const enhancedCapabilities = await this.probeCapabilities(rootPath, cliPath, launch);
    const forge = await this.probeForgeTaskCompatibility(rootPath, config, launch);
    const blockingIssues: string[] = [];
    const warnings: string[] = [];

    if (!forge.ready) blockingIssues.push(forge.message);
    if (venvStatus === "missing") warnings.push("未检测到 Hermes venv；源码 CLI 可运行，但建议一键修复补齐虚拟环境。");
    if (!enhancedCapabilities.supported) warnings.push(enhancedCapabilities.message);

    return {
      installed: true,
      version,
      cliPath,
      rootPath,
      launchMode: launch.mode,
      venvStatus,
      forgeTaskReady: forge.ready,
      enhancedCapabilities,
      doctorStatus: { status: "not_run", message: "doctor 由一键诊断执行，常规设置页不阻塞等待。" },
      blockingIssues,
      warnings,
    };
  }

  async runDoctor(autoFix = false): Promise<{ status: "pass" | "warning" | "fail"; command: string; exitCode: number | null; output: string; message: string }> {
    const rootPath = await this.configStore.getEnginePath("hermes");
    const cliPath = await resolveWindowsHermesCliPath(rootPath) ?? defaultWindowsHermesCliPath(rootPath);
    const config = await this.configStore.read();
    const launch = await this.detectLaunch(rootPath, cliPath, config);
    const args = autoFix ? ["doctor", "--fix"] : ["doctor"];
    const result = await this.runHermes(rootPath, cliPath, args, launch);
    const output = outputText(result).trim();
    const status = result.exitCode === 0
      ? /Found\s+\d+\s+issue\(s\)|issue\(s\)\s+to\s+address/i.test(output) ? "warning" : "pass"
      : "fail";
    return {
      status,
      command: result.command,
      exitCode: result.exitCode,
      output,
      message: status === "pass"
        ? "Hermes doctor 通过。"
        : status === "warning"
          ? "Hermes doctor 可运行，但仍有非阻塞建议。"
          : "Hermes doctor 执行失败。",
    };
  }

  private async detectLaunch(rootPath: string, cliPath: string, config: RuntimeConfig) {
    if (isWindowsHermesExecutable(cliPath)) {
      const versionResult = await this.runHermes(rootPath, cliPath, ["--version"], { mode: "venv-exe" as const });
      return { mode: "venv-exe" as const, versionResult };
    }
    for (const python of this.pythonCandidates(rootPath, config)) {
      const result = await runCommand(python.command, [...python.args, cliPath, "--version"], {
        cwd: rootPath,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        env: await this.hermesEnv(rootPath),
        commandId: "hermes.compat.detect-version",
        runtimeKind: "windows",
      }).catch((error) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) } as CommandResult));
      if (result.exitCode === 0 && outputText(result).trim()) {
        return { mode: "source-python" as const, python, versionResult: { ...result, command: `${python.command} ${[...python.args, cliPath, "--version"].join(" ")}` } };
      }
    }
    return { mode: "unknown" as const, versionResult: undefined };
  }

  private async probeCapabilities(rootPath: string, cliPath: string, launch: Awaited<ReturnType<HermesCompatibilityService["detectLaunch"]>>): Promise<HermesCompatibilityReport["enhancedCapabilities"]> {
    const result = await this.runHermes(rootPath, cliPath, ["capabilities", "--json"], launch);
    if (result.exitCode !== 0) {
      const version = parseHermesVersion(outputText(launch.versionResult));
      const missing = ["capabilities --json", "supportsLaunchMetadataArg", "supportsLaunchMetadataEnv"];
      return {
        supported: false,
        cliVersion: version,
        supportsLaunchMetadataArg: false,
        supportsLaunchMetadataEnv: false,
        supportsResume: Boolean(version && isAtLeastVersion(version, RESUME_SUPPORT_VERSION)),
        missing,
        message: version && isAtLeastVersion(version, RESUME_SUPPORT_VERSION)
          ? `官方 Hermes ${version} 可运行，但未提供 Forge 增强能力 ${missing.join(", ")}。`
          : `Hermes capabilities 不可用：${outputText(result).trim() || `exit ${result.exitCode ?? "unknown"}`}`,
      };
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        cliVersion?: unknown;
        capabilities?: {
          supportsLaunchMetadataArg?: unknown;
          supportsLaunchMetadataEnv?: unknown;
          supportsResume?: unknown;
        };
      };
      const capabilities = {
        cliVersion: typeof parsed.cliVersion === "string" ? parsed.cliVersion : undefined,
        supportsLaunchMetadataArg: parsed.capabilities?.supportsLaunchMetadataArg === true,
        supportsLaunchMetadataEnv: parsed.capabilities?.supportsLaunchMetadataEnv === true,
        supportsResume: parsed.capabilities?.supportsResume === true,
      };
      const missing = [
        capabilities.cliVersion ? undefined : "cliVersion",
        capabilities.supportsLaunchMetadataArg ? undefined : "supportsLaunchMetadataArg",
        capabilities.supportsLaunchMetadataEnv ? undefined : "supportsLaunchMetadataEnv",
        capabilities.supportsResume ? undefined : "supportsResume",
      ].filter((item): item is string => Boolean(item));
      return {
        supported: missing.length === 0,
        ...capabilities,
        missing,
        message: missing.length ? `Hermes capabilities 缺少：${missing.join(", ")}。` : "Hermes 增强能力可用。",
      };
    } catch (error) {
      return {
        supported: false,
        supportsLaunchMetadataArg: false,
        supportsLaunchMetadataEnv: false,
        supportsResume: false,
        missing: ["capabilities-json"],
        message: `capabilities --json 返回内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async probeForgeTaskCompatibility(rootPath: string, config: RuntimeConfig, launch: Awaited<ReturnType<HermesCompatibilityService["detectLaunch"]>>) {
    const script = `
import json, sys, inspect
sys.path.insert(0, r"""${rootPath}""")
try:
    from run_agent import AIAgent
    sig = inspect.signature(AIAgent.__init__)
    params = set(sig.parameters.keys())
    required = {"base_url", "api_key", "provider", "model", "max_iterations"}
    recommended = {"skip_context_files", "quiet_mode", "session_id", "platform", "ephemeral_system_prompt"}
    missing = sorted(required - params)
    missing_recommended = sorted(recommended - params)
    has_run_conversation = hasattr(AIAgent, "run_conversation") and callable(getattr(AIAgent, "run_conversation", None))
    print(json.dumps({"compatible": len(missing) == 0 and has_run_conversation, "missing": missing, "missing_recommended": missing_recommended, "has_run_conversation": has_run_conversation}))
except Exception as e:
    print(json.dumps({"compatible": False, "error": str(e)}))
`;
    const python = launch.mode === "source-python" && "python" in launch && launch.python
      ? launch.python
      : await this.resolvePythonCandidate(rootPath, config);
    const command = python.command;
    const args = [...python.args, "-c", script];
    const result = await runCommand(command, args, {
      cwd: rootPath,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      env: await this.hermesEnv(rootPath),
      commandId: "hermes.compat.forge-task",
      runtimeKind: "windows",
    }).catch((error) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) } as CommandResult));
    try {
      const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}") as {
        compatible?: boolean;
        missing?: string[];
        missing_recommended?: string[];
        has_run_conversation?: boolean;
        error?: string;
      };
      if (parsed.compatible) return { ready: true, message: "Forge 任务能力可用。" };
      if (!parsed.has_run_conversation) return { ready: false, message: "Hermes Agent 缺少 AIAgent.run_conversation。" };
      if (parsed.missing?.length) return { ready: false, message: `Hermes Agent 缺少必要初始化参数：${parsed.missing.join(", ")}。` };
      return { ready: false, message: parsed.error ?? "Hermes Agent 兼容性探测失败。" };
    } catch {
      return { ready: false, message: outputText(result).trim() || "Hermes Agent 兼容性探测无有效输出。" };
    }
  }

  private async runHermes(
    rootPath: string,
    cliPath: string,
    args: string[],
    launch: { mode: "venv-exe" } | { mode: "source-python"; python?: PythonCandidate } | { mode: "unknown" },
  ): Promise<CommandResult & { command: string }> {
    if (isWindowsHermesExecutable(cliPath)) {
      const result = await runCommand(cliPath, args, {
        cwd: rootPath,
        timeoutMs: args[0] === "doctor" ? 60_000 : DEFAULT_TIMEOUT_MS,
        env: await this.hermesEnv(rootPath),
        commandId: "hermes.compat.cli",
        runtimeKind: "windows",
      }).catch((error) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) } as CommandResult));
      return { ...result, command: `${cliPath} ${args.join(" ")}` };
    }
    const python = launch.mode === "source-python" && launch.python ? launch.python : undefined;
    const command = python?.command ?? "python";
    const pythonArgs = [...(python?.args ?? []), cliPath, ...args];
    const result = await runCommand(command, pythonArgs, {
      cwd: rootPath,
      timeoutMs: args[0] === "doctor" ? 60_000 : DEFAULT_TIMEOUT_MS,
      env: await this.hermesEnv(rootPath),
      commandId: "hermes.compat.cli",
      runtimeKind: "windows",
    }).catch((error) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) } as CommandResult));
    return { ...result, command: `${command} ${pythonArgs.join(" ")}` };
  }

  private pythonCandidates(rootPath: string, config: RuntimeConfig): PythonCandidate[] {
    const candidates: PythonCandidate[] = [];
    const addFile = (command: string, label: string) => {
      if (!candidates.some((item) => item.command === command && item.args.length === 0)) {
        candidates.push({ command, args: [], label });
      }
    };
    const add = (raw: string | undefined, label?: string) => {
      const parsed = raw?.trim() ? parseCommandLine(raw) : undefined;
      if (!parsed) return;
      if (!candidates.some((item) => item.command === parsed.command && item.args.join("\0") === parsed.args.join("\0"))) {
        candidates.push({ command: parsed.command, args: parsed.args, label: label ?? raw ?? parsed.command });
      }
    };
    if (process.platform === "win32") {
      addFile(path.join(rootPath, "venv", "Scripts", "python.exe"), "venv Python");
      addFile(path.join(rootPath, ".venv", "Scripts", "python.exe"), ".venv Python");
      add("py -3");
      add("python");
    } else {
      addFile(path.join(rootPath, "venv", "bin", "python3"), "venv Python");
      addFile(path.join(rootPath, ".venv", "bin", "python3"), ".venv Python");
      addFile(path.join(rootPath, "venv", "bin", "python"), "venv Python");
      addFile(path.join(rootPath, ".venv", "bin", "python"), ".venv Python");
      add("python3");
    }
    add(config.hermesRuntime?.pythonCommand, "configured Python");
    add("python");
    add("python3");
    return candidates;
  }

  private async resolvePythonCandidate(rootPath: string, config: RuntimeConfig): Promise<PythonCandidate> {
    const candidates = this.pythonCandidates(rootPath, config);
    for (const candidate of candidates) {
      if (path.isAbsolute(candidate.command) && !(await exists(candidate.command))) continue;
      const result = await runCommand(candidate.command, [...candidate.args, "--version"], {
        cwd: rootPath,
        timeoutMs: 10_000,
        env: await this.hermesEnv(rootPath),
        commandId: "hermes.compat.detect-python",
        runtimeKind: "windows",
      }).catch(() => undefined);
      if (result?.exitCode === 0) return candidate;
    }
    return { command: "python", args: [], label: "python" };
  }

  private empty(message: string, rootPath?: string, cliPath?: string): HermesCompatibilityReport {
    return {
      installed: false,
      rootPath,
      cliPath,
      launchMode: "unknown",
      venvStatus: "unknown",
      forgeTaskReady: false,
      enhancedCapabilities: {
        supported: false,
        supportsLaunchMetadataArg: false,
        supportsLaunchMetadataEnv: false,
        supportsResume: false,
        missing: ["installed"],
        message,
      },
      doctorStatus: { status: "not_run", message: "Hermes 未安装，跳过 doctor。" },
      blockingIssues: [message],
      warnings: [],
    };
  }

  private async hermesEnv(rootPath: string): Promise<NodeJS.ProcessEnv> {
    const hermesHome = typeof this.hermesHomeProvider === "function"
      ? await this.hermesHomeProvider()
      : this.hermesHomeProvider;
    return hermesEnv(rootPath, hermesHome);
  }
}

function hermesEnv(rootPath: string, hermesHome?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: `${rootPath}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...(hermesHome ? { HERMES_HOME: hermesHome } : {}),
  };
}

function outputText(result: Pick<CommandResult, "stdout" | "stderr"> | undefined) {
  return result ? [result.stdout, result.stderr].filter(Boolean).join("\n") : "";
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hasVenv(rootPath: string) {
  return exists(path.join(rootPath, "venv", "Scripts", "python.exe"))
    || exists(path.join(rootPath, ".venv", "Scripts", "python.exe"))
    || exists(path.join(rootPath, "venv", "Scripts", "hermes.exe"))
    || exists(path.join(rootPath, ".venv", "Scripts", "hermes.exe"));
}
