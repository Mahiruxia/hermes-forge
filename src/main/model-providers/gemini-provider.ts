import { z } from "zod";
import { fetchWithRetry, httpFailureCategory } from "./http";
import { BaseProvider } from "./base-provider";
import type { ChatResult, ModelListResult, ModelSourceDefinition, ProviderTestContext, ToolCheckResult } from "./types";

const geminiModelsSchema = z.object({
  models: z.array(z.object({
    name: z.string().optional(),
    inputTokenLimit: z.number().optional(),
    supportedGenerationMethods: z.array(z.string()).optional(),
  })).optional(),
}).passthrough();

export class GeminiProvider extends BaseProvider {
  readonly sourceType: ModelSourceDefinition["sourceType"];
  readonly urlPatterns = [/generativelanguage\.googleapis\.com/i];
  readonly modelPatterns = [/^gemini-/i];

  constructor(readonly definition: ModelSourceDefinition) {
    super();
    this.sourceType = definition.sourceType;
  }

  protected override normalizeBaseUrl(baseUrl?: string) {
    const url = (baseUrl?.trim() || this.definition.baseUrl || "").replace(/\/$/, "");
    return url ? { ok: true as const, url } : { ok: false as const, message: "还没有填写模型服务地址。" };
  }

  protected async fetchModels(_input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ModelListResult> {
    const modelsUrl = `${baseUrl}/models?key=${encodeURIComponent(auth ?? "")}`;
    try {
      const response = await fetchWithRetry(modelsUrl, { method: "GET" });
      if (!response.ok) {
        return {
          ok: false,
          message: `Gemini 模型列表请求失败（HTTP ${response.status}）。`,
          failureCategory: response.status === 401 || response.status === 403 ? "auth_invalid" : "server_error",
          recommendedFix: "请确认 API Key 正确，且 Base URL 指向 Google AI Studio / Gemini 接口。",
          availableModels: [],
          authResolved: !(response.status === 401 || response.status === 403),
        };
      }
      const parsed = geminiModelsSchema.safeParse(await response.json().catch(() => undefined));
      const models = parsed.success ? parsed.data.models ?? [] : [];
      const availableModels = models.map((item) => item.name?.replace(/^models\//, "")).filter((item): item is string => Boolean(item));
      return {
        ok: true,
        message: availableModels.length ? `发现 ${availableModels.length} 个 Gemini 模型` : "模型列表为空，继续做最小 chat 测试",
        availableModels,
        rawModelPayload: models.map((item) => ({
          id: item.name?.replace(/^models\//, ""),
          context_window: item.inputTokenLimit,
        })),
        authResolved: true,
      };
    } catch (error) {
      return {
        ok: false,
        message: `连不上 Gemini 接口 ${modelsUrl}。`,
        failureCategory: "network_unreachable",
        recommendedFix: error instanceof Error ? error.message : "请检查网络、代理和 Google API 地址。",
        availableModels: [],
        authResolved: false,
      };
    }
  }

  protected async sendTestChat(input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ChatResult> {
    const response = await this.generateContent(input, baseUrl, auth, {
      contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
    });
    if (response.ok) return { ok: true, message: "最小生成请求通过" };
    return {
      ok: false,
      message: `Gemini 最小生成请求失败（HTTP ${response.status}）。`,
      failureCategory: httpFailureCategory(response.status),
      recommendedFix: "请确认模型 ID 属于 Gemini，可用区域和账号权限也正确。",
    };
  }

  protected async testToolCalling(_input: ProviderTestContext, _baseUrl: string, _auth?: string): Promise<ToolCheckResult> {
    return {
      ok: false,
      message: "Gemini 原生 function calling 需要单独的工具声明转换，当前仅完成模型连通性校验。",
      recommendedFix: "可继续保存为辅助模型；若要作为主模型，请接入 Gemini functionDeclarations 转换。",
    };
  }

  private generateContent(input: ProviderTestContext, baseUrl: string, auth: string | undefined, body: Record<string, unknown>) {
    const url = `${baseUrl}/models/${input.profile.model}:generateContent?key=${encodeURIComponent(auth ?? "")}`;
    return fetchWithRetry(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
