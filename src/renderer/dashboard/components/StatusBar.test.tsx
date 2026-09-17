import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";
import { useAppStore } from "../../store";

describe("StatusBar", () => {
  beforeEach(() => {
    useAppStore.getState().resetStore();
  });

  it("labels an unrequested Hermes probe as idle instead of spinning indefinitely", () => {
    useAppStore.setState({ clientInfo: { appVersion: "0.2.32", userDataPath: "test", portable: false, rendererMode: "built" } });
    const getHermesProbe = vi.fn();
    window.workbenchClient = { ...window.workbenchClient, getHermesProbe, onClientUpdateEvent: vi.fn().mockReturnValue(() => undefined) };
    render(<StatusBar />);
    expect(screen.getByRole("button", { name: /待检查/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /检查中/ })).toBeNull();
    expect(screen.getByTestId("status-summary-light")).toHaveClass("hermes-status-light--idle");
    expect(getHermesProbe).not.toHaveBeenCalled();
  });

  it("makes no Gateway or probe requests during five idle minutes", async () => {
    vi.useFakeTimers();
    try {
      const getGatewayStatus = vi.fn();
      const getHermesProbe = vi.fn();
      window.workbenchClient = { ...window.workbenchClient, getGatewayStatus, getHermesProbe, onClientUpdateEvent: vi.fn().mockReturnValue(() => undefined) };
      const view = render(<StatusBar />);
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
      expect(getGatewayStatus).not.toHaveBeenCalled();
      expect(getHermesProbe).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("summarizes healthy status into one quiet entry and expands details on demand", () => {
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

    expect(screen.getByRole("button", { name: /环境就绪/ })).toBeInTheDocument();
    expect(screen.queryByTestId("status-light-api")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /环境就绪/ }));

    expect(screen.getByText("API")).toBeInTheDocument();
    expect(screen.getByText("Hermes")).toBeInTheDocument();
    expect(screen.getByText("Gateway")).toBeInTheDocument();
    expect(screen.getByText("更新")).toBeInTheDocument();
    expect(screen.getByTestId("status-light-api")).toHaveClass("hermes-status-light--ok");
    expect(screen.getByTestId("status-light-hermes")).toHaveClass("hermes-status-light--ok");
    expect(screen.getByTestId("status-light-gateway")).toHaveClass("hermes-status-light--idle");
    expect(getGatewayStatus).not.toHaveBeenCalled();
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

    expect(screen.getByRole("button", { name: /有提醒/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /有提醒/ }));
    expect(screen.getByTestId("status-light-api")).toHaveClass("hermes-status-light--warn");
    expect(screen.getByTestId("status-light-hermes")).toHaveClass("hermes-status-light--warn");
    expect(screen.getByTestId("status-light-gateway")).toHaveClass("hermes-status-light--idle");
    expect(getGatewayStatus).not.toHaveBeenCalled();
    expect(getHermesProbe).not.toHaveBeenCalled();
  });

  it("suppresses stale Windows Control Bridge probe noise in Hermes detail", () => {
    useAppStore.setState({
      clientInfo: {
        appVersion: "0.1.2",
        userDataPath: "D:/temp",
        portable: false,
        rendererMode: "dev",
      },
      runtimeConfig: {
        hermesRuntime: { mode: "windows", pythonCommand: "python", windowsAgentMode: "hermes_native", cliPermissionMode: "guarded", permissionPolicy: "bridge_guarded" },
        modelProfiles: [],
        updateSources: {},
      } as any,
      hermesProbe: {
        checkedAt: "2026-05-18T10:00:00.000Z",
        probe: {
          engineId: "hermes",
          checkedAt: "2026-05-18T10:00:00.000Z",
          status: "healthy",
          primaryMetric: "Windows Native",
          secondaryMetric: "D:/Hermes",
          metrics: [],
          message: "Windows Control Bridge 不可达。",
        },
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
      getGatewayStatus: vi.fn(),
      onClientUpdateEvent: vi.fn().mockReturnValue(() => undefined),
    };

    render(<StatusBar />);

    fireEvent.click(screen.getByRole("button", { name: /环境就绪/ }));
    expect(screen.queryByText(/Windows Control Bridge/)).toBeNull();
    expect(screen.getByTestId("status-light-hermes")).toHaveClass("hermes-status-light--ok");
  });

  it("turns Hermes updates into a visible reminder summary", () => {
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
          currentVersion: "Hermes Agent v0.11.0",
          latestVersion: "v0.12.0",
          updateAvailable: true,
          sourceConfigured: true,
          message: "Hermes 有新版本可更新，当前版本 Hermes Agent v0.11.0，最新版本 v0.12.0。",
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
      getGatewayStatus: vi.fn(),
      onClientUpdateEvent: vi.fn().mockReturnValue(() => undefined),
    };

    render(<StatusBar />);

    expect(screen.getByRole("button", { name: /有提醒/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /有提醒/ }));
    expect(screen.getByText("Hermes 更新")).toBeInTheDocument();
    expect(screen.getAllByText(/Hermes 有新版本可更新/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("status-light-hermes")).toHaveClass("hermes-status-light--warn");
  });

  it("prioritizes gateway errors in the summary", async () => {
    const onOpenHealth = vi.fn();
    useAppStore.setState({
      runtimeConfig: { modelProfiles: [], updateSources: {}, extensionSettings: { connectorsEnabled: true, cronEnabled: false, desktopAutomationEnabled: false } } as any,
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
      getGatewayStatus: vi.fn().mockResolvedValue({
        running: false,
        managedRunning: false,
        healthStatus: "error",
        message: "Gateway exited with code 1.",
        checkedAt: "2026-04-21T01:00:00.000Z",
      }),
      onClientUpdateEvent: vi.fn().mockReturnValue(() => undefined),
    };

    render(<StatusBar onOpenHealth={onOpenHealth} />);

    expect(window.workbenchClient.getGatewayStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /环境就绪/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /环境需处理/ })).toBeInTheDocument());
    expect(screen.getAllByText("Gateway exited with code 1.").length).toBeGreaterThan(0);
    expect(screen.getByTestId("status-light-gateway")).toHaveClass("hermes-status-light--error");
    fireEvent.click(screen.getByRole("button", { name: /打开健康检查/ }));
    expect(onOpenHealth).toHaveBeenCalledTimes(1);
  });
});
