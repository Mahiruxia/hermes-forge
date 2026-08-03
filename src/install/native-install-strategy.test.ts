import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { RuntimeConfig } from "../shared/types";
import { NativeInstallStrategy } from "./native-install-strategy";

const runCommandMock = vi.fn();

vi.mock("../process/command-runner", () => ({
  runCommand: (...args: Parameters<typeof runCommandMock>) => runCommandMock(...args),
  streamCommand: async function* (...args: Parameters<typeof runCommandMock>) {
    const result = await runCommandMock(...args);
    for (const line of String(result.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
      yield { type: "stdout", line };
    }
    for (const line of String(result.stderr ?? "").split(/\r?\n/).filter(Boolean)) {
      yield { type: "stderr", line };
    }
    yield { type: "exit", exitCode: result.exitCode };
  },
}));

let tempRoot = "";
let config: RuntimeConfig;
let healthCheckMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "native-install-strategy-"));
  vi.stubEnv("LOCALAPPDATA", tempRoot);
  config = { modelProfiles: [], updateSources: {}, enginePaths: {} };
  healthCheckMock = vi.fn()
    .mockResolvedValueOnce({
      engineId: "hermes",
      label: "Hermes",
      available: false,
      mode: "cli",
      message: "missing",
    })
    .mockResolvedValue({
      engineId: "hermes",
      label: "Hermes",
      available: true,
      mode: "cli",
      path: defaultWindowsInstallRoot(),
      message: "ready",
    });
  runCommandMock.mockReset();
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("NativeInstallStrategy Windows installer", () => {
  it("omits removed official script flags when running the latest installer", async () => {
    const installerRuns: string[][] = [];
    mockOfficialInstaller({
      script: [
        "param(",
        "  [switch]$NoVenv,",
        "  [switch]$SkipSetup,",
        "  [string]$HermesHome,",
        "  [string]$InstallDir",
        ")",
      ].join("\n"),
      installerRuns,
    });
    const service = createStrategy();

    const result = await service.install();

    expect(result.ok).toBe(true);
    expect(installerRuns).toHaveLength(1);
    expect(installerRuns[0]).not.toContain("-WithSystemPackages");
  });

  it("keeps legacy official script flags when the downloaded installer supports them", async () => {
    const installerRuns: string[][] = [];
    mockOfficialInstaller({
      script: [
        "param(",
        "  [switch]$SkipSetup,",
        "  [switch]$WithSystemPackages,",
        "  [string]$HermesHome,",
        "  [string]$InstallDir",
        ")",
      ].join("\n"),
      installerRuns,
    });
    const service = createStrategy();

    const result = await service.install();

    expect(result.ok).toBe(true);
    expect(installerRuns[0]).toContain("-WithSystemPackages");
  });

  it("treats swallowed PowerShell installer failures as failed installs", async () => {
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
      installerStdout: "Installation failed: Git not available and auto-install failed",
      createHermes: false,
    });
    const service = createStrategy();

    const result = await service.install();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("安装脚本报告失败");
    expect(result.message).toContain("可改用国内社区镜像重试");
    expect(config.enginePaths?.hermes).toBeUndefined();
  });

  it("uses the official GitHub Raw installer when official source is selected", async () => {
    const downloadUrls: string[] = [];
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
      downloadUrls,
    });
    const service = createStrategy();

    const result = await service.install(undefined, { source: { kind: "official" } });

    expect(result.ok).toBe(true);
    expect(downloadUrls).toEqual(["https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1"]);
  });

  it("uses the community mirror installer only when mirror source is selected", async () => {
    const downloadUrls: string[] = [];
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
      downloadUrls,
    });
    const service = createStrategy();

    const result = await service.install(undefined, { source: { kind: "mirror" } });

    expect(result.ok).toBe(true);
    expect(downloadUrls).toEqual(["https://res1.hermesagent.org.cn/install.ps1"]);
    expect(config.hermesRuntime?.installSource?.sourceLabel).toBe("mirror");
  });

  it("records mirror installer URL, size, and SHA256 in install logs", async () => {
    const script = "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)";
    mockOfficialInstaller({ script });
    const service = createStrategy();

    const result = await service.install(undefined, { source: { kind: "mirror" } });

    expect(result.ok).toBe(true);
    const log = result.log.join("\n");
    expect(log).toContain("Hermes installer source URL: https://res1.hermesagent.org.cn/install.ps1");
    expect(log).toContain(`Hermes installer content length: ${Buffer.byteLength(script, "utf8")} bytes`);
    expect(log).toMatch(/Hermes installer SHA256: [0-9a-f]{64}/);
  });

  it("passes UTF-8 replacement and python-sitecustomize to installer Python environment", async () => {
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
    });
    const service = createStrategy();

    const result = await service.install();

    expect(result.ok).toBe(true);
    const installerCall = runCommandMock.mock.calls.find(([command, args]) =>
      command === "powershell.exe" && Array.isArray(args) && args.includes("-File")
    );
    expect(installerCall).toBeTruthy();
    const env = installerCall?.[2]?.env as Record<string, string> | undefined;
    expect(env?.PYTHONIOENCODING).toBe("utf-8:replace");
    if (process.platform === "win32") {
      expect(env?.PYTHONPATH).toContain("python-sitecustomize");
    }
  });

  it("does not block the selected installer when system Git and winget are unavailable", async () => {
    const installerRuns: string[][] = [];
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
      installerRuns,
      systemGitAvailable: false,
      wingetAvailable: false,
    });
    const service = createStrategy();

    const result = await service.install(undefined, { source: { kind: "mirror" } });

    expect(result.ok).toBe(true);
    expect(installerRuns).toHaveLength(1);
    expect(result.log.join("\n")).toContain("未检测到系统 Git；将继续运行 Hermes 安装脚本");
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "winget",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("does not block the selected installer when system Python and winget are unavailable", async () => {
    const installerRuns: string[][] = [];
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
      installerRuns,
      systemPythonAvailable: false,
      wingetAvailable: false,
    });
    const service = createStrategy();

    const result = await service.install(undefined, { source: { kind: "mirror" } });

    expect(result.ok).toBe(true);
    expect(installerRuns).toHaveLength(1);
    expect(result.log.join("\n")).toContain("未检测到系统 Python；将继续运行 Hermes 安装脚本");
    expect(runCommandMock).not.toHaveBeenCalledWith(
      "winget",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("does not skip install when switching an existing install to a custom source", async () => {
    const installerRuns: string[][] = [];
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
      installerRuns,
    });
    healthCheckMock.mockResolvedValue({
      engineId: "hermes",
      label: "Hermes",
      available: true,
      mode: "cli",
      path: defaultWindowsInstallRoot(),
      message: "ready",
    });
    const service = createStrategy();

    const result = await service.install(undefined, {
      source: {
        kind: "custom",
        repoUrl: "https://github.com/example/hermes-agent.git",
        branch: "forge-test",
      },
    });

    expect(result.ok).toBe(true);
    expect(installerRuns).toHaveLength(1);
    expect(config.hermesRuntime?.installSource).toMatchObject({
      sourceLabel: "custom",
      repoUrl: "https://github.com/example/hermes-agent.git",
      branch: "forge-test",
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      "git",
      ["remote", "set-url", "origin", "https://github.com/example/hermes-agent.git"],
      expect.objectContaining({ cwd: defaultWindowsInstallRoot() }),
    );
  });

  it("streams installer output through install events", async () => {
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
      installerStdout: "Downloading uv\nInstalling Hermes",
    });
    const service = createStrategy();
    const logLines: string[] = [];

    const result = await service.install((event) => {
      if (event.logLine) logLines.push(event.logLine);
    });

    expect(result.ok).toBe(true);
    expect(logLines).toEqual(expect.arrayContaining(["Downloading uv", "Installing Hermes"]));
  });

  it("cancels an in-flight installer and allows a later install attempt", async () => {
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
    });
    let installerStarted!: () => void;
    const installerStartedPromise = new Promise<void>((resolve) => {
      installerStarted = resolve;
    });
    runCommandMock.mockImplementation(async (command: string, args: string[] = [], options?: { cwd?: string; signal?: AbortSignal }) => {
      if (command === "powershell.exe" && args.includes("-Command") && args.some((arg) => arg.includes("Invoke-WebRequest"))) {
        const commandText = args.at(-1) ?? "";
        const outFile = /-OutFile '([^']+)'/.exec(commandText)?.[1];
        if (outFile) {
          await fs.mkdir(path.dirname(outFile), { recursive: true });
          await fs.writeFile(outFile, "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)", "utf8");
        }
        return { exitCode: 0, stdout: "downloaded", stderr: "" };
      }
      if (command === "powershell.exe" && args.includes("-File")) {
        installerStarted();
        return await new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "cancelled" }), { once: true });
        });
      }
      if (command.endsWith("hermes.exe") && args[0] === "--version") {
        return { exitCode: 0, stdout: "Hermes Agent v0.13.0 (2026.5.7)", stderr: "" };
      }
      if (command === "powershell.exe" && args.at(-1)?.includes("$PSVersionTable")) {
        return { exitCode: 0, stdout: "5.1", stderr: "" };
      }
      return { exitCode: 0, stdout: `${command} ${args.join(" ")} ${options?.cwd ?? ""}`, stderr: "" };
    });
    const service = createStrategy();
    const installPromise = service.install();

    await installerStartedPromise;
    const cancel = await service.cancelInstall();
    const result = await installPromise;

    expect(cancel.ok).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("已取消");
    mockOfficialInstaller({
      script: "param([switch]$SkipSetup,[string]$HermesHome,[string]$InstallDir)",
    });
    healthCheckMock.mockResolvedValue({
      engineId: "hermes",
      label: "Hermes",
      available: true,
      mode: "cli",
      path: defaultWindowsInstallRoot(),
      message: "ready",
    });
    const retry = await service.install();
    expect(retry.ok).toBe(true);
  });
});

function mockOfficialInstaller(input: {
  script: string;
  installerRuns?: string[][];
  installerStdout?: string;
  createHermes?: boolean;
  downloadUrls?: string[];
  systemGitAvailable?: boolean;
  systemPythonAvailable?: boolean;
  wingetAvailable?: boolean;
}) {
  runCommandMock.mockImplementation(async (command: string, args: string[] = [], options?: { cwd?: string }) => {
    if (command === "powershell.exe" && args.includes("-Command") && args.some((arg) => arg.includes("Invoke-WebRequest"))) {
      const commandText = args.at(-1) ?? "";
      const outFile = /-OutFile '([^']+)'/.exec(commandText)?.[1];
      const url = /-Uri '([^']+)'/.exec(commandText)?.[1];
      if (url) input.downloadUrls?.push(url);
      if (!outFile) return { exitCode: 1, stdout: "", stderr: "missing OutFile" };
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.writeFile(outFile, input.script, "utf8");
      return { exitCode: 0, stdout: "downloaded", stderr: "" };
    }
    if (command === "powershell.exe" && args.includes("-File")) {
      input.installerRuns?.push([...args]);
      const rootPath = valueAfter(args, "-InstallDir") ?? defaultWindowsInstallRoot();
      if (input.createHermes !== false) {
        await fs.mkdir(path.join(rootPath, "venv", "Scripts"), { recursive: true });
        await fs.writeFile(path.join(rootPath, "venv", "Scripts", "hermes.exe"), "", "utf8");
        await fs.writeFile(path.join(rootPath, "pyproject.toml"), "[project]\nname='hermes-agent'\n", "utf8");
      }
      return { exitCode: 0, stdout: input.installerStdout ?? "installed", stderr: "" };
    }
    if (command.endsWith("hermes.exe") && args[0] === "--version") {
      return { exitCode: 0, stdout: "Hermes Agent v0.13.0 (2026.5.7)", stderr: "" };
    }
    if (command === "powershell.exe" && args.includes("[Environment]::SetEnvironmentVariable")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "powershell.exe" && args.at(-1)?.includes("$PSVersionTable")) {
      return { exitCode: 0, stdout: "5.1", stderr: "" };
    }
    if (command === "git") {
      if (input.systemGitAvailable === false) {
        return { exitCode: 1, stdout: "", stderr: "git missing" };
      }
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "git version fixture", stderr: "" };
      }
    }
    if (args.at(-1) === "--version" && input.systemPythonAvailable === false && /(?:^|[\\/])(python|py)(?:\.exe)?$/i.test(command)) {
      return { exitCode: 1, stdout: "", stderr: "python missing" };
    }
    if (command === "winget" && input.wingetAvailable === false) {
      return { exitCode: 1, stdout: "", stderr: "winget missing" };
    }
    return { exitCode: 0, stdout: `${command} ${args.join(" ")} ${options?.cwd ?? ""}`, stderr: "" };
  });
}

function createStrategy() {
  const appPaths = {
    baseDir: () => tempRoot,
    hermesDir: () => path.join(tempRoot, "profiles", "default", "hermes"),
  } as AppPaths;
  const configStore = {
    read: async () => config,
    write: async (next: RuntimeConfig) => {
      config = next;
      return next;
    },
    getEnginePath: async () => config.enginePaths?.hermes ?? defaultWindowsInstallRoot(),
  } as RuntimeConfigStore;
  const hermes = {
    healthCheck: healthCheckMock,
  } as EngineAdapter;
  return new NativeInstallStrategy(appPaths, hermes, configStore);
}

function defaultWindowsInstallRoot() {
  return process.platform === "win32"
    ? path.join(tempRoot, "hermes", "hermes-agent")
    : path.join(os.homedir(), "Hermes Agent");
}

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
