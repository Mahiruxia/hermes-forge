import { normalizeOpenAiCompatibleBaseUrl } from "../../shared/model-config";
import type { ModelConnectionTestResult, ModelHealthCheckStep, ModelProfile } from "../../shared/types";
import { compactPreview, fetchWithRetry, httpFailureCategory, httpFailureFix, isRecord } from "./http";
import { classifyAgentRole, failure, inferContextWindow, step, success } from "./result";
import type {
  ChatResult,
  ModelListResult,
  ModelSourceDefinition,
  ProviderAuthResult,
  ProviderTestContext,
  ToolCheckResult,
} from "./types";
import { probeWslReachability } from "./wsl-reachability";

type OpenAiToolProbeAttempt = {
  id: string;
  label: string;
  body: Record<string, unknown>;
};

type OpenAiToolProbeAttemptResult = {
  label: string;
  ok: boolean;
  message: string;
  status?: number;
};

type NormalizedBaseUrlResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

/**
 * Base template for model provider connection tests.
 *
 * Subclasses provide model discovery and may override chat/tool probes when
 * the provider is not OpenAI-compatible. The shared template handles auth,
 * model mismatch tolerance, agent capability classification, WSL reachability,
 * and consistent `ModelConnectionTestResult` construction.
 */
export abstract class BaseProvider {
  abstract readonly sourceType: ModelSourceDefinition["sourceType"];
  abstract readonly definition: ModelSourceDefinition;

  readonly urlPatterns: RegExp[] = [];
  readonly modelPatterns: RegExp[] = [];

  async testConnection(input: ProviderTestContext): Promise<ModelConnectionTestResult> {
    const profile = this.withDefaultBaseUrl(input.profile);
    if (!profile.model.trim()) {
      return this.fail(profile, "model_not_found", "模型还没选，请先从可用模型中选择，或手动填写模型 ID。", "先选 provider family，再选择或填写模型。", [
        step("models", false, "模型 ID 为空"),
      ]);
    }

    const auth = await this.resolveAuth({ ...input, profile });
    if (!auth.ok) return auth.result;

    const baseUrlResult = this.normalizeBaseUrl(profile.baseUrl);
    if (!baseUrlResult.ok) {
      return this.fail(profile, "invalid_url", baseUrlResult.message, "请填写有效的 Base URL，例如 http://127.0.0.1:1234/v1。", [
        step("models", false, baseUrlResult.message),
      ]);
    }
    const baseUrl = baseUrlResult.url;
    const outboundValidation = validateProviderOutboundBaseUrl(baseUrl, {
      allowPrivateNetwork: allowsPrivateNetwork(this.sourceType, auth.auth),
    });
    if (!outboundValidation.ok) {
      return this.fail(profile, "invalid_url", outboundValidation.message, outboundValidation.message, [
        step("models", false, outboundValidation.message),
      ], { normalizedBaseUrl: baseUrl, authResolved: Boolean(auth.auth) });
    }

    if (this.shouldDelegateToHermesRuntime()) {
      return this.buildDelegatedSuccess({ ...input, profile }, baseUrl);
    }

    const steps: ModelHealthCheckStep[] = [];
    const modelInfo = await this.fetchModels({ ...input, profile }, baseUrl, auth.auth);
    steps.push(step("auth", modelInfo.authResolved, modelInfo.authResolved ? "鉴权已通过" : modelInfo.message));
    const modelListMismatch = modelInfo.availableModels.length > 0 && !modelInfo.availableModels.includes(profile.model);
    steps.push(step(
      "models",
      modelInfo.ok,
      modelListMismatch
        ? `模型列表返回 ${modelInfo.availableModels.length} 个模型，但未包含 ${profile.model}；继续用 chat 实测为准。`
        : modelInfo.message,
      modelListMismatch ? `返回模型示例：${modelInfo.availableModels.slice(0, 12).join("、")}` : undefined,
    ));
    if (!modelInfo.ok) {
      return this.fail(profile, modelInfo.failureCategory ?? "unknown", modelInfo.message, modelInfo.recommendedFix, steps, {
        normalizedBaseUrl: baseUrl,
        availableModels: modelInfo.availableModels,
        authResolved: modelInfo.authResolved,
      });
    }

    const chat = await this.sendTestChat({ ...input, profile }, baseUrl, auth.auth);
    steps.push(step("chat", chat.ok, chat.message));
    const isCodingPlan = this.definition.badge === "Coding Plan";
    const isAccessTerminated = !chat.ok && chat.failureCategory === "manual_action_required" && /access_terminated/i.test(chat.message ?? "");

    if (!chat.ok) {
      if (isCodingPlan) {
        if (chat.failureCategory === "network_unreachable" || (chat.failureCategory === "auth_invalid" && !isAccessTerminated)) {
          return this.fail(
            profile,
            chat.failureCategory,
            chat.message,
            chat.recommendedFix,
            steps,
            { normalizedBaseUrl: baseUrl, availableModels: modelInfo.availableModels, authResolved: modelInfo.authResolved },
          );
        }
        const runtimeCompatibility = this.effectiveRuntimeCompatibility();
        const roleCompatibility = this.buildRoleCompatibility("provider_only", runtimeCompatibility);
        steps.push(step("agent_capability", false, "Coding Plan provider 的 agent 能力由 Hermes Agent 在运行时验证，Forge 不做直接测试。"));
        steps.push(step("runtime", runtimeCompatibility !== "connection_only", runtimeCompatibility === "proxy" ? "运行态将通过本地 OpenAI 兼容代理接入 Hermes。" : runtimeCompatibility === "runtime" ? "运行态可直接同步到 Hermes。" : "当前只支持连接测试和保存，暂不能分配给 Hermes runtime。"));
        const wsl = await this.testWslIfNeeded({ ...input, profile }, baseUrl, steps);
        if (!wsl.ok) {
          return this.fail(profile, "wsl_unreachable", wsl.message ?? "WSL 内 Hermes 暂时访问不到这个模型服务地址。", wsl.fixHint, steps, {
            normalizedBaseUrl: baseUrl,
            availableModels: modelInfo.availableModels,
            authResolved: modelInfo.authResolved,
            agentRole: "provider_only",
            runtimeCompatibility,
            roleCompatibility,
            wslReachable: false,
            wslProbeUrl: wsl.testedUrl,
            fixSteps: wsl.fixSteps,
          });
        }
        return success({
          profile,
          sourceType: this.sourceType,
          family: this.definition.family,
          authMode: this.definition.authMode,
          message: chat.ok ? "连接成功；Coding Plan provider 配置已保存。" : "Forge 直接连接测试被 Coding Plan provider 拦截，但配置可保存。实际可用性请通过 Hermes Agent 验证。",
          steps,
          normalizedBaseUrl: baseUrl,
          availableModels: modelInfo.availableModels,
          authResolved: modelInfo.authResolved,
          agentRole: "provider_only",
          runtimeCompatibility,
          roleCompatibility,
          wslReachable: wsl.reachable,
          wslProbeUrl: wsl.testedUrl,
        });
      }
      return this.fail(
        profile,
        modelListMismatch ? "model_not_found" : chat.failureCategory ?? "unknown",
        modelListMismatch ? `模型服务可达，但模型列表不包含"${profile.model}"，chat 实测也失败。` : chat.message,
        modelListMismatch ? "请从返回的模型列表里选择一个模型，或确认模型 ID/部署名是否正确。" : chat.recommendedFix,
        steps,
        { normalizedBaseUrl: baseUrl, availableModels: modelInfo.availableModels, authResolved: modelInfo.authResolved },
      );
    }

    const toolCheck = await this.testToolCalling({ ...input, profile }, baseUrl, auth.auth);
    const contextWindow = profile.maxTokens ?? inferContextWindow(profile.model, modelInfo.rawModelPayload);
    const agentRole = classifyAgentRole({ contextWindow, supportsTools: toolCheck.ok });
    const runtimeCompatibility = this.effectiveRuntimeCompatibility();
    const roleCompatibility = this.buildRoleCompatibility(agentRole, runtimeCompatibility);
    steps.push(step(
      "agent_capability",
      agentRole === "primary_agent",
      agentRole === "primary_agent"
        ? "满足 Hermes agent 主模型要求"
        : toolCheck.ok
          ? `上下文窗口只有 ${contextWindow ?? 0}，更适合作为辅助模型`
          : "tool calling 未通过，不能直接作为 Hermes 主模型",
      toolCheck.detail,
    ));
    steps.push(step(
      "runtime",
      runtimeCompatibility !== "connection_only",
      runtimeCompatibility === "proxy"
        ? "运行态将通过本地 OpenAI 兼容代理接入 Hermes。"
        : runtimeCompatibility === "runtime"
          ? "运行态可直接同步到 Hermes。"
          : "当前只支持连接测试和保存，暂不能分配给 Hermes runtime。",
    ));

    const wsl = await this.testWslIfNeeded({ ...input, profile }, baseUrl, steps);
    if (!wsl.ok) {
      return this.fail(profile, "wsl_unreachable", wsl.message ?? "WSL 内 Hermes 暂时访问不到这个模型服务地址。", wsl.fixHint, steps, {
        normalizedBaseUrl: baseUrl,
        availableModels: modelInfo.availableModels,
        authResolved: modelInfo.authResolved,
        contextWindow,
        supportsTools: toolCheck.ok,
        agentRole,
        runtimeCompatibility,
        roleCompatibility,
        wslReachable: false,
        wslProbeUrl: wsl.testedUrl,
        fixSteps: wsl.fixSteps,
      });
    }

    if (!toolCheck.ok) {
      const toolFailureMessage = /HTTP 429|限流|额度/.test(toolCheck.message)
        ? toolCheck.message
        : "模型可以正常对话，但不支持「工具调用」功能。Hermes 需要工具调用才能自动执行命令、读写文件。如果你确认不需要这些功能，可以把它保存为「辅助模型」；否则请换一个支持 tool calling 的模型。";
      return this.fail(profile, "tool_calling_unavailable", toolFailureMessage, toolCheck.recommendedFix ?? "请开启工具调用能力，或把它只作为辅助模型保存。", steps, {
        normalizedBaseUrl: baseUrl,
        availableModels: modelInfo.availableModels,
        authResolved: modelInfo.authResolved,
        contextWindow,
        supportsTools: false,
        agentRole,
        runtimeCompatibility,
        roleCompatibility,
        wslReachable: wsl.reachable,
        wslProbeUrl: wsl.testedUrl,
      });
    }
    if (!contextWindow || contextWindow < 16_000) {
      return this.fail(profile, "context_too_low", `模型服务可以聊天，也支持 tool calling，但上下文窗口只有 ${contextWindow ?? 0}，不适合作为 Hermes 主模型。`, "请填写真实的 context length（至少 16000），或把它只作为辅助模型保存。", steps, {
        normalizedBaseUrl: baseUrl,
        availableModels: modelInfo.availableModels,
        authResolved: modelInfo.authResolved,
        contextWindow,
        supportsTools: true,
        agentRole,
        runtimeCompatibility,
        roleCompatibility,
        wslReachable: wsl.reachable,
        wslProbeUrl: wsl.testedUrl,
      });
    }

    return success({
      profile,
      sourceType: this.sourceType,
      family: this.definition.family,
      authMode: this.definition.authMode,
      message: `连接成功；鉴权、模型发现、最小 chat、tool calling、${input.config.hermesRuntime?.mode === "wsl" ? "WSL 可达性、" : ""}agent 能力检查均已通过。`,
      steps,
      normalizedBaseUrl: baseUrl,
      availableModels: modelInfo.availableModels,
      authResolved: modelInfo.authResolved,
      contextWindow,
      supportsTools: true,
      agentRole,
      runtimeCompatibility,
      roleCompatibility,
      wslReachable: wsl.reachable,
      wslProbeUrl: wsl.testedUrl,
      recommendedFix: wsl.fixHint,
    });
  }

  protected abstract fetchModels(input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ModelListResult>;

  /**
   * Coding Plan / Token Plan 走 Hermes Agent 直通分支，
   * 直接保存配置并跳过 Forge 侧的 chat/tool 探测。
   *
   * 这些 provider 通常：
   * - 限制第三方客户端访问（kimi-cli stainless headers 校验、access_terminated_error 等）
   * - 不暴露 OpenAI 兼容的 /models 端点，或返回非标准格式
   * - 用 Anthropic /v1/messages 协议而非 OpenAI /chat/completions
   *
   * Hermes Agent 内置 handler 会在运行时按 --provider 字段直接处理这些差异，
   * Forge 唯一需要做的是把凭据 + base URL 准确写到 settingsConfig.env。
   */
  protected shouldDelegateToHermesRuntime(): boolean {
    return this.definition.badge === "Coding Plan";
  }

  protected async buildDelegatedSuccess(input: ProviderTestContext, baseUrl: string): Promise<ModelConnectionTestResult> {
    const steps: ModelHealthCheckStep[] = [
      step("auth", true, "API Key 已就绪"),
      step("models", true, "Coding Plan / Token Plan 直通 Hermes Agent，跳过 Forge 侧模型发现。"),
      step("agent_capability", true, "Agent 能力由 Hermes Agent 内置 handler 在运行时验证。"),
      step("runtime", true, "运行态由 Hermes Agent 直接接管。"),
    ];
    const wsl = await this.testWslIfNeeded(input, baseUrl, steps);
    const runtimeCompatibility = this.effectiveRuntimeCompatibility();
    const roleCompatibility = this.buildRoleCompatibility("primary_agent", runtimeCompatibility);
    if (!wsl.ok) {
      return this.fail(
        input.profile,
        "wsl_unreachable",
        wsl.message ?? "WSL 内 Hermes 暂时访问不到这个模型服务地址。",
        wsl.fixHint,
        steps,
        {
          normalizedBaseUrl: baseUrl,
          availableModels: [],
          authResolved: true,
          agentRole: "primary_agent",
          runtimeCompatibility,
          roleCompatibility,
          wslReachable: false,
          wslProbeUrl: wsl.testedUrl,
          fixSteps: wsl.fixSteps,
        },
      );
    }
    return success({
      profile: input.profile,
      sourceType: this.sourceType,
      family: this.definition.family,
      authMode: this.definition.authMode,
      message: "Coding Plan / Token Plan 配置已保存，运行时由 Hermes Agent 直接验证。请在实际会话中确认实际可用性。",
      steps,
      normalizedBaseUrl: baseUrl,
      availableModels: [],
      authResolved: true,
      agentRole: "primary_agent",
      runtimeCompatibility,
      roleCompatibility,
      wslReachable: wsl.reachable,
      wslProbeUrl: wsl.testedUrl,
    });
  }

  protected async resolveAuth(input: ProviderTestContext): Promise<ProviderAuthResult> {
    if (this.definition.authMode === "optional_api_key") {
      if (!input.profile.secretRef) return { ok: true };
      if (!(await input.secretVault.hasSecret(input.profile.secretRef))) {
        return { ok: false, result: this.fail(input.profile, "auth_missing", "配置里引用了 API Key，但这个密钥当前不可用。", "请重新保存 API Key，或清空这个可选密钥引用。", [step("auth", false, "密钥引用存在，但密钥不可用")]) };
      }
      return { ok: true, auth: await input.secretVault.readSecret(input.profile.secretRef) };
    }
    if (this.definition.authMode !== "api_key") return { ok: true };
    if (!input.profile.secretRef) {
      return { ok: false, result: this.fail(input.profile, "auth_missing", "这个 provider family 需要 API Key，但当前还没有保存。", "先完成 provider 认证，再测试连接。", [step("auth", false, "缺少 API Key")]) };
    }
    if (!(await input.secretVault.hasSecret(input.profile.secretRef))) {
      return { ok: false, result: this.fail(input.profile, "auth_missing", "已配置密钥引用，但当前密钥内容不存在或已失效。", "请重新保存对应 provider 的 API Key。", [step("auth", false, "密钥引用存在，但密钥不可用")]) };
    }
    return { ok: true, auth: await input.secretVault.readSecret(input.profile.secretRef) ?? "" };
  }

  protected async sendTestChat(input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ChatResult> {
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    try {
      const response = await fetchWithRetry(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.buildAuthHeaders(auth) },
        body: JSON.stringify({ model: input.profile.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 8 }),
      });
      if (response.ok) return { ok: true, message: "最小 chat 请求通过。" };
      const preview = await response.text().catch(() => "");
      const modelMissing = /model.*(not found|not exist|does not exist|unknown|不存在|未找到)|deployment.*not found/i.test(preview);
      const accessTerminated = /access_terminated_error/i.test(preview);
      return {
        ok: false,
        message: `最小 chat 请求失败（HTTP ${response.status}）${preview ? `：${compactPreview(preview)}` : "。"}`,
        failureCategory: modelMissing ? "model_not_found" : accessTerminated ? "manual_action_required" : httpFailureCategory(response.status),
        recommendedFix: modelMissing
          ? "请确认模型 ID/部署名正确，或从模型列表中选择一个已加载模型。"
          : accessTerminated
            ? "该模型服务当前限制了第三方客户端访问，请联系 provider 确认您的账户是否已开通对应权限，或尝试使用官方推荐的客户端。"
            : httpFailureFix(response.status, baseUrl),
      };
    } catch (error) {
      return { ok: false, message: `连不上聊天接口 ${url}。`, failureCategory: "network_unreachable", recommendedFix: error instanceof Error ? error.message : "请检查服务地址和网络。" };
    }
  }

  protected async testToolCalling(input: ProviderTestContext, baseUrl: string, auth?: string): Promise<ToolCheckResult> {
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const results: OpenAiToolProbeAttemptResult[] = [];
    let rateLimited = false;
    try {
      for (const attempt of this.buildOpenAiToolProbeAttempts(input.profile.model)) {
        const response = await fetchWithRetry(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.buildAuthHeaders(auth) },
          body: JSON.stringify(attempt.body),
        });
        if (!response.ok) {
          const preview = await response.text().catch(() => "");
          results.push({ label: attempt.label, ok: false, status: response.status, message: `HTTP ${response.status}${preview ? `：${compactPreview(preview)}` : ""}` });
          if (response.status === 429) {
            rateLimited = true;
            break;
          }
          continue;
        }
        const parsed = this.parseOpenAiToolProbePayload(await response.json().catch(() => undefined));
        results.push({ label: attempt.label, ok: parsed.ok, message: parsed.message });
        if (parsed.ok) return { ok: true, message: parsed.message, detail: this.toolProbeDetail(results) };
      }
      if (rateLimited) {
        return {
          ok: false,
          message: "模型可以正常对话，但 tool calling 探测被服务端限流/额度拦截（HTTP 429）。",
          detail: this.toolProbeDetail(results),
          recommendedFix: "中转站已返回 429，请等待小时额度恢复、降低测试频率，或换用有剩余额度且支持 tools/tool_choice 透传的中转站。Forge 已停止后续工具探针，避免继续消耗额度。",
        };
      }
      return { ok: false, message: "接口能返回 chat，但所有标准 tool calling 探测都没有返回可执行工具调用。", detail: this.toolProbeDetail(results), recommendedFix: "请确认模型服务端开启了 function/tool calling、选择了支持工具的模型，并检查代理/网关没有移除 tools 或 tool_choice 参数。" };
    } catch (error) {
      return { ok: false, message: "tool calling 探测失败。", detail: results.length ? this.toolProbeDetail(results) : undefined, recommendedFix: error instanceof Error ? error.message : "请检查模型服务是否支持工具调用。" };
    }
  }

  protected buildAuthHeaders(auth?: string): Record<string, string> {
    return { authorization: `Bearer ${auth || "lm-studio"}` };
  }

  protected normalizeBaseUrl(baseUrl?: string): NormalizedBaseUrlResult {
    try {
      const url = normalizeOpenAiCompatibleBaseUrl(baseUrl) ?? "";
      return url
        ? { ok: true, url }
        : { ok: false, message: "还没有填写模型服务地址。" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "URL 格式非法。";
      console.warn("[Hermes Forge] Invalid model provider Base URL:", { baseUrl, message });
      return { ok: false, message: `Base URL 格式不正确：${message}` };
    }
  }

  protected withDefaultBaseUrl(profile: ModelProfile): ModelProfile {
    return { ...profile, baseUrl: profile.baseUrl?.trim() || this.definition.baseUrl };
  }

  protected fail(profile: ModelProfile, category: NonNullable<ModelConnectionTestResult["failureCategory"]>, message: string, fix: string | undefined, steps: ModelHealthCheckStep[], extra: Partial<ProviderHealthExtra> = {}) {
    return failure({ profile, sourceType: this.sourceType, family: this.definition.family, authMode: this.definition.authMode, category, message, fix, steps, ...extra });
  }

  private async testWslIfNeeded(input: ProviderTestContext, baseUrl: string, steps: ModelHealthCheckStep[]) {
    if (input.config.hermesRuntime?.mode !== "wsl") return { ok: true, reachable: true as const };
    const wsl = await probeWslReachability({ baseUrl, runtime: input.config.hermesRuntime, runtimeAdapterFactory: input.runtimeAdapterFactory, resolveHermesRoot: input.resolveHermesRoot });
    steps.push(step("wsl_network", wsl.ok, wsl.message, wsl.detail));
    return { ok: wsl.ok, reachable: wsl.ok, testedUrl: wsl.testedUrl, fixHint: wsl.fixHint, fixSteps: wsl.fixSteps, message: wsl.message };
  }

  private buildOpenAiToolProbeAttempts(model: string): OpenAiToolProbeAttempt[] {
    const tool = { type: "function", function: { name: "ping", description: "Return a ping result. You must call this function when asked.", parameters: { type: "object", properties: { message: { type: "string", description: "A short ping message." } }, required: ["message"] } } };
    const messages = [{ role: "user", content: "Call the ping tool now with message \"ok\". Do not answer in text." }];
    const base = { model, messages, max_tokens: 32, temperature: 0 };
    return [
      { id: "tools_required", label: "标准 tools + required", body: { ...base, tools: [tool], tool_choice: "required" } },
      { id: "tools_auto", label: "标准 tools + auto", body: { ...base, tools: [tool], tool_choice: "auto" } },
      { id: "legacy_functions_forced", label: "旧版 functions + function_call", body: { ...base, functions: [tool.function], function_call: { name: "ping" } } },
    ];
  }

  private parseOpenAiToolProbePayload(payload: unknown) {
    const choice = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    const toolCalls = isRecord(message) && Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
    if (toolCalls && toolCalls.length > 0) return { ok: true, message: "tool calling 可用（返回 OpenAI 标准 tool_calls）。" };
    const functionCall = isRecord(message) && isRecord(message.function_call) ? message.function_call : undefined;
    if (functionCall && typeof functionCall.name === "string" && functionCall.name.trim()) return { ok: true, message: "tool calling 可用（返回旧版 function_call，Forge 会按兼容能力接入）。" };
    const finishReason = isRecord(choice) && typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
    const content = isRecord(message) && typeof message.content === "string" ? message.content : undefined;
    if (finishReason === "tool_calls" || finishReason === "function_call") return { ok: false, message: `响应声明了 ${finishReason}，但没有携带可解析的调用内容。` };
    return { ok: false, message: content ? `返回普通文本：${compactPreview(content)}` : "没有返回 tool_calls 或 function_call。" };
  }

  private toolProbeDetail(results: OpenAiToolProbeAttemptResult[]) {
    return results.map((item) => `${item.ok ? "通过" : "失败"}：${item.label} - ${item.message}`).join("\n");
  }

  private buildRoleCompatibility(
    agentRole: ModelConnectionTestResult["agentRole"],
    runtimeCompatibility: NonNullable<ModelConnectionTestResult["runtimeCompatibility"]>,
  ): NonNullable<ModelConnectionTestResult["roleCompatibility"]> {
    const runtimeReady = runtimeCompatibility !== "connection_only";
    const roles = this.definition.roleCapabilities ?? (this.sourceType === "volcengine_coding_api_key" ? ["coding_plan"] : ["chat"]);
    const chatOk = runtimeReady && agentRole === "primary_agent" && roles.includes("chat");
    const codingPlanOk = runtimeReady && agentRole === "primary_agent" && roles.includes("coding_plan");
    return {
      chat: {
        ok: chatOk,
        message: chatOk ? "可作为主模型同步到 Hermes。" : "不满足主模型运行要求。",
      },
      coding_plan: {
        ok: codingPlanOk,
        message: codingPlanOk ? "可作为 Coding Plan 专用模型同步到 Hermes。" : "不满足 Coding Plan 运行要求。",
      },
    };
  }

  private effectiveRuntimeCompatibility(): NonNullable<ModelConnectionTestResult["runtimeCompatibility"]> {
    if (this.definition.runtimeCompatibility) return this.definition.runtimeCompatibility;
    if (this.sourceType === "baidu_wenxin_api_key") return "proxy";
    if (["spark_api_key", "baichuan_api_key", "minimax_api_key", "yi_api_key", "hunyuan_api_key"].includes(this.sourceType)) {
      return "connection_only";
    }
    return "runtime";
  }
}

type ProviderHealthExtra = {
  normalizedBaseUrl?: string;
  availableModels?: string[];
  authResolved?: boolean;
  contextWindow?: number;
  supportsTools?: boolean;
  agentRole?: ModelConnectionTestResult["agentRole"];
  runtimeCompatibility?: ModelConnectionTestResult["runtimeCompatibility"];
  roleCompatibility?: ModelConnectionTestResult["roleCompatibility"];
  wslReachable?: boolean;
  wslProbeUrl?: string;
  fixSteps?: string[];
};

function validateProviderOutboundBaseUrl(baseUrl: string, options: { allowPrivateNetwork?: boolean } = {}): { ok: boolean; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, message: `Base URL 格式不正确：${baseUrl}` };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, message: "Base URL 只支持 http 或 https。" };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!options.allowPrivateNetwork && isPrivateOrInternalHost(hostname)) {
    return {
      ok: false,
      message: `检测到内网或本机地址 ${hostname}。为避免把 API Key 发送到不受信任的本地/内网服务，Forge 已取消本次连接测试。`,
    };
  }
  return { ok: true, message: "ok" };
}

function allowsPrivateNetwork(sourceType: ModelSourceDefinition["sourceType"], auth?: string) {
  if (["ollama", "vllm", "sglang", "lm_studio", "legacy"].includes(sourceType)) return true;
  return sourceType === "openai_compatible" && !auth;
}

function isPrivateOrInternalHost(hostname: string) {
  if (!hostname) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  if (!hostname.includes(".") && !isIpv4(hostname) && !hostname.includes(":")) return true;
  if (hostname === "::1" || hostname.startsWith("fe80:") || hostname.startsWith("fd")) return true;
  if (!isIpv4(hostname)) return false;
  const parts = hostname.split(".").map((part) => Number(part));
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 0;
}

function isIpv4(hostname: string) {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}
