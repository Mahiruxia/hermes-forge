import fs from "node:fs/promises";
import path from "node:path";
import { getPlatformKind } from "../platform";
import type { PlatformKind } from "../platform/platform-types";
import { mergeProcessEnvironment, nativeToolEnvironment } from "./native-tool-environment";

export interface ManagedHermesEnvironment {
  rootPath: string;
  venvPath: string;
  pythonPath: string;
  cliPath: string;
}

/** A single selection shared by maintenance, diagnostics and actual launches. */
export async function resolveManagedHermesEnvironment(
  rootPath: string,
  platform: PlatformKind = getPlatformKind(),
): Promise<ManagedHermesEnvironment | undefined> {
  for (const name of ["venv", ".venv"] as const) {
    const environment = managedHermesEnvironmentAt(rootPath, name, platform);
    const python = await fs.stat(environment.pythonPath).catch(() => undefined);
    if (python?.isFile()) return environment;
  }
  return undefined;
}

export function managedHermesEnvironmentAt(
  rootPath: string,
  name: "venv" | ".venv" = "venv",
  platform: PlatformKind = getPlatformKind(),
): ManagedHermesEnvironment {
  const venvPath = path.join(rootPath, name);
  const binPath = path.join(venvPath, platform === "win32" ? "Scripts" : "bin");
  return {
    rootPath,
    venvPath,
    pythonPath: path.join(binPath, platform === "win32" ? "python.exe" : "python"),
    cliPath: path.join(binPath, platform === "win32" ? "hermes.exe" : "hermes"),
  };
}

export function managedHermesEnvironmentEnv(
  environment: ManagedHermesEnvironment,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const nativeEnv = nativeToolEnvironment(environment.rootPath, mergeProcessEnvironment({
    ...extra,
    PATH: extra.PATH ?? extra.Path ?? process.env.PATH ?? process.env.Path ?? "",
  }));
  const inheritedPath = nativeEnv.PATH ?? "";
  const env: NodeJS.ProcessEnv = {
    ...nativeEnv,
    VIRTUAL_ENV: environment.venvPath,
    UV_PROJECT_ENVIRONMENT: environment.venvPath,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8:replace",
    PYTHONUNBUFFERED: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONHOME: undefined,
    PYTHONPATH: extra.PYTHONPATH ?? environment.rootPath,
    // Keep runtime imports from expanding the locked environment (or a second
    // durable dependency directory). Feature dependencies belong to maintenance.
    HERMES_DISABLE_LAZY_INSTALLS: "1",
    HERMES_LAZY_INSTALL_TARGET: undefined,
  };
  // Avoid duplicate case-insensitive PATH keys on Windows.
  delete env.Path;
  env.PATH = `${path.dirname(environment.pythonPath)}${path.delimiter}${inheritedPath}`;
  return env;
}

export async function requireManagedHermesEnvironment(rootPath: string) {
  const environment = await resolveManagedHermesEnvironment(rootPath);
  if (!environment) throw new Error("未找到 Hermes 受管虚拟环境，请先安装或修复 Hermes。");
  return environment;
}
