import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";
import { useAppStore } from "../../store";

describe("StatusBar", () => {
  beforeEach(() => {
    useAppStore.getState().resetStore();
  });

  it("lights API and Hermes from cached store status without probing Gateway", () => {
    useAppStore.setState({
      runtimeConfig: {
        hermesRuntime: { mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native", cliPermissionMode: "guarded", permissionPolicy: "bridge_guarded" },
        modelProfiles: [],
        updateSources: {},
      } as any,
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
    const getGatewayStatus = vi.fn();
    const getHermesProbe = vi.fn();

    window.workbenchClient = {
      ...window.workbenchClient,
      getGatewayStatus,
      getHermesProbe,
      onClientUpdateEvent: vi.fn().mockReturnValue(() => undefined),
    };

    render(<StatusBar />);

    expect(screen.getByRole("button", { name: "API 连接正常" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hermes 已连接 · 当前运行：WSL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gateway 状态未刷新" })).toBeInTheDocument();
    expect(screen.getByTestId("status-light-api")).toHaveClass("hermes-status-light--ok");
    expect(screen.getByTestId("status-light-hermes")).toHaveClass("hermes-status-light--ok");
    expect(screen.getByTestId("status-light-gateway")).toHaveClass("hermes-status-light--idle");
    expect(getGatewayStatus).toHaveBeenCalledTimes(1);
    expect(getHermesProbe).not.toHaveBeenCalled();
  });

  it("uses amber for checking and warning states without polling backend", () => {
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
    const getGatewayStatus = vi.fn();
    const getHermesProbe = vi.fn();

    window.workbenchClient = {
      ...window.workbenchClient,
      getGatewayStatus,
      getHermesProbe,
      onClientUpdateEvent: vi.fn().mockReturnValue(() => undefined),
    };

    render(<StatusBar />);

    expect(screen.getByTestId("status-light-api")).toHaveClass("hermes-status-light--warn");
    expect(screen.getByTestId("status-light-hermes")).toHaveClass("hermes-status-light--warn");
    expect(screen.getByTestId("status-light-gateway")).toHaveClass("hermes-status-light--idle");
    expect(getGatewayStatus).toHaveBeenCalledTimes(1);
    expect(getHermesProbe).not.toHaveBeenCalled();
  });
});
