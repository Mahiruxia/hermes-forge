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
});
