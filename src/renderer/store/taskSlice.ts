import { combine } from "zustand/middleware";
import { stripHermesCliLifecycleLines } from "../../shared/hermes-cli-output";
import type { ContextBundle, EngineEvent, SessionMessage, StreamEvent, TaskEventEnvelope, TaskRunProjection, TaskRunStatus } from "../../shared/types";

const MAX_EVENT_LOGS = 240;
const MAX_CONVERSATION_MESSAGES = 160;
const MAX_TASK_EVENTS_PER_RUN = 800;

export interface TaskState {
  runningSessionId?: string;
  contextBundle?: ContextBundle;
  events: TaskEventEnvelope[];
  taskEventsByRunId: Record<string, TaskEventEnvelope[]>;
  taskRunProjectionsById: Record<string, TaskRunProjection>;
  taskRunOrderBySession: Record<string, string[]>;
  streamEventsByTaskId: Record<string, StreamEvent[]>;
  pendingTasksBySessionId: Record<string, { taskId: string; engineId: string; status: StreamEvent["status"]; updatedAt: string }>;
  conversationMessages: SessionMessage[];
  runningTaskRunId?: string;
}

export interface TaskActions {
  setRunningSessionId(sessionId?: string): void;
  setRunningTaskRunId(taskRunId?: string): void;
  setContextBundle(contextBundle?: ContextBundle): void;
  setEvents(events: TaskEventEnvelope[]): void;
  pushEvent(event: TaskEventEnvelope): void;
  pushSessionMessage(message: SessionMessage): void;
  updateSessionMessage(id: string, patch: Partial<SessionMessage>): void;
  bindTaskToMessage(messageId: string, taskId: string): void;
  beginTaskRun(input: { workSessionId: string; taskRunId: string; userInput: string; createdAt?: string }): void;
  updateTaskRunMeta(taskRunId: string, patch: Partial<Pick<TaskRunProjection, "engineId" | "actualEngine" | "runtimeMode" | "providerId" | "modelId" | "status">>): void;
  rebindTaskRunId(previousTaskRunId: string, nextTaskRunId: string): void;
  finalizeTaskRun(taskRunId: string, patch: { status: TaskRunStatus; content: string }): void;
  applyTaskEvent(event: TaskEventEnvelope): void;
  applyStreamEvent(event: StreamEvent): void;
  reconcileSessionMessagesFromEvents(sessionId: string, events: TaskEventEnvelope[]): void;
  rebuildSessionProjections(workSessionId: string, events: TaskEventEnvelope[]): void;
  clearSessionData(sessionId: string): void;
}

function statusForMessage(status: TaskRunStatus): SessionMessage["status"] {
  if (status === "failed") return "failed";
  if (status === "complete" || status === "cancelled" || status === "interrupted") return "complete";
  if (status === "streaming" || status === "running" || status === "routing") return "streaming";
  return "pending";
}

function createTaskProjection(input: {
  workSessionId: string;
  taskRunId: string;
  userInput?: string;
  content?: string;
  status?: TaskRunStatus;
  createdAt?: string;
}): TaskRunProjection {
  const startedAt = input.createdAt || new Date().toISOString();
  const status = input.status ?? "routing";
  const userMessage: SessionMessage | undefined = input.userInput
    ? {
        id: `user-${input.taskRunId}`,
        sessionId: input.workSessionId,
        taskId: input.taskRunId,
        role: "user",
        content: input.userInput,
        createdAt: startedAt,
        visibleInChat: true,
      }
    : undefined;

  return {
    taskRunId: input.taskRunId,
    workSessionId: input.workSessionId,
    userMessage,
    assistantMessage: {
      id: `agent-${input.taskRunId}`,
      sessionId: input.workSessionId,
      taskId: input.taskRunId,
      role: "agent",
      content: input.content ?? "",
      status: statusForMessage(status),
      engineId: "hermes",
      createdAt: startedAt,
      visibleInChat: true,
    },
    status,
    toolEvents: [],
    startedAt,
    updatedAt: startedAt,
  };
}

function projectionStatusFromLifecycle(stage: Extract<EngineEvent, { type: "lifecycle" }>["stage"]): TaskRunStatus {
  if (stage === "queued" || stage === "preflight" || stage === "snapshot") return "routing";
  if (stage === "running") return "running";
  if (stage === "streaming") return "streaming";
  if (stage === "completed") return "complete";
  if (stage === "cancelled") return "cancelled";
  if (stage === "failed" || stage === "restored") return "failed";
  return "running";
}

function contentFromEngineEvent(event: EngineEvent): string | undefined {
  if (event.type === "stdout") return displayableAssistantContent(event.line);
  if (event.type === "result") return displayableAssistantContent(event.detail);
  return undefined;
}

function displayableAssistantContent(content: string) {
  const cleaned = stripHermesCliLifecycleLines(content);
  return cleaned || undefined;
}

function toolEventFromEngineEvent(event: EngineEvent, taskRunId: string): import("../../shared/types").ToolEvent | undefined {
  if (event.type === "tool_call") {
    return {
      id: event.callId ?? `${taskRunId}-tool-${event.at}-${event.toolName}`,
      type: "tool_call",
      label: event.toolName,
      status: event.status ?? "running",
      command: event.argsPreview,
      summary: event.summary,
      startedAt: event.at,
    };
  }
  if (event.type === "tool_result") {
    return {
      id: event.callId ?? `${taskRunId}-tool-${event.at}-${event.toolName}`,
      type: "tool_call",
      label: event.toolName,
      status: event.status ?? (event.success === false ? "failed" : "complete"),
      summary: event.summary ?? event.outputPreview,
      finishedAt: event.at,
    };
  }
  if (event.type === "file_change") {
    return {
      id: `${taskRunId}-file-${event.at}-${event.path}`,
      type: event.changeType === "create" || event.changeType === "update" ? "file_write" : "diagnostic",
      label: event.changeType,
      status: "complete",
      path: event.path,
      finishedAt: event.at,
    };
  }
  return undefined;
}

function upsertToolEvent(
  tools: import("../../shared/types").ToolEvent[],
  next: import("../../shared/types").ToolEvent,
) {
  const existingIndex = tools.findIndex((tool) => tool.id === next.id);
  if (existingIndex < 0) return [...tools, next];
  return tools.map((tool, index) => (index === existingIndex ? { ...tool, ...next } : tool));
}

function appendAssistantContent(projection: TaskRunProjection, content: string, at: string, status: TaskRunStatus) {
  const separator = projection.assistantMessage.content && content && !projection.assistantMessage.content.endsWith("\n") ? "\n" : "";
  return {
    ...projection,
    status,
    assistantMessage: {
      ...projection.assistantMessage,
      content: `${projection.assistantMessage.content}${separator}${content}`,
      status: statusForMessage(status),
      createdAt: projection.assistantMessage.createdAt || at,
    },
    updatedAt: at,
  };
}

function applyEngineEventToProjection(projection: TaskRunProjection, envelope: TaskEventEnvelope): TaskRunProjection {
  const event = envelope.event;
  const base = ensureTaskProjection(projection, {
    taskRunId: envelope.taskRunId,
    workSessionId: envelope.workSessionId ?? projection.workSessionId,
  });

  if (event.type === "lifecycle") {
    const status = projectionStatusFromLifecycle(event.stage);
    return {
      ...base,
      status,
      assistantMessage: {
        ...base.assistantMessage,
        status: statusForMessage(status),
      },
      updatedAt: event.at,
      completedAt: status === "complete" || status === "failed" || status === "cancelled" ? event.at : base.completedAt,
    };
  }

  const toolEvent = toolEventFromEngineEvent(event, envelope.taskRunId);
  if (toolEvent) {
    return {
      ...base,
      toolEvents: upsertToolEvent(base.toolEvents, toolEvent),
      updatedAt: event.at,
    };
  }

  const content = contentFromEngineEvent(event);
  if (event.type === "result") {
    const status = event.success ? "complete" : "failed";
    return {
      ...base,
      status,
      assistantMessage: {
        ...base.assistantMessage,
        content: content ?? base.assistantMessage.content,
        status: statusForMessage(status),
        createdAt: base.assistantMessage.createdAt || event.at,
      },
      updatedAt: event.at,
      completedAt: event.at,
    };
  }
  if (content !== undefined) {
    return appendAssistantContent(base, content, event.at, "streaming");
  }

  if (event.type === "diagnostic" && base.status === "failed" && !base.assistantMessage.content) {
    return appendAssistantContent(base, event.message, event.at, "failed");
  }

  return { ...base, updatedAt: event.at };
}

function normalizeStatus(status: unknown): TaskRunStatus {
  if (status === "completed") return "complete";
  if (
    status === "pending"
    || status === "routing"
    || status === "running"
    || status === "streaming"
    || status === "complete"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted"
  ) {
    return status;
  }
  return "complete";
}

function ensureTaskProjection(
  projection: TaskRunProjection | undefined,
  fallback: { taskRunId: string; workSessionId: string; createdAt?: string },
): TaskRunProjection {
  if (!projection) {
    return createTaskProjection({
      taskRunId: fallback.taskRunId,
      workSessionId: fallback.workSessionId,
      status: "running",
      createdAt: fallback.createdAt,
    });
  }
  const status = normalizeStatus(projection.status);
  const startedAt = projection.startedAt || fallback.createdAt || new Date().toISOString();
  const updatedAt = projection.updatedAt || startedAt;
  const assistantMessage = projection.assistantMessage ?? {
    id: `agent-${fallback.taskRunId}`,
    sessionId: projection.workSessionId || fallback.workSessionId,
    taskId: fallback.taskRunId,
    role: "agent" as const,
    content: "",
    status: statusForMessage(status),
    engineId: "hermes" as const,
    createdAt: updatedAt,
    visibleInChat: true,
  };
  return {
    ...projection,
    taskRunId: projection.taskRunId || fallback.taskRunId,
    workSessionId: projection.workSessionId || fallback.workSessionId,
    assistantMessage: {
      ...assistantMessage,
      content: assistantMessage.content ?? "",
      createdAt: assistantMessage.createdAt || updatedAt,
      visibleInChat: assistantMessage.visibleInChat ?? true,
    },
    status,
    toolEvents: projection.toolEvents ?? [],
    startedAt,
    updatedAt,
  };
}

export const taskSlice = combine<TaskState, TaskActions>(
  {
    runningSessionId: undefined,
    contextBundle: undefined,
    events: [],
    taskEventsByRunId: {},
    taskRunProjectionsById: {},
    taskRunOrderBySession: {},
    streamEventsByTaskId: {},
    pendingTasksBySessionId: {},
    conversationMessages: [],
    runningTaskRunId: undefined,
  },
  (set) => ({
    setRunningSessionId: (sessionId?: string) => set({ runningSessionId: sessionId }),
    setRunningTaskRunId: (taskRunId?: string) => set({ runningTaskRunId: taskRunId }),
    setContextBundle: (contextBundle?: ContextBundle) => set({ contextBundle }),
    setEvents: (events: TaskEventEnvelope[]) => set({ events }),
    pushEvent: (event: TaskEventEnvelope) =>
      set((state) => ({
        events: [event, ...state.events].slice(0, MAX_EVENT_LOGS),
      })),
    pushSessionMessage: (message: SessionMessage) =>
      set((state) => ({
        conversationMessages: [message, ...state.conversationMessages].slice(0, MAX_CONVERSATION_MESSAGES),
      })),
    updateSessionMessage: (id: string, patch: Partial<SessionMessage>) =>
      set((state) => ({
        conversationMessages: state.conversationMessages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      })),
    bindTaskToMessage: (messageId: string, taskId: string) =>
      set((state) => ({
        conversationMessages: state.conversationMessages.map((m) =>
          m.id === messageId ? { ...m, taskId } : m
        ),
      })),
    beginTaskRun: (input: { workSessionId: string; taskRunId: string; userInput: string; createdAt?: string }) =>
      set((state) => ({
        runningTaskRunId: input.taskRunId,
        taskRunProjectionsById: {
          ...state.taskRunProjectionsById,
          [input.taskRunId]: createTaskProjection(input),
        },
        taskRunOrderBySession: {
          ...state.taskRunOrderBySession,
          [input.workSessionId]: [input.taskRunId, ...(state.taskRunOrderBySession[input.workSessionId] || []).filter((id) => id !== input.taskRunId)],
        },
      })),
    updateTaskRunMeta: (taskRunId: string, patch: Partial<Pick<TaskRunProjection, "engineId" | "actualEngine" | "runtimeMode" | "providerId" | "modelId" | "status">>) =>
      set((state) => ({
        taskRunProjectionsById: {
          ...state.taskRunProjectionsById,
          [taskRunId]: {
            ...ensureTaskProjection(state.taskRunProjectionsById[taskRunId], {
              taskRunId,
              workSessionId: state.runningSessionId ?? "local-session",
            }),
            ...patch,
            ...(patch.status ? {
              status: patch.status,
              assistantMessage: {
                ...ensureTaskProjection(state.taskRunProjectionsById[taskRunId], {
                  taskRunId,
                  workSessionId: state.runningSessionId ?? "local-session",
                }).assistantMessage,
                status: statusForMessage(patch.status),
              },
            } : {}),
          },
        },
      })),
    rebindTaskRunId: (previousTaskRunId: string, nextTaskRunId: string) =>
      set((state) => {
        const previous = state.taskRunProjectionsById[previousTaskRunId];
        const existing = state.taskRunProjectionsById[nextTaskRunId];
        if (!previous && !existing) return state;
        const merged = existing
          ? {
              ...existing,
              userMessage: previous?.userMessage ?? existing.userMessage,
              assistantMessage: previous?.assistantMessage
                ? { ...previous.assistantMessage, content: existing.assistantMessage.content || previous.assistantMessage.content, status: existing.assistantMessage.status }
                : existing.assistantMessage,
              toolEvents: [...(previous?.toolEvents ?? []), ...existing.toolEvents],
              startedAt: previous?.startedAt ?? existing.startedAt,
            }
          : previous!;
        const { [previousTaskRunId]: _removed, ...remainingProjections } = state.taskRunProjectionsById;
        return {
          taskRunProjectionsById: {
            ...remainingProjections,
            [nextTaskRunId]: {
              ...ensureTaskProjection(merged, { taskRunId: previousTaskRunId, workSessionId: merged.workSessionId }),
              taskRunId: nextTaskRunId,
            },
          },
          taskRunOrderBySession: Object.fromEntries(
            Object.entries(state.taskRunOrderBySession).map(([sessionId, order]) => [
              sessionId,
              order.map((taskRunId) => (taskRunId === previousTaskRunId ? nextTaskRunId : taskRunId)).filter((taskRunId, index, all) => all.indexOf(taskRunId) === index),
            ]),
          ),
          runningTaskRunId: state.runningTaskRunId === previousTaskRunId ? nextTaskRunId : state.runningTaskRunId,
        };
      }),
    finalizeTaskRun: (taskRunId: string, patch: { status: TaskRunStatus; content: string }) =>
      set((state) => {
        const current = ensureTaskProjection(state.taskRunProjectionsById[taskRunId], {
          taskRunId,
          workSessionId: state.runningSessionId ?? "local-session",
        });
        const updatedAt = new Date().toISOString();
        return {
          taskRunProjectionsById: {
            ...state.taskRunProjectionsById,
            [taskRunId]: {
              ...current,
              status: patch.status,
              assistantMessage: {
                ...current.assistantMessage,
                content: patch.content,
                status: statusForMessage(patch.status),
                createdAt: current.assistantMessage.createdAt || updatedAt,
              },
              updatedAt,
              completedAt: updatedAt,
            },
          },
          runningTaskRunId: state.runningTaskRunId === taskRunId ? undefined : state.runningTaskRunId,
        };
      }),
    applyTaskEvent: (event: TaskEventEnvelope) =>
      set((state) => {
        const newEvents = [event, ...state.events].slice(0, MAX_EVENT_LOGS);
        const activeSessionId = (state as TaskState & { activeSessionId?: string }).activeSessionId;
        const workSessionId = event.workSessionId ?? state.runningSessionId ?? activeSessionId ?? event.sessionId ?? "local-session";
        const currentProjection = ensureTaskProjection(state.taskRunProjectionsById[event.taskRunId], {
          taskRunId: event.taskRunId,
          workSessionId,
        });
        const nextProjection = {
          ...applyEngineEventToProjection(currentProjection, { ...event, workSessionId }),
          engineId: event.engineId,
          actualEngine: event.engineId,
        };
        const currentOrder = state.taskRunOrderBySession[workSessionId] ?? [];
        return {
          events: newEvents,
          taskEventsByRunId: {
            ...state.taskEventsByRunId,
            [event.taskRunId]: [event, ...(state.taskEventsByRunId[event.taskRunId] || [])].slice(0, MAX_TASK_EVENTS_PER_RUN),
          },
          taskRunProjectionsById: {
            ...state.taskRunProjectionsById,
            [event.taskRunId]: nextProjection,
          },
          taskRunOrderBySession: {
            ...state.taskRunOrderBySession,
            [workSessionId]: currentOrder.includes(event.taskRunId) ? currentOrder : [...currentOrder, event.taskRunId],
          },
        };
      }),
    applyStreamEvent: (event: StreamEvent) =>
      set((state) => {
        const parts = [...(state.streamEventsByTaskId[event.taskId] || []), event].sort((left, right) => left.seq - right.seq);
        const existing = ensureTaskProjection(state.taskRunProjectionsById[event.taskId], {
          taskRunId: event.taskId,
          workSessionId: state.runningSessionId ?? (state as TaskState & { activeSessionId?: string }).activeSessionId ?? "local-session",
          createdAt: event.createdAt,
        });
        const content = displayableAssistantContent(parts.filter((part) => part.type === "text").map((part) => part.content ?? "").join("")) ?? "";
        const nextStatus: TaskRunStatus = event.status === "complete" ? "complete" : event.status === "failed" ? "failed" : "streaming";
        const workSessionId = existing.workSessionId;
        const currentOrder = state.taskRunOrderBySession[workSessionId] ?? [];
        const isTerminal = nextStatus === "complete" || nextStatus === "failed";
        return {
          streamEventsByTaskId: {
            ...state.streamEventsByTaskId,
            [event.taskId]: parts,
          },
          taskRunProjectionsById: {
            ...state.taskRunProjectionsById,
            [event.taskId]: {
              ...existing,
              status: nextStatus,
              assistantMessage: {
                ...existing.assistantMessage,
                content,
                status: statusForMessage(nextStatus),
                parts,
              },
              updatedAt: event.createdAt,
              completedAt: isTerminal ? event.createdAt : existing.completedAt,
            },
          },
          taskRunOrderBySession: {
            ...state.taskRunOrderBySession,
            [workSessionId]: currentOrder.includes(event.taskId) ? currentOrder : [...currentOrder, event.taskId],
          },
          ...(isTerminal && state.runningTaskRunId === event.taskId ? { runningTaskRunId: undefined } : {}),
          ...(isTerminal && state.runningSessionId === event.taskId ? { runningSessionId: undefined } : {}),
        };
      }),
    reconcileSessionMessagesFromEvents: (sessionId: string, events: TaskEventEnvelope[]) =>
      set((state) => {
        const messages = events
          .filter((event) => event.workSessionId === sessionId && event.event.type === "result")
          .map<SessionMessage>((event) => ({
            id: `agent-${event.taskRunId}`,
            sessionId,
            taskId: event.taskRunId,
            role: "agent",
            content: event.event.type === "result" ? event.event.detail : "",
            status: "complete",
            engineId: event.engineId,
            createdAt: event.event.at,
            visibleInChat: true,
          }));
        return { conversationMessages: [...messages, ...state.conversationMessages].slice(0, MAX_CONVERSATION_MESSAGES) };
      }),
    rebuildSessionProjections: (workSessionId: string, events: TaskEventEnvelope[]) =>
      set((state) => {
        const projections: Record<string, TaskRunProjection> = { ...state.taskRunProjectionsById };
        const order: string[] = [];

        events.forEach((event) => {
          const base = ensureTaskProjection(projections[event.taskRunId], {
            taskRunId: event.taskRunId,
            workSessionId,
            createdAt: event.event.at,
          });
          projections[event.taskRunId] = applyEngineEventToProjection(base, { ...event, workSessionId });
          if (!order.includes(event.taskRunId)) order.push(event.taskRunId);
        });

        for (const taskRunId of order) {
          const projection = projections[taskRunId];
          if (projection.status === "running" || projection.status === "routing" || projection.status === "streaming") {
            projections[taskRunId] = {
              ...projection,
              status: "interrupted",
              assistantMessage: {
                ...projection.assistantMessage,
                status: "complete",
              },
            };
          }
        }

        return {
          taskRunProjectionsById: projections,
          taskRunOrderBySession: { ...state.taskRunOrderBySession, [workSessionId]: order },
        };
      }),
    clearSessionData: (sessionId: string) =>
      set((state) => {
        const removedIds = new Set(state.taskRunOrderBySession[sessionId] ?? []);
        const { [sessionId]: _removedOrder, ...remainingOrder } = state.taskRunOrderBySession;
        return {
          taskRunOrderBySession: remainingOrder,
          taskRunProjectionsById: Object.fromEntries(Object.entries(state.taskRunProjectionsById).filter(([taskRunId, projection]) => projection.workSessionId !== sessionId && !removedIds.has(taskRunId))),
          taskEventsByRunId: Object.fromEntries(Object.entries(state.taskEventsByRunId).filter(([taskRunId]) => !removedIds.has(taskRunId))),
          events: state.events.filter((event) => event.workSessionId !== sessionId && !removedIds.has(event.taskRunId)),
          dashboard: {
            ...(state as TaskState & { dashboard: import("../../shared/types").DashboardSnapshot }).dashboard,
            activityLogs: (state as TaskState & { dashboard: import("../../shared/types").DashboardSnapshot }).dashboard.activityLogs.filter((log) => !removedIds.has(log.id)),
          },
          dashboardData: {
            ...(state as TaskState & { dashboardData: import("../../shared/types").DashboardData }).dashboardData,
            activityLogs: (state as TaskState & { dashboardData: import("../../shared/types").DashboardData }).dashboardData.activityLogs.filter((log) => !removedIds.has(log.id)),
          },
        };
      }),
  })
);
