import type { ModelCapabilityRole, ModelConnectionTestResult, ModelSourceType } from "../../../../../shared/types";
import type { DraftState, OverviewModels, ProviderPreset, SecretMeta } from "./types";
import { providerFor, providerForCatalog, providerPresetsForDefinitions } from "./providerCatalog";

export const DEFAULT_MAX_CONTEXT = 256_000;
export const MIN_AGENT_CONTEXT = 16_000;

export function inferSourceType(provider: string, baseUrl?: string): ModelSourceType {
  if (provider === "openrouter") return "openrouter_api_key";
  if (provider === "anthropic") return "anthropic_api_key";
  if (provider === "gemini") return "gemini_api_key";
  if (provider === "deepseek") return "deepseek_api_key";
  if (provider === "huggingface") return "huggingface_api_key";
  if (provider === "copilot") return "github_copilot";
  if (provider === "copilot_acp") return "github_copilot_acp";
  if (provider === "custom") {
    const text = (baseUrl ?? "").toLowerCase();
    if (text.includes("coding-intl.dashscope.aliyuncs.com") || text.includes("coding.dashscope.aliyuncs.com")) return "dashscope_coding_api_key";
    if (text.includes("dashscope.aliyuncs.com")) return "dashscope_api_key";
    if (text.includes("open.bigmodel.cn/api/coding/paas/v4") || text.includes("api.z.ai/api/coding/paas/v4")) return "zhipu_coding_api_key";
    if (text.includes("bigmodel.cn") || text.includes("api.z.ai")) return "zhipu_api_key";
    if (text.includes("api.kimi.com/coding/v1")) return "kimi_coding_api_key";
    if (text.includes("moonshot.cn")) return "moonshot_api_key";
    if (text.includes("qianfan.baidubce.com/v2/coding")) return "baidu_qianfan_coding_api_key";
    if (text.includes("aip.baidubce.com")) return "baidu_wenxin_api_key";
    if (text.includes("spark-api-open.xf-yun.com")) return "spark_api_key";
    if (text.includes("baichuan-ai.com")) return "baichuan_api_key";
    if (text.includes("api.minimaxi.com/anthropic") || text.includes("api.minimax.io/anthropic") || text.includes("api.minimaxi.com/v1")) return "minimax_token_plan_api_key";
    if (text.includes("minimax.chat")) return "minimax_api_key";
    if (text.includes("lingyiwanwu.com")) return "yi_api_key";
    if (text.includes("api.lkeap.cloud.tencent.com/coding/v3") || text.includes("api.lkeap.cloud.tencent.com/plan/v3")) return "tencent_token_plan_api_key";
    if (text.includes("tokenhub.tencentmaas.com")) return "tencent_hunyuan_token_plan_api_key";
    if (text.includes("hunyuan.cloud.tencent.com")) return "hunyuan_api_key";
    if (text.includes("siliconflow.cn")) return "siliconflow_api_key";
    if (text.includes("ark.cn-beijing.volces.com/api/coding")) return "volcengine_coding_api_key";
    if (text.includes("ark.cn-beijing.volces.com")) return "volcengine_ark_api_key";
    if (text.includes(":11434")) return "ollama";
    if (text.includes(":1234")) return "lm_studio";
    if (text.includes(":8000")) return "vllm";
    if (text.includes(":30000")) return "sglang";
  }
  return "openai_compatible";
}

export function defaultSecretRefForSource(sourceType: ModelSourceType) {
  switch (sourceType) {
    case "openrouter_api_key": return "provider.openrouter.apiKey";
    case "anthropic_api_key": return "provider.anthropic.apiKey";
    case "gemini_api_key": return "provider.gemini.apiKey";
    case "deepseek_api_key": return "provider.deepseek.apiKey";
    case "huggingface_api_key": return "provider.huggingface.apiKey";
    case "dashscope_api_key": return "provider.dashscope.apiKey";
    case "baidu_wenxin_api_key": return "provider.baidu-wenxin.apiKeySecret";
    case "zhipu_api_key": return "provider.zhipu.apiKey";
    case "spark_api_key": return "provider.spark.apiPassword";
    case "moonshot_api_key": return "provider.moonshot.apiKey";
    case "baichuan_api_key": return "provider.baichuan.apiKey";
    case "minimax_api_key": return "provider.minimax.apiKey";
    case "yi_api_key": return "provider.yi.apiKey";
    case "hunyuan_api_key": return "provider.hunyuan.apiKey";
    case "siliconflow_api_key": return "provider.siliconflow.apiKey";
    case "volcengine_ark_api_key": return "provider.volcengine-ark.apiKey";
    case "volcengine_coding_api_key": return "provider.volcengine-coding.apiKey";
    case "dashscope_coding_api_key": return "provider.dashscope-coding.apiKey";
    case "zhipu_coding_api_key": return "provider.zhipu-coding.apiKey";
    case "baidu_qianfan_coding_api_key": return "provider.baidu-qianfan-coding.apiKey";
    case "tencent_token_plan_api_key": return "provider.tencent-token-plan.apiKey";
    case "tencent_hunyuan_token_plan_api_key": return "provider.tencent-hy-token-plan.apiKey";
    case "minimax_token_plan_api_key": return "provider.minimax-token-plan.apiKey";
    case "kimi_coding_api_key": return "provider.kimi-coding.apiKey";
    case "github_copilot": return "provider.copilot.token";
    case "github_copilot_acp": return "provider.copilot-acp.token";
    case "gemini_oauth": return "provider.gemini.oauth";
    case "anthropic_local_credentials": return "provider.anthropic.local";
    case "ollama": return "provider.ollama.apiKey";
    case "vllm": return "provider.vllm.apiKey";
    case "sglang": return "provider.sglang.apiKey";
    case "lm_studio": return "provider.lmstudio.apiKey";
    default: return "provider.custom.apiKey";
  }
}

export function providerIdForSource(sourceType: ModelSourceType) {
  switch (sourceType) {
    case "openrouter_api_key": return "openrouter" as const;
    case "anthropic_api_key":
    case "anthropic_local_credentials": return "anthropic" as const;
    case "gemini_api_key":
    case "gemini_oauth": return "gemini" as const;
    case "deepseek_api_key": return "deepseek" as const;
    case "huggingface_api_key": return "huggingface" as const;
    case "github_copilot": return "copilot" as const;
    case "github_copilot_acp": return "copilot_acp" as const;
    default: return "custom" as const;
  }
}

export function sourceNeedsKey(sourceType: ModelSourceType, catalog?: ProviderPreset[]) {
  return (catalog ? providerForCatalog(sourceType, catalog) : providerFor(sourceType)).keyMode === "required";
}

export function draftStateForNewProfile(sourceType: ModelSourceType, catalog?: ProviderPreset[]): DraftState {
  const preset = catalog ? providerForCatalog(sourceType, catalog) : providerFor(sourceType);
  return {
    sourceType,
    baseUrl: preset.baseUrl ?? "",
    model: preset.defaultModel ?? "",
    secretRef: defaultSecretRefForSource(sourceType),
  };
}

export function draftStateForProfile(models: OverviewModels, profileId?: string, catalog = providerPresetsForDefinitions(models.providers)): DraftState {
  const current = profileId ? models.modelProfiles.find((item) => item.id === profileId) : undefined;
  if (!current) return draftStateForNewProfile("openai_compatible", catalog);
  const sourceType = current.sourceType ?? inferSourceType(current.provider, current.baseUrl);
  return {
    sourceType,
    baseUrl: current.baseUrl ?? providerForCatalog(sourceType, catalog).baseUrl ?? "",
    model: current.model ?? "",
    secretRef: current.secretRef ?? defaultSecretRefForSource(sourceType),
  };
}

export function friendlyProfileName(sourceType: ModelSourceType, model: string, catalog?: ProviderPreset[]) {
  const provider = catalog ? providerForCatalog(sourceType, catalog) : providerFor(sourceType);
  return model ? `${provider.label} · ${model}` : provider.label;
}

export function roleLabel(role: ModelCapabilityRole, sourceType?: ModelSourceType) {
  if (role === "primary_agent" && isCodingPlanSourceType(sourceType)) return "可作 Coding Plan 主模型（运行时验证）";
  if (role === "primary_agent") return "可作主模型";
  if (role === "auxiliary_model") return "辅助模型";
  return "仅接入 provider";
}

export function isCodingPlanSourceType(sourceType?: ModelSourceType) {
  if (!sourceType) return false;
  return [
    "volcengine_coding_api_key",
    "dashscope_coding_api_key",
    "zhipu_coding_api_key",
    "baidu_qianfan_coding_api_key",
    "tencent_token_plan_api_key",
    "tencent_hunyuan_token_plan_api_key",
    "minimax_token_plan_api_key",
    "kimi_coding_api_key",
  ].includes(sourceType);
}

export function healthStepLabel(stepId: NonNullable<ModelConnectionTestResult["healthChecks"]>[number]["id"]) {
  if (stepId === "auth") return "鉴权";
  if (stepId === "models") return "模型列表";
  if (stepId === "chat") return "对话测试";
  if (stepId === "agent_capability") return "Agent 能力评估";
  if (stepId === "runtime") return "运行环境";
  if (stepId === "wsl_network") return "WSL 网络连通";
  return stepId;
}

export function getSourceStatus(models: OverviewModels, secrets: SecretMeta[], sourceType: ModelSourceType, catalog = providerPresetsForDefinitions(models.providers)) {
  const current = models.modelProfiles.find((item) => (item.sourceType ?? inferSourceType(item.provider, item.baseUrl)) === sourceType);
  const isDefault = current?.id === models.defaultProfileId;
  if (!current) return { label: "未配置", tone: "muted" as const, isDefault };
  const secretReady = !sourceNeedsKey(sourceType, catalog) || secrets.some((item) => item.ref === (current.secretRef || defaultSecretRefForSource(sourceType)) && item.exists);
  if (!current.model?.trim()) return { label: "缺模型", tone: "warning" as const, isDefault };
  if (!secretReady) return { label: "缺 Key", tone: "warning" as const, isDefault };
  if (current.lastHealthStatus === "failed") return { label: "异常", tone: "error" as const, isDefault };
  if (current.lastHealthStatus === "warning" || (current.agentRole && current.agentRole !== "primary_agent")) return { label: "警告", tone: "warning" as const, isDefault };
  return { label: "已配置", tone: "success" as const, isDefault };
}

export function sameModelIdentity(existing: Pick<OverviewModels["modelProfiles"][number], "provider" | "model" | "baseUrl"> | undefined, next: { provider: ReturnType<typeof providerIdForSource>; model: string; baseUrl?: string }) {
  if (!existing) return false;
  return existing.provider === next.provider &&
    existing.model.trim() === next.model.trim() &&
    normalizeIdentityBaseUrl(existing.baseUrl) === normalizeIdentityBaseUrl(next.baseUrl);
}

function normalizeIdentityBaseUrl(value?: string) {
  return value?.trim().replace(/\/$/, "") ?? "";
}
