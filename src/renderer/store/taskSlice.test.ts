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
