import { validateWslHermesCli, type HermesCliValidationFailureKind } from "../runtime/hermes-cli-resolver";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import type { AppPaths } from "./app-paths";
import { createPermissionBoundaryAudit, createPermissionPolicyBlockReason } from "../shared/permission-audit";
import { resolveEnginePermissions } from "../shared/types";
import type {
  HermesCliPermissionMode,
  HermesPermissionPolicyMode,
  HermesRuntimeConfig,
  PermissionOverview,
  PermissionOverviewBlockReason,
  RuntimeConfig,
  WindowsBridgeStatus,
} from "../shared/types";

type CapabilityProbe = NonNullable<PermissionOverview["capabilityProbe"]> & {
  support?: "native" | "legacy_compatible" | "degraded" | "unsupported";
  reason?: string;
  failureKind?: HermesCliValidationFailureKind;
};

export async function buildPermissionOverview(input: {
  config: RuntimeConfig;
  bridge: WindowsBridgeStatus;
  appPaths: AppPaths;
  resolveHermesRoot: () => Promise<string>;
  runtimeAdapterFactory: RuntimeAdapterFactory;
}): Promise<PermissionOverview> {
  const runtime = runtimeWithDefaults(input.config.hermesRuntime);
  const permissions = resolveEnginePermissions(input.config, "hermes");
  const bridgeEnabled = permissions.enabled && permissions.contextBridge && runtime.windowsAgentMode !== "disabled";
  const bridgeCapabilities = input.bridge.capabilities ?? [];
  const audit = createPermissionBoundaryAudit({ runtime, permissions, bridgeRunning: input.bridge.running });
  const policyBlock = createPermissionPolicyBlockReason({ runtime, audit });
  const capabilityProbe: PermissionOverview["capabilityProbe"] = null;
  const capabilityBlock = undefined;
  const blockReason = policyBlock ?? capabilityBlock ?? null;
  const notes = [
    "Native Windows mode does not use WSL launch metadata transport.",
    bridgeCapabilities.length ? undefined : "Backend did not report bridge capabilities.",
  ].filter((item): item is string => Boolean(item));
  return {
    runtime: "native",
    permissionPolicy: runtime.permissionPolicy,
    cliPermissionMode: runtime.cliPermissionMode,
    transport: null,
    sessionMode: null,
    bridge: {
      enabled: bridgeEnabled,
      running: input.bridge.running,
      capabilities: bridgeCapabilities,
      capabilityCount: bridgeCapabilities.length,
      reportedByBackend: bridgeCapabilities.length > 0,
    },
    enforcement: {
      hardEnforceable: Object.entries(audit.hardEnforceable).map(formatBoundary),
      softGuarded: Object.entries(audit.softGuarded).map(formatBoundary),
      notEnforceableYet: Object.entries(audit.notEnforceableYet).map(formatBoundary),
    },
    blocked: Boolean(blockReason),
    blockReason,
    capabilityProbe,
    runtimeReady: !blockReason,
    notes,
  };
}

function runtimeWithDefaults(runtime: RuntimeConfig["hermesRuntime"]): HermesRuntimeConfig & {
  mode: "windows" | "wsl";
  pythonCommand: string;
  windowsAgentMode: NonNullable<HermesRuntimeConfig["windowsAgentMode"]>;
  cliPermissionMode: HermesCliPermissionMode;
  permissionPolicy: HermesPermissionPolicyMode;
} {
  return {
    mode: "windows",
    distro: undefined,
    managedRoot: runtime?.managedRoot,
    pythonCommand: runtime?.pythonCommand ?? "python3",
    windowsAgentMode: runtime?.windowsAgentMode ?? "hermes_native",
    cliPermissionMode: runtime?.cliPermissionMode ?? "yolo",
    permissionPolicy: runtime?.permissionPolicy ?? "bridge_guarded",
  };
}

async function probeCapabilities(input: {
  runtime: HermesRuntimeConfig;
  resolveHermesRoot: () => Promise<string>;
  runtimeAdapterFactory: RuntimeAdapterFactory;
  appPaths: AppPaths;
}): Promise<CapabilityProbe> {
  const adapter = input.runtimeAdapterFactory(input.runtime);
  let rootPath: string;
  try {
    rootPath = adapter.toRuntimePath(await input.resolveHermesRoot());
  } catch (error) {
    return classifyCapabilities({
      cliVersion: undefined,
      supportsLaunchMetadataArg: false,
      supportsLaunchMetadataEnv: false,
      supportsResume: false,
      reason: error instanceof Error ? error.message : String(error),
      failureKind: "file_missing",
    });
  }
  const cliPath = `${rootPath.replace(/\/+$/, "")}/hermes`;
  const validation = await validateWslHermesCli(input.runtime, cliPath);
  if (!validation.ok) {
    return classifyCapabilities({
      cliVersion: validation.capabilities?.cliVersion,
      supportsLaunchMetadataArg: validation.capabilities?.supportsLaunchMetadataArg === true,
      supportsLaunchMetadataEnv: validation.capabilities?.supportsLaunchMetadataEnv === true,
      supportsResume: validation.capabilities?.supportsResume === true,
      reason: validation.message,
      failureKind: validation.kind,
    });
  }
  return classifyCapabilities({
    cliVersion: validation.capabilities.cliVersion,
    supportsLaunchMetadataArg: validation.capabilities.supportsLaunchMetadataArg,
    supportsLaunchMetadataEnv: validation.capabilities.supportsLaunchMetadataEnv,
    supportsResume: validation.capabilities.supportsResume,
  });
}

function classifyCapabilities(input: {
  cliVersion?: string;
  supportsLaunchMetadataArg: boolean;
  supportsLaunchMetadataEnv: boolean;
  supportsResume: boolean;
  reason?: string;
  failureKind?: HermesCliValidationFailureKind;
}): CapabilityProbe {
  const missing = [
    input.cliVersion ? undefined : "cliVersion",
    input.supportsLaunchMetadataArg ? undefined : "supportsLaunchMetadataArg",
    input.supportsLaunchMetadataEnv ? undefined : "supportsLaunchMetadataEnv",
    input.supportsResume ? undefined : "supportsResume",
  ].filter((item): item is string => Boolean(item));
  const minimumSatisfied = missing.length === 0;
  return {
    minimumSatisfied,
    cliVersion: input.cliVersion,
    missing,
    allowedTransports: minimumSatisfied ? ["native-arg-env"] : [],
    support: minimumSatisfied ? "native" : input.reason ? "legacy_compatible" : "unsupported",
    reason: input.reason,
    failureKind: input.failureKind,
  };
}

function capabilityBlockReason(probe: CapabilityProbe): PermissionOverviewBlockReason {
  const missingFile = probe.failureKind === "file_missing";
  const permissionDenied = probe.failureKind === "permission_denied";
  return {
    code: probe.missing?.includes("cliVersion") ? "unsupported_cli_version" : "unsupported_cli_capability",
    summary: missingFile
      ? "Hermes Agent 未安装或路径不存在"
      : permissionDenied
        ? "Hermes CLI 无执行权限"
        : "Hermes CLI 不满足 Forge 最低能力门槛",
    detail: missingFile
      ? `capabilities --json 尚未执行。${probe.reason ?? "Hermes CLI 文件不存在。"}`
      : permissionDenied
        ? `capabilities --json 尚未执行。${probe.reason ?? "Hermes CLI 文件不可读取。"}`
        : `Forge 主链路要求 capabilities --json、cliVersion、supportsLaunchMetadataArg、supportsLaunchMetadataEnv、supportsResume。缺失：${probe.missing?.join(", ") || "unknown"}。${probe.reason ? `原因：${probe.reason}` : ""}`,
    fixHint: missingFile
      ? "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。"
      : permissionDenied
        ? "请修复 Hermes CLI 文件权限后重试。"
        : "请升级 Hermes CLI 到支持原生 launch metadata 和 resume capability 的版本。",
    debugContext: {
      capabilityProbe: probe,
      allowedTransports: ["native-arg-env"],
      minimumRequired: {
        capabilitiesJson: true,
        supportsLaunchMetadataArg: true,
        supportsLaunchMetadataEnv: true,
        supportsResume: true,
        cliVersion: "present",
      },
    },
  };
}

function formatBoundary([key, value]: [string, string]) {
  return `${key}: ${value}`;
}
