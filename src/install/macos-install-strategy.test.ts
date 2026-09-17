import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { RuntimeConfig } from "../shared/types";
import { MacosInstallStrategy } from "./macos-install-strategy";
import { AUDITED_HERMES_COMMIT } from "./hermes-version-constants";
import { managedHermesEnvironmentAt } from "../runtime/managed-hermes-environment";
let root = "";
const run = vi.fn();
vi.mock("../process/command-runner", () => ({
  runCommand: (...args: unknown[]) => run(...args),
  streamCommand: async function* (...args: unknown[]) {
    const result = await run(...args);
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) yield { type: "stdout", line };
    for (const line of result.stderr.split(/\r?\n/).filter(Boolean)) yield { type: "stderr", line };
    yield { type: "exit", exitCode: result.exitCode };
  },
}));
vi.mock("../platform", async (original) => ({ ...await original<typeof import("../platform")>(), getDefaultInstallRoot: () => root }));
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-macos-"));
  const env = managedHermesEnvironmentAt(root, "venv", "darwin");
  await fs.mkdir(path.dirname(env.pythonPath), { recursive: true });
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "run_agent.py"), "class AIAgent: pass");
  await fs.writeFile(env.pythonPath, "fixture");
  run.mockReset();
  run.mockImplementation(async (command: string, args: string[]) => ({ exitCode: 0, stderr: "", stdout:
    args[0] === "-I" ? JSON.stringify({ version: [3, 11], basePrefix: path.dirname(root), baseExecutable: path.join(path.dirname(root), "managed-python") }) :
    args[0] === "rev-parse" ? AUDITED_HERMES_COMMIT :
    args[0] === "--version" && path.basename(command) === "hermes" ? "Hermes Agent 0.21.3" :
    args[0] === "-c" ? "hermes-import-ok" : "" }));
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
describe("macOS native maintenance", () => {
  it("leaves an unrelated Git repository untouched", async () => {
    await fs.unlink(path.join(root, "run_agent.py"));
    const service = new MacosInstallStrategy({ baseDir: () => path.join(root, "data") } as AppPaths,
      { read: async () => ({ modelProfiles: [], updateSources: {} }), write: vi.fn() } as unknown as RuntimeConfigStore);
    const result = await service.install();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("目标 Git 仓库不是 Hermes");
    expect(run.mock.calls.some(([, args]) => ["remote", "fetch", "checkout"].includes(args[0]))).toBe(false);
  });
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
    expect(run.mock.calls.some(([cmd]) => cmd === "/usr/bin/curl")).toBe(false);
  });

  it.each([true, false])("bootstraps missing uv only after installer integrity verification: %s", async (validDigest) => {
    const originalRun = run.getMockImplementation()!;
    let bootstrapped = false;
    run.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (args[0] === "--version" && /uv(?:\.exe)?$/.test(command) && !bootstrapped) return { exitCode: 1, stdout: "", stderr: "missing uv" };
      if (command === "/usr/bin/curl") await fs.writeFile(args[args.indexOf("--output") + 1], "installer fixture");
      if (command === "/bin/sh") bootstrapped = true;
      return originalRun(command, args, options);
    });
    if (validDigest) vi.spyOn(crypto, "createHash").mockReturnValue({ update: () => ({ digest: () => "716a1d6844740756c68770fcec2f79c2013fb9b03869a113f61e15f6f482a6a1" }) } as never);
    const service = new MacosInstallStrategy({ baseDir: () => path.join(root, "data"), hermesDir: () => path.join(root, "home") } as AppPaths,
      { read: async () => ({ modelProfiles: [], updateSources: {} }), write: vi.fn() } as unknown as RuntimeConfigStore);
    const result = await service.install();
    expect(result.ok, result.message).toBe(validDigest);
    expect(bootstrapped).toBe(validDigest);
    if (validDigest) expect(run.mock.calls.find(([cmd]) => cmd === "/bin/sh")?.[2].env).toMatchObject({ UV_UNMANAGED_INSTALL: path.join(path.dirname(root), "bin"), UV_NO_MODIFY_PATH: "1" });
    else expect(result.message).toContain("校验失败");
  });
});
