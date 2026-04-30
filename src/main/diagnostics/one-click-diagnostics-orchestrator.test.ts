import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OneClickDiagnosticsOrchestrator } from "./one-click-diagnostics-orchestrator";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OneClickDiagnosticsOrchestrator", () => {
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
});
