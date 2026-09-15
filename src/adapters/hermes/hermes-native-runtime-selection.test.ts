import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesCliAdapter } from "./hermes-cli-adapter";
import { NativeRuntimeAdapter } from "../../runtime/native-runtime-adapter";
import { managedHermesEnvironmentAt } from "../../runtime/managed-hermes-environment";
import type { HermesRuntimeConfig } from "../../shared/types";

let root = "";
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-native-selection-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const runtime: HermesRuntimeConfig = { mode: process.platform === "darwin" ? "darwin" : "windows", pythonCommand: "system-python", windowsAgentMode: "hermes_native" };

async function fixture(name: "venv" | ".venv") {
  const environment = managedHermesEnvironmentAt(root, name);
  await fs.mkdir(path.dirname(environment.pythonPath), { recursive: true });
  await fs.writeFile(environment.pythonPath, "fixture");
  await fs.writeFile(environment.cliPath, "fixture");
  return environment;
}

function adapter() {
  return new HermesCliAdapter({
    baseDir: () => root,
    hermesDir: () => path.join(root, "profile"),
    sessionDir: () => path.join(root, "session"),
  } as never, {} as never, async () => root) as unknown as {
    windowsPythonSpec(rootPath: string, cliPath: string, env: NodeJS.ProcessEnv): Promise<{ command: string; env: NodeJS.ProcessEnv }>;
    launchSpec(runtime: HermesRuntimeConfig, rootPath: string, args: string[], cwd: string): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
  };
}

async function nativeSpec(instance: ReturnType<typeof adapter>) {
  return instance.windowsPythonSpec(root, "stale-cli", { VIRTUAL_ENV: "stale-env", PYTHONHOME: "stale-home" });
}

describe("Hermes actual native process environment", () => {
  it("uses the repaired venv in both the wrapper launch and the native runtime adapter", async () => {
    await fixture(".venv");
    const selected = await fixture("venv");
    const wrapperLaunch = await nativeSpec(adapter());
    expect(wrapperLaunch).toMatchObject({ command: selected.pythonPath,
      env: { VIRTUAL_ENV: selected.venvPath, UV_PROJECT_ENVIRONMENT: selected.venvPath, PYTHONHOME: undefined },
    });
    const native = new NativeRuntimeAdapter(runtime, {} as never, {} as never);
    const launch = await native.buildPythonLaunch({ runtime, rootPath: root, pythonArgs: ["-c", "pass"], cwd: root, env: { VIRTUAL_ENV: "stale-env" } });
    expect(launch.command).toBe(selected.pythonPath);
    expect(launch.env?.VIRTUAL_ENV).toBe(selected.venvPath);
  });

  it("reselects after repair instead of retaining a cached .venv interpreter", async () => {
    const old = await fixture(".venv");
    const instance = adapter();
    expect((await nativeSpec(instance)).command).toBe(old.pythonPath);
    const repaired = await fixture("venv");
    expect((await nativeSpec(instance)).command).toBe(repaired.pythonPath);
  });

  it("fails before spawning when the managed environment is missing", async () => {
    await expect(nativeSpec(adapter())).rejects.toThrow("受管虚拟环境");
  });

  it("uses the selected CLI executable when a runtime adapter factory is absent", async () => {
    const selected = await fixture("venv");
    const old = await fixture(".venv");
    const launch = await adapter().launchSpec(runtime, root, [old.cliPath, "--version"], root);
    expect(launch).toMatchObject({ command: selected.cliPath, args: ["--version"], env: { VIRTUAL_ENV: selected.venvPath } });
  });
});
