import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HermesModelSyncService, testOnly } from "./hermes-model-sync";
import type { RuntimeConfig } from "../shared/types";

describe("HermesModelSyncService helpers", () => {
  it("replaces only the top-level Hermes model block", () => {
    const original = [
      "model:",
      "  provider: \"openai-codex\"",
      "  default: \"old-model\"",
      "",
      "mcp_servers:",
      "  windows_control_bridge:",
      "    command: \"py\"",
    ].join("\n");

    const next = testOnly.upsertModelBlock(original, {
      provider: "custom",
      model: "gpt-5.4",
      baseUrl: "http://127.0.0.1:8080/v1",
    });

    expect(next).toContain("provider: \"custom\"");
    expect(next).toContain("default: \"gpt-5.4\"");
    expect(next).toContain("base_url: \"http://127.0.0.1:8080/v1\"");
    expect(next).toContain("mcp_servers:");
    expect(next).not.toContain("old-model");
  });

  it("keeps connector env blocks while replacing stale model env", () => {
    const original = [
      "CUSTOM_VALUE=keep",
      "",
      "# >>> Hermes Forge Model Runtime >>>",
      "OPENAI_API_KEY=old",
      "# <<< Hermes Forge Model Runtime <<<",
      "",
      "# >>> Hermes Desktop Connectors >>>",
      "WEIXIN_TOKEN=keep-token",
      "# <<< Hermes Desktop Connectors <<<",
    ].join("\n");

    const next = testOnly.upsertManagedEnvBlock(original, {
      HERMES_INFERENCE_PROVIDER: "custom",
      OPENAI_API_KEY: "pwd",
    });

    expect(next).toContain("CUSTOM_VALUE=keep");
    expect(next).toContain("WEIXIN_TOKEN=keep-token");
    expect(next).toContain("OPENAI_API_KEY=pwd");
    expect(next).not.toContain("OPENAI_API_KEY=old");
  });
});

describe("HermesModelSyncService", () => {
  it("writes the active Hermes profile and maps custom local models for Gateway", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-model-sync-"));
    await fs.mkdir(path.join(home, "profiles", "wechat"), { recursive: true });
    await fs.writeFile(path.join(home, "active_profile"), "wechat", "utf8");

    const config: RuntimeConfig = {
      defaultModelProfileId: "local-gpt",
      modelProfiles: [{
        id: "local-gpt",
        provider: "custom",
        model: "gpt-5.4",
        baseUrl: "http://127.0.0.1:8080/v1",
        secretRef: "provider.local.apiKey",
      }],
      updateSources: {},
    };
    const resolver = {
      resolveFromConfig: async () => ({
        profileId: "local-gpt",
        provider: "custom",
        model: "gpt-5.4",
        baseUrl: "http://127.0.0.1:8080/v1",
        env: {
          AI_PROVIDER: "custom",
          AI_MODEL: "gpt-5.4",
          AI_BASE_URL: "http://127.0.0.1:8080/v1",
          OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
          OPENAI_API_KEY: "pwd",
        },
      }),
    };

    const service = new HermesModelSyncService(resolver as never, () => home);
    const result = await service.syncRuntimeConfig(config);
    const profileHome = path.join(home, "profiles", "wechat");

    expect(result.synced).toBe(true);
    await expect(fs.readFile(path.join(profileHome, "config.yaml"), "utf8")).resolves.toContain("default: \"gpt-5.4\"");
    await expect(fs.readFile(path.join(profileHome, ".env"), "utf8")).resolves.toContain("HERMES_INFERENCE_PROVIDER=custom");
    await expect(fs.readFile(path.join(profileHome, ".env"), "utf8")).resolves.toContain("OPENAI_API_KEY=pwd");
  });

  it("writes the canonical Hermes provider name for Coding Plan chat profiles", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-model-sync-coding-plan-"));
    const config: RuntimeConfig = {
      defaultModelProfileId: "kimi-coding",
      modelProfiles: [{
        id: "kimi-coding",
        provider: "custom",
        sourceType: "kimi_coding_api_key",
        model: "kimi-for-coding",
        baseUrl: "https://api.kimi.com/coding/v1",
        secretRef: "provider.kimi-coding.apiKey",
      }],
      updateSources: {},
    };
    const resolver = {
      resolveFromConfig: async () => ({
        profileId: "kimi-coding",
        provider: "custom",
        sourceType: "kimi_coding_api_key",
        model: "kimi-for-coding",
        baseUrl: "https://api.kimi.com/coding/v1",
        env: {
          AI_PROVIDER: "custom",
          AI_MODEL: "kimi-for-coding",
          OPENAI_BASE_URL: "https://api.kimi.com/coding/v1",
          OPENAI_API_KEY: "sk-kimi",
          KIMI_API_KEY: "sk-kimi",
        },
      }),
    };

    const service = new HermesModelSyncService(resolver as never, () => home);
    const result = await service.syncRuntimeConfig(config);

    expect(result.synced).toBe(true);
    expect(result.roles?.chat?.provider).toBe("kimi-coding");
    const yaml = await fs.readFile(path.join(home, "config.yaml"), "utf8");
    expect(yaml).toContain("provider: \"kimi-coding\"");
    const env = await fs.readFile(path.join(home, ".env"), "utf8");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=kimi-coding");
  });

  it("writes separate chat and Coding Plan runtime env values", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-model-sync-roles-"));
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
          model: "moonshot-v1-128k",
          baseUrl: "https://api.moonshot.cn/v1",
        },
        {
          id: "doubao-coding",
          provider: "custom",
          sourceType: "volcengine_coding_api_key",
          model: "doubao-coding",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        },
      ],
      updateSources: {},
    };
    const resolver = {
      resolveFromConfig: async (_config: RuntimeConfig, profileId: string) => ({
        profileId,
        provider: "custom",
        model: profileId === "doubao-coding" ? "doubao-coding" : "moonshot-v1-128k",
        baseUrl: profileId === "doubao-coding" ? "https://ark.cn-beijing.volces.com/api/coding/v3" : "https://api.moonshot.cn/v1",
        env: {
          AI_PROVIDER: "custom",
          AI_MODEL: profileId === "doubao-coding" ? "doubao-coding" : "moonshot-v1-128k",
          OPENAI_BASE_URL: profileId === "doubao-coding" ? "https://ark.cn-beijing.volces.com/api/coding/v3" : "https://api.moonshot.cn/v1",
          OPENAI_API_KEY: profileId === "doubao-coding" ? "coding-key" : "kimi-key",
        },
      }),
    };

    const service = new HermesModelSyncService(resolver as never, () => home);
    const result = await service.syncRuntimeConfig(config);
    const env = await fs.readFile(path.join(home, ".env"), "utf8");

    expect(result.roles?.chat?.profileId).toBe("kimi-main");
    expect(result.roles?.coding_plan?.profileId).toBe("doubao-coding");
    expect(result.roles?.chat?.consumedByHermes).toBe(true);
    expect(result.roles?.coding_plan?.consumedByHermes).toBe(false);
    expect(result.roles?.coding_plan?.syncNote).toContain("未读取 HERMES_CODING_PLAN");
    expect(env).toContain("HERMES_FORGE_CHAT_MODEL_PROFILE_ID=kimi-main");
    expect(env).toContain("OPENAI_BASE_URL=https://api.moonshot.cn/v1");
    expect(env).toContain("HERMES_FORGE_CODING_PLAN_MODEL_PROFILE_ID=doubao-coding");
    expect(env).toContain("HERMES_CODING_PLAN_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3");
    expect(env).toContain("HERMES_CODING_PLAN_API_KEY=coding-key");
  });

  it("uses provider-specific Coding Plan API keys when generic keys are absent", () => {
    expect(testOnly.resolveCodingPlanApiKey({
      profileId: "coding",
      provider: "custom",
      model: "doubao",
      env: { VOLCENGINE_API_KEY: "volc-key" },
    })).toBe("volc-key");
    expect(testOnly.resolveCodingPlanApiKey({
      profileId: "coding",
      provider: "custom",
      model: "kimi",
      env: { KIMI_API_KEY: "kimi-key" },
    })).toBe("kimi-key");
  });
});
