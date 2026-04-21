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
    if (command === "python" && args[0] === "-m") {
      return { exitCode: 0, stdout: "pip ok", stderr: "" };
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
