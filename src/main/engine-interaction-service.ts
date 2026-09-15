import crypto from "node:crypto";
import type { ApprovalService } from "./approval-service";
import type { TaskInteractionHandler } from "../process/task-runner";
import type { EngineInteractionRequest, EngineInteractionResponse } from "../shared/types";

type Clarification = Extract<EngineInteractionRequest, { kind: "clarify" }>;
type Answer = Extract<EngineInteractionResponse, { kind: "clarify" }>;
type Pending = { request: Clarification; finish: (answer: Answer) => Promise<void> };

/** Replies are bound to the originating task; a reply can only be consumed once. */
export class EngineInteractionService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly approvals: ApprovalService) {}

  readonly handle: TaskInteractionHandler = async (request, context) => {
    if (request.kind === "approval") {
      const allowedChoices = ["once", "deny"] as Array<"once" | "session" | "always" | "deny">;
      if (!request.smartDenied && request.allowSession) allowedChoices.push("session");
      if (!request.smartDenied && request.allowPermanent) allowedChoices.push("always");
      const result = await this.approvals.request({
        taskRunId: request.taskRunId,
        scopeKey: context.workSessionId ?? request.taskRunId,
        title: "Hermes 请求执行命令",
        command: request.command,
        details: request.description,
        patternKey: `hermes:${crypto.createHash("sha256").update(request.command).digest("hex")}`,
        actionKind: "command_run",
        risk: "high",
        timeoutMs: request.timeoutMs,
        allowedChoices,
        allowEdit: false,
        // Hermes owns its persistent policies. An existing Forge rule cannot
        // override a fresh request or a restriction from the official engine.
        managePolicies: false,
        signal: context.signal,
      }, context.publish);
      return { requestId: request.requestId, taskRunId: request.taskRunId, kind: "approval", choice: context.signal.aborted ? "timeout" : result.choice };
    }

    const timeoutAnswer: Answer = { requestId: request.requestId, taskRunId: request.taskRunId, kind: "clarify", timedOut: true };
    if (context.signal.aborted) return timeoutAnswer;
    const key = this.key(request);
    if (this.pending.has(key)) throw new Error("重复的 Hermes 交互请求。");
    let resolveAnswer!: (answer: Answer) => void;
    const promise = new Promise<Answer>((resolve) => { resolveAnswer = resolve; });
    let timer: NodeJS.Timeout;
    const abort = () => { void finish(timeoutAnswer); };
    const finish = async (answer: Answer) => {
      if (!this.pending.delete(key)) return;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      try {
        await context.publish({ type: "clarify", ...request, status: answer.timedOut ? "dismissed" : "answered", at: new Date().toISOString() });
      } catch (error) {
        console.warn("[Hermes Forge] Failed to publish clarification completion:", error);
      } finally {
        resolveAnswer(answer);
      }
    };
    this.pending.set(key, { request, finish });
    timer = setTimeout(abort, request.timeoutMs);
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      if (context.signal.aborted) await finish(timeoutAnswer);
      else await context.publish({ type: "clarify", ...request, status: "pending", at: new Date().toISOString() });
    } catch (error) {
      await finish(timeoutAnswer);
      throw error;
    }
    return promise;
  };

  async respond(response: EngineInteractionResponse): Promise<{ ok: boolean; message: string }> {
    const pending = this.pending.get(this.key(response));
    if (!pending || response.kind !== "clarify") return { ok: false, message: "请求不存在、已结束或不属于当前任务。" };
    if (!response.timedOut) {
      const validAnswer = (value: unknown, multiSelect?: boolean): boolean =>
        typeof value === "string" ? value.trim().length > 0 : Boolean(multiSelect && Array.isArray(value) && value.length && value.every((item) => typeof item === "string" && item.trim()));
      const questions = pending.request.questions;
      if (questions?.length) {
        if (!response.answers || Object.keys(response.answers).some((id) => !questions.some((question) => question.id === id)) || questions.some((question) => !validAnswer(response.answers?.[question.id], question.multiSelect))) {
          return { ok: false, message: "请回答每个问题。" };
        }
      } else if (!validAnswer(response.answer, pending.request.multiSelect)) {
        return { ok: false, message: "请填写回答或选择选项。" };
      }
    }
    await pending.finish(response);
    return { ok: true, message: response.timedOut ? "已取消回答。" : "回答已发送给当前任务。" };
  }

  private key(request: { requestId: string; taskRunId: string }) {
    return `${request.taskRunId}\0${request.requestId}`;
  }
}
