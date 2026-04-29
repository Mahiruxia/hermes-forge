import { OpenAiCompatibleProvider } from "../openai-compatible-provider";
import type { ModelListResult, ModelPayloadItem, ModelSourceDefinition, ProviderTestContext } from "../types";

const mimoModels: ModelPayloadItem[] = [
  { id: "mimo-v2.5-pro", context_window: 1_048_576 },
  { id: "mimo-v2.5", context_window: 1_048_576 },
  { id: "mimo-v2.5-flash", context_window: 262_144 },
];

const commonModels = mimoModels.map((item) => item.id).filter((item): item is string => Boolean(item));

const apiDefinition: ModelSourceDefinition = {
  sourceType: "mimo_api_key",
  family: "api_key",
  authMode: "api_key",
  label: "MiMo API（按量付费）",
  provider: "custom",
  baseUrl: "https://api.xiaomimimo.com/v1",
  modelPlaceholder: "mimo-v2.5-pro / mimo-v2.5 / mimo-v2.5-flash",
  presetModels: commonModels,
  group: "china",
  keywords: ["mimo", "xiaomi", "小米", "mimo-v2.5-pro", "pay as you go"],
  description: "小米 MiMo V2.5 按量付费 API，OpenAI-compatible 入口。",
  roleCapabilities: ["chat"],
  runtimeCompatibility: "proxy",
};

const tokenPlanDefinition: ModelSourceDefinition = {
  sourceType: "mimo_token_plan_api_key",
  family: "api_key",
  authMode: "api_key",
  label: "MiMo Token Plan（中国区）",
  provider: "custom",
  baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
  modelPlaceholder: "mimo-v2.5-pro / mimo-v2.5 / mimo-v2.5-flash",
  presetModels: commonModels,
  group: "china",
  keywords: ["mimo", "xiaomi", "小米", "mimo-v2.5-pro", "token plan"],
  description: "小米 MiMo V2.5 Token Plan 中国区 OpenAI-compatible 入口。新加坡/欧洲订阅可把 Base URL 改成控制台显示的专属端点。",
  badge: "Coding Plan",
  roleCapabilities: ["chat", "coding_plan"],
  runtimeCompatibility: "proxy",
};

class MimoCompatibleProvider extends OpenAiCompatibleProvider {
  constructor(definition: ModelSourceDefinition, urlPatterns: RegExp[]) {
    super(definition, { urlPatterns, modelPatterns: [/^mimo-v2\.5/i, /^mimo-v2-/i, /^xiaomi\/mimo-v2\.5/i] });
  }

  protected override buildAuthHeaders(auth?: string): Record<string, string> {
    const apiKey = auth || "";
    return { authorization: `Bearer ${apiKey}`, "api-key": apiKey };
  }

  protected override shouldDelegateToHermesRuntime(): boolean {
    return false;
  }

  protected override async fetchModels(input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ModelListResult> {
    const result = await super.fetchModels(input, baseUrl, auth);
    if (!result.ok || result.availableModels.length) return result;
    return {
      ...result,
      message: `${result.message} 已回退到 MiMo V2.5 内置模型清单。`,
      availableModels: commonModels,
      rawModelPayload: mimoModels,
    };
  }
}

export class MimoProvider extends MimoCompatibleProvider {
  constructor() {
    super(apiDefinition, [/api\.xiaomimimo\.com\/v1/i, /api\.mimo-v2\.com\/v1/i]);
  }
}

export class MimoTokenPlanProvider extends MimoCompatibleProvider {
  constructor() {
    super(tokenPlanDefinition, [/token-plan-[\w-]+\.xiaomimimo\.com\/v1/i]);
  }
}
