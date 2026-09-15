// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesConnectorService } from "./hermes-connector-service";
import { HermesModelSyncService } from "./hermes-model-sync";
import { atomicWriteText, withHermesHomeLock } from "./hermes-config-files";
import type { RuntimeConfig } from "../shared/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-config-queue-"));
  roots.push(root);
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const connectors = new HermesConnectorService({ baseDir: () => root, hermesDir: () => home } as never, {
    hasSecret: async () => true, readSecret: async () => "connector-secret",
  } as never, async () => { throw new Error("no Python during config sync"); });
  const config: RuntimeConfig = { defaultModelProfileId: "chat", modelProfiles: [{ id: "chat", provider: "custom", model: "model-a", baseUrl: "https://example.test/v1" }], updateSources: {} };
  const models = new HermesModelSyncService({ resolveFromConfig: async () => ({ profileId: "chat", provider: "custom", model: "model-a", baseUrl: "https://example.test/v1", env: { OPENAI_API_KEY: "model-secret" } }) } as never, () => home);
  return { root, home, connectors, config, models };
}

describe("Hermes configuration writers", () => {
  it("keeps model and connector edits when both services update the same home concurrently", async () => {
    const { root, home, connectors, config, models } = await harness();
    await fs.writeFile(path.join(root, "connectors-config.json"), JSON.stringify({ platforms: { telegram: { enabled: true, values: {}, secretRefs: { botToken: "telegram.token" } } } }));
    await fs.writeFile(path.join(home, ".env"), "CUSTOM_KEEP=unchanged\n");
    await fs.writeFile(path.join(home, "config.yaml"), "auxiliary:\n  vision:\n    provider: keep-provider\nfallback_providers:\n  - model: fallback-model\n");
    await Promise.all([models.syncRuntimeConfig(config), connectors.syncEnv(), models.syncRuntimeConfig(config), connectors.syncEnv()]);
    const env = await fs.readFile(path.join(home, ".env"), "utf8");
    expect(env).toContain("CUSTOM_KEEP=unchanged");
    expect(env).toContain("TELEGRAM_BOT_TOKEN=connector-secret");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=custom");
    const yaml = await fs.readFile(path.join(home, "config.yaml"), "utf8");
    expect(yaml).toContain("keep-provider");
    expect(yaml).toContain("fallback-model");
    expect((await fs.readdir(home)).some((name) => /backup|\.tmp$/.test(name))).toBe(false);
  });

  it("does not modify config when reading the second input fails", async () => {
    const { home, models, config } = await harness();
    await fs.writeFile(path.join(home, "config.yaml"), "unknown: keep\n");
    await fs.mkdir(path.join(home, ".env"));
    await expect(models.syncRuntimeConfig(config)).rejects.toThrow();
    expect(await fs.readFile(path.join(home, "config.yaml"), "utf8")).toBe("unknown: keep\n");
  });

  it("releases the shared writer queue after a failed operation", async () => {
    const { home } = await harness();
    await expect(withHermesHomeLock(home, async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
    await withHermesHomeLock(home, () => atomicWriteText(path.join(home, "config.yaml"), "recovered: true\n"));
    expect(await fs.readFile(path.join(home, "config.yaml"), "utf8")).toContain("recovered");
  });

  it("refreshes an existing Feishu fallback copy after its profile changes", async () => {
    const { root, connectors } = await harness();
    const source = path.join(root, "profile.yaml");
    const target = path.join(root, "copied.yaml");
    await fs.writeFile(source, "model: new-model\n");
    await fs.writeFile(target, "model: stale-model\n");
    await (connectors as unknown as { ensureProfileFileLink(source: string, target: string): Promise<void> }).ensureProfileFileLink(source, target);
    expect(await fs.readFile(target, "utf8")).toBe("model: new-model\n");
  });

  it("never starts a CLI from passive Gateway status reads", async () => {
    const { connectors } = await harness();
    const internals = connectors as unknown as { gatewayCliStatus(): Promise<undefined>; gatewayStateStatus(): Promise<undefined> };
    const cli = vi.spyOn(internals, "gatewayCliStatus").mockResolvedValue(undefined);
    vi.spyOn(internals, "gatewayStateStatus").mockResolvedValue(undefined);
    for (let minute = 0; minute < 5; minute += 1) {
      for (let interval = 0; interval < 4; interval += 1) await connectors.status();
    }
    expect(cli).not.toHaveBeenCalled();
    await Promise.all([connectors.status({ refresh: true }), connectors.status({ refresh: true })]);
    expect(cli).toHaveBeenCalledOnce();
  });
});
