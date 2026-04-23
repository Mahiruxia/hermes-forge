import type {
  ClientInfo,
  DiagnosticExportResult,
  EngineMaintenanceResult,
  EngineUpdateStatus,
  EngineWarmupResult,
  FileLockState,
  FileBreadcrumbItem,
  FilePreviewResult,
  FileTreeResult,
  HermesCronJob,
  HermesConnectorConfig,
  HermesConnectorListResult,
  HermesConnectorPlatformId,
  HermesConnectorSaveInput,
  HermesExistingConfigImportResult,
  HermesGatewayActionResult,
  HermesGatewayStatus,
  HermesInstallEvent,
  HermesInstallResult,
  HermesSystemAuditResult,
  ClientUpdateEvent,
  HermesWindowsBridgeTestResult,
  HermesMemoryFile,
  HermesProbeSummary,
  HermesProfile,
  HermesSkill,
  HermesStatusSummary,
  HermesWebUiOverview,
  HermesWebUiSettings,
  ModelConnectionTestResult,
  LocalModelDiscoveryResult,
  QuickTextFileInput,
  QuickTextFileResult,
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
  ProjectGroup,
  StartTaskInput,
  TaskEventEnvelope,
  TaskStartResult,
  WorkSession,
  WorkspaceSpace,
  WeixinQrLoginResult,
  WeixinQrLoginStatus,
  WeixinDependencyInstallResult,
  SponsorOverview,
  SponsorSubmitInput,
  SponsorSubmitResult,
} from "../shared/types";

declare global {
  type SpeechRecognitionConstructor = new () => SpeechRecognition;

  interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    maxAlternatives: number;
    onstart: ((event: Event) => void) | null;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
    onend: ((event: Event) => void) | null;
    start(): void;
    stop(): void;
  }

  interface SpeechRecognitionEvent extends Event {
    resultIndex: number;
    results: SpeechRecognitionResultList;
  }

  interface SpeechRecognitionErrorEvent extends Event {
    error: string;
  }

  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }

  interface File {
    path?: string;
  }

  interface Window {
    workbenchClient: {
      pickWorkspaceFolder(): Promise<string | null>;
      pickHermesInstallFolder(): Promise<string | null>;
      pickSessionAttachments(sessionFilesPath: string): Promise<SessionAttachment[]>;
      importSessionAttachments(sessionFilesPath: string, filePaths: string[]): Promise<SessionAttachment[]>;
      importClipboardImageAttachment(sessionFilesPath: string): Promise<SessionAttachment[]>;
      createQuickTextFile(input: QuickTextFileInput): Promise<QuickTextFileResult>;
      openPath(targetPath: string): Promise<{ ok: boolean; message: string }>;
      openHelp(): Promise<{ ok: boolean; message: string }>;
      restart(): Promise<{ ok: boolean }>;
      getClientInfo(): Promise<ClientInfo>;
      listSponsorEntries(): Promise<SponsorOverview>;
      submitSponsorEntry(input: SponsorSubmitInput): Promise<SponsorSubmitResult>;
      startTask(input: StartTaskInput): Promise<TaskStartResult>;
      cancelTask(sessionId: string): Promise<boolean>;
      restoreLatestSnapshot(workspacePath: string): Promise<SnapshotRestoreResult>;
      listSnapshots(workspacePath: string): Promise<SnapshotRecord[]>;
      getFileTree(workspacePath: string): Promise<FileTreeResult>;
      listActiveLocks(workspacePath?: string): Promise<FileLockState[]>;
      getRecentTaskEvents(workspacePath: string, workSessionId?: string): Promise<TaskEventEnvelope[]>;
      listSessions(): Promise<WorkSession[]>;
      createSession(title?: string): Promise<WorkSession>;
      getSessionAgentInsight(sessionId: string, eventSourcePath?: string): Promise<SessionAgentInsight>;
      updateSession(input: {
        id: string;
        title?: string;
        status?: WorkSession["status"];
        lastMessagePreview?: string;
        workspacePath?: string;
        workspaceStatus?: WorkSession["workspaceStatus"];
        pinned?: boolean;
        projectId?: string | null;
        tags?: string[];
      }): Promise<WorkSession>;
      archiveSession(id: string): Promise<WorkSession>;
      deleteSession(id: string): Promise<{ ok: boolean; message: string; deletedId: string }>;
      duplicateSession(id: string): Promise<WorkSession>;
      exportSession(input: { id: string; format: "json" | "markdown" }): Promise<{ ok: boolean; path: string; message: string }>;
      importSession(): Promise<WorkSession | undefined>;
      importCliSession(filePath: string): Promise<WorkSession>;
      clearSessionFiles(id: string): Promise<{ ok: boolean; message: string; session: WorkSession }>;
      openSessionFolder(id: string): Promise<{ ok: boolean; message: string }>;
      getWebUiOverview(): Promise<HermesWebUiOverview>;
      getWebUiSettings(): Promise<HermesWebUiSettings>;
      saveWebUiSettings(input: Partial<HermesWebUiSettings>): Promise<HermesWebUiSettings>;
      listConnectors(): Promise<HermesConnectorListResult>;
      saveConnector(input: HermesConnectorSaveInput): Promise<HermesConnectorConfig>;
      disableConnector(platformId: HermesConnectorPlatformId): Promise<HermesConnectorConfig>;
      syncConnectorsEnv(): Promise<{ ok: boolean; envPath: string; message: string; connectors: HermesConnectorConfig[] }>;
      getGatewayStatus(): Promise<HermesGatewayStatus>;
      startGateway(): Promise<HermesGatewayActionResult>;
      stopGateway(): Promise<HermesGatewayActionResult>;
      restartGateway(): Promise<HermesGatewayActionResult>;
      startWeixinQrLogin(): Promise<WeixinQrLoginResult>;
      getWeixinQrLoginStatus(): Promise<WeixinQrLoginStatus>;
      cancelWeixinQrLogin(): Promise<WeixinQrLoginResult>;
      installWeixinDependency(): Promise<WeixinDependencyInstallResult>;
      listProjects(): Promise<ProjectGroup[]>;
      saveProject(input: Partial<ProjectGroup>): Promise<ProjectGroup>;
      deleteProject(id: string): Promise<{ ok: boolean; id: string }>;
      listSpaces(): Promise<WorkspaceSpace[]>;
      saveSpace(input: Partial<WorkspaceSpace>): Promise<WorkspaceSpace>;
      deleteSpace(id: string): Promise<{ ok: boolean; id: string }>;
      listSkills(): Promise<HermesSkill[]>;
      readSkill(id: string): Promise<{ id: string; path: string; content: string }>;
      saveSkill(input: { id: string; content: string }): Promise<{ id: string; path: string; content: string }>;
      deleteSkill(id: string): Promise<{ ok: boolean; id: string }>;
      listMemoryFiles(): Promise<HermesMemoryFile[]>;
      saveMemoryFile(input: { id: HermesMemoryFile["id"]; content: string }): Promise<HermesMemoryFile | undefined>;
      importMemoryFile(input: { sourcePath: string; targetId: HermesMemoryFile["id"] }): Promise<HermesMemoryFile | undefined>;
      listProfiles(): Promise<HermesProfile[]>;
      switchProfile(name: string): Promise<{ ok: boolean; active: string; profiles: HermesProfile[] }>;
      createProfile(name: string): Promise<HermesProfile | undefined>;
      deleteProfile(name: string): Promise<{ ok: boolean; id: string; profiles: HermesProfile[] }>;
      listCronJobs(): Promise<HermesCronJob[]>;
      saveCronJob(input: Partial<HermesCronJob>): Promise<HermesCronJob>;
      runCronJob(id: string): Promise<{ ok: boolean; message: string; exitCode: number | null }>;
      pauseCronJob(id: string): Promise<{ ok: boolean; message: string; exitCode: number | null }>;
      resumeCronJob(id: string): Promise<{ ok: boolean; message: string; exitCode: number | null }>;
      deleteCronJob(id: string): Promise<{ ok: boolean; message: string; exitCode: number | null }>;
      previewFile(filePath: string): Promise<FilePreviewResult>;
      getFileBreadcrumb(filePath: string): Promise<FileBreadcrumbItem[]>;
      getGitInfo(workspacePath: string): Promise<{ available: boolean; branch: string; dirtyCount: number; dirtyFiles?: string[] }>;
      respondApproval(input: { id: string; choice: "once" | "session" | "always" | "deny"; editedCommand?: string }): Promise<{ ok: boolean; id: string; approved: boolean; message: string }>;
      getHermesStatus(workspacePath?: string): Promise<HermesStatusSummary>;
      getHermesProbe(workspacePath?: string): Promise<HermesProbeSummary>;
      warmHermes(): Promise<EngineWarmupResult>;
      probeHermes(workspacePath?: string): Promise<EngineWarmupResult>;
      checkUpdates(): Promise<EngineUpdateStatus[]>;
      checkClientUpdate(): Promise<ClientUpdateEvent>;
      onClientUpdateEvent(callback: (event: ClientUpdateEvent) => void): () => void;
      updateHermes(): Promise<EngineMaintenanceResult>;
      installHermes(options?: { rootPath?: string }): Promise<HermesInstallResult>;
      repairSetupDependency(id: SetupDependencyRepairId): Promise<SetupDependencyRepairResult>;
      onInstallHermesEvent(callback: (event: HermesInstallEvent) => void): () => void;
      getRuntimeConfig(): Promise<RuntimeConfig>;
      getConfigOverview(workspacePath?: string): Promise<any>;
      importExistingHermesConfig(): Promise<HermesExistingConfigImportResult>;
      testHermesWindowsBridge(): Promise<HermesWindowsBridgeTestResult>;
      testHermesSystemAudit(): Promise<HermesSystemAuditResult>;
      updateHermesConfig(input: unknown): Promise<RuntimeConfig>;
      updateModelConfig(input: unknown): Promise<RuntimeConfig>;
      saveRuntimeConfig(config: RuntimeConfig): Promise<RuntimeConfig>;
      testModelConnection(input?: string | Record<string, unknown>): Promise<ModelConnectionTestResult>;
      discoverLocalModelSources(): Promise<LocalModelDiscoveryResult>;
      getSetupSummary(workspacePath?: string): Promise<SetupSummary>;
      getSecretStatus(): Promise<SecretVaultStatus>;
      saveSecret(input: SecretSaveInput): Promise<{ secretRef: string }>;
      deleteSecret(ref: string): Promise<{ ref: string; existed: boolean }>;
      hasSecret(ref: string): Promise<SecretRefStatus>;
      exportDiagnostics(workspacePath?: string): Promise<DiagnosticExportResult>;
      onTaskEvent(callback: (event: TaskEventEnvelope) => void): () => void;
    };
  }
}

export {};
