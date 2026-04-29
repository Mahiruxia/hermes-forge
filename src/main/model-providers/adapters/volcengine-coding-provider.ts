import { OpenAiCompatibleProvider } from "../openai-compatible-provider";
import type { ModelSourceDefinition } from "../types";

const definition: ModelSourceDefinition = {
  sourceType: "volcengine_coding_api_key",
  family: "api_key",
  authMode: "api_key",
  label: "火山引擎 Coding Plan",
  provider: "custom",
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
  modelPlaceholder: "火山方舟 coding endpoint ID",
  presetModels: [],
  group: "china",
  description: "火山方舟 Coding Plan 专用入口，使用独立 base URL。",
  keywords: ["火山", "方舟", "doubao", "coding", "plan"],
  badge: "Coding Plan",
  roleCapabilities: ["chat", "coding_plan"],
  runtimeCompatibility: "runtime",
};

export class VolcengineCodingProvider extends OpenAiCompatibleProvider {
  constructor() {
    super(definition, {
      urlPatterns: [/ark\.cn-beijing\.volces\.com\/api\/coding/i],
      modelPatterns: [/^doubao.*coding/i],
    });
  }
}
