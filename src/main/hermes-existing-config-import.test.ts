import { describe, expect, it } from "vitest";
import { testOnly } from "./hermes-existing-config-import";

describe("importExistingHermesConfig helpers", () => {
  it("parses top-level Hermes model block", () => {
    const block = testOnly.parseTopLevelModelBlock([
      "model:",
      "  managed_by: \"Hermes Forge\"",
      "  provider: \"openrouter\"",
      "  default: \"anthropic/claude-sonnet-4-5\"",
      "  base_url: \"https://openrouter.ai/api/v1\"",
      "",
      "memory:",
      "  mode: file",
    ].join("\n"));

    expect(block).toEqual({
      provider: "openrouter",
      defaultModel: "anthropic/claude-sonnet-4-5",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("builds an imported OpenAI-compatible custom profile from Hermes env", () => {
    const profile = testOnly.buildImportedModelProfile(
      {
        AI_PROVIDER: "custom",
        AI_BASE_URL: "https://api.deepseek.com/v1",
        AI_MODEL: "deepseek-chat",
        OPENAI_API_KEY: "sk-test",
      },
      {},
    );

    expect(profile).toMatchObject({
      id: "wizard-deepseek",
      provider: "custom",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      secretRef: "provider.deepseek.apiKey",
    });
  });

  it("keeps anthropic provider when Hermes config explicitly uses anthropic", () => {
    const profile = testOnly.buildImportedModelProfile(
      {
        HERMES_INFERENCE_PROVIDER: "anthropic",
        AI_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "anthropic-secret",
      },
      {
        provider: "anthropic",
      },
    );

    expect(profile).toMatchObject({
      id: "imported-anthropic",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      secretRef: "provider.anthropic.apiKey",
    });
  });
});
