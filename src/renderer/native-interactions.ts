import type { TaskEventEnvelope } from "../shared/types";
import { useAppStore } from "./store";

export function applyNativeInteractionEvent(envelope: TaskEventEnvelope) {
  const state = useAppStore.getState();
  const event = envelope.event;
  if (event.type === "approval") {
    if (event.outcome === "requested") state.upsertApprovalCard(event.request);
    else state.resolveApprovalCard(event.request.id, event.request.status);
    return;
  }
  if (event.type !== "clarify" || !event.requestId) return;
  if (event.status === "answered" || event.status === "dismissed") {
    state.resolveClarifyCard(event.requestId, event.status);
    return;
  }
  state.upsertClarifyCard({
    id: event.requestId,
    taskRunId: event.taskRunId ?? envelope.taskRunId,
    sessionId: envelope.workSessionId ?? state.taskRunProjectionsById[envelope.taskRunId]?.workSessionId,
    question: event.question,
    options: event.choices,
    multiSelect: event.multiSelect,
    questions: event.questions,
    status: "pending",
    createdAt: event.at,
  });
}
