import { runCommand, type CommandResult } from "../process/command-runner";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { HermesRuntimeConfig } from "../shared/types";
import { isAtLeastVersion, parseHermesVersion } from "../install/hermes-version";
import { RESUME_SUPPORT_VERSION } from "../install/hermes-version-constants";
import type { RuntimeAdapter } from "./runtime-adapter";
import {
  defaultWindowsHermesCliPath,
  inferWindowsHermesRootFromCliPath,
  resolveWindowsHermesCliPath,
} from "./hermes-cli-paths";

export type HermesCliValidationFailureKind =
  | "distro_missing"
  | "file_missing"
  | "permission_denied"
  | "capability_failed"
  | "capability_unsupported";

export type ResolvedHermesCli = {
  runtime: HermesRuntimeConfig;
  rootPath: string;
  cliPath: string;
  source: "windows";
  capabilities?: {
    cliVersion?: string;
    supportsLaunchMetadataArg: boolean;
    supportsLaunchMetadataEnv: boolean;
    supportsResume: boolean;
    raw: string;
  };
};

export type HermesCliValidationFailure = {
  ok: false;
  kind: HermesCliValidationFailureKind;
  message: string;
  command?: string;
  result?: CommandResult;
  capabilities?: NonNullable<ResolvedHermesCli["capabilities"]>;
};

export type HermesCliValidationResult =
  | { ok: true; capabilities: NonNullable<ResolvedHermesCli["capabilities"]>; command: string; result: CommandResult }
  | HermesCliValidationFailure;

export async function resolveHermesCliForRuntime(
  configStore: RuntimeConfigStore,
  runtime: HermesRuntimeConfig,
  _options: { persist?: boolean } = {},
): Promise<ResolvedHermesCli> {
  const rootPath = await configStore.getEnginePath("hermes");
  const cliPath = await resolveWindowsHermesCliPath(rootPath) ?? defaultWindowsHermesCliPath(rootPath);
  return {
    runtime: { ...runtime, mode: "windows", distro: undefined, workerMode: "off" },
    rootPath,
    cliPath,
    source: "windows",
  };
}

export async function validateHermesCli(input: {
  runtime: HermesRuntimeConfig;
  cliPath: string;
  runtimeAdapter?: RuntimeAdapter;
}): Promise<HermesCliValidationResult> {
  if (!input.runtimeAdapter) {
    return {
      ok: false,
      kind: "capability_failed",
      message: "Native Hermes CLI 校验需要提供 RuntimeAdapter。",
    };
  }
  return validateNativeHermesCli(input.runtimeAdapter, input.cliPath);
}

export async function validateNativeHermesCli(
  adapter: RuntimeAdapter,
  cliPath: string,
): Promise<HermesCliValidationResult> {
  const rootPath = inferWindowsHermesRootFromCliPath(cliPath);
  const launch = await adapter.buildHermesLaunch({
    runtime: { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" },
    rootPath,
    pythonArgs: [cliPath, "capabilities", "--json"],
    cwd: rootPath,
    env: {
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: rootPath,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
  const result = await runCommand(launch.command, launch.args, {
    cwd: launch.cwd,
    timeoutMs: 20_000,
    env: launch.env,
    commandId: "hermes-cli.validate.capabilities.native",
    runtimeKind: "windows",
  });
  const command = `${launch.command} ${launch.args.join(" ")}`;
  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout || "").trim();
    const fallback = await probeNativeHermesVersionAsFallback(adapter, cliPath, rootPath);
    if (fallback) {
      return {
        ok: false,
        kind: "capability_unsupported",
        message: fallback.message,
        command: fallback.command,
        result: fallback.result,
        capabilities: fallback.capabilities,
      };
    }
    return {
      ok: false,
      kind: "capability_failed",
      message: formatCapabilityFailureMessage(result.exitCode, output),
      command,
      result,
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
      raw: result.stdout,
    };
    if (!capabilities.cliVersion || !capabilities.supportsLaunchMetadataArg || !capabilities.supportsLaunchMetadataEnv || !capabilities.supportsResume) {
      return {
        ok: false,
        kind: "capability_unsupported",
        message: [
          "Hermes CLI 存在，但版本 / capability 不满足 Forge 最低能力门槛。",
          `缺失: ${[
            capabilities.cliVersion ? undefined : "cliVersion",
            capabilities.supportsLaunchMetadataArg ? undefined : "supportsLaunchMetadataArg",
            capabilities.supportsLaunchMetadataEnv ? undefined : "supportsLaunchMetadataEnv",
            capabilities.supportsResume ? undefined : "supportsResume",
          ].filter(Boolean).join(", ")}`,
        ].join(" "),
        command,
        result,
        capabilities,
      };
    }
    return { ok: true, capabilities, command, result };
  } catch (error) {
    return {
      ok: false,
      kind: "capability_failed",
      message: `capabilities --json 返回内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      command,
      result,
    };
  }
}

export async function validateWslHermesCli(
  _runtime: HermesRuntimeConfig,
  _cliPath: string,
): Promise<HermesCliValidationResult> {
  return {
    ok: false,
    kind: "capability_unsupported",
    message: "WSL runtime 已停用；请使用 Windows Native Hermes。旧 WSL 数据仅可通过 Legacy WSL Migration 导入。",
  };
}

export async function resolveWslHome(_runtime: Pick<HermesRuntimeConfig, "distro">) {
  throw new Error("WSL runtime 已停用；旧 WSL 数据导入请使用 Legacy WSL Migration。");
}

function formatCapabilityFailureMessage(exitCode: number | null | undefined, output: string) {
  const missingModule = detectMissingPythonModule(output);
  if (missingModule) {
    const packageName = missingModule === "dotenv" ? "python-dotenv" : missingModule === "yaml" ? "PyYAML" : missingModule;
    return [
      `capabilities --json 执行失败：Hermes CLI 的 Python 环境缺少依赖 ${packageName}。`,
      "这通常不是模型配置问题，而是当前 Hermes 安装没有完成 pip 依赖安装。",
      "请点击一键修复 / 重新安装 Hermes；Forge 会优先复用现有 Hermes，并为它补齐 Windows venv 依赖。",
      output,
    ].filter(Boolean).join("\n");
  }
  return `capabilities --json 执行失败：exit ${exitCode ?? "unknown"}。${output}`;
}

function detectMissingPythonModule(output: string) {
  const match = output.match(/ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/i);
  return match?.[1];
}

async function probeNativeHermesVersionAsFallback(
  adapter: RuntimeAdapter,
  cliPath: string,
  rootPath: string,
): Promise<ReturnType<typeof classifyVersionFallback>> {
  const launch = await adapter.buildHermesLaunch({
    runtime: { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" },
    rootPath,
    pythonArgs: [cliPath, "--version"],
    cwd: rootPath,
    env: {
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: rootPath,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
  const versionResult = await runCommand(launch.command, launch.args, {
    cwd: launch.cwd,
    timeoutMs: 20_000,
    env: launch.env,
    commandId: "hermes-cli.validate.version-fallback.native",
    runtimeKind: "windows",
  });
  const command = `${launch.command} ${launch.args.join(" ")}`;
  return classifyVersionFallback(versionResult, command);
}

function classifyVersionFallback(
  versionResult: CommandResult,
  command: string,
): { capabilities: NonNullable<ResolvedHermesCli["capabilities"]>; command: string; result: CommandResult; message: string } | undefined {
  if (versionResult.exitCode !== 0) {
    return undefined;
  }
  const version = parseHermesVersion(versionResult.stdout);
  if (!version || !isAtLeastVersion(version, RESUME_SUPPORT_VERSION)) {
    return undefined;
  }
  return {
    capabilities: {
      cliVersion: version,
      supportsLaunchMetadataArg: false,
      supportsLaunchMetadataEnv: false,
      supportsResume: true,
      raw: versionResult.stdout,
    },
    command,
    result: versionResult,
    message: `检测到 Hermes CLI ${version}（官方 ${RESUME_SUPPORT_VERSION}+），但该版本不支持 Forge 所需的 launch metadata 增强能力；Windows Native 主聊天仍以 Forge 兼容层为准。`,
  };
}
