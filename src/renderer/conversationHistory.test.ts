import { describe, expect, it } from "vitest";
import { buildConversationHistory } from "./conversationHistory";
import type { TaskRunProjection } from "../shared/types";

describe("buildConversationHistory", () => {
  it("compacts long completed assistant replies before IPC validation", () => {
    const longReply = `开头${"一".repeat(13_000)}结尾`;
    const history = buildConversationHistory({
      workSessionId: "session-1",
      taskRunOrderBySession: { "session-1": ["task-1"] },
      taskRunProjectionsById: {
        "task-1": runFor("task-1", "session-1", "你好", longReply),
      },
    });

    const assistant = history.find((entry) => entry.role === "assistant");
    expect(assistant?.content.length).toBeLessThanOrEqual(12_000);
    expect(assistant?.content).toContain("已省略");
    expect(assistant?.content).toContain("开头");
    expect(assistant?.content).toContain("结尾");
  });

  it("keeps the newest valid history within the entry and total budgets", () => {
    const ids = Array.from({ length: 30 }, (_, index) => `task-${index}`);
    const history = buildConversationHistory({
      workSessionId: "session-1",
      taskRunOrderBySession: { "session-1": ids },
      taskRunProjectionsById: Object.fromEntries(
        ids.map((id, index) => [id, runFor(id, "session-1", `问题 ${index}`, `回答 ${index} ${"好".repeat(6000)}`)]),
      ),
    });

    expect(history.length).toBeLessThanOrEqual(24);
    expect(history.every((entry) => entry.content.length <= 12_000)).toBe(true);
    expect(history.reduce((sum, entry) => sum + entry.content.length, 0)).toBeLessThanOrEqual(56_000);
    expect(history.at(-1)?.taskRunId).toBe("task-29");
    expect(history[0].role).toBe("user");
    expect(history.length % 2).toBe(0);
  });

  it("keeps complete contiguous turns when the next older turn exceeds the budget", () => {
    const ids = ["task-0", "task-1", "task-2", "task-3"];
    const history = buildConversationHistory({
      workSessionId: "session-1", taskRunOrderBySession: { "session-1": ids },
      taskRunProjectionsById: Object.fromEntries(ids.map((id, index) => [id, runFor(id, "session-1", index === 0 ? "short" : "q".repeat(11000), index === 0 ? "short" : "a".repeat(11000))])),
    });
    expect(history.map((entry) => entry.taskRunId)).toEqual(["task-2", "task-2", "task-3", "task-3"]);
  });
});

function runFor(taskRunId: string, workSessionId: string, userContent: string, assistantContent: string): TaskRunProjection {
  const index = Number(taskRunId.replace(/\D/g, "")) || 0;
  const startedAt = new Date(Date.UTC(2026, 4, 18, 8, 0, index)).toISOString();
  return {
    taskRunId,
    workSessionId,
    status: "complete",
    engineId: "hermes",
    actualEngine: "hermes",
    toolEvents: [],
    startedAt,
    updatedAt: startedAt,
    userMessage: {
      id: `user-${taskRunId}`,
      sessionId: workSessionId,
      taskId: taskRunId,
      role: "user",
      content: userContent,
      createdAt: startedAt,
      visibleInChat: true,
    },
    assistantMessage: {
      id: `assistant-${taskRunId}`,
      sessionId: workSessionId,
      taskId: taskRunId,
      role: "agent",
      content: assistantContent,
      status: "complete",
      engineId: "hermes",
      createdAt: startedAt,
      visibleInChat: true,
    },
  };
}
