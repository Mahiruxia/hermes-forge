import type { EngineEvent } from "./types";

export type TokenUsage = Extract<EngineEvent, { type: "usage" }>;

/** Context is the latest request plus its response, never all tool-loop spend. */
export function currentContextTokens(usage: Pick<TokenUsage, "contextTokens" | "contextOutputTokens" | "totalTokens" | "inputTokens" | "outputTokens">) {
  if (typeof usage.contextTokens === "number") {
    return Math.max(0, usage.contextTokens) + Math.max(0, usage.contextOutputTokens ?? 0);
  }
  return Math.max(0, usage.totalTokens ?? usage.inputTokens + usage.outputTokens);
}

export function cacheHitPercent(readTokens: number | undefined, inputTokens: number | undefined) {
  if (readTokens === undefined || !inputTokens || inputTokens <= 0) return undefined;
  return Math.min(100, Math.max(0, readTokens / inputTokens * 100));
}

/** Weight by tokens; averaging percentages overcounts small requests. */
export function aggregateCacheUsage(events: TokenUsage[]) {
  const reported = events.filter((event) => event.source === "actual" && typeof event.cacheReadTokens === "number");
  const cacheReadTokens = reported.length ? reported.reduce((sum, event) => sum + event.cacheReadTokens!, 0) : undefined;
  const cacheInputTokens = reported.length ? reported.reduce((sum, event) => sum + (event.promptTokens ?? event.inputTokens), 0) : undefined;
  const writes = events.filter((event) => event.source === "actual" && typeof event.cacheWriteTokens === "number");
  return {
    cacheReadTokens,
    cacheInputTokens,
    cacheWriteTokens: writes.length ? writes.reduce((sum, event) => sum + event.cacheWriteTokens!, 0) : undefined,
    cacheHitPercent: cacheHitPercent(cacheReadTokens, cacheInputTokens),
  };
}
