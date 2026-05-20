import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: class {},
  clipboard: { writeText: vi.fn() },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

import { testOnly } from "./ipc";

describe("ipc safety helpers", () => {
  function gatewayStatus(overrides: Record<string, unknown> = {}) {
    return {
      running: false,
      managedRunning: false,
      healthStatus: "stopped",
      checkedAt: "2026-05-20T00:00:00.000Z",
      message: "Gateway 未运行。",
      ...overrides,
    };
  }

  it("rejects executable, UNC, and relative paths for generic openPath", () => {
    expect(testOnly.validateOpenablePath("\\\\evil\\share\\payload.exe").ok).toBe(false);
    expect(testOnly.validateOpenablePath("payload.txt").ok).toBe(false);
    expect(testOnly.validateOpenablePath("C:\\Users\\xia\\Desktop\\payload.ps1").ok).toBe(false);
  });

  it("allows safe local document paths for generic openPath", () => {
    expect(testOnly.validateOpenablePath("C:\\Users\\xia\\Desktop\\notes.md")).toMatchObject({ ok: true });
    expect(testOnly.validateOpenablePath("C:\\Users\\xia\\Desktop\\report.pdf")).toMatchObject({ ok: true });
  });

  it("allows existing local directories after stat validation", () => {
    expect(testOnly.validateOpenablePath("C:\\Users\\xia\\Hermes Agent", { isDirectory: true })).toMatchObject({ ok: true });
  });

  it("rejects private model endpoints unless explicitly allowed", () => {
    expect(testOnly.validateOutboundModelBaseUrl("http://127.0.0.1:6379/v1").ok).toBe(false);
    expect(testOnly.validateOutboundModelBaseUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(testOnly.validateOutboundModelBaseUrl("http://redis:6379/v1").ok).toBe(false);
    expect(testOnly.validateOutboundModelBaseUrl("http://127.0.0.1:11434/v1", { allowPrivateNetwork: true }).ok).toBe(true);
  });

  it("restarts a running Gateway after model runtime sync", async () => {
    const status = gatewayStatus({
      running: true,
      managedRunning: true,
      healthStatus: "running",
      connectedPlatforms: ["weixin"],
      pid: 100,
      message: "Gateway 正在运行。",
    });
    const restartedStatus = gatewayStatus({
      running: true,
      managedRunning: true,
      healthStatus: "running",
      connectedPlatforms: ["weixin"],
      pid: 200,
      message: "Gateway 已启动。",
    });
    const services = {
      hermesConnectorService: {
        status: vi.fn(async () => status),
        restart: vi.fn(async () => ({ ok: true, status: restartedStatus, message: "Gateway 已启动。" })),
      },
    };

    const result = await testOnly.restartGatewayIfRunning(services as never);

    expect(services.hermesConnectorService.restart).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ restarted: true, message: expect.stringContaining("Gateway 已自动重启") });
  });

  it("does not start Gateway on model sync when it is stopped", async () => {
    const services = {
      hermesConnectorService: {
        status: vi.fn(async () => gatewayStatus()),
        restart: vi.fn(),
      },
    };

    const result = await testOnly.restartGatewayIfRunning(services as never);

    expect(services.hermesConnectorService.restart).not.toHaveBeenCalled();
    expect(result).toMatchObject({ restarted: false, skippedReason: "gateway-not-running" });
  });

  it("surfaces Gateway restart failures after model sync", async () => {
    const services = {
      hermesConnectorService: {
        status: vi.fn(async () => gatewayStatus({ running: true, managedRunning: true, healthStatus: "running" })),
        restart: vi.fn(async () => ({ ok: false, status: gatewayStatus(), message: "boom" })),
      },
    };

    await expect(testOnly.restartGatewayIfRunning(services as never)).rejects.toThrow("Gateway 重启失败");
  });
});
