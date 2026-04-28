import { z } from "zod";
import { compactPreview, fetchWithRetry, httpFailureCategory } from "./http";
import { BaseProvider } from "./base-provider";
import type { ChatResult, ModelListResult, ModelSourceDefinition, ProviderAuthResult, ProviderTestContext, ToolCheckResult } from "./types";

const anthropicModelsSchema = z.object({
  data: z.array(z.object({
    id: z.string().optional(),
    context_window: z.number().optional(),
  })).optional(),
}).passthrough();

export class AnthropicProvider extends BaseProvider {
  readonly sourceType: ModelSourceDefinition["sourceType"];
  readonly urlPatterns = [/anthropic\.com/i];
  readonly modelPatterns = [/^claude-/i];

  constructor(readonly definition: ModelSourceDefinition) {
    super();
    this.sourceType = definition.sourceType;
  }

  protected override normalizeBaseUrl(baseUrl?: string) {
    const url = (baseUrl?.trim() || this.definition.baseUrl || "").replace(/\/$/, "");
    return url ? { ok: true as const, url } : { ok: false as const, message: "还没有填写模型服务地址。" };
  }

  protected override buildAuthHeaders(auth?: string) {
    return {
      "x-api-key": auth ?? "",
      "anthropic-version": "2023-06-01",
    };
  }

  protected async fetchModels(_input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ModelListResult> {
    const modelsUrl = `${baseUrl}/v1/models`;
    try {
      const response = await fetchWithRetry(modelsUrl, {
        method: "GET",
        headers: this.buildAuthHeaders(auth),
      });
      if (!response.ok) {
        return {
          ok: false,
          message: `Anthropic 鉴权或模型发现失败（HTTP ${response.status}）。`,
          failureCategory: response.status === 401 || response.status === 403 ? "auth_invalid" : "server_error",
          recommendedFix: "请确认 API Key 正确，并检查当前模型是否属于 Anthropic。",
          availableModels: [],
          authResolved: !(response.status === 401 || response.status === 403),
        };
      }
      const parsed = anthropicModelsSchema.safeParse(await response.json().catch(() => undefined));
      const raw = parsed.success ? parsed.data.data ?? [] : [];
      const availableModels = raw.map((item) => item.id).filter((item): item is string => Boolean(item));
      return {
        ok: true,
        message: availableModels.length ? `发现 ${availableModels.length} 个模型` : "模型列表为空，继续做最小消息测试",
        availableModels,
        rawModelPayload: raw.map((item) => ({ id: item.id, context_window: item.context_window })),
        authResolved: true,
      };
    } catch (error) {
      return {
        ok: false,
        message: `连不上 Anthropic 接口 ${modelsUrl}。`,
        failureCategory: "network_unreachable",
        recommendedFix: error instanceof Error ? error.message : "请检查网络、代理和 API 地址。",
        availableModels: [],
        authResolved: false,
      };
    }
  }

  protected async sendTestChat(input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ChatResult> {
    const response = await this.postMessages(baseUrl, auth, {
      model: input.profile.model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    if (response.ok) return { ok: true, message: "最小消息请求通过" };
    const preview = await response.text().catch(() => "");
    return {
      ok: false,
      message: `Anthropic 最小消息请求失败（HTTP ${response.status}）${preview ? `：${compactPreview(preview)}` : "。"}`,
      failureCategory: httpFailureCategory(response.status),
      recommendedFix: "请确认模型 ID、账号权限和 API Key 都正确。",
    };
  }

  protected async testToolCalling(input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ToolCheckResult> {
    const response = await this.postMessages(baseUrl, auth, {
      model: input.profile.model,
      max_tokens: 32,
      tools: [{ name: "ping", description: "ping", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "Call the ping tool." }],
    });
    if (response.ok) return { ok: true, message: "tool calling 可用" };
    return { ok: false, message: `tool calling 探测失败（HTTP ${response.status}）。`, recommendedFix: "请改用支持工具调用的 Anthropic 模型。" };
  }

  private postMessages(baseUrl: string, auth: string | undefined, body: Record<string, unknown>) {
    return fetchWithRetry(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.buildAuthHeaders(auth) },
      body: JSON.stringify(body),
    });
  }
}

export class AnthropicLocalCredentialsProvider extends AnthropicProvider {
  protected override async resolveAuth(input: ProviderTestContext): Promise<ProviderAuthResult> {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_TOKEN;
    if (!token) {
      return {
        ok: false,
        result: this.fail(input.profile, "manual_action_required", "没有发现可用于 Anthropic 的本地凭据。", "请先在本机完成 Anthropic 登录，或提供 ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN。", [
          { id: "auth", label: "auth", ok: false, message: "未发现本地 Anthropic 凭据" },
        ]),
      };
    }
    return { ok: true, auth: token };
  }
}
