import type { EngineEvent, EngineRuntimeEnv, RuntimeConfig } from "../shared/types";

export type TaskUsageState = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  inputCostPer1kUsd: number;
  outputCostPer1kUsd: number;
  source: "estimated" | "actual";
};

const FALLBACK_INPUT_COST_PER_1K = 0.002;
const FALLBACK_OUTPUT_COST_PER_1K = 0.006;

export function createTaskUsageState(inputTokens: number, runtimeEnv: EngineRuntimeEnv, config: RuntimeConfig): TaskUsageState {
  const pricing = resolvePricing(runtimeEnv, config);
  return {
    inputTokens,
    outputTokens: 0,
    estimatedCostUsd: 0,
    inputCostPer1kUsd: pricing.inputCostPer1kUsd,
    outputCostPer1kUsd: pricing.outputCostPer1kUsd,
    source: "estimated",
  };
}

export function trackTaskUsage(usage: TaskUsageState | undefined, event: EngineEvent, estimateTokens: (text: string) => number) {
  if (!usage) return;
  if (event.type === "usage" && event.source === "actual") {
    usage.inputTokens = event.inputTokens;
    usage.outputTokens = event.outputTokens;
    usage.estimatedCostUsd = event.estimatedCostUsd;
    usage.source = "actual";
    return;
  }
  if (usage.source === "actual") return;
  if (event.type !== "stdout" && event.type !== "stderr" && event.type !== "result") return;
  const text = event.type === "result" ? `${event.title} ${event.detail}` : event.line;
  usage.outputTokens += estimateTokens(text);
  usage.estimatedCostUsd =
    (usage.inputTokens * usage.inputCostPer1kUsd + usage.outputTokens * usage.outputCostPer1kUsd) / 1000;
}

function resolvePricing(runtimeEnv: EngineRuntimeEnv, config: RuntimeConfig) {
  const providerProfile = config.providerProfiles?.find((profile) => profile.id === runtimeEnv.providerProfileId)
    ?? config.providerProfiles?.find((profile) => profile.provider === runtimeEnv.provider);
  const modelOption = providerProfile?.models.find((model) => model.id === runtimeEnv.model);
  return {
    inputCostPer1kUsd: modelOption?.inputCostPer1kUsd ?? FALLBACK_INPUT_COST_PER_1K,
    outputCostPer1kUsd: modelOption?.outputCostPer1kUsd ?? FALLBACK_OUTPUT_COST_PER_1K,
  };
}
