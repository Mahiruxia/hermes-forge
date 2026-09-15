import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelProfile, RuntimeConfig } from "../shared/types";
import { normalizeSourceTypeForProfile, resolveHermesProvider } from "../shared/model-config";
import { getPlatformKind, type PlatformKind } from "../platform";
import type { InstallSource } from "./install-source";
import type { ManagedHermesEnvironment } from "../runtime/managed-hermes-environment";
import { managedHermesEnvironmentEnv, managedHermesEnvironmentAt, resolveManagedHermesEnvironment } from "../runtime/managed-hermes-environment";

export type MaintenanceRunner = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

async function checked(run: MaintenanceRunner, command: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = await run(command, args, env);
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} 失败：${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
  return result.stdout.trim();
}

/** In-place, resumable source update. Never creates or restores a stash. */
export async function synchronizeHermesSource(source: InstallSource, run: MaintenanceRunner) {
  const status = await checked(run, "git", ["status", "--porcelain", "--untracked-files=no"]);
  const changed = status.split(/\r?\n/).filter(Boolean);
  const otherChanges = changed.filter((line) => !/^[ MARCUD?!]{1,2}\s+uv\.lock$/.test(line));
  if (otherChanges.length) throw new Error("Hermes 源码存在本地修改，请先处理这些修改后再更新；客户端不会覆盖源码或操作 Git stash。");
  const remote = await run("git", ["remote", "get-url", "origin"]);
  await checked(run, "git", ["remote", remote.exitCode === 0 ? "set-url" : "add", "origin", source.repoUrl]);
  const target = source.commit ?? source.branch ?? "main";
  await checked(run, "git", ["fetch", "--depth", "1", "origin", target]);
  const commit = await checked(run, "git", ["rev-parse", "FETCH_HEAD"]);
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("无法验证下载的 Hermes Git 提交。");
  if (source.commit && (!/^[a-f0-9]{7,40}$/i.test(source.commit) || !commit.toLowerCase().startsWith(source.commit.toLowerCase()))) {
    throw new Error("下载的 Hermes 提交与指定版本不一致，未切换代码。");
  }
  if (changed.length) {
    // uv.lock is generated state; upgrade uses the target release's lockfile.
    await checked(run, "git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", "uv.lock"]);
  }
  await checked(run, "git", ["checkout", "--detach", commit]);
  const actual = await checked(run, "git", ["rev-parse", "HEAD"]);
  if (actual !== commit) throw new Error("Hermes 源码切换未完成，请重新运行更新。");
  return commit;
}

type ConnectorSettings = { platforms?: Record<string, { enabled?: boolean; instances?: Record<string, { enabled?: boolean }> }> };

function requiresAnthropicRuntime(profile: ModelProfile): boolean {
  const provider = resolveHermesProvider({ provider: profile.provider, sourceType: normalizeSourceTypeForProfile(profile) });
  // These native routes use Hermes' Anthropic Messages client, even when Forge
  // stores a Coding Plan under provider=custom. Keep SDK selection aligned with
  // hermes_cli/runtime_provider.py and the same provider mapping used at launch.
  if (["anthropic", "kimi-coding", "kimi-coding-cn", "minimax", "minimax-cn"].includes(provider)) return true;
  try {
    const url = new URL(profile.baseUrl ?? "");
    const pathname = url.pathname.toLowerCase().replace(/\/+$/, "");
    return url.hostname.toLowerCase() === "api.anthropic.com"
      || /\/anthropic(?:\/v1)?$/.test(pathname)
      || (url.hostname.toLowerCase() === "api.kimi.com" && pathname.includes("/coding"));
  } catch { return false; }
}

export function configuredHermesExtras(config: RuntimeConfig, connectors: ConnectorSettings = {}): string[] {
  const extras = new Set(["mcp"]);
  const selectedIds = new Set([config.defaultModelProfileId, ...Object.values(config.modelRoleAssignments ?? {})]);
  if (!config.modelProfiles.some((profile) => profile.id === (config.modelRoleAssignments?.chat ?? config.defaultModelProfileId))) {
    selectedIds.add(config.modelProfiles.find((profile) => profile.id === config.defaultModelProfileId)?.id ?? config.modelProfiles[0]?.id);
  }
  if (config.modelProfiles.some((profile) => selectedIds.has(profile.id) && requiresAnthropicRuntime(profile))) extras.add("anthropic");
  if (config.extensionSettings?.connectorsEnabled !== true) return [...extras].sort();
  const mapping: Record<string, string> = {
    telegram: "messaging", discord: "messaging", weixin: "messaging", qq: "messaging", qqbot: "messaging",
    slack: "slack", feishu: "feishu", dingtalk: "dingtalk", matrix: "matrix",
    teams: "teams", sms: "sms", homeassistant: "homeassistant", wecom: "wecom",
  };
  for (const [platform, settings] of Object.entries(connectors.platforms ?? {})) {
    const enabled = settings.enabled !== false && (settings.instances
      ? Object.values(settings.instances).some((instance) => instance.enabled !== false)
      : true);
    const extra = mapping[platform];
    if (enabled && extra) extras.add(extra);
  }
  return [...extras].sort();
}

export async function readConfiguredHermesExtras(config: RuntimeConfig, baseDir: string) {
  if (config.extensionSettings?.connectorsEnabled !== true) return configuredHermesExtras(config);
  const raw = await fs.readFile(path.join(baseDir, "connectors-config.json"), "utf8").catch(() => undefined);
  let connectors: ConnectorSettings = {};
  if (raw) {
    try { connectors = JSON.parse(raw) as ConnectorSettings; }
    catch { throw new Error("连接器配置无法解析，未同步依赖；请先修复连接器配置。"); }
  }
  return configuredHermesExtras(config, connectors);
}

export async function findUvCommand(run: MaintenanceRunner, rootPath?: string) {
  const executable = process.platform === "win32" ? "uv.exe" : "uv";
  const candidates = ["uv", path.join(os.homedir(), ".local", "bin", executable), path.join(os.homedir(), ".cargo", "bin", executable)];
  if (rootPath) candidates.unshift(path.join(path.dirname(rootPath), "bin", executable));
  if (process.env.HERMES_HOME) candidates.unshift(path.join(process.env.HERMES_HOME, "bin", executable));
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", executable));
  }
  for (const candidate of candidates) {
    const result = await run(candidate, ["--version"]).catch(() => undefined);
    if (result?.exitCode === 0) return candidate;
  }
  throw new Error("未找到 uv。请安装 uv 后重新运行 Hermes 更新；不会改用系统 Python 安装依赖。");
}

type InterpreterIdentity = { version: number[]; basePrefix: string; baseExecutable: string };

async function inspectInterpreter(command: string, environment: ManagedHermesEnvironment, run: MaintenanceRunner): Promise<InterpreterIdentity | undefined> {
  const env = managedHermesEnvironmentEnv(environment, { UV_PYTHON: undefined });
  const result = await run(command, ["-I", "-c", "import json,sys; print(json.dumps({'version': list(sys.version_info[:2]), 'basePrefix': sys.base_prefix, 'baseExecutable': getattr(sys, '_base_executable', sys.executable)}))"], env);
  if (result.exitCode !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as Partial<InterpreterIdentity>;
    if (!Array.isArray(parsed.version) || typeof parsed.basePrefix !== "string" || typeof parsed.baseExecutable !== "string") return undefined;
    return parsed as InterpreterIdentity;
  } catch { return undefined; }
}

function usableInterpreter(python: InterpreterIdentity | undefined): python is InterpreterIdentity {
  return Boolean(python && python.version[0] === 3 && [11, 12, 13].includes(python.version[1] ?? 0)
    && path.isAbsolute(python.baseExecutable)
    && !/WindowsApps[\\/].*PythonSoftwareFoundation|PythonSoftwareFoundation\.Python/i.test(python.basePrefix));
}

async function prepareInterpreter(environment: ManagedHermesEnvironment, uv: string, run: MaintenanceRunner) {
  const current = await inspectInterpreter(environment.pythonPath, environment, run);
  if (usableInterpreter(current)) return current;
  // Provision and execute a replacement base interpreter BEFORE replacing the
  // selected venv. This never operates on system Python packages or another venv.
  const env = managedHermesEnvironmentEnv(environment, { UV_PYTHON: undefined });
  let found = await run(uv, ["python", "find", "--managed-python", "3.11"], env);
  if (found.exitCode !== 0) {
    await checked(run, uv, ["python", "install", "3.11"], env);
    found = await run(uv, ["python", "find", "--managed-python", "3.11"], env);
  }
  const executable = found.stdout.trim();
  if (found.exitCode !== 0 || !path.isAbsolute(executable)) throw new Error("无法找到 uv 管理的 Python 3.11，未替换 Hermes 环境。");
  const replacement = await inspectInterpreter(executable, environment, run);
  if (!usableInterpreter(replacement)) throw new Error("替代 Python 检查失败，未替换 Hermes 环境。");
  const resolvedRoot = path.resolve(environment.rootPath);
  const resolvedVenv = path.resolve(environment.venvPath);
  if (path.dirname(resolvedVenv) !== resolvedRoot || !["venv", ".venv"].includes(path.basename(resolvedVenv))) throw new Error("虚拟环境路径不在 Hermes 安装目录中，未替换环境。");
  const stat = await fs.lstat(resolvedVenv).catch(() => undefined);
  if (stat?.isSymbolicLink()) throw new Error("Hermes 虚拟环境是链接，请手动修复其基础解释器。");
  await checked(run, uv, ["venv", "--clear", "--python", replacement.baseExecutable, environment.venvPath], env);
  const repaired = await inspectInterpreter(environment.pythonPath, environment, run);
  if (!usableInterpreter(repaired)) throw new Error("Hermes 虚拟环境重建未完成，请重新运行修复。");
  return repaired;
}

export async function synchronizeHermesDependencies(environment: ManagedHermesEnvironment, extras: string[], run: MaintenanceRunner) {
  const uv = await findUvCommand(run, environment.rootPath);
  const python = await prepareInterpreter(environment, uv, run);
  // --python must name the verified base interpreter, never the executable
  // inside the venv being synchronized. An explicit base also prevents the
  // repository's .python-version from silently replacing a compatible venv.
  const env = managedHermesEnvironmentEnv(environment, { UV_PYTHON: python.baseExecutable, UV_PYTHON_DOWNLOADS: "never" });
  await checked(run, uv, ["sync", "--locked", "--no-dev", "--python", python.baseExecutable, ...extras.flatMap((extra) => ["--extra", extra])], env);
  await checked(run, uv, ["pip", "check", "--python", environment.pythonPath], env);
}

export async function ensureManagedHermesEnvironment(rootPath: string, run: MaintenanceRunner, platform: PlatformKind = getPlatformKind()) {
  const existing = await resolveManagedHermesEnvironment(rootPath, platform);
  if (existing) return existing;
  const environment = managedHermesEnvironmentAt(rootPath, "venv", platform);
  const existingDirectory = await fs.lstat(environment.venvPath).catch(() => undefined);
  if (existingDirectory?.isDirectory()) return environment; // interrupted creation is repaired after provisioning a usable base
  if (existingDirectory) throw new Error("Hermes venv 路径不是普通目录，未覆盖该路径。");
  const uv = await findUvCommand(run, rootPath);
  await checked(run, uv, ["venv", "--managed-python", "--python", "3.11", environment.venvPath]);
  return environment;
}
