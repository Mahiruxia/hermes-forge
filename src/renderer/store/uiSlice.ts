import { combine } from "zustand/middleware";
import type { ApprovalRequest, ClarifyRequest, TaskType } from "../../shared/types";

export type ViewId = "home" | "engines" | "memory" | "admin" | "settings" | "logs";

export interface UiState {
  view: ViewId;
  userInput: string;
  inspectorOpen: boolean;
  controlCenterOpen: boolean;
  workspaceDrawerOpen: boolean;
  agentPanelOpen: boolean;
  sessionSidebarOpen: boolean;
  activePanel: "chat" | "tasks" | "skills" | "memory" | "connectors" | "files" | "profiles" | "settings" | "spaces" | "projects";
  activeProfile?: string;
  selectedProjectId?: string;
  sidebarGrouping: "smart" | "project" | "time";
  pendingApprovalCards: ApprovalRequest[];
  pendingClarifyCards: ClarifyRequest[];
  lastWebUiError?: string;
  taskType: TaskType;
  firstLaunch: boolean;
}

export interface UiActions {
  setView(view: ViewId): void;
  setUserInput(userInput: string): void;
  setInspectorOpen(open: boolean): void;
  setControlCenterOpen(open: boolean): void;
  setWorkspaceDrawerOpen(open: boolean): void;
  setAgentPanelOpen(open: boolean): void;
  setSessionSidebarOpen(open: boolean): void;
  setActivePanel(panel: UiState["activePanel"]): void;
  setSelectedProject(projectId?: string): void;
  setSidebarGrouping(grouping: UiState["sidebarGrouping"]): void;
  setLastWebUiError(error?: string): void;
  upsertApprovalCard(card: ApprovalRequest): void;
  resolveApprovalCard(id: string, status: ApprovalRequest["status"]): void;
  upsertClarifyCard(card: ClarifyRequest): void;
  resolveClarifyCard(id: string, status: ClarifyRequest["status"]): void;
  setTaskType(taskType: TaskType): void;
  setFirstLaunch(firstLaunch: boolean): void;
}

export const uiSlice = combine<UiState, UiActions>(
  {
    view: "home",
    userInput: "",
    inspectorOpen: false,
    controlCenterOpen: false,
    workspaceDrawerOpen: false,
    agentPanelOpen: false,
    sessionSidebarOpen: true,
    activePanel: "chat",
    activeProfile: undefined,
    selectedProjectId: undefined,
    sidebarGrouping: "smart",
    pendingApprovalCards: [],
    pendingClarifyCards: [],
    lastWebUiError: undefined,
    taskType: "custom",
    firstLaunch: true,
  },
  (set) => ({
    setView: (view: ViewId) => set({ view }),
    setUserInput: (userInput: string) => set({ userInput }),
    setInspectorOpen: (open: boolean) => set({ inspectorOpen: open }),
    setControlCenterOpen: (open: boolean) => set({ controlCenterOpen: open }),
    setWorkspaceDrawerOpen: (open: boolean) => set({ workspaceDrawerOpen: open }),
    setAgentPanelOpen: (open: boolean) => set({ agentPanelOpen: open }),
    setSessionSidebarOpen: (open: boolean) => set({ sessionSidebarOpen: open }),
    setActivePanel: (panel: UiState["activePanel"]) => set({ activePanel: panel }),
    setSelectedProject: (projectId?: string) => set({ selectedProjectId: projectId }),
    setSidebarGrouping: (grouping: UiState["sidebarGrouping"]) => set({ sidebarGrouping: grouping }),
    setLastWebUiError: (error?: string) => set({ lastWebUiError: error }),
    upsertApprovalCard: (card: ApprovalRequest) =>
      set((state) => ({
        pendingApprovalCards: state.pendingApprovalCards.filter((c) => c.id !== card.id).concat(card),
      })),
    resolveApprovalCard: (id: string, status: ApprovalRequest["status"]) =>
      set((state) => ({
        pendingApprovalCards: state.pendingApprovalCards.filter((c) => !(c.id === id && c.status === "pending")),
      })),
    upsertClarifyCard: (card: ClarifyRequest) =>
      set((state) => ({
        pendingClarifyCards: state.pendingClarifyCards.filter((c) => c.id !== card.id).concat(card),
      })),
    resolveClarifyCard: (id: string, status: ClarifyRequest["status"]) =>
      set((state) => ({
        pendingClarifyCards: state.pendingClarifyCards.filter((c) => !(c.id === id && c.status === "pending")),
      })),
    setTaskType: (taskType: TaskType) => set({ taskType }),
    setFirstLaunch: (firstLaunch: boolean) => set({ firstLaunch }),
  })
);
