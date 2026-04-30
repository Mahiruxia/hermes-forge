import fs from "node:fs/promises";
import nodeFs from "node:fs";
import path from "node:path";

export function windowsHermesCliCandidates(rootPath: string) {
  return [
    path.join(rootPath, "venv", "Scripts", "hermes.exe"),
    path.join(rootPath, ".venv", "Scripts", "hermes.exe"),
    path.join(rootPath, "Scripts", "hermes.exe"),
    path.join(rootPath, "hermes.exe"),
    path.join(rootPath, "hermes"),
  ];
}

export function defaultWindowsHermesCliPath(rootPath: string) {
  return windowsHermesCliCandidates(rootPath)[0]!;
}

export async function resolveWindowsHermesCliPath(rootPath: string) {
  for (const candidate of windowsHermesCliCandidates(rootPath)) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

export function resolveWindowsHermesCliPathSync(rootPath: string) {
  for (const candidate of windowsHermesCliCandidates(rootPath)) {
    if (nodeFs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function isWindowsHermesExecutable(cliPath: string) {
  return /\.(exe|cmd|bat)$/i.test(cliPath);
}

export function inferWindowsHermesRootFromCliPath(cliPath: string) {
  const parent = path.dirname(cliPath);
  const venvDir = path.basename(path.dirname(parent)).toLowerCase();
  if (path.basename(parent).toLowerCase() === "scripts" && (venvDir === "venv" || venvDir === ".venv")) {
    return path.dirname(path.dirname(parent));
  }
  return parent;
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
