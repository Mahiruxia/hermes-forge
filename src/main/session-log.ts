import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { aggregateCacheUsage } from "../shared/token-usage";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AppPaths } from "./app-paths";
import type { EngineEvent, SessionAgentInsightUsage, TaskEventEnvelope } from "../shared/types";
import { redactSensitiveValue } from "../shared/redaction";

const RECENT_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_RECENT_SESSION_RUNS = 160;
type UsageEvent = Extract<EngineEvent, { type: "usage" }>;
type UsageFileSummary = {
  signature: string;
  latestBySessionAndTask: Map<string, Map<string, UsageEvent>>;
};

export class SessionLog {
  private readonly usageFileCache = new Map<string, UsageFileSummary>();

  constructor(private readonly appPaths: AppPaths) {}

  async append(workspaceId: string, envelope: TaskEventEnvelope) {
    const filePath = path.join(this.appPaths.workspaceSessionDir(workspaceId), `${envelope.sessionId}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(this.redact(envelope))}\n`, "utf8");
  }

  async readRecent(workspaceId: string, maxEvents = 200, workSessionId?: string) {
    const dir = this.appPaths.workspaceSessionDir(workspaceId);
    const files = await fs.readdir(dir).catch(() => []);
    const events: TaskEventEnvelope[] = [];

    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      const text = await readFileTail(path.join(dir, file), RECENT_LOG_TAIL_BYTES).catch(() => "");
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        try {
          const event = JSON.parse(line) as TaskEventEnvelope;
          if (!workSessionId || event.workSessionId === workSessionId) {
            events.push(event);
          }
        } catch {
          // Ignore corrupt diagnostic lines.
        }
      }
    }

    return events
      .sort((left, right) => this.eventTimestamp(left.event).localeCompare(this.eventTimestamp(right.event)))
      .slice(-maxEvents);
  }

  async readRecentSessionRuns(workspaceId: string, workSessionId: string, maxRuns = DEFAULT_RECENT_SESSION_RUNS) {
    const dir = this.appPaths.workspaceSessionDir(workspaceId);
    const files = await fs.readdir(dir).catch(() => []);
    const byTaskRun = new Map<string, TaskEventEnvelope[]>();

    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      for await (const line of readJsonlLines(path.join(dir, file))) {
        try {
          const event = JSON.parse(line) as TaskEventEnvelope;
          if (event.workSessionId !== workSessionId) continue;
          const key = event.taskRunId || event.sessionId || file;
          const events = byTaskRun.get(key) ?? [];
          events.push(event);
          byTaskRun.set(key, events);
        } catch {
          // Ignore corrupt diagnostic lines.
        }
      }
    }

    const latestRuns = [...byTaskRun.values()]
      .map((events) => [...events].sort((left, right) => this.eventTimestamp(left.event).localeCompare(this.eventTimestamp(right.event))))
      .sort((left, right) => this.eventTimestamp(left.at(-1)?.event).localeCompare(this.eventTimestamp(right.at(-1)?.event)))
      .slice(-maxRuns);

    return latestRuns
      .flat()
      .sort((left, right) => this.eventTimestamp(left.event).localeCompare(this.eventTimestamp(right.event)));
  }

  async summarizeRecentRuns(workspaceId: string, maxEvents = 400) {
    const events = await this.readRecent(workspaceId, maxEvents);
    const grouped = new Map<string, TaskEventEnvelope[]>();
    for (const envelope of events) {
      const key = envelope.taskRunId || envelope.sessionId || "unknown";
      grouped.set(key, [...(grouped.get(key) ?? []), envelope]);
    }

    return [...grouped.entries()].map(([taskRunId, taskEvents]) => {
      const sorted = [...taskEvents].sort((left, right) => this.eventTimestamp(left.event).localeCompare(this.eventTimestamp(right.event)));
      const last = sorted.at(-1);
      const status = this.detectRunStatus(sorted.map((item) => item.event));
      const startedAt = this.eventTimestamp(sorted[0]?.event);
      const completedAt = last ? this.eventTimestamp(last.event) : undefined;
      const fileChanges = sorted.filter((item) => item.event.type === "file_change").length;
      const toolCalls = sorted.filter((item) => item.event.type === "tool_call").length;
      return {
        taskRunId,
        status,
        startedAt,
        completedAt,
        eventCount: sorted.length,
        fileChanges,
        toolCalls,
      };
    }).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  }

  async aggregateUsageForSession(workspaceId: string, workSessionId: string): Promise<SessionAgentInsightUsage | undefined> {
    const dir = this.appPaths.workspaceSessionDir(workspaceId);
    const files = await fs.readdir(dir).catch(() => []);
    const latestByTaskRun = new Map<string, UsageEvent>();
    let latestInputTokens = 0;
    let latestOutputTokens = 0;
    let latestTotalTokens: number | undefined;
    let latestContextTokens: number | undefined;
    let latestContextOutputTokens: number | undefined;
    let latestContextSource: "estimated" | "actual" | undefined;
    let latestContextWindow: number | undefined;
    let latestContextPercent: number | undefined;
    let latestEstimatedCostUsd = 0;
    let latestReasoningTokens: number | undefined;
    let latestCacheReadTokens: number | undefined;
    let latestCacheWriteTokens: number | undefined;
    let latestModelId: string | undefined;
    let latestModelProfileId: string | undefined;
    let latestSource: "estimated" | "actual" = "estimated";
    let updatedAt = "";

    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      const fileSummary = await this.readUsageFileSummary(path.join(dir, file)).catch(() => undefined);
      if (!fileSummary) {
        continue;
      }
      const sessionUsage = fileSummary.latestBySessionAndTask.get(workSessionId);
      if (!sessionUsage) {
        continue;
      }
      for (const [taskRunId, usage] of sessionUsage) {
        const existing = latestByTaskRun.get(taskRunId);
        if (!existing || prefersUsageEvent(usage, existing)) {
          latestByTaskRun.set(taskRunId, usage);
        }
      }
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalEstimatedCostUsd = 0;
    for (const usage of latestByTaskRun.values()) {
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      totalTokens += usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
      totalEstimatedCostUsd += usage.estimatedCostUsd;
      if (usage.at >= updatedAt) {
        latestInputTokens = usage.inputTokens;
        latestOutputTokens = usage.outputTokens;
        latestTotalTokens = usage.totalTokens;
        latestContextTokens = usage.contextTokens;
        latestContextOutputTokens = usage.contextOutputTokens;
        latestContextSource = usage.contextSource;
        latestContextWindow = usage.contextWindow;
        latestContextPercent = usage.contextPercent;
        latestEstimatedCostUsd = usage.estimatedCostUsd;
        latestReasoningTokens = usage.reasoningTokens;
        latestCacheReadTokens = usage.cacheReadTokens;
        latestCacheWriteTokens = usage.cacheWriteTokens;
        latestModelId = usage.modelId;
        latestModelProfileId = usage.modelProfileId;
        latestSource = usage.source === "actual" ? "actual" : "estimated";
        updatedAt = usage.at;
      }
    }

    if (!updatedAt) {
      return undefined;
    }

    const cacheUsage = aggregateCacheUsage([...latestByTaskRun.values()]);
    return {
      totalInputTokens,
      totalOutputTokens,
      ...(totalTokens !== totalInputTokens + totalOutputTokens ? { totalTokens } : {}),
      totalEstimatedCostUsd,
      ...(cacheUsage.cacheReadTokens !== undefined ? { totalCacheReadTokens: cacheUsage.cacheReadTokens, totalCacheInputTokens: cacheUsage.cacheInputTokens } : {}),
      ...(cacheUsage.cacheWriteTokens !== undefined ? { totalCacheWriteTokens: cacheUsage.cacheWriteTokens } : {}),
      latestInputTokens,
      latestOutputTokens,
      ...(typeof latestTotalTokens === "number" ? { latestTotalTokens } : {}),
      ...(typeof latestContextTokens === "number" ? { latestContextTokens } : {}),
      ...(typeof latestContextOutputTokens === "number" ? { latestContextOutputTokens } : {}),
      ...(latestContextSource ? { latestContextSource } : {}),
      ...(typeof latestContextWindow === "number" ? { latestContextWindow } : {}),
      ...(typeof latestContextPercent === "number" ? { latestContextPercent } : {}),
      latestEstimatedCostUsd,
      ...(typeof latestReasoningTokens === "number" ? { latestReasoningTokens } : {}),
      ...(typeof latestCacheReadTokens === "number" ? { latestCacheReadTokens } : {}),
      ...(typeof latestCacheWriteTokens === "number" ? { latestCacheWriteTokens } : {}),
      ...(latestModelId ? { latestModelId } : {}),
      ...(latestModelProfileId ? { latestModelProfileId } : {}),
      source: latestSource,
      updatedAt,
    };
  }

  private detectRunStatus(events: EngineEvent[]) {
    const lastResult = [...events].reverse().find((event) => event.type === "result");
    if (lastResult?.type === "result") return lastResult.success ? "completed" : "failed";
    const lastLifecycle = [...events].reverse().find((event) => event.type === "lifecycle");
    if (lastLifecycle?.type === "lifecycle") return lastLifecycle.stage;
    return "unknown";
  }

  private eventTimestamp(event?: EngineEvent) {
    if (!event) return "";
    return "at" in event ? event.at : new Date().toISOString();
  }

  redact<T>(value: T): T {
    return redactSensitiveValue(value);
  }

  private async readUsageFileSummary(filePath: string): Promise<UsageFileSummary> {
    const signature = await fileSignature(filePath);
    const cached = this.usageFileCache.get(filePath);
    if (cached?.signature === signature) {
      return cached;
    }

    const latestBySessionAndTask = new Map<string, Map<string, UsageEvent>>();
    for await (const line of readJsonlLines(filePath)) {
      try {
        const envelope = JSON.parse(line) as TaskEventEnvelope;
        if (!envelope.workSessionId || envelope.event.type !== "usage") continue;
        let byTask = latestBySessionAndTask.get(envelope.workSessionId);
        if (!byTask) {
          byTask = new Map<string, UsageEvent>();
          latestBySessionAndTask.set(envelope.workSessionId, byTask);
        }
        const existing = byTask.get(envelope.taskRunId);
        if (!existing || prefersUsageEvent(envelope.event, existing)) {
          byTask.set(envelope.taskRunId, envelope.event);
        }
      } catch {
        // Ignore corrupt diagnostic lines.
      }
    }

    const summary = { signature, latestBySessionAndTask };
    this.usageFileCache.set(filePath, summary);
    return summary;
  }
}

function prefersUsageEvent(next: UsageEvent, current: UsageEvent) {
  if ((next.source === "actual") !== (current.source === "actual")) return next.source === "actual";
  return next.at >= current.at;
}

async function fileSignature(filePath: string) {
  const stat = await fs.stat(filePath);
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

async function readFileTail(filePath: string, maxBytes: number) {
  const stat = await fs.stat(filePath);
  if (stat.size <= maxBytes) {
    return await fs.readFile(filePath, "utf8");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const firstLineBreak = text.search(/\r?\n/);
    return firstLineBreak >= 0 ? text.slice(firstLineBreak + (text[firstLineBreak] === "\r" && text[firstLineBreak + 1] === "\n" ? 2 : 1)) : text;
  } finally {
    await handle.close();
  }
}

async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line) yield line;
    }
  } catch {
    // Ignore unreadable diagnostic files.
  } finally {
    reader.close();
  }
}
