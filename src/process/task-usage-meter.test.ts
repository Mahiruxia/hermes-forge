import { describe, expect, it } from "vitest";
import { createTaskUsageState, trackTaskUsage } from "./task-usage-meter";
import type { EngineRuntimeEnv, RuntimeConfig } from "../shared/types";

describe("task usage meter", () => {
  it("uses model option pricing when available", () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "default",
      modelProfiles: [{ id: "default", provider: "openai", model: "gpt-5.4" }],
      providerProfiles: [{
        id: "openai-default",
        provider: "openai",
        label: "OpenAI",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", inputCostPer1kUsd: 1, outputCostPer1kUsd: 2 }],
        status: "ready",
      }],
      updateSources: {},
    };
    const runtimeEnv: EngineRuntimeEnv = {
      profileId: "default",
      provider: "openai",
      providerProfileId: "openai-default",
      model: "gpt-5.4",
      env: {},
    };

    const usage = createTaskUsageState(1000, runtimeEnv, config);
    trackTaskUsage(usage, { type: "stdout", line: "abcd", at: new Date().toISOString() }, () => 1000);
    expect(usage.estimatedCostUsd).toBe(3);
  });

  it("falls back to default pricing when model pricing is missing", () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "default",
      modelProfiles: [{ id: "default", provider: "openai", model: "gpt-5.4" }],
      updateSources: {},
    };
    const runtimeEnv: EngineRuntimeEnv = {
      profileId: "default",
      provider: "openai",
      model: "gpt-5.4",
      env: {},
    };

    const usage = createTaskUsageState(1000, runtimeEnv, config);
    trackTaskUsage(usage, { type: "stdout", line: "abcd", at: new Date().toISOString() }, () => 1000);
    expect(usage.estimatedCostUsd).toBeCloseTo(0.008);
  });
});
