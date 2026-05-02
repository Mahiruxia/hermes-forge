import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppPaths } from "../main/app-paths";
import { resolveActiveHermesHome } from "../main/hermes-home";
import { getDefaultPythonCommand, getPlatformKind } from "../platform";
import type { HermesRuntimeConfig, RuntimeConfig } from "../shared/types";
import type { RuntimeKind, RuntimePathDescriptor, RuntimePathResolution } from "./runtime-types";

export type ParsedCommand = {
  command: string;
  args: string[];
  label: string;
};

export class RuntimeResolver {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly resolveHermesRoot: () => Promise<string>,
  ) {}

  async resolvePaths(input: {
    runtime: HermesRuntimeConfig;
    workspacePath?: string;
  }): Promise<RuntimePathResolution> {
    const hermesRoot = await this.resolveHermesRoot().catch(() => input.runtime.managedRoot ?? "");
    const activeHermesHome = await resolveActiveHermesHome(this.appPaths.hermesDir());
    const appUserDataPath = descriptor("app-user-data", this.appPaths.baseDir(), "windows-app", true, false, false, "Electron app userData directory.");
    const profileHermesPath = descriptor("profile-hermes", activeHermesHome, "windows-app", true, true, false, "Desktop-managed Hermes profile directory currently used by runtime.");
    const vaultPath = descriptor("vault", this.appPaths.vaultDir(), "windows-app", true, false, false, "Encrypted desktop secret vault.");
    const workspacePath = input.workspacePath?.trim()
      ? descriptor("workspace", input.workspacePath.trim(), "windows-user", true, false, false, "Current user-selected workspace.")
      : undefined;
    const windowsUserHermesPath = descriptor("windows-user-hermes", path.join(os.homedir(), ".hermes"), "windows-user", true, true, false, "Hermes user home on native Windows.");
    const wslHermesHomePath = input.runtime.mode === "wsl"
      ? descriptor("wsl-hermes-home", toWslPath(activeHermesHome), "wsl", true, true, false, "Hermes home as seen from WSL.")
      : undefined;
    const memoryPath = descriptor("memory", path.join(activeHermesHome, "memories"), "windows-app", true, false, false, "Hermes memory files currently used by the adapter.");
    const mcpConfigPath = descriptor("mcp-config", path.join(activeHermesHome, "config.yaml"), "windows-app", true, true, false, "Desktop-managed Hermes MCP config.");
    const cliConfigPath = descriptor("cli-config", path.join(activeHermesHome, "config.yaml"), "windows-app", true, true, false, "Hermes CLI config path written by desktop runtime.");
    const promptTempPath = descriptor("temporary", path.join(this.appPaths.baseDir(), "tmp", "hermes-prompts"), "windows-app", false, true, true, "Temporary prompt files for headless invocations.");
    const all = [
      appUserDataPath,
      profileHermesPath,
      vaultPath,
      ...(workspacePath ? [workspacePath] : []),
      windowsUserHermesPath,
      ...(wslHermesHomePath ? [wslHermesHomePath] : []),
      memoryPath,
      mcpConfigPath,
      cliConfigPath,
      promptTempPath,
    ];
    return {
      appUserDataPath,
      profileHermesPath,
      vaultPath,
      workspacePath,
      windowsUserHermesPath,
      wslHermesHomePath,
      memoryPath,
      mcpConfigPath,
      cliConfigPath,
      promptTempPath,
      all,
    };
  }

  runtimeFromConfig(config: RuntimeConfig | undefined): HermesRuntimeConfig {
    const mode = config?.hermesRuntime?.mode ?? "windows";
    const defaultPython = mode === "windows" ? getDefaultPythonCommand(getPlatformKind()) : "python3";
    return {
      mode,
      distro: config?.hermesRuntime?.distro?.trim() || undefined,
      pythonCommand: config?.hermesRuntime?.pythonCommand?.trim() || defaultPython,
      managedRoot: config?.hermesRuntime?.managedRoot?.trim() || undefined,
      windowsAgentMode: config?.hermesRuntime?.windowsAgentMode ?? "hermes_native",
      cliPermissionMode: config?.hermesRuntime?.cliPermissionMode ?? "yolo",
      permissionPolicy: config?.hermesRuntime?.permissionPolicy ?? "bridge_guarded",
      installSource: config?.hermesRuntime?.installSource,
    };
  }

  toRuntimePath(runtime: Pick<HermesRuntimeConfig, "mode">, inputPath: string) {
    return runtime.mode === "wsl" ? toWslPath(inputPath) : inputPath;
  }

  async exists(targetPath: string) {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}

function descriptor(
  role: RuntimePathDescriptor["role"],
  targetPath: string,
  owner: RuntimePathDescriptor["owner"],
  persistent: boolean,
  synced: boolean,
  temporary: boolean,
  description: string,
): RuntimePathDescriptor {
  return {
    role,
    path: targetPath,
    owner,
    persistent,
    synced,
    temporary,
    description,
  };
}

export function parseCommandLine(raw: string): ParsedCommand | undefined {
  const parts = raw.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  const command = parts.shift()?.trim();
  if (!command) return undefined;
  return {
    command,
    args: parts,
    label: [command, ...parts].join(" "),
  };
}

export function toWslPath(inputPath: string) {
  const normalized = inputPath.trim();
  if (!normalized) return normalized;
  if (/^\/(?:bin|boot|dev|etc|home|lib|lib64|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var)\b/i.test(normalized)) {
    return normalized;
  }
  const uncMatch = normalized.match(/^\\\\wsl\$\\[^\\]+\\(.+)$/i);
  if (uncMatch?.[1]) {
    return `/${uncMatch[1].replace(/\\/g, "/")}`;
  }
  const driveMatch = normalized.match(/^([A-Za-z]):[\\/](.*)$/);
  if (driveMatch?.[1]) {
    const drive = driveMatch[1].toLowerCase();
    const rest = (driveMatch[2] ?? "").replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return normalized.replace(/\\/g, "/");
}

export function parseWslHost(stdout: string) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines.find((line) => line.includes(" via ")) ?? lines[0] ?? "";
  const match = first.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return match?.[0];
}

export function runtimeKindLabel(kind: RuntimeKind) {
  if (kind === "wsl") return "WSL";
  if (kind === "darwin") return "macOS Native";
  return "Windows Native";
}

// Windows-only env variables that must NOT cross into a WSL `env KEY=VALUE … bash -lc` invocation.
// PATHEXT (.COM;.EXE;.BAT;.CMD;…) and Windows PATH are semicolon-delimited and would be re-interpreted
// by bash as a sequence of commands, producing the classic "/bin/bash: line 1: .EXE: command not found".
// Other paths use Windows backslashes that have no meaning in WSL.
export const WSL_FORWARD_BLOCKLIST: ReadonlyArray<string> = [
  "Path",
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "ComSpec",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ProgramData",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "PUBLIC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "OS",
  "OneDrive",
  "OneDriveConsumer",
  "OneDriveCommercial",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOSTNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "USERNAME",
  "SESSIONNAME",
  "LOGONSERVER",
  "ALLUSERSPROFILE",
  "DriverData",
  "PSModulePath",
];

const WSL_FORWARD_BLOCKLIST_LOWER = new Set(WSL_FORWARD_BLOCKLIST.map((key) => key.toLowerCase()));

// Filters a NodeJS env so it can be safely passed to `wsl.exe env`.
// Drops Windows-only variables and any values containing CR/LF that would corrupt the argv encoding.
export function sanitizeEnvForWsl(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (WSL_FORWARD_BLOCKLIST_LOWER.has(key.toLowerCase())) continue;
    if (/\r|\n/.test(value)) continue;
    out[key] = value;
  }
  return out;
}
