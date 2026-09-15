import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupService } from "./setup-service";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { SecretVault } from "../auth/secret-vault";
import type { RuntimeConfig, HermesCompatibilityReport } from "../shared/types";
import type { InstallOrchestrator } from "../install/install-orchestrator";
import type { HermesCompatibilityService } from "./hermes-compatibility-service";
import { managedHermesEnvironmentAt } from "../runtime/managed-hermes-environment";

const runCommandMock = vi.fn();
vi.mock("../process/command-runner", () => ({
  runCommand: (...args: unknown[]) => runCommandMock(...args),
  streamCommand: async function* () { yield { type: "exit", exitCode: 0 }; },
}));
let tempRoot = "";
let config: RuntimeConfig;
let rootPath = "";
let orchestration: { install: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; cancelInstall: ReturnType<typeof vi.fn>; repairDependency: ReturnType<typeof vi.fn> };
const report: HermesCompatibilityReport = {
  installed: true, version: "0.21.3", launchMode: "venv-exe", venvStatus: "present", forgeTaskReady: true,
  enhancedCapabilities: { supported: false, supportsLaunchMetadataArg: false, supportsLaunchMetadataEnv: false, supportsResume: true, missing: [], message: "official" },
  doctorStatus: { status: "not_run", message: "not run" }, blockingIssues: [], warnings: [],
};

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-setup-test-"));
  rootPath = path.join(tempRoot, "agent");
  const environment = managedHermesEnvironmentAt(rootPath);
  await fs.mkdir(path.dirname(environment.pythonPath), { recursive: true });
  await fs.writeFile(environment.pythonPath, "fixture");
  config = {
    defaultModelProfileId: "local-test", modelProfiles: [{ id: "local-test", provider: "local", model: "qwen", baseUrl: "http://127.0.0.1:1234/v1" }],
    updateSources: {}, enginePaths: { hermes: rootPath },
    extensionSettings: { connectorsEnabled: false, cronEnabled: false, desktopAutomationEnabled: false },
  };
  orchestration = {
    install: vi.fn().mockResolvedValue({ ok: true, engineId: "hermes", message: "installed", log: [] }),
    update: vi.fn().mockResolvedValue({ ok: true, engineId: "hermes", message: "updated", log: [] }),
    cancelInstall: vi.fn().mockResolvedValue({ ok: true, message: "cancelled" }),
    repairDependency: vi.fn().mockResolvedValue({ ok: true, id: "hermes_pyyaml", message: "fixed" }),
  };
  runCommandMock.mockReset();
  runCommandMock.mockResolvedValue({ exitCode: 0, stdout: "fixture ok", stderr: "" });
});
afterEach(async () => { await fs.rm(tempRoot, { recursive: true, force: true }); });

function service() {
  return new SetupService(
    { baseDir: () => tempRoot, hermesDir: () => path.join(tempRoot, "home") } as AppPaths,
    { healthCheck: async () => ({ available: true, message: "ready" }) } as unknown as EngineAdapter,
    { read: async () => config, getEnginePath: async () => rootPath } as RuntimeConfigStore,
    { has: async () => true, read: async () => "fixture" } as unknown as SecretVault,
    undefined, undefined, orchestration as unknown as InstallOrchestrator,
    { inspect: async () => report } as HermesCompatibilityService,
  );
}

describe("SetupService maintenance routing", () => {
  it("routes install, repair and cancel through the shared maintenance orchestrator", async () => {
    const setup = service();
    const options = { rootPath, source: { kind: "official" as const } };
    await setup.installHermes(undefined, options);
    await setup.repairDependency("hermes_pyyaml");
    await setup.cancelInstallHermes();
    expect(orchestration.install).toHaveBeenCalledWith(undefined, options);
    expect(orchestration.repairDependency).toHaveBeenCalledWith("hermes_pyyaml");
    expect(orchestration.cancelInstall).toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });
  it("publishes the actual maintenance result instead of optimistic update progress", async () => {
    orchestration.update.mockResolvedValue({ ok: false, engineId: "hermes", message: "offline", log: [] });
    const publish = vi.fn();
    expect((await service().updateHermes(publish)).ok).toBe(false);
    expect(publish.mock.calls.map(([event]) => event.stage)).toEqual(["preflight", "failed"]);
  });
});

describe("SetupService lean dependency summary", () => {
  it("does not probe or suggest SDKs when connectors are disabled", async () => {
    await fs.writeFile(path.join(tempRoot, "connectors-config.json"), JSON.stringify({ platforms: { feishu: { enabled: true } } }));
    const result = await service().getSummary();
    const scripts = runCommandMock.mock.calls.map(([, args]) => args.join(" ")).join("\n");
    expect(scripts).not.toMatch(/lark_oapi|aiohttp|import telegram|import discord|slack_bolt/);
    expect(result.checks.some((check) => check.id.startsWith("connector-"))).toBe(false);
    expect(result.checks.some((check) => check.message.includes("capabilities"))).toBe(false);
    expect(runCommandMock.mock.calls.map(([command]) => command)).not.toEqual(expect.arrayContaining(["python", "python3", "node", "winget"]));
  });
  it("checks only configured active connectors, and a missing connector SDK does not block core chat", async () => {
    config.extensionSettings!.connectorsEnabled = true;
    await fs.writeFile(path.join(tempRoot, "connectors-config.json"), JSON.stringify({ platforms: { feishu: { enabled: true }, telegram: { enabled: false } } }));
    runCommandMock.mockImplementation(async (_command: string, args: string[]) => args.join(" ").includes("lark_oapi")
      ? { exitCode: 1, stdout: "", stderr: "No module named lark_oapi" }
      : { exitCode: 0, stdout: "ok", stderr: "" });
    const result = await service().getSummary();
    expect(result.checks.find((check) => check.id === "connector-feishu")).toMatchObject({ status: "warning", blocking: false, autoFixId: "feishu_lark_oapi" });
    expect(result.checks.some((check) => check.id === "connector-telegram")).toBe(false);
    expect(result.blocking.some((check) => check.id.startsWith("connector-"))).toBe(false);
  });
  it("detects missing core dependencies in the actual venv and marks them as blocking", async () => {
    const extra = managedHermesEnvironmentAt(rootPath, ".venv");
    await fs.mkdir(path.dirname(extra.pythonPath), { recursive: true });
    await fs.writeFile(extra.pythonPath, "fixture");
    runCommandMock.mockImplementation(async (_command: string, args: string[]) => args.join(" ").includes("import yaml")
      ? { exitCode: 1, stdout: "", stderr: "No module named yaml" }
      : { exitCode: 0, stdout: "ok", stderr: "" });
    const result = await service().getSummary();
    expect(result.blocking.find((check) => check.id === "hermes-pyyaml")).toMatchObject({ status: "missing" });
    const probe = runCommandMock.mock.calls.find(([, args]) => args.join(" ").includes("import yaml"));
    expect(probe?.[0]).toBe(managedHermesEnvironmentAt(rootPath).pythonPath);
  });
  it("treats official metadata handling as healthy when the real task contract passes", async () => {
    expect(await service().checkHermesAgentCompatibility(report)).toMatchObject({ status: "ok", blocking: false });
  });
});
