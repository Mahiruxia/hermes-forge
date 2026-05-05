import { PanelLeftOpen } from "lucide-react";
import type { KeyboardEvent, PointerEvent } from "react";
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
import { hasInlineLocalFilePath } from "../../shared/local-file-paths";

type PanelId = ReturnType<typeof useAppStore.getState>["activePanel"];
type FixTarget = "model" | "hermes" | "health" | "diagnostics" | "workspace";
type ResizablePanel = "session" | "agent";

const DEFAULT_SESSION_SIDEBAR_WIDTH = 228;
const DEFAULT_AGENT_PANEL_WIDTH = 360;
const SESSION_SIDEBAR_MIN_WIDTH = 200;
const SESSION_SIDEBAR_MAX_WIDTH = 360;
const AGENT_PANEL_MIN_WIDTH = 320;
const AGENT_PANEL_MAX_WIDTH = 520;
const ICON_RAIL_WIDTH = 56;
const MIN_MAIN_CONTENT_WIDTH = 360;

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
  const activeSession = store.sessions.find((session) => session.id === store.activeSessionId);
  const sessionSidebarWidth = clampPanelWidth(
    store.sessionSidebarWidth,
    "session",
    store.agentPanelOpen ? store.agentPanelWidth : 0,
  );
  const agentPanelWidth = clampPanelWidth(
    store.agentPanelWidth,
    "agent",
    store.sessionSidebarOpen ? store.sessionSidebarWidth : 0,
  );

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

  function resizePanel(panel: ResizablePanel, width: number) {
    if (panel === "session") {
      store.setSessionSidebarWidth(clampPanelWidth(width, panel, store.agentPanelOpen ? agentPanelWidth : 0));
    } else {
      store.setAgentPanelWidth(clampPanelWidth(width, panel, store.sessionSidebarOpen ? sessionSidebarWidth : 0));
    }
  }

  function startPanelResize(panel: ResizablePanel, event: PointerEvent<HTMLDivElement>) {
    if (!Number.isFinite(event.clientX)) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel === "session" ? sessionSidebarWidth : agentPanelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(moveEvent: globalThis.PointerEvent) {
      if (!Number.isFinite(moveEvent.clientX)) return;
      const delta = moveEvent.clientX - startX;
      const nextWidth = panel === "session" ? startWidth + delta : startWidth - delta;
      resizePanel(panel, nextWidth);
    }

    function cleanup() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }

  function handleResizeKey(panel: ResizablePanel, event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentWidth = panel === "session" ? sessionSidebarWidth : agentPanelWidth;
    const step = event.shiftKey ? 24 : 12;
    if (event.key === "Home") {
      resizePanel(panel, panel === "session" ? SESSION_SIDEBAR_MIN_WIDTH : AGENT_PANEL_MIN_WIDTH);
      return;
    }
    if (event.key === "End") {
      resizePanel(panel, panel === "session" ? SESSION_SIDEBAR_MAX_WIDTH : AGENT_PANEL_MAX_WIDTH);
      return;
    }
    const direction = event.key === "ArrowRight" ? 1 : -1;
    resizePanel(panel, currentWidth + (panel === "session" ? direction : -direction) * step);
  }

  return (
    <section className="absolute inset-0 flex overflow-hidden bg-[#f6f8fb] text-slate-900">
      <IconRail />
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <HermesHeader
          onRenameSession={props.onRenameSession}
          onClearSession={props.onClearSession}
          onDeleteActiveSession={() => activeSession && props.onDeleteSession(activeSession)}
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
              "relative shrink-0 overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              store.sessionSidebarOpen
                ? "translate-x-0 opacity-100"
                : "pointer-events-none w-0 -translate-x-2 opacity-0",
            ].join(" ")}
            data-testid="session-sidebar-shell"
            style={store.sessionSidebarOpen ? { width: sessionSidebarWidth } : undefined}
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
            {store.sessionSidebarOpen ? (
              <PanelResizeHandle
                label="调整历史会话栏宽度"
                min={SESSION_SIDEBAR_MIN_WIDTH}
                max={SESSION_SIDEBAR_MAX_WIDTH}
                value={sessionSidebarWidth}
                side="right"
                onPointerDown={(event) => startPanelResize("session", event)}
                onKeyDown={(event) => handleResizeKey("session", event)}
                onDoubleClick={() => resizePanel("session", DEFAULT_SESSION_SIDEBAR_WIDTH)}
              />
            ) : null}
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
              />
            </div>
          )}

          <div
            className={[
              "relative shrink-0 overflow-hidden transition-[width,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              store.agentPanelOpen
                ? "translate-x-0 opacity-100"
                : "pointer-events-none w-0 translate-x-2 opacity-0",
            ].join(" ")}
            data-testid="agent-panel-shell"
            style={store.agentPanelOpen ? { width: agentPanelWidth } : undefined}
          >
            {store.agentPanelOpen ? (
              <PanelResizeHandle
                label="调整 Agent 面板宽度"
                min={AGENT_PANEL_MIN_WIDTH}
                max={AGENT_PANEL_MAX_WIDTH}
                value={agentPanelWidth}
                side="left"
                onPointerDown={(event) => startPanelResize("agent", event)}
                onKeyDown={(event) => handleResizeKey("agent", event)}
                onDoubleClick={() => resizePanel("agent", DEFAULT_AGENT_PANEL_WIDTH)}
              />
            ) : null}
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
        onOpenSessionFolder={props.onOpenSessionFolder}
      />
    </section>
  );
}

function PanelResizeHandle(props: {
  label: string;
  min: number;
  max: number;
  value: number;
  side: "left" | "right";
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuemax={props.max}
      aria-valuemin={props.min}
      aria-valuenow={Math.round(props.value)}
      className={[
        "hermes-panel-resizer group absolute top-0 z-30 flex h-full w-3 cursor-col-resize items-center justify-center outline-none",
        props.side === "right" ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2",
      ].join(" ")}
      onDoubleClick={props.onDoubleClick}
      onKeyDown={props.onKeyDown}
      onPointerDown={props.onPointerDown}
      role="separator"
      tabIndex={0}
    >
      <span className="h-10 w-0.5 rounded-full bg-slate-300/0 transition group-hover:bg-[var(--hermes-primary-border)] group-focus-visible:bg-[var(--hermes-primary)] group-active:bg-[var(--hermes-primary)]" />
    </div>
  );
}

function clampPanelWidth(width: number, panel: ResizablePanel, otherPanelWidth: number) {
  const min = panel === "session" ? SESSION_SIDEBAR_MIN_WIDTH : AGENT_PANEL_MIN_WIDTH;
  const max = panel === "session" ? SESSION_SIDEBAR_MAX_WIDTH : AGENT_PANEL_MAX_WIDTH;
  const viewport = typeof window === "undefined" ? 1280 : window.innerWidth || 1280;
  const responsiveMax = Math.max(min, viewport - ICON_RAIL_WIDTH - MIN_MAIN_CONTENT_WIDTH - otherPanelWidth);
  return Math.round(Math.min(Math.max(width, min), max, responsiveMax));
}

function computeSendBlock(store: ReturnType<typeof useAppStore.getState>): { message: string; target?: FixTarget } | undefined {
  if (store.runningTaskRunId) return { message: "当前任务运行中，完成或停止后再发送。" };
  if (!store.userInput.trim() && store.attachments.length === 0) return { message: "写一句需求或添加附件后就能发送。" };
  if (!store.workspacePath.trim() && promptNeedsWorkspace(store.userInput, store.selectedFiles)) {
    return { message: "这类请求需要先选择项目目录，否则 Forge 无法像原版 CLI 那样在真实工作区读取文件。", target: "workspace" };
  }

  const defaultProfile = store.runtimeConfig?.modelProfiles.find((profile) => profile.id === store.runtimeConfig?.defaultModelProfileId)
    ?? store.runtimeConfig?.modelProfiles[0];
  if (!defaultProfile?.model?.trim()) {
    return { message: "未配置可用模型。", target: "model" };
  }
  if (defaultProfile.provider === "local" && defaultProfile.model === "mock-model") {
    return { message: "当前默认模型是占位配置 mock-model，请在设置中配置真实模型。", target: "model" };
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
