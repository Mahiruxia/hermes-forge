import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunPanel } from "./AgentRunPanel";
import { useAppStore } from "../../store";
import type { RuntimeConfig } from "../../../shared/types";

const defaultSettings = { theme: "green-light" as const, language: "zh" as const, sendKey: "enter" as const, showUsage: false, showCliSessions: true };
const defaultRuntimeConfig: RuntimeConfig = {
  defaultModelProfileId: "default-model",
  modelProfiles: [{ id: "default-model", provider: "custom", model: "gpt-5.4", baseUrl: "http://127.0.0.1:1234/v1", temperature: 0.6, maxTokens: 128000 }],
  providerProfiles: [{
    id: "provider-1",
    label: "Provider",
    provider: "custom",
    models: [{ id: "gpt-5.4", label: "gpt-5.4", contextWindow: 128000 }],
    status: "ready",
  }],
  enginePermissions: { hermes: { commandRun: true, fileWrite: true } },
  updateSources: {},
};

describe("AgentRunPanel", () => {
  const saveWebUiSettings = vi.fn();
  const saveRuntimeConfig = vi.fn();

  beforeEach(() => {
    useAppStore.getState().resetStore();
    saveWebUiSettings.mockReset();
    saveRuntimeConfig.mockReset();
    saveWebUiSettings.mockImplementation(async (input: Partial<typeof defaultSettings>) => ({ ...defaultSettings, ...input }));
    saveRuntimeConfig.mockImplementation(async (config: RuntimeConfig) => config);
    Object.defineProperty(window, "workbenchClient", {
      configurable: true,
      value: {
        saveWebUiSettings,
        saveRuntimeConfig,
      },
    });
    useAppStore.setState({
      activeSessionId: "session-1",
      runtimeConfig: defaultRuntimeConfig,
      webUiOverview: {
        settings: defaultSettings,
        projects: [],
        spaces: [],
        skills: [],
        memory: [],
        crons: [],
        profiles: [],
        slashCommands: [],
      },
    });
  });

  it("shows the reference-style cards without an active run", () => {
    render(<AgentRunPanel open />);

    expect(screen.getByText("Agent 运行面板")).toBeInTheDocument();
    expect(screen.getByText("当前模型")).toBeInTheDocument();
    expect(screen.getByText("Token 估算")).toBeInTheDocument();
    expect(screen.getByText("工具状态")).toBeInTheDocument();
    expect(screen.getByText("会话记忆")).toBeInTheDocument();
    expect(screen.getByText("任务进度")).toBeInTheDocument();
    expect(screen.getByText("快捷设置")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent 面板")).toHaveClass("w-full");
    expect(screen.getByLabelText("Agent 面板")).toHaveClass("bg-[#f5f6fa]");
    expect(screen.getByText("gpt-5.4")).toBeInTheDocument();
    expect(screen.getByText("128,000 token")).toBeInTheDocument();
    expect(screen.getByText("0.6")).toBeInTheDocument();
    expect(screen.getByText("暂无 Token 估算，运行任务后自动汇总。")).toBeInTheDocument();
    expect(screen.getByText("详细用量已隐藏")).toBeInTheDocument();
  });

  it("summarizes token usage, memory and active run data", () => {
    useAppStore.setState({
      runningTaskRunId: "task-1",
      contextBundle: {
        id: "context-1",
        workspaceId: "workspace-1",
        policy: "isolated",
        readonly: true,
        maxCharacters: 128000,
        usedCharacters: 48000,
        sources: [],
        summary: "当前会话主要讨论图像内容识别与模型信息查询。",
        expiresAt: "2026-04-22T11:00:00.000Z",
        createdAt: "2026-04-22T10:00:00.000Z",
      },
      events: [
        { taskRunId: "task-1", workSessionId: "session-1", engineId: "hermes", event: { type: "usage", inputTokens: 1200, outputTokens: 800, estimatedCostUsd: 0.012, message: "usage", at: "2026-04-22T10:00:02.000Z" } },
        { taskRunId: "task-0", workSessionId: "session-1", engineId: "hermes", event: { type: "usage", inputTokens: 300, outputTokens: 200, estimatedCostUsd: 0.003, message: "usage", at: "2026-04-22T10:00:01.000Z" } },
      ],
      taskRunProjectionsById: {
        "task-1": {
          taskRunId: "task-1",
          workSessionId: "session-1",
          status: "running",
          engineId: "hermes",
          actualEngine: "hermes",
          modelId: "gpt-5.4",
          toolEvents: [
            { id: "tool-1", type: "tool_call", label: "image_analyze", status: "complete", summary: "图像理解完成" },
          ],
          startedAt: "2026-04-22T10:00:00.000Z",
          updatedAt: "2026-04-22T10:00:01.000Z",
          assistantMessage: {
            id: "agent-task-1",
            sessionId: "session-1",
            taskId: "task-1",
            role: "agent",
            content: "",
            createdAt: "2026-04-22T10:00:01.000Z",
            visibleInChat: true,
          },
        },
      },
      taskRunOrderBySession: { "session-1": ["task-1"] },
    });

    render(<AgentRunPanel open />);

    expect(screen.getByText("约 2.5K")).toBeInTheDocument();
    expect(screen.getByText("$0.01")).toBeInTheDocument();
    expect(screen.getByText("最近一次估算：1,200 in / 800 out")).toBeInTheDocument();
    expect(screen.getByText("38%")).toBeInTheDocument();
    expect(screen.getByText("48K / 128K")).toBeInTheDocument();
    expect(screen.getByText("当前会话主要讨论图像内容识别与模型信息查询。")).toBeInTheDocument();
    expect(screen.getByText("图像理解").parentElement).toHaveClass("bg-emerald-50");
  });

  it("uses latest usage per task run instead of double-counting cumulative events", () => {
    useAppStore.setState({
      events: [
        { taskRunId: "task-1", workSessionId: "session-1", engineId: "hermes", event: { type: "usage", inputTokens: 1000, outputTokens: 400, estimatedCostUsd: 0.01, message: "usage", at: "2026-04-22T10:00:02.000Z" } },
        { taskRunId: "task-1", workSessionId: "session-1", engineId: "hermes", event: { type: "usage", inputTokens: 500, outputTokens: 200, estimatedCostUsd: 0.005, message: "usage", at: "2026-04-22T10:00:01.000Z" } },
      ],
    });

    render(<AgentRunPanel open />);

    expect(screen.getByText("约 1.4K")).toBeInTheDocument();
    expect(screen.queryByText("约 2.1K")).toBeNull();
  });

  it("marks file and memory activity in tool status", () => {
    useAppStore.setState({
      events: [
        { taskRunId: "task-1", workSessionId: "session-1", engineId: "hermes", event: { type: "file_change", path: "D:/demo/file.txt", changeType: "update", at: "2026-04-22T10:00:01.000Z" } },
        { taskRunId: "task-1", workSessionId: "session-1", engineId: "hermes", event: { type: "memory_access", engineId: "hermes", action: "read", source: "MEMORY.md", at: "2026-04-22T10:00:02.000Z" } },
      ],
    });

    render(<AgentRunPanel open />);

    expect(screen.getByText("文件解析").parentElement).toHaveClass("bg-sky-50");
    expect(screen.getByText("思维链").parentElement).toHaveClass("bg-orange-50");
    expect(screen.getByText("2/6 已触发")).toBeInTheDocument();
  });

  it("falls back to persisted session insight when in-memory data is empty", () => {
    useAppStore.setState({
      sessionAgentInsight: {
        sessionId: "session-1",
        latestRuntime: {
          taskRunId: "task-persisted",
          status: "complete",
          providerId: "custom",
          modelId: "gpt-5.4",
          runtimeMode: "local_fast",
          contextWindow: 128000,
          temperature: 0.5,
          updatedAt: "2026-04-22T10:00:00.000Z",
        },
        usage: {
          totalInputTokens: 500,
          totalOutputTokens: 300,
          totalEstimatedCostUsd: 0.004,
          latestInputTokens: 500,
          latestOutputTokens: 300,
          latestEstimatedCostUsd: 0.004,
          updatedAt: "2026-04-22T10:00:00.000Z",
        },
        memory: {
          bundleId: "bundle-persisted",
          usedCharacters: 32000,
          maxCharacters: 128000,
          summary: "这是从后端会话洞察恢复的摘要。",
          updatedAt: "2026-04-22T10:00:00.000Z",
        },
      },
    });

    render(<AgentRunPanel open />);

    expect(screen.getByText("约 800")).toBeInTheDocument();
    expect(screen.getByText("$0.0040")).toBeInTheDocument();
    expect(screen.getByText("32K / 128K")).toBeInTheDocument();
    expect(screen.getByText("这是从后端会话洞察恢复的摘要。")).toBeInTheDocument();
    expect(screen.getByText("0.5")).toBeInTheDocument();
  });

  it("expands tool and task details", () => {
    useAppStore.setState({
      runningTaskRunId: "task-1",
      events: [
        { taskRunId: "task-1", workSessionId: "session-1", engineId: "hermes", event: { type: "tool_call", toolName: "powershell.run", argsPreview: "pwd", status: "complete", at: "2026-04-22T10:00:01.000Z" } },
      ],
      taskRunProjectionsById: {
        "task-1": {
          taskRunId: "task-1",
          workSessionId: "session-1",
          status: "running",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [{ id: "tool-1", type: "tool_call", label: "powershell.run", status: "complete", summary: "PowerShell completed" }],
          startedAt: "2026-04-22T10:00:00.000Z",
          updatedAt: "2026-04-22T10:00:01.000Z",
          assistantMessage: { id: "a1", sessionId: "session-1", role: "agent", content: "", createdAt: "2026-04-22T10:00:00.000Z", visibleInChat: true },
        },
      },
      taskRunOrderBySession: { "session-1": ["task-1"] },
    });

    render(<AgentRunPanel open />);

    fireEvent.click(screen.getByRole("button", { name: /查看全部工具/ }));
    expect(screen.getAllByText("powershell.run").length).toBeGreaterThan(0);
    expect(screen.getByText("PowerShell completed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /查看详情/ }));
    expect(screen.getByText("tool_call")).toBeInTheDocument();
  });

  it("saves quick settings through existing APIs", async () => {
    render(<AgentRunPanel open />);

    fireEvent.click(screen.getByRole("button", { name: "显示 Token 用量" }));

    await waitFor(() => expect(saveWebUiSettings).toHaveBeenCalledWith({ showUsage: true }));
    expect(useAppStore.getState().webUiOverview?.settings.showUsage).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "允许命令执行" }));

    await waitFor(() => expect(saveRuntimeConfig).toHaveBeenCalled());
    expect(saveRuntimeConfig.mock.calls.at(-1)?.[0].enginePermissions.hermes.commandRun).toBe(false);
    expect(useAppStore.getState().runtimeConfig?.enginePermissions?.hermes?.commandRun).toBe(false);
  });

  it("keeps settings unchanged when saving fails", async () => {
    saveWebUiSettings.mockRejectedValueOnce(new Error("boom"));

    render(<AgentRunPanel open />);

    fireEvent.click(screen.getByRole("button", { name: "显示 Token 用量" }));

    await waitFor(() => expect(saveWebUiSettings).toHaveBeenCalledWith({ showUsage: true }));
    expect(useAppStore.getState().webUiOverview?.settings.showUsage).toBe(false);
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe("设置保存失败");
  });

  it("opens model fix flow from the change model button", () => {
    const onOpenFix = vi.fn();

    render(<AgentRunPanel open onOpenFix={onOpenFix} />);

    fireEvent.click(screen.getByRole("button", { name: /更换模型/ }));

    expect(onOpenFix).toHaveBeenCalledWith("model");
  });
});
