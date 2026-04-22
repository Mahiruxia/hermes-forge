import { combine } from "zustand/middleware";
import type { FileLockState, FileTreeResult, SessionAgentInsight, SessionAttachment, SnapshotRecord, WorkSession } from "../../shared/types";
import type { RecentWorkspace } from "../store";

export interface SessionState {
  workspacePath: string;
  sessionFilesPath: string;
  sessions: WorkSession[];
  activeSessionId?: string;
  recentWorkspaces: RecentWorkspace[];
  selectedFiles: string[];
  attachments: SessionAttachment[];
  fileTree?: FileTreeResult;
  locks: FileLockState[];
  snapshots: SnapshotRecord[];
  sessionAgentInsight?: SessionAgentInsight;
}

export interface SessionActions {
  setWorkspacePath(path: string): void;
  setSessionFilesPath(path: string): void;
  setSessions(sessions: WorkSession[]): void;
  setActiveSession(sessionId?: string): void;
  upsertSession(session: WorkSession): void;
  setRecentWorkspaces(workspaces: RecentWorkspace[]): void;
  rememberWorkspace(path: string): void;
  toggleSelectedFile(path: string): void;
  clearSelectedFiles(): void;
  addAttachments(attachments: SessionAttachment[]): void;
  removeAttachment(id: string): void;
  clearAttachments(): void;
  setFileTree(fileTree?: FileTreeResult): void;
  setLocks(locks: FileLockState[]): void;
  setSnapshots(snapshots: SnapshotRecord[]): void;
  setSessionAgentInsight(insight?: SessionAgentInsight): void;
}

export const sessionSlice = combine<SessionState, SessionActions>(
  {
    workspacePath: "",
    sessionFilesPath: "",
    sessions: [],
    activeSessionId: undefined,
    recentWorkspaces: [],
    selectedFiles: [],
    attachments: [],
    fileTree: undefined,
    locks: [],
    snapshots: [],
    sessionAgentInsight: undefined,
  },
  (set) => ({
    setWorkspacePath: (path: string) => set({ workspacePath: path }),
    setSessionFilesPath: (path: string) => set({ sessionFilesPath: path }),
    setSessions: (sessions: WorkSession[]) => set({ sessions }),
    setActiveSession: (sessionId?: string) => set({ activeSessionId: sessionId }),
    upsertSession: (session: WorkSession) =>
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== session.id).concat(session),
      })),
    setRecentWorkspaces: (workspaces: RecentWorkspace[]) => set({ recentWorkspaces: workspaces }),
    rememberWorkspace: (path: string) =>
      set((state) => {
        const existing = state.recentWorkspaces.find((w) => w.path === path);
        if (existing) {
          return {
            recentWorkspaces: state.recentWorkspaces.map((w) =>
              w.path === path ? { ...w, lastOpenedAt: new Date().toISOString() } : w
            ),
          };
        }
        return {
          recentWorkspaces: [
            { path, name: path.split(/[\\/]/).pop() || path, lastOpenedAt: new Date().toISOString() },
            ...state.recentWorkspaces,
          ].slice(0, 10),
        };
      }),
    toggleSelectedFile: (path: string) =>
      set((state) => ({
        selectedFiles: state.selectedFiles.includes(path)
          ? state.selectedFiles.filter((p) => p !== path)
          : [...state.selectedFiles, path],
      })),
    clearSelectedFiles: () => set({ selectedFiles: [] }),
    addAttachments: (attachments: SessionAttachment[]) =>
      set((state) => ({ attachments: [...state.attachments, ...attachments] })),
    removeAttachment: (id: string) =>
      set((state) => ({ attachments: state.attachments.filter((a) => a.id !== id) })),
    clearAttachments: () => set({ attachments: [] }),
    setFileTree: (fileTree?: FileTreeResult) => set({ fileTree }),
    setLocks: (locks: FileLockState[]) => set({ locks }),
    setSnapshots: (snapshots: SnapshotRecord[]) => set({ snapshots }),
    setSessionAgentInsight: (sessionAgentInsight?: SessionAgentInsight) => set({ sessionAgentInsight }),
  })
);
