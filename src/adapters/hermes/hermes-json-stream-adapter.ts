import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { engineInteractionRequestSchema, engineInteractionResponseSchema } from "../../shared/schemas";
import { redactSensitiveText } from "../../shared/redaction";
import type { EngineEvent, EngineInteractionRequest, EngineInteractionResponse, EngineRunRequest } from "../../shared/types";

const EVENT_START = "__FORGE_EVENT__";
const EVENT_END = "__FORGE_EVENT_END__";

export type ParsedJsonEvent =
  | { type: "lifecycle"; stage: string; session_id?: string; timestamp: string }
  | { type: "tool_call"; tool: string; input?: Record<string, unknown>; session_id?: string; timestamp: string }
  | { type: "tool_result"; tool: string; output?: string; success?: boolean; session_id?: string; timestamp: string }
  | { type: "message_chunk"; content: string; session_id?: string; timestamp: string }
  | { type: "reasoning"; content: string; session_id?: string; timestamp: string }
  | { type: "clarify"; question: string; choices?: string[]; session_id?: string; timestamp: string }
  | { type: "status"; level?: string; message: string; session_id?: string; timestamp: string }
  | { type: "progress"; step: string; done?: boolean; message: string; session_id?: string; timestamp: string }
  | { type: "usage"; source?: string; input_tokens?: number; output_tokens?: number; total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number; context_tokens?: number; context_window?: number; context_percent?: number; estimated_cost_usd?: number; cost_source?: string; session_id?: string; timestamp: string }
  | { type: "session_update"; session_id: string; previous_session_id?: string; title?: string; message_count?: number; model?: string; timestamp: string }
  | { type: "result"; success: boolean; content: string; session_id?: string; timestamp: string }
  | { type: "error"; message: string; error_type?: string; traceback?: string; session_id?: string; timestamp: string }
  | Record<string, unknown>;

function parseEventLine(line: string): ParsedJsonEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(EVENT_START) || !trimmed.endsWith(EVENT_END)) {
    return undefined;
  }
  const jsonText = trimmed.slice(EVENT_START.length, -EVENT_END.length);
  try {
    return JSON.parse(jsonText) as ParsedJsonEvent;
  } catch {
    return undefined;
  }
}

function toEngineEvent(parsed: ParsedJsonEvent): EngineEvent | undefined {
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    return undefined;
  }
  const now = () => new Date().toISOString();
  const record = parsed as Record<string, unknown>;
  const type = record.type;

  switch (type) {
    case "lifecycle": {
      const rawStage = String((parsed as Record<string, unknown>).stage ?? "running");
      const stage = rawStage === "started" ? "running" : rawStage;
      if (!["queued", "preflight", "snapshot", "running", "streaming"].includes(stage)) return undefined;
      return {
        type: "lifecycle",
        stage: stage as "running",
        message: `Hermes ${stage}`,
        at: now(),
      };
    }
    case "tool_call": {
      const tool = String((parsed as Record<string, unknown>).tool ?? "unknown");
      const input = (parsed as Record<string, unknown>).input;
      return {
        type: "tool_call",
        toolName: tool,
        argsPreview: JSON.stringify(input ?? {}),
        callId: typeof (parsed as Record<string, unknown>).call_id === "string" ? String((parsed as Record<string, unknown>).call_id) : undefined,
        status: "running",
        at: now(),
      };
    }
    case "tool_result": {
      const tool = String((parsed as Record<string, unknown>).tool ?? "unknown");
      const output = String((parsed as Record<string, unknown>).output ?? "");
      const success = Boolean((parsed as Record<string, unknown>).success ?? true);
      return {
        type: "tool_result",
        toolName: tool,
        outputPreview: output.slice(0, 400),
        callId: typeof (parsed as Record<string, unknown>).call_id === "string" ? String((parsed as Record<string, unknown>).call_id) : undefined,
        success,
        status: "complete",
        at: now(),
      };
    }
    case "message_chunk": {
      const content = String((parsed as Record<string, unknown>).content ?? "");
      return {
        type: "message_chunk",
        content,
        at: now(),
      };
    }
    case "reasoning": {
      return {
        type: "reasoning",
        content: String((parsed as Record<string, unknown>).content ?? ""),
        at: now(),
      };
    }
    case "clarify": {
      const choices = (parsed as Record<string, unknown>).choices;
      return {
        type: "clarify",
        question: String((parsed as Record<string, unknown>).question ?? ""),
        choices: Array.isArray(choices) ? choices.filter((c): c is string => typeof c === "string") : undefined,
        at: now(),
      };
    }
    case "status": {
      const rawLevel = String((parsed as Record<string, unknown>).level ?? "info").toLowerCase();
      const level = rawLevel === "success" || rawLevel === "warning" || rawLevel === "error" ? rawLevel : "info";
      return {
        type: "status",
        level,
        message: String((parsed as Record<string, unknown>).message ?? ""),
        at: now(),
      };
    }
    case "progress": {
      return {
        type: "progress",
        step: String((parsed as Record<string, unknown>).step ?? "agent-step"),
        done: Boolean((parsed as Record<string, unknown>).done ?? false),
        message: String((parsed as Record<string, unknown>).message ?? ""),
        at: now(),
      };
    }
    case "diagnostic": {
      return {
        type: "diagnostic",
        category: String(record.category ?? "hermes-native"),
        message: String(record.message ?? ""),
        at: now(),
      };
    }
    case "usage": {
      const inputTokens = numberFrom(parsed, "input_tokens") ?? numberFrom(parsed, "inputTokens") ?? numberFrom(parsed, "prompt_tokens") ?? 0;
      const outputTokens = numberFrom(parsed, "output_tokens") ?? numberFrom(parsed, "outputTokens") ?? numberFrom(parsed, "completion_tokens") ?? 0;
      const totalTokens = numberFrom(parsed, "total_tokens") ?? numberFrom(parsed, "totalTokens") ?? inputTokens + outputTokens;
      const source = String((parsed as Record<string, unknown>).source ?? "").toLowerCase() === "actual" ? "actual" : "estimated";
      return {
        type: "usage",
        inputTokens,
        outputTokens,
        totalTokens,
        promptTokens: numberFrom(parsed, "prompt_tokens") ?? numberFrom(parsed, "promptTokens") ?? numberFrom(parsed, "promptTokenCount"),
        completionTokens: numberFrom(parsed, "completion_tokens") ?? numberFrom(parsed, "completionTokens") ?? numberFrom(parsed, "completionTokenCount"),
        cacheReadTokens: numberFrom(parsed, "cache_read_tokens") ?? numberFrom(parsed, "cacheReadTokens"),
        cacheWriteTokens: numberFrom(parsed, "cache_write_tokens") ?? numberFrom(parsed, "cacheWriteTokens"),
        reasoningTokens: numberFrom(parsed, "reasoning_tokens") ?? numberFrom(parsed, "reasoningTokens"),
        contextTokens: numberFrom(parsed, "context_tokens") ?? numberFrom(parsed, "contextTokens") ?? numberFrom(parsed, "last_prompt_tokens"),
        contextWindow: numberFrom(parsed, "context_window") ?? numberFrom(parsed, "contextWindow") ?? numberFrom(parsed, "context_length"),
        contextPercent: numberFrom(parsed, "context_percent") ?? numberFrom(parsed, "contextPercent"),
        costSource: typeof (parsed as Record<string, unknown>).cost_source === "string"
          ? String((parsed as Record<string, unknown>).cost_source)
          : typeof (parsed as Record<string, unknown>).costSource === "string"
            ? String((parsed as Record<string, unknown>).costSource)
            : undefined,
        estimatedCostUsd: numberFrom(parsed, "estimated_cost_usd") ?? numberFrom(parsed, "estimatedCostUsd") ?? 0,
        source,
        message: source === "actual"
          ? `实测 Token：输入 ${inputTokens}，输出 ${outputTokens}。`
          : `估算 Token：输入 ${inputTokens}，输出 ${outputTokens}。`,
        at: now(),
      };
    }
    case "session_update": {
      return {
        type: "session_update",
        hermesSessionId: String((parsed as Record<string, unknown>).session_id ?? ""),
        previousHermesSessionId: typeof (parsed as Record<string, unknown>).previous_session_id === "string"
          ? String((parsed as Record<string, unknown>).previous_session_id)
          : undefined,
        title: typeof (parsed as Record<string, unknown>).title === "string" ? String((parsed as Record<string, unknown>).title) : undefined,
        messageCount: typeof (parsed as Record<string, unknown>).message_count === "number" ? Number((parsed as Record<string, unknown>).message_count) : undefined,
        model: typeof (parsed as Record<string, unknown>).model === "string" ? String((parsed as Record<string, unknown>).model) : undefined,
        at: now(),
      };
    }
    case "result": {
      const cancelled = record.interrupted === true || record.outcome === "cancelled";
      const success = record.success === true && record.failed !== true && !cancelled;
      const content = String((parsed as Record<string, unknown>).content ?? "");
      return {
        type: "result",
        success,
        outcome: cancelled ? "cancelled" : success ? "completed" : "failed",
        title: cancelled ? "任务已取消" : success ? "Hermes 回复" : "Hermes 执行失败",
        detail: content || "Hermes 已运行，但没有返回可显示的内容。",
        at: now(),
      };
    }
    case "error": {
      const message = String((parsed as Record<string, unknown>).message ?? "未知错误");
      const errorType = String((parsed as Record<string, unknown>).error_type ?? "Error");
      return {
        type: "result",
        success: false,
        outcome: "failed",
        title: `${errorType} 错误`,
        detail: message,
        at: now(),
      };
    }
    default:
      return undefined;
  }
}

function numberFrom(source: unknown, key: string) {
  const value = (source as Record<string, unknown>)?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export type HermesJsonStreamOptions = {
  taskRunId?: string;
  onInteraction?: EngineRunRequest["onInteraction"];
  /** Maximum wall time for one task, including user interaction. */
  timeoutMs?: number;
  /** Grace period after cooperative cancellation; production never exceeds 4s. */
  stopGraceMs?: number;
};

export async function terminateHermesProcessTree(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => { proc.kill(); killer.kill(); resolve(); }, 900);
      const done = () => { clearTimeout(timer); if (proc.exitCode === null) proc.kill(); resolve(); };
      killer.once("error", done);
      killer.once("close", done);
    });
  } else {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
  }
}

function refusedInteraction(request: EngineInteractionRequest, timedOut = false): EngineInteractionResponse {
  const identity = { requestId: request.requestId, taskRunId: request.taskRunId };
  return request.kind === "approval"
    ? { ...identity, kind: "approval", choice: timedOut ? "timeout" : "deny" }
    : { ...identity, kind: "clarify", timedOut: true };
}

export async function* readHermesJsonStream(
  proc: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
  options: HermesJsonStreamOptions = {},
): AsyncIterable<EngineEvent> {
  const rl = createInterface(proc.stdout);
  const queue: EngineEvent[] = [];
  const pending = new Map<string, AbortController>();
  const seenRequests = new Set<string>();
  let wake: (() => void) | undefined;
  let closed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let stderr = "";
  let terminal: Extract<EngineEvent, { type: "result" }> | undefined;
  let stopped: { outcome: "failed" | "cancelled"; message: string } | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  let terminalTimer: NodeJS.Timeout | undefined;
  let killPromise: Promise<void> | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const push = (event: EngineEvent) => {
    if (queue.length >= 8192) { stop("failed", "Hermes 输出超过缓冲上限，任务已中断。"); return; }
    queue.push(event);
    notify();
  };
  const finish = (code: number | null, childSignal: NodeJS.Signals | null) => {
    exitCode = code;
    exitSignal = childSignal;
    closed = true;
    for (const controller of pending.values()) controller.abort();
    notify();
  };
  const writeControl = (message: Record<string, unknown>) => {
    if (closed || proc.stdin.destroyed || !proc.stdin.writable) return false;
    try { proc.stdin.write(`${JSON.stringify(message)}\n`, () => undefined); return true; } catch { return false; }
  };
  const kill = () => { killPromise ??= terminateHermesProcessTree(proc); return killPromise; };
  function stop(outcome: "failed" | "cancelled", message: string) {
    if (closed || stopped) return;
    stopped = { outcome, message };
    for (const controller of pending.values()) controller.abort();
    writeControl({ type: "cancel", taskRunId: options.taskRunId });
    const grace = Math.max(0, Math.min(options.stopGraceMs ?? 4000, 4000));
    killTimer = setTimeout(() => { void kill(); }, grace);
    // A descendant holding stdout open must not keep the task/workspace locked forever.
    stopTimer = setTimeout(() => {
      void kill();
      rl.close();
      proc.stdout.destroy();
      proc.stderr.destroy();
      finish(proc.exitCode, proc.signalCode);
    }, grace + 950);
  }
  const handleInteraction = async (request: EngineInteractionRequest) => {
    if (closed || stopped || signal.aborted) return;
    if (request.taskRunId !== options.taskRunId || seenRequests.has(request.requestId)) {
      stop("failed", "Hermes 交互请求的任务标识无效或重复，已中断任务。");
      return;
    }
    if (pending.size >= 32 || seenRequests.size >= 1000) {
      stop("failed", "Hermes 交互请求过多，已中断任务。");
      return;
    }
    seenRequests.add(request.requestId);
    const controller = new AbortController();
    pending.set(request.requestId, controller);
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let abortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<EngineInteractionResponse>((resolve) => {
        abortListener = () => resolve(refusedInteraction(request, true));
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      const response = await Promise.race([
        Promise.resolve().then(() => options.onInteraction?.(request, controller.signal) ?? refusedInteraction(request)),
        aborted,
      ]).catch(() => refusedInteraction(request));
      const parsed = engineInteractionResponseSchema.safeParse(response);
      let reply = parsed.success && parsed.data.requestId === request.requestId && parsed.data.taskRunId === request.taskRunId && parsed.data.kind === request.kind
        ? parsed.data : refusedInteraction(request);
      if (request.kind === "approval" && reply.kind === "approval") {
        if ((reply.choice === "always" && (!request.allowPermanent || request.smartDenied)) || (reply.choice === "session" && (!request.allowSession || request.smartDenied))) {
          reply = refusedInteraction(request);
        }
      }
      if (!closed && !stopped && !signal.aborted) writeControl({ type: "interaction_response", ...reply });
    } finally {
      clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      controller.abort();
      pending.delete(request.requestId);
    }
  };
  const onLine = (line: string) => {
    if (closed || stopped) return;
    if (line.length > 1024 * 1024) { stop("failed", "Hermes 单条输出过大，已中断任务。"); return; }
    const parsed = parseEventLine(line);
    if (parsed?.type === "interaction_request") {
      const request = engineInteractionRequestSchema.safeParse(parsed);
      if (!request.success) { stop("failed", "Hermes 返回了无效的交互请求。"); return; }
      void handleInteraction(request.data);
      return;
    }
    if (parsed) {
      const event = toEngineEvent(parsed);
      if (event?.type === "result") {
        // A success frame is provisional until close confirms a successful process exit.
        if (!terminal || terminal.success) terminal = event;
        terminalTimer ??= setTimeout(() => stop("failed", "Hermes 返回结果后未完成资源清理，已中断进程。"), 5000);
      } else if (event) push(event);
    } else if (line.trim()) {
      if (line.trim().startsWith(EVENT_START)) { stop("failed", "Hermes 返回了损坏的事件数据。"); return; }
      push({ type: "stdout", line: line.trim(), at: new Date().toISOString() });
    }
  };
  const onStderr = (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-24000); };
  const onSpawnError = (error: Error) => { stopped ??= { outcome: "failed", message: `Hermes 进程启动失败：${error.message}` }; finish(null, null); };
  const onStdinError = () => { if (pending.size && !closed && !stopped) stop("failed", "Hermes 交互连接已断开。"); };
  const onAbort = () => stop("cancelled", "任务已取消。");
  const timeout = setTimeout(() => stop("failed", "Hermes 任务超过运行时限，已中断。"), Math.max(1, options.timeoutMs ?? 30 * 60 * 1000));
  proc.once("error", onSpawnError);
  proc.once("close", finish);
  proc.stderr.on("data", onStderr);
  proc.stdin.on("error", onStdinError);
  rl.on("line", onLine);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    while (!closed || queue.length) {
      const event = queue.shift();
      if (event) { yield event; continue; }
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    const at = new Date().toISOString();
    if (signal.aborted || stopped?.outcome === "cancelled" || terminal?.outcome === "cancelled") {
      yield { type: "result", success: false, outcome: "cancelled", title: "任务已取消", detail: "任务已取消。", at };
    } else if (stopped || exitCode !== 0 || exitSignal || !terminal) {
      const detail = stopped?.message ?? (terminal && !terminal.success ? terminal.detail : undefined)
        ?? (exitCode !== 0 || exitSignal ? `Hermes 进程异常退出（${exitSignal ?? exitCode ?? "unknown"}）。` : "Hermes 未返回完整执行结果。");
      const diagnostic = redactSensitiveText(stderr.trim().slice(-6000));
      yield { type: "result", success: false, outcome: "failed", title: "Hermes 执行失败", detail: diagnostic ? `${detail}\n${diagnostic}` : detail, at };
    } else {
      yield terminal;
    }
  } finally {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    if (stopTimer) clearTimeout(stopTimer);
    if (terminalTimer) clearTimeout(terminalTimer);
    signal.removeEventListener("abort", onAbort);
    for (const controller of pending.values()) controller.abort();
    rl.off("line", onLine);
    rl.close();
    proc.stderr.off("data", onStderr);
    if (!closed) await kill();
    // Keep the stdin error handler until the pipe closes: a late EPIPE must not crash Electron.
    if (!proc.stdin.destroyed) proc.stdin.end();
  }
}
