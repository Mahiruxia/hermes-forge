import { create } from "zustand";
import { persist } from "zustand/middleware";
import { uiSlice } from "./store/uiSlice";
import { configSlice } from "./store/configSlice";
import { sessionSlice } from "./store/sessionSlice";
import { taskSlice } from "./store/taskSlice";
import { dashboardSlice } from "./store/dashboardSlice";
import { feedbackSlice } from "./store/feedbackSlice";
import type { UiActions, UiState } from "./store/uiSlice";
import type { ConfigActions, ConfigState } from "./store/configSlice";
import type { SessionActions, SessionState } from "./store/sessionSlice";
import type { TaskActions, TaskState } from "./store/taskSlice";
import type { DashboardActions, DashboardState } from "./store/dashboardSlice";
import type { FeedbackActions, FeedbackState } from "./store/feedbackSlice";
import type { SessionMessage, TaskRunProjection, TaskRunStatus } from "../shared/types";

export type ViewId = "home" | "engines" | "memory" | "admin" | "settings" | "support" | "logs";
export type RecentWorkspace = {
  path: string;
  name: string;
  lastOpenedAt: string;
};
export type EngineWarmupState = {
  status: "not_checked" | "checking" | "ready" | "degraded" | "failed" | "real_probe_passed";
  message: string;
  checkedAt: string;
  probeKind?: string;
  lastRealProbeAt?: string;
  diagnosticCategory?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
  authMode?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeStatus(value: unknown): TaskRunStatus {
  if (value === "completed") return "complete";
  if (
    value === "pending"
    || value === "routing"
    || value === "running"
    || value === "streaming"
    || value === "complete"
    || value === "failed"
    || value === "cancelled"
    || value === "interrupted"
  ) {
    return value;
  }
  return "complete";
}

function normalizeMessage(value: unknown, fallback: SessionMessage): SessionMessage {
  if (!isRecord(value)) return fallback;
  return {
    ...fallback,
    ...value,
    id: typeof value.id === "string" ? value.id : fallback.id,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : fallback.sessionId,
    role: value.role === "user" || value.role === "agent" || value.role === "system" || value.role === "tool" ? value.role : fallback.role,
    content: typeof value.content === "string" ? value.content : fallback.content,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : fallback.createdAt,
    visibleInChat: typeof value.visibleInChat === "boolean" ? value.visibleInChat : fallback.visibleInChat,
  };
}

function normalizeTaskRunProjection(value: unknown, fallbackId: string): TaskRunProjection | undefined {
  if (!isRecord(value)) return undefined;
  const taskRunId = typeof value.taskRunId === "string"
    ? value.taskRunId
    : typeof value.id === "string"
      ? value.id
      : fallbackId;
  const workSessionId = typeof value.workSessionId === "string" ? value.workSessionId : "local-session";
  const createdAt = typeof value.startedAt === "string"
    ? value.startedAt
    : typeof value.createdAt === "string"
      ? value.createdAt
      : new Date().toISOString();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  const content = typeof value.content === "string" ? value.content : "";
  const userInput = typeof value.userInput === "string" ? value.userInput : "";
  const userMessage = userInput
    ? normalizeMessage(value.userMessage, {
        id: `user-${taskRunId}`,
        sessionId: workSessionId,
        role: "user",
        content: userInput,
        createdAt,
        visibleInChat: true,
      })
    : isRecord(value.userMessage)
      ? normalizeMessage(value.userMessage, {
          id: `user-${taskRunId}`,
          sessionId: workSessionId,
          role: "user",
          content: "",
          createdAt,
          visibleInChat: true,
        })
      : undefined;
  const assistantMessage = normalizeMessage(value.assistantMessage, {
    id: `agent-${taskRunId}`,
    sessionId: workSessionId,
    role: "agent",
    content,
    status: normalizeStatus(value.status) === "complete" ? "complete" : "streaming",
    engineId: "hermes",
    createdAt: updatedAt,
    visibleInChat: true,
  });

  return {
    ...value,
    taskRunId,
    workSessionId,
    userMessage,
    assistantMessage,
    status: normalizeStatus(value.status),
    toolEvents: Array.isArray(value.toolEvents) ? value.toolEvents : [],
    startedAt: createdAt,
    updatedAt,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
  };
}

function sanitizePersistedState(value: unknown) {
  if (!isRecord(value)) return value;
  const projections = isRecord(value.taskRunProjectionsById) ? value.taskRunProjectionsById : {};
  const normalizedProjections: Record<string, TaskRunProjection> = {};
  Object.entries(projections).forEach(([key, projection]) => {
    const normalized = normalizeTaskRunProjection(projection, key);
    if (normalized) {
      normalizedProjections[normalized.taskRunId] = normalized;
    }
  });

  const orderBySession = isRecord(value.taskRunOrderBySession) ? value.taskRunOrderBySession : {};
  const normalizedOrder = Object.fromEntries(
    Object.entries(orderBySession).map(([sessionId, order]) => [
      sessionId,
      Array.isArray(order) ? order.filter((taskRunId): taskRunId is string => typeof taskRunId === "string" && Boolean(normalizedProjections[taskRunId])) : [],
    ]),
  );

  return {
    ...value,
    taskType: value.taskType === "chat" ? "custom" : value.taskType,
    taskRunProjectionsById: normalizedProjections,
    taskRunOrderBySession: normalizedOrder,
  };
}

export type AppStore =
  UiState & UiActions &
  ConfigState & ConfigActions &
  SessionState & SessionActions &
  TaskState & TaskActions &
  DashboardState & DashboardActions &
  FeedbackState & FeedbackActions & {
    resetStore(): void;
  };

let initialStoreSnapshot: Partial<AppStore> | undefined;

const useAppStoreBase = create<AppStore>()(
  persist(
    (...a) => ({
      ...uiSlice(...a),
      ...configSlice(...a),
      ...sessionSlice(...a),
      ...taskSlice(...a),
      ...dashboardSlice(...a),
      ...feedbackSlice(...a),
      resetStore: () => {
        const [set] = a;
        if (initialStoreSnapshot) {
          set({ ...initialStoreSnapshot } as AppStore);
        }
      },
    }),
    { 
      name: "hermes-workbench",
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(sanitizePersistedState(persistedState) as Partial<AppStore>),
      } as AppStore),
      partialize: (state) => ({
        ...state,
        inspectorOpen: false,
        workspaceDrawerOpen: false,
        agentPanelOpen: false,
        activePanel: "chat",
        runningTaskRunId: undefined,
        runningSessionId: undefined,
        events: [],
        taskEventsByRunId: {},
        streamEventsByTaskId: {},
        pendingTasksBySessionId: {},
        contextBundle: undefined,
        sessionAgentInsight: undefined,
      }),
    }
  )
);
initialStoreSnapshot = useAppStoreBase.getInitialState();

export const useAppStore = useAppStoreBase;
