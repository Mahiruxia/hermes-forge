import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../process/command-runner", () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from "../process/command-runner";
import { __resetPreferredHermesRuntimeCacheForTests, RuntimeConfigStore } from "./runtime-config";

const runCommandMock = vi.mocked(runCommand);
const tempDirs: string[] = [];

afterEach(async () => {
  __resetPreferredHermesRuntimeCacheForTests();
  runCommandMock.mockReset();
  delete process.env.HERMES_FORGE_DETECT_PREFERRED_RUNTIME_ON_STARTUP;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("RuntimeConfigStore preferred runtime", () => {
  it("uses WSL as the startup-safe default without probing on first run", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-config-"));
    tempDirs.push(dir);

    const store = new RuntimeConfigStore(path.join(dir, "config.json"));
    const config = await store.read();

    expect(config.hermesRuntime?.mode).toBe("wsl");
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(config.hermesRuntime?.installSource).toMatchObject({
      sourceLabel: "pinned",
      repoUrl: "https://github.com/Mahiruxia/hermes-agent.git",
      commit: "0537bad534a7ce43d683f06f8ebdf7ff9dfb4816",
    });
  });

  it("defaults to WSL when explicit startup detection is enabled and WSL has distros", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-config-"));
    tempDirs.push(dir);
    process.env.HERMES_FORGE_DETECT_PREFERRED_RUNTIME_ON_STARTUP = "1";
    runCommandMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "Default Distribution: Ubuntu", stderr: "" } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "Ubuntu\n", stderr: "" } as never);

    const store = new RuntimeConfigStore(path.join(dir, "config.json"));
    const config = await store.read();

    expect(config.hermesRuntime?.mode).toBe("wsl");
    expect(config.hermesRuntime?.distro).toBe("Ubuntu");
    expect(config.hermesRuntime?.installSource).toMatchObject({
      sourceLabel: "pinned",
      repoUrl: "https://github.com/Mahiruxia/hermes-agent.git",
      commit: "0537bad534a7ce43d683f06f8ebdf7ff9dfb4816",
    });
  });

  it("keeps WSL default without startup probing when explicit detection is disabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-config-"));
    tempDirs.push(dir);
    runCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "wsl unavailable" } as never)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" } as never);

    const store = new RuntimeConfigStore(path.join(dir, "config.json"));
    const config = await store.read();

    expect(config.hermesRuntime?.mode).toBe("wsl");
    expect(runCommandMock).not.toHaveBeenCalled();
    expect(config.hermesRuntime?.installSource).toMatchObject({
      sourceLabel: "pinned",
      repoUrl: "https://github.com/Mahiruxia/hermes-agent.git",
      commit: "0537bad534a7ce43d683f06f8ebdf7ff9dfb4816",
    });
  });

  it("migrates legacy model profiles with missing ids instead of dropping config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({
      defaultModel: "gpt-5.4",
      modelProfiles: [
        { provider: "openai", model: "gpt-5.4", baseUrl: "https://api.openai.com/v1" },
      ],
      updateSources: {},
    }), "utf8");
    runCommandMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" } as never)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" } as never);

    const store = new RuntimeConfigStore(configPath);
    const config = await store.read();

    expect(config.modelProfiles[0].id).toMatch(/^model-/);
    expect(config.defaultModelProfileId).toBe(config.modelProfiles[0].id);
  });

  it("backs up invalid JSON and resets to default config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await fs.writeFile(configPath, "{not json", "utf8");

    const store = new RuntimeConfigStore(configPath);
    const config = await store.read();
    const backups = await fs.readdir(dir);

    expect(config.defaultModelProfileId).toBe("default-local");
    expect(backups.some((name) => name.startsWith("config.json.bak."))).toBe(true);
    expect(store.getLastRecovery()).toMatchObject({ reason: "invalid_json", configPath });
    await expect(fs.readFile(configPath, "utf8")).resolves.toContain("default-local");
  });

  it("backs up schema-invalid config and resets to default config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({
      modelProfiles: [{ id: "bad", provider: "openai", model: "gpt-5.4" }],
      updateSources: { hermes: "not a url" },
    }), "utf8");

    const store = new RuntimeConfigStore(configPath);
    const config = await store.read();
    const recovery = store.consumeLastRecovery();

    expect(config.defaultModelProfileId).toBe("default-local");
    expect(recovery).toMatchObject({ reason: "schema_validation_failed", configPath });
    expect(recovery?.backupPath).toContain("config.json.bak.");
  });
});
