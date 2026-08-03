import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "./DashboardView";
import { ChatInput } from "./ChatInput";
import { useAppStore } from "../store";
import type { PermissionOverview, WorkSession } from "../../shared/types";

describe("DashboardView", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    useAppStore.getState().resetStore();
    useAppStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "测试会话",
          status: "idle",
          sessionFilesPath: "D:/temp/session-1",
          workspacePath: "D:/workspace/demo",
          workspaceStatus: "ready",
          createdAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:00.000Z",
          lastMessagePreview: "hello",
        },
      ],
      activeSessionId: "session-1",
      workspacePath: "D:/workspace/demo",
      runtimeConfig: {
        defaultModelProfileId: "custom-local-endpoint",
        modelProfiles: [{ id: "custom-local-endpoint", provider: "custom", model: "qwen", baseUrl: "http://127.0.0.1:1234/v1" }],
        updateSources: {},
      },
      webUiOverview: {
        settings: { theme: "green-light", language: "zh", sendKey: "enter", sendKeyHintDismissed: true, showUsage: false, showCliSessions: true },
        projects: [{ id: "project-1", name: "项目 A", color: "#10b981", createdAt: "2026-04-18T10:00:00.000Z", updatedAt: "2026-04-18T10:00:00.000Z" }],
        spaces: [],
        skills: [],
        memory: [],
        crons: [],
        profiles: [{ id: "default", name: "default", path: "C:/Users/example/.hermes", active: true, hasConfig: false, skillCount: 0, memoryFiles: 0 }],
        slashCommands: [],
      },
    });
  });

  function renderView(overrides?: {
    onOpenFix?: (target: "model" | "hermes" | "health" | "diagnostics" | "workspace") => void;
    onDeleteSession?: (session: WorkSession) => void;
    onCancelTask?: () => void;
    onCreateSession?: () => void;
    onPickWorkspace?: () => void;
  }) {
    const onDeleteSession = overrides?.onDeleteSession ?? vi.fn();
    const view = render(
      <DashboardView
        onPickWorkspace={overrides?.onPickWorkspace ?? vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCreateSession={overrides?.onCreateSession ?? vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={onDeleteSession}
        onRenameSession={vi.fn()}
        onOpenSessionFolder={vi.fn()}
        onOpenSupport={vi.fn()}
        onClearSession={vi.fn()}
        onStartTask={vi.fn()}
        onCancelTask={overrides?.onCancelTask ?? vi.fn()}
        onRestoreSnapshot={vi.fn()}
        onRefreshFileTree={vi.fn()}
        onOpenFix={overrides?.onOpenFix}
      />,
    );
    return { ...view, onDeleteSession };
  }

  function permissionOverview(input: Partial<PermissionOverview>): PermissionOverview {
    return {
      runtime: "wsl",
      permissionPolicy: "bridge_guarded",
      cliPermissionMode: "guarded",
      transport: "native-arg-env",
      sessionMode: "fresh",
      bridge: {
        enabled: true,
        running: true,
        capabilities: ["windows.files.writeText", "windows.powershell.run"],
        capabilityCount: 2,
        reportedByBackend: true,
      },
      enforcement: {
        hardEnforceable: ["windowsBridgeTools: gated"],
        softGuarded: ["cliDangerousCommandApproval: guarded"],
        notEnforceableYet: ["shell: not hard-blocked"],
      },
      blocked: false,
      blockReason: null,
      capabilityProbe: {
        minimumSatisfied: true,
        cliVersion: "0.12.0",
        missing: [],
        allowedTransports: ["native-arg-env"],
        support: "native",
      },
      runtimeReady: true,
      notes: [],
      ...input,
    };
  }

  it("shows the session sidebar by default and toggles it manually", () => {
    renderView();

    const shell = screen.getByTestId("session-sidebar-shell");
    const inputShell = screen.getByTestId("chat-input-shell");
    expect(shell).toHaveStyle({ width: "228px" });
    expect(shell).toHaveClass("opacity-100");
    expect(inputShell).toHaveClass("max-w-[1120px]");
    expect(inputShell).toHaveClass("2xl:max-w-[1240px]");
    expect(screen.getAllByText("测试会话").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "隐藏历史会话栏" }));

    expect(shell).toHaveClass("w-0");
    expect(shell).toHaveClass("opacity-0");
    expect(shell).toHaveClass("-translate-x-2");
    expect(shell).toHaveClass("pointer-events-none");
    const restoreButton = screen.getByRole("button", { name: "显示历史会话栏" });
    expect(restoreButton).toBeInTheDocument();
    expect(restoreButton).toHaveClass("top-3");
    expect(restoreButton).toHaveClass("h-9");
    expect(restoreButton).toHaveClass("rounded-xl");

    fireEvent.click(restoreButton);

    expect(shell).toHaveStyle({ width: "228px" });
    expect(shell).toHaveClass("translate-x-0");
    expect(shell).toHaveClass("opacity-100");
    expect(screen.queryByRole("button", { name: "显示历史会话栏" })).toBeNull();
  });

  it("adapts the right control panel as a collapsible layout column", () => {
    const onOpenFix = vi.fn();
    renderView({ onOpenFix });

    const shell = screen.getByTestId("agent-panel-shell");
    expect(shell).toHaveClass("w-0");
    expect(shell).toHaveClass("opacity-0");
    expect(shell).toHaveClass("pointer-events-none");
    expect(screen.queryByRole("button", { name: "显示右侧控制面板" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Agent 面板" }));

    expect(shell).toHaveStyle({ width: "360px" });
    expect(shell).toHaveClass("translate-x-0");
    expect(shell).toHaveClass("opacity-100");
    expect(screen.queryByRole("button", { name: "显示右侧控制面板" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /更换模型/ }));
    expect(onOpenFix).toHaveBeenCalledWith("model");

    fireEvent.click(screen.getByRole("button", { name: "关闭 Agent 面板" }));

    expect(shell).toHaveClass("w-0");
    expect(shell).toHaveClass("translate-x-2");
    expect(shell).toHaveClass("opacity-0");
  });

  it("renders clean chat shell with management and delete session actions", () => {
    useAppStore.setState({
      taskRunProjectionsById: {
        "task-1": {
          taskRunId: "task-1",
          workSessionId: "session-1",
          status: "complete",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [],
          startedAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:01.000Z",
          userMessage: {
            id: "u1",
            sessionId: "session-1",
            taskId: "task-1",
            role: "user",
            content: "你好",
            createdAt: "2026-04-18T10:00:00.000Z",
            visibleInChat: true,
          },
          assistantMessage: {
            id: "a1",
            sessionId: "session-1",
            taskId: "task-1",
            role: "agent",
            content: "我可以帮你分析项目。",
            status: "complete",
            actualEngine: "hermes",
            authorName: "Hermes",
            createdAt: "2026-04-18T10:00:01.000Z",
            visibleInChat: true,
          },
        },
      },
      taskRunOrderBySession: { "session-1": ["task-1"] },
    });

    renderView();

    expect(screen.getByRole("button", { name: "设置中心" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "删除" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Hermes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("我可以帮你分析项目。").length).toBeGreaterThan(0);
    const agentShell = screen.getByTestId("agent-panel-shell");
    const agentDrawer = document.querySelector('aside[aria-label="Agent 面板"]');
    expect(agentDrawer).not.toBeNull();
    expect(agentShell).toHaveClass("w-0");

    fireEvent.click(screen.getByRole("button", { name: "Agent 面板" }));

    expect(agentShell).toHaveStyle({ width: "360px" });

    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    expect(useAppStore.getState().agentPanelOpen).toBe(false);
    expect(useAppStore.getState().inspectorOpen).toBe(true);
    expect(agentShell).toHaveClass("w-0");

    fireEvent.click(screen.getByRole("button", { name: "Agent 面板" }));

    expect(useAppStore.getState().agentPanelOpen).toBe(true);
    expect(useAppStore.getState().inspectorOpen).toBe(false);
    expect(agentShell).toHaveStyle({ width: "360px" });
  });

  it("supports high-frequency workspace keyboard shortcuts", () => {
    const onCreateSession = vi.fn();
    const onPickWorkspace = vi.fn();
    renderView({ onCreateSession, onPickWorkspace });

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(onCreateSession).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(onPickWorkspace).toHaveBeenCalledTimes(1);

    const input = screen.getByLabelText("给 Hermes 发送消息");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(input).toHaveFocus();
  });

  it("opens and closes workspace files from the user-visible controls", () => {
    renderView();

    expect(useAppStore.getState().workspaceDrawerOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "工作区文件" }));
    expect(useAppStore.getState().workspaceDrawerOpen).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "收起工作区文件" }));
    expect(useAppStore.getState().workspaceDrawerOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "打开工作区文件" }));
    expect(useAppStore.getState().workspaceDrawerOpen).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().workspaceDrawerOpen).toBe(false);
  });

  it("renders long chats through a recent window and loads older runs on demand", () => {
    const projections = Object.fromEntries(
      Array.from({ length: 90 }, (_, index) => {
        const id = `task-${index}`;
        const at = new Date(Date.UTC(2026, 3, 18, 10, 0, index)).toISOString();
        return [id, {
          taskRunId: id,
          workSessionId: "session-1",
          status: "complete",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [],
          startedAt: at,
          updatedAt: at,
          userMessage: {
            id: `u-${index}`,
            sessionId: "session-1",
            taskId: id,
            role: "user",
            content: `问题 ${index}`,
            createdAt: at,
            visibleInChat: true,
          },
          assistantMessage: {
            id: `a-${index}`,
            sessionId: "session-1",
            taskId: id,
            role: "agent",
            content: `回答 ${index}`,
            status: "complete",
            actualEngine: "hermes",
            createdAt: at,
            visibleInChat: true,
          },
        }];
      }),
    );
    useAppStore.setState({
      taskRunProjectionsById: projections,
      taskRunOrderBySession: { "session-1": Array.from({ length: 90 }, (_, index) => `task-${index}`) },
    });

    renderView();

    expect(screen.getAllByTestId("chat-run")).toHaveLength(64);
    expect(screen.queryByText("问题 0")).toBeNull();
    expect(screen.getByText("问题 89")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("load-older-runs"));

    expect(screen.getAllByTestId("chat-run")).toHaveLength(90);
    expect(screen.getByText("问题 0")).toBeInTheDocument();
  });

  it("offers markdown export for very long assistant replies", () => {
    useAppStore.setState({
      taskRunProjectionsById: {
        "task-long": {
          taskRunId: "task-long",
          workSessionId: "session-1",
          status: "complete",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [],
          startedAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:01.000Z",
          userMessage: {
            id: "u-long",
            sessionId: "session-1",
            taskId: "task-long",
            role: "user",
            content: "整理这次更新",
            createdAt: "2026-04-18T10:00:00.000Z",
            visibleInChat: true,
          },
          assistantMessage: {
            id: "a-long",
            sessionId: "session-1",
            taskId: "task-long",
            role: "agent",
            content: `长回复\n\n${"内容".repeat(7000)}`,
            status: "complete",
            actualEngine: "hermes",
            authorName: "Hermes",
            createdAt: "2026-04-18T10:00:01.000Z",
            visibleInChat: true,
          },
        },
      },
      taskRunOrderBySession: { "session-1": ["task-long"] },
    });

    renderView();

    expect(screen.getByText("这条回复较长，建议导出为 Markdown 文件保存或转发。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 Markdown" })).toBeInTheDocument();
  });

  it("floats the scroll-to-bottom action above the composer without adding a layout row", async () => {
    useAppStore.setState({
      taskRunProjectionsById: {
        "task-1": {
          taskRunId: "task-1",
          workSessionId: "session-1",
          status: "complete",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [],
          startedAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:01.000Z",
          userMessage: {
            id: "u1",
            sessionId: "session-1",
            taskId: "task-1",
            role: "user",
            content: "你好",
            createdAt: "2026-04-18T10:00:00.000Z",
            visibleInChat: true,
          },
          assistantMessage: {
            id: "a1",
            sessionId: "session-1",
            taskId: "task-1",
            role: "agent",
            content: "我可以帮你分析项目。",
            status: "complete",
            actualEngine: "hermes",
            authorName: "Hermes",
            createdAt: "2026-04-18T10:00:01.000Z",
            visibleInChat: true,
          },
        },
      },
      taskRunOrderBySession: { "session-1": ["task-1"] },
    });

    const { container } = renderView();
    const scrollArea = container.querySelector(".hermes-chat-scroll") as HTMLElement;
    expect(scrollArea).toBeTruthy();
    Object.defineProperty(scrollArea, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scrollArea, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(scrollArea, "scrollTop", { configurable: true, value: 200 });

    fireEvent.scroll(scrollArea);

    const overlay = await screen.findByTestId("scroll-to-bottom-overlay");
    expect(overlay).toHaveClass("absolute");
    expect(overlay).toHaveClass("pointer-events-none");
    await waitFor(() => expect(overlay).toHaveStyle({ bottom: "168px" }));
    expect(screen.getByRole("button", { name: "回到底部" })).toHaveClass("pointer-events-auto");
  });

  it("keeps secondary header actions folded until the menu is opened", () => {
    renderView();
    const banner = screen.getByRole("banner");
    const header = within(banner);

    expect(header.getByText("测试会话")).toBeTruthy();
    expect(banner).toHaveClass("z-40");
    expect(header.getByTitle("Hermes Forge")).toBeTruthy();
    expect(header.getByRole("button", { name: "搜索" })).toBeTruthy();
    expect(header.getByRole("button", { name: "Agent 面板" })).toBeTruthy();
    expect(header.queryByRole("button", { name: "清空会话" })).toBeNull();
    expect(header.queryByRole("button", { name: "删除当前会话" })).toBeNull();

    fireEvent.click(header.getByRole("button", { name: "更多选项" }));

    expect(header.getByRole("button", { name: "官网" })).toBeTruthy();
    expect(header.getByRole("button", { name: "赞助与反馈" })).toBeTruthy();
    expect(header.getByRole("button", { name: "打开会话文件夹" })).toBeTruthy();
    expect(header.queryByRole("button", { name: "打开文件树" })).toBeNull();
    expect(header.getByRole("button", { name: "打开搜索与检查器" })).toBeTruthy();
    expect(header.getByRole("button", { name: "删除当前会话" })).toBeTruthy();
    expect(header.getByRole("button", { name: "清空会话" })).toBeTruthy();
  });

  it("confirms before deleting the active session from the header menu", () => {
    const onDeleteSession = vi.fn();
    renderView({ onDeleteSession });
    const header = within(screen.getByRole("banner"));

    fireEvent.click(header.getByRole("button", { name: "更多选项" }));
    fireEvent.click(header.getByRole("button", { name: "删除当前会话" }));

    expect(header.getByText("删除当前会话？")).toBeInTheDocument();
    expect(header.getByText(/会删除该会话记录和会话文件夹/)).toBeInTheDocument();

    fireEvent.click(header.getByRole("button", { name: "取消" }));
    expect(onDeleteSession).not.toHaveBeenCalled();
    expect(header.queryByText("删除当前会话？")).toBeNull();

    fireEvent.click(header.getByRole("button", { name: "删除当前会话" }));
    fireEvent.click(header.getByRole("button", { name: "删除" }));

    expect(onDeleteSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }));
  });

  it("resizes both side panels and preserves the chosen widths while collapsed", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
    renderView();
    const sessionShell = screen.getByTestId("session-sidebar-shell");
    const sessionResizer = screen.getByRole("separator", { name: "调整历史会话栏宽度" });

    act(() => {
      dispatchPointerEvent("pointerdown", 228, sessionResizer);
      dispatchPointerEvent("pointermove", 268);
      dispatchPointerEvent("pointerup", 268);
    });

    expect(useAppStore.getState().sessionSidebarWidth).toBe(268);
    expect(sessionShell).toHaveStyle({ width: "268px" });

    fireEvent.click(screen.getByRole("button", { name: "隐藏历史会话栏" }));
    expect(sessionShell).toHaveClass("w-0");
    fireEvent.click(screen.getByRole("button", { name: "显示历史会话栏" }));
    expect(sessionShell).toHaveStyle({ width: "268px" });

    fireEvent.click(screen.getByRole("button", { name: "Agent 面板" }));
    const agentShell = screen.getByTestId("agent-panel-shell");
    const agentResizer = screen.getByRole("separator", { name: "调整 Agent 面板宽度" });

    act(() => {
      dispatchPointerEvent("pointerdown", 800, agentResizer);
      dispatchPointerEvent("pointermove", 740);
      dispatchPointerEvent("pointerup", 740);
    });

    expect(useAppStore.getState().agentPanelWidth).toBe(420);
    expect(agentShell).toHaveStyle({ width: "420px" });
  });

  it("clamps panel width and supports keyboard reset controls", () => {
    renderView();
    const sessionResizer = screen.getByRole("separator", { name: "调整历史会话栏宽度" });

    fireEvent.keyDown(sessionResizer, { key: "Home" });
    expect(useAppStore.getState().sessionSidebarWidth).toBe(200);

    fireEvent.keyDown(sessionResizer, { key: "ArrowRight", shiftKey: true });
    expect(useAppStore.getState().sessionSidebarWidth).toBe(224);

    fireEvent.doubleClick(sessionResizer);
    expect(useAppStore.getState().sessionSidebarWidth).toBe(228);
  });

  it("prefers the latest task result in chat", () => {
    useAppStore.setState({
      taskRunProjectionsById: {
        "task-1": {
          taskRunId: "task-1",
          workSessionId: "session-1",
          status: "complete",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [],
          startedAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:03.000Z",
          userMessage: {
            id: "u1",
            sessionId: "session-1",
            taskId: "task-1",
            role: "user",
            content: "请问我们之前聊过什么",
            createdAt: "2026-04-18T10:00:00.000Z",
            visibleInChat: true,
          },
          assistantMessage: {
            id: "a1",
            sessionId: "session-1",
            taskId: "task-1",
            role: "agent",
            content: "我们之前聊过 Hermes 的工作区和 MEMORY.md。",
            status: "complete",
            actualEngine: "hermes",
            authorName: "Hermes",
            createdAt: "2026-04-18T10:00:01.000Z",
            visibleInChat: true,
          },
        },
      },
      taskRunOrderBySession: { "session-1": ["task-1"] },
    });

    renderView();

    expect(screen.getAllByText("我们之前聊过 Hermes 的工作区和 MEMORY.md。").length).toBeGreaterThan(0);
  });

  it("shows actual token usage in the message badge instead of the early estimate", () => {
    useAppStore.setState((state) => ({
      webUiOverview: state.webUiOverview ? {
        ...state.webUiOverview,
        settings: { ...state.webUiOverview.settings, showUsage: true },
      } : state.webUiOverview,
      taskRunProjectionsById: {
        "task-usage": {
          taskRunId: "task-usage",
          workSessionId: "session-1",
          status: "complete",
          engineId: "hermes",
          actualEngine: "hermes",
          modelId: "kimi-for-coding",
          toolEvents: [],
          startedAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:03.000Z",
          userMessage: {
            id: "u-usage",
            sessionId: "session-1",
            taskId: "task-usage",
            role: "user",
            content: "帮我看看 token",
            createdAt: "2026-04-18T10:00:00.000Z",
            visibleInChat: true,
          },
          assistantMessage: {
            id: "a-usage",
            sessionId: "session-1",
            taskId: "task-usage",
            role: "agent",
            content: "这次应该显示真实 token。",
            status: "complete",
            actualEngine: "hermes",
            authorName: "Hermes",
            createdAt: "2026-04-18T10:00:01.000Z",
            visibleInChat: true,
          },
        },
      },
      taskRunOrderBySession: { "session-1": ["task-usage"] },
      taskEventsByRunId: {
        "task-usage": [
          { taskRunId: "task-usage", workSessionId: "session-1", engineId: "hermes", event: { type: "usage", source: "actual", inputTokens: 9421, outputTokens: 519, totalTokens: 9940, contextTokens: 11981, contextWindow: 256000, estimatedCostUsd: 0.01, message: "actual", at: "2026-04-18T10:00:03.000Z" } },
          { taskRunId: "task-usage", workSessionId: "session-1", engineId: "hermes", event: { type: "usage", source: "estimated", inputTokens: 40, outputTokens: 15, totalTokens: 55, estimatedCostUsd: 0, message: "estimate", at: "2026-04-18T10:00:01.000Z" } },
        ],
      },
    }));

    renderView();

    expect(screen.getByText("实测 9,940 token")).toBeInTheDocument();
    expect(screen.queryByText("约 55 token")).toBeNull();
  });

  it("shows a typing state instead of raw placeholder text while waiting", () => {
    useAppStore.setState({
      taskRunProjectionsById: {
        "task-typing": {
          taskRunId: "task-typing",
          workSessionId: "session-1",
          status: "routing",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [],
          startedAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:01.000Z",
          userMessage: {
            id: "u2",
            sessionId: "session-1",
            taskId: "task-typing",
            role: "user",
            content: "你现在在哪",
            createdAt: "2026-04-18T10:00:00.000Z",
            visibleInChat: true,
          },
          assistantMessage: {
            id: "a2",
            sessionId: "session-1",
            taskId: "task-typing",
            role: "agent",
            content: "",
            status: "pending",
            actualEngine: "hermes",
            authorName: "Hermes",
            createdAt: "2026-04-18T10:00:01.000Z",
            visibleInChat: true,
          },
        },
      },
      taskRunOrderBySession: { "session-1": ["task-typing"] },
    });

    renderView();

    expect(screen.getByTestId("typing-state")).toBeTruthy();
    expect(screen.queryByText("已完成路由，正在执行任务。")).toBeNull();
  });

  it("surfaces Hermes thinking state while waiting for the final reply", () => {
    useAppStore.setState({
      taskRunProjectionsById: {
        "task-thinking": {
          taskRunId: "task-thinking",
          workSessionId: "session-1",
          status: "running",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [],
          startedAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:02.000Z",
          userMessage: {
            id: "u-thinking",
            sessionId: "session-1",
            taskId: "task-thinking",
            role: "user",
            content: "分析一下问题",
            createdAt: "2026-04-18T10:00:00.000Z",
            visibleInChat: true,
          },
          assistantMessage: {
            id: "a-thinking",
            sessionId: "session-1",
            taskId: "task-thinking",
            role: "agent",
            content: "",
            status: "streaming",
            actualEngine: "hermes",
            authorName: "Hermes",
            createdAt: "2026-04-18T10:00:01.000Z",
            visibleInChat: true,
          },
        },
      },
      taskRunOrderBySession: { "session-1": ["task-thinking"] },
      taskEventsByRunId: {
        "task-thinking": [{
          taskRunId: "task-thinking",
          workSessionId: "session-1",
          sessionId: "task-thinking",
          engineId: "hermes",
          event: { type: "reasoning", content: "internal reasoning is not rendered", at: "2026-04-18T10:00:02.000Z" },
        }],
      },
    });

    renderView();

    expect(screen.getAllByText("思考中").length).toBeGreaterThan(0);
    expect(screen.getByText("不是卡住，是在把话说顺一点。")).toBeInTheDocument();
    expect(screen.queryByText("internal reasoning is not rendered")).toBeNull();
  });

  it("enables send for normal Hermes input", () => {
    useAppStore.setState({ userInput: "帮我检查项目" });

    renderView();

    const input = screen.getByLabelText("给 Hermes 发送消息");
    const sendButton = screen.getByRole("button", { name: "发送" });
    const modelButton = screen.getByRole("button", { name: "qwen" });
    const attachmentButton = screen.getByRole("button", { name: "添加附件" });

    expect(input).toHaveAttribute("placeholder", "写给 Hermes… (/ 命令，拖拽或粘贴附件)");
    expect(sendButton).not.toBeDisabled();
    expect(sendButton).toHaveClass("h-8");
    expect(sendButton).toHaveClass("bg-[var(--hermes-primary)]");
    expect(attachmentButton).toHaveClass("h-8");
    expect(modelButton).toHaveClass("h-8");
    expect(modelButton).toHaveClass("max-w-[176px]");
    expect(modelButton).toHaveClass("bg-[var(--hermes-primary-soft)]");
    expect(modelButton).toHaveAttribute("title", "qwen");
  });

  it("keeps yellow runtime protection as compact helper text with expandable details", () => {
    useAppStore.setState({
      userInput: "帮我检查项目",
      permissionOverview: permissionOverview({ cliPermissionMode: "yolo" }),
    });

    renderView();

    const input = screen.getByLabelText("给 Hermes 发送消息");
    const sendButton = screen.getByRole("button", { name: "发送" });
    const summary = screen.getAllByText(/可发送 · 命令自动放行/)[0];
    const helper = summary.closest("summary");

    expect(sendButton).not.toBeDisabled();
    expect(helper).toHaveClass("hermes-composer-status");
    expect(helper).toHaveClass("border");
    expect(screen.getByText("运行说明")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "帮我检查项目结构" } });
    fireEvent.click(screen.getByText("运行说明"));

    expect(screen.getByText(/命令执行不会逐项询问/)).toBeInTheDocument();
    expect(input).toHaveValue("帮我检查项目结构");
    expect(sendButton).not.toBeDisabled();
  });

  it("does not block the next send when a stale setup blocker conflicts with healthy Hermes status", () => {
    useAppStore.setState({
      userInput: "请问我刚才问了什么",
      hermesStatus: {
        engine: {
          engineId: "hermes",
          label: "Hermes",
          available: true,
          mode: "cli",
          message: "Hermes CLI 已接入真实本地安装。",
        },
        memory: {
          engineId: "hermes",
          workspaceId: "workspace",
          usedCharacters: 0,
          maxCharacters: 28000,
          entries: 0,
          message: "memory ok",
        },
        update: {
          engineId: "hermes",
          updateAvailable: false,
          sourceConfigured: true,
          message: "update ok",
        },
      },
      setupSummary: {
        ready: false,
        blocking: [
          {
            id: "hermes",
            label: "Hermes",
            status: "missing",
            message: "后台健康检查的旧 Hermes 阻塞项。",
            fixAction: "install_hermes",
            blocking: true,
          },
        ],
        checks: [],
      },
    });

    renderView();

    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
  });

  it("shows a model setup reason and opens the fix target", () => {
    const onOpenFix = vi.fn();
    useAppStore.setState({
      userInput: "帮我检查项目",
      runtimeConfig: {
        defaultModelProfileId: undefined,
        modelProfiles: [],
        updateSources: {},
      },
    });

    render(
      <DashboardView
        onPickWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCreateSession={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onOpenSessionFolder={vi.fn()}
        onOpenSupport={vi.fn()}
        onClearSession={vi.fn()}
        onStartTask={vi.fn()}
        onCancelTask={vi.fn()}
        onRestoreSnapshot={vi.fn()}
        onRefreshFileTree={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onOpenFix={onOpenFix}
      />,
    );

    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "配置模型" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /未配置可用模型/ }));
    expect(onOpenFix).toHaveBeenCalledWith("model");
  });

  it("blocks file-oriented requests when no workspace is selected", () => {
    const onOpenFix = vi.fn();
    useAppStore.setState({
      userInput: "请读取这个项目里的 package.json 并分析依赖",
      workspacePath: "",
    });

    render(
      <DashboardView
        onPickWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onCreateSession={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onOpenSessionFolder={vi.fn()}
        onOpenSupport={vi.fn()}
        onClearSession={vi.fn()}
        onStartTask={vi.fn()}
        onCancelTask={vi.fn()}
        onRestoreSnapshot={vi.fn()}
        onRefreshFileTree={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onOpenFix={onOpenFix}
      />,
    );

    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /这类请求需要先选择项目目录/ }));
    expect(onOpenFix).toHaveBeenCalledWith("workspace");
  });

  it("allows direct absolute file path prompts without a workspace", () => {
    useAppStore.setState({
      userInput: '请帮我总结一下 "C:\\Users\\xia\\Desktop\\论文md\\论文正文格式规范.md"',
      workspacePath: "",
    });

    renderView();

    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
  });

  it("fills the input from an empty chat suggestion", () => {
    renderView();

    fireEvent.click(screen.getByRole("button", { name: /分析这个项目结构/ }));

    expect(screen.getByLabelText("给 Hermes 发送消息")).toHaveValue("分析这个项目结构，并告诉我入口文件和关键模块。");
  });

  it("uses Enter to submit Hermes input", () => {
    const onStartTask = vi.fn();
    useAppStore.setState({ userInput: "" });

    render(
      <ChatInput
        onStartTask={onStartTask}
        onCancelTask={vi.fn()}
        onRestoreSnapshot={vi.fn()}
        canStart
        latestSnapshotAvailable={false}
        locked={false}
      />,
    );

    const input = screen.getByLabelText("给 Hermes 发送消息");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "请检查 MEMORY.md", selectionStart: 14 } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onStartTask).toHaveBeenCalledTimes(1);
  });

  it("blocks sending without exposing stop when another session owns the running task", () => {
    const onCancelTask = vi.fn();
    useAppStore.setState({
      sessions: [
        ...useAppStore.getState().sessions,
        {
          id: "session-other",
          title: "后台会话",
          status: "running",
          sessionFilesPath: "D:/temp/session-other",
          workspacePath: "D:/workspace/demo",
          workspaceStatus: "ready",
          createdAt: "2026-05-20T10:00:00.000Z",
          updatedAt: "2026-05-20T10:00:00.000Z",
        },
      ],
      userInput: "当前会话的新问题",
    });
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-other",
      taskRunId: "task-other",
      userInput: "后台会话任务",
      createdAt: "2026-05-20T10:00:00.000Z",
    });

    renderView({ onCancelTask });

    expect(screen.queryByRole("button", { name: "停止 Hermes" })).toBeNull();
    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).toBeDisabled();
    expect(sendButton).toHaveAttribute("title", "后台会话正在运行，完成后再发送。");
    expect(onCancelTask).not.toHaveBeenCalled();
  });

  it("shows pending approval and clarify cards only for the active session", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-1",
      taskRunId: "task-active-card",
      userInput: "当前会话审批",
      createdAt: "2026-05-20T10:00:00.000Z",
    });
    useAppStore.getState().finalizeTaskRun("task-active-card", { status: "complete", content: "done" });
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-other",
      taskRunId: "task-foreign-card",
      userInput: "其他会话审批",
      createdAt: "2026-05-20T10:01:00.000Z",
    });
    useAppStore.getState().finalizeTaskRun("task-foreign-card", { status: "complete", content: "done" });
    useAppStore.setState({
      pendingApprovalCards: [
        {
          id: "approval-active",
          taskRunId: "task-active-card",
          title: "当前会话需要确认",
          patternKey: "cmd:active",
          scopeKey: "task-active-card",
          actionKind: "command_run",
          risk: "medium",
          status: "pending",
          createdAt: "2026-05-20T10:00:00.000Z",
        },
        {
          id: "approval-foreign",
          taskRunId: "task-foreign-card",
          title: "其他会话需要确认",
          patternKey: "cmd:foreign",
          scopeKey: "task-foreign-card",
          actionKind: "command_run",
          risk: "medium",
          status: "pending",
          createdAt: "2026-05-20T10:01:00.000Z",
        },
      ],
      pendingClarifyCards: [
        { id: "clarify-active", sessionId: "session-1", question: "当前会话澄清问题", status: "pending", createdAt: "2026-05-20T10:00:00.000Z" },
        { id: "clarify-foreign", sessionId: "session-other", question: "其他会话澄清问题", status: "pending", createdAt: "2026-05-20T10:01:00.000Z" },
      ],
    });

    renderView();

    expect(screen.getByText("当前会话需要确认")).toBeInTheDocument();
    expect(screen.queryByText("其他会话需要确认")).toBeNull();
    expect(screen.getByText("当前会话澄清问题")).toBeInTheDocument();
    expect(screen.queryByText("其他会话澄清问题")).toBeNull();
  });

  it("shows interactive context details inside the composer", () => {
    useAppStore.setState({
      userInput: "请继续分析这个模块",
      runtimeConfig: {
        defaultModelProfileId: "main",
        modelProfiles: [{ id: "main", provider: "custom", model: "qwen", maxTokens: 1000 }],
        updateSources: {},
      },
      conversationMessages: [
        { id: "m1", sessionId: "session-1", role: "user", content: "上一轮需求：检查模型配置模块。", createdAt: "2026-04-18T10:00:00.000Z", visibleInChat: true },
      ],
      taskEventsByRunId: {
        "task-1": [{
          taskRunId: "task-1",
          workSessionId: "session-1",
          sessionId: "task-1",
          engineId: "hermes",
          event: { type: "usage", source: "actual", inputTokens: 420, outputTokens: 80, estimatedCostUsd: 0.01, message: "usage", at: "2026-04-18T10:00:02.000Z" },
        }],
      },
    });

    render(
      <ChatInput
        onStartTask={vi.fn()}
        onCancelTask={vi.fn()}
        onRestoreSnapshot={vi.fn()}
        canStart
        latestSnapshotAvailable={false}
        locked={false}
      />,
    );

    const contextButton = screen.getByLabelText(/实测当前上下文占用/);
    expect(contextButton).toHaveTextContent(/实测上下文 509/);
    expect(contextButton).toHaveTextContent(/51%/);

    fireEvent.click(contextButton);

    expect(screen.getByText("真实上下文")).toBeInTheDocument();
    expect(screen.getByText("509 tokens")).toBeInTheDocument();
    expect(screen.getByText("491 tokens")).toBeInTheDocument();
    expect(screen.getByText("420 tokens")).toBeInTheDocument();
    expect(screen.getByText("80 tokens")).toBeInTheDocument();
  });

  it("keeps voice input transcripts stable while interim results update", async () => {
    const recognitionInstances: MockSpeechRecognition[] = [];
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    const originalMediaDevices = navigator.mediaDevices;
    const originalSpeechRecognition = window.SpeechRecognition;
    const originalWebkitSpeechRecognition = window.webkitSpeechRecognition;
    class MockSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      maxAlternatives = 0;
      onstart: ((event: Event) => void) | null = null;
      onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
      onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
      onend: ((event: Event) => void) | null = null;

      constructor() {
        recognitionInstances.push(this);
      }

      start() {
        this.onstart?.(new Event("start"));
      }

      stop() {
        this.onend?.(new Event("end"));
      }
    }
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    window.SpeechRecognition = MockSpeechRecognition as unknown as SpeechRecognitionConstructor;
    window.webkitSpeechRecognition = undefined;
    useAppStore.setState({ userInput: "已有文字" });

    try {
      render(
        <ChatInput
          onStartTask={vi.fn()}
          onCancelTask={vi.fn()}
          onRestoreSnapshot={vi.fn()}
          canStart
          latestSnapshotAvailable={false}
          locked={false}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "打开更多输入入口" }));
      fireEvent.click(screen.getByRole("button", { name: "语音输入" }));

      await waitFor(() => expect(recognitionInstances).toHaveLength(1));
      const recognition = recognitionInstances[0];

      act(() => {
        recognition.onresult?.(speechEvent(0, [{ transcript: "第一段", isFinal: false }]));
      });
      expect(screen.getByLabelText("给 Hermes 发送消息")).toHaveValue("已有文字 第一段");

      act(() => {
        recognition.onresult?.(speechEvent(0, [{ transcript: "第一段", isFinal: true }]));
      });
      expect(screen.getByLabelText("给 Hermes 发送消息")).toHaveValue("已有文字 第一段");

      act(() => {
        recognition.onresult?.(speechEvent(1, [
          { transcript: "第一段", isFinal: true },
          { transcript: "第二段", isFinal: false },
        ]));
      });
      expect(screen.getByLabelText("给 Hermes 发送消息")).toHaveValue("已有文字 第一段 第二段");

      fireEvent.click(screen.getByRole("button", { name: "停止语音输入" }));

      expect(useAppStore.getState().toasts.at(-1)?.title).toBe("语音输入已停止");
    } finally {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
      window.SpeechRecognition = originalSpeechRecognition;
      window.webkitSpeechRecognition = originalWebkitSpeechRecognition;
    }
  });
});

function dispatchPointerEvent(type: string, clientX: number, target: EventTarget = window) {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  Object.defineProperty(event, "clientX", { value: clientX });
  target.dispatchEvent(event);
}

function speechEvent(resultIndex: number, results: Array<{ transcript: string; isFinal: boolean }>) {
  return {
    resultIndex,
    results: results.map((result) => ({
      0: { transcript: result.transcript },
      isFinal: result.isFinal,
      length: 1,
    })),
  } as unknown as SpeechRecognitionEvent;
}
