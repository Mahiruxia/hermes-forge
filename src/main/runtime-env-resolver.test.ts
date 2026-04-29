import { describe, expect, it } from "vitest";
import { RuntimeEnvResolver } from "./runtime-env-resolver";
import type { RuntimeConfig } from "../shared/types";

describe("RuntimeEnvResolver", () => {
  it("injects OpenRouter API key aliases for OpenRouter profiles", async () => {
    const publicFixtureSecret = "public-fixture-secret";
    const config: RuntimeConfig = {
      defaultModelProfileId: "openrouter-elephant-alpha",
      modelProfiles: [{
        id: "openrouter-elephant-alpha",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openrouter/elephant-alpha",
        secretRef: "provider.openrouter.apiKey",
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => publicFixtureSecret } as never,
    );

    const runtime = await resolver.resolve();

    expect(runtime.env).toMatchObject({
      AI_PROVIDER: "openrouter",
      AI_MODEL: "openrouter/elephant-alpha",
      AI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_API_KEY: publicFixtureSecret,
      OPENAI_API_KEY: publicFixtureSecret,
      AI_API_KEY: publicFixtureSecret,
    });
  });

  it("uses the normalized OpenAI-compatible base URL everywhere", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "local-openai",
      modelProfiles: [{
        id: "local-openai",
        provider: "custom",
        baseUrl: "http://127.0.0.1:8080",
        model: "gpt-5.4",
        secretRef: "provider.local.apiKey",
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "pwd" } as never,
    );

    const runtime = await resolver.resolve();

    expect(runtime.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(runtime.env).toMatchObject({
      AI_BASE_URL: "http://127.0.0.1:8080/v1",
      OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8080/v1",
    });
  });

  it("lets the runtime proxy rewrite short-key local endpoints before Hermes sees them", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "local-openai",
      modelProfiles: [{
        id: "local-openai",
        provider: "custom",
        baseUrl: "http://127.0.0.1:8080",
        model: "gpt-5.4",
        secretRef: "provider.local.apiKey",
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "pwd" } as never,
      {
        resolve: async (runtime) => ({
          ...runtime,
          baseUrl: "http://127.0.0.1:49001/v1",
          env: {
            ...runtime.env,
            OPENAI_BASE_URL: "http://127.0.0.1:49001/v1",
            OPENAI_API_KEY: "hermes-forge-local-proxy-key",
          },
        }),
      },
    );

    const runtime = await resolver.resolve();

    expect(runtime.baseUrl).toBe("http://127.0.0.1:49001/v1");
    expect(runtime.env.OPENAI_API_KEY).toBe("hermes-forge-local-proxy-key");
  });

  it("keeps Volcengine coding plan profiles on the coding endpoint URL", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "doubao-coding",
      modelProfiles: [{
        id: "doubao-coding",
        provider: "custom",
        sourceType: "volcengine_coding_api_key",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        model: "doubao-coding",
        secretRef: "provider.volcengine-coding.apiKey",
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "ark-key" } as never,
    );

    const runtime = await resolver.resolve();

    expect(runtime.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/coding/v3");
    expect(runtime.env).toMatchObject({
      AI_PROVIDER: "custom",
      AI_MODEL: "doubao-coding",
      AI_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3",
      OPENAI_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3",
      OPENAI_API_KEY: "ark-key",
    });
  });

  it("exports Kimi Coding provider-specific env so Hermes does not fall back to Moonshot", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "kimi-coding",
      modelProfiles: [{
        id: "kimi-coding",
        provider: "custom",
        sourceType: "kimi_coding_api_key",
        baseUrl: "https://api.kimi.com/coding/v1",
        model: "kimi-k2.6",
        secretRef: "provider.kimi-coding.apiKey",
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "sk-kimi-test" } as never,
    );

    const runtime = await resolver.resolve();

    // KIMI_BASE_URL is stripped of trailing /v1: Hermes Agent treats this
    // endpoint as Anthropic Messages, and the Anthropic SDK appends /v1/messages,
    // so .../coding becomes .../coding/v1/messages (correct), while .../coding/v1
    // would yield .../coding/v1/v1/messages (404).
    expect(runtime.env).toMatchObject({
      AI_PROVIDER: "custom",
      AI_MODEL: "kimi-k2.6",
      KIMI_API_KEY: "sk-kimi-test",
      KIMI_BASE_URL: "https://api.kimi.com/coding",
      OPENAI_API_KEY: "sk-kimi-test",
      OPENAI_BASE_URL: "https://api.kimi.com/coding/v1",
    });
  });

  it("strips trailing /v1 from Kimi base URL even when user already typed it without /v1", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "kimi-coding",
      modelProfiles: [{
        id: "kimi-coding",
        provider: "custom",
        sourceType: "kimi_coding_api_key",
        baseUrl: "https://api.kimi.com/coding",
        model: "kimi-k2.6",
        secretRef: "provider.kimi-coding.apiKey",
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "sk-kimi-test" } as never,
    );

    const runtime = await resolver.resolve();

    expect(runtime.env.KIMI_BASE_URL).toBe("https://api.kimi.com/coding");
  });

  it("exports MiniMax provider-specific env so Hermes sends Authorization", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "minimax-token-plan",
      modelProfiles: [{
        id: "minimax-token-plan",
        provider: "custom",
        sourceType: "minimax_token_plan_api_key",
        baseUrl: "https://api.minimaxi.com/anthropic",
        model: "MiniMax-M2.7",
        secretRef: "provider.minimax-token-plan.apiKey",
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "sk-minimax-test" } as never,
    );

    const runtime = await resolver.resolve();

    expect(runtime.env).toMatchObject({
      AI_PROVIDER: "custom",
      AI_MODEL: "MiniMax-M2.7",
      MINIMAX_API_KEY: "sk-minimax-test",
      ANTHROPIC_API_KEY: "sk-minimax-test",
      ANTHROPIC_AUTH_TOKEN: "sk-minimax-test",
      MINIMAX_BASE_URL: "https://api.minimaxi.com/anthropic",
      AI_BASE_URL: "https://api.minimaxi.com/anthropic",
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      OPENAI_API_KEY: "sk-minimax-test",
      OPENAI_BASE_URL: "https://api.minimaxi.com/v1",
    });
  });

  it("exports MiMo Token Plan env and lets the runtime proxy adapt auth", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "mimo-token-plan",
      modelProfiles: [{
        id: "mimo-token-plan",
        provider: "custom",
        sourceType: "mimo_token_plan_api_key",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        model: "mimo-v2.5-pro",
        secretRef: "provider.mimo-token-plan.apiKey",
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "mimo-key" } as never,
    );

    const runtime = await resolver.resolve();

    expect(runtime.env).toMatchObject({
      AI_PROVIDER: "custom",
      AI_MODEL: "mimo-v2.5-pro",
      MIMO_API_KEY: "mimo-key",
      XIAOMI_API_KEY: "mimo-key",
      OPENAI_API_KEY: "mimo-key",
      OPENAI_BASE_URL: "https://token-plan-cn.xiaomimimo.com/v1",
      AI_BASE_URL: "https://token-plan-cn.xiaomimimo.com/v1",
    });
  });

  it("normalizes old mixed-case MiMo model ids at runtime even with settingsConfig", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "mimo-token-plan",
      modelProfiles: [{
        id: "mimo-token-plan",
        provider: "custom",
        sourceType: "mimo_token_plan_api_key",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        model: "MiMo-V2.5-Pro",
        secretRef: "provider.mimo-token-plan.apiKey",
        settingsConfig: {
          env: {
            AI_PROVIDER: "custom",
            AI_MODEL: "${model}",
            OPENAI_BASE_URL: "${base_url}",
            OPENAI_API_KEY: "${api_key}",
          },
        },
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "mimo-key" } as never,
    );

    const runtime = await resolver.resolve();

    expect(runtime.model).toBe("mimo-v2.5-pro");
    expect(runtime.env.AI_MODEL).toBe("mimo-v2.5-pro");
    expect(runtime.env.MIMO_BASE_URL).toBe("https://token-plan-cn.xiaomimimo.com/v1");
  });

  it("uses provider-specific Kimi runtime env instead of stale settingsConfig templates", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "kimi-coding",
      modelProfiles: [{
        id: "kimi-coding",
        provider: "custom",
        sourceType: "kimi_coding_api_key",
        baseUrl: "https://api.kimi.com/coding/v1",
        model: "kimi-for-coding",
        secretRef: "provider.kimi-coding.apiKey",
        settingsConfig: {
          env: {
            AI_PROVIDER: "custom",
            KIMI_BASE_URL: "https://api.kimi.com/coding/v1",
            OPENAI_BASE_URL: "https://api.kimi.com/coding/v1",
            OPENAI_API_KEY: "${api_key}",
          },
        },
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "sk-kimi-test" } as never,
    );

    const runtime = await resolver.resolve();

    expect(runtime.env.KIMI_BASE_URL).toBe("https://api.kimi.com/coding");
    expect(runtime.env.OPENAI_API_KEY).toBe("sk-kimi-test");
  });

  it("resolves chat and Coding Plan roles to independent model URLs", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "kimi-main",
      modelRoleAssignments: {
        chat: "kimi-main",
        coding_plan: "doubao-coding",
      },
      modelProfiles: [
        {
          id: "kimi-main",
          provider: "custom",
          sourceType: "moonshot_api_key",
          baseUrl: "https://api.moonshot.cn/v1",
          model: "moonshot-v1-128k",
          secretRef: "provider.moonshot.apiKey",
        },
        {
          id: "doubao-coding",
          provider: "custom",
          sourceType: "volcengine_coding_api_key",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
          model: "doubao-coding",
          secretRef: "provider.volcengine-coding.apiKey",
        },
      ],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async (ref: string) => ref.includes("coding") ? "coding-key" : "kimi-key" } as never,
    );

    const chat = await resolver.resolveRoleFromConfig(config, "chat");
    const coding = await resolver.resolveRoleFromConfig(config, "coding_plan");

    expect(chat.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(chat.env.OPENAI_API_KEY).toBe("kimi-key");
    expect(coding.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/coding/v3");
    expect(coding.env.OPENAI_API_KEY).toBe("coding-key");
  });

  it("does not fall back to the chat model when a non-chat role is unassigned", async () => {
    const config: RuntimeConfig = {
      defaultModelProfileId: "chat-main",
      modelRoleAssignments: { chat: "chat-main" },
      modelProfiles: [{
        id: "chat-main",
        provider: "custom",
        sourceType: "moonshot_api_key",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "moonshot-v1-128k",
        secretRef: "provider.moonshot.apiKey",
      }],
      updateSources: {},
    };
    const resolver = new RuntimeEnvResolver(
      { read: async () => config } as never,
      { readSecret: async () => "kimi-key" } as never,
    );

    await expect(resolver.resolveRoleFromConfig(config, "coding_plan")).rejects.toThrow("coding_plan 角色尚未分配模型");
  });
});
