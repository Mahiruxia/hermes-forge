import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { EngineEvent } from "../../shared/types";

const EVENT_START = "__FORGE_EVENT__";
const EVENT_END = "__FORGE_EVENT_END__";

export type ParsedJsonEvent =
  | { type: "lifecycle"; stage: string; session_id?: string; timestamp: string }
  | { type: "tool_call"; tool: string; input?: Record<string, unknown>; session_id?: string; timestamp: string }
  | { type: "tool_result"; tool: string; output?: string; success?: boolean; session_id?: string; timestamp: string }
  | { type: "message_chunk"; content: string; session_id?: string; timestamp: string }
  | { type: "reasoning"; content: string; session_id?: string; timestamp: string }
  | { type: "status"; level?: string; message: string; session_id?: string; timestamp: string }
  | { type: "progress"; step: string; done?: boolean; message: string; session_id?: string; timestamp: string }
  | { type: "usage"; source?: string; input_tokens?: number; output_tokens?: number; total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number; estimated_cost_usd?: number; session_id?: string; timestamp: string }
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
  const type = (parsed as Record<string, unknown>).type;

  switch (type) {
    case "lifecycle": {
      const stage = String((parsed as Record<string, unknown>).stage ?? "unknown");
      return {
        type: "lifecycle",
        stage: stage as EngineEvent & { type: "lifecycle" } extends { stage: infer S } ? S : "running",
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
        promptTokens: numberFrom(parsed, "prompt_tokens"),
        completionTokens: numberFrom(parsed, "completion_tokens"),
        cacheReadTokens: numberFrom(parsed, "cache_read_tokens"),
        cacheWriteTokens: numberFrom(parsed, "cache_write_tokens"),
        reasoningTokens: numberFrom(parsed, "reasoning_tokens"),
        estimatedCostUsd: numberFrom(parsed, "estimated_cost_usd") ?? 0,
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
      const success = Boolean((parsed as Record<string, unknown>).success ?? true);
      const content = String((parsed as Record<string, unknown>).content ?? "");
      return {
        type: "result",
        success,
        title: success ? "Hermes 回复" : "Hermes 执行失败",
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

export async function* readHermesJsonStream(
  proc: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
): AsyncIterable<EngineEvent> {
  const rl = createInterface(proc.stdout);

  const stderrBuffer: string[] = [];
  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) stderrBuffer.push(line.trim());
    }
  });

  try {
    for await (const line of rl) {
      if (signal.aborted) {
        proc.kill();
        rl.close();
        return;
      }

      const parsed = parseEventLine(line);
      if (parsed) {
        const event = toEngineEvent(parsed);
        if (event) yield event;
        continue;
      }

      // 非事件行作为 stdout 透传（兼容 Hermes 的普通日志输出）
      if (line.trim()) {
        yield { type: "stdout", line: line.trim(), at: new Date().toISOString() };
      }
    }
  } finally {
    rl.close();

    // 如果 stderr 有内容且进程退出码非 0，发出诊断
    const exitCode = proc.exitCode;
    if (exitCode !== 0 && exitCode !== null) {
      const stderrText = stderrBuffer.slice(-20).join("\n");
      if (stderrText) {
        yield {
          type: "diagnostic",
          category: "hermes-windows-agent-stderr",
          message: stderrText,
          at: new Date().toISOString(),
        };
      }
    }
  }
}
