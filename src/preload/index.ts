import { contextBridge, ipcRenderer } from "electron";
import type {
  ClientInfo,
  DiagnosticExportResult,
  EngineMaintenanceResult,
  EngineUpdateStatus,
  EngineWarmupResult,
  FileLockState,
  FileTreeResult,
  HermesProbeSummary,
  HermesWebUiOverview,
  HermesWebUiSettings,
  HermesStatusSummary,
  ModelConnectionTestResult,
  ManagedWslInstallerIpcResult,
  OneClickDiagnosticsExportResult,
  OneClickDiagnosticsReport,
  OneClickDiagnosticsRunOptions,
  OneClickDiagnosticsStatus,
  LocalModelDiscoveryResult,
  QuickTextFileInput,
  QuickTextFileResult,
  PermissionOverview,
  RuntimeConfig,
  SessionAgentInsight,
  SecretRefStatus,
  SecretSaveInput,
  SecretVaultStatus,
  SetupDependencyRepairId,
  SetupDependencyRepairResult,
  SetupSummary,
  SnapshotRecord,
  SnapshotRestoreResult,
  SessionAttachment,
  StartTaskInput,
  TaskEventEnvelope,
  TaskStartResult,
  WorkSession,
  ProjectGroup,
  WorkspaceSpace,
  HermesSkill,
  HermesMemoryFile,
  HermesCronJob,
  HermesConnectorConfig,
  HermesConnectorListResult,
  HermesConnectorPlatformId,
  HermesConnectorSaveInput,
  HermesGatewayActionResult,
  HermesGatewayStatus,
  HermesInstallEvent,
  ClientUpdateEvent,
  HermesWindowsBridgeTestResult,
  HermesSystemAuditResult,
  HermesInstallResult,
  HermesProfile,
  HermesExistingConfigImportResult,
  FilePreviewResult,
  FileBreadcrumbItem,
  WeixinQrLoginResult,
  WeixinQrLoginStatus,
  WeixinDependencyInstallResult,
  SponsorOverview,
  SponsorSubmitInput,
  SponsorSubmitResult,
} from "../shared/types";

const IpcChannels = {
  openHelp: "system:open-help",
  restartApp: "system:restart",
  pickWorkspaceFolder: "workspace:pick-folder",
  pickHermesInstallFolder: "setup:pick-hermes-install-folder",
  pickSessionAttachments: "workspace:pick-session-attachments",
  importSessionAttachments: "workspace:import-session-attachments",
  importClipboardImageAttachment: "workspace:import-clipboard-image-attachment",
  createQuickTextFile: "workspace:create-quick-text-file",
  openPath: "system:open-path",
  getClientInfo: "system:get-client-info",
  listSponsorEntries: "support:sponsors:list",
  submitSponsorEntry: "support:sponsors:submit",
  startTask: "task:start",
  cancelTask: "task:cancel",
  taskEvent: "task:event",
  restoreLatestSnapshot: "snapshot:restore-latest",
  listSnapshots: "snapshot:list",
  getFileTree: "file-tree:get",
  listActiveLocks: "locks:list-active",
  getRecentTaskEvents: "task:recent-events",
  listSessions: "sessions:list",
  createSession: "sessions:create",
  updateSession: "sessions:update",
  archiveSession: "sessions:archive",
  deleteSession: "sessions:delete",
  duplicateSession: "sessions:duplicate",
  getSessionAgentInsight: "sessions:get-agent-insight",
  exportSession: "sessions:export",
  importSession: "sessions:import",
  importCliSession: "sessions:import-cli",
  clearSessionFiles: "sessions:clear-files",
  openSessionFolder: "sessions:open-folder",
  listProjects: "webui:projects:list",
  saveProject: "webui:projects:save",
  deleteProject: "webui:projects:delete",
  listSpaces: "webui:spaces:list",
  saveSpace: "webui:spaces:save",
  deleteSpace: "webui:spaces:delete",
  listSkills: "webui:skills:list",
  readSkill: "webui:skills:read",
  saveSkill: "webui:skills:save",
  deleteSkill: "webui:skills:delete",
  uploadSkill: "webui:skills:upload",
  listMemoryFiles: "webui:memory:list",
  saveMemoryFile: "webui:memory:save",
  importMemoryFile: "webui:memory:import",
  listProfiles: "webui:profiles:list",
  switchProfile: "webui:profiles:switch",
  createProfile: "webui:profiles:create",
  deleteProfile: "webui:profiles:delete",
  listCronJobs: "webui:crons:list",
  saveCronJob: "webui:crons:save",
  runCronJob: "webui:crons:run",
  pauseCronJob: "webui:crons:pause",
  resumeCronJob: "webui:crons:resume",
  deleteCronJob: "webui:crons:delete",
  previewFile: "webui:file:preview",
  getFileBreadcrumb: "webui:file:breadcrumb",
  getGitInfo: "webui:git:info",
  respondApproval: "webui:approval:respond",
  getWebUiOverview: "webui:overview",
  getWebUiSettings: "webui:settings:get",
  saveWebUiSettings: "webui:settings:save",
  getHermesStatus: "hermes:status",
  getHermesProbe: "hermes:probe",
  warmHermes: "hermes:warm",
  probeHermes: "hermes:probe-real",
  checkUpdates: "updates:check",
  checkClientUpdate: "updates:client-check",
  clientUpdateEvent: "updates:client-event",
  updateHermes: "updates:hermes",
  installHermes: "setup:install-hermes",
  installHermesEvent: "setup:install-hermes:event",
  repairSetupDependency: "setup:repair-dependency",
  installerPlan: "installer:plan",
  installerDryRunRepair: "installer:dry-run-repair",
  installerExecuteRepair: "installer:execute-repair",
  installerInstall: "installer:install",
  installerGetLastReport: "installer:get-last-report",
  getRuntimeConfig: "config:get-runtime",
  getConfigOverview: "config:get-overview",
  getPermissionOverview: "runtime:get-permission-overview",
  importExistingHermesConfig: "config:import-existing-hermes",
  testHermesWindowsBridge: "hermes:windows-bridge:test",
  testHermesSystemAudit: "hermes:system-audit:test",
  updateHermesConfig: "config:update-hermes",
  updateModelConfig: "config:update-models",
  setDefaultModel: "config:set-default-model",
  setModelRole: "config:set-model-role",
  listModelProviders: "config:list-model-providers",
  syncHermesModelRuntime: "config:sync-hermes-model-runtime",
  testModelRuntimeRole: "config:test-model-runtime-role",
  saveRuntimeConfig: "config:save-runtime",
  testModelConnection: "config:test-model-connection",
  getSetupSummary: "setup:get-summary",
  getSecretStatus: "secrets:status",
  saveSecret: "secrets:save",
  deleteSecret: "secrets:delete",
  hasSecret: "secrets:has",
  exportDiagnostics: "diagnostics:export",
  oneClickDiagnosticsRun: "diagnostics:one-click-run",
  oneClickDiagnosticsExport: "diagnostics:one-click-export",
  oneClickDiagnosticsStatus: "diagnostics:one-click-status",
  hermesAgentCompatibilityWarning: "setup:hermes-compatibility-warning",
  listConnectors: "connectors:list",
  saveConnector: "connectors:save",
  disableConnector: "connectors:disable",
  syncConnectorsEnv: "connectors:sync-env",
  getGatewayStatus: "gateway:status",
  startGateway: "gateway:start",
  stopGateway: "gateway:stop",
  restartGateway: "gateway:restart",
  startWeixinQrLogin: "connectors:weixin-qr:start",
  getWeixinQrLoginStatus: "connectors:weixin-qr:status",
  cancelWeixinQrLogin: "connectors:weixin-qr:cancel",
  installWeixinDependency: "connectors:weixin-qr:install-dependency",
  discoverLocalModelSources: "config:discover-local-model-sources",
  exportMessage: "message:export",
  writeClipboard: "clipboard:write-text",
} as const;

const api = {
  pickWorkspaceFolder: () => ipcRenderer.invoke(IpcChannels.pickWorkspaceFolder) as Promise<string | null>,
  pickHermesInstallFolder: () => ipcRenderer.invoke(IpcChannels.pickHermesInstallFolder) as Promise<string | null>,
  pickSessionAttachments: (sessionFilesPath: string) =>
    ipcRenderer.invoke(IpcChannels.pickSessionAttachments, sessionFilesPath) as Promise<SessionAttachment[]>,
  importSessionAttachments: (sessionFilesPath: string, filePaths: string[]) =>
    ipcRenderer.invoke(IpcChannels.importSessionAttachments, sessionFilesPath, filePaths) as Promise<SessionAttachment[]>,
  importClipboardImageAttachment: (sessionFilesPath: string) =>
    ipcRenderer.invoke(IpcChannels.importClipboardImageAttachment, sessionFilesPath) as Promise<SessionAttachment[]>,
  createQuickTextFile: (input: QuickTextFileInput) =>
    ipcRenderer.invoke(IpcChannels.createQuickTextFile, input) as Promise<QuickTextFileResult>,
  openPath: (targetPath: string) => ipcRenderer.invoke(IpcChannels.openPath, targetPath) as Promise<{ ok: boolean; message: string }>,
  openHelp: () => ipcRenderer.invoke(IpcChannels.openHelp) as Promise<{ ok: boolean; message: string }>,
  restart: () => ipcRenderer.invoke(IpcChannels.restartApp) as Promise<{ ok: boolean }>,
  getClientInfo: () => ipcRenderer.invoke(IpcChannels.getClientInfo) as Promise<ClientInfo>,
  listSponsorEntries: () => ipcRenderer.invoke(IpcChannels.listSponsorEntries) as Promise<SponsorOverview>,
  submitSponsorEntry: (input: SponsorSubmitInput) =>
    ipcRenderer.invoke(IpcChannels.submitSponsorEntry, input) as Promise<SponsorSubmitResult>,
  startTask: (input: StartTaskInput) => {
    console.info("[Hermes Trace]", {
      layer: "preload:startTask",
      clientTaskId: input.clientTaskId,
      taskType: input.taskType,
      userInputLength: input.userInput.length,
      workspacePath: input.workspacePath,
      selectedFilesCount: input.selectedFiles?.length ?? 0,
      attachmentsCount: input.attachments?.length ?? 0,
    });
    return ipcRenderer.invoke(IpcChannels.startTask, input) as Promise<TaskStartResult>;
  },
  cancelTask: (sessionId: string) => ipcRenderer.invoke(IpcChannels.cancelTask, sessionId) as Promise<boolean>,
  restoreLatestSnapshot: (workspacePath: string) =>
    ipcRenderer.invoke(IpcChannels.restoreLatestSnapshot, workspacePath) as Promise<SnapshotRestoreResult>,
  listSnapshots: (workspacePath: string) =>
    ipcRenderer.invoke(IpcChannels.listSnapshots, workspacePath) as Promise<SnapshotRecord[]>,
  getFileTree: (workspacePath: string) =>
    ipcRenderer.invoke(IpcChannels.getFileTree, workspacePath) as Promise<FileTreeResult>,
  listActiveLocks: (workspacePath?: string) =>
    ipcRenderer.invoke(IpcChannels.listActiveLocks, workspacePath) as Promise<FileLockState[]>,
  getRecentTaskEvents: (workspacePath: string, workSessionId?: string) =>
    ipcRenderer.invoke(IpcChannels.getRecentTaskEvents, workspacePath, workSessionId) as Promise<TaskEventEnvelope[]>,
  listSessions: () => ipcRenderer.invoke(IpcChannels.listSessions) as Promise<WorkSession[]>,
  createSession: (title?: string) => ipcRenderer.invoke(IpcChannels.createSession, title) as Promise<WorkSession>,
  getSessionAgentInsight: (sessionId: string, eventSourcePath?: string) =>
    ipcRenderer.invoke(IpcChannels.getSessionAgentInsight, sessionId, eventSourcePath) as Promise<SessionAgentInsight>,
  updateSession: (input: {
    id: string;
    title?: string;
    status?: WorkSession["status"];
    lastMessagePreview?: string;
    workspacePath?: string;
    workspaceStatus?: WorkSession["workspaceStatus"];
  }) => ipcRenderer.invoke(IpcChannels.updateSession, input) as Promise<WorkSession>,
  archiveSession: (id: string) => ipcRenderer.invoke(IpcChannels.archiveSession, id) as Promise<WorkSession>,
  deleteSession: (id: string) =>
    ipcRenderer.invoke(IpcChannels.deleteSession, id) as Promise<{ ok: boolean; message: string; deletedId: string }>,
  duplicateSession: (id: string) => ipcRenderer.invoke(IpcChannels.duplicateSession, id) as Promise<WorkSession>,
  exportSession: (input: { id: string; format: "json" | "markdown" }) =>
    ipcRenderer.invoke(IpcChannels.exportSession, input) as Promise<{ ok: boolean; path: string; message: string }>,
  importSession: () => ipcRenderer.invoke(IpcChannels.importSession) as Promise<WorkSession | undefined>,
  importCliSession: (filePath: string) => ipcRenderer.invoke(IpcChannels.importCliSession, filePath) as Promise<WorkSession>,
  clearSessionFiles: (id: string) =>
    ipcRenderer.invoke(IpcChannels.clearSessionFiles, id) as Promise<{ ok: boolean; message: string; session: WorkSession }>,
  openSessionFolder: (id: string) => ipcRenderer.invoke(IpcChannels.openSessionFolder, id) as Promise<{ ok: boolean; message: string }>,
  getWebUiOverview: () => ipcRenderer.invoke(IpcChannels.getWebUiOverview) as Promise<HermesWebUiOverview>,
  getWebUiSettings: () => ipcRenderer.invoke(IpcChannels.getWebUiSettings) as Promise<HermesWebUiSettings>,
  saveWebUiSettings: (input: Partial<HermesWebUiSettings>) =>
    ipcRenderer.invoke(IpcChannels.saveWebUiSettings, input) as Promise<HermesWebUiSettings>,
  listConnectors: () => ipcRenderer.invoke(IpcChannels.listConnectors) as Promise<HermesConnectorListResult>,
  saveConnector: (input: HermesConnectorSaveInput) =>
    ipcRenderer.invoke(IpcChannels.saveConnector, input) as Promise<HermesConnectorConfig>,
  disableConnector: (platformId: HermesConnectorPlatformId) =>
    ipcRenderer.invoke(IpcChannels.disableConnector, platformId) as Promise<HermesConnectorConfig>,
  syncConnectorsEnv: () =>
    ipcRenderer.invoke(IpcChannels.syncConnectorsEnv) as Promise<{ ok: boolean; envPath: string; message: string; connectors: HermesConnectorConfig[] }>,
  getGatewayStatus: () => ipcRenderer.invoke(IpcChannels.getGatewayStatus) as Promise<HermesGatewayStatus>,
  startGateway: () => ipcRenderer.invoke(IpcChannels.startGateway) as Promise<HermesGatewayActionResult>,
  stopGateway: () => ipcRenderer.invoke(IpcChannels.stopGateway) as Promise<HermesGatewayActionResult>,
  restartGateway: () => ipcRenderer.invoke(IpcChannels.restartGateway) as Promise<HermesGatewayActionResult>,
  startWeixinQrLogin: () => ipcRenderer.invoke(IpcChannels.startWeixinQrLogin) as Promise<WeixinQrLoginResult>,
  getWeixinQrLoginStatus: () => ipcRenderer.invoke(IpcChannels.getWeixinQrLoginStatus) as Promise<WeixinQrLoginStatus>,
  cancelWeixinQrLogin: () => ipcRenderer.invoke(IpcChannels.cancelWeixinQrLogin) as Promise<WeixinQrLoginResult>,
  installWeixinDependency: () =>
    ipcRenderer.invoke(IpcChannels.installWeixinDependency) as Promise<WeixinDependencyInstallResult>,
  listProjects: () => ipcRenderer.invoke(IpcChannels.listProjects) as Promise<ProjectGroup[]>,
  saveProject: (input: Partial<ProjectGroup>) => ipcRenderer.invoke(IpcChannels.saveProject, input) as Promise<ProjectGroup>,
  deleteProject: (id: string) => ipcRenderer.invoke(IpcChannels.deleteProject, id) as Promise<{ ok: boolean; id: string }>,
  listSpaces: () => ipcRenderer.invoke(IpcChannels.listSpaces) as Promise<WorkspaceSpace[]>,
  saveSpace: (input: Partial<WorkspaceSpace>) => ipcRenderer.invoke(IpcChannels.saveSpace, input) as Promise<WorkspaceSpace>,
  deleteSpace: (id: string) => ipcRenderer.invoke(IpcChannels.deleteSpace, id) as Promise<{ ok: boolean; id: string }>,
  listSkills: () => ipcRenderer.invoke(IpcChannels.listSkills) as Promise<HermesSkill[]>,
  readSkill: (id: string) => ipcRenderer.invoke(IpcChannels.readSkill, id) as Promise<{ id: string; path: string; content: string }>,
  saveSkill: (input: { id: string; content: string }) => ipcRenderer.invoke(IpcChannels.saveSkill, input) as Promise<{ id: string; path: string; content: string }>,
  deleteSkill: (id: string) => ipcRenderer.invoke(IpcChannels.deleteSkill, id) as Promise<{ ok: boolean; id: string }>,
  uploadSkill: () => ipcRenderer.invoke(IpcChannels.uploadSkill) as Promise<HermesSkill>,
  listMemoryFiles: () => ipcRenderer.invoke(IpcChannels.listMemoryFiles) as Promise<HermesMemoryFile[]>,
  saveMemoryFile: (input: { id: HermesMemoryFile["id"]; content: string }) =>
    ipcRenderer.invoke(IpcChannels.saveMemoryFile, input) as Promise<HermesMemoryFile | undefined>,
  importMemoryFile: (input: { sourcePath: string; targetId: HermesMemoryFile["id"] }) =>
    ipcRenderer.invoke(IpcChannels.importMemoryFile, input) as Promise<HermesMemoryFile | undefined>,
  listProfiles: () => ipcRenderer.invoke(IpcChannels.listProfiles) as Promise<HermesProfile[]>,
  switchProfile: (name: string) => ipcRenderer.invoke(IpcChannels.switchProfile, name) as Promise<{ ok: boolean; active: string; profiles: HermesProfile[] }>,
  createProfile: (name: string) => ipcRenderer.invoke(IpcChannels.createProfile, name) as Promise<HermesProfile | undefined>,
  deleteProfile: (name: string) => ipcRenderer.invoke(IpcChannels.deleteProfile, name) as Promise<{ ok: boolean; id: string; profiles: HermesProfile[] }>,
  listCronJobs: () => ipcRenderer.invoke(IpcChannels.listCronJobs) as Promise<HermesCronJob[]>,
  saveCronJob: (input: Partial<HermesCronJob>) => ipcRenderer.invoke(IpcChannels.saveCronJob, input) as Promise<HermesCronJob>,
  runCronJob: (id: string) => ipcRenderer.invoke(IpcChannels.runCronJob, id) as Promise<{ ok: boolean; message: string; exitCode: number | null }>,
  pauseCronJob: (id: string) => ipcRenderer.invoke(IpcChannels.pauseCronJob, id) as Promise<{ ok: boolean; message: string; exitCode: number | null }>,
  resumeCronJob: (id: string) => ipcRenderer.invoke(IpcChannels.resumeCronJob, id) as Promise<{ ok: boolean; message: string; exitCode: number | null }>,
  deleteCronJob: (id: string) => ipcRenderer.invoke(IpcChannels.deleteCronJob, id) as Promise<{ ok: boolean; message: string; exitCode: number | null }>,
  previewFile: (filePath: string) => ipcRenderer.invoke(IpcChannels.previewFile, filePath) as Promise<FilePreviewResult>,
  getFileBreadcrumb: (filePath: string) => ipcRenderer.invoke(IpcChannels.getFileBreadcrumb, filePath) as Promise<FileBreadcrumbItem[]>,
  getGitInfo: (workspacePath: string) =>
    ipcRenderer.invoke(IpcChannels.getGitInfo, workspacePath) as Promise<{ available: boolean; branch: string; dirtyCount: number; dirtyFiles?: string[] }>,
  respondApproval: (input: { id: string; choice: "once" | "session" | "always" | "deny"; editedCommand?: string }) =>
    ipcRenderer.invoke(IpcChannels.respondApproval, input) as Promise<{ ok: boolean; id: string; approved: boolean; message: string }>,
  getHermesStatus: (workspacePath?: string) =>
    ipcRenderer.invoke(IpcChannels.getHermesStatus, workspacePath) as Promise<HermesStatusSummary>,
  getHermesProbe: (workspacePath?: string) =>
    ipcRenderer.invoke(IpcChannels.getHermesProbe, workspacePath) as Promise<HermesProbeSummary>,
  warmHermes: () => ipcRenderer.invoke(IpcChannels.warmHermes) as Promise<EngineWarmupResult>,
  probeHermes: (workspacePath?: string) =>
    ipcRenderer.invoke(IpcChannels.probeHermes, workspacePath) as Promise<EngineWarmupResult>,
  checkUpdates: () => ipcRenderer.invoke(IpcChannels.checkUpdates) as Promise<EngineUpdateStatus[]>,
  checkClientUpdate: () => ipcRenderer.invoke(IpcChannels.checkClientUpdate) as Promise<ClientUpdateEvent>,
  onClientUpdateEvent: (callback: (event: ClientUpdateEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ClientUpdateEvent) => callback(payload);
    ipcRenderer.on(IpcChannels.clientUpdateEvent, wrapped);
    return () => ipcRenderer.removeListener(IpcChannels.clientUpdateEvent, wrapped);
  },
  updateHermes: () => ipcRenderer.invoke(IpcChannels.updateHermes) as Promise<EngineMaintenanceResult>,
  installHermes: (options?: { rootPath?: string }) => ipcRenderer.invoke(IpcChannels.installHermes, options) as Promise<HermesInstallResult>,
  repairSetupDependency: (id: SetupDependencyRepairId) =>
    ipcRenderer.invoke(IpcChannels.repairSetupDependency, id) as Promise<SetupDependencyRepairResult>,
  installerPlan: () =>
    ipcRenderer.invoke(IpcChannels.installerPlan) as Promise<ManagedWslInstallerIpcResult>,
  installerDryRunRepair: () =>
    ipcRenderer.invoke(IpcChannels.installerDryRunRepair) as Promise<ManagedWslInstallerIpcResult>,
  installerExecuteRepair: () =>
    ipcRenderer.invoke(IpcChannels.installerExecuteRepair) as Promise<ManagedWslInstallerIpcResult>,
  installerInstall: () =>
    ipcRenderer.invoke(IpcChannels.installerInstall) as Promise<ManagedWslInstallerIpcResult>,
  installerGetLastReport: () =>
    ipcRenderer.invoke(IpcChannels.installerGetLastReport) as Promise<ManagedWslInstallerIpcResult>,
  onInstallHermesEvent: (callback: (event: HermesInstallEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: HermesInstallEvent) => callback(payload);
    ipcRenderer.on(IpcChannels.installHermesEvent, wrapped);
    return () => ipcRenderer.removeListener(IpcChannels.installHermesEvent, wrapped);
  },
  getRuntimeConfig: () => ipcRenderer.invoke(IpcChannels.getRuntimeConfig) as Promise<RuntimeConfig>,
  getPermissionOverview: () => ipcRenderer.invoke(IpcChannels.getPermissionOverview) as Promise<PermissionOverview>,
  getConfigOverview: (workspacePath?: string) => ipcRenderer.invoke(IpcChannels.getConfigOverview, workspacePath) as Promise<any>,
  importExistingHermesConfig: () => ipcRenderer.invoke(IpcChannels.importExistingHermesConfig) as Promise<HermesExistingConfigImportResult>,
  testHermesWindowsBridge: () =>
    ipcRenderer.invoke(IpcChannels.testHermesWindowsBridge) as Promise<HermesWindowsBridgeTestResult>,
  testHermesSystemAudit: () =>
    ipcRenderer.invoke(IpcChannels.testHermesSystemAudit) as Promise<HermesSystemAuditResult>,
  updateHermesConfig: (input: unknown) => ipcRenderer.invoke(IpcChannels.updateHermesConfig, input) as Promise<RuntimeConfig>,
  updateModelConfig: (input: unknown) => ipcRenderer.invoke(IpcChannels.updateModelConfig, input) as Promise<RuntimeConfig>,
  setDefaultModel: (modelId: string) => ipcRenderer.invoke(IpcChannels.setDefaultModel, { modelId }) as Promise<{ success: boolean; code?: string; message?: string; defaultModelId?: string; models?: RuntimeConfig["modelProfiles"] }>,
  setModelRole: (input: { role: string; profileId: string }) => ipcRenderer.invoke(IpcChannels.setModelRole, input) as Promise<{ success: boolean; code?: string; message?: string; role?: string; profileId?: string; defaultModelId?: string; modelRoleAssignments?: RuntimeConfig["modelRoleAssignments"]; models?: RuntimeConfig["modelProfiles"] }>,
  listModelProviders: () => ipcRenderer.invoke(IpcChannels.listModelProviders) as Promise<unknown[]>,
  syncHermesModelRuntime: () => ipcRenderer.invoke(IpcChannels.syncHermesModelRuntime) as Promise<unknown>,
  testModelRuntimeRole: (role: string) => ipcRenderer.invoke(IpcChannels.testModelRuntimeRole, { role }) as Promise<unknown>,
  saveRuntimeConfig: (config: RuntimeConfig) =>
    ipcRenderer.invoke(IpcChannels.saveRuntimeConfig, config) as Promise<RuntimeConfig>,
  testModelConnection: (input?: string | Record<string, unknown>) =>
    ipcRenderer.invoke(IpcChannels.testModelConnection, input) as Promise<ModelConnectionTestResult>,
  discoverLocalModelSources: () =>
    ipcRenderer.invoke(IpcChannels.discoverLocalModelSources) as Promise<LocalModelDiscoveryResult>,
  getSetupSummary: (workspacePath?: string) =>
    ipcRenderer.invoke(IpcChannels.getSetupSummary, workspacePath) as Promise<SetupSummary>,
  getSecretStatus: () => ipcRenderer.invoke(IpcChannels.getSecretStatus) as Promise<SecretVaultStatus>,
  saveSecret: (input: SecretSaveInput) =>
    ipcRenderer.invoke(IpcChannels.saveSecret, input) as Promise<{ secretRef: string }>,
  deleteSecret: (ref: string) => ipcRenderer.invoke(IpcChannels.deleteSecret, ref) as Promise<{ ref: string; existed: boolean }>,
  hasSecret: (ref: string) => ipcRenderer.invoke(IpcChannels.hasSecret, ref) as Promise<SecretRefStatus>,
  exportDiagnostics: (workspacePath?: string) =>
    ipcRenderer.invoke(IpcChannels.exportDiagnostics, workspacePath) as Promise<DiagnosticExportResult>,
  runOneClickDiagnostics: (options?: OneClickDiagnosticsRunOptions) =>
    ipcRenderer.invoke(IpcChannels.oneClickDiagnosticsRun, options) as Promise<OneClickDiagnosticsReport>,
  exportOneClickDiagnostics: (workspacePath?: string) =>
    ipcRenderer.invoke(IpcChannels.oneClickDiagnosticsExport, workspacePath) as Promise<OneClickDiagnosticsExportResult>,
  getOneClickDiagnosticsStatus: () =>
    ipcRenderer.invoke(IpcChannels.oneClickDiagnosticsStatus) as Promise<OneClickDiagnosticsStatus>,
  onTaskEvent: (callback: (event: TaskEventEnvelope) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: TaskEventEnvelope) => callback(payload);
    ipcRenderer.on(IpcChannels.taskEvent, wrapped);
    return () => ipcRenderer.removeListener(IpcChannels.taskEvent, wrapped);
  },
  onHermesAgentCompatibilityWarning: (callback: (event: { compatible: boolean; message: string }) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { compatible: boolean; message: string }) => callback(payload);
    ipcRenderer.on(IpcChannels.hermesAgentCompatibilityWarning, wrapped);
    return () => ipcRenderer.removeListener(IpcChannels.hermesAgentCompatibilityWarning, wrapped);
  },
  exportMessage: (input: { content: string; suggestedName: string }) =>
    ipcRenderer.invoke(IpcChannels.exportMessage, input) as Promise<{ ok: boolean; path?: string; message?: string }>,
  writeClipboard: (text: string) => ipcRenderer.invoke(IpcChannels.writeClipboard, text) as Promise<{ ok: boolean }>,
};

contextBridge.exposeInMainWorld("workbenchClient", api);

export type WorkbenchClientApi = typeof api;
