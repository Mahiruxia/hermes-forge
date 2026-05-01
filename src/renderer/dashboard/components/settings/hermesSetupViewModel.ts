import type {
  EngineUpdateStatus,
  HermesInstallEvent,
  HermesRuntimeConfig,
  PermissionOverview,
  SetupCheck,
  WindowsBridgeStatus,
} from "../../../../shared/types";

export type HermesSetupTone = "ok" | "warn" | "danger" | "neutral";

export type HermesSetupAction =
  | "install"
  | "repair"
  | "update"
  | "diagnose"
  | "refresh"
  | "none";

export type HermesSetupViewModel = {
  state: "ready" | "installing" | "missing" | "broken" | "degraded" | "update_required" | "config_error" | "connection_error";
  tone: HermesSetupTone;
  title: string;
  detail: string;
  primaryAction: HermesSetupAction;
  primaryLabel: string;
  runtimeLabel: string;
  statusPill: string;
  detailRows: Array<{
    id: string;
    label: string;
    value: string;
    tone: HermesSetupTone;
    detail?: string;
  }>;
};

export function buildHermesSetupViewModel(input: {
  runtime?: HermesRuntimeConfig;
  rootPath: string;
  bridge?: WindowsBridgeStatus;
  installEvent?: HermesInstallEvent;
  permissionOverview?: PermissionOverview;
  permissionError?: string;
  hermesAvailable?: boolean;
  setupBlocking: SetupCheck[];
  setupLoading: boolean;
  updateStatus?: EngineUpdateStatus;
  version?: string;
}): HermesSetupViewModel {
  const runtimeLabel = input.runtime?.mode === "darwin" ? "macOS Native" : "Windows Native";
  const rootPath = input.rootPath.trim();
  const hermesBlocking = input.setupBlocking.find((check) => check.id === "hermes" || check.id.startsWith("hermes-"));
  const modelBlocking = input.setupBlocking.find((check) => check.id === "model" || check.id === "model-secret");
  const firstBlocking = hermesBlocking ?? modelBlocking ?? input.setupBlocking[0];
  const capabilityBlock = input.permissionOverview?.blockReason?.code === "unsupported_cli_capability"
    || input.permissionOverview?.blockReason?.code === "unsupported_cli_version"
    || input.permissionOverview?.capabilityProbe?.minimumSatisfied === false;
  const currentVersion = input.version || input.updateStatus?.currentVersion;
  const latestVersion = input.updateStatus?.latestVersion;

  const detailRows = [
    {
      id: "runtime",
      label: "运行环境",
      value: runtimeLabel,
      tone: "ok" as const,
      detail: "固定使用 Windows 本机 Agent。",
    },
    {
      id: "install",
      label: "Agent",
      value: input.hermesAvailable && !hermesBlocking ? "可用" : rootPath ? "需要修复" : "未安装",
      tone: input.hermesAvailable && !hermesBlocking ? "ok" as const : "danger" as const,
      detail: hermesBlocking?.message ?? (rootPath ? "路径已配置，但未检测到可用 Hermes。" : "可以直接一键安装。"),
    },
    {
      id: "connection",
      label: "连接",
      value: input.permissionError || input.permissionOverview?.blocked || hermesBlocking ? "需检查" : "正常",
      tone: input.permissionError || input.permissionOverview?.blocked || hermesBlocking ? "danger" as const : "ok" as const,
      detail: input.permissionError ?? input.permissionOverview?.blockReason?.summary ?? "本机通信链路可用。",
    },
    {
      id: "health",
      label: "健康检查",
      value: input.setupLoading ? "检测中" : input.setupBlocking.length ? "有阻塞项" : "通过",
      tone: input.setupLoading ? "neutral" as const : input.setupBlocking.length ? "danger" as const : "ok" as const,
      detail: firstBlocking?.message ?? "暂无阻塞项。",
    },
    ...(currentVersion ? [{
      id: "version",
      label: "当前版本",
      value: currentVersion,
      tone: "ok" as const,
      detail: input.updateStatus?.updateAvailable ? `有 ${input.updateStatus.behindCount ?? "?"} 个提交可更新` : "已是最新",
    }] : []),
    ...(latestVersion ? [{
      id: "latestVersion",
      label: "最新版本",
      value: latestVersion,
      tone: input.updateStatus?.updateAvailable ? "warn" as const : "ok" as const,
      detail: input.updateStatus?.remoteRef,
    }] : []),
  ];

  if (input.installEvent && input.installEvent.stage !== "completed" && input.installEvent.stage !== "failed") {
    return {
      state: "installing",
      tone: "neutral",
      title: "Hermes Agent 正在处理",
      detail: input.installEvent.message || "正在执行安装或修复，请等待完成。",
      primaryAction: "none",
      primaryLabel: "处理中",
      runtimeLabel,
      statusPill: "处理中",
      detailRows,
    };
  }

  if (!rootPath && input.hermesAvailable !== true) {
    const isMac = input.runtime?.mode === "darwin";
    return {
      state: "missing",
      tone: "danger",
      title: "Hermes Agent 未安装",
      detail: `当前电脑没有可用的 ${runtimeLabel} Hermes Agent。请先选择或安装 Hermes Agent。`,
      primaryAction: "install",
      primaryLabel: isMac ? "选择安装位置" : "一键安装",
      runtimeLabel,
      statusPill: "未安装",
      detailRows,
    };
  }

  if (hermesBlocking) {
    const shouldUpdate = hermesBlocking.fixAction === "update_hermes" || capabilityBlock;
    return {
      state: shouldUpdate ? "degraded" : "broken",
      tone: shouldUpdate ? "warn" : "danger",
      title: shouldUpdate ? "Hermes Agent 可用，增强能力降级" : "Hermes Agent 需要修复",
      detail: hermesBlocking.message || (shouldUpdate ? "当前官方版本缺少增强 capabilities，基础功能仍可使用。" : "路径存在，但 Hermes Agent 不可用。"),
      primaryAction: shouldUpdate ? "diagnose" : "repair",
      primaryLabel: shouldUpdate ? "查看详情" : "一键修复",
      runtimeLabel,
      statusPill: shouldUpdate ? "兼容模式" : "安装损坏",
      detailRows,
    };
  }

  if (capabilityBlock && input.permissionOverview?.blockReason) {
    return {
      state: "degraded",
      tone: "warn",
      title: "Hermes Agent 可用，增强能力降级",
      detail: input.permissionOverview.blockReason.detail || input.permissionOverview.blockReason.summary,
      primaryAction: "diagnose",
      primaryLabel: "查看详情",
      runtimeLabel,
      statusPill: "兼容模式",
      detailRows,
    };
  }

  if (modelBlocking) {
    return {
      state: "config_error",
      tone: "warn",
      title: "模型配置需要补齐",
      detail: modelBlocking.message || "默认模型还不可用，请先配置模型来源和密钥。",
      primaryAction: "diagnose",
      primaryLabel: "查看诊断",
      runtimeLabel,
      statusPill: "配置异常",
      detailRows,
    };
  }

  if (input.permissionError || input.permissionOverview?.blocked) {
    return {
      state: "connection_error",
      tone: "danger",
      title: "Agent 连接需要检查",
      detail: input.permissionError ?? input.permissionOverview?.blockReason?.detail ?? "Windows Agent 权限或联动能力未通过检查。",
      primaryAction: "diagnose",
      primaryLabel: "查看诊断",
      runtimeLabel,
      statusPill: "连接异常",
      detailRows,
    };
  }

  if (input.updateStatus?.updateAvailable) {
    return {
      state: "update_required",
      tone: "warn",
      title: `Hermes Agent 有更新可用`,
      detail: input.updateStatus.message || `当前版本 ${currentVersion ?? "unknown"}，最新版本 ${latestVersion ?? "unknown"}，建议更新到最新版。`,
      primaryAction: "update",
      primaryLabel: "一键更新",
      runtimeLabel,
      statusPill: "可更新",
      detailRows,
    };
  }

  return {
    state: "ready",
    tone: "ok",
    title: "Hermes Agent 已准备好",
    detail: `${runtimeLabel} Agent、模型配置、Skills 和连接器可以继续使用。`,
    primaryAction: "refresh",
    primaryLabel: "刷新状态",
    runtimeLabel,
    statusPill: "已准备好",
    detailRows,
  };
}
