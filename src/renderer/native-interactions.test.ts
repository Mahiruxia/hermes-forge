import { beforeEach, describe, expect, it } from "vitest";
import type { TaskEventEnvelope } from "../shared/types";
import { applyNativeInteractionEvent } from "./native-interactions";
import { useAppStore } from "./store";

describe("native interaction event routing", () => {
  beforeEach(() => useAppStore.getState().resetStore());

  it("preserves task/session ownership and removes only the resolved native question", () => {
    useAppStore.getState().upsertClarifyCard({ id: "help", question: "本地帮助", status: "pending", createdAt: "now" });
    const event: TaskEventEnvelope = { taskRunId: "run-1", workSessionId: "session-2", engineId: "hermes", event: { type: "clarify", requestId: "request-1", question: "选择目录", choices: ["src", "test"], multiSelect: true, at: "now" } };
    applyNativeInteractionEvent(event);
    expect(useAppStore.getState().pendingClarifyCards).toContainEqual(expect.objectContaining({ id: "request-1", taskRunId: "run-1", sessionId: "session-2", options: ["src", "test"], multiSelect: true, status: "pending" }));
    applyNativeInteractionEvent({ ...event, event: { ...event.event, type: "clarify", requestId: "request-1", question: "选择目录", status: "dismissed", at: "later" } });
    expect(useAppStore.getState().pendingClarifyCards.map(card => card.id)).toEqual(["help"]);
  });
});
