import { RuntimeResolver, parseWslHost, sanitizeEnvForWsl, toWslPath } from "./runtime-resolver";
import { runCommand } from "../process/command-runner";
import type { HermesRuntimeConfig } from "../shared/types";
import type { RuntimeProbeService } from "./runtime-probe-service";
import { wslDistroArgs } from "./runtime-probe-service";
import type { RuntimeAdapter } from "./runtime-adapter";
import { preflightFromProbe } from "./runtime-adapter";
import type { BuildHermesLaunchInput, RuntimeLaunchSpec, RuntimePreflightResult, RuntimeProbeResult } from "./runtime-types";

export class WslRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly runtime: HermesRuntimeConfig,
    private readonly runtimeResolver: RuntimeResolver,
    private readonly runtimeProbeService: RuntimeProbeService,
  ) {}

  getKind() {
    return "wsl" as const;
  }

  probe(workspacePath?: string): Promise<RuntimeProbeResult> {
    return this.runtimeProbeService.probe({ workspacePath, runtime: { ...this.runtime, mode: "wsl" } });
  }

  async buildHermesLaunch(input: BuildHermesLaunchInput): Promise<RuntimeLaunchSpec> {
    return this.buildPythonLaunch(input);
  }

  async buildPythonLaunch(input: BuildHermesLaunchInput): Promise<RuntimeLaunchSpec> {
    const runtimeCwd = this.toRuntimePath(input.cwd);
    const pythonCommand = this.runtime.pythonCommand?.trim() || "python3";
    const rootPath = input.rootPath.trim().replace(/\/+$/, "");
    const venvPython = `${rootPath}/.venv/bin/python`;
    const pythonArgs = input.pythonArgs.map(shellQuote).join(" ");
    const launcher = [
      `if [ -x ${shellQuote(venvPython)} ]; then exec ${shellQuote(venvPython)} ${pythonArgs}; fi`,
      `exec ${shellQuote(pythonCommand)} ${pythonArgs}`,
    ].join("; ");
    return {
      command: "wsl.exe",
      args: [
        ...wslDistroArgs(this.runtime),
        "--cd",
        runtimeCwd,
        "env",
        ...this.envArgs(input.env),
        "bash",
        "-lc",
        launcher,
      ],
      cwd: process.cwd(),
      env: process.env,
      detached: false,
      runtimeKind: "wsl",
      diagnostics: {
        label: `wsl ${this.runtime.distro ?? "<default>"} ${pythonCommand}`,
        runtimeRootPath: input.rootPath,
        runtimeCwd,
        pythonCommand,
      },
    };
  }

  toRuntimePath(inputPath: string) {
    return this.runtimeResolver.toRuntimePath({ mode: "wsl" }, inputPath);
  }

  async getBridgeAccessHost() {
    const result = await runCommand("wsl.exe", [...wslDistroArgs(this.runtime), "ip", "route", "show", "default"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      commandId: "runtime.wsl.bridge-host",
      runtimeKind: "wsl",
    }).catch(() => undefined);
    return parseWslHost(result?.stdout ?? "") || "127.0.0.1";
  }

  async preflight(input?: { workspacePath?: string }): Promise<RuntimePreflightResult> {
    const probe = await this.probe(input?.workspacePath);
    const result = preflightFromProbe(probe);
    if (input?.workspacePath?.trim()) {
      const runtimeWorkspace = toWslPath(input.workspacePath);
      const cd = await runCommand("wsl.exe", [...wslDistroArgs(this.runtime), "--cd", runtimeWorkspace, "pwd"], {
        cwd: process.cwd(),
        timeoutMs: 8000,
        commandId: "runtime.wsl.preflight.cd",
        runtimeKind: "wsl",
      });
      const check = {
        ok: cd.exitCode === 0,
        code: cd.exitCode === 0 ? "ok" as const : "path_unreachable" as const,
        severity: cd.exitCode === 0 ? "info" as const : "error" as const,
        summary: cd.exitCode === 0 ? "WSL 可以进入工作区路径。" : "WSL 无法进入工作区路径。",
        detail: cd.exitCode === 0 ? cd.stdout.trim() : cd.stderr || cd.stdout || `exit ${cd.exitCode ?? "unknown"}`,
        fixHint: cd.exitCode === 0 ? undefined : "请确认该 Windows 路径在 WSL 中可通过 /mnt/<drive> 访问，或选择 WSL 可访问的工作区。",
        debugContext: { workspacePath: input.workspacePath, runtimeWorkspace },
      };
      result.checks.push(check);
      if (!check.ok) {
        result.ok = false;
        result.issues.push({
          code: "path_unreachable",
          severity: "error",
          summary: check.summary,
          detail: check.detail,
          fixHint: check.fixHint,
          debugContext: check.debugContext,
        });
      }
    }
    return result;
  }

  async describeRuntime() {
    return `WSL runtime${this.runtime.distro ? ` (${this.runtime.distro})` : ""}`;
  }

  async shutdown(_reason?: string) {
    return;
  }

  private envArgs(env: NodeJS.ProcessEnv) {
    return Object.entries(sanitizeEnvForWsl(env))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => `${key}=${value}`);
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
