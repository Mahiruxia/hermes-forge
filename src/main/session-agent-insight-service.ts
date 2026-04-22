import fs from "node:fs/promises";
import type { AppPaths } from "./app-paths";
import type { SessionLog } from "./session-log";
import type {
  ContextBundle,
  EngineRuntimeEnv,
  RuntimeConfig,
  SessionAgentInsight,
  SessionAgentInsightMemory,
  SessionAgentInsightRuntime,
  SessionAgentInsightUsage,
  TaskRunStatus,
} from "../shared/types";

export class SessionAgentInsightService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly sessionLog: SessionLog,
  ) {}

  async read(sessionId: string, eventSourcePath?: string): Promise<SessionAgentInsight> {
    const stored = await this.readStored(sessionId);
    if (stored.usage) {
      return stored;
    }
    if (!eventSourcePath?.trim()) {
      return stored;
    }
    const usage = await this.sessionLog.aggregateUsageForSession(this.appPaths.workspaceId(eventSourcePath), sessionId);
    return usage ? { ...stored, usage } : stored;
  }

  async recordTaskStart(input: {
    sessionId: string;
    taskRunId: string;
    runtimeConfig: RuntimeConfig;
    runtimeEnv: EngineRuntimeEnv;
    contextBundle: ContextBundle;
    updatedAt?: string;
  }) {
    const current = await this.readStored(input.sessionId);
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const latestRuntime = this.resolveRuntimeSnapshot(input.runtimeConfig, input.runtimeEnv, input.taskRunId, updatedAt);
    const memory: SessionAgentInsightMemory = {
      bundleId: input.contextBundle.id,
      usedCharacters: input.contextBundle.usedCharacters,
      maxCharacters: input.contextBundle.maxCharacters,
      summary: input.contextBundle.summary,
      updatedAt,
    };
    await this.writeStored({
      ...current,
      sessionId: input.sessionId,
      latestRuntime,
      memory,
    });
  }

  async recordUsage(input: {
    sessionId: string;
    workspaceId: string;
  }) {
    const current = await this.readStored(input.sessionId);
    const usage = await this.sessionLog.aggregateUsageForSession(input.workspaceId, input.sessionId);
    if (!usage) {
      return;
    }
    await this.writeStored({
      ...current,
      sessionId: input.sessionId,
      usage,
    });
  }

  async recordTaskTerminal(input: {
    sessionId: string;
    taskRunId: string;
    status: TaskRunStatus;
    updatedAt?: string;
  }) {
    const current = await this.readStored(input.sessionId);
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const latestRuntime: SessionAgentInsightRuntime = {
      taskRunId: input.taskRunId,
      status: input.status,
      providerId: current.latestRuntime?.providerId,
      modelId: current.latestRuntime?.modelId,
      runtimeMode: current.latestRuntime?.runtimeMode,
      contextWindow: current.latestRuntime?.contextWindow,
      temperature: current.latestRuntime?.temperature,
      updatedAt,
    };
    await this.writeStored({
      ...current,
      sessionId: input.sessionId,
      latestRuntime,
    });
  }

  async clear(sessionId: string) {
    await fs.rm(this.appPaths.sessionAgentInsightPath(sessionId), { force: true }).catch(() => undefined);
  }

  private async readStored(sessionId: string): Promise<SessionAgentInsight> {
    const raw = await fs.readFile(this.appPaths.sessionAgentInsightPath(sessionId), "utf8").catch(() => "");
    if (!raw) return { sessionId };
    try {
      const parsed = JSON.parse(raw) as SessionAgentInsight;
      return { ...parsed, sessionId };
    } catch {
      return { sessionId };
    }
  }

  private async writeStored(insight: SessionAgentInsight) {
    await fs.mkdir(this.appPaths.sessionDir(insight.sessionId), { recursive: true });
    await fs.writeFile(this.appPaths.sessionAgentInsightPath(insight.sessionId), JSON.stringify(insight, null, 2), "utf8");
  }

  private resolveRuntimeSnapshot(config: RuntimeConfig, runtimeEnv: EngineRuntimeEnv, taskRunId: string, updatedAt: string): SessionAgentInsightRuntime {
    const modelProfile = config.modelProfiles.find((profile) => profile.id === runtimeEnv.profileId)
      ?? config.modelProfiles.find((profile) => profile.model === runtimeEnv.model)
      ?? config.modelProfiles[0];
    const providerProfile = (config.providerProfiles ?? []).find((profile) => profile.id === runtimeEnv.providerProfileId)
      ?? (config.providerProfiles ?? []).find((profile) => profile.provider === runtimeEnv.provider && profile.models.some((model) => model.id === runtimeEnv.model || model.label === runtimeEnv.model));
    const modelOption = providerProfile?.models.find((model) => model.id === runtimeEnv.model || model.label === runtimeEnv.model);
    return {
      taskRunId,
      status: "running",
      providerId: runtimeEnv.provider,
      modelId: runtimeEnv.model,
      runtimeMode: runtimeEnv.executionMode,
      contextWindow: modelOption?.contextWindow ?? modelProfile?.maxTokens,
      temperature: modelProfile?.temperature ?? 0.7,
      updatedAt,
    };
  }
}
