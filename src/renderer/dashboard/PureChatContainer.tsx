import { AlertCircle, ChevronDown, Copy, Ellipsis, Loader2, RefreshCcw, Sparkles, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { EngineEvent, TaskRunProjection, ToolEvent } from "../../shared/types";
import { StreamingMarkdown } from "../markdown/StreamingMarkdown";
import { useAppStore } from "../store";
import { ChatInput } from "./ChatInput";
import { cn, formatShortDate } from "./DashboardPrimitives";

type FixTarget = "model" | "hermes" | "health" | "diagnostics" | "workspace";

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
  canStart: boolean;
  sendBlockReason?: string;
  sendBlockTarget?: FixTarget;
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
  const lastRun = visibleRuns[visibleRuns.length - 1];
  const latestRunSignature = lastRun
    ? `${lastRun.taskRunId}:${lastRun.status}:${lastRun.assistantMessage.content.length}:${lastRun.toolEvents.length}`
    : "";

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
    <div className="hermes-chat-shell relative flex h-full min-h-0 flex-col bg-white">
      <div
        className="hermes-chat-scroll custom-scrollbar min-h-0 flex-1 overflow-y-auto bg-[#f6f7f9] px-4 py-5 sm:px-6"
        onScroll={(event) => {
          const el = event.currentTarget;
          setFollowBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 160);
        }}
      >
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 2xl:max-w-[1240px]">
          {visibleRuns.length === 0 ? (
            <EmptyPureChat
              hasWorkspace={Boolean(store.workspacePath)}
              onUsePromptSuggestion={props.onUsePromptSuggestion}
              onPickWorkspace={props.onPickWorkspace}
            />
          ) : visibleRuns.map((run) => <PureRun key={run.taskRunId} run={run} onOpenFix={props.onOpenFix} />)}
          <PendingNativeCards />
          <div ref={bottomRef} />
        </div>
      </div>

      {!followBottom ? (
        <button
          className="absolute bottom-32 left-1/2 z-10 -translate-x-1/2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-600 shadow-[0_8px_30px_rgb(0,0,0,0.04)]"
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })}
          type="button"
        >
          回到底部
        </button>
      ) : null}

      <div className="hermes-composer-shell shrink-0 border-t border-slate-200/70 bg-white/90">
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
  const store = useAppStore();
  const approvals = store.pendingApprovalCards.filter((card) => card.status === "pending");
  const clarifies = store.pendingClarifyCards.filter((card) => card.status === "pending");
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
            <button className="rounded-full bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-white" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "once", editedCommand: card.command }).then(() => store.resolveApprovalCard(card.id, "approved"))} type="button">本次允许</button>
            <button className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "session", editedCommand: card.command }).then(() => store.resolveApprovalCard(card.id, "approved"))} type="button">本会话允许</button>
            <button className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "always", editedCommand: card.command }).then(() => store.resolveApprovalCard(card.id, "approved"))} type="button">始终允许</button>
            <button className="rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600" onClick={() => void window.workbenchClient.respondApproval({ id: card.id, choice: "deny" }).then(() => store.resolveApprovalCard(card.id, "denied"))} type="button">拒绝</button>
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
    <section className="flex flex-col gap-2">
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

function ChatMessageCard(props: { role: "user" | "assistant"; createdAt: string; content: ReactNode; chrome?: ReactNode; metaSuffix?: string }) {
  const isUser = props.role === "user";
  return (
    <article
      className={cn(
        "hermes-message-card group relative w-full rounded-[24px] px-5 py-4 shadow-[0_16px_38px_rgba(15,23,42,0.05)] outline-none transition",
        isUser
          ? "hermes-message-card--user ml-auto max-w-[min(64%,560px)] border border-blue-100 bg-[#eef5ff] text-slate-800 max-sm:max-w-[92%]"
          : "hermes-message-card--assistant max-w-3xl border border-[var(--hermes-card-border)] bg-white text-slate-800",
      )}
      tabIndex={0}
    >
      <div className="mb-3 flex items-center justify-between gap-3 text-[11px] text-slate-400">
        <div className="inline-flex items-center gap-2">
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
        <span>{props.metaSuffix ? `${props.metaSuffix} · ${formatShortDate(props.createdAt)}` : formatShortDate(props.createdAt)}</span>
      </div>

      {props.chrome}

      <div>{props.content}</div>
    </article>
  );
}

function AssistantMessageCard(props: { run: TaskRunProjection; onOpenFix?: (target: FixTarget) => void }) {
  const { run } = props;
  const store = useAppStore();
  const content = run.assistantMessage.content.trim();
  const usage = useMemo(() => {
    const eventsForRun = store.taskEventsByRunId[run.taskRunId] || [];
    for (let i = eventsForRun.length - 1; i >= 0; i--) {
      if (eventsForRun[i].event.type === "usage") return eventsForRun[i].event as Extract<EngineEvent, { type: "usage" }>;
    }
    return undefined;
  }, [store.taskEventsByRunId, run.taskRunId]);
  const waiting = !content && (run.status === "pending" || run.status === "routing" || run.status === "running" || run.status === "streaming");
  const softStreaming = Boolean(content) && run.status === "streaming";
  const completed = run.status === "complete";
  const statusLabel = completed ? "已完成" : softStreaming ? "补充中" : waiting ? "处理中" : run.status === "cancelled" ? "已取消" : run.status === "interrupted" ? "已中断" : run.status === "failed" ? "未完成" : "回复中";

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(run.assistantMessage.content);
      store.success("已复制回复", "当前消息内容已写入剪贴板");
    } catch (error) {
      store.error("复制失败", error instanceof Error ? error.message : "无法写入剪贴板");
    }
  }

  function continueMessage() {
    store.setUserInput("继续，保持当前上下文往下完成。");
    store.info("已填入继续指令", "可以直接发送，让 Hermes 在当前上下文继续处理");
  }

  return (
    <ChatMessageCard
      role="assistant"
      createdAt={run.assistantMessage.createdAt}
      metaSuffix={statusLabel}
      chrome={(
        <>
          <div className="mb-3 flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {run.modelId ? <MessageMetaPill>{run.modelId}</MessageMetaPill> : null}
              {store.webUiOverview?.settings.showUsage && usage?.type === "usage" ? <MessageMetaPill tone="emerald">{usage.inputTokens}+{usage.outputTokens} token</MessageMetaPill> : null}
            </div>
          </div>

          <div className="pointer-events-none absolute right-4 top-4 flex items-center gap-1 rounded-full border border-[var(--hermes-primary-border)] bg-white/95 px-1.5 py-1 opacity-0 shadow-[0_8px_24px_rgba(91,77,255,0.12)] transition group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
            <MessageActionButton icon={Copy} label="复制内容" onClick={() => void copyMessage()} />
            <MessageActionButton icon={RefreshCcw} label="继续生成" onClick={continueMessage} />
            <AssistantMoreMenu run={run} onCopy={() => void copyMessage()} onContinue={continueMessage} />
          </div>
        </>
      )}
      content={(
        <>
          {run.status === "failed" || run.status === "cancelled" || run.status === "interrupted" ? <FailureInline status={run.status} content={run.assistantMessage.content} onOpenFix={props.onOpenFix} /> : null}

          {waiting ? (
            <TypingState phase={run.status === "routing" ? "handoff" : "replying"} />
          ) : (
            <div className="hermes-assistant-bubble relative rounded-[22px] border border-[var(--hermes-primary-border)] bg-[var(--hermes-primary-soft)] p-4 before:absolute before:left-0 before:top-5 before:h-10 before:w-1 before:rounded-r-full before:bg-[var(--hermes-primary)]">
              <StreamingMarkdown content={run.assistantMessage.content} isStreaming={run.status === "streaming"} className="prose prose-slate max-w-none break-words text-[14px] leading-relaxed text-slate-800 [overflow-wrap:anywhere] prose-p:my-3 prose-ul:my-3 prose-ol:my-3 prose-li:my-1.5 prose-li:leading-relaxed" />
              {softStreaming ? <SoftStreamingHint /> : null}
            </div>
          )}

          {run.toolEvents.length > 0 ? <ToolSummary tools={run.toolEvents} /> : null}
        </>
      )}
    />
  );
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
  const store = useAppStore();
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
    store.setUserInput(text);
    store.info("已填入后续动作", toast);
    setOpen(false);
  }

  function exportMessage() {
    const blob = new Blob([props.run.assistantMessage.content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `hermes-${props.run.taskRunId}.md`;
    link.click();
    URL.revokeObjectURL(url);
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
          <MenuAction label="导出结果" onClick={exportMessage} />
        </div>
      ) : null}
    </div>
  );
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

function EmptyPureChat(props: { hasWorkspace: boolean; onPickWorkspace: () => void; onUsePromptSuggestion?: (prompt: string) => void }) {
  const suggestions = props.hasWorkspace
    ? [
        "分析这个项目结构，并告诉我入口文件和关键模块。",
        "帮我修复当前报错，并说明你准备怎么处理。",
        "整理这个目录，并给我一个更清晰的文件分组方案。",
      ]
    : [
        "先选择一个工作区，然后分析这个项目结构。",
        "先选择一个工作区，然后检查配置和启动状态。",
        "先选择一个工作区，然后帮我跑一次基础诊断。",
      ];
  return (
    <div className="grid min-h-[46vh] place-items-center text-center">
      <div className="max-w-xl px-8 py-10">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">Hermes Workspace</p>
        <h3 className="mt-4 text-[30px] font-semibold tracking-tight text-slate-900">默认保持安静，需要时再展开细节。</h3>
        <p className="mt-4 text-[15px] leading-7 text-slate-500">
          {props.hasWorkspace
            ? "把任务交给 Hermes，主区优先看最终回复；工具过程、诊断和附加动作会按需出现。"
            : "先选择一个工作区，再开始一轮任务。你也可以先点下面的建议，让输入框直接填好。"}
        </p>
        <div className="mt-6 grid gap-2 text-left text-[13px] text-slate-500">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              className="rounded-2xl border border-slate-200/80 bg-white px-4 py-3 text-left transition hover:border-slate-300 hover:bg-slate-50"
              onClick={() => props.onUsePromptSuggestion?.(suggestion)}
              type="button"
            >
              试试：{suggestion}
            </button>
          ))}
        </div>
        {!props.hasWorkspace ? (
          <button className="mt-5 rounded-full bg-slate-900 px-4 py-2 text-[13px] font-semibold text-white hover:bg-slate-800" onClick={props.onPickWorkspace} type="button">
            选择工作区
          </button>
        ) : null}
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
      action: "先检查 Hermes 运行模式和 Python 环境，必要时切到 WSL 模式后重试",
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

function TypingState(props: { phase: "handoff" | "replying" }) {
  const title = props.phase === "handoff" ? "Hermes 已接手" : "Hermes 正在回复中";
  const subtitle = props.phase === "handoff"
    ? "Hermes 正在准备 MEMORY.md、工作区上下文和执行链路。通常很快就会开始输出。"
    : "Hermes 正在整理最终回复；如果等待时间偏长，可以展开工具过程或停止本轮任务。";
  return (
    <div data-testid="typing-state" className="hermes-typing-card rounded-[22px] bg-[#f7f8fa] px-4 py-4">
      <div className="flex items-center gap-2.5 text-[13px] font-medium text-slate-600">
        <span className="relative inline-flex h-5 w-5 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-slate-200/70 [animation-duration:1.8s]" />
          <span className="relative inline-flex h-5 w-5 items-center justify-center rounded-full bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
            <Loader2 size={12} className="animate-spin text-slate-400" />
          </span>
        </span>
        <span>{title}</span>
      </div>
      <p className="mt-2 text-[13px] leading-6 text-slate-500">{subtitle}</p>
    </div>
  );
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
