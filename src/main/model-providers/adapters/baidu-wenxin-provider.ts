import { z } from "zod";
import { BaseProvider } from "../base-provider";
import { fetchWithRetry, httpFailureCategory } from "../http";
import type { ChatResult, ModelListResult, ModelSourceDefinition, ProviderAuthResult, ProviderTestContext, ToolCheckResult } from "../types";

const definition: ModelSourceDefinition = {
  sourceType: "baidu_wenxin_api_key",
  family: "api_key",
  authMode: "api_key",
  label: "百度文心一言（ERNIE Bot）",
  provider: "custom",
  baseUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat",
  modelPlaceholder: "ernie-4.0-8k / ernie-4.0-turbo-8k / ernie-speed-128k",
  presetModels: ["ernie-4.0-8k", "ernie-4.0-turbo-8k", "ernie-speed-128k"],
  group: "china",
  description: "百度千帆非 OpenAI 兼容接口，运行时通过本地代理转换。",
  keywords: ["百度", "文心", "ernie", "qianfan", "baidu"],
  requiredAuthFields: ["api_key", "secret_key"],
  roleCapabilities: ["chat"],
  runtimeCompatibility: "proxy",
};

const tokenSchema = z.object({
  access_token: z.string().min(1),
}).passthrough();

const chatSchema = z.object({
  result: z.string().optional(),
  error_code: z.number().optional(),
  error_msg: z.string().optional(),
}).passthrough();

export class BaiduWenxinProvider extends BaseProvider {
  readonly sourceType = definition.sourceType;
  readonly definition = definition;
  readonly urlPatterns = [/aip\.baidubce\.com/i, /wenxinworkshop/i];
  readonly modelPatterns = [/^ernie-/i];

  protected override normalizeBaseUrl(baseUrl?: string) {
    const url = (baseUrl?.trim() || this.definition.baseUrl || "").replace(/\/$/, "");
    return url ? { ok: true as const, url } : { ok: false as const, message: "还没有填写模型服务地址。" };
  }

  protected override async resolveAuth(input: ProviderTestContext): Promise<ProviderAuthResult> {
    const base = await super.resolveAuth(input);
    if (!base.ok) return base;
    const credential = parseBaiduCredential(base.auth ?? "");
    if (!credential) {
      return {
        ok: false,
        result: this.fail(input.profile, "auth_invalid", "百度文心需要同时提供 API Key 和 Secret Key。", "请把密钥保存为 JSON（apiKey/secretKey）或 apiKey:secretKey。", [
          { id: "auth", label: "auth", ok: false, message: "缺少 API Key 或 Secret Key" },
        ]),
      };
    }
    const token = await this.fetchAccessToken(credential.apiKey, credential.secretKey);
    if (!token.ok) {
      return {
        ok: false,
        result: this.fail(input.profile, token.category, token.message, token.fix, [
          { id: "auth", label: "auth", ok: false, message: token.message },
        ]),
      };
    }
    return { ok: true, auth: token.accessToken };
  }

  protected async fetchModels(_input: ProviderTestContext): Promise<ModelListResult> {
    return {
      ok: true,
      message: "百度文心不提供统一 OpenAI /models；已使用内置模型清单并继续实测。",
      availableModels: this.definition.presetModels ?? [],
      rawModelPayload: (this.definition.presetModels ?? []).map((id: string) => ({ id, context_window: 128000 })),
      authResolved: true,
    };
  }

  protected async sendTestChat(input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ChatResult> {
    const url = `${baseUrl}/${encodeURIComponent(input.profile.model)}?access_token=${encodeURIComponent(auth ?? "")}`;
    try {
      const response = await fetchWithRetry(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Reply with OK." }] }),
      });
      const parsed = chatSchema.safeParse(await response.json().catch(() => undefined));
      if (response.ok && parsed.success && !parsed.data.error_code) return { ok: true, message: "最小文心 chat 请求通过。" };
      return {
        ok: false,
        message: parsed.success && parsed.data.error_msg ? `文心请求失败：${parsed.data.error_msg}` : `文心请求失败（HTTP ${response.status}）。`,
        failureCategory: response.ok ? "unknown" : httpFailureCategory(response.status),
        recommendedFix: "请确认模型名、百度千帆权限、API Key 和 Secret Key 均正确。",
      };
    } catch (error) {
      return { ok: false, message: `连不上百度文心接口 ${url}。`, failureCategory: "network_unreachable", recommendedFix: error instanceof Error ? error.message : "请检查网络和百度接口地址。" };
    }
  }

  protected async testToolCalling(): Promise<ToolCheckResult> {
    return {
      ok: false,
      message: "百度文心原生接口不是 OpenAI tool calling 格式，当前已完成非兼容 chat 转换但尚未声明主模型工具能力。",
      recommendedFix: "需要补充百度千帆工具调用字段转换后，才能作为 Hermes 主模型。",
    };
  }

  private async fetchAccessToken(apiKey: string, secretKey: string) {
    const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
    try {
      const response = await fetchWithRetry(url, { method: "POST" });
      const parsed = tokenSchema.safeParse(await response.json().catch(() => undefined));
      if (response.ok && parsed.success) return { ok: true as const, accessToken: parsed.data.access_token };
      return { ok: false as const, category: httpFailureCategory(response.status), message: `百度 access_token 获取失败（HTTP ${response.status}）。`, fix: "请确认百度 API Key / Secret Key 正确且服务已开通。" };
    } catch (error) {
      return { ok: false as const, category: "network_unreachable" as const, message: "连不上百度 OAuth token 接口。", fix: error instanceof Error ? error.message : "请检查网络。" };
    }
  }
}

function parseBaiduCredential(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const json = tryParseJson(trimmed);
  if (json && typeof json.apiKey === "string" && typeof json.secretKey === "string") {
    return { apiKey: json.apiKey.trim(), secretKey: json.secretKey.trim() };
  }
  const [apiKey, secretKey] = trimmed.includes(":") ? trimmed.split(":", 2) : trimmed.split(/\r?\n/, 2);
  if (!apiKey?.trim() || !secretKey?.trim()) return undefined;
  return { apiKey: apiKey.trim(), secretKey: secretKey.trim() };
}

function tryParseJson(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
