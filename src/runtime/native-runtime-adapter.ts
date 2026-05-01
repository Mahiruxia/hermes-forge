import path from "node:path";
import { runCommand } from "../process/command-runner";
import type { HermesRuntimeConfig } from "../shared/types";
import { getPlatformKind, getPythonCandidates, isHermesExecutable } from "../platform";
import { parseCommandLine, RuntimeResolver } from "./runtime-resolver";
import type { RuntimeProbeService } from "./runtime-probe-service";
import type { RuntimeAdapter } from "./runtime-adapter";
import { preflightFromProbe } from "./runtime-adapter";
import type { BuildHermesLaunchInput, RuntimeLaunchSpec, RuntimePreflightResult, RuntimeProbeResult } from "./runtime-types";

export class NativeRuntimeAdapter implements RuntimeAdapter {
  private pythonSpec?: Promise<{ command: string; args: string[]; label: string; lastError?: string }>;
  private readonly platform = getPlatformKind();

  constructor(
    private readonly runtime: HermesRuntimeConfig,
    private readonly runtimeResolver: RuntimeResolver,
    private readonly runtimeProbeService: RuntimeProbeService,
  ) {}

  getKind() {
    return this.platform === "win32" ? "windows" : (this.runtime.mode as HermesRuntimeConfig["mode"]);
  }

  probe(workspacePath?: string): Promise<RuntimeProbeResult> {
    return this.runtimeProbeService.probe({ workspacePath, runtime: { ...this.runtime, mode: this.getKind() } });
  }

  async buildHermesLaunch(input: BuildHermesLaunchInput): Promise<RuntimeLaunchSpec> {
    const cliPath = input.pythonArgs[0] ?? path.join(input.rootPath, "hermes");
    if (isHermesExecutable(cliPath, this.platform)) {
      return this.launchFromExecutable(input, cliPath, input.pythonArgs.slice(1));
    }
    const python = await this.resolvePython(input.rootPath, cliPath, input.env);
    return this.launchFromPython(input, python, input.pythonArgs);
  }

  async buildPythonLaunch(input: BuildHermesLaunchInput): Promise<RuntimeLaunchSpec> {
    const python = await this.resolvePython(input.rootPath, path.join(input.rootPath, "hermes"), input.env);
    return this.launchFromPython(input, python, input.pythonArgs);
  }

  private launchFromPython(
    input: BuildHermesLaunchInput,
    python: { command: string; args: string[]; label: string },
    pythonArgs: string[],
  ): RuntimeLaunchSpec {
    return {
      command: python.command,
      args: [...python.args, ...pythonArgs],
      cwd: input.cwd,
      env: input.env,
      detached: false,
      runtimeKind: this.getKind(),
      diagnostics: {
        label: python.label,
        runtimeRootPath: input.rootPath,
        runtimeCwd: input.cwd,
        pythonCommand: python.label,
      },
    };
  }

  private launchFromExecutable(
    input: BuildHermesLaunchInput,
    cliPath: string,
    args: string[],
  ): RuntimeLaunchSpec {
    return {
      command: cliPath,
      args,
      cwd: input.cwd,
      env: input.env,
      detached: false,
      runtimeKind: this.getKind(),
      diagnostics: {
        label: "Hermes CLI executable",
        runtimeRootPath: input.rootPath,
        runtimeCwd: input.cwd,
        pythonCommand: cliPath,
      },
    };
  }

  toRuntimePath(inputPath: string) {
    return inputPath;
  }

  async getBridgeAccessHost() {
    return "127.0.0.1";
  }

  async preflight(input?: { workspacePath?: string }): Promise<RuntimePreflightResult> {
    return preflightFromProbe(await this.probe(input?.workspacePath));
  }

  async describeRuntime() {
    return this.platform === "win32" ? "Windows Native runtime" : "Native runtime";
  }

  async shutdown(_reason?: string) {
    return;
  }

  private async resolvePython(rootPath: string, cliPath: string | undefined, env: NodeJS.ProcessEnv) {
    this.pythonSpec ??= this.detectPython(rootPath, cliPath ?? path.join(rootPath, "hermes"), env);
    return await this.pythonSpec;
  }

  private async detectPython(rootPath: string, cliPath: string, env: NodeJS.ProcessEnv) {
    const candidates = getPythonCandidates(this.platform, rootPath);
    let lastError = "";
    for (const candidate of candidates) {
      const result = await runCommand(candidate.command, [...candidate.args, cliPath, "--version"], {
        cwd: rootPath,
        timeoutMs: 20_000,
        env,
        commandId: "runtime.native.detect-python",
        runtimeKind: this.getKind(),
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode === 0 && /Hermes Agent/i.test(output)) {
        return candidate;
      }
      lastError = `${candidate.label} ${cliPath} --version failed: ${output.trim() || `exit ${result.exitCode ?? "unknown"}`}`;
    }
    return { command: this.platform === "win32" ? "python" : "python3", args: [], label: this.platform === "win32" ? "python" : "python3", lastError };
  }
}
