import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import type { EngineEvent, TaskEventEnvelope } from "../../shared/types";
import { taskSlice } from "./taskSlice";

describe("task terminal projection", () => {
  let store = createStore(taskSlice);
  beforeEach(() => {
    store = createStore(taskSlice);
    store.getState().beginTaskRun({ taskRunId: "task-1", workSessionId: "chat-1", userInput: "hello" });
  });
  function apply(event: EngineEvent) {
    const envelope: TaskEventEnvelope = { taskRunId: "task-1", workSessionId: "chat-1", engineId: "hermes", event };
    store.getState().applyTaskEvent(envelope);
  }
  const at = "2026-09-15T06:00:00Z";

  it("uses the official final answer even when interim narration is longer", () => {
    apply({ type: "message_chunk", content: "A long provisional plan and tool commentary that precedes the actual answer.", at });
    apply({ type: "result", success: true, isFinalResponse: true, title: "Reply", detail: "The answer is 42.", at });
    expect(store.getState().taskRunProjectionsById["task-1"].assistantMessage.content).toBe("The answer is 42.");
  });

  it("stops pending tool indicators on cancellation and ignores a late start", () => {
    apply({ type: "tool_call", toolName: "terminal", callId: "call-1", argsPreview: "{}", at });
    apply({ type: "result", success: false, outcome: "cancelled", title: "Cancelled", detail: "Cancelled", at });
    apply({ type: "tool_call", toolName: "terminal", callId: "late-call", argsPreview: "{}", at });
    const tools = store.getState().taskRunProjectionsById["task-1"].toolEvents;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: "call-1", status: "failed", summary: "任务已停止，工具执行未完成。", finishedAt: at });
  });

  it("keeps a tool's reported failure after a successful recovery", () => {
    apply({ type: "tool_call", toolName: "terminal", callId: "call-1", argsPreview: "{}", at });
    apply({ type: "tool_result", toolName: "terminal", callId: "call-1", success: false, status: "failed", outputPreview: "exit 2", at });
    apply({ type: "result", success: true, title: "Reply", detail: "Recovered.", at });
    expect(store.getState().taskRunProjectionsById["task-1"].toolEvents[0]).toMatchObject({ status: "failed", summary: "exit 2" });
  });

  it("keeps a failed result visible after partial text and a late completed lifecycle", () => {
    apply({ type: "message_chunk", content: "A much longer provisional response that never completed.", at });
    apply({ type: "result", success: false, outcome: "failed", title: "Failure", detail: "Model failed", at });
    apply({ type: "lifecycle", stage: "completed", message: "Late completion", at });
    apply({ type: "message_chunk", content: "late", at });
    const projection = store.getState().taskRunProjectionsById["task-1"];
    expect(projection.status).toBe("failed");
    expect(projection.assistantMessage).toMatchObject({ content: "Model failed", status: "failed" });
  });

  it("keeps cancellation terminal when a late success result arrives", () => {
    apply({ type: "result", success: false, outcome: "cancelled", title: "Cancelled", detail: "Cancelled", at });
    apply({ type: "result", success: true, title: "Done", detail: "Late success", at });
    apply({ type: "lifecycle", stage: "running", message: "Late start", at });
    const projection = store.getState().taskRunProjectionsById["task-1"];
    expect(projection.status).toBe("cancelled");
    expect(projection.assistantMessage.content).toBe("Cancelled");
  });

  it("rebuilds persisted failure events without turning them into success", () => {
    apply({ type: "result", success: false, title: "Failure", detail: "API unavailable", at });
    apply({ type: "lifecycle", stage: "completed", message: "Old completion", at });
    const events = store.getState().taskEventsByRunId["task-1"];
    const restored = createStore(taskSlice);
    restored.getState().rebuildSessionProjections("chat-1", events);
    expect(restored.getState().taskRunProjectionsById["task-1"].status).toBe("failed");
  });
});
