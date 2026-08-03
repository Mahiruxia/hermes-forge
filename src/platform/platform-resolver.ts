import os from "node:os";
import path from "node:path";
import type { PlatformKind, PlatformCommands, PlatformPaths } from "./platform-types";

export function getPlatformKind(): PlatformKind {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isDarwin(): boolean {
  return process.platform === "darwin";
}

export function getPlatformPaths(platform: PlatformKind): PlatformPaths {
  if (platform === "win32") {
    return {
      venvBinDir: "Scripts",
      venvScriptsDir: "Scripts",
      cliExtension: ".exe",
      pythonCandidates: ["python", "py -3", "py", "python3"],
    };
  }
  return {
    venvBinDir: "bin",
    venvScriptsDir: "bin",
    cliExtension: "",
    pythonCandidates: ["python3", "python", "/usr/bin/python3", "/opt/homebrew/bin/python3"],
  };
}

export function getDefaultPythonCommand(platform: PlatformKind): string {
  return platform === "win32" ? "python" : "python3";
}

export function getPlatformCommands(platform: PlatformKind): PlatformCommands {
  if (platform === "win32") {
    return {
      shell: "powershell.exe",
      packageManager: "winget",
      pythonLauncher: "py",
    };
  }
  if (platform === "darwin") {
    return {
      shell: undefined,
      packageManager: "brew",
      pythonLauncher: undefined,
    };
  }
  return {
    shell: undefined,
    packageManager: undefined,
    pythonLauncher: undefined,
  };
}

export function getDefaultInstallRoot(platform: PlatformKind): string {
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "hermes", "hermes-agent");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Hermes Agent");
  }
  return path.join(os.homedir(), "Hermes Agent");
}

export function getDefaultHermesHome(platform: PlatformKind): string {
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "hermes");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "hermes");
  }
  return path.join(os.homedir(), ".hermes");
}

export function getHermesCliCandidates(platform: PlatformKind, rootPath: string): string[] {
  const paths = getPlatformPaths(platform);
  const pathApi = pathApiFor(platform);
  const ext = paths.cliExtension;
  return [
    pathApi.join(rootPath, "venv", paths.venvBinDir, `hermes${ext}`),
    pathApi.join(rootPath, ".venv", paths.venvBinDir, `hermes${ext}`),
    pathApi.join(rootPath, paths.venvBinDir, `hermes${ext}`),
    pathApi.join(rootPath, `hermes${ext}`),
    pathApi.join(rootPath, "hermes"),
  ];
}

export function getPythonCandidates(platform: PlatformKind, rootPath: string): Array<{ command: string; args: string[]; label: string }> {
  const paths = getPlatformPaths(platform);
  const pathApi = pathApiFor(platform);
  const candidates: Array<{ command: string; args: string[]; label: string }> = [];
  const addExecutable = (command: string, label: string) => {
    addCandidate(candidates, { command, args: [], label });
  };
  const addCommandLine = (cmd: string) => {
    const parsed = parseCommandLine(cmd);
    if (parsed) addCandidate(candidates, parsed);
  };

  // venv Python first
  addExecutable(pathApi.join(rootPath, ".venv", paths.venvBinDir, `python${ext(platform)}`), "venv Python");
  addExecutable(pathApi.join(rootPath, "venv", paths.venvBinDir, `python${ext(platform)}`), "venv Python");

  // System Python
  for (const candidate of paths.pythonCandidates) {
    addCommandLine(candidate);
  }

  for (const candidate of getWindowsPythonInstallCandidates(platform)) {
    addExecutable(candidate, candidate);
  }

  return candidates;
}

export function getWindowsPythonInstallCandidates(platform: PlatformKind = getPlatformKind()): string[] {
  if (platform !== "win32") return [];
  const versions = ["315", "314", "313", "312", "311", "310", "39", "38"];
  const candidates: string[] = [];
  const add = (candidate: string | undefined) => {
    if (!candidate?.trim()) return;
    const normalized = path.win32.normalize(candidate);
    if (!candidates.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      candidates.push(normalized);
    }
  };

  const localPrograms = process.env.LOCALAPPDATA ? path.win32.join(process.env.LOCALAPPDATA, "Programs", "Python") : undefined;
  const roots = [
    localPrograms,
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env["ProgramFiles(x86)"],
  ].filter((item): item is string => Boolean(item?.trim()));

  for (const version of versions) {
    for (const root of roots) {
      add(path.win32.join(root, `Python${version}`, "python.exe"));
      add(path.win32.join(root, "Python", `Python${version}`, "python.exe"));
    }
  }

  // Anaconda / Miniconda
  if (process.env.USERPROFILE) {
    add(path.win32.join(process.env.USERPROFILE, "anaconda3", "python.exe"));
    add(path.win32.join(process.env.USERPROFILE, "miniconda3", "python.exe"));
  }
  if (process.env.ProgramData) {
    add(path.win32.join(process.env.ProgramData, "anaconda3", "python.exe"));
    add(path.win32.join(process.env.ProgramData, "miniconda3", "python.exe"));
  }

  return candidates;
}

function parseCommandLine(raw: string): { command: string; args: string[]; label: string } | undefined {
  const parts = raw.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  const command = parts.shift()?.trim();
  if (!command) return undefined;
  return { command, args: parts, label: [command, ...parts].join(" ") };
}

function addCandidate(
  candidates: Array<{ command: string; args: string[]; label: string }>,
  candidate: { command: string; args: string[]; label: string },
) {
  if (!candidates.some((item) => item.command.toLowerCase() === candidate.command.toLowerCase() && item.args.join("\0") === candidate.args.join("\0"))) {
    candidates.push(candidate);
  }
}

function ext(platform: PlatformKind): string {
  return platform === "win32" ? ".exe" : "";
}

export function isHermesExecutable(cliPath: string, platform: PlatformKind): boolean {
  if (platform === "win32") {
    return /\.(exe|cmd|bat)$/i.test(cliPath);
  }
  return !cliPath.endsWith(".py");
}

export function inferHermesRootFromCliPath(cliPath: string, platform: PlatformKind): string {
  const pathApi = pathApiFor(platform);
  const parent = pathApi.dirname(cliPath);
  if (platform !== "win32") {
    const binDir = pathApi.basename(parent);
    const venvDir = pathApi.basename(pathApi.dirname(parent)).toLowerCase();
    if (binDir === "bin" && (venvDir === "venv" || venvDir === ".venv")) {
      return pathApi.dirname(pathApi.dirname(parent));
    }
    return parent;
  }
  const venvDir = pathApi.basename(pathApi.dirname(parent)).toLowerCase();
  if (pathApi.basename(parent).toLowerCase() === "scripts" && (venvDir === "venv" || venvDir === ".venv")) {
    return pathApi.dirname(pathApi.dirname(parent));
  }
  return parent;
}

function pathApiFor(platform: PlatformKind): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}
