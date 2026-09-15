import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { RuntimeConfig } from "../shared/types";
import { MacosInstallStrategy } from "./macos-install-strategy";
import { AUDITED_HERMES_COMMIT } from "./hermes-version-constants";
import { managedHermesEnvironmentAt } from "../runtime/managed-hermes-environment";
let root = "";
const run = vi.fn();
vi.mock("../process/command-runner", () => ({ runCommand: (...args: unknown[]) => run(...args) }));
vi.mock("../platform", async (original) => ({ ...await original<typeof import("../platform")>(), getDefaultInstallRoot: () => root }));
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-macos-"));
  const env = managedHermesEnvironmentAt(root, "venv", "darwin");
  await fs.mkdir(path.dirname(env.pythonPath), { recursive: true });
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(env.pythonPath, "fixture");
  run.mockReset();
  run.mockImplementation(async (command: string, args: string[]) => ({ exitCode: 0, stderr: "", stdout:
    args[0] === "-I" ? JSON.stringify({ version: [3, 11], basePrefix: path.dirname(root), baseExecutable: path.join(path.dirname(root), "managed-python") }) :
    args[0] === "rev-parse" ? AUDITED_HERMES_COMMIT :
    args[0] === "--version" && path.basename(command) === "hermes" ? "Hermes Agent 0.21.3" :
    args[0] === "-c" ? "hermes-import-ok" : "" }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe("macOS native maintenance", () => {
  it("uses native bin paths and fixed official source without PowerShell or winget", async () => {
    let config: RuntimeConfig = { modelProfiles: [], updateSources: {} };
    const service = new MacosInstallStrategy({ baseDir: () => path.join(root, "data"), hermesDir: () => path.join(root, "home") } as AppPaths,
      { read: async () => config, write: async (value: RuntimeConfig) => { config = value; } } as RuntimeConfigStore);
    const result = await service.update();
    expect(result.ok, result.message).toBe(true);
    expect(config.hermesRuntime?.mode).toBe("darwin");
    expect(config.hermesRuntime?.pythonCommand).toBe(managedHermesEnvironmentAt(root, "venv", "darwin").pythonPath);
    expect(run.mock.calls.some(([cmd]) => /powershell|winget/.test(cmd))).toBe(false);
    expect(run.mock.calls.some(([, args]) => args.includes("stash") || args.includes("--all-extras"))).toBe(false);
  });
});
