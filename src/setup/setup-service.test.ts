import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupService } from "./setup-service";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { RuntimeConfig } from "../shared/types";

const runCommandMock = vi.fn();

vi.mock("../process/command-runner", () => ({
  runCommand: (...args: Parameters<typeof runCommandMock>) => runCommandMock(...args),
}));

let tempRoot = "";
let config: RuntimeConfig;
let healthCheckMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-setup-service-"));
  config = { modelProfiles: [], updateSources: {}, enginePaths: {} };
  healthCheckMock = vi.fn(async () => ({
    engineId: "hermes",
    label: "Hermes",
    available: false,
    mode: "cli",
    message: "Hermes missing",
  }));
  runCommandMock.mockReset();
  runCommandMock.mockImplementation(async (command: string, args: string[] = []) => {
    if (command === "git" && args[0] === "--version") {
      return { exitCode: 0, stdout: "git version fixture", stderr: "" };
    }
    if (command === "git" && args[0] === "clone") {
      const target = args.at(-1)!;
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "hermes"), "#!/usr/bin/env python\n", "utf8");
      await fs.writeFile(path.join(target, "pyproject.toml"), "[project]\nname='hermes'\n", "utf8");
      return { exitCode: 0, stdout: "clone ok", stderr: "" };
    }
    if (command === "python" && args[0] === "--version") {
      return { exitCode: 0, stdout: "Python fixture", stderr: "" };
    }
    if (command === "python" && args[0] === "-c") {
      return { exitCode: 0, stdout: "aiohttp ok", stderr: "" };
    }
    if (command === "python" && args[0] === "-m") {
      return { exitCode: 0, stdout: "pip ok", stderr: "" };
    }
    if (command === "winget" && args[0] === "--version") {
      return { exitCode: 0, stdout: "v1.9.0", stderr: "" };
    }
    if (command === "winget" && args[0] === "install") {
      return { exitCode: 0, stdout: "install ok", stderr: "" };
    }
    if ((command === "python" || command === "py") && args.at(-1) === "--version") {
      return { exitCode: 0, stdout: "Hermes Agent 0.1.0", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("SetupService installHermes", () => {
  it("reuses an already healthy Hermes install and saves its root path", async () => {
    const rootPath = path.join(tempRoot, "Hermes Agent");
    healthCheckMock.mockResolvedValueOnce({
      engineId: "hermes",
      label: "Hermes",
      available: true,
      mode: "cli",
      path: rootPath,
      message: "Hermes CLI ready",
    });
    const service = createService();

    const result = await service.installHermes();

    expect(result.ok).toBe(true);
    expect(result.rootPath).toBe(rootPath);
    expect(config.enginePaths?.hermes).toBe(rootPath);
  });

  it("refuses to overwrite a non-empty target directory without Hermes signals for custom paths", async () => {
    const rootPath = path.join(tempRoot, "occupied");
    await fs.mkdir(rootPath, { recursive: true });
    await fs.writeFile(path.join(rootPath, "notes.txt"), "user data", "utf8");
    vi.stubEnv("HERMES_INSTALL_DIR", rootPath);
    const service = createService();

    const result = await service.installHermes();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是可自动恢复的 Hermes 安装");
    expect(config.enginePaths?.hermes).toBeUndefined();
  });

  it("does not persist a broken path when post-install adapter health still fails", async () => {
    const service = createService();

    const result = await service.installHermes();

    expect(result.ok).toBe(false);
    expect(result.rootPath).toBe(path.join(os.homedir(), "Hermes Agent"));
    expect(config.enginePaths?.hermes).toBeUndefined();
  });

  it("auto-recovers the default install directory when a stale managed clone is left behind", async () => {
    const rootPath = path.join(tempRoot, "Hermes Agent");
    vi.spyOn(os, "homedir").mockReturnValue(tempRoot);
    await fs.mkdir(rootPath, { recursive: true });
    await fs.writeFile(path.join(rootPath, ".git"), "gitdir", "utf8");
    await fs.writeFile(path.join(rootPath, "README.md"), "partial", "utf8");
    const service = createService();
    healthCheckMock
      .mockResolvedValueOnce({
        engineId: "hermes",
        label: "Hermes",
        available: false,
        mode: "cli",
        message: "Hermes missing",
      })
      .mockResolvedValueOnce({
        engineId: "hermes",
        label: "Hermes",
        available: true,
        mode: "cli",
        path: rootPath,
        message: "Hermes CLI ready",
      });

    const result = await service.installHermes();

    expect(result.ok).toBe(true);
    expect(result.rootPath).toBe(rootPath);
    expect(config.enginePaths?.hermes).toBe(rootPath);
    await expect(fs.readFile(path.join(rootPath, "hermes"), "utf8")).resolves.toContain("#!/usr/bin/env python");
    const siblings = await fs.readdir(tempRoot);
    expect(siblings.some((entry) => entry.startsWith("Hermes Agent.stale-"))).toBe(true);
  });

  it("publishes staged install progress for the first-run UI", async () => {
    const service = createService();
    healthCheckMock
      .mockResolvedValueOnce({
        engineId: "hermes",
        label: "Hermes",
        available: false,
        mode: "cli",
        message: "Hermes missing",
      })
      .mockResolvedValueOnce({
        engineId: "hermes",
        label: "Hermes",
        available: true,
        mode: "cli",
        path: path.join(tempRoot, "Hermes Agent"),
        message: "Hermes CLI ready",
      });
    const events: string[] = [];

    const result = await service.installHermes((event) => {
      events.push(event.stage);
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(expect.arrayContaining(["preflight", "cloning", "installing_dependencies", "health_check", "completed"]));
  });

  it("auto-repairs missing Git during first-run install and continues deployment", async () => {
    const service = createService();
    const rootPath = path.join(tempRoot, "Hermes Agent");
    healthCheckMock
      .mockResolvedValueOnce({
        engineId: "hermes",
        label: "Hermes",
        available: false,
        mode: "cli",
        message: "Hermes missing",
      })
      .mockResolvedValueOnce({
        engineId: "hermes",
        label: "Hermes",
        available: true,
        mode: "cli",
        path: rootPath,
        message: "Hermes CLI ready",
      });
    let gitVersionChecks = 0;
    runCommandMock.mockImplementation(async (command: string, args: string[] = []) => {
      if (command === "git" && args[0] === "--version") {
        gitVersionChecks += 1;
        return gitVersionChecks === 1
          ? { exitCode: 1, stdout: "", stderr: "git missing" }
          : { exitCode: 0, stdout: "git version repaired", stderr: "" };
      }
      if (command === "winget" && args[0] === "--version") {
        return { exitCode: 0, stdout: "v1.9.0", stderr: "" };
      }
      if (command === "winget" && args[0] === "install") {
        return { exitCode: 0, stdout: "git installed", stderr: "" };
      }
      if (command === "python" && args[0] === "--version") {
        return { exitCode: 0, stdout: "Python fixture", stderr: "" };
      }
      if (command === "git" && args[0] === "clone") {
        const target = args.at(-1)!;
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "hermes"), "#!/usr/bin/env python\n", "utf8");
        await fs.writeFile(path.join(target, "pyproject.toml"), "[project]\nname='hermes'\n", "utf8");
        return { exitCode: 0, stdout: "clone ok", stderr: "" };
      }
      if (command === "python" && args[0] === "-m") {
        return { exitCode: 0, stdout: "pip ok", stderr: "" };
      }
      if (command === "python" && args.at(-1) === "--version") {
        return { exitCode: 0, stdout: "Hermes Agent 0.1.0", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const events: string[] = [];

    const result = await service.installHermes((event) => events.push(event.stage));

    expect(result.ok).toBe(true);
    expect(gitVersionChecks).toBe(2);
    expect(events).toContain("repairing_dependencies");
    expect(runCommandMock).toHaveBeenCalledWith(
      "winget",
      expect.arrayContaining(["install", "--id", "Git.Git"]),
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it("uses the Python launcher when python is unavailable but py -3 works", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(tempRoot);
    const service = createService();
    const rootPath = path.join(tempRoot, "Hermes Agent");
    healthCheckMock
      .mockResolvedValueOnce({
        engineId: "hermes",
        label: "Hermes",
        available: false,
        mode: "cli",
        message: "Hermes missing",
      })
      .mockResolvedValueOnce({
        engineId: "hermes",
        label: "Hermes",
        available: true,
        mode: "cli",
        path: rootPath,
        message: "Hermes CLI ready",
      });
    runCommandMock.mockImplementation(async (command: string, args: string[] = []) => {
      if (command === "git" && args[0] === "--version") {
        return { exitCode: 0, stdout: "git version fixture", stderr: "" };
      }
      if (command === "git" && args[0] === "clone") {
        const target = args.at(-1)!;
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "hermes"), "#!/usr/bin/env python\n", "utf8");
        await fs.writeFile(path.join(target, "pyproject.toml"), "[project]\nname='hermes'\n", "utf8");
        return { exitCode: 0, stdout: "clone ok", stderr: "" };
      }
      if (command === "python" && args[0] === "--version") {
        return { exitCode: 1, stdout: "", stderr: "python missing" };
      }
      if (command === "py" && args.join(" ") === "-3 --version") {
        return { exitCode: 0, stdout: "Python 3 launcher", stderr: "" };
      }
      if (command === "py" && args.slice(0, 4).join(" ") === "-3 -m pip install") {
        return { exitCode: 0, stdout: "pip ok", stderr: "" };
      }
      if (command === "py" && args.at(-1) === "--version") {
        return { exitCode: 0, stdout: "Hermes Agent 0.1.0", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await service.installHermes();

    expect(result.ok).toBe(true);
    expect(runCommandMock).toHaveBeenCalledWith(
      "py",
      expect.arrayContaining(["-3", "-m", "pip", "install", "-e", "."]),
      expect.objectContaining({ cwd: rootPath }),
    );
  });
});

describe("SetupService dependency health", () => {
  it("marks missing Git and Python as first-run repairable dependencies", async () => {
    config = {
      defaultModelProfileId: "local",
      modelProfiles: [{ id: "local", provider: "local", model: "gpt-5.4", baseUrl: "http://127.0.0.1:8080/v1" }],
      updateSources: {},
      enginePaths: {},
    };
    healthCheckMock.mockResolvedValueOnce({
      engineId: "hermes",
      label: "Hermes",
      available: true,
      mode: "cli",
      path: path.join(tempRoot, "Hermes Agent"),
      message: "Hermes CLI ready",
    });
    runCommandMock.mockImplementation(async (command: string, args: string[] = []) => {
      if ((command === "git" || command === "python") && args[0] === "--version") {
        return { exitCode: 1, stdout: "", stderr: `${command} missing` };
      }
      if (command === "python" && args[0] === "-c") {
        return { exitCode: 1, stdout: "", stderr: "No module named aiohttp" };
      }
      if (command === "node" && args[0] === "--version") {
        return { exitCode: 0, stdout: "v22.0.0", stderr: "" };
      }
      if (command === "winget" && args[0] === "--version") {
        return { exitCode: 0, stdout: "v1.9.0", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const service = createService();

    const summary = await service.getSummary();

    const git = summary.checks.find((check) => check.id === "git");
    const python = summary.checks.find((check) => check.id === "python");
    const weixin = summary.checks.find((check) => check.id === "weixin-aiohttp");
    expect(git).toMatchObject({ status: "missing", canAutoFix: true, autoFixId: "git", blocking: false });
    expect(python).toMatchObject({ status: "missing", canAutoFix: true, autoFixId: "python", blocking: false });
    expect(weixin).toMatchObject({ status: "warning", canAutoFix: true, autoFixId: "weixin_aiohttp", blocking: false });
    expect(summary.ready).toBe(true);
  });

  it("repairs system dependencies through winget", async () => {
    const service = createService();

    const result = await service.repairDependency("git");

    expect(result.ok).toBe(true);
    expect(result.command).toContain("winget install --id Git.Git");
    expect(runCommandMock).toHaveBeenCalledWith(
      "winget",
      expect.arrayContaining(["install", "--id", "Git.Git"]),
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it("repairs the Weixin aiohttp dependency through pip", async () => {
    const service = createService();

    const result = await service.repairDependency("weixin_aiohttp");

    expect(result.ok).toBe(true);
    expect(result.command).toBe("python -m pip install --upgrade aiohttp");
    expect(runCommandMock).toHaveBeenCalledWith(
      "python",
      ["-m", "pip", "install", "--upgrade", "aiohttp"],
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it("surfaces missing PyYAML as a repairable Hermes dependency", async () => {
    healthCheckMock.mockResolvedValueOnce({
      engineId: "hermes",
      label: "Hermes",
      available: false,
      mode: "cli",
      path: path.join(tempRoot, "Hermes Agent"),
      message: "ModuleNotFoundError: No module named 'yaml'",
    });
    const service = createService();

    const summary = await service.getSummary();
    const hermes = summary.checks.find((check) => check.id === "hermes");
    expect(hermes).toMatchObject({
      status: "missing",
      autoFixId: "hermes_pyyaml",
      fixAction: "install_hermes_dependency",
      canAutoFix: true,
      blocking: true,
    });

    const result = await service.repairDependency("hermes_pyyaml");
    expect(result.ok).toBe(true);
    expect(result.command).toBe("python -m pip install --upgrade PyYAML");
  });
});

function createService(overrides: Partial<EngineAdapter> = {}) {
  const appPaths = {
    baseDir: () => tempRoot,
  } as AppPaths;
  const configStore = {
    read: async () => config,
    write: async (next: RuntimeConfig) => {
      config = next;
      return next;
    },
    getEnginePath: async () => config.enginePaths?.hermes ?? path.join(tempRoot, "Hermes Agent"),
  } as RuntimeConfigStore;
  const hermes = {
    healthCheck: healthCheckMock,
    ...overrides,
  } as EngineAdapter;

  return new SetupService(appPaths, hermes, configStore, { hasSecret: async () => false });
}
