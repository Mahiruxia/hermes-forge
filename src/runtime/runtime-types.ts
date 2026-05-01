import type { HermesRuntimeConfig, WindowsBridgeStatus } from "../shared/types";

export type RuntimeKind = HermesRuntimeConfig["mode"];

export type RuntimeOverallStatus =
  | "ready"
  | "degraded"
  | "missing_dependency"
  | "misconfigured"
  | "unavailable";

export type RuntimeIssueSeverity = "info" | "warning" | "error";

export type RuntimeIssueCode =
  | "windows_platform_unavailable"
  | "macos_platform_unavailable"
  | "powershell_missing"
  | "python_missing"
  | "git_missing"
  | "winget_missing"
  | "brew_missing"
  | "xcode_tools_missing"
  | "wsl_missing"
  | "wsl_unreachable"
  | "wsl_distro_missing"
  | "wsl_distro_unreachable"
  | "wsl_python_missing"
  | "hermes_root_missing"
  | "hermes_cli_missing"
  | "bridge_disabled"
  | "bridge_unreachable"
  | "runtime_mismatch"
  | "path_unreachable";

export type RuntimeIssue = {
  code: RuntimeIssueCode;
  severity: RuntimeIssueSeverity;
  summary: string;
  detail?: string;
  fixHint?: string;
  debugContext?: Record<string, unknown>;
};

export type RuntimePathRole =
  | "app-user-data"
  | "profile-hermes"
  | "vault"
  | "workspace"
  | "windows-user-hermes"
  | "wsl-hermes-home"
  | "memory"
  | "mcp-config"
  | "cli-config"
  | "temporary";

export type RuntimePathOwnership = "windows-app" | "windows-user" | "wsl";

export type RuntimePathDescriptor = {
  role: RuntimePathRole;
  path: string;
  owner: RuntimePathOwnership;
  persistent: boolean;
  synced: boolean;
  temporary: boolean;
  description: string;
};

export type RuntimePathResolution = {
  appUserDataPath: RuntimePathDescriptor;
  profileHermesPath: RuntimePathDescriptor;
  vaultPath: RuntimePathDescriptor;
  workspacePath?: RuntimePathDescriptor;
  windowsUserHermesPath: RuntimePathDescriptor;
  wslHermesHomePath?: RuntimePathDescriptor;
  memoryPath: RuntimePathDescriptor;
  mcpConfigPath: RuntimePathDescriptor;
  cliConfigPath: RuntimePathDescriptor;
  promptTempPath: RuntimePathDescriptor;
  all: RuntimePathDescriptor[];
};

export type RuntimeBridgeProbe = {
  configured: boolean;
  running: boolean;
  reachable: boolean;
  host?: string;
  port?: number;
  url?: string;
  status?: WindowsBridgeStatus;
  message: string;
};

export type RuntimeCommandProbe = {
  available: boolean;
  command?: string;
  args?: string[];
  label?: string;
  version?: string;
  message: string;
};

export type RuntimeWslProbe = {
  available: boolean;
  status?: string;
  distroExists?: boolean;
  distroName?: string;
  distroReachable?: boolean;
  pythonAvailable?: boolean;
  pythonCommand?: string;
  hostIp?: string;
  message: string;
};

export type RuntimeProbeResult = {
  checkedAt: string;
  runtimeMode: RuntimeKind;
  windowsAvailable: boolean;
  powershellAvailable: boolean;
  pythonAvailable: boolean;
  pythonCommandResolved?: string;
  gitAvailable: boolean;
  wingetAvailable: boolean;
  wslAvailable: boolean;
  wslStatus?: string;
  distroExists?: boolean;
  distroName?: string;
  distroReachable?: boolean;
  wslPythonAvailable?: boolean;
  hermesRootExists: boolean;
  hermesCliExists: boolean;
  bridgeReachable: boolean;
  bridgeHost?: string;
  bridgePort?: number;
  configResolved: boolean;
  homeResolved: boolean;
  memoryResolved: boolean;
  paths: RuntimePathResolution;
  commands: {
    powershell: RuntimeCommandProbe;
    python: RuntimeCommandProbe;
    git: RuntimeCommandProbe;
    winget: RuntimeCommandProbe;
    wsl: RuntimeWslProbe;
  };
  bridge: RuntimeBridgeProbe;
  overallStatus: RuntimeOverallStatus;
  issues: RuntimeIssue[];
  recommendations: string[];
};

export type RuntimePreflightCheck = {
  ok: boolean;
  code: RuntimeIssueCode | "ok";
  severity: RuntimeIssueSeverity;
  summary: string;
  detail?: string;
  fixHint?: string;
  debugContext?: Record<string, unknown>;
};

export type RuntimePreflightResult = {
  ok: boolean;
  runtimeMode: RuntimeKind;
  summary: string;
  checks: RuntimePreflightCheck[];
  issues: RuntimeIssue[];
  debugContext: Record<string, unknown>;
};

export type RuntimeLaunchSpec = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  runtimeKind: RuntimeKind;
  diagnostics: {
    label: string;
    runtimeRootPath: string;
    runtimeCwd: string;
    pythonCommand?: string;
  };
};

export type BuildHermesLaunchInput = {
  runtime: HermesRuntimeConfig;
  rootPath: string;
  pythonArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type BuildPythonLaunchInput = BuildHermesLaunchInput;
