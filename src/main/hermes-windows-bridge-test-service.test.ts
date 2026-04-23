import { describe, expect, it, vi } from "vitest";
import {
  HermesWindowsBridgeTestService,
  buildBridgeTestResult,
  parseWslNameserver,
  wslDistroArgs,
} from "./hermes-windows-bridge-test-service";
import type { CommandResult } from "../process/command-runner";
import type { RuntimeConfig } from "../shared/types";
import type { WindowsControlBridge } from "./windows-control-bridge";

const baseConfig: RuntimeConfig = {
  modelProfiles: [],
  updateSources: {},
  hermesRuntime: { mode: "wsl", pythonCommand: "python3" },
};
const publicFixtureValue = "public-fixture-value";

describe("buildBridgeTestResult", () => {
  it("marks the result ok when every step passed or skipped", () => {
    const result = buildBridgeTestResult("wsl", "http://127.0.0.1:1234", [
      { id: "bridge-running", label: "Bridge", status: "passed", message: "ok" },
      { id: "powershell-smoke", label: "PowerShell", status: "skipped", message: "disabled" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("WSL + Windows Bridge 诊断通过。");
  });

  it("marks the result failed when any step failed", () => {
    const result = buildBridgeTestResult("wsl", undefined, [
      { id: "bridge-running", label: "Bridge", status: "failed", message: "down" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Bridge");
  });
});

describe("WSL bridge test helpers", () => {
  it("parses nameserver output and falls back on empty output", () => {
    expect(parseWslNameserver("172.20.96.1\n")).toBe("172.20.96.1");
    expect(parseWslNameserver("nameserver 10.255.255.254\n")).toBe("10.255.255.254");
    expect(parseWslNameserver("default via 172.17.160.1 dev eth0 proto kernel\n")).toBe("172.17.160.1");
    expect(parseWslNameserver("\r\n")).toBeUndefined();
  });

  it("builds WSL distro args", () => {
    expect(wslDistroArgs({ mode: "wsl", pythonCommand: "python3" })).toEqual([]);
    expect(wslDistroArgs({ mode: "wsl", distro: "Ubuntu", pythonCommand: "python3" })).toEqual(["-d", "Ubuntu"]);
  });
});

describe("HermesWindowsBridgeTestService", () => {
  it("skips PowerShell smoke when commandRun is disabled", async () => {
    const bridge = fakeBridge();
    const runner = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
      const script = args.at(-1) ?? "";
      if (args.includes("route")) return okCommand("default via 172.20.96.1 dev eth0 proto kernel\n");
      return okCommand('{"ok":true}');
    });
    const service = new HermesWindowsBridgeTestService(
      bridge,
      async () => ({
        ...baseConfig,
        enginePermissions: { hermes: { commandRun: false } },
      }),
      async () => new Response('{"ok":true}', { status: 200 }),
      runner,
    );

    const result = await service.test();
    const powershell = result.steps.find((step) => step.id === "powershell-smoke");

    expect(result.ok).toBe(true);
    expect(powershell?.status).toBe("skipped");
    expect(powershell?.message).toContain("commandRun=false");
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("reports local health authorization failures", async () => {
    const service = new HermesWindowsBridgeTestService(
      fakeBridge(),
      async () => ({ ...baseConfig, hermesRuntime: { mode: "windows", pythonCommand: "python3" } }),
      async () => new Response("Unauthorized", { status: 401 }),
      vi.fn(),
    );

    const result = await service.test();
    const localHealth = result.steps.find((step) => step.id === "bridge-health-local");

    expect(result.ok).toBe(false);
    expect(localHealth?.status).toBe("failed");
    expect(localHealth?.message).toContain("鉴权失败");
  });

  it("falls back to 127.0.0.1 when WSL host output is empty", async () => {
    const runner = vi.fn(async (_command: string, args: string[]): Promise<CommandResult> => {
      const script = args.at(-1) ?? "";
      if (script.includes("awk")) return okCommand("");
      return okCommand('{"ok":true}');
    });
    const service = new HermesWindowsBridgeTestService(
      fakeBridge(),
      async () => ({
        ...baseConfig,
        enginePermissions: { hermes: { commandRun: false } },
      }),
      async () => new Response('{"ok":true}', { status: 200 }),
      runner,
    );

    const result = await service.test();
    const hostStep = result.steps.find((step) => step.id === "wsl-host-resolved");
    const healthScript = runner.mock.calls.at(-1)?.[1].at(-1);

    expect(result.ok).toBe(true);
    expect(hostStep?.message).toContain("fallback 到 127.0.0.1");
    expect(healthScript).toContain("http://127.0.0.1:1234");
  });
});

function fakeBridge() {
  return {
    start: vi.fn(async () => ({
      running: true,
      host: "0.0.0.0",
      port: 1234,
      capabilities: ["powershell", "openPath", "clipboard", "screenshot", "writeTextFile"],
    })),
    status: () => ({
      running: true,
      host: "0.0.0.0",
      port: 1234,
      capabilities: ["powershell", "openPath", "clipboard", "screenshot", "writeTextFile"],
    }),
    accessForHost: (host: string) => ({
      url: `http://${host}:1234`,
      token: publicFixtureValue,
      capabilities: "powershell,openPath,clipboard,screenshot,writeTextFile",
    }),
  } as unknown as WindowsControlBridge;
}

function okCommand(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
