import type { EngineAdapter, HermesToolLoopMessage } from "../adapters/engine-adapter";
import type { EngineEvent, EngineRunRequest, HermesToolLoopModelOutput, WindowsToolCall } from "../shared/types";
import type { WindowsToolExecutor } from "../main/windows-tool-executor";

const now = () => new Date().toISOString();
const MAX_STEPS = 12;
const MAX_FORMAT_REPAIRS = 2;

export class HermesToolLoopRunner {
  constructor(
    private readonly hermesAdapter: EngineAdapter,
    private readonly windowsToolExecutor: WindowsToolExecutor,
  ) {}

  canRun() {
    return typeof this.hermesAdapter.planToolStep === "function";
  }

  async *run(
    request: EngineRunRequest,
    signal: AbortSignal,
    publishEvent?: (event: EngineEvent) => Promise<void>,
  ): AsyncIterable<EngineEvent> {
    if (!this.hermesAdapter.planToolStep) {
      throw new Error("Hermes adapter does not support tool loop planning.");
    }
    const transcript: HermesToolLoopMessage[] = [{ role: "user", content: request.userInput }];
    let repairCount = 0;

    yield { type: "status", level: "info", message: "Hermes Tool Loop 已启动，正在要求 Hermes 输出结构化 Windows 工具调用。", at: now() };

    for (let step = 1; step <= MAX_STEPS; step += 1) {
      if (signal.aborted) {
        throw new Error("Hermes Tool Loop 已取消。");
      }
      yield { type: "progress", step: `tool-loop-${step}`, done: false, message: `正在规划第 ${step} 步 Windows 操作。`, at: now() };
      const raw = await this.hermesAdapter.planToolStep(request, transcript, signal);
      const parsed = parseHermesToolOutput(raw);

      if (!parsed.ok) {
        repairCount += 1;
        transcript.push({
          role: "observation",
          content: {
            ok: false,
            tool: "windows.powershell.run",
            message: `上一轮输出不是合法 JSON。请只返回 {"type":"tool_call",...} 或 {"type":"final",...}。错误：${parsed.message}`,
            durationMs: 0,
          },
        });
        if (repairCount >= MAX_FORMAT_REPAIRS) {
          yield {
            type: "result",
            success: false,
            title: "Hermes Tool Loop 格式错误",
            detail: `Hermes 连续输出非 JSON 工具协议，已停止。\n最后输出：${raw.slice(0, 1000)}`,
            at: now(),
          };
          return;
        }
        continue;
      }

      repairCount = 0;
      const output = parsed.output;
      transcript.push({ role: "assistant", content: JSON.stringify(output) });

      if (output.type === "final") {
        yield { type: "result", success: true, title: "Hermes 回复", detail: output.message, at: now() };
        return;
      }

      yield { type: "tool_call", toolName: output.tool, argsPreview: summarizeToolInput(output), at: now() };
      const result = await this.windowsToolExecutor.execute(output, {
        taskRunId: request.sessionId,
        publish: publishEvent,
      });
      transcript.push({ role: "observation", content: result });
      yield {
        type: "tool_result",
        toolName: output.tool,
        success: result.ok,
        status: result.ok ? "complete" : "failed",
        outputPreview: result.message,
        at: now(),
      };
      if (output.tool === "windows.files.writeText" && result.ok && typeof result.result?.path === "string") {
        yield { type: "file_change", changeType: "create", path: result.result.path, at: now() };
      }
    }

    yield {
      type: "result",
      success: false,
      title: "Hermes Tool Loop 步数超限",
      detail: `已达到 ${MAX_STEPS} 步上限。请缩小任务范围或让 Hermes 总结当前状态。`,
      at: now(),
    };
  }
}

export function parseHermesToolOutput(raw: string): { ok: true; output: HermesToolLoopModelOutput } | { ok: false; message: string } {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return { ok: false, message: "未找到 JSON object。" };
  }
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: "JSON 不是 object。" };
    }
    const candidate = parsed as Partial<HermesToolLoopModelOutput>;
    if (candidate.type === "final" && typeof candidate.message === "string") {
      return { ok: true, output: { type: "final", message: candidate.message } };
    }
    if (candidate.type === "tool_call" && typeof (candidate as WindowsToolCall).tool === "string") {
      const call = candidate as WindowsToolCall;
      return { ok: true, output: { type: "tool_call", tool: call.tool, input: isRecord(call.input) ? call.input : {} } };
    }
    return { ok: false, message: "JSON 缺少合法 type/tool/message。" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function extractJsonObject(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("{")) return fenced;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return raw.slice(start, end + 1);
}

function summarizeToolInput(call: WindowsToolCall) {
  const input = call.input ?? {};
  const redacted = call.tool === "windows.clipboard.write" && typeof input.text === "string"
    ? { ...input, text: `[${input.text.length} chars]` }
    : input;
  return JSON.stringify(redacted).slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
