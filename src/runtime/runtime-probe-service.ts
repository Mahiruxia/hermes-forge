import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../process/command-runner";
import type { HermesRuntimeConfig, WindowsBridgeStatus } from "../shared/types";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { RuntimeResolver, ParsedCommand } from "./runtime-resolver";
import { parseCommandLine } from "./runtime-resolver";
import { resolveWindowsHermesCliPath } from "./hermes-cli-paths";
import type {
  RuntimeBridgeProbe,
  RuntimeCommandProbe,
  RuntimeIssue,
  RuntimeIssueCode,
  RuntimeOverallStatus,
  RuntimeProbeResult,
  RuntimeWslProbe,
} from "./runtime-types";

type BridgeAccess = {
  url: string;
  token: string;
  capabilities: string;
};

type BridgeProvider = {
  status(): WindowsBridgeStatus;
  accessForHost(host: string): BridgeAccess | undefined;
  start?(): Promise<WindowsBridgeStatus>;
};

const COMMAND_TIMEOUT_MS = 8000;

export class RuntimeProbeService {
  constructor(
    private readonly configStore: RuntimeConfigStore,
    private readonly runtimeResolver: RuntimeResolver,
    private readonly bridge?: BridgeProvider,
    private readonly appFetch: typeof fetch = fetch,
  ) {}

  async probe(input: { workspacePath?: string; runtime?: HermesRuntimeConfig; persistResolvedHermesPath?: boolean } = {}): Promise<RuntimeProbeResult> {
    const config = await this.configStore.read().catch(() => undefined);
    const runtime = input.runtime ?? this.runtimeResolver.runtimeFromConfig(config);
    const paths = await this.runtimeResolver.resolvePaths({ runtime, workspacePath: input.workspacePath });
    const rootPath = await this.configStore.getEnginePath("hermes");
    const resolvedWindowsCliPath = await resolveWindowsHermesCliPath(rootPath);

    const [powershell, python, git, winget, wsl] = await Promise.all([
      this.probeCommand("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], "PowerShell", "windows"),
      this.probeNativePython(runtime, rootPath),
      this.probeCommand("git", ["--version"], "Git", "windows"),
      process.platform === "win32"
        ? this.probeCommand("winget", ["--version"], "winget", "windows")
        : Promise.resolve({ available: false, message: "非 Windows 平台跳过 winget 检测。" } satisfies RuntimeCommandProbe),
      this.probeWsl(),
    ]);

    const hermesRootExists = await exists(rootPath);
    const hermesCliExists = Boolean(resolvedWindowsCliPath);
    const bridge = await this.probeBridge();
    const issues = this.collectIssues({
      runtime,
      powershell,
      python,
      git,
      winget,
      wsl,
      hermesRootExists,
      hermesCliExists,
      bridge,
    });
    const overallStatus = this.overallStatus(runtime, issues);

    return {
      checkedAt: new Date().toISOString(),
      runtimeMode: runtime.mode,
      windowsAvailable: process.platform === "win32",
      powershellAvailable: powershell.available,
      pythonAvailable: python.available,
      pythonCommandResolved: python.label,
      gitAvailable: git.available,
      wingetAvailable: winget.available,
      wslAvailable: wsl.available,
      wslStatus: wsl.status,
      distroExists: wsl.distroExists,
      distroName: wsl.distroName,
      distroReachable: wsl.distroReachable,
      wslPythonAvailable: wsl.pythonAvailable,
      hermesRootExists,
      hermesCliExists,
      bridgeReachable: bridge.reachable,
      bridgeHost: bridge.host,
      bridgePort: bridge.port,
      configResolved: Boolean(config),
      homeResolved: Boolean(paths.profileHermesPath.path),
      memoryResolved: Boolean(paths.memoryPath.path),
      paths,
      commands: { powershell, python, git, winget, wsl },
      bridge,
      overallStatus,
      issues,
      recommendations: issues.map((issue) => issue.fixHint).filter((item): item is string => Boolean(item)),
    };
  }

  private async probeNativePython(runtime: HermesRuntimeConfig, rootPath: string): Promise<RuntimeCommandProbe> {
    const candidates = this.pythonCandidates(runtime, rootPath);
    const failures: string[] = [];
    for (const candidate of candidates) {
      if (looksLikeFilePath(candidate.command) && !(await exists(candidate.command))) {
        failures.push(`${candidate.label}: 文件不存在`);
        continue;
      }
      const result = await runCommand(candidate.command, [...candidate.args, "--version"], {
        cwd: rootPath,
        timeoutMs: COMMAND_TIMEOUT_MS,
        commandId: "runtime.probe.python",
        runtimeKind: "windows",
      });
      if (result.exitCode === 0) {
        return {
          available: true,
          command: candidate.command,
          args: candidate.args,
          label: candidate.label,
          version: (result.stdout || result.stderr).trim(),
          message: `${candidate.label} 可用。`,
        };
      }
      failures.push(`${candidate.label}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
    }
    return {
      available: false,
      message: failures.length ? failures.slice(0, 5).join("；") : "未找到可用 Python。",
    };
  }

  private pythonCandidates(runtime: HermesRuntimeConfig, rootPath: string): ParsedCommand[] {
    const candidates: ParsedCommand[] = [];
    const add = (raw: string | undefined) => {
      const parsed = raw?.trim() ? parseCommandLine(raw) : undefined;
      if (!parsed) return;
      if (!candidates.some((item) => item.command === parsed.command && item.args.join("\0") === parsed.args.join("\0"))) {
        candidates.push(parsed);
      }
    };
    add(runtime.pythonCommand);
    if (process.platform === "win32") {
      add(path.join(rootPath, ".venv", "Scripts", "python.exe"));
      add(path.join(rootPath, "venv", "Scripts", "python.exe"));
      add("py -3");
      add("python");
      add("python3");
    } else {
      add(path.join(rootPath, ".venv", "bin", "python"));
      add(path.join(rootPath, "venv", "bin", "python"));
      add("python3");
      add("python");
    }
    return candidates;
  }

  private async probeCommand(command: string, args: string[], label: string, runtimeKind: "windows" | "wsl"): Promise<RuntimeCommandProbe> {
    const result = await runCommand(command, args, {
      cwd: process.cwd(),
      timeoutMs: COMMAND_TIMEOUT_MS,
      commandId: `runtime.probe.${label.toLowerCase()}`,
      runtimeKind,
    });
    const output = (result.stdout || result.stderr).trim();
    return {
      available: result.exitCode === 0,
      command,
      args,
      label,
      version: result.exitCode === 0 ? output : undefined,
      message: result.exitCode === 0 ? output || `${label} 可用。` : `${label} 不可用：${output || result.diagnostics?.spawnError || `exit ${result.exitCode}`}`,
    };
  }

  private async probeWsl(): Promise<RuntimeWslProbe> {
    return {
      available: false,
      message: "WSL 不再参与运行环境探测；旧数据导入由 Legacy WSL Migration 单独处理。",
    };
  }

  private async probeBridge(): Promise<RuntimeBridgeProbe> {
    const status = this.bridge?.status();
    if (!this.bridge || !status?.running) {
      return {
        configured: false,
        running: false,
        reachable: false,
        status,
        message: "Windows Control Bridge 未启动。",
      };
    }
    const host = "127.0.0.1";
    const access = this.bridge.accessForHost(host);
    if (!access) {
      return {
        configured: true,
        running: true,
        reachable: false,
        host,
        port: status.port,
        status,
        message: "Bridge access 信息不可用。",
      };
    }
    const reachable = await this.httpHealth(access);
    return {
      configured: true,
      running: true,
      reachable,
      host,
      port: status.port,
      url: access.url,
      status,
      message: reachable ? "Bridge 本机 health 可访问。" : "Bridge 本机 health 不可访问。",
    };
  }

  private async httpHealth(access: BridgeAccess) {
    try {
      const response = await this.appFetch(`${access.url}/v1/health`, {
        headers: { authorization: `Bearer ${access.token}` },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private collectIssues(input: {
    runtime: HermesRuntimeConfig;
    powershell: RuntimeCommandProbe;
    python: RuntimeCommandProbe;
    git: RuntimeCommandProbe;
    winget: RuntimeCommandProbe;
    wsl: RuntimeWslProbe;
    hermesRootExists: boolean;
    hermesCliExists: boolean;
    bridge: RuntimeBridgeProbe;
  }) {
    const issues: RuntimeIssue[] = [];
    const add = (code: RuntimeIssueCode, severity: RuntimeIssue["severity"], summary: string, detail?: string, fixHint?: string, debugContext?: Record<string, unknown>) => {
      issues.push({ code, severity, summary, detail, fixHint, debugContext });
    };
    if (process.platform === "win32" && !input.powershell.available) {
      add("powershell_missing", "warning", "PowerShell 不可用。", input.powershell.message, "请确认 powershell.exe 在系统路径中可执行。");
    }
    if (!input.python.available) {
      add("python_missing", input.runtime.mode === "windows" ? "error" : "warning", "Windows Python 不可用。", input.python.message, "请安装 Python 或在设置中填写 Hermes Python 命令。");
    }
    if (!input.git.available) {
      add("git_missing", "warning", "Git 不可用。", input.git.message, "官网 Windows 安装脚本会优先尝试自动补齐；若失败请手动安装 Git。");
    }
    if (process.platform === "win32" && !input.winget.available) {
      add("winget_missing", "warning", "winget 不可用。", input.winget.message, "官网 Windows 安装脚本仍会尝试 uv/zip 等路径；缺失系统包时请按诊断日志手动安装。");
    }
    if (!input.hermesRootExists) {
      add("hermes_root_missing", "error", "Hermes root 不存在。", undefined, "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。");
    } else if (!input.hermesCliExists) {
      add("hermes_cli_missing", "error", "Hermes CLI 文件不存在。", undefined, "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。");
    }
    if (!input.bridge.reachable) {
      add(input.bridge.running ? "bridge_unreachable" : "bridge_disabled", "warning", "Windows Control Bridge 不可达。", input.bridge.message, "Bridge 不应阻断 Windows Native Hermes CLI 检测；需要桌面控制能力时再重启客户端或刷新 Bridge。");
    }
    return issues;
  }

  private overallStatus(runtime: HermesRuntimeConfig, issues: RuntimeIssue[]): RuntimeOverallStatus {
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length === 0) {
      return issues.length ? "degraded" : "ready";
    }
    if (errors.some((issue) => issue.code.includes("missing") || issue.code === "wsl_distro_missing")) {
      return "missing_dependency";
    }
    if (errors.some((issue) => issue.code === "hermes_root_missing" || issue.code === "hermes_cli_missing" || issue.code === "runtime_mismatch")) {
      return "misconfigured";
    }
    return "degraded";
  }
}

function looksLikeFilePath(value: string) {
  return path.isAbsolute(value) || value.includes("\\") || value.includes("/");
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
