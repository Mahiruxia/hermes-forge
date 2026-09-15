import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OneClickDiagnosticsOrchestrator } from "./one-click-diagnostics-orchestrator";
import { managedHermesEnvironmentAt } from "../../runtime/managed-hermes-environment";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OneClickDiagnosticsOrchestrator", () => {
  async function managedFixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "one-click-managed-"));
    tempDirs.push(dir);
    const root = path.join(dir, "hermes-agent");
    const environment = managedHermesEnvironmentAt(root);
    await fs.mkdir(path.dirname(environment.pythonPath), { recursive: true });
    await fs.writeFile(environment.pythonPath, "fixture");
    const oldEnvironment = managedHermesEnvironmentAt(root, ".venv");
    await fs.mkdir(path.dirname(oldEnvironment.pythonPath), { recursive: true });
    await fs.writeFile(oldEnvironment.pythonPath, "fixture");
    return { dir, root, environment };
  }

  function dependencyOrchestrator(dir: string, root: string, repairDependency = vi.fn()) {
    const config = { modelProfiles: [], extensionSettings: { connectorsEnabled: false, cronEnabled: false }, hermesRuntime: { mode: "windows", pythonCommand: "system-python" } };
    const orchestrator = new OneClickDiagnosticsOrchestrator(
      { getConfigPath: () => path.join(dir, "config.json"), getEnginePath: async () => root, read: async () => config } as any,
      { repairDependency } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    return { orchestrator, context: { config, runtime: config.hermesRuntime }, repairDependency };
  }

  it("checks the selected managed venv and skips disabled extras without demanding pip", async () => {
    const { dir, root, environment } = await managedFixture();
    await fs.writeFile(path.join(dir, "connectors-config.json"), "invalid disabled connector settings");
    const { orchestrator, context, repairDependency } = dependencyOrchestrator(dir, root);
    const probe = vi.spyOn(orchestrator as any, "probeManagedPython").mockResolvedValue({ ok: true, missing: [] });
    const items: any[] = [];
    await (orchestrator as any).checkPythonDeps(items, context, undefined, { autoFix: true });
    expect(probe).toHaveBeenCalledWith(environment, ["mcp"]);
    expect(repairDependency).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject({ status: "pass", evidence: { pythonCommand: environment.pythonPath, extras: ["mcp"] } });
  });

  it("delegates missing dependencies to locked maintenance and verifies the repaired environment", async () => {
    const { dir, root } = await managedFixture();
    const repair = vi.fn().mockResolvedValue({ ok: true, message: "synchronized" });
    const { orchestrator, context } = dependencyOrchestrator(dir, root, repair);
    const probe = vi.spyOn(orchestrator as any, "probeManagedPython")
      .mockResolvedValueOnce({ ok: false, missing: ["mcp"] }).mockResolvedValueOnce({ ok: true, missing: [] });
    const items: any[] = [];
    await (orchestrator as any).checkPythonDeps(items, context, undefined, { autoFix: true });
    expect(repair).toHaveBeenCalledExactlyOnceWith("hermes_pyyaml");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(items[0]).toMatchObject({ status: "fixed", fixed: true });
  });

  it("does not report a successful repair until dependency verification passes", async () => {
    const { dir, root } = await managedFixture();
    const { orchestrator, context } = dependencyOrchestrator(dir, root, vi.fn().mockResolvedValue({ ok: true }));
    vi.spyOn(orchestrator as any, "probeManagedPython").mockResolvedValue({ ok: false, missing: ["mcp"] });
    const items: any[] = [];
    await (orchestrator as any).checkPythonDeps(items, context, undefined, { autoFix: true });
    expect(items[0]).toMatchObject({ status: "fail", fixed: false, userActionRequired: true });
  });

  it("does not fall through to configured system Python when the managed environment is absent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "one-click-missing-"));
    tempDirs.push(dir);
    const { orchestrator, context, repairDependency } = dependencyOrchestrator(dir, path.join(dir, "missing"));
    const probe = vi.spyOn(orchestrator as any, "probeManagedPython");
    const items: any[] = [];
    await (orchestrator as any).checkPythonDeps(items, context, undefined, { autoFix: false });
    expect(probe).not.toHaveBeenCalled();
    expect(repairDependency).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject({ status: "fail", evidence: { missing: ["受管虚拟环境"] } });
  });

  it("does not query or start Gateway when connectors and Cron are disabled", async () => {
    const status = vi.fn();
    const checkPreflight = vi.fn();
    const restart = vi.fn();
    const orchestrator = new OneClickDiagnosticsOrchestrator(
      { read: async () => ({ extensionSettings: { connectorsEnabled: false, cronEnabled: false } }) } as any,
      {} as any, {} as any, { status, checkPreflight, restart } as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    const items: any[] = [];
    await (orchestrator as any).checkGateway(items, { autoFix: true });
    expect(items[0]).toMatchObject({ status: "skipped", source: "extension-settings" });
    expect(status).not.toHaveBeenCalled();
    expect(checkPreflight).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("accepts the official task contract without probing fork capabilities or doctor", async () => {
    const inspect = vi.fn().mockResolvedValue({ installed: true, version: "0.21.3", forgeTaskReady: true, blockingIssues: [], warnings: [] });
    const orchestrator = new OneClickDiagnosticsOrchestrator(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { inspect } as any,
    );
    const items: any[] = [];
    await (orchestrator as any).checkHermesCli(items, {}, undefined, { autoFix: true });
    expect(items.map((entry) => entry.id)).toEqual(["hermes.version", "hermes.compatibility"]);
    expect(items.every((entry) => entry.status === "pass")).toBe(true);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("exports diagnostics without starting a one-click run when no cached report exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "one-click-export-"));
    tempDirs.push(dir);
    const diagnosticsService = {
      export: vi.fn(async () => ({ ok: true, path: dir, message: `诊断报告已导出：${dir}` })),
    };
    const setupService = { getSummary: vi.fn() };
    const orchestrator = new OneClickDiagnosticsOrchestrator(
      {} as any,
      setupService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      diagnosticsService as any,
      {} as any,
      {} as any,
    );

    const result = await orchestrator.exportLatest();

    expect(result.ok).toBe(true);
    expect(diagnosticsService.export).toHaveBeenCalledTimes(1);
    expect(setupService.getSummary).not.toHaveBeenCalled();
    const oneClickReport = JSON.parse(await fs.readFile(result.oneClickReportPath!, "utf8")) as { summary: { skipped: number }; items: Array<{ status: string }> };
    expect(oneClickReport.summary.skipped).toBe(1);
    expect(oneClickReport.items[0]?.status).toBe("skipped");
  });

  it("checks Windows runtime without running WSL diagnostics", async () => {
    const probe = vi.fn(async () => ({
      runtimeMode: "windows",
      overallStatus: "ready",
      commands: {},
      issues: [],
    }));
    const orchestrator = new OneClickDiagnosticsOrchestrator(
      {} as any,
      {} as any,
      { probe } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const items: Array<{ id: string; status: string; evidence?: unknown }> = [];

    await (orchestrator as any).checkWindowsRuntime(
      items,
      {
        config: {},
        runtime: {
          mode: "windows",
          pythonCommand: "python3",
          windowsAgentMode: "hermes_native",
        },
      },
      { workspacePath: "C:\\repo", autoFix: false },
    );

    expect(probe).toHaveBeenCalledTimes(1);
    expect(items.map((entry) => entry.id)).toEqual(["runtime.windows"]);
    expect(items[0]?.status).toBe("pass");
  });

  it("adds a real model connection failure to one-click diagnostics", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "one-click-model-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "config.json");
    const config = {
      modelProfiles: [{
        id: "default",
        name: "Default",
        provider: "custom",
        sourceType: "openai_compatible",
        model: "bad-model",
        baseUrl: "https://api.example.invalid/v1",
        secretRef: "provider.custom.apiKey",
      }],
      defaultModelProfileId: "default",
      providerProfiles: [],
      updateSources: {},
      enginePaths: {},
      enginePermissions: {},
      hermesRuntime: {
        mode: "windows",
        pythonCommand: "python3",
        windowsAgentMode: "hermes_native",
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const testModelConnection = vi.fn(async () => ({
      ok: false,
      message: "401 Unauthorized",
      recommendedFix: "检查 API Key。",
      providerFamily: "openai-compatible",
      sourceType: "openai_compatible",
      model: "bad-model",
      normalizedBaseUrl: "https://api.example.invalid/v1",
      failureCategory: "auth",
      healthChecks: [],
    }));
    const orchestrator = new OneClickDiagnosticsOrchestrator(
      {
        getConfigPath: () => configPath,
        read: vi.fn(async () => config),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      { syncRuntimeConfig: vi.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      testModelConnection as any,
    );
    const items: Array<{ id: string; status: string; summary?: string }> = [];

    await (orchestrator as any).checkModels(items, { autoFix: false });

    expect(testModelConnection).toHaveBeenCalledTimes(1);
    expect(items.find((entry) => entry.id === "model.connection")).toMatchObject({
      status: "fail",
      summary: "默认模型真实连接失败：401 Unauthorized",
    });
  });

  it("warns when install source is the community mirror", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "one-click-source-"));
    tempDirs.push(dir);
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    const managedHome = path.join(dir, "forge-home");
    await fs.mkdir(managedHome, { recursive: true });
    await fs.symlink(managedHome, path.join(dir, ".hermes"), "junction");
    const orchestrator = new OneClickDiagnosticsOrchestrator(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      () => managedHome,
      () => managedHome,
    );
    const items: Array<{ id: string; status: string; summary?: string }> = [];

    await (orchestrator as any).checkInstallSourceAndHome(items, {
      config: {},
      runtime: {
        mode: "windows",
        pythonCommand: "python",
        windowsAgentMode: "hermes_native",
        installSource: {
          sourceLabel: "mirror",
          repoUrl: "https://github.com/NousResearch/hermes-agent.git",
          branch: "main",
        },
      },
    });

    expect(items.find((entry) => entry.id === "hermes.install-source")).toMatchObject({
      status: "warn",
      summary: "安装来源为中文社区/国内镜像，非 Nous 官方源。",
    });
    expect(items.find((entry) => entry.id === "hermes.home-link")).toMatchObject({
      status: "pass",
    });
  });

  it("warns instead of modifying when the original Hermes home exists independently", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "one-click-home-"));
    tempDirs.push(dir);
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    await fs.mkdir(path.join(dir, ".hermes"), { recursive: true });
    const managedHome = path.join(dir, "forge-home");
    await fs.mkdir(managedHome, { recursive: true });
    const orchestrator = new OneClickDiagnosticsOrchestrator(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      () => managedHome,
      () => managedHome,
    );
    const items: Array<{ id: string; status: string; summary?: string }> = [];

    await (orchestrator as any).checkInstallSourceAndHome(items, {
      config: {},
      runtime: {
        mode: "windows",
        pythonCommand: "python",
        windowsAgentMode: "hermes_native",
        installSource: {
          sourceLabel: "official",
          repoUrl: "https://github.com/NousResearch/hermes-agent.git",
          branch: "main",
        },
      },
    });

    expect(items.find((entry) => entry.id === "hermes.home-link")).toMatchObject({
      status: "warn",
      summary: "检测到原版 Hermes 默认 home 独立存在；Forge 不会覆盖它，原版 CLI 与 Forge 配置可能分离。",
    });
  });
});
