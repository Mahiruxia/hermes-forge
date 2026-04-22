import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "./DashboardView";
import { ChatInput } from "./ChatInput";
import { useAppStore } from "../store";

describe("DashboardView", () => {
  beforeEach(() => {
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
        settings: { theme: "green-light", language: "zh", sendKey: "enter", showUsage: false, showCliSessions: true },
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

  function renderView(overrides?: { onOpenFix?: (target: "model" | "hermes" | "health" | "diagnostics") => void }) {
    return render(
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
        onOpenFix={overrides?.onOpenFix}
      />,
    );
  }

  it("shows the session sidebar by default and toggles it manually", () => {
    renderView();

    const shell = screen.getByTestId("session-sidebar-shell");
    const inputShell = screen.getByTestId("chat-input-shell");
    expect(shell).toHaveClass("w-[228px]");
    expect(shell).toHaveClass("xl:w-[240px]");
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

    expect(shell).toHaveClass("w-[228px]");
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

    expect(shell).toHaveClass("w-[360px]");
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

    expect(agentShell).toHaveClass("w-[360px]");

    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    expect(useAppStore.getState().agentPanelOpen).toBe(false);
    expect(useAppStore.getState().inspectorOpen).toBe(true);
    expect(agentShell).toHaveClass("w-0");

    fireEvent.click(screen.getByRole("button", { name: "Agent 面板" }));

    expect(useAppStore.getState().agentPanelOpen).toBe(true);
    expect(useAppStore.getState().inspectorOpen).toBe(false);
    expect(agentShell).toHaveClass("w-[360px]");
  });

  it("keeps secondary header actions folded until the menu is opened", () => {
    renderView();
    const banner = screen.getByRole("banner");
    const header = within(banner);

    expect(header.getByText("测试会话")).toBeTruthy();
    expect(banner).toHaveClass("z-40");
    expect(header.getByText("Hermes Forge")).toBeTruthy();
    expect(header.getByRole("button", { name: "搜索" })).toBeTruthy();
    expect(header.getByRole("button", { name: "Agent 面板" })).toBeTruthy();
    expect(header.queryByRole("button", { name: "清空会话" })).toBeNull();

    fireEvent.click(header.getByRole("button", { name: "更多选项" }));

    expect(header.getByRole("button", { name: "官网" })).toBeTruthy();
    expect(header.getByRole("button", { name: "赞助与反馈" })).toBeTruthy();
    expect(header.getByRole("button", { name: "打开会话文件夹" })).toBeTruthy();
    expect(header.queryByRole("button", { name: "打开文件树" })).toBeNull();
    expect(header.getByRole("button", { name: "打开搜索与检查器" })).toBeTruthy();
    expect(header.getByRole("button", { name: "清空会话" })).toBeTruthy();
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

  it("enables send for normal Hermes input", () => {
    useAppStore.setState({ userInput: "帮我检查项目" });

    renderView();

    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toHaveClass("bg-[var(--hermes-primary)]");
    expect(screen.getByRole("button", { name: "qwen" })).toHaveClass("bg-[var(--hermes-primary-soft)]");
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
    fireEvent.click(screen.getByRole("button", { name: /未配置可用模型/ }));
    expect(onOpenFix).toHaveBeenCalledWith("model");
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
});
