import type {
  ModelCapabilityRole,
  ModelConnectionTestResult,
  ModelHealthCheckStep,
} from "../../shared/types";
import type { ModelPayloadItem, ProviderHealthResultInput } from "./types";

export const MIN_AGENT_CONTEXT = 16_000;

export function step(id: ModelHealthCheckStep["id"], ok: boolean, message: string, detail?: string): ModelHealthCheckStep {
  return { id, label: id, ok, message, detail };
}

export function inferContextWindow(model: string, payload?: ModelPayloadItem[]) {
  const match = payload?.find((item) => item.id === model);
  return match?.context_length ?? match?.context_window;
}

export function classifyAgentRole(input: { contextWindow?: number; supportsTools?: boolean }): ModelCapabilityRole {
  if (!input.supportsTools) return "auxiliary_model";
  if (!input.contextWindow || input.contextWindow < MIN_AGENT_CONTEXT) return "auxiliary_model";
  return "primary_agent";
}

export function success(input: ProviderHealthResultInput & { recommendedFix?: string }): ModelConnectionTestResult {
  return {
    ok: true,
    profileId: input.profile.id,
    message: input.message,
    model: input.profile.model,
    sourceType: input.sourceType,
    providerFamily: input.family,
    authMode: input.authMode,
    normalizedBaseUrl: input.normalizedBaseUrl,
    availableModels: input.availableModels,
    healthChecks: input.steps,
    authResolved: input.authResolved,
    contextWindow: input.contextWindow,
    supportsTools: input.supportsTools,
    agentRole: input.agentRole,
    runtimeCompatibility: input.runtimeCompatibility,
    roleCompatibility: input.roleCompatibility,
    wslReachable: input.wslReachable,
    wslProbeUrl: input.wslProbeUrl,
    recommendedFix: input.recommendedFix,
  };
}

export function failure(input: ProviderHealthResultInput & {
  category: NonNullable<ModelConnectionTestResult["failureCategory"]>;
  fix?: string;
}): ModelConnectionTestResult {
  return {
    ok: false,
    profileId: input.profile.id,
    message: input.message,
    model: input.profile.model,
    sourceType: input.sourceType,
    providerFamily: input.family,
    authMode: input.authMode,
    normalizedBaseUrl: input.normalizedBaseUrl,
    availableModels: input.availableModels,
    healthChecks: input.steps,
    authResolved: input.authResolved,
    contextWindow: input.contextWindow,
    supportsTools: input.supportsTools,
    agentRole: input.agentRole ?? "provider_only",
    runtimeCompatibility: input.runtimeCompatibility,
    roleCompatibility: input.roleCompatibility,
    wslReachable: input.wslReachable,
    wslProbeUrl: input.wslProbeUrl,
    failureCategory: input.category,
    recommendedFix: input.fix,
  };
}
