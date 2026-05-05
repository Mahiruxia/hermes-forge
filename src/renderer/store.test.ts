import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./store";
import type { SessionMessage, StreamEvent, TaskEventEnvelope } from "../shared/types";

function reset() {
  useAppStore.getState().resetStore();
}

describe("renderer store task projections", () => {
  beforeEach(() => {
    reset();
  });

  it("keeps the session sidebar open by default and toggles it", () => {
    expect(useAppStore.getState().sessionSidebarOpen).toBe(true);
    expect(useAppStore.getState().sessionSidebarWidth).toBe(228);
    expect(useAppStore.getState().agentPanelWidth).toBe(360);

    useAppStore.getState().setSessionSidebarOpen(false);
    expect(useAppStore.getState().sessionSidebarOpen).toBe(false);

    useAppStore.getState().setSessionSidebarOpen(true);
    expect(useAppStore.getState().sessionSidebarOpen).toBe(true);

    useAppStore.getState().setSessionSidebarWidth(280);
    useAppStore.getState().setAgentPanelWidth(420);
    expect(useAppStore.getState().sessionSidebarWidth).toBe(280);
    expect(useAppStore.getState().agentPanelWidth).toBe(420);
  });

  it("projects stdout and final result into the same task run", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-1",
      taskRunId: "task-1",
      userInput: "你好",
      createdAt: "2026-04-18T10:00:00.000Z",
    });

    useAppStore.getState().applyTaskEvent({
      taskRunId: "task-1",
      workSessionId: "session-1",
      engineId: "hermes",
      event: {
        type: "stdout",
        line: "Hello",
        at: "2026-04-18T10:00:01.000Z",
      },
    });

    useAppStore.getState().applyTaskEvent({
      taskRunId: "task-1",
      workSessionId: "session-1",
      engineId: "hermes",
      event: {
        type: "result",
        success: true,
        title: "Hermes 回复",
        detail: "Hello, world.",
        at: "2026-04-18T10:00:02.000Z",
      },
    });

    const projection = useAppStore.getState().taskRunProjectionsById["task-1"];
    expect(projection.assistantMessage.content).toBe("Hello, world.");
    expect(projection.status).toBe("complete");
    expect(projection.actualEngine).toBe("hermes");
  });

  it("filters Hermes CLI session lifecycle output from chat projections", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-1",
      taskRunId: "task-cli-status",
      userInput: "继续",
      createdAt: "2026-04-18T10:00:00.000Z",
    });

    useAppStore.getState().applyTaskEvent({
      taskRunId: "task-cli-status",
      workSessionId: "session-1",
      engineId: "hermes",
      event: {
        type: "stdout",
        line: "Resumed session 20260424_121414_49cda7 (4 user messages, 10 total messages)",
        at: "2026-04-18T10:00:01.000Z",
      },
    });

    useAppStore.getState().applyTaskEvent({
      taskRunId: "task-cli-status",
      workSessionId: "session-1",
      engineId: "hermes",
      event: {
        type: "result",
        success: true,
        title: "Hermes 回复",
        detail: "Resumed session 20260424_121414_49cda7 (4 user messages, 10 total messages)\n继续处理。",
        at: "2026-04-18T10:00:02.000Z",
      },
    });

    const projection = useAppStore.getState().taskRunProjectionsById["task-cli-status"];
    expect(projection.assistantMessage.content).toBe("继续处理。");
    expect(projection.status).toBe("complete");
  });

  it("keeps only a bounded per-run event history in renderer state", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-1",
      taskRunId: "task-noisy",
      userInput: "输出很多日志",
      createdAt: "2026-04-18T10:00:00.000Z",
    });

    for (let index = 0; index < 850; index += 1) {
      useAppStore.getState().applyTaskEvent({
        taskRunId: "task-noisy",
        workSessionId: "session-1",
        sessionId: "task-noisy",
        engineId: "hermes",
        event: {
          type: "progress",
          step: `step-${index}`,
          done: false,
          message: `event ${index}`,
          at: `2026-04-18T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        },
      });
    }

    const state = useAppStore.getState();
    expect(state.taskEventsByRunId["task-noisy"]).toHaveLength(800);
    expect(state.taskEventsByRunId["task-noisy"][0].event).toMatchObject({ type: "progress", step: "step-849" });
    expect(state.events).toHaveLength(240);
  });

  it("clears only deleted session task runs and related logs", () => {
    useAppStore.setState({
      taskRunProjectionsById: {
        "task-a": {
          taskRunId: "task-a",
          workSessionId: "s1",
          status: "running",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [],
          startedAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:00.000Z",
          userMessage: {
            id: "u1",
            sessionId: "s1",
            taskId: "task-a",
            role: "user",
            content: "A",
            createdAt: "2026-04-18T10:00:00.000Z",
            visibleInChat: true,
          },
          assistantMessage: {
            id: "a1",
            sessionId: "s1",
            taskId: "task-a",
            role: "agent",
            content: "",
            createdAt: "2026-04-18T10:00:01.000Z",
            visibleInChat: true,
          },
        },
        "task-b": {
          taskRunId: "task-b",
          workSessionId: "s2",
          status: "complete",
          engineId: "hermes",
          actualEngine: "hermes",
          toolEvents: [],
          startedAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:00.000Z",
          assistantMessage: {
            id: "a2",
            sessionId: "s2",
            taskId: "task-b",
            role: "agent",
            content: "B",
            createdAt: "2026-04-18T10:00:01.000Z",
            visibleInChat: true,
          },
        },
      },
      taskRunOrderBySession: {
        s1: ["task-a"],
        s2: ["task-b"],
      },
      taskEventsByRunId: {
        "task-a": [{ taskRunId: "task-a", workSessionId: "s1", sessionId: "task-a", engineId: "hermes", event: { type: "progress", step: "a", done: false, message: "A", at: "2026-04-18T10:00:00.000Z" } }],
        "task-b": [{ taskRunId: "task-b", workSessionId: "s2", sessionId: "task-b", engineId: "hermes", event: { type: "result", success: true, title: "done", detail: "B", at: "2026-04-18T10:00:00.000Z" } }],
      },
      events: [
        { taskRunId: "task-a", workSessionId: "s1", sessionId: "task-a", engineId: "hermes", event: { type: "progress", step: "a", done: false, message: "A", at: "2026-04-18T10:00:00.000Z" } },
        { taskRunId: "task-b", workSessionId: "s2", sessionId: "task-b", engineId: "hermes", event: { type: "result", success: true, title: "done", detail: "B", at: "2026-04-18T10:00:00.000Z" } },
      ],
      dashboard: { ...useAppStore.getState().dashboard, activityLogs: [{ id: "task-a", engineId: "hermes", type: "analyze", status: "running", timestamp: "2026-04-18T10:00:00.000Z", summary: "A" }, { id: "task-b", engineId: "hermes", type: "fix", status: "success", timestamp: "2026-04-18T10:00:00.000Z", summary: "B" }] },
      dashboardData: { ...useAppStore.getState().dashboardData, activityLogs: [{ id: "task-a", engineId: "hermes", type: "analyze", status: "running", timestamp: "2026-04-18T10:00:00.000Z", summary: "A" }, { id: "task-b", engineId: "hermes", type: "fix", status: "success", timestamp: "2026-04-18T10:00:00.000Z", summary: "B" }] },
    });

    useAppStore.getState().clearSessionData("s1");
    const state = useAppStore.getState();
    expect(Object.keys(state.taskRunProjectionsById)).toEqual(["task-b"]);
    expect(state.taskRunOrderBySession.s1).toBeUndefined();
    expect(Object.keys(state.taskEventsByRunId)).toEqual(["task-b"]);
    expect(state.events).toHaveLength(1);
    expect(state.dashboard.activityLogs).toHaveLength(1);
  });

  it("rebuilds a legacy placeholder into the final assistant result", () => {
    const legacyAgent: SessionMessage = {
      id: "a1",
      sessionId: "session-1",
      taskId: "task-finished",
      role: "agent",
      content: "已完成路由，正在执行任务。",
      status: "streaming",
      createdAt: "2026-04-18T10:00:01.000Z",
      visibleInChat: true,
    };
    useAppStore.setState({
      conversationMessages: [legacyAgent],
    });

    useAppStore.getState().rebuildSessionProjections("session-1", [
      {
        taskRunId: "task-finished",
        workSessionId: "session-1",
        sessionId: "task-finished",
        engineId: "hermes",
        event: {
          type: "result",
          success: true,
          title: "Hermes 回复",
          detail: "这是最终回复。",
          at: "2026-04-18T10:00:03.000Z",
        },
      },
    ]);

    const projection = useAppStore.getState().taskRunProjectionsById["task-finished"];
    expect(projection.assistantMessage.content).toBe("这是最终回复。");
    expect(projection.status).toBe("complete");
  });

  it("marks unfinished historical placeholder runs as interrupted", () => {
    useAppStore.setState({
      conversationMessages: [
        {
          id: "a2",
          sessionId: "session-1",
          taskId: "task-interrupted",
          role: "agent",
          content: "",
          status: "streaming",
          createdAt: "2026-04-18T10:00:01.000Z",
          visibleInChat: true,
        },
      ],
    });

    useAppStore.getState().rebuildSessionProjections("session-1", [
      {
        taskRunId: "task-interrupted",
        workSessionId: "session-1",
        sessionId: "task-interrupted",
        engineId: "hermes",
        event: {
          type: "lifecycle",
          stage: "running",
          message: "running",
          at: "2026-04-18T10:00:03.000Z",
        },
      },
    ]);

    const projection = useAppStore.getState().taskRunProjectionsById["task-interrupted"];
    expect(projection.status).toBe("interrupted");
  });

  it("does not let an unrelated live result overwrite the newest task run", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-active",
      taskRunId: "client-temp-id",
      userInput: "新的提问",
      createdAt: "2026-04-18T10:00:00.000Z",
    });

    useAppStore.getState().applyTaskEvent({
      taskRunId: "previous-task-id",
      workSessionId: "session-active",
      sessionId: "previous-task-id",
      engineId: "hermes",
      event: {
        type: "result",
        success: true,
        title: "Hermes 回复",
        detail: "这是上一轮任务迟到的结果。",
        at: "2026-04-18T10:00:03.000Z",
      },
    });

    const currentProjection = useAppStore.getState().taskRunProjectionsById["client-temp-id"];
    const oldProjection = useAppStore.getState().taskRunProjectionsById["previous-task-id"];
    expect(currentProjection.assistantMessage.content).toBe("");
    expect(currentProjection.status).toBe("routing");
    expect(oldProjection.assistantMessage.content).toBe("这是上一轮任务迟到的结果。");
  });

  it("rebinds a client placeholder task run to the real task run id", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-active",
      taskRunId: "client-temp-id",
      userInput: "你是谁",
      createdAt: "2026-04-18T10:00:00.000Z",
    });

    useAppStore.getState().applyTaskEvent({
      taskRunId: "client-temp-id",
      workSessionId: "session-active",
      sessionId: "client-temp-id",
      engineId: "hermes",
      event: {
        type: "lifecycle",
        stage: "running",
        message: "running",
        at: "2026-04-18T10:00:01.000Z",
      },
    });

    useAppStore.getState().rebindTaskRunId("client-temp-id", "server-task-id");

    useAppStore.getState().applyTaskEvent({
      taskRunId: "server-task-id",
      workSessionId: "session-active",
      sessionId: "server-task-id",
      engineId: "hermes",
      event: {
        type: "result",
        success: true,
        title: "Hermes 回复",
        detail: "我是 Hermes。",
        at: "2026-04-18T10:00:02.000Z",
      },
    });

    const state = useAppStore.getState();
    expect(state.taskRunProjectionsById["client-temp-id"]).toBeUndefined();
    expect(state.taskRunOrderBySession["session-active"]).toEqual(["server-task-id"]);
    expect(state.taskRunProjectionsById["server-task-id"]?.assistantMessage.content).toBe("我是 Hermes。");
    expect(state.taskRunProjectionsById["server-task-id"]?.status).toBe("complete");
  });

  it("merges an early real task result into the client placeholder during rebind", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-active",
      taskRunId: "client-temp-id",
      userInput: "先返回真实结果",
      createdAt: "2026-04-18T10:00:00.000Z",
    });

    useAppStore.getState().applyTaskEvent({
      taskRunId: "server-task-id",
      workSessionId: "session-active",
      sessionId: "server-task-id",
      engineId: "hermes",
      event: {
        type: "result",
        success: true,
        title: "Hermes 回复",
        detail: "真实结果先到了。",
        at: "2026-04-18T10:00:01.000Z",
      },
    });

    useAppStore.getState().rebindTaskRunId("client-temp-id", "server-task-id");

    const state = useAppStore.getState();
    expect(state.taskRunProjectionsById["client-temp-id"]).toBeUndefined();
    expect(state.taskRunOrderBySession["session-active"]).toEqual(["server-task-id"]);
    expect(state.taskRunProjectionsById["server-task-id"]?.userMessage?.content).toBe("先返回真实结果");
    expect(state.taskRunProjectionsById["server-task-id"]?.assistantMessage.id).toBe("agent-client-temp-id");
    expect(state.taskRunProjectionsById["server-task-id"]?.assistantMessage.content).toBe("真实结果先到了。");
    expect(state.taskRunProjectionsById["server-task-id"]?.status).toBe("complete");
  });

  it("keeps task run order sorted by message timestamps", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-active",
      taskRunId: "task-late",
      userInput: "晚一点的问题",
      createdAt: "2026-04-18T10:00:10.000Z",
    });

    useAppStore.getState().beginTaskRun({
      workSessionId: "session-active",
      taskRunId: "task-early",
      userInput: "早一点的问题",
      createdAt: "2026-04-18T10:00:00.000Z",
    });

    expect(useAppStore.getState().taskRunOrderBySession["session-active"]).toEqual(["task-early", "task-late"]);
  });

  it("applies stream events to the existing task projection without adding messages", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-active",
      taskRunId: "task-stream",
      userInput: "流式回复",
      createdAt: "2026-04-18T10:00:00.000Z",
    });

    const firstEvent: StreamEvent = {
      id: "stream-1",
      taskId: "task-stream",
      seq: 1,
      type: "text",
      content: "第一段",
      engineId: "hermes",
      createdAt: "2026-04-18T10:00:01.000Z",
      status: "running",
    };
    const finalEvent: StreamEvent = {
      id: "stream-2",
      taskId: "task-stream",
      seq: 2,
      type: "text",
      content: "第二段",
      engineId: "hermes",
      createdAt: "2026-04-18T10:00:02.000Z",
      status: "complete",
    };

    useAppStore.getState().applyStreamEvent(firstEvent);
    useAppStore.getState().applyStreamEvent(finalEvent);

    const state = useAppStore.getState();
    expect(Object.keys(state.taskRunProjectionsById)).toEqual(["task-stream"]);
    expect(state.taskRunOrderBySession["session-active"]).toEqual(["task-stream"]);
    expect(state.conversationMessages).toHaveLength(0);
    expect(state.taskRunProjectionsById["task-stream"]?.assistantMessage.content).toBe("第一段第二段");
    expect(state.taskRunProjectionsById["task-stream"]?.assistantMessage.status).toBe("complete");
    expect(state.taskRunProjectionsById["task-stream"]?.assistantMessage.parts).toEqual([firstEvent, finalEvent]);
  });

  it("filters Hermes CLI session lifecycle output from stream text", () => {
    useAppStore.getState().beginTaskRun({
      workSessionId: "session-active",
      taskRunId: "task-stream-cli-status",
      userInput: "继续",
      createdAt: "2026-04-18T10:00:00.000Z",
    });

    useAppStore.getState().applyStreamEvent({
      id: "stream-cli-status",
      taskId: "task-stream-cli-status",
      seq: 1,
      type: "text",
      content: "⟳ Resumed session 20260424_121414_49cda7 (4 user messages, 10 total messages)\n继续处理。",
      engineId: "hermes",
      createdAt: "2026-04-18T10:00:01.000Z",
      status: "complete",
    });

    expect(useAppStore.getState().taskRunProjectionsById["task-stream-cli-status"]?.assistantMessage.content).toBe("继续处理。");
  });

  it("keeps a long practical session stable across many task rounds", () => {
    const sessionId = "session-long";
    const events: TaskEventEnvelope[] = [];

    for (let index = 0; index < 80; index += 1) {
      const taskRunId = `task-${index.toString().padStart(2, "0")}`;
      useAppStore.getState().beginTaskRun({
        workSessionId: sessionId,
        taskRunId,
        userInput: `第 ${index + 1} 轮实战任务`,
        createdAt: `2026-04-22T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
      });
      const stdoutEvent: TaskEventEnvelope = {
        taskRunId,
        workSessionId: sessionId,
        sessionId: taskRunId,
        engineId: "hermes",
        event: {
          type: "stdout",
          line: `第 ${index + 1} 轮正在处理`,
          at: `2026-04-22T10:${String(index % 60).padStart(2, "0")}:01.000Z`,
        },
      };
      const resultEvent: TaskEventEnvelope = {
        taskRunId,
        workSessionId: sessionId,
        sessionId: taskRunId,
        engineId: "hermes",
        event: {
          type: "result",
          success: true,
          title: "Hermes 回复",
          detail: `第 ${index + 1} 轮完成`,
          at: `2026-04-22T10:${String(index % 60).padStart(2, "0")}:02.000Z`,
        },
      };
      useAppStore.getState().applyTaskEvent(stdoutEvent);
      useAppStore.getState().applyTaskEvent(resultEvent);
      events.push(stdoutEvent, resultEvent);
    }

    const state = useAppStore.getState();
    const order = state.taskRunOrderBySession[sessionId];
    expect(order).toHaveLength(80);
    expect(state.events).toHaveLength(160);
    expect(order.every((taskRunId) => state.taskRunProjectionsById[taskRunId]?.status === "complete")).toBe(true);
    expect(state.taskRunProjectionsById["task-79"]?.assistantMessage.content).toBe("第 80 轮完成");

    reset();
    useAppStore.getState().rebuildSessionProjections(sessionId, events);
    const restored = useAppStore.getState();
    expect(restored.taskRunOrderBySession[sessionId]).toHaveLength(80);
    expect(restored.taskRunProjectionsById["task-00"]?.assistantMessage.content).toBe("第 1 轮完成");
    expect(restored.taskRunProjectionsById["task-79"]?.status).toBe("complete");
  });

  it("does not mix another session into a long-session rebuild", () => {
    const ownEvents = Array.from({ length: 12 }, (_, index): TaskEventEnvelope => ({
      taskRunId: `own-${index}`,
      workSessionId: "session-own",
      sessionId: `own-${index}`,
      engineId: "hermes",
      event: {
        type: "result",
        success: true,
        title: "Hermes 回复",
        detail: `own ${index}`,
        at: `2026-04-22T11:00:${String(index).padStart(2, "0")}.000Z`,
      },
    }));
    const otherEvents = Array.from({ length: 12 }, (_, index): TaskEventEnvelope => ({
      taskRunId: `other-${index}`,
      workSessionId: "session-other",
      sessionId: `other-${index}`,
      engineId: "hermes",
      event: {
        type: "result",
        success: true,
        title: "Hermes 回复",
        detail: `other ${index}`,
        at: `2026-04-22T11:01:${String(index).padStart(2, "0")}.000Z`,
      },
    }));

    useAppStore.getState().rebuildSessionProjections(
      "session-own",
      [...ownEvents, ...otherEvents].filter((event) => event.workSessionId === "session-own"),
    );

    const state = useAppStore.getState();
    expect(state.taskRunOrderBySession["session-own"]).toHaveLength(12);
    expect(state.taskRunProjectionsById["own-11"]?.assistantMessage.content).toBe("own 11");
    expect(state.taskRunProjectionsById["other-0"]).toBeUndefined();
  });
});
