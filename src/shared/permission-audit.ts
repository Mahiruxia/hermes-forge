import type {
  EnginePermissionPolicy,
  HermesPermissionPolicyMode,
  HermesRuntimeConfig,
  PermissionOverviewBlockReason,
} from "./types";

export type PermissionBoundaryAudit = {
  policy: HermesPermissionPolicyMode;
  hardEnforceable: Record<string, string>;
  softGuarded: Record<string, string>;
  notEnforceableYet: Record<string, string>;
  enforcementMismatch: boolean;
  mismatchReasons: string[];
};

export function permissionPolicyWithDefault(runtime?: HermesRuntimeConfig): HermesPermissionPolicyMode {
  return runtime?.permissionPolicy ?? "bridge_guarded";
}

export function createPermissionBoundaryAudit(input: {
  runtime: HermesRuntimeConfig;
  permissions?: Partial<EnginePermissionPolicy>;
  bridgeRunning?: boolean;
}): PermissionBoundaryAudit {
  const { runtime, permissions } = input;
  const policy = permissionPolicyWithDefault(runtime);
  const bridgeHardControl = permissions?.contextBridge === false
    ? "hard disabled by engine permission: bridge env/config are withheld"
    : runtime.windowsAgentMode === "disabled"
      ? "hard disabled by windowsAgentMode=disabled"
      : `hard gated by desktop-issued bridge token/capabilities and MCP config${input.bridgeRunning === false ? " (bridge not currently running)" : ""}`;
  const audit: PermissionBoundaryAudit = {
    policy,
    hardEnforceable: {
      windowsBridgeTools: bridgeHardControl,
      windowsNativeCapabilities: "hard gated through Windows Bridge capability/token path; desktop can withhold bridge access",
      sessionPromptMetadata: "hard shaped by adapter: WSL receives natural query plus native launch metadata only",
      secretEnvInjection: "hard shaped by adapter env construction; desktop controls model/bridge/runtime env it injects",
      runtimeRootCheck: "Hermes CLI root path is resolved before launch; missing root/CLI fails before execution",
    },
    softGuarded: {
      cliDangerousCommandApproval: `delegated to Hermes CLI permission mode; ${runtime.cliPermissionMode ?? "guarded"} omits --yolo unless yolo is explicitly selected`,
      bridgeCapabilities: "capability strings are enforced by Windows Bridge/tool server implementation, not by prompt text",
    },
    notEnforceableYet: {
      shell: "WSL shell execution is inside Hermes CLI and not hard-blocked by desktop",
      fileReadWrite: "WSL filesystem access is inside Hermes CLI and not limited to workspace by desktop",
      git: "git operations run inside WSL Hermes CLI and are not hard-blocked by desktop",
      network: "WSL network egress is not sandboxed or filtered by desktop",
      restrictedWorkspace: "no OS/container/WSL-level workspace sandbox is implemented yet",
    },
    enforcementMismatch: false,
    mismatchReasons: [],
  };
  if (policy === "restricted_workspace") {
    audit.enforcementMismatch = true;
    audit.mismatchReasons.push("restricted_workspace requires hard WSL shell/file/git workspace isolation, but current runtime has no such enforcement layer");
  }
  if (policy === "passthrough") {
    audit.softGuarded.bridgeCapabilities = "passthrough does not add WSL shell/file/git restrictions; Windows Bridge remains governed only by existing bridge token/capability plumbing when enabled";
  }
  return audit;
}

export function createPermissionPolicyBlockReason(input: {
  runtime: HermesRuntimeConfig;
  audit: PermissionBoundaryAudit;
}): PermissionOverviewBlockReason | undefined {
  if (input.runtime.mode !== "wsl") {
    return undefined;
  }
  if (input.audit.policy === "restricted_workspace") {
    return {
      code: "policy_not_enforceable",
      summary: "当前权限策略无法被真实执行",
      detail: "restricted_workspace 需要 WSL 内 shell/file/git 的硬隔离或 workspace allowlist enforcement，但当前实现没有 WSL sandbox、受限用户、mount namespace、容器或 syscall/file policy 层。为避免用提示词伪装权限控制，本轮直接阻断。",
      fixHint: "请将 hermesRuntime.permissionPolicy 改为 bridge_guarded 或 passthrough；等实现真实 WSL workspace 隔离后再启用 restricted_workspace。",
      debugContext: {
        policy: input.audit.policy,
        runtimeMode: input.runtime.mode,
        enforcementMismatch: input.audit.enforcementMismatch,
        mismatchReasons: input.audit.mismatchReasons,
        hardEnforceable: input.audit.hardEnforceable,
        notEnforceableYet: input.audit.notEnforceableYet,
      },
    };
  }
  return undefined;
}
