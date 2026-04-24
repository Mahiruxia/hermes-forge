import { describe, expect, it, vi, beforeEach } from "vitest";
import { WslHermesInstallService } from "./wsl-hermes-install-service";

const runCommandMock = vi.fn();

vi.mock("../process/command-runner", () => ({
  runCommand: (...args: Parameters<typeof runCommandMock>) => runCommandMock(...args),
}));

function createDoctorReport() {
  return {
    checkedAt: new Date().toISOString(),
    runtime: {
      mode: "wsl",
      distro: "Ubuntu",
      pythonCommand: "python3",
      managedRoot: "/home/test/.hermes-forge/hermes-agent",
      windowsAgentMode: "hermes_native",
    },
    overallStatus: "ready_to_attach_existing_wsl",
    checks: [],
    recommendedActions: [],
    blockingIssues: [],
    safeAutoRepairs: [],
    runtimeProbe: {
      bridge: { running: true, reachable: true, configured: true, message: "ok" },
    },
  } as any;
}

describe("WslHermesInstallService", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  it("stops before pip install when virtualenv creation fails", async () => {
    runCommandMock.mockImplementation(async (_command: string, _args: string[], options: { commandId: string }) => {
      switch (options.commandId) {
        case "install.wsl.resolve-home":
          return { exitCode: 0, stdout: "/home/test", stderr: "" };
        case "install.wsl.mkdir-root":
          return { exitCode: 0, stdout: "", stderr: "" };
        case "install.wsl.ensure-python":
          return { exitCode: 0, stdout: "Python 3.12.3", stderr: "" };
        case "install.wsl.git-version":
          return { exitCode: 0, stdout: "git version 2.43.0", stderr: "" };
        case "install.wsl.check-repo":
          return { exitCode: 0, stdout: "no\n", stderr: "" };
        case "install.wsl.git-clone":
          return { exitCode: 0, stdout: "clone ok", stderr: "" };
        case "install.wsl.check-venv":
          return { exitCode: 0, stdout: "no\n", stderr: "" };
        case "install.wsl.create-venv":
          return { exitCode: 1, stdout: "", stderr: "ensurepip is not available" };
        default:
          return { exitCode: 1, stdout: "", stderr: `unexpected command: ${options.commandId}` };
      }
    });

    const service = new WslHermesInstallService(
      { baseDir: () => "C:\\temp" } as any,
      { read: vi.fn(async () => ({})), write: vi.fn(async () => undefined) } as any,
      { probe: vi.fn() } as any,
      (() => ({ preflight: vi.fn() })) as any,
      { diagnose: vi.fn(async () => createDoctorReport()) } as any,
    );

    const result = await service.install({ report: createDoctorReport() });

    expect(result.installExecuted).toBe(false);
    expect(result.healthCheckPassed).toBe(false);
    expect(result.lastSuccessfulStage).toBe("ensure_repo");
    expect(result.venvStatus).toMatchObject({ state: "failed" });
    expect(result.steps.some((step) => step.step === "pip-install")).toBe(false);
    expect(result.steps.find((step) => step.step === "ensure-venv")).toMatchObject({
      status: "failed",
      code: "venv_unavailable",
    });
  });

  it("treats Hermes verification as successful even when bridge-only follow-up checks are degraded", async () => {
    runCommandMock.mockImplementation(async (_command: string, _args: string[], options: { commandId: string }) => {
      switch (options.commandId) {
        case "install.wsl.resolve-home":
          return { exitCode: 0, stdout: "/home/test", stderr: "" };
        case "install.wsl.mkdir-root":
        case "install.wsl.git-clone":
        case "install.wsl.pip-install":
          return { exitCode: 0, stdout: "ok", stderr: "" };
        case "install.wsl.ensure-python":
          return { exitCode: 0, stdout: "Python 3.12.3", stderr: "" };
        case "install.wsl.git-version":
          return { exitCode: 0, stdout: "git version 2.43.0", stderr: "" };
        case "install.wsl.check-repo":
        case "install.wsl.check-venv":
          return { exitCode: 0, stdout: "no\n", stderr: "" };
        case "install.wsl.create-venv":
          return { exitCode: 0, stdout: "", stderr: "" };
        case "install.wsl.pip-version":
          return { exitCode: 0, stdout: "pip 24.0", stderr: "" };
        case "install.wsl.hermes-version":
          return { exitCode: 0, stdout: "Hermes Agent v0.10.0", stderr: "" };
        case "install.wsl.hermes-capabilities":
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              cliVersion: "0.10.0",
              capabilities: {
                supportsLaunchMetadataArg: true,
                supportsLaunchMetadataEnv: true,
                supportsResume: true,
              },
            }),
            stderr: "",
          };
        default:
          return { exitCode: 1, stdout: "", stderr: `unexpected command: ${options.commandId}` };
      }
    });
    const bridgeIssue = {
      code: "bridge_unreachable",
      severity: "error",
      summary: "Windows Bridge 不可达。",
    };
    const service = new WslHermesInstallService(
      { baseDir: () => "C:\\temp" } as any,
      {
        read: vi.fn(async () => ({
          hermesRuntime: {
            mode: "wsl",
            distro: "Ubuntu",
            pythonCommand: "python3",
            managedRoot: "/home/test/.hermes-forge/hermes-agent",
          },
        })),
        write: vi.fn(async () => undefined),
      } as any,
      {
        probe: vi.fn(async () => ({
          overallStatus: "unavailable",
          issues: [bridgeIssue],
          bridge: { running: false, reachable: false, configured: false, message: "bridge stopped" },
        })),
      } as any,
      (() => ({ preflight: vi.fn() })) as any,
      {
        diagnose: vi.fn(async () => ({
          ...createDoctorReport(),
          overallStatus: "manual_setup_required",
          blockingIssues: [bridgeIssue],
        })),
      } as any,
    );

    const result = await service.install({ report: createDoctorReport() });

    expect(result.healthCheckPassed).toBe(true);
    expect(result.lastSuccessfulStage).toBe("health_check");
    expect(result.steps.find((step) => step.step === "verify-hermes")).toMatchObject({ status: "passed" });
    expect(result.steps.find((step) => step.step === "reprobe-after-install")).toMatchObject({ status: "passed" });
    expect(result.steps.find((step) => step.step === "redoctor-after-install")).toMatchObject({ status: "passed" });
  });

  it("imports an existing WSL Hermes CLI before treating the managed directory as invalid", async () => {
    const configStore = {
      read: vi.fn(async () => ({
        hermesRuntime: {
          mode: "wsl",
          distro: "Ubuntu",
          pythonCommand: "python3",
          managedRoot: "/home/test/broken-hermes",
        },
      })),
      write: vi.fn(async () => undefined),
    };
    const runtimeProbeService = {
      probe: vi.fn(async () => ({
        overallStatus: "ready",
        issues: [],
        bridge: { running: true, reachable: true, configured: true, message: "ok" },
      })),
    };
    const doctorService = {
      diagnose: vi.fn(async () => ({
        ...createDoctorReport(),
        runtime: {
          ...createDoctorReport().runtime,
          managedRoot: "/home/test/existing-hermes",
        },
      })),
    };
    runCommandMock.mockImplementation(async (_command: string, _args: string[], options: { commandId: string }) => {
      switch (options.commandId) {
        case "install.wsl.resolve-home":
          return { exitCode: 0, stdout: "/home/test", stderr: "" };
        case "install.wsl.mkdir-root":
          return { exitCode: 0, stdout: "", stderr: "" };
        case "install.wsl.ensure-python":
          return { exitCode: 0, stdout: "Python 3.12.3", stderr: "" };
        case "install.wsl.find-existing-hermes":
          return { exitCode: 0, stdout: "/home/test/existing-hermes/hermes\n", stderr: "" };
        case "install.wsl.existing-hermes-file":
          return { exitCode: 0, stdout: "yes\n", stderr: "" };
        case "install.wsl.existing-hermes-python":
          return { exitCode: 0, stdout: "/home/test/existing-hermes/.venv/bin/python", stderr: "" };
        case "install.wsl.existing-hermes-version":
          return { exitCode: 0, stdout: "Hermes Agent v0.10.0", stderr: "" };
        case "install.wsl.existing-hermes-capabilities":
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              cliVersion: "0.10.0",
              capabilities: {
                supportsLaunchMetadataArg: true,
                supportsLaunchMetadataEnv: true,
                supportsResume: true,
              },
            }),
            stderr: "",
          };
        case "install.wsl.git-rev-parse":
          return { exitCode: 1, stdout: "", stderr: "not a git repo" };
        default:
          return { exitCode: 1, stdout: "", stderr: `unexpected command: ${options.commandId}` };
      }
    });

    const service = new WslHermesInstallService(
      { baseDir: () => "C:\\temp" } as any,
      configStore as any,
      runtimeProbeService as any,
      (() => ({ preflight: vi.fn() })) as any,
      doctorService as any,
    );

    const result = await service.install({
      report: {
        ...createDoctorReport(),
        runtime: {
          ...createDoctorReport().runtime,
          managedRoot: "/home/test/broken-hermes",
        },
      },
    });

    expect(result.healthCheckPassed).toBe(true);
    expect(result.installExecuted).toBe(false);
    expect(result.hermesRoot).toBe("/home/test/existing-hermes");
    expect(result.repoStatus).toMatchObject({ state: "reused", root: "/home/test/existing-hermes" });
    expect(result.steps.find((step) => step.step === "import-existing-hermes")).toMatchObject({ status: "passed" });
    expect(runCommandMock.mock.calls.some((call) => call[2]?.commandId === "install.wsl.git-version")).toBe(false);
    expect(configStore.write).toHaveBeenCalledWith(expect.objectContaining({
      hermesRuntime: expect.objectContaining({ managedRoot: "/home/test/existing-hermes" }),
    }));
  });

  it("repairs missing dependencies for an existing Hermes CLI through an attached WSL venv wrapper", async () => {
    const configStore = {
      read: vi.fn(async () => ({
        hermesRuntime: {
          mode: "wsl",
          distro: "Ubuntu",
          pythonCommand: "python3",
          managedRoot: "/mnt/c/Users/Jia/Hermes Agent",
        },
      })),
      write: vi.fn(async () => undefined),
    };
    runCommandMock.mockImplementation(async (_command: string, _args: string[], options: { commandId: string }) => {
      switch (options.commandId) {
        case "install.wsl.resolve-home":
        case "install.wsl.repaired-wrapper-home":
          return { exitCode: 0, stdout: "/home/jia", stderr: "" };
        case "install.wsl.mkdir-root":
          return { exitCode: 0, stdout: "", stderr: "" };
        case "install.wsl.ensure-python":
          return { exitCode: 0, stdout: "Python 3.12.3", stderr: "" };
        case "install.wsl.find-existing-hermes":
          return { exitCode: 0, stdout: "/mnt/c/Users/Jia/Hermes Agent/hermes\n", stderr: "" };
        case "install.wsl.existing-hermes-file":
          return { exitCode: 0, stdout: "yes\n", stderr: "" };
        case "install.wsl.existing-hermes-python":
          return { exitCode: 0, stdout: "python3", stderr: "" };
        case "install.wsl.existing-hermes-version":
        case "install.wsl.existing-hermes-capabilities":
          return { exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'dotenv'" };
        case "install.wsl.repair-existing-hermes-deps":
          return { exitCode: 0, stdout: "Successfully installed python-dotenv", stderr: "" };
        case "install.wsl.repaired-existing-hermes-version":
          return { exitCode: 0, stdout: "Hermes Agent v0.10.0", stderr: "" };
        case "install.wsl.repaired-existing-hermes-capabilities":
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              cliVersion: "0.10.0",
              capabilities: {
                supportsLaunchMetadataArg: true,
                supportsLaunchMetadataEnv: true,
                supportsResume: true,
              },
            }),
            stderr: "",
          };
        case "install.wsl.git-rev-parse":
          return { exitCode: 1, stdout: "", stderr: "not a git repo" };
        default:
          return { exitCode: 1, stdout: "", stderr: `unexpected command: ${options.commandId}` };
      }
    });

    const service = new WslHermesInstallService(
      { baseDir: () => "C:\\temp" } as any,
      configStore as any,
      {
        probe: vi.fn(async () => ({
          overallStatus: "ready",
          issues: [],
          bridge: { running: true, reachable: true, configured: true, message: "ok" },
        })),
      } as any,
      (() => ({ preflight: vi.fn() })) as any,
      { diagnose: vi.fn(async () => createDoctorReport()) } as any,
    );

    const result = await service.install({
      report: {
        ...createDoctorReport(),
        runtime: {
          ...createDoctorReport().runtime,
          managedRoot: "/mnt/c/Users/Jia/Hermes Agent",
        },
      },
    });

    expect(result.healthCheckPassed).toBe(true);
    expect(result.installExecuted).toBe(false);
    expect(result.hermesRoot).toContain("/home/jia/.hermes-forge/attached-hermes-");
    expect(result.steps.find((step) => step.step === "repair-existing-hermes-deps")).toMatchObject({ status: "passed" });
    expect(configStore.write).toHaveBeenCalledWith(expect.objectContaining({
      hermesRuntime: expect.objectContaining({ managedRoot: expect.stringContaining("/home/jia/.hermes-forge/attached-hermes-") }),
    }));
  });

  it("detects missing dependencies from capabilities output even when version prints successfully", async () => {
    const configStore = {
      read: vi.fn(async () => ({
        hermesRuntime: {
          mode: "wsl",
          distro: "Ubuntu",
          pythonCommand: "python3",
          managedRoot: "/mnt/c/Users/Jia/Hermes Agent",
        },
      })),
      write: vi.fn(async () => undefined),
    };
    runCommandMock.mockImplementation(async (_command: string, _args: string[], options: { commandId: string }) => {
      switch (options.commandId) {
        case "install.wsl.resolve-home":
        case "install.wsl.repaired-wrapper-home":
          return { exitCode: 0, stdout: "/home/jia", stderr: "" };
        case "install.wsl.mkdir-root":
          return { exitCode: 0, stdout: "", stderr: "" };
        case "install.wsl.ensure-python":
          return { exitCode: 0, stdout: "Python 3.12.3", stderr: "" };
        case "install.wsl.find-existing-hermes":
          return { exitCode: 0, stdout: "/mnt/c/Users/Jia/Hermes Agent/hermes\n", stderr: "" };
        case "install.wsl.existing-hermes-file":
          return { exitCode: 0, stdout: "yes\n", stderr: "" };
        case "install.wsl.existing-hermes-python":
          return { exitCode: 0, stdout: "python3", stderr: "" };
        case "install.wsl.existing-hermes-version":
          return { exitCode: 0, stdout: "Hermes Agent v0.9.0", stderr: "" };
        case "install.wsl.existing-hermes-capabilities":
          return { exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'dotenv'" };
        case "install.wsl.repair-existing-hermes-deps":
          return { exitCode: 0, stdout: "Successfully installed python-dotenv", stderr: "" };
        case "install.wsl.repaired-existing-hermes-version":
          return { exitCode: 0, stdout: "Hermes Agent v0.10.0", stderr: "" };
        case "install.wsl.repaired-existing-hermes-capabilities":
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              cliVersion: "0.10.0",
              capabilities: {
                supportsLaunchMetadataArg: true,
                supportsLaunchMetadataEnv: true,
                supportsResume: true,
              },
            }),
            stderr: "",
          };
        case "install.wsl.git-rev-parse":
          return { exitCode: 1, stdout: "", stderr: "not a git repo" };
        default:
          return { exitCode: 1, stdout: "", stderr: `unexpected command: ${options.commandId}` };
      }
    });

    const service = new WslHermesInstallService(
      { baseDir: () => "C:\\temp" } as any,
      configStore as any,
      {
        probe: vi.fn(async () => ({
          overallStatus: "ready",
          issues: [],
          bridge: { running: true, reachable: true, configured: true, message: "ok" },
        })),
      } as any,
      (() => ({ preflight: vi.fn() })) as any,
      { diagnose: vi.fn(async () => createDoctorReport()) } as any,
    );

    const result = await service.install({
      report: {
        ...createDoctorReport(),
        runtime: {
          ...createDoctorReport().runtime,
          managedRoot: "/mnt/c/Users/Jia/Hermes Agent",
        },
      },
    });

    expect(result.healthCheckPassed).toBe(true);
    expect(result.steps.find((step) => step.step === "repair-existing-hermes-deps")).toMatchObject({ status: "passed" });
  });
});
