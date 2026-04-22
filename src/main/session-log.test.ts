// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppPaths } from "./app-paths";
import { SessionLog } from "./session-log";
import type { TaskEventEnvelope } from "../shared/types";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("SessionLog.readRecent", () => {
  it("filters events by work session id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-session-log-"));
    tempRoots.push(root);
    const appPaths = new AppPaths(root);
    const sessionLog = new SessionLog(appPaths);
    const workspaceId = appPaths.workspaceId(path.join(root, "workspace"));

    const first = eventFor("task-a", "session-a", "first");
    const second = eventFor("task-b", "session-b", "second");
    await sessionLog.append(workspaceId, first);
    await sessionLog.append(workspaceId, second);

    const events = await sessionLog.readRecent(workspaceId, 200, "session-a");

    expect(events).toHaveLength(1);
    expect(events[0].taskRunId).toBe("task-a");
    expect(events[0].event.type).toBe("result");
    if (events[0].event.type === "result") {
      expect(events[0].event.detail).toBe("first");
    }
  });

  it("keeps long session reads capped after filtering", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-session-log-"));
    tempRoots.push(root);
    const appPaths = new AppPaths(root);
    const sessionLog = new SessionLog(appPaths);
    const workspaceId = appPaths.workspaceId(path.join(root, "workspace"));

    for (let index = 0; index < 260; index += 1) {
      const at = new Date(Date.UTC(2026, 3, 22, 12, 0, index)).toISOString();
      await sessionLog.append(workspaceId, eventFor(`task-${index}`, "session-long", `detail-${index}`, at));
    }
    for (let index = 0; index < 20; index += 1) {
      const at = new Date(Date.UTC(2026, 3, 22, 13, 0, index)).toISOString();
      await sessionLog.append(workspaceId, eventFor(`other-${index}`, "session-other", `other-${index}`, at));
    }

    const events = await sessionLog.readRecent(workspaceId, 200, "session-long");

    expect(events).toHaveLength(200);
    expect(events[0].taskRunId).toBe("task-60");
    expect(events.at(-1)?.taskRunId).toBe("task-259");
    expect(events.every((event) => event.workSessionId === "session-long")).toBe(true);
  });
});

describe("SessionLog.aggregateUsageForSession", () => {
  it("uses the latest usage event per task run when building totals", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-session-log-"));
    tempRoots.push(root);
    const appPaths = new AppPaths(root);
    const sessionLog = new SessionLog(appPaths);
    const workspaceId = appPaths.workspaceId(path.join(root, "workspace"));

    await sessionLog.append(workspaceId, usageEventFor("task-1", "session-a", 100, 20, 0.001, "2026-04-22T10:00:00.000Z"));
    await sessionLog.append(workspaceId, usageEventFor("task-1", "session-a", 140, 40, 0.002, "2026-04-22T10:00:01.000Z"));
    await sessionLog.append(workspaceId, usageEventFor("task-2", "session-a", 30, 10, 0.0005, "2026-04-22T10:00:02.000Z"));

    const usage = await sessionLog.aggregateUsageForSession(workspaceId, "session-a");

    expect(usage).toEqual({
      totalInputTokens: 170,
      totalOutputTokens: 50,
      totalEstimatedCostUsd: 0.0025,
      latestInputTokens: 30,
      latestOutputTokens: 10,
      latestEstimatedCostUsd: 0.0005,
      updatedAt: "2026-04-22T10:00:02.000Z",
    });
  });
});

function eventFor(taskRunId: string, workSessionId: string, detail: string, at = "2026-04-22T00:00:00.000Z"): TaskEventEnvelope {
  return {
    taskRunId,
    workSessionId,
    sessionId: taskRunId,
    engineId: "hermes",
    event: {
      type: "result",
      success: true,
      title: "Hermes 回复",
      detail,
      at,
    },
  };
}

function usageEventFor(taskRunId: string, workSessionId: string, inputTokens: number, outputTokens: number, estimatedCostUsd: number, at: string): TaskEventEnvelope {
  return {
    taskRunId,
    workSessionId,
    sessionId: taskRunId,
    engineId: "hermes",
    event: {
      type: "usage",
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      message: "usage",
      at,
    },
  };
}
