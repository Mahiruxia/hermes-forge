import path from "node:path";
import { runCommand } from "../process/command-runner";
import type { HermesRuntimeConfig } from "../shared/types";
import { parseCommandLine, RuntimeResolver } from "./runtime-resolver";
import type { RuntimeProbeService } from "./runtime-probe-service";
import type { RuntimeAdapter } from "./runtime-adapter";
import { preflightFromProbe } from "./runtime-adapter";
import type { BuildHermesLaunchInput, RuntimeLaunchSpec, RuntimePreflightResult, RuntimeProbeResult } from "./runtime-types";
import { isWindowsHermesExecutable } from "./hermes-cli-paths";

export class NativeRuntimeAdapter implements RuntimeAdapter {
  private pythonSpec?: Promise<{ command: string; args: string[]; label: string; lastError?: string }>;

  constructor(
    private readonly runtime: HermesRuntimeConfig,
    private readonly runtimeResolver: RuntimeResolver,
    private readonly runtimeProbeService: RuntimeProbeService,
  ) {}

  getKind() {
    return "windows" as const;
  }

  probe(workspacePath?: string): Promise<RuntimeProbeResult> {
    return this.runtimeProbeService.probe({ workspacePath, runtime: { ...this.runtime, mode: "windows" } });
  }

  async buildHermesLaunch(input: BuildHermesLaunchInput): Promise<RuntimeLaunchSpec> {
    const cliPath = input.pythonArgs[0] ?? path.join(input.rootPath, "hermes");
    if (isWindowsHermesExecutable(cliPath)) {
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
      runtimeKind: "windows",
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
      runtimeKind: "windows",
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
    return "Windows Native runtime";
  }

  async shutdown(_reason?: string) {
    return;
  }

  private async resolvePython(rootPath: string, cliPath: string | undefined, env: NodeJS.ProcessEnv) {
    this.pythonSpec ??= this.detectPython(rootPath, cliPath ?? path.join(rootPath, "hermes"), env);
    return await this.pythonSpec;
  }

  private async detectPython(rootPath: string, cliPath: string, env: NodeJS.ProcessEnv) {
    const candidates = this.pythonCandidates(rootPath);
    let lastError = "";
    for (const candidate of candidates) {
      const result = await runCommand(candidate.command, [...candidate.args, cliPath, "--version"], {
        cwd: rootPath,
        timeoutMs: 20_000,
        env,
        commandId: "runtime.native.detect-python",
        runtimeKind: "windows",
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode === 0 && /Hermes Agent/i.test(output)) {
        return candidate;
      }
      lastError = `${candidate.label} ${cliPath} --version failed: ${output.trim() || `exit ${result.exitCode ?? "unknown"}`}`;
    }
    return { command: "python", args: [], label: "python", lastError };
  }

  private pythonCandidates(rootPath: string) {
    const candidates: Array<{ command: string; args: string[]; label: string }> = [];
    const add = (raw: string | undefined) => {
      const parsed = raw?.trim() ? parseCommandLine(raw) : undefined;
      if (!parsed) return;
      if (!candidates.some((item) => item.command === parsed.command && item.args.join("\0") === parsed.args.join("\0"))) {
        candidates.push(parsed);
      }
    };
    add(this.runtime.pythonCommand);
    add(path.join(rootPath, ".venv", "Scripts", "python.exe"));
    add(path.join(rootPath, "venv", "Scripts", "python.exe"));
    add("py -3");
    add("python");
    add("python3");
    return candidates;
  }
}
