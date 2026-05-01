export type PlatformKind = "win32" | "darwin" | "linux";

export interface PlatformPaths {
  venvBinDir: string;
  venvScriptsDir: string;
  cliExtension: string;
  pythonCandidates: string[];
}

export interface PlatformCommands {
  shell: string | undefined;
  packageManager: string | undefined;
  pythonLauncher: string | undefined;
}
