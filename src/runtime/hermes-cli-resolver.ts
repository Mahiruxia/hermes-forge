import path from "node:path";
import { runCommand, type CommandResult } from "../process/command-runner";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { HermesRuntimeConfig, RuntimeConfig } from "../shared/types";
import { toWslPath } from "./runtime-resolver";

const WSL_TIMEOUT_MS = 12_000;
const RESOLVED_WSL_CLI_CACHE_MS = 60_000;

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
  source: "saved" | "managed-home" | "path" | "home-find" | "windows";
  wslHome?: string;
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

let resolvedWslCliCache: { key: string; checkedAt: number; value: ResolvedHermesCli } | undefined;

export async function resolveHermesCliForRuntime(
  configStore: RuntimeConfigStore,
  runtime: HermesRuntimeConfig,
  options: { persist?: boolean } = {},
): Promise<ResolvedHermesCli> {
  const config = await configStore.read();
  if (runtime.mode !== "wsl") {
    const rootPath = await configStore.getEnginePath("hermes");
    return {
      runtime,
      rootPath,
      cliPath: path.join(rootPath, "hermes"),
      source: "windows",
    };
  }

  const cacheKey = resolvedWslCliCacheKey(config, runtime);
  if (resolvedWslCliCache?.key === cacheKey && Date.now() - resolvedWslCliCache.checkedAt < RESOLVED_WSL_CLI_CACHE_MS) {
    if (options.persist !== false) {
      await persistResolvedWslHermesRoot(configStore, config, runtime, resolvedWslCliCache.value.rootPath);
    }
    return resolvedWslCliCache.value;
  }

  const distro = runtime.distro?.trim();
  await assertWslDistroExists(runtime);
  const wslHome = await resolveWslHome(runtime);
  const candidates = await wslHermesCliCandidates(config, runtime, wslHome);
  const seen = new Set<string>();
  const failures: string[] = [];

  for (const candidate of candidates) {
    const cliPath = candidate.cliPath.trim();
    if (!cliPath || seen.has(cliPath)) continue;
    seen.add(cliPath);
    const exists = await wslPathTest(runtime, cliPath, "-f");
    if (!exists.ok) {
      failures.push(`${candidate.source}:${cliPath}: ${exists.message}`);
      continue;
    }
    const readable = await wslPathTest(runtime, cliPath, "-r");
    if (!readable.ok) {
      throw new Error(`Hermes CLI 无执行权限或不可读取：${cliPath}。请修复 WSL 文件权限后重试。`);
    }
    const rootPath = dirnamePosix(cliPath);
    if (options.persist !== false) {
      await persistResolvedWslHermesRoot(configStore, config, runtime, rootPath);
    }
    const resolved = {
      runtime,
      rootPath,
      cliPath,
      source: candidate.source,
      wslHome,
    };
    resolvedWslCliCache = { key: cacheKey, checkedAt: Date.now(), value: resolved };
    return resolved;
  }

  throw new Error([
    "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。",
    distro ? `WSL distro: ${distro}` : "WSL distro: <default>",
    `WSL HOME: ${wslHome}`,
    `已尝试: ${candidates.map((item) => item.cliPath).join("；") || "<none>"}`,
    failures.length ? `失败详情: ${failures.slice(0, 6).join("；")}` : "",
  ].filter(Boolean).join(" "));
}

function resolvedWslCliCacheKey(config: RuntimeConfig, runtime: HermesRuntimeConfig) {
  return [
    runtime.mode,
    runtime.distro?.trim() ?? "",
    runtime.pythonCommand?.trim() ?? "python3",
    runtime.managedRoot?.trim() ?? "",
    config.hermesRuntime?.managedRoot?.trim() ?? "",
    config.enginePaths?.hermes?.trim() ?? "",
  ].join("\0");
}

export async function validateWslHermesCli(
  runtime: HermesRuntimeConfig,
  cliPath: string,
): Promise<HermesCliValidationResult> {
  if (runtime.mode !== "wsl") {
    return {
      ok: false,
      kind: "capability_failed",
      message: "capabilities 校验仅用于 WSL Hermes CLI。",
    };
  }
  const fileCheck = await wslPathTest(runtime, cliPath, "-f");
  if (!fileCheck.ok) {
    return {
      ok: false,
      kind: "file_missing",
      message: "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。",
      result: fileCheck.result,
    };
  }
  const readableCheck = await wslPathTest(runtime, cliPath, "-r");
  if (!readableCheck.ok) {
    return {
      ok: false,
      kind: "permission_denied",
      message: `Hermes CLI 无执行权限或不可读取：${cliPath}`,
      result: readableCheck.result,
    };
  }

  const pythonCommand = await resolveWslPythonForCli(runtime, cliPath);
  const rootPath = dirnamePosix(cliPath);
  const args = [
    ...wslDistroArgs(runtime),
    "--",
    "bash",
    "-lc",
    `cd ${shellQuote(rootPath)} && exec ${shellQuote(pythonCommand)} ${shellQuote(cliPath)} capabilities --json`,
  ];
  const result = await runCommand("wsl.exe", args, {
    cwd: process.cwd(),
    timeoutMs: 20_000,
    commandId: "hermes-cli.validate.capabilities",
    runtimeKind: "wsl",
  });
  const command = `wsl.exe ${args.join(" ")}`;
  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout || "").trim();
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
          "Hermes CLI 存在，但版本 / capability 不满足 Forge WSL 最低能力门槛。",
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

export async function resolveWslHome(runtime: Pick<HermesRuntimeConfig, "distro">) {
  const args = [...wslDistroArgs(runtime), "--", "bash", "-lc", "printf %s \"$HOME\""];
  const result = await runCommand("wsl.exe", args, {
    cwd: process.cwd(),
    timeoutMs: WSL_TIMEOUT_MS,
    commandId: "hermes-cli.resolve-wsl-home",
    runtimeKind: "wsl",
  });
  const home = result.stdout.trim();
  if (result.exitCode !== 0 || !home) {
    throw new Error(`无法发现 WSL HOME：${result.stderr || result.stdout || `exit ${result.exitCode ?? "unknown"}`}`);
  }
  return home;
}

async function assertWslDistroExists(runtime: Pick<HermesRuntimeConfig, "distro">) {
  const list = await runCommand("wsl.exe", ["-l", "-q"], {
    cwd: process.cwd(),
    timeoutMs: WSL_TIMEOUT_MS,
    commandId: "hermes-cli.wsl-list",
    runtimeKind: "windows",
  });
  if (list.exitCode !== 0) {
    throw new Error(`WSL 不可用：${list.stderr || list.stdout || `exit ${list.exitCode ?? "unknown"}`}`);
  }
  const distros = list.stdout.replace(/\0/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const distro = runtime.distro?.trim();
  const exists = distro ? distros.some((item) => item.toLowerCase() === distro.toLowerCase()) : distros.length > 0;
  if (!exists) {
    throw new Error(distro ? `WSL distro 不存在：${distro}` : "没有可用 WSL distro。");
  }
}

async function wslHermesCliCandidates(
  config: RuntimeConfig,
  runtime: HermesRuntimeConfig,
  wslHome: string,
): Promise<Array<{ cliPath: string; source: ResolvedHermesCli["source"] }>> {
  const saved = [
    config.hermesRuntime?.managedRoot,
    config.enginePaths?.hermes,
  ].filter((item): item is string => Boolean(item?.trim()));
  const candidates: Array<{ cliPath: string; source: ResolvedHermesCli["source"] }> = [];
  for (const item of saved) {
    candidates.push({ cliPath: normalizeSavedWslHermesCliPath(item), source: "saved" });
  }
  candidates.push({ cliPath: `${wslHome.replace(/\/+$/, "")}/.hermes-forge/hermes-agent/hermes`, source: "managed-home" });

  const commandPath = await runWslBash(runtime, "command -v hermes || true", "hermes-cli.find-command");
  if (commandPath.exitCode === 0 && commandPath.stdout.trim()) {
    candidates.push({ cliPath: commandPath.stdout.trim().split(/\r?\n/)[0]!, source: "path" });
  }
  return candidates;
}

function normalizeSavedWslHermesCliPath(savedPath: string) {
  const normalized = toWslPath(savedPath.trim()).replace(/\/+$/, "");
  return /\/hermes$/i.test(normalized) ? normalized : `${normalized}/hermes`;
}

async function resolveWslPythonForCli(runtime: Pick<HermesRuntimeConfig, "distro" | "pythonCommand">, cliPath: string) {
  const venvPython = `${dirnamePosix(cliPath)}/.venv/bin/python`;
  const venvCheck = await wslPathTest(runtime, venvPython, "-x");
  if (venvCheck.ok) {
    return venvPython;
  }
  return runtime.pythonCommand?.trim() || "python3";
}

async function wslPathTest(runtime: Pick<HermesRuntimeConfig, "distro">, targetPath: string, testFlag: "-f" | "-r" | "-x") {
  const result = await runCommand("wsl.exe", [...wslDistroArgs(runtime), "--", "bash", "-lc", `test ${testFlag} ${shellQuote(targetPath)}`], {
    cwd: process.cwd(),
    timeoutMs: WSL_TIMEOUT_MS,
    commandId: `hermes-cli.path-test.${testFlag.slice(1)}`,
    runtimeKind: "wsl",
  });
  return {
    ok: result.exitCode === 0,
    result,
    message: result.stderr || result.stdout || `test ${testFlag} failed with exit ${result.exitCode ?? "unknown"}`,
  };
}

async function runWslBash(runtime: Pick<HermesRuntimeConfig, "distro">, script: string, commandId: string) {
  return runCommand("wsl.exe", [...wslDistroArgs(runtime), "--", "bash", "-lc", script], {
    cwd: process.cwd(),
    timeoutMs: WSL_TIMEOUT_MS,
    commandId,
    runtimeKind: "wsl",
  });
}

async function persistResolvedWslHermesRoot(
  configStore: RuntimeConfigStore,
  config: RuntimeConfig,
  runtime: HermesRuntimeConfig,
  rootPath: string,
) {
  const nextRuntime = {
    ...(config.hermesRuntime ?? runtime),
    mode: "wsl" as const,
    distro: runtime.distro ?? config.hermesRuntime?.distro,
    pythonCommand: runtime.pythonCommand?.trim() || config.hermesRuntime?.pythonCommand?.trim() || "python3",
    managedRoot: rootPath,
  };
  if (config.hermesRuntime?.managedRoot === rootPath && config.enginePaths?.hermes === rootPath) {
    return;
  }
  await configStore.write({
    ...config,
    hermesRuntime: nextRuntime,
    enginePaths: {
      ...(config.enginePaths ?? {}),
      hermes: rootPath,
    },
  });
}

function dirnamePosix(inputPath: string) {
  const normalized = inputPath.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "/";
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function wslDistroArgs(runtime: Pick<HermesRuntimeConfig, "distro">) {
  return runtime.distro?.trim() ? ["-d", runtime.distro.trim()] : [];
}

function formatCapabilityFailureMessage(exitCode: number | null | undefined, output: string) {
  const missingModule = detectMissingPythonModule(output);
  if (missingModule) {
    const packageName = missingModule === "dotenv" ? "python-dotenv" : missingModule === "yaml" ? "PyYAML" : missingModule;
    return [
      `capabilities --json 执行失败：Hermes CLI 的 Python 环境缺少依赖 ${packageName}。`,
      "这通常不是模型配置问题，而是 WSL 中当前 Hermes 安装没有完成 pip 依赖安装，或 Forge 接到了 Windows 目录里的裸源码。",
      "请点击一键修复 / 重新安装 Hermes；Forge 会优先复用现有 Hermes，并为它补齐 WSL venv 依赖。",
      output,
    ].filter(Boolean).join("\n");
  }
  return `capabilities --json 执行失败：exit ${exitCode ?? "unknown"}。${output}`;
}

function detectMissingPythonModule(output: string) {
  const match = output.match(/ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/i);
  return match?.[1];
}
