import { useEffect, useRef } from "react";
import { PanelLeftOpen } from "lucide-react";
import type { SessionMetaPatch, WorkSession } from "../../shared/types";
import { useAppStore } from "../store";
import { ContextInspector } from "./ContextInspector";
import { PureChatContainer } from "./PureChatContainer";
import { IconRail } from "./components/IconRail";
import { SessionSidebar } from "./components/SessionSidebar";
import { HermesHeader } from "./components/HermesHeader";
import { WorkspaceDrawer } from "./components/WorkspaceDrawer";
import { ControlCenter } from "./components/ControlCenter";
import { AgentRunPanel } from "./components/AgentRunPanel";

type PanelId = ReturnType<typeof useAppStore.getState>["activePanel"];
type FixTarget = "model" | "hermes" | "health" | "diagnostics";
export function DashboardView(props: {
  onPickWorkspace: () => void;
  onSelectWorkspace: (workspacePath: string) => void;
  onCreateSession: () => void;
  onSelectSession: (session: WorkSession | string) => void;
  onDeleteSession: (session: WorkSession) => void;
  onDuplicateSession?: (session: WorkSession) => void;
  onExportSession?: (session: WorkSession, format: "json" | "markdown") => void;
  onImportSession?: () => void;
  onRenameSession: (title: string) => void;
  onUpdateActiveSessionMeta?: (patch: SessionMetaPatch) => void;
  onUpdateSessionMeta?: (sessionId: string, patch: SessionMetaPatch) => void;
  onOpenSessionFolder: () => void;
  onOpenSupport: () => void;
  onClearSession: () => void;
  onStartTask: () => void;
  onCancelTask: () => void;
  onRestoreSnapshot: () => void;
  onRefreshFileTree: () => void;
  onExportDiagnostics: () => void;
  onOpenFix?: (target: FixTarget) => void;
  onRefreshWebUiOverview?: () => Promise<unknown>;
}) {
  const store = useAppStore();
  const latestSnapshot = store.snapshots[0];
  const activeLock = store.locks[0];
  const sendBlock = computeSendBlock(store);
  const canStart = !sendBlock;
  const runs = (store.activeSessionId ? (store.taskRunOrderBySession[store.activeSessionId] ?? []) : [])
    .map((taskRunId) => store.taskRunProjectionsById[taskRunId])
    .filter((run): run is NonNullable<typeof run> => Boolean(run));

  const hasRefreshed = useRef(false);

  function toggleInspector() {
    const nextOpen = !store.inspectorOpen;
    store.setInspectorOpen(nextOpen);
    if (nextOpen) store.setAgentPanelOpen(false);
  }

  function toggleAgentPanel() {
    const nextOpen = !store.agentPanelOpen;
    store.setAgentPanelOpen(nextOpen);
    if (nextOpen) store.setInspectorOpen(false);
  }

  useEffect(() => {
    if (hasRefreshed.current) return;
    hasRefreshed.current = true;
    
    // 延迟500ms再加载，让UI先渲染
    const timer = setTimeout(() => {
      void props.onRefreshWebUiOverview?.();
    }, 500);
    
    return () => clearTimeout(timer);
  }, []);

  return (
    <section className="absolute inset-0 flex overflow-hidden bg-[#f6f8fb] text-slate-900">
      <IconRail />
      <div className="relative flex min-w-0 flex-1 flex-col overflow-visible">
        <HermesHeader
          onRenameSession={props.onRenameSession}
          onClearSession={props.onClearSession}
          onToggleInspector={toggleInspector}
          onToggleWorkspace={() => store.setWorkspaceDrawerOpen(!store.workspaceDrawerOpen)}
          onToggleAgentPanel={toggleAgentPanel}
          onUpdateActiveSessionMeta={props.onUpdateActiveSessionMeta ?? (() => undefined)}
          onOpenSessionFolder={props.onOpenSessionFolder}
          onOpenSupport={props.onOpenSupport}
          inspectorOpen={store.inspectorOpen}
          agentPanelOpen={store.agentPanelOpen}
        />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div
            className={[
              "shrink-0 overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              store.sessionSidebarOpen
                ? "w-[228px] translate-x-0 opacity-100 xl:w-[240px]"
                : "pointer-events-none w-0 -translate-x-2 opacity-0",
            ].join(" ")}
            data-testid="session-sidebar-shell"
          >
            <SessionSidebar
              onCreateSession={props.onCreateSession}
              onSelectSession={props.onSelectSession}
              onDeleteSession={props.onDeleteSession}
              onDuplicateSession={props.onDuplicateSession ?? (() => undefined)}
              onExportSession={props.onExportSession ?? (() => undefined)}
              onImportSession={props.onImportSession ?? (() => undefined)}
              onUpdateSessionMeta={props.onUpdateSessionMeta ?? ((_sessionId, _patch) => undefined)}
              onCollapse={() => store.setSessionSidebarOpen(false)}
            />
          </div>

          {!store.sessionSidebarOpen ? (
            <button
              aria-label="显示历史会话栏"
              className="absolute left-2 top-3 z-20 grid h-9 w-9 place-items-center rounded-xl border border-slate-200/80 bg-white/95 text-slate-500 shadow-[0_10px_28px_rgba(15,23,42,0.12)] backdrop-blur transition hover:border-[var(--hermes-primary-border)] hover:bg-[var(--hermes-primary-soft)] hover:text-[var(--hermes-primary)]"
              onClick={() => store.setSessionSidebarOpen(true)}
              title="显示历史会话栏"
              type="button"
            >
              <PanelLeftOpen size={16} />
            </button>
          ) : null}

          {store.activePanel === "chat" ? (
            <div className="min-w-0 flex-1">
              <PureChatContainer
                runs={runs}
                onPickWorkspace={props.onPickWorkspace}
                onCreateSession={props.onCreateSession}
                onClearSession={props.onClearSession}
                onStartTask={props.onStartTask}
                onCancelTask={props.onCancelTask}
                onRestoreSnapshot={props.onRestoreSnapshot}
                onOpenFix={props.onOpenFix}
                onUsePromptSuggestion={(prompt) => store.setUserInput(prompt)}
                canStart={canStart}
                sendBlockReason={sendBlock?.message}
                sendBlockTarget={sendBlock?.target}
                latestSnapshotAvailable={Boolean(latestSnapshot)}
                locked={Boolean(activeLock)}
              />
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <ControlCenter
                onRefresh={props.onRefreshWebUiOverview ?? (async () => undefined)}
                onOpenSettings={() => store.setView("settings")}
                onClearSession={props.onClearSession}
                onOpenSessionFolder={props.onOpenSessionFolder}
                onExportDiagnostics={props.onExportDiagnostics}
              />
            </div>
          )}

          <div
            className={[
              "shrink-0 overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              store.agentPanelOpen
                ? "w-[360px] translate-x-0 opacity-100"
                : "pointer-events-none w-0 translate-x-2 opacity-0",
            ].join(" ")}
            data-testid="agent-panel-shell"
          >
            <AgentRunPanel open={store.agentPanelOpen} onClose={() => store.setAgentPanelOpen(false)} onOpenFix={props.onOpenFix} />
          </div>

        </div>
      </div>

      <WorkspaceDrawer onPickWorkspace={props.onPickWorkspace} onSelectWorkspace={props.onSelectWorkspace} onRefreshFileTree={props.onRefreshFileTree} />

      <ContextInspector
        open={store.inspectorOpen}
        onClose={() => store.setInspectorOpen(false)}
        onRefreshFileTree={props.onRefreshFileTree}
        onRestoreSnapshot={props.onRestoreSnapshot}
        onExportDiagnostics={props.onExportDiagnostics}
        onOpenSessionFolder={props.onOpenSessionFolder}
      />
    </section>
  );
}

function computeSendBlock(store: ReturnType<typeof useAppStore.getState>): { message: string; target?: FixTarget } | undefined {
  if (store.runningTaskRunId) return { message: "当前任务运行中，完成或停止后再发送。" };
  if (!store.userInput.trim() && store.attachments.length === 0) return { message: "写一句需求或添加附件后就能发送。" };

  const defaultProfile = store.runtimeConfig?.modelProfiles.find((profile) => profile.id === store.runtimeConfig?.defaultModelProfileId)
    ?? store.runtimeConfig?.modelProfiles[0];
  if (!defaultProfile?.model?.trim()) {
    return { message: "未配置可用模型。", target: "model" };
  }

  const criticalBlocker = store.setupSummary?.blocking.find((check) => {
    if (check.id === "model" || check.id === "model-secret") return true;
    if (check.id === "hermes") return store.hermesStatus?.engine.available === false;
    if (check.id === "workspace") return Boolean(store.workspacePath.trim()) && store.taskType !== "custom";
    return false;
  });
  if (criticalBlocker) {
    const action = criticalBlocker.fixAction;
    return {
      message: criticalBlocker.message || "运行环境还有阻塞项。",
      target: action === "configure_model" ? "model" : action === "configure_hermes" || action === "open_settings" ? "hermes" : "health",
    };
  }

  return undefined;
}
