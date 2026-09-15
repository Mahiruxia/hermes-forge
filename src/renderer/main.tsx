import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ActivityLog,
  EngineEvent,
  HermesInstallEvent,
  HermesPermissionPolicyMode,
  HermesRuntimeConfig,
  OneClickDiagnosticItem,
  OneClickDiagnosticsReport,
  HermesWindowsBridgeTestResult,
  HermesWebUiOverview,
  HermesWebUiSettings,
  RuntimeConfig,
  SecretVaultStatus,
  SessionMetaPatch,
  SetupCheck,
  SetupDependencyRepairId,
  SetupSummary,
  TaskRunStatus,
  TaskEventEnvelope,
  TaskType,
  WindowsAgentMode,
  WindowsBridgeStatus,
  WorkSession,
} from "../shared/types";
import type { WelcomeCompleteTarget } from "./dashboard/WelcomePage";
import { ToastContainer } from "./dashboard/ToastNotification";
import { PageLoader } from "./dashboard/LoadingIndicator";
import type { ConfigSectionId } from "./dashboard/components/settings/ConfigCenterLayout";
import type { ConfigOverview } from "./settings/SettingsView";
import { buildConversationHistory } from "./conversationHistory";
import { markPerf, markPerfEnd, markPerfStart } from "./perf";
import { targetSessionForTaskEvent } from "./session-routing";
import { applyNativeInteractionEvent } from "./native-interactions";
import { resolveRunningTaskState, runningSessionLabel } from "./sessionRunState";
import { useAppStore, type RecentWorkspace } from "./store";
import { resolveSelectedModelProfileId } from "./modelSelection";
import { safePromiseWithFallback } from "./utils/safePromise";
import { hasInlineLocalFilePath } from "../shared/local-file-paths";
import "./styles.css";

const DashboardView = lazy(() =>
  import("./dashboard/DashboardView").then((module) => ({ default: module.DashboardView }))
);
const SupportView = lazy(() =>
  import("./dashboard/SupportView").then((module) => ({ default: module.SupportView }))
);
const WelcomePage = lazy(() =>
  import("./dashboard/WelcomePage").then((module) => ({ default: module.WelcomePage }))
);
const SettingsView = lazy(() => import("./settings/SettingsView").then(module => ({ default: module.SettingsView })));

const RECENT_WORKSPACES_KEY = "zhenghebao.hermes.recentWorkspaces";

type FixTarget = "model" | "hermes" | "health" | "diagnostics" | "workspace";
function App() {
  const [configOverview, setConfigOverview] = useState<ConfigOverview | undefined>();
  const [settingsInitialSection, setSettingsInitialSection] = useState<ConfigSectionId>("general");
  const sessionLoadSeq = useRef(0);
  const coalescedRefreshes = useRef(new Map<string, Promise<unknown>>());
  const taskPerf = useRef(new Map<string, { startedAt: number; firstTokenAt?: number }>());
  const webUiRefreshedTaskIds = useRef(new Set<string>());
  const store = useAppStore();

  async function loadConfigOverview(workspacePath?: string) {
    return coalesceRefresh(`config:${workspacePath ?? ""}`, async () => {
      const overview = await safePromiseWithFallback(
        window.workbenchClient.getConfigOverview(workspacePath),
        undefined,
        { errorMessage: "加载配置概览失败" }
      );
      setConfigOverview(overview);
      if (overview?.runtimeConfig) {
        store.setRuntimeConfig(overview.runtimeConfig);
      }
      void window.workbenchClient.getPermissionOverview?.().then((permissionOverview) => store.setPermissionOverview(permissionOverview)).catch(() => undefined);
      return overview;
    });
  }

  async function coalesceRefresh<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = coalescedRefreshes.current.get(key);
    if (existing) return existing as Promise<T>;
    const promise = task().finally(() => {
      coalescedRefreshes.current.delete(key);
    });
    coalescedRefreshes.current.set(key, promise);
    return promise;
  }

  async function loadWebUiOverview() {
    const overview = await safePromiseWithFallback(
      window.workbenchClient.getWebUiOverview(),
      undefined,
      { errorMessage: "加载 WebUI 概览失败" }
    );
    store.setWebUiOverview(overview);
    return overview;
  }

  async function refreshWebUiOverviewAfterTask(taskRunId: string, currentState: ReturnType<typeof useAppStore.getState>) {
    if (webUiRefreshedTaskIds.current.has(taskRunId)) return;
    if (currentState.activePanel === "chat" && !currentState.webUiOverview) return;
    webUiRefreshedTaskIds.current.add(taskRunId);
    await coalesceRefresh("webui:overview", loadWebUiOverview);
  }

  useEffect(() => {
    applyTheme(store.webUiOverview?.settings.theme ?? "green-light");
  }, [store.webUiOverview?.settings.theme]);

  useEffect(() => {
    void bootstrap();
    if (!window.workbenchClient || typeof window.workbenchClient.onTaskEvent !== "function") {
      console.warn("workbenchClient.onTaskEvent not available, skipping event listener");
      return;
    }
    let pendingEvents: TaskEventEnvelope[] = [];
    let rafId: number | null = null;
    const MAX_PENDING_EVENTS = 100;

    function handleAuxiliaryEvent(event: TaskEventEnvelope) {
      applyNativeInteractionEvent(event);
    }

    function isTerminalTaskEvent(event: TaskEventEnvelope) {
      if (event.event.type === "result") return true;
      if (event.event.type !== "lifecycle") return false;
      return ["completed", "failed", "cancelled", "restored"].includes(event.event.stage);
    }

    function releaseTaskLockForTerminalEvent(event: TaskEventEnvelope) {
      if (!isTerminalTaskEvent(event)) return;
      const perfEntry = taskPerf.current.get(event.taskRunId);
      if (perfEntry) {
        markPerf("task:complete", {
          taskRunId: event.taskRunId,
          durationMs: Math.round(performance.now() - perfEntry.startedAt),
          firstTokenMs: perfEntry.firstTokenAt ? Math.round(perfEntry.firstTokenAt - perfEntry.startedAt) : undefined,
        });
        taskPerf.current.delete(event.taskRunId);
      }
      const currentState = useAppStore.getState();
      if (currentState.runningSessionId === event.taskRunId) {
        store.setRunningSessionId(undefined);
      }
      if (currentState.runningTaskRunId === event.taskRunId) {
        store.setRunningTaskRunId(undefined);
      }
      void refreshWorkspaceSafety();
      void refreshWebUiOverviewAfterTask(event.taskRunId, currentState);
      window.setTimeout(() => {
        void reconcileLockStateAfterTerminalEvent(event.taskRunId);
      }, 1500);
    }

    async function reconcileLockStateAfterTerminalEvent(taskRunId: string) {
      await refreshWorkspaceSafety();
      const latest = useAppStore.getState();
      const projection = latest.taskRunProjectionsById[taskRunId];
      if (projection && isTerminalTaskStatus(projection.status)) {
        if (latest.runningTaskRunId === taskRunId) store.setRunningTaskRunId(undefined);
        if (latest.runningSessionId === taskRunId) store.setRunningSessionId(undefined);
        const staleOwnLocks = latest.locks.filter((lock) => lock.sessionId !== taskRunId);
        if (staleOwnLocks.length !== latest.locks.length) {
          store.setLocks(staleOwnLocks);
        }
      }
    }

    function flushEvents() {
      rafId = null;
      const events = pendingEvents;
      pendingEvents = [];
      for (const event of events) {
        store.applyTaskEvent(event);
        handleAuxiliaryEvent(event);
        if (event.event.type === "result") {
          const currentState = useAppStore.getState();
          store.pushActivityLog({
            id: `result-${event.taskRunId}-${event.event.at}`,
            engineId: "hermes",
            type: activityTypeFromTask(currentState.taskType),
            status: event.event.success ? "success" : "failed",
            timestamp: event.event.at,
            summary: `${event.event.title}：${event.event.detail}`,
          });
          const targetSessionId = targetSessionForTaskEvent(event, currentState);
          if (targetSessionId && currentState.runningTaskRunId === event.taskRunId) {
            void window.workbenchClient
              .updateSession({
                id: targetSessionId,
                status: event.event.success ? "completed" : "failed",
                lastMessagePreview: event.event.detail.slice(0, 120),
              })
              .then((session) => store.upsertSession(session));
          }
        }
        releaseTaskLockForTerminalEvent(event);
      }
    }

    const unsubscribe = window.workbenchClient.onTaskEvent((event) => {
      if (event.event.type === "message_chunk") {
        const perfEntry = taskPerf.current.get(event.taskRunId);
        if (perfEntry && !perfEntry.firstTokenAt) {
          perfEntry.firstTokenAt = performance.now();
          markPerf("task:first-token", {
            taskRunId: event.taskRunId,
            firstTokenMs: Math.round(perfEntry.firstTokenAt - perfEntry.startedAt),
          });
        }
      }
      const isTerminal = event.event.type === "result" || event.event.type === "lifecycle";
      if (isTerminal) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        const events = pendingEvents;
        pendingEvents = [];
        for (const e of events) {
          store.applyTaskEvent(e);
          handleAuxiliaryEvent(e);
        }
        store.applyTaskEvent(event);
        handleAuxiliaryEvent(event);
        if (event.event.type === "result") {
          const currentState = useAppStore.getState();
          store.pushActivityLog({
            id: `result-${event.taskRunId}-${event.event.at}`,
            engineId: "hermes",
            type: activityTypeFromTask(currentState.taskType),
            status: event.event.success ? "success" : "failed",
            timestamp: event.event.at,
            summary: `${event.event.title}：${event.event.detail}`,
          });
          const targetSessionId = targetSessionForTaskEvent(event, currentState);
          if (targetSessionId && currentState.runningTaskRunId === event.taskRunId) {
            void window.workbenchClient
              .updateSession({
                id: targetSessionId,
                status: event.event.success ? "completed" : "failed",
                lastMessagePreview: event.event.detail.slice(0, 120),
              })
              .then((session) => store.upsertSession(session));
          }
        }
        releaseTaskLockForTerminalEvent(event);
      } else {
        pendingEvents.push(event);
        if (pendingEvents.length >= MAX_PENDING_EVENTS) {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          flushEvents();
        } else if (rafId === null) {
          rafId = requestAnimationFrame(flushEvents);
        }
      }
    });
    return () => {
      unsubscribe();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    if (!window.workbenchClient || typeof window.workbenchClient.onHermesAgentCompatibilityWarning !== "function") {
      return;
    }
    const unsubscribe = window.workbenchClient.onHermesAgentCompatibilityWarning((event) => {
      if (!event.compatible) {
        if (useAppStore.getState().view === "settings") return;
        store.warning("Hermes Agent 需要处理", event.message);
      }
    });
    return () => unsubscribe();
  }, []);

  async function bootstrap() {
    markPerfStart("bootstrap");
    store.startLoading("bootstrap");
    try {
      // 强制设置默认状态，确保启动时显示聊天界面
      store.setInspectorOpen(false);
      store.setActivePanel("chat");
      store.setWorkspaceDrawerOpen(false);
      
      // 检查 workbenchClient 是否可用
      const workbenchClient = window.workbenchClient;
      if (!workbenchClient) {
        console.error("workbenchClient not available, running in offline mode");
        store.stopLoading("bootstrap");
        return;
      }
      
      // ========== 第一阶段：关键数据优先加载（UI必需） ==========
      const [clientInfo, sessions] = await Promise.all([
        safePromiseWithFallback(
          workbenchClient.getClientInfo(),
          { appVersion: "unknown", userDataPath: "", portable: false, rendererMode: "built" as const },
          { errorMessage: "获取客户端信息失败" }
        ),
        safePromiseWithFallback(
          workbenchClient.listSessions(),
          [],
          { errorMessage: "获取会话列表失败" }
        ),
      ]);
      
      store.setClientInfo(clientInfo);
      store.setSessions(sessions);
      store.setRecentWorkspaces(readRecentWorkspaces());
      
      // 快速选择会话，提前进入主界面
      const activeSession = sessions[0];
      
      if (activeSession) {
        store.upsertSession(activeSession);
        store.setActiveSession(activeSession.id);
        store.setSessionFilesPath(activeSession.sessionFilesPath);
        store.setWorkspacePath(activeSession.workspacePath ?? "");
        const requestId = ++sessionLoadSeq.current;
        void loadSelectedSessionData(activeSession, requestId);
      } else {
        const newSession = await safePromiseWithFallback(
          workbenchClient.createSession("新的会话"),
          undefined,
          { errorMessage: "创建新会话失败" }
        );
        if (newSession) {
          store.upsertSession(newSession);
          store.setActiveSession(newSession.id);
          store.setSessionFilesPath(newSession.sessionFilesPath);
          const requestId = ++sessionLoadSeq.current;
          void loadSelectedSessionData(newSession, requestId);
        }
      }
      
      // ========== 第二阶段：仅加载轻量本地状态 ==========
      // Startup must not fan out into RuntimeProbe, capabilities --json,
      // Gateway status/start, or WebUI file scans. Those remain explicit
      // refresh actions after the shell is interactive.
      Promise.all([
        // 密钥状态
        safePromiseWithFallback(
          workbenchClient.getSecretStatus(),
          { available: false, mode: "safe-storage", path: "", message: "密钥状态暂不可用。" } satisfies SecretVaultStatus,
          { errorMessage: "获取密钥状态失败" }
        ).then((status) => {
          store.setSecretStatus(status);
        }),
        
        // 运行时配置（后备）
        safePromiseWithFallback(
          workbenchClient.getRuntimeConfig(),
          { defaultModelProfileId: undefined, modelProfiles: [], updateSources: {}, enginePermissions: {} } satisfies RuntimeConfig,
          { errorMessage: "获取运行时配置失败" }
          ).then((config) => {
            store.setRuntimeConfig(config);
          }),
      ]).then(() => {
        store.info("欢迎使用 Hermes 工作台", "已完成初始化");
      }).catch(() => {
        // 后台加载失败不影响主流程
      });
      
    } finally {
      store.stopLoading("bootstrap");
      markPerfEnd("bootstrap", {
        sessions: useAppStore.getState().sessions.length,
        activeSessionId: useAppStore.getState().activeSessionId,
      });
    }
  }

  async function selectSession(sessionOrId: WorkSession | string) {
    markPerfStart("session:switch");
    const current = useAppStore.getState();
    let session = typeof sessionOrId === "string"
      ? current.sessions.find((item) => item.id === sessionOrId)
      : sessionOrId;
    
    if (!session) {
      session = await safePromiseWithFallback(
        window.workbenchClient.createSession("新的会话"),
        undefined,
        { errorMessage: "创建新会话失败" }
      );
      if (!session) return;
    }
    
    if (current.activeSessionId && current.sessions.some((item) => item.id === current.activeSessionId)) {
      store.saveSessionEphemeralState(current.activeSessionId);
    }
    store.setActiveSession(session.id);
    store.setSessionFilesPath(session.sessionFilesPath);
    store.setWorkspacePath(session.workspacePath ?? "");
    store.restoreSessionEphemeralState(session.id);
    store.setSessionAgentInsight(undefined);
    const requestId = ++sessionLoadSeq.current;
    await loadSelectedSessionData(session, requestId);
    markPerfEnd("session:switch", { sessionId: session.id });

    // 非关键数据：后台异步加载
    Promise.all([
      refreshWorkspaceSafety(),
      refreshHermesStatus(),
      refreshSetupSummary(),
    ]).catch(() => {
      // 后台加载失败不影响主流程
    });
  }

  async function loadSelectedSessionData(session: WorkSession, requestId: number) {
    // 关键数据：纯聊天会话从 sessionFilesPath 恢复事件；工作区只是可选上下文。
    const eventSourcePath = session.workspacePath || session.sessionFilesPath;
    const [events, fileTree, insight] = await Promise.all([
      eventSourcePath
        ? safePromiseWithFallback(
          window.workbenchClient.getRecentTaskEvents(eventSourcePath, session.id),
          [],
          { errorMessage: "获取任务事件失败" }
        )
        : [],
      session.workspacePath
        ? safePromiseWithFallback(
            window.workbenchClient.getFileTree(session.workspacePath),
            undefined,
            { errorMessage: "获取文件树失败" }
          )
        : undefined,
      eventSourcePath
        ? safePromiseWithFallback(
            window.workbenchClient.getSessionAgentInsight(session.id, eventSourcePath),
            undefined,
            { errorMessage: "获取 Agent 面板恢复数据失败" }
          )
        : undefined,
    ]);

    const latest = useAppStore.getState();
    if (sessionLoadSeq.current !== requestId || latest.activeSessionId !== session.id) {
      return;
    }

    store.setEvents(events);
    store.rebuildSessionProjections(session.id, events);
    store.setFileTree(fileTree);
    store.setSessionAgentInsight(insight);
  }

  async function createSession() {
    const session = await safePromiseWithFallback(
      window.workbenchClient.createSession("新的会话"),
      undefined,
      { errorMessage: "创建会话失败" }
    );
    if (!session) return;
    store.upsertSession(session);
    await selectSession(session);
    store.success("会话已创建", "新会话已准备就绪");
  }

  async function deleteSession(session: WorkSession) {
    const current = useAppStore.getState();
    const deletedWasActive = current.activeSessionId === session.id;
    
    const result = await safePromiseWithFallback(
      window.workbenchClient.deleteSession(session.id),
      { ok: false, message: "删除失败", deletedId: "" },
      { errorMessage: "删除会话失败" }
    );
    
    if (!result.ok) return;
    
    const remaining = useAppStore.getState().sessions.filter((item) => item.id !== result.deletedId);
    store.setSessions(remaining);
    store.clearSessionData(session.id);
    store.clearSessionEphemeralState(session.id);
    if (deletedWasActive) {
      store.setSessionAgentInsight(undefined);
    }
    store.info("会话已删除", `已删除会话：${session.title}`);
    
    if (!deletedWasActive) return;
    
    const nextSession = remaining[0] ?? await safePromiseWithFallback(
      window.workbenchClient.createSession("新的会话"),
      undefined,
      { errorMessage: "创建新会话失败" }
    );
    
    if (!nextSession) return;
    if (!remaining[0]) store.upsertSession(nextSession);
    await selectSession(nextSession);
  }

  async function renameActiveSession(title: string) {
    const current = useAppStore.getState();
    if (!current.activeSessionId) return;
    const session = await window.workbenchClient.updateSession({ id: current.activeSessionId, title });
    store.upsertSession(session);
  }

  async function openActiveSessionFolder() {
    const current = useAppStore.getState();
    if (!current.activeSessionId) return;
    await window.workbenchClient.openSessionFolder(current.activeSessionId);
  }

  async function clearActiveSession() {
    const current = useAppStore.getState();
    if (!current.activeSessionId) return;
    const result = await window.workbenchClient.clearSessionFiles(current.activeSessionId);
    store.upsertSession(result.session);
    store.clearSessionData(current.activeSessionId);
    store.clearSessionEphemeralState(current.activeSessionId);
    store.setSessionAgentInsight(undefined);
  }

  async function pickWorkspace() {
    const workspacePath = await window.workbenchClient.pickWorkspaceFolder();
    if (!workspacePath) return;
    await selectWorkspace(workspacePath);
  }

  async function selectWorkspace(workspacePath: string) {
    const current = useAppStore.getState();
    store.setWorkspacePath(workspacePath);
    store.rememberWorkspace(workspacePath);
    store.clearSelectedFiles();
    store.clearAttachments();
    store.saveSessionEphemeralState(current.activeSessionId);
    store.setWorkspaceDrawerOpen(false);
    writeRecentWorkspaces(useAppStore.getState().recentWorkspaces);
    if (current.activeSessionId) {
      const session = await window.workbenchClient.updateSession({ id: current.activeSessionId, workspacePath, workspaceStatus: "ready" });
      store.upsertSession(session);
    }
    await Promise.all([refreshHermesStatus(), refreshSetupSummary(), refreshFileTree(), refreshWorkspaceSafety(), loadConfigOverview(workspacePath), loadWebUiOverview()]);
  }

  async function updateActiveSessionMeta(patch: SessionMetaPatch) {
    const current = useAppStore.getState();
    if (!current.activeSessionId) return;
    const session = await window.workbenchClient.updateSession({ id: current.activeSessionId, ...patch });
    store.upsertSession(session);
  }

  async function updateSessionMeta(sessionId: string, patch: SessionMetaPatch) {
    const session = await window.workbenchClient.updateSession({ id: sessionId, ...patch });
    store.upsertSession(session);
  }

  async function exportSession(session: WorkSession, format: "json" | "markdown") {
    const result = await window.workbenchClient.exportSession({ id: session.id, format });
    store.pushEvent({
      taskRunId: "session-export",
      workSessionId: session.id,
      sessionId: "session-export",
      engineId: "hermes",
      event: { type: "status", level: result.ok ? "success" : "warning", message: result.message, at: new Date().toISOString() },
    });
  }

  async function startTask() {
    const current = useAppStore.getState();
    const selectedModelProfileId = resolveSelectedModelProfileId({
      runtimeConfig: current.runtimeConfig,
      activeSessionId: current.activeSessionId,
      preferredModelProfileId: current.preferredModelProfileId,
      modelProfileIdBySession: current.modelProfileIdBySession,
    });
    
    if (!window.workbenchClient || typeof window.workbenchClient.startTask !== "function") {
      store.pushEvent({
        taskRunId: "client",
        workSessionId: current.activeSessionId,
        sessionId: "client",
        engineId: "hermes",
        event: { type: "status", level: "error", message: "Hermes 客户端未就绪，请检查连接状态。", at: new Date().toISOString() },
      });
      store.error("发送失败", "Hermes 客户端未就绪，请检查连接状态");
      return;
    }
    
    const prompt = current.userInput.trim() || (current.attachments.length ? "请查看我上传的附件，并根据附件内容给出分析或处理建议。" : "");
    if (!prompt) {
      store.pushEvent({
        taskRunId: "client",
        workSessionId: current.activeSessionId,
        sessionId: "client",
        engineId: "hermes",
        event: { type: "status", level: "warning", message: "请先写清楚要让 Hermes 做什么。", at: new Date().toISOString() },
      });
      return;
    }
    const running = resolveRunningTaskState(current);
    if (running.isAnyTaskRunning) {
      store.warning(
        "任务运行中",
        running.isActiveSessionRunning
          ? "当前会话任务还在运行，完成或停止后再发送。"
          : `${runningSessionLabel(running)}正在运行，完成后再发送。`,
      );
      return;
    }

    let activeSessionId = current.activeSessionId;
    let sessionFilesPath = current.sessionFilesPath;

    if (!activeSessionId) {
      const newSession = await safePromiseWithFallback(
        window.workbenchClient.createSession(prompt.slice(0, 40)),
        undefined,
        { errorMessage: "自动创建会话失败" }
      );
      if (newSession) {
        store.upsertSession(newSession);
        store.setActiveSession(newSession.id);
        activeSessionId = newSession.id;
        sessionFilesPath = newSession.sessionFilesPath || newSession.id;
        store.setSessionFilesPath(sessionFilesPath);
        if (selectedModelProfileId) store.setModelProfileSelection(selectedModelProfileId, activeSessionId);
      } else {
        activeSessionId = `local-${Date.now()}`;
        sessionFilesPath = activeSessionId;
        store.setActiveSession(activeSessionId);
        store.setSessionFilesPath(sessionFilesPath);
        if (selectedModelProfileId) store.setModelProfileSelection(selectedModelProfileId, activeSessionId);
      }
    }

    const taskType = current.workspacePath.trim() ? inferTaskType(prompt, current.taskType) : "custom";
    const workSessionId = activeSessionId || "local-session";
    if (!current.workspacePath.trim() && promptNeedsWorkspace(prompt, current.selectedFiles)) {
      store.warning("请先选择项目目录", "这类请求需要真实工作区，Forge 才能像原版 CLI 一样读取项目文件。");
      store.setWorkspaceDrawerOpen(true);
      return;
    }
    const conversationHistory = buildConversationHistory({
      workSessionId,
      taskRunOrderBySession: current.taskRunOrderBySession,
      taskRunProjectionsById: current.taskRunProjectionsById,
    });
    const clientTaskId = createClientTaskId();
    const createdAt = new Date().toISOString();
    store.beginTaskRun({ workSessionId, taskRunId: clientTaskId, userInput: prompt, createdAt });
    taskPerf.current.set(clientTaskId, { startedAt: performance.now() });
    store.setUserInput("");
    store.setSessionEphemeralState(workSessionId, { userInput: "", selectedFiles: current.selectedFiles, attachments: current.attachments });
    let result;
    try {
      result = await window.workbenchClient.startTask({
        clientTaskId,
        userInput: prompt,
        sessionId: activeSessionId,
        conversationHistory,
        taskType,
        workspacePath: current.workspacePath || undefined,
        sessionFilesPath: sessionFilesPath || activeSessionId || "default",
        selectedFiles: current.selectedFiles,
        attachments: current.attachments,
        modelProfileId: selectedModelProfileId,
      });
    } catch (error) {
      taskPerf.current.delete(clientTaskId);
      const message = error instanceof Error ? error.message : "Hermes 启动前检查失败。";
      store.finalizeTaskRun(clientTaskId, { status: "failed", content: humanizeStartFailure(message) });
      const latest = useAppStore.getState();
      if (latest.runningTaskRunId === clientTaskId) store.setRunningTaskRunId(undefined);
      if (latest.runningSessionId === clientTaskId) store.setRunningSessionId(undefined);
      const shouldRestorePrompt = latest.activeSessionId !== workSessionId || !latest.userInput.trim();
      if (shouldRestorePrompt) {
        store.setSessionEphemeralState(workSessionId, { userInput: prompt, selectedFiles: current.selectedFiles, attachments: current.attachments });
      }
      store.pushEvent({
        taskRunId: "preflight",
        workSessionId: activeSessionId,
        sessionId: "preflight",
        engineId: "hermes",
        event: { type: "status", level: "error", message, at: new Date().toISOString() },
      });
      await Promise.all([refreshSetupSummary(), refreshHermesStatus()]);
      openFixTarget(fixTargetForFailure(message, useAppStore.getState().setupSummary?.blocking[0]?.fixAction));
      return;
    }
    store.setSessionEphemeralState(workSessionId, { userInput: "", selectedFiles: current.selectedFiles, attachments: [] });
    if (result.taskRunId !== clientTaskId) {
      const perfEntry = taskPerf.current.get(clientTaskId);
      if (perfEntry) {
        taskPerf.current.delete(clientTaskId);
        taskPerf.current.set(result.taskRunId, perfEntry);
      }
      store.rebindTaskRunId(clientTaskId, result.taskRunId);
    }
    const resultProjection = useAppStore.getState().taskRunProjectionsById[result.taskRunId];
    if (!isTerminalTaskStatus(resultProjection?.status)) {
      store.setRunningSessionId(result.taskRunId);
      store.setRunningTaskRunId(result.taskRunId);
    }
    store.updateTaskRunMeta(result.taskRunId, {
      engineId: "hermes",
      actualEngine: "hermes",
      runtimeMode: result.runtime.runtimeMode,
      providerId: result.runtime.providerId,
      modelId: result.runtime.modelId,
    });
    store.setContextBundle(result.contextBundle);
    store.setSessionAgentInsight({
      sessionId: activeSessionId || workSessionId,
      latestRuntime: {
        taskRunId: result.taskRunId,
        status: "running",
        providerId: result.runtime.providerId,
        modelId: result.runtime.modelId,
        runtimeMode: result.runtime.runtimeMode,
        updatedAt: new Date().toISOString(),
      },
      memory: {
        bundleId: result.contextBundle.id,
        usedCharacters: result.contextBundle.usedCharacters,
        maxCharacters: result.contextBundle.maxCharacters,
        summary: result.contextBundle.summary,
        updatedAt: result.contextBundle.createdAt,
      },
    });
    store.pushActivityLog({
      id: `start-${result.taskRunId}`,
      engineId: "hermes",
      type: activityTypeFromTask(taskType),
      status: "running",
      timestamp: new Date().toISOString(),
      summary: prompt,
    });
    if (current.activeSessionId) {
      const updated = await window.workbenchClient.updateSession({
        id: current.activeSessionId,
        title: sessionTitleFromPrompt(prompt),
        status: "running",
        lastMessagePreview: prompt.slice(0, 120),
        workspacePath: current.workspacePath || undefined,
        workspaceStatus: current.workspacePath ? "ready" : "unselected",
      });
      store.upsertSession(updated);
    }
    void Promise.all([
      refreshWorkspaceSafety(),
      refreshSetupSummary(),
      refreshHermesStatus(),
      loadConfigOverview(current.workspacePath || undefined),
    ]).catch(() => undefined);
  }

  async function cancelTask() {
    const current = useAppStore.getState();
    const running = resolveRunningTaskState(current);
    if (!running.globalRunningTaskRunId) return;
    if (!running.activeSessionRunningTaskRunId) {
      store.warning("任务在其他会话运行", `${runningSessionLabel(running)}正在运行，切回对应会话后再停止。`);
      return;
    }
    await window.workbenchClient.cancelTask(running.activeSessionRunningTaskRunId);
    store.finalizeTaskRun(running.activeSessionRunningTaskRunId, { status: "cancelled", content: "Hermes 任务已取消。" });
    store.setRunningSessionId(undefined);
    store.setRunningTaskRunId(undefined);
    await refreshWorkspaceSafety();
    store.warning("任务已取消", "当前任务已终止");
  }

  async function restoreSnapshot() {
    const current = useAppStore.getState();
    const target = current.workspacePath || current.sessionFilesPath;
    if (!target) return;
    const result = await window.workbenchClient.restoreLatestSnapshot(target);
    store.pushEvent({
      taskRunId: "snapshot",
      workSessionId: current.activeSessionId,
      sessionId: "snapshot",
      engineId: "hermes",
      event: { type: "status", level: result.restored ? "success" : "warning", message: result.message, at: new Date().toISOString() },
    });
    await refreshWorkspaceSafety();
    if (result.restored) {
      store.success("快照已恢复", result.message);
    } else {
      store.warning("快照恢复失败", result.message);
    }
  }

  async function refreshFileTree() {
    const current = useAppStore.getState();
    if (!current.workspacePath.trim()) {
      store.setFileTree(undefined);
      return;
    }
    const fileTree = await safePromiseWithFallback(
      window.workbenchClient.getFileTree(current.workspacePath),
      undefined,
      { errorMessage: "获取文件树失败" }
    );
    store.setFileTree(fileTree);
  }

  async function refreshWorkspaceSafety() {
    const current = useAppStore.getState();
    const target = current.workspacePath || current.sessionFilesPath;
    if (!target) {
      store.setLocks([]);
      store.setSnapshots([]);
      return;
    }
    const [locks, snapshots] = await Promise.all([
      safePromiseWithFallback(
        window.workbenchClient.listActiveLocks(target),
        [],
        { errorMessage: "获取文件锁失败" }
      ),
      safePromiseWithFallback(
        window.workbenchClient.listSnapshots(target),
        [],
        { errorMessage: "获取快照列表失败" }
      ),
    ]);
    store.setLocks(locks);
    store.setSnapshots(snapshots);
  }

  async function refreshHermesStatus() {
    const workspacePath = useAppStore.getState().workspacePath || undefined;
    await coalesceRefresh(`hermes-status:${workspacePath ?? ""}`, async () => {
      const [status, probe] = await Promise.all([
        safePromiseWithFallback(
          window.workbenchClient.getHermesStatus(workspacePath),
          undefined,
          { errorMessage: "获取 Hermes 状态失败" }
        ),
        safePromiseWithFallback(
          window.workbenchClient.getHermesProbe(workspacePath),
          undefined,
          { errorMessage: "获取 Hermes 探测失败" }
        ),
      ]);
      if (status) store.setHermesStatus(status);
      if (probe) store.setHermesProbe(probe);
    });
  }

  async function refreshSetupSummary() {
    const workspacePath = useAppStore.getState().workspacePath || undefined;
    await coalesceRefresh(`setup-summary:${workspacePath ?? ""}`, async () => {
      const summary = await safePromiseWithFallback(
        window.workbenchClient.getSetupSummary(workspacePath),
        undefined,
        { errorMessage: "获取设置摘要失败" }
      );
      if (summary) {
        store.setSetupSummary(summary);
      }
    });
  }

  function openFixTarget(target: FixTarget) {
    if (target === "workspace") {
      store.setView("home");
      store.setActivePanel("chat");
      store.setWorkspaceDrawerOpen(true);
      return;
    }
    const section: ConfigSectionId = target === "model" ? "providers" : target === "hermes" ? "general" : "health";
    setSettingsInitialSection(section);
    store.setView("settings");
  }

  function completeWelcome(target?: WelcomeCompleteTarget) {
    store.setFirstLaunch(false);
    if (target === "model") {
      setSettingsInitialSection("providers");
      store.setView("settings");
    } else if (target === "hermes") {
      setSettingsInitialSection("general");
      store.setView("settings");
    }
  }

  if (store.firstLaunch) {
    return <WelcomePage onComplete={completeWelcome} />;
  }

  return (
    <>
      <a className="hermes-skip-link" href="#main-content">跳到主要内容</a>
      {store.isLoading("bootstrap") && <PageLoader />}
      {store.view === "support" ? (
        <SupportView onBack={() => store.setView("home")} />
      ) : store.view === "settings" ? (
        <SettingsView
          overview={configOverview}
          initialSection={settingsInitialSection}
          onBack={() => store.setView("home")}
          onRefresh={async () => {
            const workspacePath = useAppStore.getState().workspacePath || undefined;
            await Promise.all([
              loadConfigOverview(workspacePath),
              refreshSetupSummary(),
              refreshHermesStatus(),
            ]);
          }}
          onClearSession={clearActiveSession}
          onOpenSessionFolder={openActiveSessionFolder}
        />
      ) : (
        <DashboardView
          onPickWorkspace={pickWorkspace}
          onSelectWorkspace={selectWorkspace}
          onCreateSession={createSession}
          onSelectSession={selectSession}
          onDeleteSession={deleteSession}
          onExportSession={exportSession}
          onRenameSession={renameActiveSession}
          onUpdateActiveSessionMeta={updateActiveSessionMeta}
          onUpdateSessionMeta={updateSessionMeta}
          onOpenSessionFolder={openActiveSessionFolder}
          onOpenSupport={() => store.setView("support")}
          onClearSession={clearActiveSession}
          onStartTask={startTask}
          onCancelTask={cancelTask}
          onRestoreSnapshot={restoreSnapshot}
          onRefreshFileTree={refreshFileTree}
          onOpenFix={openFixTarget}
          onRefreshWebUiOverview={loadWebUiOverview}
        />
      )}
      <ToastContainer toasts={store.toasts} onClose={store.removeToast} />
    </>
  );
}

function createClientTaskId() {
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function requiresWorkspace(taskType: TaskType) {
  return taskType !== "custom";
}

function inferTaskType(input: string, fallback: TaskType): TaskType {
  const text = input.toLowerCase();
  if (/修复|报错|错误|bug|failed|error/.test(text)) return "fix_error";
  if (/生成.*网页|做.*页面|网站|前端|react|ui/.test(text)) return "generate_web";
  if (/分析.*项目|目录|架构|依赖|启动方式/.test(text)) return "analyze_project";
  if (/整理|归类|移动|重命名/.test(text)) return "organize_files";
  return fallback;
}

function activityTypeFromTask(taskType: TaskType): ActivityLog["type"] {
  if (taskType === "fix_error") return "fix";
  if (taskType === "analyze_project") return "analyze";
  return "generate";
}

function sessionTitleFromPrompt(prompt: string) {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 32) || "新的会话";
}

function applyTheme(theme: "green-light" | "light" | "slate" | "oled" | "default-large") {
  const resolved = theme === "oled" ? "slate" : theme;
  document.documentElement.setAttribute("data-theme", resolved);
  document.body.setAttribute("data-theme", resolved);
}

function withThemeOverview(
  overview: HermesWebUiOverview | undefined,
  settings: HermesWebUiSettings,
): HermesWebUiOverview {
  if (overview) {
    return { ...overview, settings };
  }
  return {
    settings,
    projects: [],
    spaces: [],
    skills: [],
    memory: [],
    crons: [],
    profiles: [],
    slashCommands: [],
  };
}

function promptNeedsWorkspace(input: string, selectedFiles: string[]) {
  if (hasInlineLocalFilePath(input)) return false;
  if (selectedFiles.length > 0) return true;
  const text = input.trim().toLowerCase();
  if (!text) return false;
  return (
    /读取|读一下|查看|分析|检查|搜索|打开|遍历|修复|修改|编辑|重构|定位|查找/.test(text) &&
    /文件|代码|项目|目录|仓库|源码|模块|package\.json|readme|tsconfig|src\b|文件夹|工作区/.test(text)
  );
}

function humanizeStartFailure(message: string) {
  if (/MODEL_NOT_CONFIGURED|缺少模型|API Key|密钥/i.test(message)) return `Hermes 模型配置还没准备好：${message}`;
  if (/WORKSPACE_LOCKED|占用/i.test(message)) return "当前工作区正在被 Hermes 使用。请等待任务完成，或先停止当前任务。";
  if (/SNAPSHOT_FAILED|快照/i.test(message)) return `Hermes 建立安全快照失败：${message}`;
  return message;
}

function isTerminalTaskStatus(status?: TaskRunStatus) {
  return status === "complete" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function fixTargetForFailure(message: string, action?: string): FixTarget {
  if (action === "configure_model") return "model";
  if (action === "configure_hermes" || action === "open_settings") return "hermes";
  if (/模型|密钥|API Key|auth|model/i.test(message)) return "model";
  if (/Hermes 路径|Hermes 根路径|权限|控制台|Python|CLI|NoConsoleScreenBuffer/i.test(message)) return "hermes";
  if (/诊断|退出码|unknown|未知/i.test(message)) return "diagnostics";
  return "health";
}

function readRecentWorkspaces(): RecentWorkspace[] {
  try {
    const raw = localStorage.getItem(RECENT_WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentWorkspace[];
    return Array.isArray(parsed) ? parsed.filter((item) => item.path && item.name) : [];
  } catch {
    return [];
  }
}

function writeRecentWorkspaces(workspaces: RecentWorkspace[]) {
  localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(workspaces.slice(0, 12)));
}

try {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    console.error("Root element not found");
    throw new Error("Root element not found");
  }
  createRoot(rootElement).render(
    <Suspense fallback={<PageLoader />}>
      <App />
    </Suspense>
  );
} catch (error) {
  console.error("Failed to render app:", error);
  const rootElement = document.getElementById("root");
  if (rootElement) {
    rootElement.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background: #f5f7f8; padding: 20px;">
        <div style="background: white; padding: 40px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); max-width: 500px;">
          <h1 style="font-size: 24px; font-weight: bold; color: #1f2937; margin-bottom: 16px;">应用启动失败</h1>
          <p style="font-size: 14px; color: #6b7280; margin-bottom: 24px;">
            抱歉，应用启动时遇到了错误。请尝试重新启动应用。
          </p>
          <pre style="background: #f3f4f6; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #374151; max-height: 200px; overflow-y: auto;">
应用渲染初始化失败，请尝试重启客户端。如问题持续，请导出诊断报告或联系技术支持。
          </pre>
          <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">
            如果问题持续存在，请检查控制台获取更多详细信息。
          </p>
        </div>
      </div>
    `;
  }
}
