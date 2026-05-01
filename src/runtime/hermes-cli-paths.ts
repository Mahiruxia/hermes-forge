import fs from "node:fs/promises";
import nodeFs from "node:fs";
import path from "node:path";
import {
  getHermesCliCandidates,
  getPlatformKind,
  inferHermesRootFromCliPath,
  isHermesExecutable,
} from "../platform";

export function windowsHermesCliCandidates(rootPath: string) {
  return getHermesCliCandidates("win32", rootPath);
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
  return isHermesExecutable(cliPath, "win32");
}

export function inferWindowsHermesRootFromCliPath(cliPath: string) {
  return inferHermesRootFromCliPath(cliPath, "win32");
}

// Cross-platform helpers
export function hermesCliCandidates(rootPath: string) {
  return getHermesCliCandidates(getPlatformKind(), rootPath);
}

export function defaultHermesCliPath(rootPath: string) {
  return hermesCliCandidates(rootPath)[0]!;
}

export async function resolveHermesCliPath(rootPath: string) {
  for (const candidate of hermesCliCandidates(rootPath)) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

export function resolveHermesCliPathSync(rootPath: string) {
  for (const candidate of hermesCliCandidates(rootPath)) {
    if (nodeFs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function isHermesCliExecutable(cliPath: string) {
  return isHermesExecutable(cliPath, getPlatformKind());
}

export function inferHermesRootFromCliPathUniversal(cliPath: string) {
  return inferHermesRootFromCliPath(cliPath, getPlatformKind());
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
