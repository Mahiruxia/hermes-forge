import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineInteractionService } from "./engine-interaction-service";
import type { ApprovalService } from "./approval-service";
import type { EngineEvent, EngineInteractionRequest } from "../shared/types";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const approvalRequest = vi.fn(async () => ({ approved: true, choice: "once" as const }));
  const service = new EngineInteractionService({ request: approvalRequest } as unknown as ApprovalService);
  const events: EngineEvent[] = [];
  const controller = new AbortController();
  const context = { signal: controller.signal, workSessionId: "chat-1", workspaceId: "workspace-1", publish: async (event: EngineEvent) => { events.push(event); } };
  return { service, events, context, controller, approvalRequest };
}
const clarification = { kind: "clarify" as const, requestId: "ask-1", taskRunId: "task-1", timeoutMs: 1000, question: "Choose", choices: ["A", "B"] };

describe("EngineInteractionService", () => {
  it("passes official scope restrictions and disables Forge auto-approval policies", async () => {
    const { service, context, approvalRequest } = fixture();
    const request: EngineInteractionRequest = { kind: "approval", requestId: "approve-1", taskRunId: "task-1", timeoutMs: 1000, command: "echo ok", description: "Run", allowSession: true, allowPermanent: true, smartDenied: true };
    expect(await service.handle(request, context)).toMatchObject({ kind: "approval", requestId: "approve-1", taskRunId: "task-1", choice: "once" });
    expect(approvalRequest).toHaveBeenCalledWith(expect.objectContaining({ allowedChoices: ["once", "deny"], managePolicies: false, allowEdit: false, scopeKey: "chat-1", signal: context.signal }), context.publish);
  });

  it("routes concurrent identical request IDs to their own tasks and consumes once", async () => {
    const { service, context } = fixture();
    const first = service.handle(clarification, context);
    const second = service.handle({ ...clarification, taskRunId: "task-2" }, context);
    expect(await service.respond({ kind: "clarify", requestId: "ask-1", taskRunId: "other-task", answer: "A" })).toMatchObject({ ok: false });
    expect(await service.respond({ kind: "clarify", requestId: "ask-1", taskRunId: "task-2", answer: "B" })).toMatchObject({ ok: true });
    expect(await service.respond({ kind: "clarify", requestId: "ask-1", taskRunId: "task-2", answer: "A" })).toMatchObject({ ok: false });
    expect(await service.respond({ kind: "clarify", requestId: "ask-1", taskRunId: "task-1", answer: "A" })).toMatchObject({ ok: true });
    await expect(first).resolves.toMatchObject({ taskRunId: "task-1", answer: "A" });
    await expect(second).resolves.toMatchObject({ taskRunId: "task-2", answer: "B" });
  });

  it("rejects duplicate pending requests in one task", async () => {
    const { service, context, controller } = fixture();
    const pending = service.handle(clarification, context);
    await expect(service.handle(clarification, context)).rejects.toThrow("重复");
    controller.abort();
    await expect(pending).resolves.toMatchObject({ timedOut: true });
  });

  it("requires every batch answer and validates multi-select shape", async () => {
    const { service, context } = fixture();
    const pending = service.handle({ ...clarification, questions: [{ id: "q1", question: "Where?" }, { id: "q2", question: "Which?", multiSelect: true, choices: ["A", "B"] }] }, context);
    const identity = { kind: "clarify" as const, requestId: "ask-1", taskRunId: "task-1" };
    expect(await service.respond({ ...identity, answers: { q1: "answer" } })).toMatchObject({ ok: false });
    expect(await service.respond({ ...identity, answers: { q1: ["wrong shape"], q2: ["A"] } })).toMatchObject({ ok: false });
    expect(await service.respond({ ...identity, answers: { q1: "answer", q2: ["A"], unknown: "injected" } })).toMatchObject({ ok: false });
    expect(await service.respond({ ...identity, answers: { q1: "answer", q2: ["A", "B"] } })).toMatchObject({ ok: true });
    await expect(pending).resolves.toMatchObject({ answers: { q1: "answer", q2: ["A", "B"] } });
  });

  it("resolves an abort even if dismissing the card cannot be published", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, context, controller } = fixture();
    context.publish = async (event) => { if (event.type === "clarify" && event.status === "dismissed") throw new Error("log unavailable"); };
    const pending = service.handle(clarification, context);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ timedOut: true });
    expect(await service.respond({ kind: "clarify", requestId: "ask-1", taskRunId: "task-1", answer: "late" })).toMatchObject({ ok: false });
  });

  it("bounds unanswered questions and removes the pending request", async () => {
    const { service, context, events } = fixture();
    await expect(service.handle({ ...clarification, timeoutMs: 10 }, context)).resolves.toMatchObject({ timedOut: true });
    expect(events.at(-1)).toMatchObject({ type: "clarify", status: "dismissed" });
    expect(await service.respond({ kind: "clarify", requestId: "ask-1", taskRunId: "task-1", answer: "late" })).toMatchObject({ ok: false });
  });
});
