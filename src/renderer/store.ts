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
import type { SessionAttachment } from "../shared/types";
import { createResilientStorage } from "./utils/resilientStorage";

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

export type SessionEphemeralState = {
  sessionDrafts: Record<string, string>;
  selectedFilesBySessionId: Record<string, string[]>;
  attachmentsBySessionId: Record<string, SessionAttachment[]>;
};

export type SessionEphemeralActions = {
  saveSessionEphemeralState(sessionId?: string): void;
  restoreSessionEphemeralState(sessionId?: string): void;
  setSessionEphemeralState(
    sessionId: string | undefined,
    patch: Partial<{
      userInput: string;
      selectedFiles: string[];
      attachments: SessionAttachment[];
    }>,
  ): void;
  clearSessionEphemeralState(sessionId?: string): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Persist preferences only. Sessions and task history are restored from main-process logs. */
function sanitizePersistedState(value: unknown): Partial<AppStore> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const key of ["firstLaunch", "sessionSidebarOpen"] as const) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  for (const key of ["userInput", "activeSessionId", "preferredModelProfileId", "selectedProjectId"] as const) {
    if (typeof value[key] === "string") result[key] = value[key];
  }
  const choices = {
    view: ["home", "settings", "support"],
    knowledgeTab: ["skills", "memory"],
    sidebarGrouping: ["smart", "project", "time"],
    taskType: ["custom", "fix_error", "generate_web", "analyze_project", "organize_files"],
  };
  for (const [key, allowed] of Object.entries(choices)) {
    if (typeof value[key] === "string" && allowed.includes(value[key])) result[key] = value[key];
  }
  if (value.taskType === "chat") result.taskType = "custom";
  if (isRecord(value.modelProfileIdBySession)) {
    result.modelProfileIdBySession = Object.fromEntries(Object.entries(value.modelProfileIdBySession)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  const settings = value.webUiSettings ?? (isRecord(value.webUiOverview) ? value.webUiOverview.settings : undefined);
  if (isRecord(settings)) {
    result.webUiSettings = {
      theme: ["green-light", "light", "slate", "oled", "default-large"].includes(String(settings.theme)) ? settings.theme : "green-light",
      language: settings.language === "en" ? "en" : "zh",
      sendKey: settings.sendKey === "mod-enter" ? "mod-enter" : "enter",
      sendKeyHintDismissed: settings.sendKeyHintDismissed === true,
      showUsage: settings.showUsage === true,
      showCliSessions: settings.showCliSessions !== false,
    };
  }
  return {
    ...result,
    sessionSidebarWidth: sanitizePanelWidth(value.sessionSidebarWidth, 228, 200, 360),
    agentPanelWidth: sanitizePanelWidth(value.agentPanelWidth, 360, 320, 520),
  };
}

function sanitizePanelWidth(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(Math.max(value, min), max));
}

export type AppStore =
  UiState & UiActions &
  ConfigState & ConfigActions &
  SessionState & SessionActions &
  TaskState & TaskActions &
  DashboardState & DashboardActions &
  FeedbackState & FeedbackActions &
  SessionEphemeralState & SessionEphemeralActions & {
    resetStore(): void;
  };

let initialStoreSnapshot: Partial<AppStore> | undefined;

const useAppStoreBase = create<AppStore>()(
  persist<AppStore, [], [], Partial<AppStore>>(
    (...a) => {
      const [set, get] = a;
      return {
        ...uiSlice(...a),
        ...configSlice(...a),
        ...sessionSlice(...a),
        ...taskSlice(...a),
        ...dashboardSlice(...a),
        ...feedbackSlice(...a),
        sessionDrafts: {},
        selectedFilesBySessionId: {},
        attachmentsBySessionId: {},
        saveSessionEphemeralState: (sessionId?: string) => {
          if (!sessionId) return;
          const state = get();
          set({
            sessionDrafts: { ...state.sessionDrafts, [sessionId]: state.userInput },
            selectedFilesBySessionId: { ...state.selectedFilesBySessionId, [sessionId]: state.selectedFiles },
            attachmentsBySessionId: { ...state.attachmentsBySessionId, [sessionId]: state.attachments },
          } as Partial<AppStore>);
        },
        restoreSessionEphemeralState: (sessionId?: string) => {
          if (!sessionId) {
            set({ userInput: "", selectedFiles: [], attachments: [] } as Partial<AppStore>);
            return;
          }
          const state = get();
          set({
            userInput: state.sessionDrafts[sessionId] ?? "",
            selectedFiles: state.selectedFilesBySessionId[sessionId] ?? [],
            attachments: state.attachmentsBySessionId[sessionId] ?? [],
          } as Partial<AppStore>);
        },
        setSessionEphemeralState: (sessionId, patch) => {
          if (!sessionId) return;
          const state = get();
          const nextDraft = patch.userInput ?? (state.activeSessionId === sessionId ? state.userInput : state.sessionDrafts[sessionId] ?? "");
          const nextSelectedFiles = patch.selectedFiles ?? (state.activeSessionId === sessionId ? state.selectedFiles : state.selectedFilesBySessionId[sessionId] ?? []);
          const nextAttachments = patch.attachments ?? (state.activeSessionId === sessionId ? state.attachments : state.attachmentsBySessionId[sessionId] ?? []);
          set({
            sessionDrafts: { ...state.sessionDrafts, [sessionId]: nextDraft },
            selectedFilesBySessionId: { ...state.selectedFilesBySessionId, [sessionId]: nextSelectedFiles },
            attachmentsBySessionId: { ...state.attachmentsBySessionId, [sessionId]: nextAttachments },
            ...(state.activeSessionId === sessionId
              ? { userInput: nextDraft, selectedFiles: nextSelectedFiles, attachments: nextAttachments }
              : {}),
          } as Partial<AppStore>);
        },
        clearSessionEphemeralState: (sessionId?: string) => {
          if (!sessionId) return;
          const state = get();
          const { [sessionId]: _draft, ...sessionDrafts } = state.sessionDrafts;
          const { [sessionId]: _files, ...selectedFilesBySessionId } = state.selectedFilesBySessionId;
          const { [sessionId]: _attachments, ...attachmentsBySessionId } = state.attachmentsBySessionId;
          set({
            sessionDrafts,
            selectedFilesBySessionId,
            attachmentsBySessionId,
            ...(state.activeSessionId === sessionId ? { userInput: "", selectedFiles: [], attachments: [] } : {}),
          } as Partial<AppStore>);
        },
        resetStore: () => {
          if (initialStoreSnapshot) {
            set({ ...initialStoreSnapshot } as AppStore);
          }
        },
      };
    },
    { 
      name: "hermes-workbench",
      storage: createResilientStorage<Partial<AppStore>>(),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(sanitizePersistedState(persistedState) as Partial<AppStore>),
      } as AppStore),
      partialize: sanitizePersistedState,
    }
  )
);
initialStoreSnapshot = useAppStoreBase.getInitialState();

export const useAppStore = useAppStoreBase;
