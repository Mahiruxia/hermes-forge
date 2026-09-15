import fs from "node:fs/promises";
import type { HermesRuntimeConfig } from "../shared/types";
import { getPlatformKind } from "../platform";
import type { RuntimeResolver } from "./runtime-resolver";
import type { RuntimeProbeService } from "./runtime-probe-service";
import type { RuntimeAdapter } from "./runtime-adapter";
import { preflightFromProbe } from "./runtime-adapter";
import type { BuildHermesLaunchInput, RuntimeLaunchSpec, RuntimePreflightResult, RuntimeProbeResult } from "./runtime-types";
import { requireManagedHermesEnvironment, managedHermesEnvironmentEnv } from "./managed-hermes-environment";

export class NativeRuntimeAdapter implements RuntimeAdapter {
  private readonly platform = getPlatformKind();

  constructor(
    private readonly runtime: HermesRuntimeConfig,
    _runtimeResolver: RuntimeResolver,
    private readonly runtimeProbeService: RuntimeProbeService,
  ) {}

  getKind() {
    return this.platform === "win32" ? "windows" : (this.runtime.mode as HermesRuntimeConfig["mode"]);
  }

  probe(workspacePath?: string): Promise<RuntimeProbeResult> {
    return this.runtimeProbeService.probe({ workspacePath, runtime: { ...this.runtime, mode: this.getKind() } });
  }

  async buildHermesLaunch(input: BuildHermesLaunchInput): Promise<RuntimeLaunchSpec> {
    const environment = await requireManagedHermesEnvironment(input.rootPath);
    const cliPath = environment.cliPath;
    if (!(await exists(cliPath))) throw new Error("Hermes 虚拟环境中缺少 CLI，请修复 Hermes 依赖。");
    input = { ...input, env: managedHermesEnvironmentEnv(environment, input.env) };
    return this.launchFromExecutable(input, cliPath, input.pythonArgs.slice(1));
  }

  async buildPythonLaunch(input: BuildHermesLaunchInput): Promise<RuntimeLaunchSpec> {
    const environment = await requireManagedHermesEnvironment(input.rootPath);
    return this.launchFromPython(
      { ...input, env: managedHermesEnvironmentEnv(environment, input.env) },
      { command: environment.pythonPath, args: [], label: environment.pythonPath },
      input.pythonArgs,
    );
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

}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
