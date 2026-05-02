import type {
  EngineEvent,
  HermesPermissionPolicyMode,
  HermesRuntimeConfig,
  PermissionOverview,
  PermissionOverviewBlockReason,
  RuntimeConfig,
  TaskEventEnvelope,
  WindowsBridgeStatus,
} from "../../shared/types";

export type EnforcementCategory = "hard-enforceable" | "soft-guarded" | "not-enforceable-yet";
export type PreflightTone = "green" | "yellow" | "red";

export type EnforcementMatrixRow = {
  id: string;
  label: string;
  category: EnforcementCategory;
  detail: string;
};

export type PolicyBlockReason = PermissionOverviewBlockReason;

export type PermissionDiagnostics = {
  permissionPolicy?: string;
  cliPermissionMode?: string;
  transport?: string;
  capabilityProbe?: Record<string, unknown>;
  hardEnforceable?: Record<string, string>;
  softGuarded?: Record<string, string>;
  notEnforceableYet?: Record<string, string>;
  policyBlock?: PolicyBlockReason;
  sessionMode?: string;
  wslWorkerStatus?: string;
  wslWorkerDetail?: string;
};

export type PreflightState = {
  tone: PreflightTone;
  runtime: string;
  permissionPolicy: HermesPermissionPolicyMode;
  cliPermissionMode: string;
  transport: string;
  sessionMode: string;
  bridgeEnabled: boolean;
  blocked: boolean;
  summary: string;
  detail: string;
  block?: PolicyBlockReason;
};

export function runtimeUserLabel(value?: string) {
  if (value === "wsl") return "WSL 原生环境";
  if (value === "windows") return "Windows 本机环境";
  if (value === "darwin") return "macOS 本机环境";
  return value || "未检测到运行环境";
}

export function permissionPolicyUserLabel(value?: string) {
  if (value === "bridge_guarded") return "推荐保护";
  if (value === "passthrough") return "宽松直通";
  if (value === "restricted_workspace") return "工作区强限制（当前不可用）";
  return value || "推荐保护";
}

export function cliPermissionModeUserLabel(value?: string) {
  if (value === "yolo") return "命令自动放行";
  if (value === "guarded") return "危险命令会确认";
  if (value === "safe") return "安全模式";
  return value || "危险命令会确认";
}

export function transportUserLabel(value?: string) {
  if (value === "native-arg-env") return "原生 WSL 启动";
  if (value === "windows-headless") return "Windows 本机启动";
  if (value === "darwin-headless") return "macOS 本机启动";
  if (!value || value === "none") return "尚未建立";
  return value;
}

export function sessionModeUserLabel(value?: string) {
  if (value === "fresh") return "新会话";
  if (value === "resumed" || value === "continued") return "已恢复历史";
  if (value === "degraded") return "恢复受限";
  if (value === "headless") return "本机无界面会话";
  if (value === "fresh/resume") return "自动恢复";
  return value || "自动恢复";
}

export function capabilityProbeUserLabel(probe?: PermissionOverview["capabilityProbe"] | Record<string, unknown> | null) {
  if (!probe) return "等待检测";
  const minimumSatisfied = typeof probe.minimumSatisfied === "boolean" ? probe.minimumSatisfied : undefined;
  const support = typeof probe.support === "string" ? probe.support : undefined;
  if (minimumSatisfied === false || support === "unsupported") return "Hermes CLI 版本不满足";
  if (support === "degraded") return "能力可用但降级";
  if (minimumSatisfied === true || support === "native") return "能力满足";
  return "已检测";
}

export function preflightSummaryForUser(preflight: PreflightState) {
  if (preflight.block) return preflight.block.summary;
  if (preflight.blocked && preflight.summary === "当前会话正在处理中") return "Hermes 正在处理上一条消息";
  if (preflight.tone === "red") return preflight.summary || "环境需要修复后才能发送";
  if (preflight.tone === "yellow") {
    if (preflight.sessionMode === "degraded") return "可以发送，但会话恢复受限";
    if (preflight.permissionPolicy === "passthrough") return "可以发送，但项目操作更宽松";
    if (preflight.cliPermissionMode === "yolo") return "可以发送，但命令会自动放行";
    return "可以发送，但当前状态需要留意";
  }
  return "环境就绪，可以发送";
}

export function preflightDetailForUser(preflight: PreflightState) {
  if (preflight.block) return preflight.block.detail;
  if (preflight.blocked && preflight.summary === "当前会话正在处理中") return "等当前回复完成后，就可以继续发送下一条消息。";
  if (preflight.tone === "yellow") {
    if (preflight.sessionMode === "degraded") return "历史会话没有完整恢复，本轮仍可运行；如结果不连续，可以新建会话再试。";
    if (preflight.permissionPolicy === "passthrough") return "Hermes 会更接近原生 CLI 行为，适合熟悉命令行和当前项目风险的用户。";
    if (preflight.cliPermissionMode === "yolo") return "命令执行不会逐项询问，适合可信工作区；不确定时建议切回 guarded。";
    return preflight.detail;
  }
  return preflight.detail;
}

export function preflightChipsForUser(preflight: PreflightState) {
  const sessionChip = preflight.blocked && preflight.summary === "当前会话正在处理中"
    ? "等待本轮完成"
    : sessionModeUserLabel(preflight.sessionMode);

  const policyChip = preflight.permissionPolicy === "passthrough"
    ? "项目操作更宽松"
    : preflight.permissionPolicy === "restricted_workspace"
      ? "策略需修复"
      : preflight.bridgeEnabled
        ? "Windows 能力受保护"
        : "Windows 联动已关闭";

  const commandChip = cliPermissionModeUserLabel(preflight.cliPermissionMode);

  return [sessionChip, policyChip, commandChip];
}

export const POLICY_OPTIONS: Array<{
  id: HermesPermissionPolicyMode;
  label: string;
  description: string;
  warning?: string;
}> = [
  {
    id: "bridge_guarded",
    label: "Bridge guarded",
    description: "WSL 内 shell/file/git/network 直通 Hermes CLI；Windows Bridge 由桌面端 token、capability 和审批边界控制。",
  },
  {
    id: "passthrough",
    label: "Passthrough",
    description: "尽量接近原版 CLI，不额外限制 WSL 内 shell/file/git；Windows Bridge 若启用仍只走现有 Bridge 边界。",
  },
  {
    id: "restricted_workspace",
    label: "Restricted workspace",
    description: "目标是把 WSL 操作硬限制在工作区内。",
    warning: "当前没有真实 WSL workspace 隔离实现，选择后会阻断任务。",
  },
];

export function runtimeWithDefaults(runtime?: HermesRuntimeConfig): Required<Pick<HermesRuntimeConfig, "mode" | "pythonCommand" | "windowsAgentMode" | "cliPermissionMode" | "permissionPolicy">> & HermesRuntimeConfig {
  const mode = runtime?.mode ?? "windows";
  return {
    mode,
    distro: runtime?.distro,
    managedRoot: runtime?.managedRoot,
    pythonCommand: runtime?.pythonCommand ?? (mode === "windows" ? "python" : "python3"),
    windowsAgentMode: runtime?.windowsAgentMode ?? "hermes_native",
    cliPermissionMode: runtime?.cliPermissionMode ?? "yolo",
    permissionPolicy: runtime?.permissionPolicy ?? "bridge_guarded",
  };
}

export function policyBlockReason(runtime?: HermesRuntimeConfig): PolicyBlockReason | undefined {
  const resolved = runtimeWithDefaults(runtime);
  if (resolved.mode !== "wsl" || resolved.permissionPolicy !== "restricted_workspace") {
    return undefined;
  }
  return {
    code: "policy_not_enforceable",
    summary: "当前权限策略无法被真实执行",
    detail: "restricted_workspace 需要 WSL 内 shell/file/git 的硬隔离或 workspace allowlist enforcement，但当前没有 WSL sandbox、受限用户、mount namespace、容器或 syscall/file policy 层。",
    fixHint: "请切换到 bridge_guarded 或 passthrough；等实现真实 WSL workspace 隔离后再启用 restricted_workspace。",
    debugContext: {
      policy: resolved.permissionPolicy,
      runtimeMode: resolved.mode,
      missingEnforcement: ["wsl-shell", "wsl-file-write", "git", "network", "workspace-allowlist"],
    },
  };
}

export function enforcementMatrix(runtime?: HermesRuntimeConfig, bridge?: WindowsBridgeStatus): EnforcementMatrixRow[] {
  const resolved = runtimeWithDefaults(runtime);
  const bridgeEnabled = resolved.windowsAgentMode !== "disabled";
  return [
    {
      id: "windows-bridge-tools",
      label: "Windows bridge tools",
      category: "hard-enforceable",
      detail: bridgeEnabled
        ? `桌面端通过 Bridge token/capabilities 控制；当前状态：${bridge?.running ? "running" : "not running"}。`
        : "windowsAgentMode=disabled，桌面端不会注入 Bridge 访问能力。",
    },
    {
      id: "windows-native",
      label: "Windows native abilities",
      category: "hard-enforceable",
      detail: "PowerShell、剪贴板、窗口、键鼠、截屏等 Windows 原生能力只通过 Bridge capability/token 进入。",
    },
    {
      id: "session-metadata",
      label: "Session / metadata",
      category: "hard-enforceable",
      detail: "WSL 主链路固定为自然 query + 原生 launch metadata；桌面端不再注入 history/memory/附件正文。",
    },
    {
      id: "secret-env",
      label: "Secret / env injection",
      category: "hard-enforceable",
      detail: "桌面端只控制自己注入的模型、Bridge、runtime env；不会硬控制 CLI 自身读取到的其它 WSL 环境。",
    },
    {
      id: "cli-approval",
      label: "CLI command approval",
      category: "soft-guarded",
      detail: `交给 Hermes CLI permission mode：${resolved.cliPermissionMode}；guarded/safe 不传 --yolo，yolo 显式传 --yolo。`,
    },
    {
      id: "wsl-shell",
      label: "WSL shell",
      category: "not-enforceable-yet",
      detail: "Hermes CLI 内部 shell 执行目前由 WSL CLI 直通，桌面端没有 OS 级硬拦截。",
    },
    {
      id: "wsl-file-write",
      label: "WSL file write",
      category: "not-enforceable-yet",
      detail: "WSL 文件读写未被桌面端限制到 workspace；snapshot 不是访问控制。",
    },
    {
      id: "git",
      label: "git",
      category: "not-enforceable-yet",
      detail: "git 在 WSL Hermes CLI 内执行，桌面端当前不能硬拦 commit/reset/checkout 等操作。",
    },
    {
      id: "network",
      label: "network",
      category: "not-enforceable-yet",
      detail: "WSL 网络出口未经过桌面端 sandbox/filter。",
    },
  ];
}

export function bridgeCapabilityRows(bridge?: WindowsBridgeStatus, runtime?: HermesRuntimeConfig) {
  const resolved = runtimeWithDefaults(runtime);
  const disabled = resolved.windowsAgentMode === "disabled";
  const capabilities = bridge?.capabilities ?? [];
  return {
    enabled: !disabled,
    running: Boolean(bridge?.running),
    capabilities,
    approvalControlled: capabilities.filter((capability) => /powershell|keyboard|mouse|ahk|window|screenshot|clipboard|files/i.test(capability)),
    disabledCapabilities: disabled ? ["all bridge capabilities"] : capabilities.length ? [] : ["no capabilities reported"],
  };
}

export function extractPermissionDiagnostics(events: TaskEventEnvelope[]): PermissionDiagnostics {
  const diagnostics = events
    .map((event) => event.event)
    .filter((event): event is Extract<EngineEvent, { type: "diagnostic" }> => event.type === "diagnostic");
  const next: PermissionDiagnostics = {};
  for (const diagnostic of diagnostics.slice().reverse()) {
    if (diagnostic.category === "hermes-permission-policy" && !next.permissionPolicy) {
      const parsed = parseJsonObject(diagnostic.message);
      if (parsed) {
        next.permissionPolicy = stringValue(parsed.policy);
        next.hardEnforceable = recordValue(parsed.hardEnforceable);
        next.softGuarded = recordValue(parsed.softGuarded);
        next.notEnforceableYet = recordValue(parsed.notEnforceableYet);
      }
    }
    if (diagnostic.category === "hermes-permission-policy-blocked" && !next.policyBlock) {
      const parsed = parseJsonObject(diagnostic.message);
      if (parsed) next.policyBlock = parsed as PolicyBlockReason;
    }
    if (diagnostic.category === "hermes-cli-session" && (!next.transport || !next.capabilityProbe || !next.sessionMode)) {
      next.transport ??= matchValue(diagnostic.message, /Launch metadata transport：([^/\s]+)/);
      next.sessionMode ??= matchValue(diagnostic.message, /CLI state：([^/\s]+)/);
      const capability = matchValue(diagnostic.message, /CLI capability probe：(\{.*?\})(?: \/ |$)/);
      if (capability && !next.capabilityProbe) next.capabilityProbe = parseJsonObject(capability);
    }
    if (diagnostic.category === "hermes-cli-permission-mode" && !next.cliPermissionMode) {
      next.cliPermissionMode = matchValue(diagnostic.message, /permission mode：([^（\s]+)/);
    }
    if (diagnostic.category === "hermes-wsl-worker" && !next.wslWorkerDetail) {
      next.wslWorkerDetail = diagnostic.message;
      next.wslWorkerStatus = diagnostic.message.split(/[：:]/)[0] || "unknown";
    }
  }
  return next;
}

export function buildPreflightState(input: {
  runtimeConfig?: RuntimeConfig;
  events: TaskEventEnvelope[];
  bridge?: WindowsBridgeStatus;
  locked?: boolean;
  overview?: PermissionOverview;
}): PreflightState {
  if (input.overview) {
    const risk = input.overview.permissionPolicy === "passthrough"
      || (input.overview.runtime === "wsl" && input.overview.cliPermissionMode === "yolo")
      || input.overview.sessionMode === "degraded"
      || input.overview.capabilityProbe?.support === "degraded";
    const tone: PreflightTone = input.overview.blocked ? "red" : input.locked || risk ? "yellow" : "green";
    return {
      tone,
      runtime: input.overview.runtime,
      permissionPolicy: input.overview.permissionPolicy,
      cliPermissionMode: input.overview.cliPermissionMode,
      transport: input.overview.transport ?? "none",
      sessionMode: input.overview.sessionMode ?? "fresh/resume",
      bridgeEnabled: input.overview.bridge.enabled,
      blocked: Boolean(input.overview.blocked || input.locked),
      summary: input.overview.blockReason
        ? input.overview.blockReason.summary
        : input.locked
          ? "当前会话正在处理中"
          : tone === "yellow"
            ? "可运行，但当前策略更接近 CLI 直通或有降级"
            : "可运行",
      detail: input.overview.blockReason?.detail ?? (input.locked ? "Hermes 正在处理上一条消息，完成后即可继续输入。" : "任务将按后端 Permission Overview 启动。"),
      block: input.overview.blockReason ?? undefined,
    };
  }
  const runtime = runtimeWithDefaults(input.runtimeConfig?.hermesRuntime);
  const diagnostics = extractPermissionDiagnostics(input.events);
  const block = policyBlockReason(runtime) ?? diagnostics.policyBlock;
  const bridgeEnabled = runtime.windowsAgentMode !== "disabled" && input.runtimeConfig?.enginePermissions?.hermes?.contextBridge !== false;
  const transport = runtime.mode === "wsl" ? diagnostics.transport ?? "native-arg-env" : runtime.mode === "darwin" ? "darwin-headless" : "windows-headless";
  const sessionMode = diagnostics.sessionMode ?? (runtime.mode === "wsl" ? "fresh/resume" : "headless");
  const hasRisk = runtime.mode === "wsl" && (runtime.permissionPolicy === "passthrough" || runtime.cliPermissionMode === "yolo");
  const tone: PreflightTone = block ? "red" : input.locked || hasRisk ? "yellow" : "green";
  return {
    tone,
    runtime: runtime.mode,
    permissionPolicy: runtime.permissionPolicy,
    cliPermissionMode: runtime.cliPermissionMode,
    transport,
    sessionMode,
    bridgeEnabled,
    blocked: Boolean(block || input.locked),
    summary: block
      ? block.summary
      : input.locked
        ? "当前会话正在处理中"
        : tone === "yellow"
          ? "可运行，但当前策略更接近 CLI 直通或 YOLO"
          : "可运行",
    detail: block?.detail ?? (input.locked ? "Hermes 正在处理上一条消息，完成后即可继续输入。" : "任务将按当前 runtime 与 permission policy 启动。"),
    block,
  };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function matchValue(value: string, pattern: RegExp) {
  return value.match(pattern)?.[1];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function recordValue(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}
