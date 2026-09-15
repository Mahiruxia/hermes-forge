import { runCommand, type CommandResult } from "../process/command-runner";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { HermesRuntimeConfig } from "../shared/types";
import { isAtLeastVersion, parseHermesVersion } from "../install/hermes-version";
import { MINIMUM_HERMES_VERSION } from "../install/hermes-version-constants";
import type { RuntimeAdapter } from "./runtime-adapter";
import { inferHermesRootFromCliPathUniversal } from "./hermes-cli-paths";
import { requireManagedHermesEnvironment } from "./managed-hermes-environment";
import { HERMES_FORGE_CONTRACT_PROBE } from "./hermes-contract";

export type HermesCliValidationFailureKind = "distro_missing" | "file_missing" | "permission_denied" | "capability_failed" | "capability_unsupported";
export type ResolvedHermesCli = {
  runtime: HermesRuntimeConfig;
  rootPath: string;
  cliPath: string;
  source: "windows" | "darwin";
  capabilities?: { cliVersion?: string; supportsLaunchMetadataArg: boolean; supportsLaunchMetadataEnv: boolean; supportsResume: boolean; raw: string };
};
export type HermesCliValidationFailure = {
  ok: false; kind: HermesCliValidationFailureKind; message: string; command?: string; result?: CommandResult; capabilities?: NonNullable<ResolvedHermesCli["capabilities"]>;
};
export type HermesCliValidationResult =
  | { ok: true; capabilities: NonNullable<ResolvedHermesCli["capabilities"]>; command: string; result: CommandResult }
  | HermesCliValidationFailure;

export async function resolveHermesCliForRuntime(configStore: RuntimeConfigStore, runtime: HermesRuntimeConfig, _options: { persist?: boolean } = {}): Promise<ResolvedHermesCli> {
  const rootPath = await configStore.getEnginePath("hermes");
  const environment = await requireManagedHermesEnvironment(rootPath);
  const mode = process.platform === "darwin" ? "darwin" : "windows";
  return { runtime: { ...runtime, mode, distro: undefined, workerMode: "off" }, rootPath, cliPath: environment.cliPath, source: mode };
}

export async function validateHermesCli(input: { runtime: HermesRuntimeConfig; cliPath: string; runtimeAdapter?: RuntimeAdapter }): Promise<HermesCliValidationResult> {
  if (!input.runtimeAdapter) return { ok: false, kind: "capability_failed", message: "Hermes CLI 校验需要 RuntimeAdapter。" };
  return validateNativeHermesCli(input.runtimeAdapter, input.cliPath);
}

export async function validateNativeHermesCli(adapter: RuntimeAdapter, cliPath: string): Promise<HermesCliValidationResult> {
  try {
    const rootPath = inferHermesRootFromCliPathUniversal(cliPath);
    const runtime = { mode: adapter.getKind(), pythonCommand: "", windowsAgentMode: "hermes_native" as const };
    const launch = await adapter.buildHermesLaunch({ runtime, rootPath, pythonArgs: [cliPath, "--version"], cwd: rootPath, env: { NO_COLOR: "1", FORCE_COLOR: "0" } });
    const result = await runCommand(launch.command, launch.args, { cwd: rootPath, env: launch.env, timeoutMs: 20_000 });
    const command = `${launch.command} ${launch.args.join(" ")}`;
    const version = parseHermesVersion([result.stdout, result.stderr].join("\n"));
    if (result.exitCode !== 0 || !version) return { ok: false, kind: "capability_failed", message: "Hermes CLI 无法读取版本。", command, result };
    if (!isAtLeastVersion(version, MINIMUM_HERMES_VERSION)) return { ok: false, kind: "capability_unsupported", message: `需要 Hermes ${MINIMUM_HERMES_VERSION}+，当前为 ${version}。`, command, result };
    const probe = await adapter.buildPythonLaunch({ runtime, rootPath, pythonArgs: ["-c", HERMES_FORGE_CONTRACT_PROBE], cwd: rootPath, env: launch.env ?? {} });
    const contract = await runCommand(probe.command, probe.args, { cwd: rootPath, env: probe.env, timeoutMs: 60_000 });
    let parsed: { compatible?: boolean; error?: string; missing?: string[] };
    try { parsed = JSON.parse(contract.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}") as typeof parsed; }
    catch { return { ok: false, kind: "capability_failed", message: "Hermes 任务契约检查返回异常。", command, result: contract }; }
    if (contract.exitCode !== 0 || parsed.compatible !== true) return { ok: false, kind: "capability_unsupported", message: parsed.error ?? `Hermes 任务接口缺失：${parsed.missing?.join(", ") ?? "unknown"}`, command, result: contract };
    return { ok: true, capabilities: { cliVersion: version, supportsLaunchMetadataArg: false, supportsLaunchMetadataEnv: false, supportsResume: true, raw: contract.stdout }, command, result };
  } catch (error) {
    return { ok: false, kind: "capability_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function validateWslHermesCli(_runtime: HermesRuntimeConfig, _cliPath: string): Promise<HermesCliValidationResult> {
  return { ok: false, kind: "capability_unsupported", message: "WSL runtime 已停用；旧 WSL 数据请通过迁移功能导入。" };
}
export async function resolveWslHome(_runtime: Pick<HermesRuntimeConfig, "distro">) {
  throw new Error("WSL runtime 已停用；旧 WSL 数据请通过迁移功能导入。");
}
