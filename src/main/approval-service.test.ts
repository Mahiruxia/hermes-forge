import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPaths } from "./app-paths";
import { ApprovalService } from "./approval-service";
import type { EngineEvent } from "../shared/types";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "approval-service-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("ApprovalService", () => {
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
