export type EngineId = "hermes";

export type EngineCapability =
  | "cli"
  | "file_memory"
  | "private_skills"
  | "context_bridge";

export type EnginePermissionPolicy = {
  enabled: boolean;
  workspaceRead: boolean;
  fileWrite: boolean;
  commandRun: boolean;
  memoryRead: boolean;
  contextBridge: boolean;
};

export type WindowsAgentMode = "hermes_native" | "host_tool_loop" | "disabled";
export type HermesCliPermissionMode = "yolo" | "safe" | "guarded";
export type HermesPermissionPolicyMode = "passthrough" | "bridge_guarded" | "restricted_workspace";
export type HermesSourceLabel = "official" | "fork" | "pinned";

export type HermesInstallSourceConfig = {
  repoUrl: string;
  branch?: string;
  commit?: string;
  sourceLabel: HermesSourceLabel;
};

export type HermesRuntimeConfig = {
  mode: "windows" | "wsl";
  distro?: string;
  pythonCommand?: string;
  managedRoot?: string;
  windowsAgentMode?: WindowsAgentMode;
  cliPermissionMode?: HermesCliPermissionMode;
  permissionPolicy?: HermesPermissionPolicyMode;
  workerMode?: "off" | "experimental_wsl";
  installSource?: HermesInstallSourceConfig;
};

export type WindowsBridgeStatus = {
  running: boolean;
  host?: string;
  port?: number;
  capabilities: string[];
  message?: string;
};

export type PermissionOverviewRuntime = "wsl" | "native";

export type PermissionOverviewBlockReason = {
  code: "policy_not_enforceable" | "unsupported_runtime_enforcement" | "manual_configuration_required" | "unsupported_cli_version" | "unsupported_cli_capability";
  summary: string;
  detail: string;
  fixHint: string;
  debugContext?: Record<string, unknown>;
};

export type PermissionOverview = {
  runtime: PermissionOverviewRuntime;
  permissionPolicy: HermesPermissionPolicyMode;
  cliPermissionMode: HermesCliPermissionMode;
  transport: "native-arg-env" | null;
  sessionMode: "fresh" | "resumed" | "continued" | "degraded" | null;
  bridge: {
    enabled: boolean;
    running: boolean;
    capabilities: string[];
    capabilityCount: number;
    reportedByBackend: boolean;
  };
  enforcement: {
    hardEnforceable: string[];
    softGuarded: string[];
    notEnforceableYet: string[];
  };
  blocked: boolean;
  blockReason: PermissionOverviewBlockReason | null;
  capabilityProbe: {
    minimumSatisfied: boolean;
    cliVersion?: string;
    missing?: string[];
    allowedTransports?: string[];
    support?: "native" | "legacy_compatible" | "degraded" | "unsupported";
    reason?: string;
  } | null;
  runtimeReady: boolean;
  notes?: string[];
};

export type BridgeTestStepStatus = "passed" | "failed" | "skipped";

export type BridgeTestStepId =
  | "bridge-running"
  | "bridge-health-local"
  | "wsl-available"
  | "wsl-host-resolved"
  | "bridge-health-from-wsl"
  | "powershell-smoke"
  | "files-write-smoke"
  | "clipboard-smoke"
  | "screenshot-smoke"
  | "autohotkey-detected"
  | "windows-list-smoke"
  | "keyboard-dry-smoke";

export type BridgeTestStep = {
  id: BridgeTestStepId;
  label: string;
  status: BridgeTestStepStatus;
  message: string;
  durationMs?: number;
  detail?: string;
};

export type HermesWindowsBridgeTestResult = {
  ok: boolean;
  mode: HermesRuntimeConfig["mode"];
  bridgeUrl?: string;
  steps: BridgeTestStep[];
  message: string;
};

export type HermesSystemAuditStepId =
  | "preflight"
  | "read-nasty-path"
  | "write-outside-workspace"
  | "read-large-file"
  | "host-command";

export type HermesSystemAuditStep = {
  id: HermesSystemAuditStepId;
  label: string;
  status: BridgeTestStepStatus;
  message: string;
  durationMs?: number;
  detail?: string;
  artifactPath?: string;
};

export type HermesSystemAuditResult = {
  ok: boolean;
  workspacePath: string;
  steps: HermesSystemAuditStep[];
  message: string;
};

export type OneClickDiagnosticStatus =
  | "pass"
  | "warn"
  | "fail"
  | "fixed"
  | "skipped";

export type OneClickDiagnosticSeverity =
  | "info"
  | "warning"
  | "error"
  | "critical";

export type OneClickDiagnosticItem = {
  id: string;
  title: string;
  status: OneClickDiagnosticStatus;
  severity: OneClickDiagnosticSeverity;
  summary: string;
  details?: string;
  evidence?: unknown;
  autoFixable: boolean;
  fixed?: boolean;
  userActionRequired?: boolean;
  suggestedActions?: string[];
  source?: string;
};

export type OneClickDiagnosticsReport = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: {
    total: number;
    passed: number;
    warnings: number;
    failed: number;
    fixed: number;
    skipped: number;
    unresolved: number;
  };
  items: OneClickDiagnosticItem[];
};

export type OneClickDiagnosticsRunOptions = {
  autoFix?: boolean;
  deepAudit?: boolean;
  workspacePath?: string;
};

export type OneClickDiagnosticsStatus = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  stage?: string;
  message: string;
  lastReport?: OneClickDiagnosticsReport;
};

export type OneClickDiagnosticsExportResult = DiagnosticExportResult & {
  oneClickReportPath?: string;
  diagnosticsPath?: string;
};

export type WindowsToolName =
  | "windows.files.listDir"
  | "windows.files.readText"
  | "windows.files.writeText"
  | "windows.files.exists"
  | "windows.files.delete"
  | "windows.shell.openPath"
  | "windows.clipboard.read"
  | "windows.clipboard.write"
  | "windows.powershell.run"
  | "windows.screenshot.capture"
  | "windows.windows.list"
  | "windows.windows.focus"
  | "windows.windows.close"
  | "windows.keyboard.type"
  | "windows.keyboard.pressHotkey"
  | "windows.mouse.click"
  | "windows.mouse.move"
  | "windows.ahk.runScript"
  | "windows.system.getDesktopPath"
  | "windows.system.getKnownFolders";

export type WindowsToolCall = {
  type: "tool_call";
  tool: WindowsToolName;
  input?: Record<string, unknown>;
};

export type HermesToolFinal = {
  type: "final";
  message: string;
};

export type HermesToolLoopModelOutput = WindowsToolCall | HermesToolFinal;

export type WindowsToolExecutionResult = {
  ok: boolean;
  tool: WindowsToolName;
  result?: Record<string, unknown>;
  message: string;
  durationMs: number;
};

export type AutoHotkeyStatus = {
  available: boolean;
  executablePath?: string;
  version?: string;
  message: string;
};

export const defaultEnginePermissions: Record<EngineId, EnginePermissionPolicy> = {
  hermes: {
    enabled: true,
    workspaceRead: true,
    fileWrite: true,
    commandRun: true,
    memoryRead: true,
    contextBridge: true,
  },
};

export function resolveEnginePermissions(
  config: Pick<RuntimeConfig, "enginePermissions"> | undefined,
  engineId: EngineId = "hermes",
): EnginePermissionPolicy {
  return {
    ...defaultEnginePermissions[engineId],
    ...(config?.enginePermissions?.[engineId] ?? {}),
  };
}

export type TaskType =
  | "fix_error"
  | "generate_web"
  | "analyze_project"
  | "organize_files"
  | "custom";

export type MemoryPolicy = "isolated";
export type WorkSessionStatus = "idle" | "running" | "failed" | "completed" | "archived";

export type WorkSession = {
  id: string;
  title: string;
  status: WorkSessionStatus;
  sessionFilesPath: string;
  workspacePath?: string;
  workspaceStatus?: "ready" | "missing" | "unselected";
  pinned?: boolean;
  projectId?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
  archivedAt?: string;
  clearedAt?: string;
};

export type SessionMetaPatch = Partial<Pick<WorkSession, "pinned" | "tags" | "status">> & {
  projectId?: string | null;
};

export type SessionAgentInsightRuntime = {
  taskRunId: string;
  status: TaskRunStatus;
  providerId?: ProviderId;
  modelId?: string;
  runtimeMode?: EngineExecutionMode;
  contextWindow?: number;
  temperature?: number;
  updatedAt: string;
};

export type SessionAgentInsightUsage = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  latestInputTokens: number;
  latestOutputTokens: number;
  latestEstimatedCostUsd: number;
  updatedAt: string;
};

export type SessionAgentInsightMemory = {
  bundleId: string;
  usedCharacters: number;
  maxCharacters: number;
  summary: string;
  updatedAt: string;
};

export type SessionAgentInsight = {
  sessionId: string;
  latestRuntime?: SessionAgentInsightRuntime;
  usage?: SessionAgentInsightUsage;
  memory?: SessionAgentInsightMemory;
};

export type ChatMessage = SessionMessage;

export interface ChatSession {
  id: string;
  title: string;
  workspacePath?: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export type ProjectGroup = {
  id: string;
  name: string;
  color: string;
  sessionCount?: number;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSpace = {
  id: string;
  name: string;
  path: string;
  description?: string;
  pinned?: boolean;
  lastOpenedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type HermesSkill = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  category: string;
  summary: string;
  updatedAt?: string;
  size: number;
};

export type HermesMemoryFile = {
  id: "USER.md" | "MEMORY.md";
  label: string;
  path: string;
  content: string;
  updatedAt?: string;
  size: number;
};

export type HermesCronJob = {
  id: string;
  name: string;
  prompt?: string;
  schedule?: string;
  status: "active" | "paused" | "unknown";
  source?: "cli" | "json-fallback";
  lastOutput?: string;
  path?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  repeat?: number | null;
  deliver?: string;
  skills?: string[];
  script?: string;
};

export type HermesConnectorPlatformId =
  | "telegram"
  | "discord"
  | "slack"
  | "whatsapp"
  | "signal"
  | "email"
  | "matrix"
  | "mattermost"
  | "dingtalk"
  | "feishu"
  | "homeassistant"
  | "wecom"
  | "wecom_callback"
  | "weixin"
  | "bluebubbles"
  | "sms"
  | "qqbot";

export type HermesConnectorStatus = "unconfigured" | "configured" | "running" | "error" | "disabled";

export type HermesConnectorField = {
  key: string;
  envVar: string;
  label: string;
  type: "text" | "password" | "url" | "boolean" | "number";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  help?: string;
};

export type HermesConnectorPlatform = {
  id: HermesConnectorPlatformId;
  label: string;
  category: "official" | "advanced" | "local";
  description: string;
  fields: HermesConnectorField[];
  setupHelp: string[];
};

export type HermesConnectorConfig = {
  platform: HermesConnectorPlatform;
  status: HermesConnectorStatus;
  runtimeStatus: "stopped" | "running" | "error";
  enabled: boolean;
  configured: boolean;
  missingRequired: string[];
  values: Record<string, string | boolean>;
  secretRefs: Record<string, string>;
  secretStatus: Record<string, boolean>;
  updatedAt?: string;
  lastSyncedAt?: string;
  message: string;
};

export type HermesConnectorSaveInput = {
  platformId: HermesConnectorPlatformId;
  enabled?: boolean;
  values: Record<string, string | boolean | undefined>;
};

export type HermesConnectorListResult = {
  connectors: HermesConnectorConfig[];
  gateway: HermesGatewayStatus;
  envPath: string;
};

export type HermesGatewayStatus = {
  running: boolean;
  managedRunning: boolean;
  healthStatus: "running" | "stopped" | "error";
  autoStartState?: "idle" | "starting" | "running" | "failed";
  autoStartMessage?: string;
  lastExitCode?: number | null;
  lastExitAt?: string;
  restartCount?: number;
  backoffUntil?: string;
  pid?: number;
  startedAt?: string;
  command?: string;
  message: string;
  lastOutput?: string;
  lastError?: string;
  checkedAt: string;
};

export type HermesGatewayActionResult = {
  ok: boolean;
  status: HermesGatewayStatus;
  message: string;
};

export type WeixinQrLoginPhase =
  | "idle"
  | "fetching_qr"
  | "waiting_scan"
  | "waiting_confirm"
  | "saving"
  | "syncing"
  | "starting_gateway"
  | "success"
  | "timeout"
  | "failed"
  | "cancelled";

export type WeixinRecoveryAction = "install_aiohttp";
export type WeixinFailureKind = "recoverable" | "manual_fix" | "external_unreachable";

export type WeixinQrLoginStatus = {
  running: boolean;
  phase: WeixinQrLoginPhase;
  startedAt?: string;
  completedAt?: string;
  success?: boolean;
  message: string;
  output?: string;
  qrUrl?: string;
  expiresAt?: string;
  accountId?: string;
  userId?: string;
  gatewayStarted?: boolean;
  failureCode?: string;
  lastHeartbeatAt?: string;
  attempt?: number;
  recoveryAction?: WeixinRecoveryAction;
  recoveryCommand?: string;
  runtimePythonLabel?: string;
  failureKind?: WeixinFailureKind;
  recommendedFix?: string;
};

export type WeixinQrLoginResult = {
  ok: boolean;
  status: WeixinQrLoginStatus;
  message: string;
};

export type WeixinDependencyInstallResult = {
  ok: boolean;
  message: string;
  command: string;
  stdout: string;
  stderr: string;
  failureCategory?: "network" | "pip_unavailable" | "permission_denied" | "interpreter_error" | "unknown";
  recommendedFix?: string;
  status?: WeixinQrLoginStatus;
};

export type HermesProfile = {
  id: string;
  name: string;
  path: string;
  active: boolean;
  hasConfig: boolean;
  skillCount: number;
  memoryFiles: number;
  updatedAt?: string;
};

export type SlashCommand = {
  name: string;
  description: string;
  usage: string;
};

export type SlashCommandResult = {
  handled: boolean;
  message: string;
  nextAction?: "send" | "clear" | "new-session" | "open-settings" | "open-workspace" | "show-help" | "noop";
};

export type ApprovalChoice = "once" | "session" | "always" | "deny";

export type ApprovalActionKind =
  | "file_write"
  | "file_delete"
  | "command_run"
  | "window_control"
  | "keyboard_input"
  | "mouse_input"
  | "automation";

export type ApprovalRequest = {
  id: string;
  taskRunId: string;
  title: string;
  command?: string;
  path?: string;
  patternKey: string;
  scopeKey: string;
  actionKind: ApprovalActionKind;
  details?: string;
  risk: "low" | "medium" | "high";
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt?: string;
};

export type ClarifyRequest = {
  id: string;
  question: string;
  options?: string[];
  status: "pending" | "answered" | "dismissed";
  createdAt: string;
};

export type ToolCardModel = {
  id: string;
  title: string;
  detail?: string;
  status: "running" | "complete" | "failed" | "pending";
  kind: "command" | "file" | "network" | "memory" | "diagnostic";
};

export type ThemePreference = {
  id: "green-light" | "light" | "slate" | "oled";
  label: string;
};

export type FilePreviewResult = {
  path: string;
  name: string;
  kind: "text" | "markdown" | "image" | "binary" | "directory";
  content?: string;
  mimeType?: string;
  size?: number;
  modifiedAt?: string;
};

export type FileBreadcrumbItem = {
  name: string;
  path: string;
};

export type SessionExportResult = {
  ok: boolean;
  path: string;
  message: string;
};

export type HermesWebUiSettings = {
  theme: ThemePreference["id"];
  language: "zh" | "en";
  sendKey: "enter" | "mod-enter";
  showUsage: boolean;
  showCliSessions: boolean;
};

export type HermesWebUiOverview = {
  settings: HermesWebUiSettings;
  projects: ProjectGroup[];
  spaces: WorkspaceSpace[];
  skills: HermesSkill[];
  memory: HermesMemoryFile[];
  crons: HermesCronJob[];
  profiles: HermesProfile[];
  slashCommands: SlashCommand[];
};

export type ToolEvent = {
  id: string;
  type: "tool_call" | "file_read" | "file_write" | "command_run" | "diagnostic" | "snapshot" | "restore";
  label: string;
  status: "running" | "complete" | "failed";
  path?: string;
  command?: string;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type TaskRunId = string;
export type TaskRunStatus = "pending" | "routing" | "running" | "streaming" | "complete" | "failed" | "cancelled" | "interrupted";
export type ProviderId =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "gemini"
  | "deepseek"
  | "huggingface"
  | "copilot"
  | "copilot_acp"
  | "local"
  | "custom";
export type EngineExecutionMode = "local_fast" | "direct_cli";

export type SessionMessage = {
  id: string;
  sessionId: string;
  taskId?: string;
  role: "user" | "agent" | "system" | "tool";
  content: string;
  status?: "pending" | "streaming" | "complete" | "failed";
  engine?: EngineId | "auto";
  engineId?: EngineId;
  actualEngine?: EngineId;
  authorName?: string;
  runtimeMode?: EngineExecutionMode;
  providerId?: ProviderId;
  modelId?: string;
  streamSeq?: number;
  parts?: StreamEvent[];
  toolEvents?: ToolEvent[];
  createdAt: string;
  visibleInChat: boolean;
};

export type TaskRunProjection = {
  taskRunId: TaskRunId;
  workSessionId: string;
  userMessage?: SessionMessage;
  assistantMessage: SessionMessage;
  status: TaskRunStatus;
  engineId?: EngineId;
  actualEngine?: EngineId;
  runtimeMode?: EngineExecutionMode;
  providerId?: ProviderId;
  modelId?: string;
  toolEvents: ToolEvent[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type SessionRun = {
  id: string;
  sessionId: string;
  engineId: EngineId;
  status: "preflight" | "snapshot" | "running" | "failed" | "completed" | "cancelled";
  startedAt: string;
  completedAt?: string;
};

export type EngineHealth = {
  engineId: EngineId;
  label: string;
  available: boolean;
  mode: "mock" | "cli" | "file" | "api";
  version?: string;
  capabilities?: string[];
  path?: string;
  message: string;
};

export type EngineUpdateStatus = {
  engineId: EngineId | "client";
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  sourceConfigured: boolean;
  message: string;
};

export type ClientUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export type ClientUpdateEvent = {
  status: ClientUpdateStatus;
  message: string;
  currentVersion?: string;
  latestVersion?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  manual?: boolean;
  at: string;
};

export type SponsorEntryStatus = "self_reported" | "verified" | "new" | "read" | "planned" | "done" | "hidden";

export type SponsorEntry = {
  id: string;
  supporterId: string;
  message: string;
  reply?: string;
  status: SponsorEntryStatus;
  createdAt: string;
};

export type SponsorOverview = {
  entries: SponsorEntry[];
  totalCount: number;
  updatedAt?: string;
};

export type SponsorSubmitInput = {
  supporterId: string;
  message?: string;
};

export type SponsorSubmitResult = {
  ok: boolean;
  entry: SponsorEntry;
  message: string;
  overview: SponsorOverview;
};

export type MemoryStatus = {
  engineId: EngineId;
  workspaceId: string;
  usedCharacters: number;
  maxCharacters?: number;
  filePath?: string;
  entries: number;
  message: string;
};

export type ModelOption = {
  id: string;
  label: string;
  contextWindow?: number;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  inputCostPer1kUsd?: number;
  outputCostPer1kUsd?: number;
};

export type ModelProviderProfile = {
  id: string;
  provider: ProviderId;
  label: string;
  baseUrl?: string;
  apiKeySecretRef?: string;
  models: ModelOption[];
  status: "unknown" | "checking" | "ready" | "failed";
  lastCheckedAt?: string;
  lastError?: string;
};

export type EngineRuntimeProfile = {
  engineId: EngineId;
  executionMode: EngineExecutionMode;
  providerProfileId?: string;
  modelId?: string;
  permissions: EnginePermissionPolicy;
  memoryPolicy: MemoryPolicy;
};

export type ModelProfile = {
  id: string;
  name?: string;
  provider: ProviderId;
  baseUrl?: string;
  model: string;
  secretRef?: string;
  temperature?: number;
  maxTokens?: number;
  sourceType?: ModelSourceType;
  authMode?: ModelAuthMode;
  agentRole?: ModelCapabilityRole;
  supportsTools?: boolean;
  supportsVision?: boolean;
  lastHealthCheckAt?: string;
  lastHealthStatus?: "ready" | "warning" | "failed";
  lastHealthSummary?: string;
};

export type ContextSource = {
  id: string;
  engineId: EngineId;
  title: string;
  summary: string;
  pointer: string;
  characters: number;
  createdAt: string;
};

export type ContextBundle = {
  id: string;
  workspaceId: string;
  policy: MemoryPolicy;
  readonly: true;
  maxCharacters: number;
  usedCharacters: number;
  sources: ContextSource[];
  summary: string;
  expiresAt: string;
  createdAt: string;
};

export type ContextRequest = {
  workspaceId: string;
  workspacePath: string;
  userInput: string;
  taskType: TaskType;
  memoryPolicy: MemoryPolicy;
};

export type EngineRunRequest = {
  sessionId: string;
  conversationId?: string;
  conversationHistory?: ConversationHistoryEntry[];
  workspaceId: string;
  workspacePath: string;
  userInput: string;
  taskType: TaskType;
  selectedFiles: string[];
  attachments?: SessionAttachment[];
  memoryPolicy: MemoryPolicy;
  modelProfileId?: string;
  runtimeEnv?: EngineRuntimeEnv;
  contextBundle?: ContextBundle;
  permissions?: EnginePermissionPolicy;
};

export type ConversationHistoryEntry = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  taskRunId?: string;
};

export type EngineRuntimeEnv = {
  profileId: string;
  provider: ModelProfile["provider"];
  model: string;
  baseUrl?: string;
  providerProfileId?: string;
  executionMode?: EngineExecutionMode;
  env: Record<string, string>;
};

export type StartupWarmupMode = "off" | "cheap" | "real_probe";
export type StreamEventType = "text" | "thinking" | "tool_use" | "tool_result" | "diagnostic" | "error" | "lifecycle";

export type StreamEvent = {
  id: string;
  taskId: string;
  seq: number;
  type: StreamEventType;
  engineId: EngineId;
  content?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  status?: "queued" | "running" | "complete" | "failed" | "cancelled";
  providerId?: ProviderId;
  modelId?: string;
  createdAt: string;
};

export type TaskLifecycleStage = "queued" | "preflight" | "snapshot" | "running" | "streaming" | "cancelled" | "failed" | "completed" | "restored";

export type EngineEvent =
  | { type: "status"; level: "info" | "success" | "warning" | "error"; message: string; at: string }
  | { type: "lifecycle"; stage: TaskLifecycleStage; message: string; at: string }
  | { type: "progress"; step: string; done: boolean; message: string; at: string }
  | { type: "diagnostic"; category: string; message: string; provider?: string; model?: string; authMode?: string; durationMs?: number; at: string }
  | { type: "stdout"; line: string; at: string }
  | { type: "stderr"; line: string; at: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; estimatedCostUsd: number; message: string; at: string }
  | { type: "tool_call"; toolName: string; argsPreview: string; callId?: string; status?: "running" | "complete" | "failed"; summary?: string; at: string }
  | { type: "tool_result"; toolName: string; outputPreview?: string; callId?: string; success?: boolean; status?: "running" | "complete" | "failed"; summary?: string; at: string }
  | { type: "file_change"; path: string; changeType: "create" | "update" | "delete"; at: string }
  | { type: "approval"; request: ApprovalRequest; outcome: "requested" | "approved" | "denied" | "expired" | "auto_approved"; choice?: ApprovalChoice; message: string; at: string }
  | { type: "memory_access"; engineId: EngineId; action: "read" | "write" | "summarize"; source: string; at: string }
  | { type: "result"; success: boolean; title: string; detail: string; at: string };

export type AppErrorCode = "ENGINE_NOT_READY" | "MODEL_NOT_CONFIGURED" | "SECRET_MISSING" | "WORKSPACE_LOCKED" | "SNAPSHOT_FAILED" | "INSTALL_REQUIRED" | "CLI_FAILED";

export type AppError = {
  code: AppErrorCode;
  title: string;
  message: string;
  fixAction?: SetupFixAction;
};

export type StartTaskInput = {
  userInput: string;
  taskType: TaskType;
  workspacePath?: string;
  clientTaskId?: string;
  sessionId?: string;
  conversationHistory?: ConversationHistoryEntry[];
  sessionFilesPath: string;
  selectedFiles: string[];
  attachments?: SessionAttachment[];
  modelProfileId?: string;
};

export type SessionAttachmentKind = "image" | "file";

export type SessionAttachment = {
  id: string;
  name: string;
  path: string;
  originalPath: string;
  kind: SessionAttachmentKind;
  mimeType?: string;
  size: number;
  createdAt: string;
};

export type TaskStartResult = {
  taskRunId: TaskRunId;
  workSessionId: string;
  workspaceId: string;
  contextBundle: ContextBundle;
  snapshotId: string;
  runtime: {
    engineId: EngineId;
    runtimeMode: EngineExecutionMode;
    providerId?: ProviderId;
    modelId?: string;
  };
};

export type TaskEventEnvelope = {
  taskRunId: TaskRunId;
  workSessionId?: string;
  sessionId?: string;
  engineId: EngineId;
  event: EngineEvent;
};

export type SnapshotRestoreResult = {
  restored: boolean;
  snapshotId?: string;
  message: string;
};

export type SnapshotRecord = {
  snapshotId: string;
  workspaceId: string;
  workspacePath: string;
  createdAt: string;
  copiedFiles: number;
  skippedFiles: number;
  copiedBytes?: number;
  truncated?: boolean;
  limitReason?: string;
  maxFiles?: number;
  maxBytes?: number;
  mode?: "full" | "scoped" | "manifest";
  manifestOnly?: boolean;
  scopedPaths?: string[];
};

export type FileTreeEntry = {
  name: string;
  path: string;
  relativePath: string;
  type: "directory" | "file";
  size?: number;
  modifiedAt?: string;
  children?: FileTreeEntry[];
};

export type FileTreeResult = {
  workspacePath: string;
  generatedAt: string;
  entries: FileTreeEntry[];
  truncated: boolean;
  skippedEntries: number;
  message: string;
};

export type FileLockState = {
  workspaceId: string;
  sessionId: string;
  engineId?: EngineId;
  taskType?: TaskType;
  scope: "workspace" | "path";
  mode: "read" | "write";
  lockedPaths: string[];
  createdAt: string;
  message: string;
};

export type ClientInfo = {
  appVersion: string;
  userDataPath: string;
  portable: boolean;
  rendererMode: "dev" | "built";
};

export type HermesStatusSummary = {
  engine: EngineHealth;
  update: EngineUpdateStatus;
  memory: MemoryStatus;
};

export type RuntimeConfig = {
  defaultModelProfileId?: string;
  modelProfiles: ModelProfile[];
  providerProfiles?: ModelProviderProfile[];
  updateSources: Partial<Record<EngineId | "client", string>>;
  enginePaths?: Partial<Record<EngineId | "client", string>>;
  startupWarmupMode?: StartupWarmupMode;
  startupGatewayAutoStart?: boolean;
  enginePermissions?: Partial<Record<EngineId | "client", Partial<EnginePermissionPolicy>>>;
  hermesRuntime?: HermesRuntimeConfig;
};

export type SetupRequirementStatus = "ok" | "missing" | "warning" | "running" | "failed";
export type SetupDependencyRepairId = "git" | "python" | "hermes_pyyaml" | "hermes_python_dotenv" | "weixin_aiohttp";
export type SetupFixAction =
  | "configure_hermes"
  | "configure_model"
  | "open_settings"
  | "install_hermes"
  | "install_git"
  | "install_python"
  | "install_hermes_dependency"
  | "install_weixin_dependency";

export type SetupCheck = {
  id: string;
  label: string;
  status: SetupRequirementStatus;
  message: string;
  description?: string;
  recommendedAction?: string;
  fixAction?: SetupFixAction;
  canAutoFix?: boolean;
  autoFixId?: SetupDependencyRepairId;
  blocking?: boolean;
};

export type SetupSummary = {
  ready: boolean;
  blocking: SetupCheck[];
  checks: SetupCheck[];
};

export type SetupDependencyRepairResult = {
  ok: boolean;
  id: SetupDependencyRepairId;
  message: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  logPath?: string;
  recommendedFix?: string;
};

export type SecretVaultStatus = {
  available: boolean;
  mode: "safe-storage";
  path: string;
  message: string;
};

export type SecretSaveInput = {
  ref: string;
  plainText: string;
};

export type SecretRefStatus = {
  ref: string;
  exists: boolean;
};

export type QuickTextFileInput = {
  fileName?: string;
  content?: string;
};

export type QuickTextFileResult = {
  ok: boolean;
  path: string;
  message: string;
};

export type DiagnosticExportResult = {
  ok: boolean;
  path: string;
  message: string;
};

export type HermesExistingConfigImportResult = {
  ok: boolean;
  hermesHome: string;
  importedModel: boolean;
  modelProfileId?: string;
  importedConnectors: HermesConnectorPlatformId[];
  importedSecretRefs: string[];
  warnings: string[];
  message: string;
};

export type ModelSourceType =
  | "openrouter_api_key"
  | "anthropic_api_key"
  | "gemini_api_key"
  | "deepseek_api_key"
  | "huggingface_api_key"
  | "gemini_oauth"
  | "anthropic_local_credentials"
  | "github_copilot"
  | "github_copilot_acp"
  | "ollama"
  | "vllm"
  | "sglang"
  | "lm_studio"
  | "openai_compatible"
  | "legacy";

export type ModelProviderFamily =
  | "api_key"
  | "oauth_or_local_credentials"
  | "custom_endpoint";

export type ModelAuthMode =
  | "api_key"
  | "oauth"
  | "local_credentials"
  | "external_process"
  | "optional_api_key";

export type ModelCapabilityRole = "provider_only" | "auxiliary_model" | "primary_agent";

export type ModelHealthCheckStep = {
  id: "auth" | "models" | "chat" | "agent_capability" | "wsl_network";
  label: string;
  ok: boolean;
  message: string;
  detail?: string;
};

export type ModelConnectionTestResult = {
  ok: boolean;
  profileId?: string;
  message: string;
  sourceType?: ModelSourceType;
  providerFamily?: ModelProviderFamily;
  authMode?: ModelAuthMode;
  normalizedBaseUrl?: string;
  availableModels?: string[];
  healthChecks?: ModelHealthCheckStep[];
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  agentRole?: ModelCapabilityRole;
  wslReachable?: boolean;
  wslProbeUrl?: string;
  authResolved?: boolean;
  failureCategory?:
    | "network_unreachable"
    | "invalid_url"
    | "auth_missing"
    | "auth_invalid"
    | "model_not_found"
    | "path_invalid"
    | "server_error"
    | "context_too_low"
    | "tool_calling_unavailable"
    | "wsl_unreachable"
    | "provider_mismatch"
    | "manual_action_required"
    | "unknown";
  recommendedFix?: string;
};

export type LocalModelDiscoveryCandidate = {
  baseUrl: string;
  ok: boolean;
  availableModels: string[];
  message: string;
  failureCategory?: ModelConnectionTestResult["failureCategory"];
};

export type LocalModelDiscoveryResult = {
  ok: boolean;
  candidates: LocalModelDiscoveryCandidate[];
  recommendedBaseUrl?: string;
  recommendedModel?: string;
  message: string;
};

export type EngineProbeKind = "cheap" | "real";

export type EngineWarmupResult = {
  ok: boolean;
  message: string;
  probeKind: EngineProbeKind;
  diagnosticCategory?: "path" | "agent" | "network" | "model" | "timeout" | "workspace" | "unknown";
  durationMs?: number;
  provider?: string;
  model?: string;
  authMode?: string;
};

export type EngineMaintenanceResult = {
  ok: boolean;
  engineId: EngineId;
  message: string;
  log: string[];
  logPath?: string;
};

export type HermesInstallResult = EngineMaintenanceResult & {
  rootPath?: string;
};

export type HermesInstallStage =
  | "preflight"
  | "repairing_dependencies"
  | "recovering"
  | "cloning"
  | "installing_dependencies"
  | "health_check"
  | "completed"
  | "failed";

export type HermesInstallEvent = {
  stage: HermesInstallStage;
  message: string;
  detail?: string;
  progress: number;
  startedAt: string;
  at: string;
};

export type ManagedWslInstallerState =
  | "doctor_started"
  | "doctor_blocked"
  | "repair_planned"
  | "repair_executing"
  | "distro_ready"
  | "hermes_install_started"
  | "hermes_install_blocked"
  | "hermes_install_failed"
  | "hermes_install_ready"
  | "completed";

export type ManagedWslInstallerCode =
  | "python_missing"
  | "git_missing"
  | "pip_missing"
  | "venv_unavailable"
  | "repo_invalid"
  | "repo_clone_failed"
  | "pip_install_failed"
  | "hermes_healthcheck_failed"
  | "bridge_unreachable"
  | "distro_unavailable"
  | "unsupported"
  | "manual_action_required"
  | "ok";

export type ManagedWslInstallerPhase =
  | "doctor"
  | "repair"
  | "distro"
  | "install"
  | "health_check"
  | "completed";

export type ManagedWslInstallerStatus =
  | "pending"
  | "running"
  | "blocked"
  | "failed"
  | "ready"
  | "completed"
  | "skipped";

export type ManagedWslInstallerResumeStage =
  | "doctor"
  | "repair"
  | "create_distro"
  | "ensure_python"
  | "ensure_repo"
  | "ensure_venv"
  | "pip_install"
  | "health_check";

export type ManagedWslInstallerRecoveryDisposition =
  | "retryable"
  | "non_retryable"
  | "manual_action_required";

export type ManagedWslInstallerRecoveryAction =
  | "retry_install"
  | "retry_create_distro"
  | "run_dry_run_repair"
  | "run_execute_repair"
  | "restart_bridge_and_retry"
  | "manual_create_distro"
  | "manual_repo_cleanup"
  | "manual_fix_then_retry"
  | "export_diagnostics"
  | "none";

export type ManagedWslInstallerDependencyId = "python3" | "git" | "pip" | "venv";

export type ManagedWslInstallerDependencyStatus =
  | "unknown"
  | "ok"
  | "missing"
  | "repair_planned"
  | "repair_executing"
  | "repaired"
  | "manual_action_required"
  | "failed";

export type ManagedWslInstallerStepResult = {
  phase: ManagedWslInstallerPhase;
  step: string;
  status: ManagedWslInstallerStatus;
  code: ManagedWslInstallerCode;
  summary: string;
  detail?: string;
  fixHint?: string;
  debugContext?: Record<string, unknown>;
};

export type ManagedWslInstallerDependencyResult = {
  dependency: ManagedWslInstallerDependencyId;
  status: ManagedWslInstallerDependencyStatus;
  code: ManagedWslInstallerCode;
  summary: string;
  detail?: string;
  fixHint?: string;
  debugContext?: Record<string, unknown>;
};

export type ManagedWslInstallerRecovery = {
  failureStage: ManagedWslInstallerResumeStage;
  disposition: ManagedWslInstallerRecoveryDisposition;
  code: string;
  summary: string;
  detail?: string;
  fixHint?: string;
  nextAction: ManagedWslInstallerRecoveryAction;
  debugContext?: Record<string, unknown>;
};

export type ManagedWslInstallerFailureCommand = {
  commandSummary: string;
  commandId?: string;
  exitCode?: number | null;
  stdoutPreview?: string;
  stderrPreview?: string;
};

export type ManagedWslInstallerFailureArtifacts = {
  failedCommand?: ManagedWslInstallerFailureCommand;
  distroName?: string;
  managedRoot?: string;
  repoStatus?: Record<string, unknown>;
  venvStatus?: Record<string, unknown>;
  bridgeStatus?: Record<string, unknown>;
  lastSuccessfulStage?: ManagedWslInstallerResumeStage;
  recommendedRecoveryAction?: ManagedWslInstallerRecoveryAction;
};

export type ManagedWslInstallerReport = {
  startedAt: string;
  finishedAt: string;
  finalInstallerState: ManagedWslInstallerState;
  phase: ManagedWslInstallerPhase;
  step: string;
  status: ManagedWslInstallerStatus;
  code: ManagedWslInstallerCode;
  summary: string;
  detail?: string;
  fixHint?: string;
  debugContext?: Record<string, unknown>;
  current: ManagedWslInstallerStepResult;
  timeline: ManagedWslInstallerStepResult[];
  distroName?: string;
  managedRoot?: string;
  hermesSource?: HermesInstallSourceConfig;
  hermesCommit?: string;
  hermesVersion?: string;
  hermesCapabilityProbe?: {
    minimumSatisfied: boolean;
    cliVersion?: string;
    missing?: string[];
    supportsLaunchMetadataArg: boolean;
    supportsLaunchMetadataEnv: boolean;
    supportsResume: boolean;
  };
  pythonStatus: ManagedWslInstallerDependencyResult;
  gitStatus: ManagedWslInstallerDependencyResult;
  pipStatus: ManagedWslInstallerDependencyResult;
  venvStatus: ManagedWslInstallerDependencyResult;
  repoStatus: ManagedWslInstallerStepResult;
  installStatus: ManagedWslInstallerStepResult;
  healthStatus: ManagedWslInstallerStepResult;
  reprobeStatus?: "ready" | "degraded" | "missing_dependency" | "misconfigured" | "unavailable";
  reDoctorStatus?: "ready_to_attach_existing_wsl" | "repair_needed" | "manual_setup_required" | "unsupported";
  resumedFromStage?: ManagedWslInstallerResumeStage;
  lastSuccessfulStage?: ManagedWslInstallerResumeStage;
  recovery?: ManagedWslInstallerRecovery;
  nextRecommendedStep?: ManagedWslInstallerRecoveryAction;
  failureArtifacts?: ManagedWslInstallerFailureArtifacts;
  lastDoctor?: Record<string, unknown>;
  lastDryRunRepair?: Record<string, unknown>;
  lastRepairExecution?: Record<string, unknown>;
  lastCreateDistro?: Record<string, unknown>;
  lastHermesInstall?: Record<string, unknown>;
  reportPath?: string;
};

export type ManagedWslInstallerAction =
  | "plan"
  | "dry_run_repair"
  | "execute_repair"
  | "install"
  | "get_last_report";

export type ManagedWslInstallerIpcResult = {
  ok: boolean;
  action: ManagedWslInstallerAction;
  phase: ManagedWslInstallerPhase;
  step: string;
  status: ManagedWslInstallerStatus;
  code: ManagedWslInstallerCode;
  summary: string;
  detail?: string;
  fixHint?: string;
  debugContext?: Record<string, unknown>;
  report?: ManagedWslInstallerReport;
};

export type EngineProbeMetric = {
  label: string;
  value: string;
  tone: "green" | "blue" | "amber" | "slate" | "red";
};

export type HermesProbe = {
  engineId: EngineId;
  checkedAt: string;
  status: "healthy" | "warning" | "offline";
  primaryMetric: string;
  secondaryMetric: string;
  metrics: EngineProbeMetric[];
  message: string;
};

export type HermesProbeSummary = {
  checkedAt: string;
  probe: HermesProbe;
};

export type EngineCostProfile = {
  engineId: EngineId;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  warningLevel: "low" | "medium" | "high";
  message: string;
};

export type EngineMemoryLoad = {
  engineId: EngineId;
  label: string;
  used: number;
  total?: number;
  unit: "characters" | "entries" | "mb";
  percent?: number;
  warningLevel: "safe" | "warning" | "critical";
  description: string;
};

export type EngineVital = {
  engineId: EngineId;
  status: "available" | "busy" | "offline";
  memoryUsage: {
    used: number;
    total?: number;
    unit: "characters" | "entries" | "mb";
  };
  latencyMs?: number;
};

export type ActivityLog = {
  id: string;
  engineId: EngineId;
  type: "generate" | "fix" | "analyze";
  status: "success" | "running" | "failed";
  timestamp: string;
  summary: string;
};

export type IntentProbeState = {
  status: "idle" | "evaluating" | "ready";
  recommendedEngine?: EngineId;
  confidence?: number;
  message: string;
};

export type DashboardSnapshot = {
  costProfiles: EngineCostProfile[];
  memoryLoads: EngineMemoryLoad[];
  engineVitals: EngineVital[];
  activityLogs: ActivityLog[];
  intentProbe: IntentProbeState;
};

export type DashboardData = {
  engineVitals: EngineVital[];
  activityLogs: ActivityLog[];
};

export const emptyDashboardData: DashboardData = {
  engineVitals: [],
  activityLogs: [],
};

export const emptyDashboardSnapshot: DashboardSnapshot = {
  costProfiles: [
    {
      engineId: "hermes",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      warningLevel: "low",
      message: "暂无 Hermes 成本采样，运行任务后自动汇总。",
    },
  ],
  memoryLoads: [
    {
      engineId: "hermes",
      label: "本地 MEMORY.md",
      used: 0,
      total: 28000,
      unit: "characters",
      percent: 0,
      warningLevel: "safe",
      description: "等待读取 Hermes 本地记忆状态。",
    },
  ],
  engineVitals: [],
  activityLogs: [],
  intentProbe: {
    status: "idle",
    message: "输入任务后由 Hermes 执行。",
  },
};
