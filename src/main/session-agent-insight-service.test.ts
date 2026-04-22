// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppPaths } from "./app-paths";
import { SessionAgentInsightService } from "./session-agent-insight-service";
import { SessionLog } from "./session-log";
import type { RuntimeConfig, TaskEventEnvelope } from "../shared/types";

const tempRoots: string[] = [];

async function createHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhenghebao-agent-insight-"));
  tempRoots.push(root);
  const appPaths = new AppPaths(root);
  await appPaths.ensureBaseLayout();
  const sessionLog = new SessionLog(appPaths);
  const service = new SessionAgentInsightService(appPaths, sessionLog);
  return { root, appPaths, sessionLog, service };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("SessionAgentInsightService", () => {
  it("records runtime and memory snapshots on task start", async () => {
    const { service } = await createHarness();
    const runtimeConfig: RuntimeConfig = {
      defaultModelProfileId: "default-model",
      modelProfiles: [{ id: "default-model", provider: "custom", model: "gpt-5.4", temperature: 0.6, maxTokens: 128000 }],
      providerProfiles: [{ id: "provider-1", provider: "custom", label: "Provider", models: [{ id: "gpt-5.4", label: "gpt-5.4", contextWindow: 128000 }], status: "ready" }],
      updateSources: {},
    };

    await service.recordTaskStart({
      sessionId: "session-1",
      taskRunId: "task-1",
      runtimeConfig,
      runtimeEnv: { profileId: "default-model", provider: "custom", model: "gpt-5.4", executionMode: "local_fast", env: {} },
      contextBundle: {
        id: "bundle-1",
        workspaceId: "workspace-1",
        policy: "isolated",
        readonly: true,
        maxCharacters: 128000,
        usedCharacters: 48000,
        sources: [],
        summary: "记忆摘要",
        expiresAt: "2026-04-22T12:00:00.000Z",
        createdAt: "2026-04-22T10:00:00.000Z",
      },
      updatedAt: "2026-04-22T10:00:00.000Z",
    });

    const insight = await service.read("session-1");
    expect(insight.latestRuntime).toEqual(expect.objectContaining({
      taskRunId: "task-1",
      modelId: "gpt-5.4",
      providerId: "custom",
      contextWindow: 128000,
      temperature: 0.6,
    }));
    expect(insight.memory).toEqual(expect.objectContaining({
      bundleId: "bundle-1",
      usedCharacters: 48000,
      maxCharacters: 128000,
      summary: "记忆摘要",
    }));
  });

  it("rebuilds usage totals from session logs", async () => {
    const { appPaths, sessionLog, service } = await createHarness();
    const workspacePath = path.join(appPaths.baseDir(), "workspace");
    const workspaceId = appPaths.workspaceId(workspacePath);
    await sessionLog.append(workspaceId, usageEvent("task-1", "session-1", 100, 50, 0.001, "2026-04-22T10:00:00.000Z"));
    await sessionLog.append(workspaceId, usageEvent("task-1", "session-1", 120, 80, 0.002, "2026-04-22T10:00:01.000Z"));
    await sessionLog.append(workspaceId, usageEvent("task-2", "session-1", 30, 20, 0.0005, "2026-04-22T10:00:02.000Z"));

    await service.recordUsage({ sessionId: "session-1", workspaceId });

    const insight = await service.read("session-1");
    expect(insight.usage).toEqual(expect.objectContaining({
      totalInputTokens: 150,
      totalOutputTokens: 100,
      latestInputTokens: 30,
      latestOutputTokens: 20,
      updatedAt: "2026-04-22T10:00:02.000Z",
    }));
  });

  it("falls back to session log usage when sidecar is missing", async () => {
    const { appPaths, sessionLog, service } = await createHarness();
    const workspacePath = path.join(appPaths.baseDir(), "workspace");
    const workspaceId = appPaths.workspaceId(workspacePath);
    await sessionLog.append(workspaceId, usageEvent("task-1", "session-1", 200, 40, 0.0012, "2026-04-22T10:00:00.000Z"));

    const insight = await service.read("session-1", workspacePath);

    expect(insight.sessionId).toBe("session-1");
    expect(insight.usage).toEqual(expect.objectContaining({
      totalInputTokens: 200,
      totalOutputTokens: 40,
      latestInputTokens: 200,
      latestOutputTokens: 40,
    }));
  });

  it("clears persisted insight", async () => {
    const { appPaths, service } = await createHarness();
    await fs.mkdir(path.dirname(appPaths.sessionAgentInsightPath("session-1")), { recursive: true });
    await fs.writeFile(appPaths.sessionAgentInsightPath("session-1"), JSON.stringify({ sessionId: "session-1" }), "utf8");

    await service.clear("session-1");

    await expect(fs.stat(appPaths.sessionAgentInsightPath("session-1"))).rejects.toBeTruthy();
  });
});

function usageEvent(taskRunId: string, workSessionId: string, inputTokens: number, outputTokens: number, estimatedCostUsd: number, at: string): TaskEventEnvelope {
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
