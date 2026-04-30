import { describe, expect, it } from "vitest";
import { migrateRuntimeConfigModels, normalizeOpenAiCompatibleBaseUrl, requiresStoredSecret, resolveHermesProvider, stableModelProfileId } from "./model-config";
import type { ModelProfile } from "./types";

describe("model config helpers", () => {
  it("normalizes root OpenAI-compatible endpoints to /v1", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234/v1");
  });

  it("allows custom local endpoints without a stored secret", () => {
    const profile: ModelProfile = {
      id: "custom-local-endpoint",
      provider: "custom",
      baseUrl: "http://127.0.0.1:1234",
      model: "qwen",
    };

    expect(requiresStoredSecret(profile)).toBe(false);
    expect(requiresStoredSecret({ ...profile, secretRef: "provider.local.apiKey" })).toBe(true);
  });

  it("migrates legacy models to stable ids and a canonical default profile id", () => {
    const migrated = migrateRuntimeConfigModels({
      defaultModel: "openrouter/elephant-alpha",
      modelProfiles: [
        { provider: "local", model: "mock-model" },
        { provider: "openrouter", model: "openrouter/elephant-alpha", baseUrl: "https://openrouter.ai/api/v1" },
      ],
    });

    const expectedId = stableModelProfileId({
      provider: "openrouter",
      model: "openrouter/elephant-alpha",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(migrated.modelProfiles.map((item) => item.id)).toContain(expectedId);
    expect(migrated.defaultModelProfileId).toBe(expectedId);
  });

  it("mirrors the legacy default model into the chat role assignment", () => {
    const migrated = migrateRuntimeConfigModels({
      defaultModelProfileId: "kimi-main",
      modelProfiles: [
        { id: "kimi-main", provider: "custom", model: "moonshot-v1-128k", baseUrl: "https://api.moonshot.cn/v1" },
        { id: "doubao-coding", provider: "custom", model: "doubao-coding", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3" },
      ],
      modelRoleAssignments: { coding_plan: "doubao-coding" },
    });

    expect(migrated.modelRoleAssignments).toMatchObject({
      chat: "kimi-main",
      coding_plan: "doubao-coding",
    });
  });

  it("promotes old no-tools Windows profiles when context is sufficient", () => {
    const migrated = migrateRuntimeConfigModels({
      defaultModelProfileId: "old-main",
      modelProfiles: [{
        id: "old-main",
        provider: "custom",
        sourceType: "openai_compatible",
        model: "qwen",
        baseUrl: "http://127.0.0.1:8080/v1",
        maxTokens: 256000,
        agentRole: "auxiliary_model",
        supportsTools: false,
      }],
    });

    expect(migrated.modelProfiles[0]).toMatchObject({
      agentRole: "primary_agent",
      supportsTools: false,
    });
    expect(migrated.modelRoleAssignments?.chat).toBe("old-main");
  });

  it("migrates an OpenAI-compatible MiMo Token Plan endpoint to the dedicated source", () => {
    const migrated = migrateRuntimeConfigModels({
      defaultModelProfileId: "mimo-main",
      modelRoleAssignments: { chat: "mimo-main" },
      modelProfiles: [{
        id: "mimo-main",
        provider: "custom",
        sourceType: "openai_compatible",
        model: "MiMo-V2.5-Pro",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        secretRef: "provider.custom.apiKey",
      }],
    });

    expect(migrated.modelProfiles[0]).toMatchObject({
      id: "mimo-main",
      sourceType: "mimo_token_plan_api_key",
      model: "mimo-v2.5-pro",
      secretRef: "provider.custom.apiKey",
    });
    expect(migrated.modelRoleAssignments?.chat).toBe("mimo-main");
  });

  it("migrates old generic Coding Plan endpoints before runtime resolution", () => {
    const migrated = migrateRuntimeConfigModels({
      defaultModel: "KIMI-FOR-CODING",
      modelProfiles: [{
        provider: "custom",
        sourceType: "openai_compatible",
        model: "KIMI-FOR-CODING",
        baseUrl: "https://api.kimi.com/coding/v1",
      }],
    });

    expect(migrated.modelProfiles[0]).toMatchObject({
      sourceType: "kimi_coding_api_key",
      model: "kimi-for-coding",
    });
    expect(migrated.defaultModelProfileId).toBe(migrated.modelProfiles[0].id);
  });

  it("maps MiMo sources to the Hermes Xiaomi provider instead of custom", () => {
    expect(resolveHermesProvider({ provider: "custom", sourceType: "mimo_token_plan_api_key" })).toBe("xiaomi");
    expect(resolveHermesProvider({ provider: "custom", sourceType: "mimo_api_key" })).toBe("xiaomi");
  });

  it("keeps native OpenAI provider names for official Hermes", () => {
    expect(resolveHermesProvider({ provider: "openai" })).toBe("openai");
  });

  it("keeps unsupported Coding Plan providers on custom instead of inventing CLI aliases", () => {
    expect(resolveHermesProvider({ provider: "custom", sourceType: "dashscope_coding_api_key" })).toBe("custom");
    expect(resolveHermesProvider({ provider: "custom", sourceType: "zhipu_coding_api_key" })).toBe("custom");
    expect(resolveHermesProvider({ provider: "custom", sourceType: "tencent_token_plan_api_key" })).toBe("custom");
    expect(resolveHermesProvider({ provider: "custom", sourceType: "volcengine_coding_api_key" })).toBe("custom");
  });
});
