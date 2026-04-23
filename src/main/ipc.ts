import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { z } from "zod";
import type { AppPaths } from "./app-paths";
import type { RuntimeConfigStore } from "./runtime-config";
import type { RuntimeEnvResolver } from "./runtime-env-resolver";
import type { SessionLog } from "./session-log";
import type { SessionAgentInsightService } from "./session-agent-insight-service";
import type { WorkSessionService } from "./work-session-service";
import type { HermesConnectorService } from "./hermes-connector-service";
import type { HermesModelSyncService } from "./hermes-model-sync";
import { syncHermesWindowsMcpConfig } from "./hermes-native-mcp-config";
import type { HermesWebUiService } from "./hermes-webui-service";
import type { HermesWindowsBridgeTestService } from "./hermes-windows-bridge-test-service";
import type { HermesSystemAuditService } from "./hermes-system-audit-service";
import type { WindowsControlBridge } from "./windows-control-bridge";
import type { ApprovalService } from "./approval-service";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { SecretVault } from "../auth/secret-vault";
import type { DiagnosticsService } from "../diagnostics/diagnostics-service";
import type { FileTreeService } from "../file-manager/file-tree-service";
import type { SnapshotManager } from "../process/snapshot-manager";
import type { TaskRunner } from "../process/task-runner";
import type { WorkspaceLock } from "../process/workspace-lock";
import type { EngineProbeService } from "../probes/engine-probe-service";
import type { SetupService } from "../setup/setup-service";
import type { ClientAutoUpdateService } from "../updater/client-auto-update-service";
import type { UpdateService } from "../updater/update-service";
import { importExistingHermesConfig } from "./hermes-existing-config-import";
import { IpcChannels } from "../shared/ipc";
import {
  runtimeConfigSchema,
  secretRefSchema,
  secretSaveInputSchema,
  sessionIdSchema,
  sessionUpdateSchema,
  startTaskInputSchema,
  workspacePathInputSchema,
} from "../shared/schemas";
import type {
  ClientInfo,
  HermesStatusSummary,
  LocalModelDiscoveryResult,
  ModelConnectionTestResult,
  ModelProfile,
  RuntimeConfig,
  SessionAttachment,
  SponsorEntry,
  SponsorOverview,
} from "../shared/types";
import { resolveEnginePermissions } from "../shared/types";
import { normalizeOpenAiCompatibleBaseUrl } from "../shared/model-config";

const quickTextFileInputSchema = z.object({
  fileName: z.string().trim().max(120).optional(),
  content: z.string().max(20000).optional(),
});
const attachmentSourcePathsSchema = z.array(workspacePathInputSchema).max(12);
const setupDependencyRepairIdSchema = z.enum(["git", "python", "hermes_pyyaml", "weixin_aiohttp"]);
const installHermesOptionsSchema = z.object({
  rootPath: z.string().trim().min(1).max(1000).optional(),
}).optional();
const sponsorSubmitInputSchema = z.object({
  supporterId: z.string().trim().min(1).max(48),
  message: z.string().trim().max(1000).optional(),
});
const DEFAULT_FEEDBACK_SYNC_ENDPOINT = "https://xiaoxiahome.icu/api/hermes-forge/feedback";
const DEFAULT_FEEDBACK_WALL_ENDPOINT = "https://xiaoxiahome.icu/api/hermes-forge/feedback/recent?kind=feedback&limit=50";

const connectorPlatformIdSchema = z.enum([
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "email",
  "matrix",
  "mattermost",
  "dingtalk",
  "feishu",
  "homeassistant",
  "wecom",
  "wecom_callback",
  "weixin",
  "bluebubbles",
  "sms",
  "qqbot",
]);

const connectorSaveInputSchema = z.object({
  platformId: connectorPlatformIdSchema,
  enabled: z.boolean().optional(),
  values: z.record(z.string(), z.union([z.string().max(20000), z.boolean(), z.undefined()])),
});

const modelConnectionDraftSchema = z.object({
  sourceType: z.enum(["local_openai", "openrouter", "openai", "custom_gateway", "legacy"]),
  profileId: z.string().max(120).optional(),
  provider: z.enum(["openai", "anthropic", "openrouter", "local", "custom"]).optional(),
  baseUrl: z.string().trim().max(2000).optional(),
  model: z.string().trim().max(200).optional(),
  secretRef: z.string().trim().max(200).optional(),
});

export type IpcServices = {
  appPaths: AppPaths;
  taskRunner: TaskRunner;
  snapshotManager: SnapshotManager;
  fileTreeService: FileTreeService;
  workspaceLock: WorkspaceLock;
  sessionLog: SessionLog;
  sessionAgentInsightService: SessionAgentInsightService;
  workSessionService: WorkSessionService;
  hermes: EngineAdapter;
  updateService: UpdateService;
  clientAutoUpdateService: ClientAutoUpdateService;
  engineProbeService: EngineProbeService;
  configStore: RuntimeConfigStore;
  runtimeEnvResolver: RuntimeEnvResolver;
  secretVault: SecretVault;
  setupService: SetupService;
  diagnosticsService: DiagnosticsService;
  hermesWebUiService: HermesWebUiService;
  hermesConnectorService: HermesConnectorService;
  hermesModelSyncService: HermesModelSyncService;
  windowsControlBridge: WindowsControlBridge;
  hermesWindowsBridgeTestService: HermesWindowsBridgeTestService;
  hermesSystemAuditService: HermesSystemAuditService;
  approvalService: ApprovalService;
  clientInfo: () => ClientInfo;
};

export function registerIpcHandlers(_mainWindow: BrowserWindow, services: IpcServices) {
  async function writeRuntimeConfigWithModelSync(nextConfig: RuntimeConfig, forceModelSync = false) {
    const previous = await services.configStore.read();
    const saved = await services.configStore.write(nextConfig);
    if (forceModelSync || modelRuntimeChanged(previous, saved)) {
      const sync = await services.hermesModelSyncService.syncRuntimeConfig(saved);
      if (sync.synced) {
        await restartGatewayIfRunning(services);
      }
    }
    await syncCurrentWindowsBridgeConfig(saved).catch((error) => {
      console.warn("[Hermes Forge] Failed to sync Windows bridge config:", error);
    });
    return saved;
  }

  async function syncCurrentWindowsBridgeConfig(config: RuntimeConfig) {
    const runtime = {
      mode: config.hermesRuntime?.mode ?? "windows",
      distro: config.hermesRuntime?.distro?.trim() || undefined,
      pythonCommand: config.hermesRuntime?.pythonCommand?.trim() || "python3",
      windowsAgentMode: config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
    };
    const permissions = resolveEnginePermissions(config, "hermes");
    const shouldEnable = permissions.enabled && permissions.contextBridge && runtime.windowsAgentMode !== "disabled";
    if (shouldEnable) {
      await services.windowsControlBridge.start();
    }
    const host = runtime.mode === "wsl" ? "127.0.0.1" : "127.0.0.1";
    return syncHermesWindowsMcpConfig({
      runtime,
      hermesHome: services.appPaths.hermesDir(),
      bridge: shouldEnable ? services.windowsControlBridge.accessForHost(host) : undefined,
    });
  }

  ipcMain.handle(IpcChannels.restartApp, () => {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.pickWorkspaceFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择工作目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IpcChannels.pickHermesInstallFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 Hermes 安装目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IpcChannels.pickSessionAttachments, async (_event, sessionFilesPath: string): Promise<SessionAttachment[]> => {
    const targetSessionPath = workspacePathInputSchema.parse(sessionFilesPath);
    const result = await dialog.showOpenDialog({
      title: "选择要交给 Hermes 的文件或图片",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "支持的图片和文件", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "txt", "md", "pdf", "doc", "docx", "xls", "xlsx", "csv", "json", "yaml", "yml", "ts", "tsx", "js", "jsx", "py", "html", "css"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return importSessionAttachments(targetSessionPath, result.filePaths);
  });

  ipcMain.handle(IpcChannels.importSessionAttachments, async (_event, sessionFilesPath: string, filePaths: string[]): Promise<SessionAttachment[]> => {
    const targetSessionPath = workspacePathInputSchema.parse(sessionFilesPath);
    const sourcePaths = attachmentSourcePathsSchema.parse(filePaths);
    return importSessionAttachments(targetSessionPath, sourcePaths);
  });
  ipcMain.handle(IpcChannels.importClipboardImageAttachment, async (_event, sessionFilesPath: string): Promise<SessionAttachment[]> => {
    const targetSessionPath = workspacePathInputSchema.parse(sessionFilesPath);
    return importClipboardImageAttachment(targetSessionPath);
  });

  ipcMain.handle(IpcChannels.createQuickTextFile, async (_event, input) => {
    const parsed = quickTextFileInputSchema.parse(input ?? {});
    const desktopPath = path.join(os.homedir(), "Desktop");
    await fs.mkdir(desktopPath, { recursive: true });
    const fileName = normalizeTextFileName(parsed.fileName);
    const targetPath = await uniqueFilePath(desktopPath, fileName);
    const content = parsed.content?.trim() || "这是由 Hermes 工作台快速创建的文本文件。";
    await fs.writeFile(targetPath, `${content}\n`, "utf8");
    return { ok: true, path: targetPath, message: `已在桌面创建 ${path.basename(targetPath)}。` };
  });

  ipcMain.handle(IpcChannels.getClientInfo, () => services.clientInfo());

  ipcMain.handle(IpcChannels.listSponsorEntries, () => readSponsorOverview(services.appPaths));

  ipcMain.handle(IpcChannels.submitSponsorEntry, async (_event, input: unknown) => {
    const parsed = sponsorSubmitInputSchema.parse(input ?? {});
    const overview = await readSponsorOverview(services.appPaths);
    const entry: SponsorEntry = {
      id: crypto.randomUUID(),
      supporterId: parsed.supporterId,
      message: parsed.message || "支持 Hermes Forge 继续打磨。",
      status: "self_reported",
      createdAt: new Date().toISOString(),
    };
    const next = await writeSponsorEntries(services.appPaths, [entry, ...overview.entries]);
    const sync = await syncHermesForgeFeedback(entry);
    return {
      ok: true,
      entry,
      message: sync.ok ? "已同步到小夏仪表盘，感谢支持和建议。" : `已保存到本机，远程同步失败：${sync.message}`,
      overview: next,
    };
  });

  ipcMain.handle(IpcChannels.openPath, async (_event, targetPath: string) => {
    const stat = await fs.stat(targetPath).catch(() => undefined);
    if (!stat) return { ok: false, message: `路径不存在：${targetPath}` };
    const error = await shell.openPath(targetPath);
    return { ok: !error, message: error || `已打开：${targetPath}` };
  });

  ipcMain.handle(IpcChannels.openHelp, async () => {
    const helpUrl = "https://github.com/Mahiruxia/hermes-forge#readme";
    await shell.openExternal(helpUrl);
    return { ok: true, message: `已打开 Hermes Forge 官网：${helpUrl}` };
  });

  ipcMain.handle(IpcChannels.startTask, (_event, input) => {
    const parsed = startTaskInputSchema.parse(input);
    console.info("[Hermes Trace]", {
      layer: "main:task:start",
      clientTaskId: parsed.clientTaskId,
      taskType: parsed.taskType,
      userInputLength: parsed.userInput.length,
      workspacePath: parsed.workspacePath,
      selectedFilesCount: parsed.selectedFiles.length,
    });
    return services.taskRunner.start(parsed);
  });

  ipcMain.handle(IpcChannels.cancelTask, (_event, sessionId: string) => services.taskRunner.cancel(sessionId));

  ipcMain.handle(IpcChannels.restoreLatestSnapshot, async (_event, workspacePath: string) => {
    const parsed = workspacePathInputSchema.parse(workspacePath);
    const workspaceId = services.appPaths.workspaceId(parsed);
    return services.snapshotManager.restoreLatest(workspaceId);
  });

  ipcMain.handle(IpcChannels.listSnapshots, async (_event, workspacePath: string) => {
    const parsed = workspacePathInputSchema.parse(workspacePath);
    const workspaceId = services.appPaths.workspaceId(parsed);
    return services.snapshotManager.listSnapshots(workspaceId);
  });

  ipcMain.handle(IpcChannels.getFileTree, async (_event, workspacePath: string) => {
    const parsed = workspacePathInputSchema.parse(workspacePath);
    return services.fileTreeService.getTree(parsed);
  });

  ipcMain.handle(IpcChannels.listActiveLocks, async (_event, workspacePath?: string) => {
    if (!workspacePath) return services.workspaceLock.listActive();
    const parsed = workspacePathInputSchema.parse(workspacePath);
    return services.workspaceLock.listActive(services.appPaths.workspaceId(parsed));
  });

  ipcMain.handle(IpcChannels.getRecentTaskEvents, async (_event, workspacePath: string, workSessionId?: string) => {
    const parsed = workspacePathInputSchema.parse(workspacePath);
    const parsedSessionId = workSessionId ? sessionIdSchema.parse(workSessionId) : undefined;
    const workspaceId = services.appPaths.workspaceId(parsed);
    return services.sessionLog.readRecent(workspaceId, 200, parsedSessionId);
  });

  ipcMain.handle(IpcChannels.listSessions, () => services.workSessionService.list());
  ipcMain.handle(IpcChannels.createSession, async (_event, title?: string) =>
    services.workSessionService.create(typeof title === "string" ? title : undefined),
  );
  ipcMain.handle(IpcChannels.getSessionAgentInsight, (_event, id: string, eventSourcePath?: string) =>
    services.sessionAgentInsightService.read(sessionIdSchema.parse(id), typeof eventSourcePath === "string" ? workspacePathInputSchema.parse(eventSourcePath) : undefined),
  );
  ipcMain.handle(IpcChannels.updateSession, async (_event, input) => {
    const parsed = sessionUpdateSchema.parse(input);
    return services.workSessionService.update(parsed.id, parsed);
  });
  ipcMain.handle(IpcChannels.archiveSession, async (_event, id: string) => services.workSessionService.archive(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.deleteSession, async (_event, id: string) => services.workSessionService.delete(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.duplicateSession, async (_event, id: string) => services.workSessionService.duplicate(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.exportSession, async (_event, input) => {
    const parsed = z.object({ id: sessionIdSchema, format: z.enum(["json", "markdown"]).default("json") }).parse(input);
    return services.workSessionService.export(parsed.id, parsed.format);
  });
  ipcMain.handle(IpcChannels.importSession, async () => {
    const result = await dialog.showOpenDialog({
      title: "导入 Hermes 工作台会话 JSON / JSONL / 目录",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Hermes Sessions", extensions: ["json", "jsonl"] }, { name: "All Files", extensions: ["*"] }],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return services.workSessionService.importFromFile(result.filePaths[0]);
  });
  ipcMain.handle(IpcChannels.importCliSession, async (_event, filePath: string) => services.workSessionService.importFromFile(workspacePathInputSchema.parse(filePath)));
  ipcMain.handle(IpcChannels.clearSessionFiles, async (_event, id: string) => services.workSessionService.clearSessionFiles(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.openSessionFolder, async (_event, id: string) => {
    const parsed = sessionIdSchema.parse(id);
    const session = await services.workSessionService.read(parsed);
    if (!session) return { ok: false, message: `会话不存在：${parsed}` };
    const error = await shell.openPath(session.sessionFilesPath);
    return { ok: !error, message: error || `已打开会话文件夹：${session.sessionFilesPath}` };
  });

  ipcMain.handle(IpcChannels.getWebUiOverview, () => services.hermesWebUiService.overview());
  ipcMain.handle(IpcChannels.getWebUiSettings, () => services.hermesWebUiService.getSettings());
  ipcMain.handle(IpcChannels.saveWebUiSettings, (_event, input) => services.hermesWebUiService.saveSettings(input ?? {}));
  ipcMain.handle(IpcChannels.listConnectors, () => services.hermesConnectorService.list());
  ipcMain.handle(IpcChannels.saveConnector, (_event, input) =>
    services.hermesConnectorService.save(connectorSaveInputSchema.parse(input ?? {})),
  );
  ipcMain.handle(IpcChannels.disableConnector, (_event, platformId: string) =>
    services.hermesConnectorService.disable(connectorPlatformIdSchema.parse(platformId)),
  );
  ipcMain.handle(IpcChannels.syncConnectorsEnv, () => services.hermesConnectorService.syncEnv());
  ipcMain.handle(IpcChannels.getGatewayStatus, () => services.hermesConnectorService.status());
  ipcMain.handle(IpcChannels.startGateway, () => services.hermesConnectorService.start());
  ipcMain.handle(IpcChannels.stopGateway, () => services.hermesConnectorService.stop());
  ipcMain.handle(IpcChannels.restartGateway, () => services.hermesConnectorService.restart());
  ipcMain.handle(IpcChannels.startWeixinQrLogin, () => services.hermesConnectorService.startWeixinQrLogin());
  ipcMain.handle(IpcChannels.getWeixinQrLoginStatus, () => services.hermesConnectorService.getWeixinQrStatus());
  ipcMain.handle(IpcChannels.cancelWeixinQrLogin, () => services.hermesConnectorService.cancelWeixinQrLogin());
  ipcMain.handle(IpcChannels.installWeixinDependency, () => services.hermesConnectorService.installWeixinDependency());
  ipcMain.handle(IpcChannels.listProjects, () => services.hermesWebUiService.listProjects());
  ipcMain.handle(IpcChannels.saveProject, (_event, input) => services.hermesWebUiService.saveProject(input ?? {}));
  ipcMain.handle(IpcChannels.deleteProject, (_event, id: string) => services.hermesWebUiService.deleteProject(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.listSpaces, () => services.hermesWebUiService.listSpaces());
  ipcMain.handle(IpcChannels.saveSpace, (_event, input) => services.hermesWebUiService.saveSpace(input ?? {}));
  ipcMain.handle(IpcChannels.deleteSpace, (_event, id: string) => services.hermesWebUiService.deleteSpace(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.listSkills, () => services.hermesWebUiService.listSkills());
  ipcMain.handle(IpcChannels.readSkill, (_event, id: string) => services.hermesWebUiService.readSkill(id));
  ipcMain.handle(IpcChannels.saveSkill, (_event, input) => {
    const parsed = z.object({ id: z.string().trim().min(1).max(300), content: z.string().max(200000) }).parse(input);
    return services.hermesWebUiService.saveSkill(parsed.id, parsed.content);
  });
  ipcMain.handle(IpcChannels.deleteSkill, (_event, id: string) => services.hermesWebUiService.deleteSkill(id));
  ipcMain.handle(IpcChannels.listMemoryFiles, () => services.hermesWebUiService.listMemoryFiles());
  ipcMain.handle(IpcChannels.saveMemoryFile, (_event, input) => {
    const parsed = z.object({ id: z.enum(["USER.md", "MEMORY.md"]), content: z.string().max(300000) }).parse(input);
    return services.hermesWebUiService.saveMemoryFile(parsed.id, parsed.content);
  });
  ipcMain.handle(IpcChannels.importMemoryFile, (_event, input) => {
    const parsed = z.object({ sourcePath: z.string(), targetId: z.enum(["USER.md", "MEMORY.md"]) }).parse(input);
    return services.hermesWebUiService.importMemoryFile(parsed.sourcePath, parsed.targetId);
  });
  ipcMain.handle(IpcChannels.listProfiles, () => services.hermesWebUiService.listProfiles());
  ipcMain.handle(IpcChannels.switchProfile, (_event, name: string) => services.hermesWebUiService.switchProfile(sessionIdSchema.parse(name)));
  ipcMain.handle(IpcChannels.createProfile, (_event, name: string) => services.hermesWebUiService.createProfile(sessionIdSchema.parse(name)));
  ipcMain.handle(IpcChannels.deleteProfile, (_event, name: string) => services.hermesWebUiService.deleteProfile(sessionIdSchema.parse(name)));
  ipcMain.handle(IpcChannels.listCronJobs, () => services.hermesWebUiService.listCronJobs());
  ipcMain.handle(IpcChannels.saveCronJob, (_event, input) => services.hermesWebUiService.saveCronJob(input ?? {}));
  ipcMain.handle(IpcChannels.runCronJob, (_event, id: string) => services.hermesWebUiService.runCronJob(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.pauseCronJob, (_event, id: string) => services.hermesWebUiService.pauseCronJob(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.resumeCronJob, (_event, id: string) => services.hermesWebUiService.resumeCronJob(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.deleteCronJob, (_event, id: string) => services.hermesWebUiService.deleteCronJob(sessionIdSchema.parse(id)));
  ipcMain.handle(IpcChannels.previewFile, (_event, filePath: string) => services.hermesWebUiService.previewFile(workspacePathInputSchema.parse(filePath)));
  ipcMain.handle(IpcChannels.getFileBreadcrumb, (_event, filePath: string) => services.hermesWebUiService.fileBreadcrumb(workspacePathInputSchema.parse(filePath)));
  ipcMain.handle(IpcChannels.getGitInfo, (_event, workspacePath: string) => services.hermesWebUiService.gitInfo(workspacePathInputSchema.parse(workspacePath)));
  ipcMain.handle(IpcChannels.respondApproval, (_event, input) => {
    const parsed = z.object({
      id: z.string().trim().min(1).max(160),
      choice: z.enum(["once", "session", "always", "deny"]),
      editedCommand: z.string().trim().max(4000).optional(),
    }).parse(input ?? {});
    return services.approvalService.respond(parsed);
  });

  ipcMain.handle(IpcChannels.getHermesStatus, async (_event, workspacePath?: string): Promise<HermesStatusSummary> => {
    const config = await services.configStore.read();
    const workspaceId = workspacePath
      ? await services.appPaths.ensureWorkspaceLayout(workspacePath)
      : services.appPaths.workspaceId(process.cwd());
    const [engine, memory, updates] = await Promise.all([
      services.hermes.healthCheck(),
      services.hermes.getMemoryStatus(workspaceId),
      services.updateService.checkAll(config),
    ]);
    return { engine, memory, update: updates.find((item) => item.engineId === "hermes") ?? updates[0] };
  });

  ipcMain.handle(IpcChannels.getHermesProbe, (_event, workspacePath?: string) =>
    services.engineProbeService.probeHermes(workspacePath),
  );

  ipcMain.handle(IpcChannels.warmHermes, async () => {
    if (!services.hermes.warmup) return { ok: false, message: "Hermes 当前没有可用的预热动作。", probeKind: "cheap" };
    return services.hermes.warmup("cheap");
  });

  ipcMain.handle(IpcChannels.probeHermes, async (_event, workspacePath?: string) => {
    if (!services.hermes.warmup) return { ok: false, message: "Hermes 当前没有可用的深度探针。", probeKind: "real", diagnosticCategory: "unknown" };
    const config = await services.configStore.read();
    const runtimeEnv = await services.runtimeEnvResolver.resolve(config.defaultModelProfileId);
    return services.hermes.warmup("real", workspacePath, runtimeEnv);
  });

  ipcMain.handle(IpcChannels.checkUpdates, async () => {
    const config = await services.configStore.read();
    return services.updateService.checkAll(config);
  });

  ipcMain.handle(IpcChannels.checkClientUpdate, () => services.clientAutoUpdateService.checkForUpdates(true));

  ipcMain.handle(IpcChannels.updateHermes, () => services.setupService.updateHermes());
  ipcMain.handle(IpcChannels.installHermes, (event, input?: unknown) =>
    services.setupService.installHermes((payload) => {
      event.sender.send(IpcChannels.installHermesEvent, payload);
    }, installHermesOptionsSchema.parse(input ?? undefined)),
  );
  ipcMain.handle(IpcChannels.repairSetupDependency, (_event, id: unknown) =>
    services.setupService.repairDependency(setupDependencyRepairIdSchema.parse(id)),
  );
  ipcMain.handle(IpcChannels.getRuntimeConfig, () => services.configStore.read());
  ipcMain.handle(IpcChannels.importExistingHermesConfig, () =>
    importExistingHermesConfig({
      configStore: services.configStore,
      secretVault: services.secretVault,
      hermesConnectorService: services.hermesConnectorService,
    }),
  );
  ipcMain.handle(IpcChannels.testHermesWindowsBridge, () => services.hermesWindowsBridgeTestService.test());
  ipcMain.handle(IpcChannels.testHermesSystemAudit, () => services.hermesSystemAuditService.test());
  ipcMain.handle(IpcChannels.getConfigOverview, async (_event, workspacePath?: string) => {
    const runtimeConfig = await services.configStore.read();
    await syncCurrentWindowsBridgeConfig(runtimeConfig).catch((error) => {
      console.warn("[Hermes Forge] Failed to refresh Windows bridge config for overview:", error);
    });
    const secretRefs = new Set<string>();
    for (const profile of runtimeConfig.modelProfiles) {
      if (profile.secretRef) secretRefs.add(profile.secretRef);
    }
    for (const provider of runtimeConfig.providerProfiles ?? []) {
      if (provider.apiKeySecretRef) secretRefs.add(provider.apiKeySecretRef);
    }
    const secrets = await Promise.all([...secretRefs].map(async (ref) => ({
      ref,
      exists: await services.secretVault.hasSecret(ref),
      ...(await services.secretVault.getSecretMeta(ref) ?? {}),
    })));
    const hermesPath = await services.configStore.getEnginePath("hermes");
    const health = await services.setupService.getSummary(workspacePath);
    const modelSummary = summarizeModelSource(runtimeConfig);
    return {
      runtimeConfig,
      hermes: {
        rootPath: hermesPath,
        warmupMode: runtimeConfig.startupWarmupMode ?? "cheap",
        runtime: runtimeConfig.hermesRuntime ?? { mode: "windows", pythonCommand: "python3" },
        bridge: services.windowsControlBridge.status(),
        permissions: {
          enabled: runtimeConfig.enginePermissions?.hermes?.enabled ?? true,
          workspaceRead: runtimeConfig.enginePermissions?.hermes?.workspaceRead ?? true,
          fileWrite: runtimeConfig.enginePermissions?.hermes?.fileWrite ?? true,
          commandRun: runtimeConfig.enginePermissions?.hermes?.commandRun ?? true,
          memoryRead: runtimeConfig.enginePermissions?.hermes?.memoryRead ?? true,
          contextBridge: runtimeConfig.enginePermissions?.hermes?.contextBridge ?? true,
        },
      },
      models: {
        defaultProfileId: runtimeConfig.defaultModelProfileId,
        providerProfiles: runtimeConfig.providerProfiles ?? [],
        modelProfiles: runtimeConfig.modelProfiles,
        summary: modelSummary,
      },
      secrets,
      health,
    };
  });
  ipcMain.handle(IpcChannels.updateHermesConfig, async (_event, input) => {
    const parsed = z.object({
      rootPath: z.string().trim().max(1000).optional(),
      warmupMode: z.enum(["off", "cheap", "real_probe"]).optional(),
      permissions: z.object({
        enabled: z.boolean().optional(),
        workspaceRead: z.boolean().optional(),
        fileWrite: z.boolean().optional(),
        commandRun: z.boolean().optional(),
        memoryRead: z.boolean().optional(),
        contextBridge: z.boolean().optional(),
      }).optional(),
      runtime: z.object({
        mode: z.enum(["windows", "wsl"]).optional(),
        distro: z.string().trim().max(120).optional(),
        pythonCommand: z.string().trim().min(1).max(120).optional(),
        windowsAgentMode: z.enum(["hermes_native", "host_tool_loop", "disabled"]).optional(),
      }).optional(),
    }).parse(input);
    const config = await services.configStore.read();
    return services.configStore.write({
      ...config,
      startupWarmupMode: parsed.warmupMode ?? config.startupWarmupMode,
      enginePaths: {
        ...(config.enginePaths ?? {}),
        ...(parsed.rootPath ? { hermes: parsed.rootPath } : {}),
      },
      enginePermissions: {
        ...(config.enginePermissions ?? {}),
        hermes: {
          ...(config.enginePermissions?.hermes ?? {}),
          ...(parsed.permissions ?? {}),
        },
      },
      hermesRuntime: {
        ...(config.hermesRuntime ?? { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" }),
        ...(parsed.runtime ?? {}),
        pythonCommand: parsed.runtime?.pythonCommand?.trim() || config.hermesRuntime?.pythonCommand || "python3",
        distro: parsed.runtime?.distro?.trim() || undefined,
        windowsAgentMode: parsed.runtime?.windowsAgentMode ?? config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
      },
    });
  });
  ipcMain.handle(IpcChannels.updateModelConfig, async (_event, input) => {
    const parsed = z.object({
      defaultProfileId: z.string().max(120).optional(),
      modelProfiles: z.array(z.any()).optional(),
      providerProfiles: z.array(z.any()).optional(),
    }).parse(input);
    const config = await services.configStore.read();
    return writeRuntimeConfigWithModelSync({
      ...config,
      defaultModelProfileId: parsed.defaultProfileId ?? config.defaultModelProfileId,
      modelProfiles: parsed.modelProfiles ?? config.modelProfiles,
      providerProfiles: parsed.providerProfiles ?? config.providerProfiles,
    }, true);
  });
  ipcMain.handle(IpcChannels.saveRuntimeConfig, (_event, config) =>
    writeRuntimeConfigWithModelSync(runtimeConfigSchema.parse(config)),
  );
  ipcMain.handle(IpcChannels.discoverLocalModelSources, async (): Promise<LocalModelDiscoveryResult> => {
    return discoverLocalModelSources();
  });

  ipcMain.handle(IpcChannels.testModelConnection, async (_event, input?: string | Record<string, unknown>): Promise<ModelConnectionTestResult> => {
    const config = await services.configStore.read();
    const draft = typeof input === "string" || typeof input === "undefined" ? undefined : modelConnectionDraftSchema.parse(input);
    const profile = draft
      ? draftToModelProfile(draft)
      : config.modelProfiles.find((item) => item.id === input) ??
        config.modelProfiles.find((item) => item.id === config.defaultModelProfileId) ??
        config.modelProfiles[0];

    if (!profile) return { ok: false, message: "尚未配置模型。请先选择来源并完成测试。" };
    if (!profile.model.trim()) {
      return {
        ok: false,
        profileId: profile.id,
        sourceType: sourceTypeFromProfile(profile),
        message: "模型名还没填，请先选择或输入模型。",
        failureCategory: "model_not_found",
        recommendedFix: "先完成模型名填写，再点击测试连接。",
      };
    }
    return validateModelProfile(profile, services.secretVault);
  });

  ipcMain.handle(IpcChannels.getSetupSummary, (_event, workspacePath?: string) => services.setupService.getSummary(workspacePath));
  ipcMain.handle(IpcChannels.getSecretStatus, () => services.secretVault.status());
  ipcMain.handle(IpcChannels.saveSecret, (_event, input) => {
    const parsed = secretSaveInputSchema.parse(input);
    return services.secretVault.saveSecret(parsed.ref, parsed.plainText);
  });
  ipcMain.handle(IpcChannels.deleteSecret, (_event, ref: string) => services.secretVault.deleteSecret(secretRefSchema.parse(ref)));
  ipcMain.handle(IpcChannels.hasSecret, async (_event, ref: string) => {
    const parsed = secretRefSchema.parse(ref);
    return { ref: parsed, exists: await services.secretVault.hasSecret(parsed) };
  });
  ipcMain.handle(IpcChannels.exportDiagnostics, (_event, workspacePath?: string) => services.diagnosticsService.export(workspacePath));
}

async function readSponsorOverview(appPaths: AppPaths): Promise<SponsorOverview> {
  const entries = await fetchRemoteFeedbackWall().catch(() => undefined) ?? await readSponsorEntries(appPaths);
  return {
    entries,
    totalCount: entries.length,
    updatedAt: entries[0]?.createdAt,
  };
}

async function fetchRemoteFeedbackWall(): Promise<SponsorEntry[]> {
  const endpoint = process.env.HERMES_FORGE_FEEDBACK_WALL_ENDPOINT?.trim()
    || process.env.SUPPORT_FEEDBACK_WALL_ENDPOINT?.trim()
    || DEFAULT_FEEDBACK_WALL_ENDPOINT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) throw new Error("Invalid feedback wall payload");
    return payload
      .filter((item) => {
        if (!item || typeof item !== "object") return false;
        const record = item as Record<string, unknown>;
        return record.public !== false && record.status !== "hidden";
      })
      .map((item) => normalizeSponsorEntry(item))
      .filter((item): item is SponsorEntry => Boolean(item))
      .slice(0, 50);
  } finally {
    clearTimeout(timer);
  }
}

async function readSponsorEntries(appPaths: AppPaths): Promise<SponsorEntry[]> {
  const raw = await fs.readFile(sponsorEntriesPath(appPaths), "utf8").catch(() => "");
  if (!raw.trim()) return defaultSponsorEntries();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return defaultSponsorEntries();
    return parsed
      .map((item) => normalizeSponsorEntry(item))
      .filter((item): item is SponsorEntry => Boolean(item))
      .slice(0, 200);
  } catch {
    return defaultSponsorEntries();
  }
}

async function writeSponsorEntries(appPaths: AppPaths, entries: SponsorEntry[]): Promise<SponsorOverview> {
  const safeEntries = entries.slice(0, 200);
  await fs.mkdir(path.dirname(sponsorEntriesPath(appPaths)), { recursive: true });
  await fs.writeFile(sponsorEntriesPath(appPaths), JSON.stringify(safeEntries, null, 2), "utf8");
  return {
    entries: safeEntries,
    totalCount: safeEntries.length,
    updatedAt: safeEntries[0]?.createdAt,
  };
}

function sponsorEntriesPath(appPaths: AppPaths) {
  return path.join(appPaths.baseDir(), "support", "sponsors.json");
}

function normalizeSponsorEntry(value: unknown): SponsorEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const supporterId = typeof record.supporterId === "string" ? record.supporterId.trim().slice(0, 48) : "";
  if (!supporterId) return undefined;
  return {
    id: typeof record.id === "string" && record.id ? record.id : crypto.randomUUID(),
    supporterId,
    message: typeof record.message === "string" && record.message.trim()
      ? record.message.trim().slice(0, 1000)
      : "支持 Hermes Forge 继续打磨。",
    reply: typeof record.reply === "string" ? record.reply.trim().slice(0, 1000) : undefined,
    status: normalizeSponsorStatus(record.status),
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : new Date().toISOString(),
  };
}

function normalizeSponsorStatus(status: unknown): SponsorEntry["status"] {
  if (
    status === "verified"
    || status === "new"
    || status === "read"
    || status === "planned"
    || status === "done"
    || status === "hidden"
  ) {
    return status;
  }
  return "self_reported";
}

function defaultSponsorEntries(): SponsorEntry[] {
  return [
    {
      id: "seed-xia",
      supporterId: "小夏",
      message: "把 Hermes Forge 打磨成真正好用的本地 Agent 工作台。",
      status: "verified",
      createdAt: "2026-04-22T00:00:00.000Z",
    },
  ];
}

async function syncHermesForgeFeedback(entry: SponsorEntry): Promise<{ ok: boolean; message: string }> {
  const endpoint = process.env.HERMES_FORGE_FEEDBACK_ENDPOINT?.trim()
    || process.env.SUPPORT_FEEDBACK_ENDPOINT?.trim()
    || DEFAULT_FEEDBACK_SYNC_ENDPOINT;
  if (!endpoint) return { ok: false, message: "未配置同步接口" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supporterId: entry.supporterId,
        message: entry.message,
        appVersion: app.getVersion(),
        platform: `${process.platform}/${process.arch}`,
        source: "hermes-forge-desktop",
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => undefined) as { message?: string } | undefined;
    if (!response.ok) {
      return { ok: false, message: payload?.message ?? `HTTP ${response.status}` };
    }
    return { ok: true, message: payload?.message ?? "反馈已同步" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "未知错误" };
  } finally {
    clearTimeout(timer);
  }
}

async function restartGatewayIfRunning(services: IpcServices) {
  const status = await services.hermesConnectorService.status().catch(() => undefined);
  if (!status?.running) {
    return;
  }
  const restart = await services.hermesConnectorService.restart();
  if (!restart.ok) {
    throw new Error(`模型已同步，但 Gateway 重启失败：${restart.message}`);
  }
}

function modelRuntimeChanged(previous: RuntimeConfig, next: RuntimeConfig) {
  return JSON.stringify(modelRuntimeSnapshot(previous)) !== JSON.stringify(modelRuntimeSnapshot(next));
}

function modelRuntimeSnapshot(config: RuntimeConfig) {
  return {
    defaultModelProfileId: config.defaultModelProfileId,
    modelProfiles: config.modelProfiles,
    providerProfiles: config.providerProfiles,
  };
}

async function testOpenAiCompatibleModel(
  profileId: string,
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  sourceType: ModelConnectionTestResult["sourceType"],
): Promise<ModelConnectionTestResult> {
  const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : { authorization: "Bearer lm-studio" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return buildHttpFailure(profileId, sourceType, baseUrl, response.status, response.statusText);
    }
    const payload = await response.json().catch(() => undefined) as { data?: Array<{ id?: string }> } | undefined;
    const availableModels = payload?.data?.map((item) => item.id).filter((item): item is string => Boolean(item)) ?? [];
    const hasModel = availableModels.length === 0 || availableModels.includes(model);
    if (!hasModel) {
      return {
        ok: false,
        profileId,
        sourceType,
        normalizedBaseUrl: baseUrl,
        availableModels,
        failureCategory: "model_not_found",
        recommendedFix: "请从可用模型列表里重新选择，或确认服务端是否已经加载了目标模型。",
        message: `已经连上模型服务，但没有找到模型“${model}”。${availableModels.length > 0 ? `可用模型有：${availableModels.slice(0, 8).join("、")}` : "服务端这次没有返回模型列表。"}`
      };
    }
    return {
      ok: true,
      profileId,
      sourceType,
      normalizedBaseUrl: baseUrl,
      availableModels,
      message: `连接成功，当前来源可用，模型“${model}”已通过测试。`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "未知错误";
    const failureCategory = errorMessage.includes("Invalid URL") ? "invalid_url" : "network_unreachable";
    return {
      ok: false,
      profileId,
      sourceType,
      normalizedBaseUrl: baseUrl,
      failureCategory,
      recommendedFix:
        failureCategory === "invalid_url"
          ? "请检查 Base URL 格式，建议填写到 /v1，例如 http://127.0.0.1:1234/v1。"
          : "请确认服务已经启动，而且 Base URL 指向实际监听端口和 /v1 接口。",
      message:
        failureCategory === "invalid_url"
          ? `地址格式不对，当前无法测试：${baseUrl}`
          : `连不上模型服务 ${modelsUrl}。请确认服务已经启动，地址和端口也填对了。`,
    };
  }
}

async function validateModelProfile(profile: ModelProfile, secretVault: SecretVault): Promise<ModelConnectionTestResult> {
  const sourceType = sourceTypeFromProfile(profile);
  if (profile.provider === "local") {
    return {
      ok: true,
      profileId: profile.id,
      sourceType,
      message: `当前使用本地占位模型 ${profile.model}。如果要接真实接口，建议改用本地 OpenAI 兼容来源。`,
    };
  }
  if (profile.provider === "custom") {
    if (!profile.baseUrl?.trim()) {
      return {
        ok: false,
        profileId: profile.id,
        sourceType,
        failureCategory: "invalid_url",
        recommendedFix: "请先填写 Base URL，例如 http://127.0.0.1:1234/v1。",
        message: "还没有填写模型服务地址。",
      };
    }
    let normalizedBaseUrl: string;
    try {
      normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(profile.baseUrl) ?? "";
    } catch {
      return {
        ok: false,
        profileId: profile.id,
        sourceType,
        failureCategory: "invalid_url",
        recommendedFix: "请检查地址格式，建议填写到 /v1。",
        message: "模型服务地址格式不正确。",
      };
    }
    if (profile.secretRef && !(await secretVault.hasSecret(profile.secretRef))) {
      return {
        ok: false,
        profileId: profile.id,
        sourceType,
        failureCategory: "auth_missing",
        recommendedFix: "请先保存 API Key，或者清空这个可选密钥引用后再测试。",
        message: "配置里引用了 API Key，但这个密钥现在并不存在。",
      };
    }
    const secret = profile.secretRef ? await secretVault.readSecret(profile.secretRef) : undefined;
    return testOpenAiCompatibleModel(profile.id, normalizedBaseUrl, profile.model, secret, sourceType);
  }

  if (!profile.secretRef) {
    return {
      ok: false,
      profileId: profile.id,
      sourceType,
      failureCategory: "auth_missing",
      recommendedFix: "请先保存 API Key，再回来测试连接。",
      message: "这个来源需要 API Key，但当前还没有配置。",
    };
  }
  if (!(await secretVault.hasSecret(profile.secretRef))) {
    return {
      ok: false,
      profileId: profile.id,
      sourceType,
      failureCategory: "auth_missing",
      recommendedFix: "请重新保存对应 API Key，然后再次测试。",
      message: "API Key 引用存在，但密钥内容已经失效或还没保存。",
    };
  }
  const apiKey = await secretVault.readSecret(profile.secretRef);
  const baseUrl = normalizeProviderBaseUrl(profile.provider, profile.baseUrl);
  return testOpenAiCompatibleModel(profile.id, baseUrl, profile.model, apiKey, sourceType);
}

function normalizeProviderBaseUrl(provider: ModelProfile["provider"], baseUrl?: string) {
  if (baseUrl?.trim()) return normalizeOpenAiCompatibleBaseUrl(baseUrl) ?? baseUrl;
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "anthropic") return "https://api.anthropic.com/v1";
  return "http://127.0.0.1:1234/v1";
}

function sourceTypeFromProfile(profile: Pick<ModelProfile, "provider" | "baseUrl">): ModelConnectionTestResult["sourceType"] {
  if (profile.provider === "custom") {
    const baseUrl = profile.baseUrl?.toLowerCase() ?? "";
    return baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost") ? "local_openai" : "custom_gateway";
  }
  if (profile.provider === "openrouter") return "openrouter";
  if (profile.provider === "openai") return "openai";
  return "legacy";
}

function draftToModelProfile(draft: z.infer<typeof modelConnectionDraftSchema>): ModelProfile {
  const provider =
    draft.sourceType === "local_openai" || draft.sourceType === "custom_gateway"
      ? "custom"
      : draft.sourceType === "openrouter"
        ? "openrouter"
        : draft.sourceType === "openai"
          ? "openai"
          : draft.provider ?? "custom";
  return {
    id: draft.profileId ?? `draft-${draft.sourceType}`,
    provider,
    model: draft.model?.trim() ?? "",
    baseUrl: draft.baseUrl?.trim(),
    secretRef: draft.secretRef?.trim(),
  };
}

async function discoverLocalModelSources(): Promise<LocalModelDiscoveryResult> {
  const candidates = ["http://127.0.0.1:1234/v1", "http://127.0.0.1:8080/v1", "http://127.0.0.1:8081/v1"];
  const results = await Promise.all(
    candidates.map(async (baseUrl) => {
      const test = await testOpenAiCompatibleModel("discovery", baseUrl, "__discovery__", undefined, "local_openai");
      return {
        baseUrl,
        ok: test.ok || test.failureCategory === "model_not_found",
        availableModels: test.availableModels ?? [],
        message: test.message,
        failureCategory: test.failureCategory,
      };
    }),
  );
  const firstOk = results.find((item) => item.ok);
  return {
    ok: Boolean(firstOk),
    candidates: results,
    recommendedBaseUrl: firstOk?.baseUrl,
    recommendedModel: firstOk?.availableModels[0],
    message: firstOk ? `已发现可用本地模型接口：${firstOk.baseUrl}` : "没有发现可直接使用的本地模型接口，请手动填写地址。",
  };
}

function summarizeModelSource(config: { defaultModelProfileId?: string; modelProfiles: ModelProfile[] }) {
  const profile = config.modelProfiles.find((item) => item.id === config.defaultModelProfileId) ?? config.modelProfiles[0];
  if (!profile) {
    return {
      sourceType: undefined,
      currentModel: undefined,
      baseUrl: undefined,
      secretStatus: "missing",
      message: "还没有默认模型来源，请先选择一个来源并完成测试。",
      recommendedFix: "进入模型向导，先选来源，再测试并保存。",
    };
  }
  return {
    sourceType: sourceTypeFromProfile(profile),
    currentModel: profile.model,
    baseUrl: profile.baseUrl ? normalizeProviderBaseUrl(profile.provider, profile.baseUrl) : normalizeProviderBaseUrl(profile.provider),
    secretStatus: profile.secretRef ? "configured" : profile.provider === "custom" ? "optional" : "missing",
    message: `当前默认来源是 ${profile.provider}，模型是 ${profile.model}。`,
    recommendedFix: profile.provider === "custom" ? "建议先做一次连接测试，确认地址和模型名都正确。" : "如果最近连不上，请先检查 API Key 和来源选择。",
  };
}

function buildHttpFailure(
  profileId: string,
  sourceType: ModelConnectionTestResult["sourceType"],
  baseUrl: string,
  status: number,
  statusText?: string,
): ModelConnectionTestResult {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      profileId,
      sourceType,
      normalizedBaseUrl: baseUrl,
      failureCategory: "auth_invalid",
      recommendedFix: "API Key 可能无效，或者当前来源不接受这个密钥。请重新保存后再试。",
      message: `已经连到服务，但鉴权失败了（HTTP ${status}${statusText ? ` ${statusText}` : ""}）。`,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      profileId,
      sourceType,
      normalizedBaseUrl: baseUrl,
      failureCategory: "path_invalid",
      recommendedFix: "请确认地址是否指向兼容 OpenAI 的 /v1 接口。",
      message: `已经连到服务器，但接口路径不对（HTTP 404）。请检查 Base URL：${baseUrl}`,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      profileId,
      sourceType,
      normalizedBaseUrl: baseUrl,
      failureCategory: "server_error",
      recommendedFix: "服务端当前异常，建议先确认模型服务是否已经完整启动。",
      message: `模型服务返回了服务器错误（HTTP ${status}）。`,
    };
  }
  return {
    ok: false,
    profileId,
    sourceType,
    normalizedBaseUrl: baseUrl,
    failureCategory: "unknown",
    recommendedFix: "请重新检查来源配置，确认地址、模型名和鉴权方式都正确。",
    message: `模型服务返回 HTTP ${status}${statusText ? ` ${statusText}` : ""}。`,
  };
}

function normalizeTextFileName(fileName?: string) {
  const safeName = (fileName || "output")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "output";
  return /\.txt$/i.test(safeName) ? safeName : `${safeName}.txt`;
}

function sanitizeAttachmentName(fileName: string) {
  return fileName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "attachment";
}

async function importSessionAttachments(targetSessionPath: string, sourcePaths: string[]) {
  const attachmentsDir = path.join(targetSessionPath, "attachments");
  await fs.mkdir(attachmentsDir, { recursive: true });
  const attachments: SessionAttachment[] = [];
  for (const sourcePath of sourcePaths.slice(0, 12)) {
    const stat = await fs.stat(sourcePath).catch(() => undefined);
    if (!stat?.isFile()) continue;
    if (stat.size > 200 * 1024 * 1024) {
      throw new Error(`附件过大：${path.basename(sourcePath)}。单个文件上限为 200MB。`);
    }
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const safeName = sanitizeAttachmentName(path.basename(sourcePath));
    const targetPath = await uniqueFilePath(attachmentsDir, `${id}-${safeName}`);
    await fs.copyFile(sourcePath, targetPath);
    const mimeType = inferMimeType(targetPath);
    attachments.push({
      id,
      name: safeName,
      path: targetPath,
      originalPath: sourcePath,
      kind: mimeType.startsWith("image/") ? "image" : "file",
      mimeType,
      size: stat.size,
      createdAt: new Date().toISOString(),
    });
  }
  return attachments;
}

async function importClipboardImageAttachment(targetSessionPath: string) {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    throw new Error("剪贴板里没有可导入的图片。");
  }
  const png = image.toPNG();
  if (!png.byteLength) {
    throw new Error("无法从剪贴板读取图片数据。");
  }
  const attachmentsDir = path.join(targetSessionPath, "attachments");
  await fs.mkdir(attachmentsDir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const fileName = `${id}-clipboard.png`;
  const targetPath = await uniqueFilePath(attachmentsDir, fileName);
  await fs.writeFile(targetPath, png);
  const stat = await fs.stat(targetPath);
  return [{
    id,
    name: "clipboard.png",
    path: targetPath,
    originalPath: "clipboard://image",
    kind: "image" as const,
    mimeType: "image/png",
    size: stat.size,
    createdAt: new Date().toISOString(),
  }];
}

function inferMimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[ext] ?? "application/octet-stream";
}

async function uniqueFilePath(directory: string, fileName: string) {
  const parsed = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  for (let index = 1; await exists(candidate); index += 1) {
    candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext || ".txt"}`);
  }
  return candidate;
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
