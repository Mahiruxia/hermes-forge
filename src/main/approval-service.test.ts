import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPaths } from "./app-paths";
import { ApprovalService } from "./approval-service";
import type { ApprovalChoice, EngineEvent } from "../shared/types";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "approval-service-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("ApprovalService", () => {
  const commandRequest = { taskRunId: "task-1", scopeKey: "chat-1", title: "Run command", command: "echo ok", patternKey: "cmd:echo", actionKind: "command_run" as const, risk: "high" as const };
  async function start(service: ApprovalService, input = commandRequest, publish?: (event: EngineEvent) => Promise<void>) {
    const events: EngineEvent[] = [];
    const decision = service.request(input, async (event) => { events.push(event); await publish?.(event); });
    await waitForApprovalEvent(events, "requested");
    const event = events.find((item) => item.type === "approval");
    if (event?.type !== "approval") throw new Error("Missing approval");
    return { decision, events, id: event.request.id };
  }

  it("rejects unsupported scope and command editing without consuming the request", async () => {
    const service = new ApprovalService(new AppPaths(tempRoot));
    const events: EngineEvent[] = [];
    const decision = service.request({ ...commandRequest, allowedChoices: ["once", "deny"], allowEdit: false }, async (event) => { events.push(event); });
    await waitForApprovalEvent(events, "requested");
    const event = events[0];
    if (event.type !== "approval") throw new Error("Missing approval");
    const id = event.request.id;
    for (const choice of ["always", "session", "unsupported"]) {
      expect(await service.respond({ id, choice: choice as ApprovalChoice })).toMatchObject({ ok: false });
    }
    expect(await service.respond({ id, choice: "once", editedCommand: "different command" })).toMatchObject({ ok: false });
    expect(await service.respond({ id, choice: "deny" })).toMatchObject({ ok: true, approved: false });
    await expect(decision).resolves.toMatchObject({ approved: false, choice: "deny" });
    expect(await service.respond({ id, choice: "once" })).toMatchObject({ ok: false });
  });

  it("scopes session rules to the chat and leaves Hermes-owned rules to Hermes", async () => {
    const service = new ApprovalService(new AppPaths(tempRoot));
    const first = await start(service);
    await service.respond({ id: first.id, choice: "session" });
    await first.decision;
    const sameChatEvents: EngineEvent[] = [];
    await expect(service.request({ ...commandRequest, taskRunId: "task-2" }, async (event) => { sameChatEvents.push(event); })).resolves.toMatchObject({ choice: "session" });
    expect(sameChatEvents[0]).toMatchObject({ outcome: "auto_approved" });
    const other = await start(service, { ...commandRequest, taskRunId: "task-3", scopeKey: "chat-2" });
    await service.respond({ id: other.id, choice: "deny" });
    await other.decision;
    const hermesEvents: EngineEvent[] = [];
    const hermes = service.request({ ...commandRequest, taskRunId: "task-4", managePolicies: false }, async (event) => { hermesEvents.push(event); });
    await waitForApprovalEvent(hermesEvents, "requested");
    const event = hermesEvents[0];
    if (event.type !== "approval") throw new Error("Missing approval");
    await service.respond({ id: event.request.id, choice: "deny" });
    await expect(hermes).resolves.toMatchObject({ choice: "deny" });
  });

  it("resolves cancellation even when completion publication fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new ApprovalService(new AppPaths(tempRoot));
    const controller = new AbortController();
    const events: EngineEvent[] = [];
    const decision = service.request({ ...commandRequest, signal: controller.signal }, async (event) => {
      events.push(event);
      if (event.type === "approval" && event.outcome === "expired") throw new Error("log unavailable");
    });
    await waitForApprovalEvent(events, "requested");
    controller.abort();
    await expect(decision).resolves.toMatchObject({ approved: false, choice: "deny" });
  });

  it("denies and resolves when saving a permanent rule fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new ApprovalService(new AppPaths(tempRoot));
    vi.spyOn(service as unknown as { persist(): Promise<void> }, "persist").mockRejectedValue(new Error("disk full"));
    const pending = await start(service);
    expect(await service.respond({ id: pending.id, choice: "always" })).toMatchObject({ ok: false, approved: false });
    await expect(pending.decision).resolves.toMatchObject({ approved: false, choice: "deny" });
    const next = await start(service);
    await service.respond({ id: next.id, choice: "deny" });
    await next.decision;
  });

  it("denies and resolves when a response cannot be published", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new ApprovalService(new AppPaths(tempRoot));
    const pending = await start(service, commandRequest, async (event) => {
      if (event.type === "approval" && event.outcome === "approved") throw new Error("log unavailable");
    });
    expect(await service.respond({ id: pending.id, choice: "once" })).toMatchObject({ ok: false, approved: false });
    await expect(pending.decision).resolves.toMatchObject({ approved: false, choice: "deny" });
  });

  it("persists always-approved pattern keys and auto-approves subsequent requests", async () => {
    const service = new ApprovalService(new AppPaths(tempRoot));
    const events: EngineEvent[] = [];

    const pending = service.request({
      taskRunId: "task-1",
      title: "允许写文件",
      patternKey: "file:demo",
      actionKind: "file_write",
      risk: "high",
    }, async (event) => {
      events.push(event);
    });
    await waitForApprovalEvent(events, "requested");

    const requestEvent = events.find((event) => event.type === "approval" && event.outcome === "requested");
    expect(requestEvent?.type).toBe("approval");
    await service.respond({ id: requestEvent?.type === "approval" ? requestEvent.request.id : "", choice: "always" });
    await expect(pending).resolves.toMatchObject({ approved: true, choice: "always" });

    const followupEvents: EngineEvent[] = [];
    await expect(service.request({
      taskRunId: "task-2",
      title: "再次写文件",
      patternKey: "file:demo",
      actionKind: "file_write",
      risk: "high",
    }, async (event) => {
      followupEvents.push(event);
    })).resolves.toMatchObject({ approved: true, choice: "always" });
    expect(followupEvents.some((event) => event.type === "approval" && event.outcome === "auto_approved")).toBe(true);
  });

  it("expires pending approvals after timeout", async () => {
    const service = new ApprovalService(new AppPaths(tempRoot));
    const publish = vi.fn(async (_event: EngineEvent) => undefined);

    await expect(service.request({
      taskRunId: "task-timeout",
      title: "允许执行 PowerShell",
      patternKey: "tool:powershell",
      actionKind: "command_run",
      risk: "high",
      timeoutMs: 10,
    }, publish)).resolves.toMatchObject({ approved: false, choice: "deny" });
    expect(publish).toHaveBeenCalled();
  });

  it("ignores and quarantines malformed persistent approval policy", async () => {
    await fs.writeFile(path.join(tempRoot, "approval-policy.json"), JSON.stringify({ patternKeys: [123] }), "utf8");
    const service = new ApprovalService(new AppPaths(tempRoot));
    const publish = vi.fn(async (_event: EngineEvent) => undefined);

    const pending = service.request({
      taskRunId: "task-bad-policy",
      title: "需要重新审批",
      patternKey: "file:demo",
      actionKind: "file_write",
      risk: "high",
      timeoutMs: 10,
    }, publish);

    await expect(pending).resolves.toMatchObject({ approved: false, choice: "deny" });
    const files = await fs.readdir(tempRoot);
    expect(files.some((file) => file.startsWith("approval-policy.json.invalid."))).toBe(true);
  });
});

async function waitForApprovalEvent(events: EngineEvent[], outcome: "requested" | "auto_approved", timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === "approval" && event.outcome === outcome)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for approval event: ${outcome}`);
}
