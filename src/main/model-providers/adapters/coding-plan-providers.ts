import { OpenAiCompatibleProvider } from "../openai-compatible-provider";
import type { ModelSourceDefinition } from "../types";

/**
 * Coding Plan / Token Plan 入口。
 *
 * 这些 provider 一律由 Hermes Agent 内置 handler 接管，Forge 不在保存前做
 * chat / tool-calling 探测。详见 BaseProvider.shouldDelegateToHermesRuntime。
 */
function codingPlanDefinition(input: {
  sourceType: ModelSourceDefinition["sourceType"];
  label: string;
  baseUrl: string;
  modelPlaceholder: string;
  presetModels?: string[];
  keywords: string[];
  description: string;
}): ModelSourceDefinition {
  return {
    sourceType: input.sourceType,
    family: "api_key",
    authMode: "api_key",
    label: input.label,
    provider: "custom",
    baseUrl: input.baseUrl,
    modelPlaceholder: input.modelPlaceholder,
    presetModels: input.presetModels,
    group: "china",
    description: input.description,
    keywords: [...input.keywords, "coding", "plan", "token plan"],
    badge: "Coding Plan",
    roleCapabilities: ["chat", "coding_plan"],
    runtimeCompatibility: "runtime",
  };
}

export class DashScopeCodingProvider extends OpenAiCompatibleProvider {
  constructor() {
    super(codingPlanDefinition({
      sourceType: "dashscope_coding_api_key",
      label: "通义千问 Coding Plan（国际）",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      modelPlaceholder: "qwen3-coder-plus / glm-5 / kimi-k2.5",
      presetModels: [
        "qwen3-coder-plus",
        "qwen3-max-2026-01-23",
        "qwen3-coder-next",
        "qwen3.6-plus",
        "qwen3.5-plus",
        "kimi-k2.5",
        "glm-5",
        "glm-4.7",
        "MiniMax-M2.5",
      ],
      keywords: ["阿里", "通义", "百炼", "qwen", "dashscope", "aliyun"],
      description: "阿里云百炼国际站 Coding Plan 专用 OpenAI-compatible 入口。",
    }), {
      urlPatterns: [/coding-intl\.dashscope\.aliyuncs\.com/i, /coding\.dashscope\.aliyuncs\.com/i],
      modelPatterns: [/^qwen3.*coder/i, /^qwen3-max/i, /^qwen3\.[56]-/i],
    });
  }
}

export class ZhipuCodingProvider extends OpenAiCompatibleProvider {
  constructor() {
    super(codingPlanDefinition({
      sourceType: "zhipu_coding_api_key",
      label: "智谱 GLM Coding Plan（国内）",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      modelPlaceholder: "glm-5 / glm-5.1 / glm-4.7",
      presetModels: [
        "glm-5",
        "glm-5.1",
        "glm-5-turbo",
        "glm-5v-turbo",
        "glm-4.7",
        "glm-4.7-flash",
        "glm-4.7-flashx",
        "glm-4.6",
        "glm-4.6v",
        "glm-4.6v-flash",
        "glm-4.5",
        "glm-4.5-air",
        "glm-4.5v",
        "glm-4.5-flash",
      ],
      keywords: ["智谱", "glm", "zhipu", "bigmodel", "z.ai"],
      description: "智谱 GLM Coding Plan 专用 OpenAI-compatible 入口。",
    }), {
      urlPatterns: [/open\.bigmodel\.cn\/api\/coding\/paas\/v4/i, /api\.z\.ai\/api\/coding\/paas\/v4/i],
      modelPatterns: [/^glm-/i, /^GLM-/],
    });
  }
}

export class BaiduQianfanCodingProvider extends OpenAiCompatibleProvider {
  constructor() {
    super(codingPlanDefinition({
      sourceType: "baidu_qianfan_coding_api_key",
      label: "百度千帆 Coding Plan",
      baseUrl: "https://qianfan.baidubce.com/v2/coding",
      modelPlaceholder: "填写千帆 Coding Plan 模型 ID",
      presetModels: ["deepseek-v3", "deepseek-r1", "ernie-4.5-turbo"],
      keywords: ["百度", "千帆", "qianfan", "baidu"],
      description: "百度千帆 Coding Plan 专用 OpenAI-compatible 入口。",
    }), {
      urlPatterns: [/qianfan\.baidubce\.com\/v2\/coding/i],
      modelPatterns: [/^ernie-/i, /^deepseek-/i],
    });
  }
}

export class TencentTokenPlanProvider extends OpenAiCompatibleProvider {
  constructor() {
    super(codingPlanDefinition({
      sourceType: "tencent_token_plan_api_key",
      label: "腾讯云通用 Coding Plan",
      baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
      modelPlaceholder: "kimi-k2.5 / glm-5 / hunyuan-turbos / minimax-m2.5",
      presetModels: [
        "kimi-k2.5",
        "glm-5",
        "minimax-m2.5",
        "hunyuan-turbos",
        "hunyuan-t1",
        "hunyuan-2.0-thinking",
        "hunyuan-2.0-instruct",
        "tc-code-latest",
      ],
      keywords: ["腾讯云", "tokenhub", "coding plan", "lkeap"],
      description: "腾讯云 Coding Plan（lkeap） OpenAI-compatible 入口。",
    }), {
      urlPatterns: [/api\.lkeap\.cloud\.tencent\.com\/coding\/v3/i, /api\.lkeap\.cloud\.tencent\.com\/plan\/v3/i],
      modelPatterns: [/^glm-/i, /^kimi-/i, /^minimax-/i, /^hunyuan-/i, /^tc-code-/i],
    });
  }
}

export class TencentHunyuanTokenPlanProvider extends OpenAiCompatibleProvider {
  constructor() {
    super(codingPlanDefinition({
      sourceType: "tencent_hunyuan_token_plan_api_key",
      label: "腾讯云 TokenHub（混元）",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
      modelPlaceholder: "hy3-preview / n-2.0-thinking / n-2.0-instruct",
      presetModels: ["hy3-preview", "n-2.0-thinking-202511", "n-2.0-instruct-202511"],
      keywords: ["腾讯云", "混元", "hunyuan", "hy", "tokenhub"],
      description: "腾讯云 TokenHub（混元）OpenAI-compatible 入口。",
    }), {
      urlPatterns: [/tokenhub\.tencentmaas\.com\/v1/i, /tokenhub\.tencentmaas\.com\/plan\/v3/i],
      modelPatterns: [/^hy3-/i, /^n-2\.0-/i, /^hunyuan-/i],
    });
  }
}

export class MiniMaxTokenPlanProvider extends OpenAiCompatibleProvider {
  constructor() {
    super(codingPlanDefinition({
      sourceType: "minimax_token_plan_api_key",
      label: "MiniMax Token Plan（国内）",
      baseUrl: "https://api.minimaxi.com/anthropic",
      modelPlaceholder: "MiniMax-M2.7 / MiniMax-M2.5 / MiniMax-M2",
      presetModels: [
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5",
        "MiniMax-M2.5-highspeed",
        "MiniMax-M2.1",
        "MiniMax-M2",
      ],
      keywords: ["minimax", "m2.7", "m2.5"],
      description: "MiniMax Token Plan Anthropic-compatible 入口，Hermes Agent 运行时由 MiniMax 专用 handler 接管。",
    }), {
      urlPatterns: [/api\.minimaxi\.com\/anthropic/i, /api\.minimaxi\.com\/v1/i, /api\.minimax\.io\/anthropic/i],
      modelPatterns: [/^MiniMax-/i],
    });
  }
}

export class KimiCodingProvider extends OpenAiCompatibleProvider {
  constructor() {
    super(codingPlanDefinition({
      sourceType: "kimi_coding_api_key",
      label: "Kimi Coding Plan",
      baseUrl: "https://api.kimi.com/coding/v1",
      modelPlaceholder: "kimi-for-coding（官方推荐）",
      presetModels: ["kimi-for-coding", "k2p6", "k2p5", "kimi-k2-thinking"],
      keywords: ["kimi", "moonshot", "月之暗面", "kimi-for-coding"],
      description: "Kimi Coding Plan 官方入口。模型名固定为 kimi-for-coding（端点内部自动选择 K2.6/K2.5/Thinking）。配置由 Hermes Agent kimi-coding handler 直接验证，Forge 不做对话探测。",
    }), {
      urlPatterns: [/api\.kimi\.com\/coding\/v1/i],
      modelPatterns: [/^kimi-/i, /^k2p\d/i],
    });
  }
}
