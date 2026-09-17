import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { RuntimeConfig } from "../shared/types";
import { managedHermesEnvironmentAt } from "../runtime/managed-hermes-environment";
import { AUDITED_HERMES_COMMIT } from "./hermes-version-constants";
import { DEFAULT_PINNED_HERMES_SOURCE } from "./install-source";
import { configuredHermesExtras, synchronizeHermesDependencies, synchronizeHermesSource, type MaintenanceRunner } from "./hermes-maintenance";

const success = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const basePython = path.resolve("test-uv-python", "python.exe");
const interpreter = () => success(JSON.stringify({ version: [3, 13], basePrefix: path.dirname(basePython), baseExecutable: basePython }));

function gitRunner(status = "") {
  return vi.fn<MaintenanceRunner>().mockImplementation(async (_command, args) => {
    if (args[0] === "status") return success(status);
    if (args[0] === "rev-parse") return success(AUDITED_HERMES_COMMIT);
    return success();
  });
}

describe("in-place Hermes source update", () => {
  it("updates detached installations to an exact SHA without pulling a branch or using stash", async () => {
    const run = gitRunner();
    expect(await synchronizeHermesSource(DEFAULT_PINNED_HERMES_SOURCE, run)).toBe(AUDITED_HERMES_COMMIT);
    expect(run).toHaveBeenCalledWith("git", ["checkout", "--detach", AUDITED_HERMES_COMMIT], undefined);
    expect(run.mock.calls.flatMap((call) => call[1])).not.toEqual(expect.arrayContaining(["stash", "pull", "reset"]));
  });

  it("rejects tracked source edits before changing the repository", async () => {
    const run = gitRunner(" M run_agent.py\n M uv.lock\n");
    await expect(synchronizeHermesSource(DEFAULT_PINNED_HERMES_SOURCE, run)).rejects.toThrow("本地修改");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("restores only uv.lock after the requested SHA has been fetched and verified", async () => {
    const run = gitRunner(" M uv.lock\n");
    await synchronizeHermesSource(DEFAULT_PINNED_HERMES_SOURCE, run);
    const args = run.mock.calls.map((call) => call[1]);
    const restore = args.findIndex((call) => call[0] === "restore");
    const fetch = args.findIndex((call) => call[0] === "fetch");
    expect(restore).toBeGreaterThan(fetch);
    expect(args[restore]).toEqual(["restore", "--source=HEAD", "--staged", "--worktree", "--", "uv.lock"]);
    expect(args.some((call) => call[0] === "stash")).toBe(false);
  });

  it("does not reset a dirty lockfile when fetch fails, and can be retried", async () => {
    const run = gitRunner(" M uv.lock");
    run.mockImplementation(async (_command, args) => args[0] === "status" ? success(" M uv.lock") : args[0] === "fetch" ? { exitCode: 1, stdout: "", stderr: "offline" } : success());
    await expect(synchronizeHermesSource(DEFAULT_PINNED_HERMES_SOURCE, run)).rejects.toThrow("offline");
    expect(run.mock.calls.some((call) => call[1][0] === "restore" || call[1][0] === "checkout")).toBe(false);
  });

  it("refuses a mismatching commit before checkout", async () => {
    const run = gitRunner();
    run.mockImplementation(async (_command, args) => success(args[0] === "rev-parse" ? "a".repeat(40) : ""));
    await expect(synchronizeHermesSource(DEFAULT_PINNED_HERMES_SOURCE, run)).rejects.toThrow("不一致");
    expect(run.mock.calls.some((call) => call[1][0] === "checkout")).toBe(false);
  });

  it("resumes an initialized repository when cancellation happened before adding origin", async () => {
    const run = gitRunner();
    run.mockImplementation(async (_command, args) => {
      if (args[0] === "remote" && args[1] === "get-url") return { exitCode: 2, stdout: "", stderr: "No such remote" };
      return success(args[0] === "rev-parse" ? AUDITED_HERMES_COMMIT : "");
    });
    await synchronizeHermesSource(DEFAULT_PINNED_HERMES_SOURCE, run);
    expect(run).toHaveBeenCalledWith("git", ["remote", "add", "origin", DEFAULT_PINNED_HERMES_SOURCE.repoUrl], undefined);
  });
});

describe("managed dependencies", () => {
  it("keeps Anthropic SDK for the selected Kimi Coding profile stored as provider custom", () => {
    const config: RuntimeConfig = {
      modelProfiles: [{ id: "kimi", provider: "custom", sourceType: "kimi_coding_api_key", model: "kimi-for-coding", baseUrl: "https://api.kimi.com/coding/v1" }],
      defaultModelProfileId: "kimi", modelRoleAssignments: { chat: "kimi", coding_plan: "kimi" }, updateSources: {},
      extensionSettings: { connectorsEnabled: true, cronEnabled: false, desktopAutomationEnabled: false },
    };
    expect(configuredHermesExtras(config, { platforms: { weixin: { enabled: true } } })).toEqual(["anthropic", "mcp", "messaging"]);
  });

  it("prepares both chat SDKs before onboarding chooses its first model", () => {
    const config: RuntimeConfig = {
      modelProfiles: [
        { id: "local", provider: "local", model: "local" },
        { id: "mini", provider: "custom", sourceType: "minimax_coding_api_key", model: "MiniMax-M2.7" },
        { id: "proxy", provider: "custom", model: "claude", baseUrl: "https://proxy.example.test/anthropic/v1" },
      ], defaultModelProfileId: "local", updateSources: {},
    };
    expect(configuredHermesExtras(config)).toEqual(["anthropic", "mcp"]);
    config.modelRoleAssignments = { coding_plan: "mini" };
    expect(configuredHermesExtras(config)).toEqual(["anthropic", "mcp"]);
    config.modelRoleAssignments = { chat: "proxy" };
    expect(configuredHermesExtras(config)).toEqual(["anthropic", "mcp"]);
  });

  it("uses the selected Python and lockfile for sync and verification without development extras", async () => {
    const run = vi.fn<MaintenanceRunner>().mockImplementation(async (_command, args) => args[0] === "-I" ? interpreter() : success());
    const environment = managedHermesEnvironmentAt("C:/Hermes Agent");
    await synchronizeHermesDependencies(environment, ["mcp"], run);
    const sync = run.mock.calls.find((call) => call[1][0] === "sync")!;
    expect(sync[1]).toEqual(["sync", "--locked", "--no-dev", "--python", basePython, "--extra", "mcp"]);
    expect(sync[2]).toMatchObject({ VIRTUAL_ENV: environment.venvPath, UV_PROJECT_ENVIRONMENT: environment.venvPath, UV_PYTHON: basePython });
    expect(run.mock.calls.find((call) => call[1][0] === "pip")?.[1]).toEqual(["pip", "check", "--python", environment.pythonPath]);
  });

  it("fails dependency maintenance without falling back to a system pip install", async () => {
    const run = vi.fn<MaintenanceRunner>().mockImplementation(async (_command, args) => args[0] === "-I" ? interpreter() : args[0] === "sync" ? { exitCode: 1, stdout: "", stderr: "lock mismatch" } : success());
    await expect(synchronizeHermesDependencies(managedHermesEnvironmentAt("C:/Hermes"), ["mcp"], run)).rejects.toThrow("lock mismatch");
    expect(run.mock.calls.some((call) => call[1].includes("install") || call[1].includes("uninstall"))).toBe(false);
  });

  it("keeps disabled connectors out and installs only configured active extras", () => {
    const config: RuntimeConfig = { modelProfiles: [], updateSources: {}, extensionSettings: { connectorsEnabled: false, cronEnabled: false, desktopAutomationEnabled: false } };
    const connectors = { platforms: { feishu: { enabled: true }, telegram: { enabled: false }, slack: { enabled: true } } };
    expect(configuredHermesExtras(config, connectors)).toEqual(["anthropic", "mcp"]);
    config.extensionSettings!.connectorsEnabled = true;
    expect(configuredHermesExtras(config, connectors)).toEqual(["anthropic", "feishu", "mcp", "slack"]);
    expect(configuredHermesExtras(config, connectors)).not.toContain("all");
  });

  it("does not enable an extension from child instances when its platform is disabled", () => {
    const config: RuntimeConfig = { modelProfiles: [], updateSources: {}, extensionSettings: { connectorsEnabled: true, cronEnabled: false, desktopAutomationEnabled: false } };
    expect(configuredHermesExtras(config, { platforms: { feishu: { enabled: false, instances: { primary: { enabled: true } } } } })).toEqual(["anthropic", "mcp"]);
  });

  it("verifies a managed replacement before rebuilding a Windows Store based venv", async () => {
    const environment = managedHermesEnvironmentAt(path.resolve("missing-store-test-root"));
    let rebuilt = false;
    const run = vi.fn<MaintenanceRunner>().mockImplementation(async (command, args) => {
      if (args[0] === "-I") {
        if (command === environment.pythonPath && !rebuilt) return success(JSON.stringify({ version: [3, 13], basePrefix: "C:/Program Files/WindowsApps/PythonSoftwareFoundation.Python.3.13", baseExecutable: path.resolve("store", "python.exe") }));
        return interpreter();
      }
      if (args[0] === "python" && args[1] === "find") return success(basePython);
      if (args[0] === "venv") rebuilt = true;
      return success();
    });
    await synchronizeHermesDependencies(environment, ["mcp"], run);
    const calls = run.mock.calls;
    const verified = calls.findIndex((call) => call[0] === basePython && call[1][0] === "-I");
    const rebuild = calls.findIndex((call) => call[1][0] === "venv");
    expect(verified).toBeGreaterThan(-1);
    expect(rebuild).toBeGreaterThan(verified);
    expect(calls[rebuild]?.[1]).toEqual(["venv", "--clear", "--python", basePython, environment.venvPath]);
    expect(calls.some((call) => call[1].includes("stash") || call[1].includes("uninstall"))).toBe(false);
  });

  it("does not clear a broken venv if the replacement interpreter cannot be provisioned", async () => {
    const run = vi.fn<MaintenanceRunner>().mockImplementation(async (_command, args) => args[0] === "--version" ? success("uv") : { exitCode: 1, stdout: "", stderr: "offline" });
    await expect(synchronizeHermesDependencies(managedHermesEnvironmentAt(path.resolve("missing-venv-root")), ["mcp"], run)).rejects.toThrow("offline");
    expect(run.mock.calls.some((call) => call[1][0] === "venv" || call[1][0] === "sync")).toBe(false);
  });
});
