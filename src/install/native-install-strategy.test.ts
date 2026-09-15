import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { RuntimeConfig } from "../shared/types";
import { managedHermesEnvironmentAt } from "../runtime/managed-hermes-environment";
import { NativeInstallStrategy } from "./native-install-strategy";
import { AUDITED_HERMES_COMMIT, AUDITED_HERMES_RELEASE_TAG } from "./hermes-version-constants";

const runCommandMock = vi.fn();
vi.mock("../process/command-runner", () => ({
  runCommand: (...args: unknown[]) => runCommandMock(...args),
  streamCommand: async function* (...args: unknown[]) {
    const result = await runCommandMock(...args);
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) yield { type: "stdout", line };
    for (const line of result.stderr.split(/\r?\n/).filter(Boolean)) yield { type: "stderr", line };
    yield { type: "exit", exitCode: result.exitCode };
  },
}));

let tempRoot = "";
let rootPath = "";
let config: RuntimeConfig;
const success = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const stageScript = "param([string]$Stage,[switch]$NonInteractive,[switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)";
const basePython = path.resolve("test-managed-base", "python.exe");
const describeWindows = process.platform === "win32" ? describe : describe.skip;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-install-test-"));
  rootPath = path.join(tempRoot, "Hermes Agent");
  config = { modelProfiles: [], updateSources: {}, enginePaths: { hermes: rootPath } };
  runCommandMock.mockReset();
  runCommandMock.mockImplementation(async (command: string, args: string[], options: { cwd: string }) => {
    if (args[0] === "-I") return success(JSON.stringify({ version: [3, 13], basePrefix: path.dirname(basePython), baseExecutable: basePython }));
    if (command === "powershell.exe" && args.some((arg) => arg.includes("Invoke-WebRequest"))) {
      const destination = /-OutFile '([^']+)'/.exec(args.at(-1)!)?.[1];
      if (destination) await fs.writeFile(destination, stageScript);
      return success("downloaded");
    }
    if (command === "powershell.exe" && args.includes("-Stage")) return success(JSON.stringify({ stage: args[args.indexOf("-Stage") + 1], ok: true }));
    if (command === "git" && args[0] === "init") {
      await fs.mkdir(path.join(options.cwd, ".git"), { recursive: true });
      return success();
    }
    if (command === "git" && args[0] === "checkout") {
      await fs.writeFile(path.join(rootPath, "pyproject.toml"), "[project]\nname='hermes-agent'\nversion='0.21.3'");
      await fs.writeFile(path.join(rootPath, "run_agent.py"), "class AIAgent: pass");
      return success();
    }
    if (command === "git" && args[0] === "rev-parse") return success(AUDITED_HERMES_COMMIT);
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") return success("https://github.com/NousResearch/hermes-agent.git");
    if (/uv(?:\.exe)?$/i.test(command) && args[0] === "venv") {
      const environment = managedHermesEnvironmentAt(rootPath);
      await fs.mkdir(path.dirname(environment.pythonPath), { recursive: true });
      await fs.writeFile(environment.pythonPath, "fixture");
      return success();
    }
    if (/uv(?:\.exe)?$/i.test(command) && args[0] === "sync") {
      const environment = managedHermesEnvironmentAt(rootPath);
      await fs.writeFile(environment.cliPath, "fixture");
      return success();
    }
    if (/hermes\.exe$/i.test(command) && args[0] === "--version") return success("Hermes Agent 0.21.3");
    if (args[0] === "-c" && args[1].includes("hermes-import-ok")) return success("hermes-import-ok");
    return success();
  });
});
afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function strategy() {
  const appPaths = { baseDir: () => path.join(tempRoot, "app"), hermesDir: () => path.join(tempRoot, "home") } as AppPaths;
  const store = { read: async () => config, getEnginePath: async () => rootPath, write: async (next: RuntimeConfig) => { config = next; } } as RuntimeConfigStore;
  return new NativeInstallStrategy(appPaths, {} as EngineAdapter, store);
}

describeWindows("native official installation", () => {
  it("bootstraps only uv and git then syncs the exact official commit and selected venv", async () => {
    const result = await strategy().install();
    expect(result.ok, result.message).toBe(true);
    const stageCalls = runCommandMock.mock.calls.filter(([command, args]) => command === "powershell.exe" && args.includes("-Stage"));
    expect(stageCalls.map(([, args]) => args[args.indexOf("-Stage") + 1])).toEqual(["uv", "git"]);
    expect(stageCalls.every(([, args]) => args.includes("-NonInteractive"))).toBe(true);
    expect(runCommandMock).toHaveBeenCalledWith("git", ["checkout", "--detach", AUDITED_HERMES_COMMIT], expect.anything());
    const sync = runCommandMock.mock.calls.find(([, args]) => args[0] === "sync")!;
    expect(sync[1]).toEqual(["sync", "--locked", "--no-dev", "--python", basePython, "--extra", "mcp"]);
    expect(config.hermesRuntime?.installSource).toMatchObject({ branch: AUDITED_HERMES_RELEASE_TAG, commit: AUDITED_HERMES_COMMIT });
  });

  it("refuses old scripts instead of running a full installer that creates backups or all extras", async () => {
    const base = runCommandMock.getMockImplementation()!;
    runCommandMock.mockImplementation(async (...args: Parameters<typeof base>) => {
      const result = await base(...args);
      const values = args[1] as string[];
      if (values.some((arg) => arg.includes("Invoke-WebRequest"))) {
        const destination = /-OutFile '([^']+)'/.exec(values.at(-1)!)?.[1];
        if (destination) await fs.writeFile(destination, "param([switch]$SkipSetup)");
      }
      return result;
    });
    const result = await strategy().install();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("分阶段");
    expect(runCommandMock.mock.calls.some(([, args]) => args.includes("-File"))).toBe(false);
  });

  it("does not report success when an installer stage swallows an error", async () => {
    const base = runCommandMock.getMockImplementation()!;
    runCommandMock.mockImplementation(async (...args: Parameters<typeof base>) => {
      const values = args[1] as string[];
      if (values.includes("-Stage")) return success(JSON.stringify({ stage: values[values.indexOf("-Stage") + 1], ok: false }));
      return base(...args);
    });
    const result = await strategy().install();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("未返回成功结果");
    expect(config.hermesRuntime).toBeUndefined();
  });

  it("does not overwrite an unrelated non-empty directory", async () => {
    await fs.mkdir(rootPath);
    await fs.writeFile(path.join(rootPath, "user.txt"), "keep");
    const result = await strategy().install();
    expect(result.ok).toBe(false);
    expect(await fs.readFile(path.join(rootPath, "user.txt"), "utf8")).toBe("keep");
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("leaves failed dependency synchronization resumable and never saves a successful install", async () => {
    const base = runCommandMock.getMockImplementation()!;
    runCommandMock.mockImplementation(async (...args: Parameters<typeof base>) => {
      if ((args[1] as string[])[0] === "sync") return { exitCode: 1, stdout: "", stderr: "network unavailable" };
      return base(...args);
    });
    const result = await strategy().install();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("network unavailable");
    expect(config.hermesRuntime).toBeUndefined();
    expect(await fs.stat(path.join(rootPath, ".git"))).toBeTruthy();
    expect(runCommandMock.mock.calls.some(([, args]) => args.includes("stash") || args.includes("uninstall"))).toBe(false);
  });

  it("updates a detached existing installation without invoking the bootstrap installer", async () => {
    const environment = managedHermesEnvironmentAt(rootPath);
    await fs.mkdir(path.dirname(environment.pythonPath), { recursive: true });
    await fs.mkdir(path.join(rootPath, ".git"));
    await fs.writeFile(environment.pythonPath, "fixture");
    await fs.writeFile(environment.cliPath, "fixture");
    const result = await strategy().update();
    expect(result.ok, result.message).toBe(true);
    expect(runCommandMock.mock.calls.some(([, args]) => args.includes("-File") || args.includes("stash") || args.includes("pull"))).toBe(false);
    expect(runCommandMock).toHaveBeenCalledWith("git", ["checkout", "--detach", AUDITED_HERMES_COMMIT], expect.anything());
  });
});
