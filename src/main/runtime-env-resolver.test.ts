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
});
