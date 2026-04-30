import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testOnly } from "./hermes-existing-config-import";
import { stableModelProfileId } from "../shared/model-config";

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
      id: stableModelProfileId({ provider: "custom", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }),
      provider: "custom",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      secretRef: "provider.deepseek.apiKey",
    });
  });

  it("falls back to legacy cli-config.yaml when config.yaml is absent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-import-"));
    try {
      await fs.writeFile(path.join(dir, "cli-config.yaml"), "model:\n  default: old-model\n", "utf8");
      await expect(testOnly.resolveHermesConfigPath(dir)).resolves.toBe(path.join(dir, "cli-config.yaml"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("recognizes MiniMax minimaxi.com endpoints when importing the active Hermes model", () => {
    const profile = testOnly.buildImportedModelProfile(
      {
        AI_PROVIDER: "custom",
        AI_BASE_URL: "https://api.minimaxi.com/v1",
        AI_MODEL: "MiniMax-M2.7",
        OPENAI_API_KEY: "sk-test",
      },
      {},
    );

    expect(profile).toMatchObject({
      id: stableModelProfileId({ provider: "custom", model: "MiniMax-M2.7", baseUrl: "https://api.minimaxi.com/v1" }),
      provider: "custom",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M2.7",
      secretRef: "provider.minimax.apiKey",
    });
  });

  it.each([
    ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat", "provider.deepseek.apiKey"],
    ["DashScope/Qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", "provider.qwen.apiKey"],
    ["Moonshot/Kimi", "https://api.moonshot.cn/v1", "kimi-k2", "provider.kimi.apiKey"],
    ["Volcengine", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1-6", "provider.volcengine.apiKey"],
    ["Volcengine Coding", "https://ark.cn-beijing.volces.com/api/coding/v3", "doubao-coding", "provider.volcengine-coding.apiKey"],
    ["Tencent Hunyuan", "https://hunyuan.cloud.tencent.com/v1", "hunyuan-turbos-latest", "provider.tencent-hunyuan.apiKey"],
    ["MiniMax", "https://api.minimaxi.com/v1", "MiniMax-M2.7", "provider.minimax.apiKey"],
    ["SiliconFlow", "https://api.siliconflow.cn/v1", "Qwen/Qwen3-Coder", "provider.siliconflow.apiKey"],
    ["Zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-4.6", "provider.zhipu.apiKey"],
  ])("imports %s coding model endpoint into a stable saved model profile", (_label, baseUrl, model, secretRef) => {
    const profile = testOnly.buildImportedModelProfile(
      {
        AI_PROVIDER: "custom",
        AI_BASE_URL: baseUrl,
        AI_MODEL: model,
        OPENAI_API_KEY: "sk-test",
      },
      {},
    );

    expect(profile).toMatchObject({
      id: stableModelProfileId({ provider: "custom", model, baseUrl }),
      provider: "custom",
      baseUrl,
      model,
      secretRef,
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
      id: stableModelProfileId({ provider: "anthropic", model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com/v1" }),
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      secretRef: "provider.anthropic.apiKey",
    });
  });
});
