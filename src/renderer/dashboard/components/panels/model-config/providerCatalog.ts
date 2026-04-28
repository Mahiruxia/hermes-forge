import { Cloud, Code2, Network, PlugZap, Server, Sparkles } from "lucide-react";
import type { ModelSourceDefinition, ModelSourceType } from "../../../../../shared/types";
import type { ProviderGroupId, ProviderPreset } from "./types";

const DEFAULT_TEMPLATE_VALUES: ProviderPreset["templateValues"] = {
  api_key: { label: "API Key", placeholder: "sk-xxxxxxxxxxxxxxxxxxxxxxxx" },
  base_url: { label: "Base URL", placeholder: "https://api.example.com/v1" },
  model: { label: "Model ID", placeholder: "model-id" },
};

const PRESET_SETTINGS_CONFIG: Partial<Record<ModelSourceType, ProviderPreset["settingsConfig"]>> = {
  openai_compatible: {
    env: {
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "${base_url}",
      AI_BASE_URL: "${base_url}",
    },
  },
  openrouter_api_key: {
    env: {
      OPENROUTER_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "openrouter",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      AI_BASE_URL: "https://openrouter.ai/api/v1",
    },
  },
  anthropic_api_key: {
    env: {
      ANTHROPIC_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "anthropic",
      ANTHROPIC_BASE_URL: "${base_url}",
    },
  },
  gemini_api_key: {
    env: {
      GOOGLE_API_KEY: "${api_key}",
      GEMINI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "gemini",
    },
  },
  deepseek_api_key: {
    env: {
      DEEPSEEK_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "deepseek",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      AI_BASE_URL: "https://api.deepseek.com/v1",
    },
  },
  huggingface_api_key: {
    env: {
      HF_TOKEN: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "huggingface",
      OPENAI_BASE_URL: "https://router.huggingface.co/v1",
      AI_BASE_URL: "https://router.huggingface.co/v1",
    },
  },
  dashscope_api_key: {
    env: {
      DASHSCOPE_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      AI_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
  },
  zhipu_api_key: {
    env: {
      ZHIPU_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
      AI_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
    },
  },
  moonshot_api_key: {
    env: {
      MOONSHOT_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "https://api.moonshot.cn/v1",
      AI_BASE_URL: "https://api.moonshot.cn/v1",
    },
  },
  spark_api_key: {
    env: {
      SPARK_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "https://spark-api-open.xf-yun.com/v1",
      AI_BASE_URL: "https://spark-api-open.xf-yun.com/v1",
    },
  },
  baichuan_api_key: {
    env: {
      BAICHUAN_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "https://api.baichuan-ai.com/v1",
      AI_BASE_URL: "https://api.baichuan-ai.com/v1",
    },
  },
  minimax_api_key: {
    env: {
      MINIMAX_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      MINIMAX_BASE_URL: "https://api.minimax.chat/v1",
      OPENAI_BASE_URL: "https://api.minimax.chat/v1",
      AI_BASE_URL: "https://api.minimax.chat/v1",
    },
  },
  yi_api_key: {
    env: {
      YI_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "https://api.lingyiwanwu.com/v1",
      AI_BASE_URL: "https://api.lingyiwanwu.com/v1",
    },
  },
  hunyuan_api_key: {
    env: {
      HUNYUAN_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "https://api.hunyuan.cloud.tencent.com/v1",
      AI_BASE_URL: "https://api.hunyuan.cloud.tencent.com/v1",
    },
  },
  siliconflow_api_key: {
    env: {
      SILICONFLOW_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "https://api.siliconflow.cn/v1",
      AI_BASE_URL: "https://api.siliconflow.cn/v1",
    },
  },
  volcengine_ark_api_key: {
    env: {
      VOLCENGINE_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3",
      AI_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3",
    },
  },
  volcengine_coding_api_key: {
    env: {
      VOLCENGINE_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      VOLCENGINE_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3",
      OPENAI_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3",
      AI_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3",
    },
  },
  dashscope_coding_api_key: {
    env: {
      DASHSCOPE_API_KEY: "${api_key}",
      ALIBABA_CODING_PLAN_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      DASHSCOPE_BASE_URL: "https://coding-intl.dashscope.aliyuncs.com/v1",
      OPENAI_BASE_URL: "https://coding-intl.dashscope.aliyuncs.com/v1",
      AI_BASE_URL: "https://coding-intl.dashscope.aliyuncs.com/v1",
    },
  },
  zhipu_coding_api_key: {
    env: {
      GLM_API_KEY: "${api_key}",
      ZAI_API_KEY: "${api_key}",
      ZHIPU_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      GLM_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4",
      OPENAI_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4",
      AI_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4",
    },
  },
  baidu_qianfan_coding_api_key: {
    env: {
      QIANFAN_API_KEY: "${api_key}",
      BAIDU_QIANFAN_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      QIANFAN_BASE_URL: "https://qianfan.baidubce.com/v2/coding",
      OPENAI_BASE_URL: "https://qianfan.baidubce.com/v2/coding",
      AI_BASE_URL: "https://qianfan.baidubce.com/v2/coding",
    },
  },
  tencent_token_plan_api_key: {
    env: {
      TENCENT_API_KEY: "${api_key}",
      TENCENT_CODING_PLAN_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      TENCENT_BASE_URL: "https://api.lkeap.cloud.tencent.com/coding/v3",
      OPENAI_BASE_URL: "https://api.lkeap.cloud.tencent.com/coding/v3",
      AI_BASE_URL: "https://api.lkeap.cloud.tencent.com/coding/v3",
    },
  },
  tencent_hunyuan_token_plan_api_key: {
    env: {
      TENCENT_HY_API_KEY: "${api_key}",
      TENCENT_TOKENHUB_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      TENCENT_HY_BASE_URL: "https://tokenhub.tencentmaas.com/v1",
      OPENAI_BASE_URL: "https://tokenhub.tencentmaas.com/v1",
      AI_BASE_URL: "https://tokenhub.tencentmaas.com/v1",
    },
  },
  minimax_token_plan_api_key: {
    env: {
      MINIMAX_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/anthropic/v1",
      OPENAI_BASE_URL: "https://api.minimaxi.com/anthropic/v1",
      AI_BASE_URL: "https://api.minimaxi.com/anthropic/v1",
    },
  },
  kimi_coding_api_key: {
    env: {
      KIMI_API_KEY: "${api_key}",
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      KIMI_BASE_URL: "https://api.kimi.com/coding/v1",
      OPENAI_BASE_URL: "https://api.kimi.com/coding/v1",
      AI_BASE_URL: "https://api.kimi.com/coding/v1",
    },
  },
  gemini_oauth: {
    env: {
      GOOGLE_API_KEY: "${api_key}",
      GEMINI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "gemini",
    },
  },
  anthropic_local_credentials: {
    env: {
      ANTHROPIC_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "anthropic",
    },
  },
  github_copilot: {
    env: {
      COPILOT_GITHUB_TOKEN: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "copilot",
      OPENAI_BASE_URL: "https://models.github.ai/inference/v1",
      AI_BASE_URL: "https://models.github.ai/inference/v1",
    },
  },
  github_copilot_acp: {
    env: {
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "copilot-acp",
    },
  },
  ollama: {
    env: {
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      AI_BASE_URL: "http://127.0.0.1:11434/v1",
    },
  },
  vllm: {
    env: {
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      AI_BASE_URL: "http://127.0.0.1:8000/v1",
    },
  },
  sglang: {
    env: {
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "http://127.0.0.1:30000/v1",
      AI_BASE_URL: "http://127.0.0.1:30000/v1",
    },
  },
  lm_studio: {
    env: {
      OPENAI_API_KEY: "${api_key}",
      AI_API_KEY: "${api_key}",
      AI_PROVIDER: "custom",
      OPENAI_BASE_URL: "http://127.0.0.1:1234/v1",
      AI_BASE_URL: "http://127.0.0.1:1234/v1",
    },
  },
  baidu_wenxin_api_key: {
    env: {
      HERMES_FORGE_BAIDU_CREDENTIAL: "${api_key}",
      AI_API_KEY: "hermes-forge-local-proxy-key",
      OPENAI_API_KEY: "hermes-forge-local-proxy-key",
      AI_PROVIDER: "custom",
    },
  },
};

function provider(
  id: ModelSourceType,
  label: string,
  group: ProviderGroupId,
  authHint: string,
  baseUrl?: string,
  defaultModel?: string,
  modelPlaceholder?: string,
  keyMode?: "required" | "optional",
  icon?: ProviderPreset["icon"],
  description?: string,
  keywords?: string[],
  badge?: string,
  authModeToStore?: ProviderPreset["authModeToStore"],
  modelOptions?: string[],
  roleCapabilities?: ProviderPreset["roleCapabilities"],
): ProviderPreset {
  return {
    id,
    label,
    group,
    authHint,
    baseUrl,
    defaultModel,
    modelPlaceholder: modelPlaceholder ?? "填写模型 ID",
    keyMode: keyMode ?? "required",
    icon: icon ?? Cloud,
    description: description ?? "",
    keywords: keywords ?? [],
    badge,
    authModeToStore: authModeToStore ?? "api_key",
    roleCapabilities: roleCapabilities ?? ["chat"],
    runtimeCompatibility: "runtime",
    modelOptions,
    settingsConfig: PRESET_SETTINGS_CONFIG[id],
    templateValues: keyMode === "optional" ? undefined : DEFAULT_TEMPLATE_VALUES,
  };
}

export const PROVIDERS: ProviderPreset[] = [
  provider("openai_compatible", "OpenAI-compatible", "recommended", "兼容 /v1/chat/completions", "http://127.0.0.1:8080/v1", undefined, "填写兼容网关模型 ID", "optional", PlugZap, "适合各类 OpenAI 兼容网关", ["openai", "compatible", "custom", "gateway"], "推荐", "optional_api_key"),
  provider("openrouter_api_key", "OpenRouter", "international", "需要 API Key", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4-5", "选择或填写 OpenRouter 模型 ID", "required", Network, "统一接入多个云模型", ["openrouter", "router"], undefined, "api_key", ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "google/gemini-2.5-pro"]),
  provider("anthropic_api_key", "Anthropic", "international", "需要 API Key", "https://api.anthropic.com", "claude-sonnet-4-5", "选择或填写 Claude 模型 ID", "required", Cloud, "Anthropic 官方 API", ["anthropic", "claude"], undefined, "api_key", ["claude-sonnet-4-5", "claude-opus-4"]),
  provider("gemini_api_key", "Gemini", "international", "需要 API Key", "https://generativelanguage.googleapis.com/v1beta", "gemini-2.5-pro", "选择或填写 Gemini 模型 ID", "required", Cloud, "Google AI Studio / Gemini API", ["gemini", "google"], undefined, "api_key", ["gemini-2.5-pro", "gemini-2.5-flash"]),
  provider("deepseek_api_key", "DeepSeek", "china", "需要 API Key", "https://api.deepseek.com/v1", "deepseek-v4-pro", "选择或填写 DeepSeek 模型 ID", "required", Network, "DeepSeek 官方 API", ["deepseek", "深度求索"], undefined, "api_key", ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"]),
  provider("huggingface_api_key", "Hugging Face", "international", "需要 HF_TOKEN", "https://router.huggingface.co/v1", undefined, "填写 Hugging Face 模型 ID", "required", Cloud, "Hugging Face Router", ["huggingface", "hf"], undefined, "api_key"),
  provider("dashscope_api_key", "通义千问 DashScope", "china", "需要 API Key", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", "选择或填写 qwen 模型 ID", "required", Sparkles, "阿里云 DashScope OpenAI 兼容模式", ["通义", "qwen", "dashscope", "aliyun"], undefined, "api_key", ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"]),
  provider("zhipu_api_key", "智谱 AI GLM", "china", "需要 API Key", "https://open.bigmodel.cn/api/paas/v4", "glm-4-plus", "选择或填写 GLM 模型 ID", "required", Sparkles, "智谱 OpenAI 兼容接口", ["智谱", "glm", "bigmodel"], undefined, "api_key", ["glm-4-plus", "glm-4", "glm-4-flash"]),
  provider("moonshot_api_key", "Kimi / Moonshot", "china", "需要 API Key", "https://api.moonshot.cn/v1", "moonshot-v1-128k", "选择或填写 Moonshot 模型 ID", "required", Sparkles, "月之暗面 OpenAI 兼容接口", ["kimi", "moonshot", "月之暗面"], undefined, "api_key", ["moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"]),
  provider("baidu_wenxin_api_key", "百度文心一言", "china", "需要 API Key + Secret Key", "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat", "ernie-4.0-8k", "选择或填写 ERNIE 模型 ID", "required", Cloud, "百度千帆 非 OpenAI 兼容格式", ["百度", "文心", "ernie", "qianfan"], undefined, "api_key", ["ernie-4.0-8k", "ernie-4.0-turbo-8k", "ernie-speed-128k"]),
  provider("spark_api_key", "讯飞星火 Spark", "china", "需要 APIPassword", "https://spark-api-open.xf-yun.com/v1", "generalv3.5", "选择或填写星火模型 ID", "required", Sparkles, "讯飞星火 OpenAI 兼容接口", ["讯飞", "星火", "spark", "xunfei"], undefined, "api_key", ["generalv3.5", "generalv3", "4.0Ultra"]),
  provider("baichuan_api_key", "百川智能", "china", "需要 API Key", "https://api.baichuan-ai.com/v1", "Baichuan4", "选择或填写百川模型 ID", "required", Cloud, "百川 OpenAI 兼容接口", ["百川", "baichuan"], undefined, "api_key", ["Baichuan4", "Baichuan3-Turbo", "Baichuan3-Turbo-128k"]),
  provider("minimax_api_key", "MiniMax", "china", "需要 API Key", "https://api.minimax.chat/v1", "abab7", "选择或填写 MiniMax 模型 ID", "required", Network, "MiniMax OpenAI 兼容接口", ["minimax", "abab"], undefined, "api_key", ["abab7", "abab6.5s-chat"]),
  provider("yi_api_key", "零一万物 Yi", "china", "需要 API Key", "https://api.lingyiwanwu.com/v1", "yi-large", "选择或填写 Yi 模型 ID", "required", Cloud, "零一万物 OpenAI 兼容接口", ["零一", "yi", "lingyiwanwu"], undefined, "api_key", ["yi-large", "yi-medium", "yi-spark", "yi-lightning"]),
  provider("hunyuan_api_key", "腾讯混元", "china", "需要 API Key", "https://api.hunyuan.cloud.tencent.com/v1", undefined, "填写混元模型 ID", "required", Cloud, "腾讯混元 OpenAI 兼容接口", ["混元", "hunyuan", "tencent"], undefined, "api_key"),
  provider("siliconflow_api_key", "SiliconFlow", "china", "需要 API Key", "https://api.siliconflow.cn/v1", undefined, "填写 SiliconFlow 模型 ID", "required", Cloud, "SiliconFlow 统一 API", ["siliconflow"], undefined, "api_key"),
  provider("volcengine_ark_api_key", "火山引擎 Ark", "china", "需要 API Key", "https://ark.cn-beijing.volces.com/api/v3", undefined, "填写火山 endpoint ID", "required", Cloud, "火山引擎豆包 Ark 推理", ["火山", "volcengine", "ark", "豆包"], undefined, "api_key"),
  provider("volcengine_coding_api_key", "火山引擎方舟 Coding Plan", "china", "需要 API Key", "https://ark.cn-beijing.volces.com/api/coding/v3", undefined, "填写火山 Coding endpoint ID", "required", Code2, "火山引擎 Coding Plan 专用接口", ["火山", "volcengine", "coding"], "Coding Plan", "api_key", undefined, ["coding_plan"]),
  provider("dashscope_coding_api_key", "通义千问 Coding Plan", "china", "需要 API Key", "https://coding-intl.dashscope.aliyuncs.com/v1", "qwen3-coder-plus", "选择或填写 DashScope Coding 模型 ID", "required", Code2, "阿里云百炼 Coding Plan 专用接口", ["通义", "dashscope", "coding", "qwen"], "Coding Plan", "api_key", ["qwen3-coder-plus", "qwen3-max-2026-01-23", "qwen3-coder-next", "qwen3.6-plus", "qwen3.5-plus", "kimi-k2.5", "glm-5", "glm-4.7", "MiniMax-M2.5"], ["coding_plan"]),
  provider("zhipu_coding_api_key", "智谱 GLM Coding Plan", "china", "需要 API Key", "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5", "选择或填写智谱 Coding 模型 ID", "required", Code2, "智谱 GLM Coding Plan 专用接口", ["智谱", "glm", "coding", "zhipu"], "Coding Plan", "api_key", ["glm-5", "glm-5.1", "glm-5-turbo", "glm-4.7", "glm-4.7-flash", "glm-4.6", "glm-4.5", "glm-4.5-air"], ["coding_plan"]),
  provider("baidu_qianfan_coding_api_key", "百度千帆 Coding Plan", "china", "需要 API Key", "https://qianfan.baidubce.com/v2/coding", undefined, "填写千帆 Coding 模型 ID", "required", Code2, "百度千帆 Coding Plan 专用接口", ["百度", "qianfan", "coding"], "Coding Plan", "api_key", undefined, ["coding_plan"]),
  provider("tencent_token_plan_api_key", "腾讯云通用 Coding Plan", "china", "需要 API Key", "https://api.lkeap.cloud.tencent.com/coding/v3", "kimi-k2.5", "选择或填写腾讯云 Coding Plan 模型 ID", "required", Code2, "腾讯云通用 Coding Plan（lkeap）接口", ["腾讯", "tencent", "coding plan", "lkeap"], "Coding Plan", "api_key", ["kimi-k2.5", "glm-5", "minimax-m2.5", "hunyuan-turbos", "hunyuan-t1", "hunyuan-2.0-thinking", "hunyuan-2.0-instruct", "tc-code-latest"], ["coding_plan"]),
  provider("tencent_hunyuan_token_plan_api_key", "腾讯云 TokenHub（混元）", "china", "需要 API Key", "https://tokenhub.tencentmaas.com/v1", "hy3-preview", "选择或填写腾讯 TokenHub 模型 ID", "required", Code2, "腾讯云混元 TokenHub 接口", ["腾讯", "hunyuan", "tokenhub", "token-plan"], "Coding Plan", "api_key", ["hy3-preview", "n-2.0-thinking-202511", "n-2.0-instruct-202511"], ["coding_plan"]),
  provider("minimax_token_plan_api_key", "MiniMax Token Plan", "china", "需要 API Key", "https://api.minimaxi.com/anthropic/v1", "MiniMax-M2.7", "选择或填写 MiniMax Token Plan 模型 ID", "required", Code2, "MiniMax Token Plan（国内）接口", ["minimax", "token-plan"], "Coding Plan", "api_key", ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2"], ["coding_plan"]),
  provider("kimi_coding_api_key", "Kimi Coding Plan", "china", "需要 API Key", "https://api.kimi.com/coding/v1", "kimi-for-coding", "选择或填写 Kimi Coding 模型 ID", "required", Code2, "Kimi Coding Plan 官方专用接口（model 固定 kimi-for-coding）", ["kimi", "coding", "moonshot", "kimi-for-coding"], "Coding Plan", "api_key", ["kimi-for-coding", "k2p6", "k2p5", "kimi-k2-thinking"], ["coding_plan"]),
  provider("github_copilot", "GitHub Copilot", "international", "需要 Copilot Token", "https://models.github.ai/inference/v1", undefined, "填写 Copilot 模型 ID", "required", Cloud, "GitHub Copilot AI 模型", ["github", "copilot"], undefined, "external_process"),
  provider("github_copilot_acp", "GitHub Copilot ACP", "international", "需要 ACP Token", undefined, undefined, "填写 ACP 模型 ID", "required", Cloud, "GitHub Copilot ACP 模式", ["github", "copilot-acp"], undefined, "external_process"),
  provider("gemini_oauth", "Gemini (OAuth)", "international", "需要 OAuth 授权", undefined, undefined, "填写 Gemini 模型 ID", "required", Cloud, "Gemini OAuth 登录模式", ["gemini", "google", "oauth"], undefined, "oauth"),
  provider("anthropic_local_credentials", "Anthropic (Local)", "international", "需要本地凭证", undefined, undefined, "填写 Claude 模型 ID", "required", Cloud, "Anthropic 本地凭证模式", ["anthropic", "claude", "local"], undefined, "local_credentials"),
  provider("ollama", "Ollama", "local", "本地运行，无需 Key", "http://127.0.0.1:11434/v1", undefined, "填写 Ollama 模型 ID", "optional", Server, "本地 Ollama 服务", ["ollama", "local"], undefined, "optional_api_key"),
  provider("vllm", "vLLM", "local", "本地运行，无需 Key", "http://127.0.0.1:8000/v1", undefined, "填写 vLLM 模型 ID", "optional", Server, "本地 vLLM 推理服务", ["vllm", "local"], undefined, "optional_api_key"),
  provider("sglang", "SGLang", "local", "本地运行，无需 Key", "http://127.0.0.1:30000/v1", undefined, "填写 SGLang 模型 ID", "optional", Server, "本地 SGLang 推理服务", ["sglang", "local"], undefined, "optional_api_key"),
  provider("lm_studio", "LM Studio", "local", "本地运行，无需 Key", "http://127.0.0.1:1234/v1", undefined, "填写 LM Studio 模型 ID", "optional", Server, "本地 LM Studio 服务", ["lm-studio", "local"], undefined, "optional_api_key"),
];

export function providerFor(sourceType: ModelSourceType): ProviderPreset {
  return providerForCatalog(sourceType, PROVIDERS);
}

export function providerForCatalog(sourceType: ModelSourceType, catalog: ProviderPreset[]): ProviderPreset {
  return catalog.find((item) => item.id === sourceType) ?? PROVIDERS[0];
}

export function providerPresetsForDefinitions(definitions: ModelSourceDefinition[] | undefined): ProviderPreset[] {
  if (!definitions?.length) return PROVIDERS;
  const mapped = definitions.map((def) => {
    const preset = PROVIDERS.find((p) => p.id === def.sourceType);
    return {
      id: def.sourceType,
      label: def.label,
      group: def.group ?? preset?.group ?? "international",
      authHint: preset?.authHint ?? "需要 API Key",
      baseUrl: def.baseUrl,
      defaultModel: def.presetModels?.[0],
      modelPlaceholder: def.modelPlaceholder,
      keyMode: def.keyOptional ? "optional" : "required",
      icon: preset?.icon ?? Cloud,
      description: def.description ?? preset?.description ?? "",
      keywords: def.keywords ?? preset?.keywords ?? [],
      badge: def.badge ?? preset?.badge,
      authModeToStore: def.authMode,
      roleCapabilities: def.roleCapabilities ?? preset?.roleCapabilities ?? ["chat"],
      runtimeCompatibility: def.runtimeCompatibility ?? preset?.runtimeCompatibility ?? "runtime",
      settingsConfig: PRESET_SETTINGS_CONFIG[def.sourceType],
      templateValues: def.keyOptional ? undefined : DEFAULT_TEMPLATE_VALUES,
    } satisfies ProviderPreset;
  });
  const existingIds = new Set(mapped.map((item) => item.id));
  return [...mapped, ...PROVIDERS.filter((item) => !existingIds.has(item.id))];
}
