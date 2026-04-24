import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPaths } from "../main/app-paths";
import { runCommand } from "../process/command-runner";
import type { RuntimeProbeResult } from "../runtime/runtime-types";
import type { RuntimeConfig } from "../shared/types";
import { WslDistroService } from "./wsl-distro-service";

vi.mock("../process/command-runner", () => ({
  runCommand: vi.fn(),
}));

let tempRoot = "";

function probe(overrides: Partial<RuntimeProbeResult> = {}): RuntimeProbeResult {
  return {
    checkedAt: new Date().toISOString(),
    runtimeMode: "wsl",
    windowsAvailable: true,
    powershellAvailable: true,
    pythonAvailable: true,
    gitAvailable: true,
    wingetAvailable: true,
    wslAvailable: true,
    distroExists: true,
    distroName: "Ubuntu",
    distroReachable: true,
    wslPythonAvailable: true,
    hermesRootExists: false,
    hermesCliExists: false,
    bridgeReachable: false,
    configResolved: true,
    homeResolved: true,
    memoryResolved: true,
    paths: {} as RuntimeProbeResult["paths"],
    commands: {
      powershell: { available: true, message: "ok" },
      python: { available: true, message: "ok" },
      git: { available: true, message: "ok" },
      winget: { available: true, message: "ok" },
      wsl: { available: true, message: "ok", distroExists: true, distroReachable: true },
    },
    bridge: { configured: false, running: false, reachable: false, message: "disabled" },
    overallStatus: "ready",
    issues: [],
    recommendations: [],
    ...overrides,
  };
}

function config(): RuntimeConfig {
  return {
    defaultModelProfileId: "default-local",
    modelProfiles: [],
    providerProfiles: [],
    updateSources: {},
    enginePaths: {},
    enginePermissions: {
      fileSystem: { read: true, write: false, allowedRoots: [], blockedRoots: [] },
      shell: { enabled: false, requireApproval: true, allowedCommands: [], blockedCommands: [] },
      network: { enabled: true, allowedHosts: [], blockedHosts: [] },
      windowsAutomation: { enabled: false, requireApproval: true },
      process: { canKill: false, canSpawn: false },
    },
    hermesRuntime: {
      mode: "wsl",
      distro: "Ubuntu",
      pythonCommand: "python3",
      windowsAgentMode: "hermes_native",
    },
  };
}

describe("WslDistroService", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wsl-distro-service-"));
    vi.mocked(runCommand).mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("uses explicit install to bootstrap Ubuntu when WSL is initially unavailable", async () => {
    const read = vi.fn(async () => config());
    const write = vi.fn(async (next: RuntimeConfig) => next);
    const runtimeProbeService = {
      probe: vi
        .fn()
        .mockResolvedValueOnce(probe({
          wslAvailable: false,
          distroExists: false,
          distroReachable: false,
          commands: {
            ...probe().commands,
            wsl: { available: false, message: "wsl.exe 不可用" },
          },
          recommendations: ["启用 WSL 后重试。"],
          overallStatus: "unavailable",
        }))
        .mockResolvedValueOnce(probe()),
    };
    vi.mocked(runCommand)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Ubuntu installed",
        stderr: "",
        diagnostics: { stdoutPreview: "Ubuntu installed", stderrPreview: "", exitCode: 0 } as any,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Linux\nready",
        stderr: "",
        diagnostics: { stdoutPreview: "Linux\nready", stderrPreview: "", exitCode: 0 } as any,
      });
    const service = new WslDistroService(
      new AppPaths(tempRoot),
      { read, write } as any,
      runtimeProbeService as any,
      (() => ({ getBridgeAccessHost: vi.fn(async () => "127.0.0.1") })) as any,
      { diagnose: vi.fn(async () => ({ overallStatus: "ready_to_attach_existing_wsl" })) } as any,
    );

    const result = await service.createOrAttach({ requestedBy: "install", explicitCreate: true });

    expect(runCommand).toHaveBeenNthCalledWith(1, "wsl.exe", ["--install", "-d", "Ubuntu"], expect.objectContaining({
      commandId: "install.wsl.bootstrap-distro",
      timeoutMs: 15 * 60 * 1000,
    }));
    expect(result.createdNow).toBe(true);
    expect(result.reachableAfterCreate).toBe(true);
    expect(result.lastSuccessfulStage).toBe("create_distro");
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: "wsl-bootstrap-install", status: "passed" }),
      expect.objectContaining({ step: "verify-distro-entry", status: "passed" }),
    ]));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      hermesRuntime: expect.objectContaining({ mode: "wsl", distro: "Ubuntu" }),
    }));
  });
});
