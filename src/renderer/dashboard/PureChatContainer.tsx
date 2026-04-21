import { AlertCircle, ChevronDown, Loader2, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TaskRunProjection, ToolEvent } from "../../shared/types";
import { StreamingMarkdown } from "../markdown/StreamingMarkdown";
import { useAppStore } from "../store";
import { ChatInput } from "./ChatInput";
import { cn, formatShortDate } from "./DashboardPrimitives";

export function PureChatContainer(props: {
  runs: TaskRunProjection[];
  onPickWorkspace: () => void;
  onCreateSession?: () => void;
  onClearSession?: () => void;
  onStartTask: () => void;
  onCancelTask: () => void;
  onRestoreSnapshot: () => void;
  canStart: boolean;
  latestSnapshotAvailable: boolean;
  locked: boolean;
}) {
  const store = useAppStore();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [followBottom, setFollowBottom] = useState(true);
  const visibleRuns = useMemo(
    () =>
      props.runs.slice().sort((left, right) => {
        const byTime = runTimestamp(left).localeCompare(runTimestamp(right));
        return byTime || left.taskRunId.localeCompare(right.taskRunId);
      }),
    [props.runs],
  );
  const latestRunSignature = visibleRuns
    .map((run) => `${run.taskRunId}:${run.status}:${run.toolEvents.length}`)
    .join("|");

  const scrollFrameRef = useRef<number | null>(null);
  useEffect(() => {
    if (followBottom) {
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ block: "end", behavior: visibleRuns.length > 1 ? "smooth" : "auto" });
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div
        className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5"
        onScroll={(event) => {
          const el = event.currentTarget;
          setFollowBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 160);
        }}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          {visibleRuns.length === 0 ? <EmptyPureChat /> : visibleRuns.map((run) => <PureRun key={run.taskRunId} run={run} />)}
          <PendingNativeCards />
          <div ref={bottomRef} />
        </div>
      </div>

      {!followBottom && (
        <button className="absolute bottom-32 left-1/2 z-10 -translate-x-1/2 rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-600 shadow-[0_8px_30px_rgb(0,0,0,0.04)] ring-1 ring-slate-100/70" onClick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })} type="button">
          回到底部
        </button>
      )}

      <div className="shrink-0 bg-white">
        <ChatInput
          onStartTask={props.onStartTask}
          onCancelTask={props.onCancelTask}
          onPickWorkspace={props.onPickWorkspace}
          onCreateSession={props.onCreateSession}
          onClearSession={props.onClearSession}
          onRestoreSnapshot={props.onRestoreSnapshot}
          canStart={props.canStart}
          latestSnapshotAvailable={props.latestSnapshotAvailable}
          locked={props.locked}
        />
      </div>
    </div>
  );
}

function PendingNativeCards() {
  const store = useAppStore();
  const approvals = store.pendingApprovalCards.filter((card) => card.status === "pending");
  const clarifies = store.pendingClarifyCards.filter((card) => card.status === "pending");
  if (!approvals.length && !clarifies.length && !store.lastWebUiError) return null;
  return (
    <div className="grid gap-2">
      {store.lastWebUiError ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
          {store.lastWebUiError}
          <button className="ml-3 font-semibold" onClick={() => store.setLastWebUiError(undefined)} type="button">关闭</button>
        </div>
      ) : null}
      {approvals.map((card) => (
        <div key={card.id} className="rounded-xl bg-slate-50/70 px-3 py-2">
          <p className="text-[13px] font-semibold text-slate-800">{card.title}</p>
          {card.command ? <code className="mt-2 block rounded-lg bg-slate-50 p-2 text-[12px] text-slate-600">{card.command}</code> : null}
          {card.details ? <p className="mt-2 text-[12px] text-slate-500">{card.details}</p> : null}
          <div className="mt-3 flex gap-2">
            <button className="rounded-md bg-indigo-100/70 px-3 py-1.5 text-[12px] font-semibold text-indigo-700" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "once", editedCommand: card.command }).then(() => store.resolveApprovalCard(card.id, "approved"))} type="button">本次允许</button>
            <button className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-200/50" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "session", editedCommand: card.command }).then(() => store.resolveApprovalCard(card.id, "approved"))} type="button">本会话允许</button>
            <button className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-200/50" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "always", editedCommand: card.command }).then(() => store.resolveApprovalCard(card.id, "approved"))} type="button">始终允许</button>
            <button className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-200/50" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "deny" }).then(() => store.resolveApprovalCard(card.id, "denied"))} type="button">拒绝</button>
          </div>
        </div>
      ))}
      {clarifies.map((card) => (
        <div key={card.id} className="rounded-xl bg-slate-50/70 px-3 py-2">
          <p className="text-[13px] font-semibold text-slate-800">{card.question}</p>
          {card.options?.length ? <div className="mt-2 flex flex-wrap gap-2">{card.options.map((option) => <button key={option} className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-200/50" onClick={() => { store.setUserInput(option); store.resolveClarifyCard(card.id, "answered"); }} type="button">{option}</button>)}</div> : null}
        </div>
      ))}
    </div>
  );
}

function runTimestamp(run: TaskRunProjection) {
  return run.userMessage?.createdAt || run.assistantMessage.createdAt || run.startedAt || run.updatedAt;
}

function PureRun(props: { run: TaskRunProjection }) {
  return (
    <section className="flex flex-col gap-2">
      {props.run.userMessage && <UserBubble content={props.run.userMessage.content} createdAt={props.run.userMessage.createdAt} />}
      <AssistantBubble run={props.run} />
    </section>
  );
}

function UserBubble(props: { content: string; createdAt: string }) {
  return (
    <article className="ml-auto max-w-[min(78%,720px)] rounded-2xl bg-indigo-50/50 px-4 py-3 text-slate-800 max-sm:max-w-[92%]">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-500">
        <span className="font-semibold">你</span>
        <span className="text-slate-400">{formatShortDate(props.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[14px] leading-7 [overflow-wrap:anywhere]">{props.content}</p>
    </article>
  );
}

function AssistantBubble(props: { run: TaskRunProjection }) {
  const { run } = props;
  const store = useAppStore();
  const content = run.assistantMessage.content.trim();
  const usage = [...store.events].reverse().find((event) => event.taskRunId === run.taskRunId && event.event.type === "usage")?.event;
  const waiting = !content && (run.status === "pending" || run.status === "routing" || run.status === "running" || run.status === "streaming");
  const softStreaming = Boolean(content) && run.status === "streaming";
  const completed = run.status === "complete";
  return (
    <article className="w-full max-w-4xl px-2 py-3 text-slate-800">
      <div className="mb-1 flex items-center gap-2 text-slate-500">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn("h-2 w-2 rounded-full bg-indigo-400", waiting && "animate-pulse")} />
          <strong className="truncate text-[12px] font-semibold text-indigo-700">Hermes</strong>
          {run.modelId && <MessageMetaPill>{run.modelId}</MessageMetaPill>}
          {store.webUiOverview?.settings.showUsage && usage?.type === "usage" ? <MessageMetaPill tone="emerald">{usage.inputTokens}+{usage.outputTokens} token</MessageMetaPill> : null}
          <MessageMetaPill tone={completed ? "emerald" : softStreaming ? "amber" : run.status === "failed" || run.status === "cancelled" || run.status === "interrupted" ? "rose" : "slate"}>
            {completed ? "已完成" : softStreaming ? "补充中" : waiting ? "处理中" : run.status === "cancelled" ? "已取消" : run.status === "interrupted" ? "已中断" : run.status === "failed" ? "未完成" : "回复中"}
          </MessageMetaPill>
        </div>
        <span className="text-[11px] text-slate-400">{formatShortDate(run.assistantMessage.createdAt)}</span>
      </div>

      <div className="mb-3 bg-white py-1">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-400">回复</span>
          {content ? <span className="text-[11px] text-slate-400">正文优先展示，过程细节已折叠</span> : null}
        </div>

        {run.status === "failed" || run.status === "cancelled" || run.status === "interrupted" ? <FailureInline status={run.status} content={run.assistantMessage.content} /> : null}

        {waiting ? (
          <TypingState phase={run.status === "routing" ? "handoff" : "replying"} />
        ) : (
          <>
            <StreamingMarkdown content={run.assistantMessage.content} isStreaming={run.status === "streaming"} className="prose prose-slate max-w-none break-words text-[14px] leading-7 text-slate-800 [overflow-wrap:anywhere] prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1" />
            {softStreaming ? <SoftStreamingHint /> : null}
          </>
        )}
      </div>

      {run.toolEvents.length > 0 ? <ToolSummary tools={run.toolEvents} /> : null}
    </article>
  );
}

function MessageMetaPill(props: { children: ReactNode; tone?: "slate" | "emerald" | "amber" | "rose" }) {
  return (
    <span className={cn(
      "inline-flex max-w-[160px] items-center truncate rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
      (!props.tone || props.tone === "slate") && "border-slate-200 text-slate-500",
      props.tone === "emerald" && "border-indigo-200 text-indigo-700",
      props.tone === "amber" && "border-amber-200 text-amber-700",
      props.tone === "rose" && "border-rose-200 text-rose-700",
    )}>
      {props.children}
    </span>
  );
}

function ToolSummary(props: { tools: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  const failed = props.tools.filter((tool) => tool.status === "failed").length;
  return (
    <div className="mt-3 overflow-hidden rounded-xl bg-slate-50/70 transition-all duration-300">
      <button className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] font-medium text-slate-500" onClick={() => setOpen((value) => !value)} type="button">
        <span className="inline-flex items-center gap-2">
          <Wrench size={14} />
          查看过程 · {props.tools.length} 步{failed ? ` · ${failed} 步未完成` : ""}
        </span>
        <ChevronDown size={14} className={cn("transition-transform duration-300", open && "rotate-180")} />
      </button>
      <div className={cn("grid transition-all duration-300 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="overflow-hidden">
          <div className="space-y-1 px-3 py-2">
            {props.tools.map((tool) => (
              <div key={tool.id} className="flex items-start justify-between gap-3 rounded-md bg-white px-3 py-2 text-[12px] max-sm:flex-col max-sm:gap-1.5">
                <span className="font-medium text-slate-700">{tool.label}</span>
                <span className={cn("min-w-0 break-words text-right text-slate-400 [overflow-wrap:anywhere] max-sm:text-left", tool.status === "failed" && "text-rose-600")}>{tool.summary ?? tool.path ?? tool.command ?? tool.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyPureChat() {
  return (
    <div className="grid min-h-[46vh] place-items-center text-center">
      <div className="max-w-lg px-8 py-10">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-indigo-500">Hermes 工作台</p>
        <h3 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">开始一轮新的 Hermes 工作任务</h3>
        <p className="mt-3 text-[14px] leading-7 text-slate-500">每条任务都会交给 Hermes；主工作台优先显示最终回复，过程细节折叠在下方，需要时再展开查看。</p>
        <div className="mt-5 grid gap-2 text-left text-[13px] text-slate-500">
          <div className="rounded-xl bg-slate-50/70 px-3 py-2 hover:bg-slate-100/70">试试：分析这个项目结构，并告诉我入口文件和关键模块。</div>
          <div className="rounded-xl bg-slate-50/70 px-3 py-2 hover:bg-slate-100/70">试试：帮我修复当前报错，并说明你准备怎么处理。</div>
          <div className="rounded-xl bg-slate-50/70 px-3 py-2 hover:bg-slate-100/70">试试：整理这个目录，并给我一个更清晰的文件分组方案。</div>
        </div>
      </div>
    </div>
  );
}

function FailureInline(props: { status: TaskRunProjection["status"]; content: string }) {
  const label = props.status === "interrupted" ? "上次回复中断了" : props.status === "cancelled" ? "这次回复已取消" : "这次回复没有顺利完成";
  const failure = failureGuidance(props.status, props.content);
  return (
    <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
      <div className="inline-flex items-center gap-2 font-medium">
        <AlertCircle size={13} />
        {label}
      </div>
      <p className="mt-1 leading-5 text-rose-600">{failure.hint}</p>
      {failure.action ? <p className="mt-1 text-[11px] text-rose-500">建议动作：{failure.action}</p> : null}
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
      action: "先检查 Hermes 运行模式和 Python 环境，必要时切到 WSL 模式后重试",
    };
  }
  if (/锁释放后重试|工作区正在被占用|WORKSPACE_LOCKED/i.test(text)) {
    return { hint: "当前更像是工作区锁冲突，并不是 Hermes 本身不可用。", action: "等待当前任务结束后重试" };
  }
  if (/模型|密钥|configure_model|配置或环境问题|API Key/i.test(text)) {
    return { hint: "当前更像是模型配置或密钥问题。", action: "先检查设置页中的模型与密钥" };
  }
  if (/CLI|退出码|Hermes CLI 执行失败/i.test(text)) {
    return { hint: "Hermes CLI 本轮执行没有顺利完成。", action: "检查 Hermes CLI、模型配置与工作区上下文后重试" };
  }
  if (/超时|等待时间偏长|缩小任务范围|未完成/i.test(text)) {
    return { hint: "本轮更像是等待过久或任务范围偏大。", action: "缩小任务范围或减少上下文后重试" };
  }
  return { hint: "建议先查看过程详情，确认失败阶段后再决定是否重试。", action: "查看过程详情或导出诊断" };
}

function TypingState(props: { phase: "handoff" | "replying" }) {
  const title = props.phase === "handoff" ? "Hermes 已接手" : "Hermes 正在回复中";
  const subtitle = props.phase === "handoff"
    ? "Hermes 正在准备 MEMORY.md、工作区上下文和执行链路。通常很快就会开始输出。"
    : "Hermes 正在整理最终回复；如果等待时间偏长，可以查看过程详情或停止本轮任务。";
  return (
    <div data-testid="typing-state" className="rounded-2xl bg-slate-50/70 px-4 py-3">
      <div className="flex items-center gap-2.5 text-[13px] font-medium text-slate-600">
        <span className="relative inline-flex h-5 w-5 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-slate-200/70 animate-ping [animation-duration:1.8s]" />
          <span className="relative inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)] ring-1 ring-slate-100/70">
            <Loader2 size={12} className="animate-spin text-slate-400" />
          </span>
        </span>
        <span>{title}</span>
        <span className="inline-flex items-center gap-1 pl-0.5 text-slate-300">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:0ms] [animation-duration:1s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:120ms] [animation-duration:1s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300 animate-bounce [animation-delay:240ms] [animation-duration:1s]" />
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-6 text-slate-500">{subtitle}</p>
    </div>
  );
}

function SoftStreamingHint() {
  return (
    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-slate-50 px-2.5 py-1 text-[12px] font-medium text-slate-500">
      <span className="inline-flex items-center gap-1">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-300" />
        <span>Hermes 还在继续补充</span>
      </span>
    </div>
  );
}
