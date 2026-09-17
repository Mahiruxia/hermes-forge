import { describe, expect, it } from "vitest";
import { aggregateCacheUsage, currentContextTokens, type TokenUsage } from "./token-usage";

const usage = (inputTokens: number, cacheReadTokens?: number, overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  type: "usage", source: "actual", inputTokens, outputTokens: 10, estimatedCostUsd: 0, cacheReadTokens, at: "2026-09-17T00:00:00Z", message: "usage", ...overrides,
});

describe("token usage accounting", () => {
  it("keeps a multi-call bill separate from the current context", () => {
    expect(currentContextTokens({ inputTokens: 800000, outputTokens: 30000, totalTokens: 830000, contextTokens: 12000, contextOutputTokens: 500 })).toBe(12500);
    expect(currentContextTokens({ inputTokens: 800000, outputTokens: 30000, contextTokens: 0, contextOutputTokens: 0 })).toBe(0);
  });

  it("weights cache hits by reported input tokens and excludes estimates/unreported requests", () => {
    const result = aggregateCacheUsage([
      usage(1000, 900, { cacheWriteTokens: 100 }), usage(9000, 900), usage(100000),
      usage(100000, 100000, { source: "estimated" }),
    ]);
    expect(result).toEqual({ cacheReadTokens: 1800, cacheInputTokens: 10000, cacheWriteTokens: 100, cacheHitPercent: 18 });
  });

  it("distinguishes an actual miss from a provider that did not report caching", () => {
    expect(aggregateCacheUsage([usage(1000, 0)]).cacheHitPercent).toBe(0);
    expect(aggregateCacheUsage([usage(1000)]).cacheHitPercent).toBeUndefined();
    expect(aggregateCacheUsage([usage(0, 0)]).cacheHitPercent).toBeUndefined();
  });

  it("uses full prompt totals for older records whose input excludes cached tokens", () => {
    expect(aggregateCacheUsage([usage(100, 900, { promptTokens: 1000 })]).cacheHitPercent).toBe(90);
  });
});
