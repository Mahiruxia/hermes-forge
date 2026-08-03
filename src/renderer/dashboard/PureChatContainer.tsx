import { AlertCircle, ArrowRight, Brain, ChevronDown, Copy, Ellipsis, FileDown, Loader2, RefreshCcw, Sparkles, Timer, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ApprovalRequest, ClarifyRequest, EngineEvent, TaskEventEnvelope, TaskRunProjection, ToolEvent } from "../../shared/types";
import { StreamingMarkdown } from "../markdown/StreamingMarkdown";
import { useAppStore } from "../store";
import { ChatInput } from "./ChatInput";
import { cn, formatShortDate } from "./DashboardPrimitives";

type FixTarget = "model" | "hermes" | "health" | "diagnostics" | "workspace";
const CHAT_RUN_WINDOW_INITIAL = 64;
const CHAT_RUN_WINDOW_STEP = 40;
const EMPTY_EVENTS: TaskEventEnvelope[] = [];
const LONG_REPLY_FILE_THRESHOLD = 12_000;

export function PureChatContainer(props: {
  runs: TaskRunProjection[];
  onPickWorkspace: () => void;
  onCreateSession?: () => void;
  onClearSession?: () => void;
  onStartTask: () => void;
  onCancelTask: () => void;
  onRestoreSnapshot: () => void;
  onOpenFix?: (target: FixTarget) => void;
  onUsePromptSuggestion?: (prompt: string) => void;
  onOpenWorkspaceDrawer?: () => void;
  canStart: boolean;
  sendBlockReason?: string;
  sendBlockTarget?: FixTarget;
  latestSnapshotAvailable: boolean;
  locked: boolean;
}) {
  const workspacePath = useAppStore((state) => state.workspacePath);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const [followBottom, setFollowBottom] = useState(true);
  const [composerHeight, setComposerHeight] = useState(156);
  const [renderLimit, setRenderLimit] = useState(CHAT_RUN_WINDOW_INITIAL);
  const visibleRuns = useMemo(
    () =>
      props.runs.slice().sort((left, right) => {
        const byTime = runTimestamp(left).localeCompare(runTimestamp(right));
        return byTime || left.taskRunId.localeCompare(right.taskRunId);
      }),
    [props.runs],
  );
  const renderedRuns = useMemo(() => visibleRuns.slice(-renderLimit), [renderLimit, visibleRuns]);
  const hiddenRunCount = Math.max(0, visibleRuns.length - renderedRuns.length);
  const lastRun = visibleRuns[visibleRuns.length - 1];
  const latestRunSignature = lastRun
    ? `${lastRun.taskRunId}:${lastRun.status}:${lastRun.assistantMessage.content.length}:${lastRun.toolEvents.length}`
    : "";

  const scrollFrameRef = useRef<number | null>(null);
  useEffect(() => {
    if (followBottom) {
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
        scrollFrameRef.current = null;
      });
    }
    return () => {
      if (scrollFrameRef.current) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [latestRunSignature, followBottom, visibleRuns.length]);

  useEffect(() => {
    if (visibleRuns.length <= CHAT_RUN_WINDOW_INITIAL) {
      setRenderLimit(CHAT_RUN_WINDOW_INITIAL);
    }
  }, [visibleRuns.length]);

  useEffect(() => {
    const composer = composerShellRef.current;
    if (!composer) return undefined;

    const updateComposerHeight = () => {
      setComposerHeight(Math.ceil(composer.getBoundingClientRect().height || 156));
    };
    updateComposerHeight();

    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="hermes-chat-shell relative flex h-full min-h-0 flex-col bg-[#f6f7f9]">
      <div
        className="hermes-chat-scroll custom-scrollbar min-h-0 flex-1 overflow-y-auto bg-[#f6f7f9] px-4 py-5 sm:px-6"
        data-testid="chat-scroll"
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollTop < 96 && renderLimit < visibleRuns.length) {
            setRenderLimit((current) => Math.min(visibleRuns.length, current + CHAT_RUN_WINDOW_STEP));
          }
          setFollowBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 160);
        }}
      >
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 2xl:max-w-[1240px]">
          {visibleRuns.length === 0 ? (
            <EmptyPureChat
              hasWorkspace={Boolean(workspacePath)}
              onUsePromptSuggestion={props.onUsePromptSuggestion}
              onOpenWorkspaceDrawer={props.onOpenWorkspaceDrawer}
              onPickWorkspace={props.onPickWorkspace}
            />
          ) : (
            <>
              {hiddenRunCount > 0 ? (
                <button
                  className="mx-auto rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-[12px] font-semibold text-slate-500 shadow-sm transition hover:border-[var(--hermes-primary-border)] hover:text-[var(--hermes-primary)]"
                  data-testid="load-older-runs"
                  onClick={() => setRenderLimit((current) => Math.min(visibleRuns.length, current + CHAT_RUN_WINDOW_STEP))}
                  type="button"
                >
                  显示更早的 {hiddenRunCount} 轮对话
                </button>
              ) : null}
              {renderedRuns.map((run) => <PureRun key={run.taskRunId} run={run} onOpenFix={props.onOpenFix} />)}
            </>
          )}
          <PendingNativeCards />
          <div ref={bottomRef} />
        </div>
      </div>

      {!followBottom ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 flex justify-center"
          data-testid="scroll-to-bottom-overlay"
          style={{ bottom: composerHeight + 12 }}
        >
          <button
            aria-label="回到底部"
            className="pointer-events-auto rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-[12px] font-semibold text-slate-600 shadow-[0_8px_30px_rgba(15,23,42,0.10)] backdrop-blur transition hover:bg-white hover:text-slate-900"
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })}
            type="button"
          >
            回到底部
          </button>
        </div>
      ) : null}

      <div ref={composerShellRef} className="hermes-composer-shell shrink-0 bg-[#f6f7f9]">
        <ChatInput
          onStartTask={props.onStartTask}
          onCancelTask={props.onCancelTask}
          onPickWorkspace={props.onPickWorkspace}
          onCreateSession={props.onCreateSession}
          onClearSession={props.onClearSession}
          onRestoreSnapshot={props.onRestoreSnapshot}
          onOpenFix={props.onOpenFix}
          canStart={props.canStart}
          sendBlockReason={props.sendBlockReason}
          sendBlockTarget={props.sendBlockTarget}
          latestSnapshotAvailable={props.latestSnapshotAvailable}
          locked={props.locked}
        />
      </div>
    </div>
  );
}

function PendingNativeCards() {
  const store = useAppStore(useShallow((state) => ({
    activeSessionId: state.activeSessionId,
    events: state.events,
    pendingApprovalCards: state.pendingApprovalCards,
    pendingClarifyCards: state.pendingClarifyCards,
    taskEventsByRunId: state.taskEventsByRunId,
    taskRunProjectionsById: state.taskRunProjectionsById,
    lastWebUiError: state.lastWebUiError,
    setLastWebUiError: state.setLastWebUiError,
    resolveApprovalCard: state.resolveApprovalCard,
    resolveClarifyCard: state.resolveClarifyCard,
    setUserInput: state.setUserInput,
    error: state.error,
  })));
  const approvals = useMemo(
    () => store.pendingApprovalCards
      .filter((card) => card.status === "pending")
      .filter((card) => approvalBelongsToSession(card, store)),
    [store],
  );
  const clarifies = useMemo(
    () => store.pendingClarifyCards
      .filter((card) => card.status === "pending")
      .filter((card) => clarifyBelongsToSession(card, store.activeSessionId)),
    [store],
  );
  if (!approvals.length && !clarifies.length && !store.lastWebUiError) return null;

  return (
    <div className="grid gap-2">
      {store.lastWebUiError ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-[13px] text-amber-800">
          {store.lastWebUiError}
          <button className="ml-3 font-semibold" onClick={() => store.setLastWebUiError(undefined)} type="button">关闭</button>
        </div>
      ) : null}
      {approvals.map((card) => (
        <div key={card.id} className="rounded-2xl border border-slate-200/70 bg-white/80 px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
          <p className="text-[13px] font-semibold text-slate-800">{card.title}</p>
          {card.command ? <code className="mt-2 block rounded-xl bg-slate-50 p-2 text-[12px] text-slate-600">{card.command}</code> : null}
          {card.details ? <p className="mt-2 text-[12px] text-slate-500">{card.details}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="rounded-full bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-white" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "once", editedCommand: card.command }).then(() => store.resolveApprovalCard(card.id, "approved")).catch((err) => store.error("审批操作失败", err instanceof Error ? err.message : "未知错误"))} type="button">本次允许</button>
            <button className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "session", editedCommand: card.command }).then(() => store.resolveApprovalCard(card.id, "approved")).catch((err) => store.error("审批操作失败", err instanceof Error ? err.message : "未知错误"))} type="button">本会话允许</button>
            <button className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "always", editedCommand: card.command }).then(() => store.resolveApprovalCard(card.id, "approved")).catch((err) => store.error("审批操作失败", err instanceof Error ? err.message : "未知错误"))} type="button">始终允许</button>
            <button className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "deny" }).then(() => store.resolveApprovalCard(card.id, "denied")).catch((err) => store.error("审批操作失败", err instanceof Error ? err.message : "未知错误"))} type="button">拒绝</button>
          </div>
        </div>
      ))}
      {clarifies.map((card) => (
        <div key={card.id} className="rounded-2xl border border-slate-200/70 bg-white/80 px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
          <p className="text-[13px] font-semibold text-slate-800">{card.question}</p>
          {card.options?.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {card.options.map((option) => (
                <button
                  key={option}
                  className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600"
                  onClick={() => {
                    store.setUserInput(option);
                    store.resolveClarifyCard(card.id, "answered");
                  }}
                  type="button"
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function runTimestamp(run: TaskRunProjection) {
  return run.userMessage?.createdAt || run.assistantMessage.createdAt || run.startedAt || run.updatedAt;
}

function PureRun(props: { run: TaskRunProjection; onOpenFix?: (target: FixTarget) => void }) {
  return (
    <section className="flex flex-col gap-2" data-testid="chat-run">
      {props.run.userMessage ? (
        <ChatMessageCard
          role="user"
          createdAt={props.run.userMessage.createdAt}
          content={<p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed [overflow-wrap:anywhere]">{props.run.userMessage.content}</p>}
        />
      ) : null}
      <AssistantMessageCard run={props.run} onOpenFix={props.onOpenFix} />
    </section>
  );
}

function ChatMessageCard(props: { role: "user" | "assistant"; createdAt: string; content: ReactNode; chrome?: ReactNode; metaSuffix?: string; actions?: ReactNode }) {
  const isUser = props.role === "user";
  return (
    <article
      className={cn(
        "hermes-message-card group relative min-w-0 overflow-hidden rounded-[24px] px-5 py-4 shadow-[0_16px_38px_rgba(15,23,42,0.05)] outline-none transition",
        isUser
          ? "hermes-message-card--user ml-auto max-w-[min(64%,560px)] border border-blue-100 bg-[#eef5ff] text-slate-800 max-sm:max-w-[92%]"
          : "hermes-message-card--assistant w-full max-w-3xl border border-[var(--hermes-card-border)] bg-white text-slate-800",
      )}
      tabIndex={0}
    >
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3 text-[11px] text-slate-400">
        <div className="inline-flex min-w-0 items-center gap-2">
          {!isUser ? (
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--hermes-primary-soft)] text-[var(--hermes-primary)] ring-1 ring-[var(--hermes-primary-border)]">
              <Sparkles size={15} />
            </span>
          ) : null}
          <span className={cn(
            "font-semibold",
            isUser ? "text-slate-600" : "text-slate-900",
          )}>
            {isUser ? "你" : "Hermes"}
          </span>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <span className="whitespace-nowrap">{props.metaSuffix ? `${props.metaSuffix} · ${formatShortDate(props.createdAt)}` : formatShortDate(props.createdAt)}</span>
          {props.actions}
        </div>
      </div>

      {props.chrome}

      <div>{props.content}</div>
    </article>
  );
}

function AssistantMessageCard(props: { run: TaskRunProjection; onOpenFix?: (target: FixTarget) => void }) {
  const { run } = props;
  const eventsForRun = useAppStore((state) => state.taskEventsByRunId[run.taskRunId]) ?? EMPTY_EVENTS;
  const showUsage = useAppStore((state) => state.webUiOverview?.settings.showUsage);
  const content = run.assistantMessage.content.trim();
  const usage = useMemo(() => preferredUsageForRun(eventsForRun), [eventsForRun]);
  const thoughtStatus = useMemo(() => buildThoughtStatus(run, eventsForRun), [run, eventsForRun]);
  const waiting = !content && (run.status === "pending" || run.status === "routing" || run.status === "running" || run.status === "streaming");
  const softStreaming = Boolean(content) && run.status === "streaming";
  const completed = run.status === "complete";
  const statusLabel = completed ? "已完成" : softStreaming ? "补充中" : waiting ? "处理中" : run.status === "cancelled" ? "已取消" : run.status === "interrupted" ? "已中断" : run.status === "failed" ? "未完成" : "回复中";
  const activeTiming = run.status === "pending" || run.status === "routing" || run.status === "running" || run.status === "streaming";

  async function copyMessage() {
    try {
      const result = await window.workbenchClient.writeClipboard(run.assistantMessage.content);
      if (result.ok) {
        useAppStore.getState().success("已复制回复", "当前消息内容已写入剪贴板");
      } else {
        useAppStore.getState().error("复制失败", "无法写入剪贴板");
      }
    } catch (error) {
      useAppStore.getState().error("复制失败", error instanceof Error ? error.message : "无法写入剪贴板");
    }
  }

  function continueMessage() {
    const feedback = useAppStore.getState();
    feedback.setUserInput("继续，保持当前上下文往下完成。");
    feedback.info("已填入继续指令", "可以直接发送，让 Hermes 在当前上下文继续处理");
  }

  return (
    <ChatMessageCard
      role="assistant"
      createdAt={run.assistantMessage.createdAt}
      metaSuffix={statusLabel}
      actions={<AssistantMessageActions run={run} onCopy={() => void copyMessage()} onContinue={continueMessage} />}
      chrome={(
        <>
          <div className="mb-3 flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {run.modelId ? <MessageMetaPill>{run.modelId}</MessageMetaPill> : null}
              <ElapsedTimePill startedAt={run.startedAt} completedAt={run.completedAt} active={activeTiming} />
              {showUsage && usage?.type === "usage" ? (
                <MessageMetaPill tone="emerald">
                  {usage.source === "actual" ? "实测" : "约"} {displayUsageTokens(usage)} token
                </MessageMetaPill>
              ) : null}
              {usage?.reasoningTokens ? (
                <MessageMetaPill tone="purple">
                  思考 {usage.reasoningTokens} token
                </MessageMetaPill>
              ) : null}
              {thoughtStatus.visible ? (
                <MessageMetaPill tone={thoughtStatus.tone}>{thoughtStatus.label}</MessageMetaPill>
              ) : null}
            </div>
          </div>

        </>
      )}
      content={(
        <>
          {run.status === "failed" || run.status === "cancelled" || run.status === "interrupted" ? <FailureInline status={run.status} content={run.assistantMessage.content} onOpenFix={props.onOpenFix} /> : null}

          {waiting ? (
            <TypingState phase={run.status === "routing" ? "handoff" : "replying"} thoughtStatus={thoughtStatus} startedAt={run.startedAt} />
          ) : (
            <div className="hermes-assistant-bubble relative min-w-0 overflow-hidden rounded-[22px] border border-[var(--hermes-primary-border)] bg-[var(--hermes-primary-soft)] p-4 before:absolute before:left-0 before:top-5 before:h-10 before:w-1 before:rounded-r-full before:bg-[var(--hermes-primary)]">
              {thoughtStatus.visible && thoughtStatus.phase !== "replying" ? <ThoughtStatusStrip status={thoughtStatus} /> : null}
              <StreamingMarkdown content={run.assistantMessage.content} isStreaming={run.status === "streaming"} className="hermes-markdown min-w-0 max-w-full break-words text-[14px] leading-relaxed text-slate-800 [overflow-wrap:anywhere]" />
              {completed && run.assistantMessage.content.length > LONG_REPLY_FILE_THRESHOLD ? <LongReplyExportHint run={run} /> : null}
              {softStreaming ? <SoftStreamingHint /> : null}
            </div>
          )}

          {run.toolEvents.length > 0 ? <ToolSummary tools={run.toolEvents} /> : null}
        </>
      )}
    />
  );
}

function approvalBelongsToSession(
  card: ApprovalRequest,
  store: Pick<ReturnType<typeof useAppStore.getState>, "activeSessionId" | "events" | "taskEventsByRunId" | "taskRunProjectionsById">,
) {
  if (!store.activeSessionId) return true;
  const projection = store.taskRunProjectionsById[card.taskRunId];
  if (projection) return projection.workSessionId === store.activeSessionId;
  const knownEvents = store.taskEventsByRunId[card.taskRunId] ?? store.events.filter((event) => event.taskRunId === card.taskRunId);
  if (!knownEvents.length) return false;
  return knownEvents.some((event) => event.workSessionId === store.activeSessionId);
}

function clarifyBelongsToSession(card: ClarifyRequest, activeSessionId?: string) {
  if (!activeSessionId) return true;
  if (!card.sessionId && !card.taskRunId) return true;
  return card.sessionId === activeSessionId;
}

function LongReplyExportHint(props: { run: TaskRunProjection }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--hermes-primary-border)] bg-white/80 px-3 py-2.5 text-[12px] text-slate-600 shadow-sm">
      <span className="inline-flex min-w-0 items-center gap-2">
        <FileDown size={14} className="shrink-0 text-[var(--hermes-primary)]" />
        <span className="min-w-0">
          这条回复较长，建议导出为 Markdown 文件保存或转发。
        </span>
      </span>
      <button
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--hermes-primary)] px-3 text-[12px] font-semibold text-white transition hover:bg-[var(--hermes-primary-strong)]"
        onClick={() => void exportAssistantMessage(props.run)}
        type="button"
      >
        <FileDown size={13} />
        导出 Markdown
      </button>
    </div>
  );
}

function AssistantMessageActions(props: { run: TaskRunProjection; onCopy: () => void; onContinue: () => void }) {
  return (
    <div className="hermes-message-actions pointer-events-none inline-flex items-center gap-1 rounded-full border border-[var(--hermes-primary-border)] bg-white/95 px-1.5 py-1 opacity-0 shadow-[0_8px_24px_rgba(91,77,255,0.12)] transition group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
      <MessageActionButton icon={Copy} label="复制内容" onClick={props.onCopy} />
      <MessageActionButton icon={RefreshCcw} label="继续生成" onClick={props.onContinue} />
      <AssistantMoreMenu run={props.run} onCopy={props.onCopy} onContinue={props.onContinue} />
    </div>
  );
}

type ThoughtStatus = {
  visible: boolean;
  label: string;
  detail: string;
  tone: "slate" | "emerald" | "amber" | "rose" | "purple";
  phase: "preparing" | "thinking" | "tool" | "replying";
};

function preferredUsageForRun(eventsForRun: TaskEventEnvelope[]) {
  const usageEvents = eventsForRun
    .map((event) => event.event)
    .filter((event): event is Extract<EngineEvent, { type: "usage" }> => event.type === "usage");
  const actualEvents = usageEvents.filter((event) => event.source === "actual");
  return latestUsageEvent(actualEvents.length ? actualEvents : usageEvents);
}

function latestUsageEvent(events: Array<Extract<EngineEvent, { type: "usage" }>>) {
  return events.reduce<Extract<EngineEvent, { type: "usage" }> | undefined>((latest, event) => {
    if (!latest) return event;
    return event.at >= latest.at ? event : latest;
  }, undefined);
}

function displayUsageTokens(usage: Extract<EngineEvent, { type: "usage" }>) {
  const total = usage.totalTokens
    ?? (usage.source === "actual" && typeof usage.contextTokens === "number"
      ? usage.contextTokens + usage.outputTokens
      : usage.inputTokens + usage.outputTokens);
  return total.toLocaleString();
}

function buildThoughtStatus(run: TaskRunProjection, events: TaskEventEnvelope[]): ThoughtStatus {
  const active = run.status === "pending" || run.status === "routing" || run.status === "running" || run.status === "streaming";
  const hasContent = Boolean(run.assistantMessage.content.trim());
  const defaultStatus: ThoughtStatus = {
    visible: active,
    label: run.status === "routing" ? "准备上下文" : hasContent ? "正在写回复" : "思考中",
    detail: run.status === "routing"
      ? "正在读取会话、工作区和执行配置。"
      : hasContent
        ? "正文正在继续生成，可以先看已出现的内容。"
        : "正在判断下一步，暂时还没有正文。",
    tone: run.status === "routing" ? "slate" : hasContent ? "emerald" : "purple",
    phase: run.status === "routing" ? "preparing" : hasContent ? "replying" : "thinking",
  };
  if (!active) return { ...defaultStatus, visible: false };

  const latestEvent = events.at(-1)?.event;
  const runningTool = run.toolEvents.find((tool) => tool.status === "running");
  if (runningTool) {
    return {
      visible: true,
      label: "正在使用工具",
      detail: `正在处理：${runningTool.label}`,
      tone: "amber",
      phase: "tool",
    };
  }
  if (latestEvent?.type === "tool_call") {
    return {
      visible: true,
      label: latestEvent.status === "failed" ? "工具异常" : "正在使用工具",
      detail: `正在处理：${latestEvent.toolName}`,
      tone: latestEvent.status === "failed" ? "rose" : "amber",
      phase: "tool",
    };
  }
  if (latestEvent?.type === "tool_result" && !hasContent) {
    return {
      visible: true,
      label: latestEvent.success === false ? "工具异常" : "整理工具结果",
      detail: latestEvent.success === false
        ? `${latestEvent.toolName} 没有顺利完成，正在判断怎么继续。`
        : `${latestEvent.toolName} 已返回，正在把结果整理成回复。`,
      tone: latestEvent.success === false ? "rose" : "amber",
      phase: "tool",
    };
  }
  if (latestEvent?.type === "reasoning") {
    return {
      visible: true,
      label: "思考中",
      detail: "正在分析任务和上下文，正文还没开始输出。",
      tone: "purple",
      phase: "thinking",
    };
  }
  if (hasContent && run.status === "streaming") {
    return {
      visible: true,
      label: "正在写回复",
      detail: "正文正在继续生成，可以先看已出现的内容。",
      tone: "emerald",
      phase: "replying",
    };
  }
  if (latestEvent?.type === "progress") {
    return {
      visible: true,
      label: latestEvent.done ? "步骤完成" : "处理中",
      detail: latestEvent.message,
      tone: latestEvent.done ? "emerald" : "amber",
      phase: latestEvent.step.includes("snapshot") ? "preparing" : "thinking",
    };
  }
  if (latestEvent?.type === "status") {
    const autoContinuing = /自动继续|未完成|继续/.test(latestEvent.message);
    return {
      visible: true,
      label: latestEvent.level === "error" ? "状态异常" : autoContinuing ? "自动续写中" : "处理中",
      detail: autoContinuing ? "上一段可能没说完，正在补全后续内容。" : latestEvent.message,
      tone: latestEvent.level === "error" ? "rose" : latestEvent.level === "warning" ? "amber" : "slate",
      phase: "preparing",
    };
  }
  if (latestEvent?.type === "lifecycle") {
    if (latestEvent.stage !== "running" && latestEvent.stage !== "streaming" && run.status === "running" && !hasContent) {
      return defaultStatus;
    }
    return {
      visible: true,
      label: latestEvent.stage === "streaming" ? "正在写回复" : latestEvent.stage === "running" ? "思考中" : "准备上下文",
      detail: latestEvent.stage === "streaming" ? "正文正在继续生成。" : latestEvent.stage === "running" ? "正在分析任务和上下文。" : "正在进入本轮任务。",
      tone: latestEvent.stage === "streaming" ? "emerald" : latestEvent.stage === "running" ? "purple" : "slate",
      phase: latestEvent.stage === "streaming" ? "replying" : latestEvent.stage === "running" ? "thinking" : "preparing",
    };
  }
  return defaultStatus;
}

function MessageActionButton(props: { icon: typeof Copy; label: string; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <button
      className="grid h-8 w-8 place-items-center rounded-full text-slate-500 transition hover:bg-[var(--hermes-primary-soft)] hover:text-[var(--hermes-primary)]"
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
      type="button"
    >
      <Icon size={14} />
    </button>
  );
}

function AssistantMoreMenu(props: { run: TaskRunProjection; onCopy: () => void; onContinue: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  function fillPrompt(text: string, toast: string) {
    const store = useAppStore.getState();
    store.setUserInput(text);
    store.info("已填入后续动作", toast);
    setOpen(false);
  }

  return (
    <div className="relative" ref={menuRef}>
      <MessageActionButton icon={Ellipsis} label="更多操作" onClick={() => setOpen((value) => !value)} />
      {open ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-48 rounded-2xl border border-[var(--hermes-card-border)] bg-white p-1.5 shadow-[0_18px_45px_rgba(15,23,42,0.12)]">
          <MenuAction label="继续分析" onClick={props.onContinue} />
          <MenuAction label="风格解析" onClick={() => fillPrompt("请分析你刚才这份输出的表达风格、结构与可复用模板。", "已填入风格解析指令")} />
          <MenuAction label="配色提取" onClick={() => fillPrompt("请从你刚才的输出里提取可复用的配色、层级和界面语言建议。", "已填入配色提取指令")} />
          <MenuAction label="复制全文" onClick={props.onCopy} />
          <MenuAction label="导出结果" onClick={() => {
            void exportAssistantMessage(props.run);
            setOpen(false);
          }} />
        </div>
      ) : null}
    </div>
  );
}

async function exportAssistantMessage(run: TaskRunProjection) {
  try {
    const result = await window.workbenchClient.exportMessage({
      content: run.assistantMessage.content,
      suggestedName: `hermes-${run.taskRunId}.md`,
    });
    if (result.ok) {
      useAppStore.getState().success("导出成功", result.message ?? "消息已保存");
    } else {
      useAppStore.getState().error("导出失败", result.message ?? "保存文件时出错");
    }
  } catch (error) {
    useAppStore.getState().error("导出失败", error instanceof Error ? error.message : "无法保存文件");
  }
}

function MenuAction(props: { label: string; onClick: () => void }) {
  return (
    <button className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] text-slate-600 transition hover:bg-[var(--hermes-primary-soft)] hover:text-[var(--hermes-primary)]" onClick={props.onClick} type="button">
      {props.label}
    </button>
  );
}

function MessageMetaPill(props: { children: ReactNode; tone?: "slate" | "emerald" | "amber" | "rose" | "purple" }) {
  return (
    <span className={cn(
      "inline-flex max-w-[160px] items-center truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium",
      (!props.tone || props.tone === "slate") && "bg-slate-50/70 text-slate-400",
      props.tone === "purple" && "bg-[var(--hermes-primary-soft)] text-[var(--hermes-primary)]",
      props.tone === "emerald" && "bg-emerald-50/60 text-emerald-600",
      props.tone === "amber" && "bg-amber-50/60 text-amber-600",
      props.tone === "rose" && "bg-rose-50/60 text-rose-600",
    )}>
      {props.children}
    </span>
  );
}

function ElapsedTimePill(props: { startedAt?: string; completedAt?: string; active: boolean }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!props.active) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.active]);

  const startedMs = props.startedAt ? Date.parse(props.startedAt) : Number.NaN;
  if (!Number.isFinite(startedMs)) return null;
  const completedMs = props.completedAt ? Date.parse(props.completedAt) : Number.NaN;
  const endMs = props.active || !Number.isFinite(completedMs) ? nowMs : completedMs;
  const elapsedMs = Math.max(0, endMs - startedMs);
  const label = props.active ? "已处理" : "耗时";
  return (
    <MessageMetaPill tone={props.active ? "amber" : "slate"}>
      <span className="inline-flex min-w-0 items-center gap-1">
        <Timer size={10} className="shrink-0" />
        <span>{label} {formatElapsedMs(elapsedMs)}</span>
      </span>
    </MessageMetaPill>
  );
}

function ToolSummary(props: { tools: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  const failed = props.tools.filter((tool) => tool.status === "failed").length;
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200/80 bg-slate-50/70">
      <button className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[11px] font-medium text-slate-500" onClick={() => setOpen((value) => !value)} type="button">
        <span className="inline-flex items-center gap-2">
          <Wrench size={13} />
          工具过程 · {props.tools.length} 步{failed ? ` · ${failed} 步未完成` : ""}
        </span>
        <ChevronDown size={14} className={cn("transition-transform duration-300", open && "rotate-180")} />
      </button>
      <div className={cn("grid transition-all duration-300 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="overflow-hidden">
          <div className="space-y-1 px-3 pb-3">
            {props.tools.map((tool) => (
              <div key={tool.id} className="flex items-start justify-between gap-3 rounded-xl bg-white px-3 py-2 text-[12px] max-sm:flex-col max-sm:gap-1.5">
                <span className="font-medium text-slate-700">{tool.label}</span>
                <span className={cn("min-w-0 break-words text-right text-slate-400 [overflow-wrap:anywhere] max-sm:text-left", tool.status === "failed" && "text-rose-600")}>
                  {tool.summary ?? tool.path ?? tool.command ?? tool.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyPureChat(props: { hasWorkspace: boolean; onPickWorkspace: () => void; onUsePromptSuggestion?: (prompt: string) => void; onOpenWorkspaceDrawer?: () => void }) {
  const suggestions = props.hasWorkspace
    ? [
        { title: "快速理解项目", detail: "找出入口、关键模块和运行方式", prompt: "分析这个项目结构，并告诉我入口文件和关键模块。" },
        { title: "定位并修复问题", detail: "先说明原因，再实施可验证的修复", prompt: "帮我修复当前报错，并说明你准备怎么处理。" },
        { title: "整理项目结构", detail: "给出更清晰、可落地的文件分组", prompt: "整理这个目录，并给我一个更清晰的文件分组方案。" },
      ]
    : [
        { title: "分析项目结构", detail: "选择目录后定位入口和关键模块", prompt: "先选择一个工作区，然后分析这个项目结构。" },
        { title: "检查启动状态", detail: "核对配置、依赖和运行命令", prompt: "先选择一个工作区，然后检查配置和启动状态。" },
        { title: "运行基础诊断", detail: "检查 Hermes 与项目环境是否就绪", prompt: "先选择一个工作区，然后帮我跑一次基础诊断。" },
      ];
  return (
    <div className="grid min-h-[48vh] place-items-center">
      <div className="grid w-full max-w-[920px] gap-8 px-5 py-10 text-left lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)] lg:items-center lg:px-8">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.14em] text-slate-400">新任务</p>
          <h3 className="mt-3 text-balance text-[32px] font-semibold leading-[1.1] tracking-[-0.04em] text-slate-950">
            {props.hasWorkspace ? "今天想推进什么？" : "先连接你的项目"}
          </h3>
          <p className="mt-4 max-w-[46ch] text-pretty text-[14px] leading-6 text-slate-500">
            {props.hasWorkspace
              ? "描述目标即可开始。Hermes 会在当前工作区读取上下文，执行过程和需要确认的操作会就地显示。"
              : "选择一个项目目录后，Hermes 才能读取真实文件、运行命令并保存修改。你仍然可以先写下需求，草稿会自动保留。"}
          </p>
          <button
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_12px_28px_rgba(15,23,42,0.16)] transition hover:-translate-y-0.5 hover:bg-slate-800 active:translate-y-0"
            onClick={props.hasWorkspace ? props.onOpenWorkspaceDrawer : props.onPickWorkspace}
            type="button"
          >
            {props.hasWorkspace ? "打开工作区文件" : "选择工作区"}
            <ArrowRight size={14} />
          </button>
          <p className="mt-4 text-[11px] leading-5 text-slate-400">
            提示：按 <kbd className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-500">Ctrl K</kbd> 聚焦输入框，也支持拖拽文件、粘贴图片和 <span className="font-mono text-slate-500">/</span> 命令。
          </p>
        </div>

        <div className="grid gap-2" aria-label="任务建议">
          <p className="mb-1 px-1 text-[11px] font-semibold text-slate-400">从常见任务开始</p>
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.prompt}
              className="group flex items-center gap-4 rounded-2xl border border-slate-200/80 bg-white px-4 py-3.5 text-left shadow-[0_10px_28px_rgba(15,23,42,0.035)] transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_14px_34px_rgba(15,23,42,0.07)]"
              onClick={() => props.onUsePromptSuggestion?.(suggestion.prompt)}
              type="button"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 font-mono text-[11px] font-semibold tabular-nums text-slate-500 transition group-hover:bg-slate-900 group-hover:text-white">0{index + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-slate-800">{suggestion.title}</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{suggestion.detail}</span>
                <span className="sr-only">：{suggestion.prompt}</span>
              </span>
              <ChevronDown size={14} className="-rotate-90 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-600" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function FailureInline(props: { status: TaskRunProjection["status"]; content: string; onOpenFix?: (target: FixTarget) => void }) {
  const label = props.status === "interrupted" ? "上次回复中断了" : props.status === "cancelled" ? "这次回复已取消" : "这次回复没有顺利完成";
  const failure = failureGuidance(props.status, props.content);
  return (
    <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50/85 px-4 py-3 text-[12px] text-rose-700">
      <div className="inline-flex items-center gap-2 font-medium">
        <AlertCircle size={13} />
        {label}
      </div>
      <p className="mt-1 leading-5 text-rose-600">{failure.hint}</p>
      {failure.action ? <p className="mt-1 text-[11px] text-rose-500">建议动作：{failure.action}</p> : null}
      {failure.target ? (
        <button
          className="mt-2 rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50"
          onClick={() => props.onOpenFix?.(failure.target)}
          type="button"
        >
          {failure.cta}
        </button>
      ) : null}
    </div>
  );
}

function failureGuidance(status: TaskRunProjection["status"], content: string) {
  const text = content.trim();
  if (status === "cancelled") {
    return { hint: "本轮任务是主动取消，不代表配置有问题。", action: "可以直接重新发起任务" };
  }
  if (status === "interrupted") {
    return { hint: "回复在过程中断，建议先看过程详情确认卡在哪一步。", action: "检查过程后重新发起任务" };
  }
  if (/NoConsoleScreenBufferError|No Windows console found|prompt_toolkit\.output\.win32|控制台初始化失败/i.test(text)) {
    return {
      hint: "当前更像是 Windows 下 Hermes CLI 拿不到可用控制台，不是模型或密钥配置错误。",
      action: "先检查 Windows Native Hermes 路径、Python 环境和模型配置后重试",
      target: "hermes" as const,
      cta: "打开 Hermes 设置",
    };
  }
  if (/锁释放后重试|工作区正在被占用|WORKSPACE_LOCKED/i.test(text)) {
    return { hint: "当前更像是工作区锁冲突，并不是 Hermes 本身不可用。", action: "等待当前任务结束后重试" };
  }
  if (/模型|密钥|configure_model|配置或环境问题|API Key/i.test(text)) {
    return { hint: "当前更像是模型配置或密钥问题。", action: "先检查设置页中的模型与密钥", target: "model" as const, cta: "打开模型配置" };
  }
  if (/CLI|退出码|Hermes CLI 执行失败/i.test(text)) {
    return { hint: "Hermes CLI 本轮执行没有顺利完成。", action: "检查 Hermes CLI、模型配置与工作区上下文后重试", target: "diagnostics" as const, cta: "导出诊断" };
  }
  if (/超时|等待时间偏长|缩小任务范围|未完成/i.test(text)) {
    return { hint: "本轮更像是等待过久或任务范围偏大。", action: "缩小任务范围或减少上下文后重试" };
  }
  return { hint: "建议先查看过程详情，确认失败阶段后再决定是否重试。", action: "查看过程详情或导出诊断", target: "diagnostics" as const, cta: "导出诊断" };
}

function formatElapsedMs(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function ThoughtStatusStrip(props: { status: ThoughtStatus }) {
  return (
    <div className={cn(
      "mb-3 inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] shadow-sm",
      props.status.phase === "thinking" && "border-[var(--hermes-primary-border)] bg-white/70 text-[var(--hermes-primary)]",
      props.status.phase === "tool" && "border-amber-200 bg-amber-50/80 text-amber-700",
      props.status.phase === "replying" && "border-emerald-200 bg-emerald-50/80 text-emerald-700",
      props.status.phase === "preparing" && "border-slate-200 bg-white/70 text-slate-600",
    )}>
      <span className="relative grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/80">
        {props.status.phase === "thinking" ? <Brain size={13} /> : <Loader2 size={13} className="animate-spin" />}
      </span>
      <span className="min-w-0 truncate font-semibold">{props.status.label}</span>
      <span className="min-w-0 truncate opacity-75">{props.status.detail}</span>
    </div>
  );
}

function TypingState(props: { phase: "handoff" | "replying"; thoughtStatus?: ThoughtStatus; startedAt?: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 4000);
    return () => window.clearInterval(timer);
  }, []);

  const startedMs = props.startedAt ? Date.parse(props.startedAt) : Number.NaN;
  const elapsedSeconds = Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs - startedMs) / 1000)) : 0;
  const friendly = playfulStatusCopy(props.thoughtStatus, props.phase, elapsedSeconds);
  const title = friendly?.label ?? (props.thoughtStatus?.visible
    ? props.thoughtStatus.label
    : props.phase === "handoff" ? "Hermes 已接手" : "Hermes 正在回复中");
  const subtitle = friendly?.detail ?? (props.thoughtStatus?.visible
    ? props.thoughtStatus.detail
    : props.phase === "handoff"
    ? "正在读取会话、工作区和执行配置。"
    : "正在整理回复；如果等待偏久，可以展开工具过程看进度。");
  return (
    <div data-testid="typing-state" className="hermes-typing-card rounded-[22px] border border-slate-200/70 bg-white/75 px-4 py-3.5 shadow-sm">
      <div className="flex items-center gap-2.5 text-[13px] font-medium text-slate-600">
        <span className="relative inline-flex h-5 w-5 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-slate-200/70 [animation-duration:1.8s]" />
          <span className="relative inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
            {props.thoughtStatus?.phase === "thinking" ? <Brain size={12} className="text-[var(--hermes-primary)]" /> : <Loader2 size={12} className="animate-spin text-slate-400" />}
          </span>
        </span>
        <span>{title}</span>
      </div>
      <p className="mt-1.5 text-[12px] leading-5 text-slate-500">{subtitle}</p>
    </div>
  );
}

function playfulStatusCopy(status: ThoughtStatus | undefined, phase: "handoff" | "replying", elapsedSeconds: number): { label: string; detail: string } | undefined {
  const activePhase = status?.phase ?? (phase === "handoff" ? "preparing" : "thinking");
  if (activePhase === "tool") return status ? { label: status.label, detail: status.detail } : undefined;
  if (activePhase === "replying") {
    return elapsedSeconds < 10
      ? { label: "正在写回复", detail: "句子已经上路，正在排队出场。" }
      : { label: "还在补充", detail: "不是沉默，是在给答案收个漂亮的尾。" };
  }
  if (activePhase === "thinking") {
    if (elapsedSeconds < 8) return { label: "思考中", detail: "正在把问题拆开，先找最靠谱的那条线。" };
    if (elapsedSeconds < 18) return { label: "认真想想", detail: "脑内白板已经打开，正在把结论写清楚。" };
    return { label: "还在打磨", detail: "不是卡住，是在把话说顺一点。" };
  }
  if (elapsedSeconds < 5) return { label: "整理材料中", detail: "把上下文摊开，给 Hermes 留一条清爽的跑道。" };
  if (elapsedSeconds < 14) return { label: "正在热身", detail: "模型正在载入上下文，稍后开始输出。" };
  return { label: "快准备好了", detail: "上下文基本摆好，正在把第一句话找出来。" };
}

function SoftStreamingHint() {
  return (
    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white px-2.5 py-1 text-[12px] font-medium text-slate-500">
      <span className="inline-flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-300" />
        <span>Hermes 还在继续补充</span>
      </span>
    </div>
  );
}
