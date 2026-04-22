import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";
import { useAppStore } from "../../store";

describe("StatusBar", () => {
  beforeEach(() => {
    useAppStore.getState().resetStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lights API and Hermes from real and fallback status sources", async () => {
    useAppStore.setState({
      clientInfo: {
        appVersion: "0.1.2",
        userDataPath: "D:/temp",
        portable: false,
        rendererMode: "dev",
      },
      hermesStatus: {
        engine: {
          engineId: "hermes",
          label: "Hermes",
          available: true,
          mode: "cli",
          message: "Hermes 已连接",
        },
        update: {
          engineId: "hermes",
          updateAvailable: false,
          sourceConfigured: true,
          message: "最新",
        },
        memory: {
          engineId: "hermes",
          workspaceId: "workspace",
          usedCharacters: 100,
          entries: 2,
          message: "ok",
        },
      },
    });

    window.workbenchClient = {
      ...window.workbenchClient,
      getClientInfo: vi.fn().mockResolvedValue({
        appVersion: "0.1.2",
        userDataPath: "D:/temp",
        portable: false,
        rendererMode: "dev",
      }),
      getGatewayStatus: vi.fn().mockResolvedValue({
        running: true,
        managedRunning: true,
        healthStatus: "running",
        message: "Gateway 正在运行",
        checkedAt: "2026-04-22T10:00:00.000Z",
      }),
      onClientUpdateEvent: vi.fn().mockReturnValue(() => undefined),
    };

    render(<StatusBar />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.getByRole("button", { name: "API 连接正常" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hermes 已连接" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gateway 正在运行" })).toBeInTheDocument();
    expect(screen.getByTestId("status-light-api")).toHaveClass("hermes-status-light--ok");
    expect(screen.getByTestId("status-light-hermes")).toHaveClass("hermes-status-light--ok");
    expect(screen.getByTestId("status-light-gateway")).toHaveClass("hermes-status-light--ok");
  });

  it("uses amber for checking and warning states, and rose for errors", async () => {
    useAppStore.setState({
      hermesProbe: {
        checkedAt: "2026-04-22T10:00:00.000Z",
        probe: {
          engineId: "hermes",
          checkedAt: "2026-04-22T10:00:00.000Z",
          status: "warning",
          primaryMetric: "warning",
          secondaryMetric: "Hermes warning",
          metrics: [],
          message: "Hermes 可用但存在警告",
        },
      },
    });

    window.workbenchClient = {
      ...window.workbenchClient,
      getGatewayStatus: vi.fn().mockResolvedValue({
        running: false,
        managedRunning: false,
        healthStatus: "error",
        message: "Gateway 异常",
        checkedAt: "2026-04-22T10:00:00.000Z",
      }),
      onClientUpdateEvent: vi.fn().mockReturnValue(() => undefined),
    };

    render(<StatusBar />);

    expect(screen.getByTestId("status-light-api")).toHaveClass("hermes-status-light--warn");
    expect(screen.getByTestId("status-light-hermes")).toHaveClass("hermes-status-light--warn");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.getByTestId("status-light-gateway")).toHaveClass("hermes-status-light--error");
  });
});
