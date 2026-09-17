import { combine } from "zustand/middleware";
import { stripHermesCliLifecycleLines } from "../../shared/hermes-cli-output";
import type { ContextBundle, EngineEvent, SessionMessage, StreamEvent, TaskEventEnvelope, TaskRunProjection, TaskRunStatus } from "../../shared/types";

const MAX_EVENT_LOGS = 240;
const MAX_CONVERSATION_MESSAGES = 160;
const MAX_TASK_EVENTS_PER_RUN = 800;
const EMPTY_HERMES_RESULT_MESSAGES = [
  "Hermes 已运行，但没有返回可显示的内容。",
  "Hermes 已运行，但没有返回可显示的模型正文。请在右侧“查看过程”检查模型配置、Hermes 日志，或导出诊断报告。",
];

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
  if (event.type === "message_chunk") return displayableAssistantContent(event.content);
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

function settlePendingTools(tools: TaskRunProjection["toolEvents"], status: TaskRunStatus, at: string) {
  if (!["complete", "failed", "cancelled", "interrupted"].includes(status)) return tools;
  return tools.map((tool) => tool.status === "running" ? {
    ...tool,
    status: "failed" as const,
    summary: status === "cancelled" || status === "interrupted"
      ? "任务已停止，工具执行未完成。"
      : "任务已结束，未收到该工具的完成结果。",
    finishedAt: at,
  } : tool);
}

function appendAssistantContent(projection: TaskRunProjection, content: string, at: string, status: TaskRunStatus, separatorMode: "exact" | "line" = "line") {
  const separator = separatorMode === "line" && projection.assistantMessage.content && content && !projection.assistantMessage.content.endsWith("\n") ? "\n" : "";
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
    if ((base.status === "failed" || base.status === "cancelled" || base.status === "interrupted") && status !== base.status) return base;
    if (base.status === "complete" && !["complete", "failed", "cancelled", "interrupted"].includes(status)) return base;
    return {
      ...base,
      status,
      toolEvents: settlePendingTools(base.toolEvents, status, event.at),
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
    if (event.type === "tool_call" && ["complete", "failed", "cancelled", "interrupted"].includes(base.status)) return base;
    return {
      ...base,
      toolEvents: upsertToolEvent(base.toolEvents, toolEvent),
      updatedAt: event.at,
    };
  }

  const content = contentFromEngineEvent(event);
  if (event.type === "result") {
    const status = event.outcome === "cancelled" ? "cancelled" : event.success ? "complete" : "failed";
    if ((base.status === "cancelled" || base.status === "interrupted") && status !== base.status) return base;
    if (base.status === "failed" && status === "complete") return base;
    const streamed = base.assistantMessage.content;
    const resultContent = content ?? "";
    const finalContent = status === "complete"
      ? event.isFinalResponse && resultContent
        ? resultContent
        : chooseFinalAssistantContent(streamed, resultContent, base.status === "streaming")
      : resultContent || streamed;
    return {
      ...base,
      status,
      toolEvents: settlePendingTools(base.toolEvents, status, event.at),
      assistantMessage: {
        ...base.assistantMessage,
        content: finalContent,
        status: statusForMessage(status),
        createdAt: base.assistantMessage.createdAt || event.at,
      },
      updatedAt: event.at,
      completedAt: event.at,
    };
  }
  if (content !== undefined) {
    if (["complete", "failed", "cancelled", "interrupted"].includes(base.status)) return base;
    return appendAssistantContent(
      base,
      content,
      event.at,
      event.type === "message_chunk" ? "streaming" : "running",
      event.type === "message_chunk" ? "exact" : "line",
    );
  }

  if (event.type === "diagnostic" && base.status === "failed" && !base.assistantMessage.content) {
    return appendAssistantContent(base, event.message, event.at, "failed");
  }

  return { ...base, updatedAt: event.at };
}

function chooseFinalAssistantContent(streamed: string, resultContent: string, hasStreamedAssistantText: boolean) {
  if (!streamed) return resultContent;
  if (!resultContent) return streamed;
  if (hasStreamedAssistantText && isEmptyHermesResultMessage(resultContent)) return streamed;
  if (!hasStreamedAssistantText) return resultContent;
  return streamed.length > resultContent.length ? streamed : resultContent;
}

function isEmptyHermesResultMessage(content: string) {
  const normalized = content.trim();
  return EMPTY_HERMES_RESULT_MESSAGES.some((message) => normalized === message);
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

function isTerminalTaskRunStatus(status: TaskRunStatus) {
  return status === "complete" || status === "failed" || status === "cancelled" || status === "interrupted";
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
      set((state) => {
        const projections = { ...state.taskRunProjectionsById };
        const keys = Object.keys(projections);
        if (keys.length > 200) {
          const sorted = keys
            .map((k) => ({ k, startedAt: projections[k].startedAt }))
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
          const toRemove = sorted.slice(0, keys.length - 200).map((x) => x.k);
          toRemove.forEach((k) => delete projections[k]);
        }
        const currentOrder = state.taskRunOrderBySession[input.workSessionId] || [];
        return {
          runningTaskRunId: input.taskRunId,
          taskRunProjectionsById: {
            ...projections,
            [input.taskRunId]: createTaskProjection(input),
          },
          taskRunOrderBySession: {
            ...state.taskRunOrderBySession,
            [input.workSessionId]: [input.taskRunId, ...currentOrder.filter((id) => id !== input.taskRunId)].slice(0, 200),
          },
        };
      }),
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
        const isTerminal = isTerminalTaskRunStatus(nextProjection.status);
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
          ...(isTerminal && state.runningTaskRunId === event.taskRunId ? { runningTaskRunId: undefined } : {}),
          ...(isTerminal && state.runningSessionId === event.taskRunId ? { runningSessionId: undefined } : {}),
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
        const relevantEvents = events
          .filter((event) => !event.workSessionId || event.workSessionId === workSessionId)
          .sort((left, right) => {
            const byTime = left.event.at.localeCompare(right.event.at);
            return byTime || left.taskRunId.localeCompare(right.taskRunId);
          });
        const previousSessionIds = new Set([
          ...(state.taskRunOrderBySession[workSessionId] ?? []),
          ...Object.values(state.taskRunProjectionsById)
            .filter((projection) => projection.workSessionId === workSessionId)
            .map((projection) => projection.taskRunId),
        ]);
        const previousSessionProjections = new Map(
          [...previousSessionIds]
            .map((taskRunId) => [taskRunId, state.taskRunProjectionsById[taskRunId]] as const)
            .filter((entry): entry is readonly [string, TaskRunProjection] => Boolean(entry[1])),
        );
        const projections: Record<string, TaskRunProjection> = Object.fromEntries(
          Object.entries(state.taskRunProjectionsById).filter(([taskRunId, projection]) => (
            projection.workSessionId !== workSessionId && !previousSessionIds.has(taskRunId)
          )),
        );
        const taskEventsByRunId: Record<string, TaskEventEnvelope[]> = Object.fromEntries(
          Object.entries(state.taskEventsByRunId).filter(([taskRunId]) => !previousSessionIds.has(taskRunId)),
        );
        const order: string[] = [];

        relevantEvents.forEach((event) => {
          const base = ensureTaskProjection(projections[event.taskRunId], {
            taskRunId: event.taskRunId,
            workSessionId,
            createdAt: event.event.at,
          });
          projections[event.taskRunId] = applyEngineEventToProjection(base, { ...event, workSessionId });
          const previous = previousSessionProjections.get(event.taskRunId);
          if (previous?.userMessage && !projections[event.taskRunId].userMessage) {
            projections[event.taskRunId] = {
              ...projections[event.taskRunId],
              userMessage: previous.userMessage,
            };
          }
          taskEventsByRunId[event.taskRunId] = [...(taskEventsByRunId[event.taskRunId] ?? []), { ...event, workSessionId }].slice(-MAX_TASK_EVENTS_PER_RUN);
          if (!order.includes(event.taskRunId)) order.push(event.taskRunId);
        });

        for (const [taskRunId, projection] of previousSessionProjections) {
          if (projections[taskRunId]) continue;
          if (!projection.userMessage && !projection.assistantMessage?.content) continue;
          projections[taskRunId] = projection;
          if (!order.includes(taskRunId)) order.push(taskRunId);
        }

        const liveTaskRunIds = new Set(
          [state.runningTaskRunId, state.runningSessionId].filter((taskRunId): taskRunId is string => Boolean(taskRunId)),
        );

        for (const taskRunId of order) {
          const projection = projections[taskRunId];
          if (
            !liveTaskRunIds.has(taskRunId)
            && (projection.status === "running" || projection.status === "routing" || projection.status === "streaming")
          ) {
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
          taskEventsByRunId,
          taskRunOrderBySession: {
            ...state.taskRunOrderBySession,
            [workSessionId]: order.sort((left, right) => {
              const leftProjection = projections[left];
              const rightProjection = projections[right];
              const byTime = (leftProjection?.startedAt ?? "").localeCompare(rightProjection?.startedAt ?? "");
              return byTime || left.localeCompare(right);
            }),
          },
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
