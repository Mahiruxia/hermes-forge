import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store";
import type { HermesInstallEvent, RuntimeConfig } from "../../../../shared/types";
import { SettingsPanel } from "./SettingsPanel";

const getConfigOverview = vi.fn();
const checkUpdates = vi.fn();
const updateHermesConfig = vi.fn();
const installHermes = vi.fn();
const saveWebUiSettings = vi.fn();
const getRuntimeConfig = vi.fn();
const saveRuntimeConfig = vi.fn();
let installEventHandler: ((event: HermesInstallEvent) => void) | undefined;

const runtimeConfig: RuntimeConfig = {
  modelProfiles: [],
  updateSources: {},
  hermesRuntime: {
    mode: "windows",
    pythonCommand: "python",
    windowsAgentMode: "hermes_native",
  },
};

beforeEach(() => {
  useAppStore.getState().resetStore();
  getConfigOverview.mockReset();
  checkUpdates.mockReset();
  updateHermesConfig.mockReset();
  installHermes.mockReset();
  saveWebUiSettings.mockReset();
  getRuntimeConfig.mockReset();
  saveRuntimeConfig.mockReset();
  installEventHandler = undefined;
  useAppStore.setState({
    webUiOverview: {
      settings: { theme: "green-light", language: "zh", sendKey: "enter", sendKeyHintDismissed: false, showUsage: false, showCliSessions: true },
      projects: [],
      spaces: [],
      skills: [],
      memory: [],
      crons: [],
      profiles: [],
      slashCommands: [],
    },
  });
  saveWebUiSettings.mockImplementation(async (input) => ({
    ...useAppStore.getState().webUiOverview!.settings,
    ...input,
  }));
  Object.assign(window, {
    workbenchClient: {
      getConfigOverview,
      checkUpdates,
      updateHermesConfig,
      installHermes,
      onInstallHermesEvent: vi.fn((handler: (event: HermesInstallEvent) => void) => {
        installEventHandler = handler;
        return () => undefined;
      }),
      getPermissionOverview: vi.fn(),
      pickHermesInstallFolder: vi.fn(),
      openPath: vi.fn(),
      cancelInstallHermes: vi.fn(),
      importExistingHermesConfig: vi.fn(),
      updateHermes: vi.fn(),
      testHermesWindowsBridge: vi.fn(),
      saveWebUiSettings,
      getRuntimeConfig,
      saveRuntimeConfig,
    },
  });
  getConfigOverview.mockResolvedValue({
    runtimeConfig,
    hermes: {
      runtime: runtimeConfig.hermesRuntime,
      rootPath: "",
      bridge: { running: false, capabilities: [] },
    },
  });
  checkUpdates.mockResolvedValue([]);
  updateHermesConfig.mockResolvedValue(runtimeConfig);
  getRuntimeConfig.mockResolvedValue(runtimeConfig);
  saveRuntimeConfig.mockImplementation(async (config) => config);
});

describe("SettingsPanel Hermes installation", () => {
  it("asks for an install source before one-click install", async () => {
    installHermes.mockResolvedValue({ ok: true, message: "installed", rootPath: "C:/Hermes" });

    renderSettingsPanel();

    fireEvent.click(await screen.findByRole("button", { name: /一键安装/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(installHermes).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /官方 GitHub/ }));

    await waitFor(() => {
      expect(installHermes).toHaveBeenCalledWith({ source: { kind: "official" } });
    });
  });

  it("shows mirror retry after official install failure and retries with mirror only after click", async () => {
    installHermes.mockImplementation(async (options) => {
      installEventHandler?.({
        stage: "failed",
        progress: 100,
        message: "官方源安装失败",
        detail: "可改用国内社区镜像重试",
        startedAt: "2026-05-18T00:00:00.000Z",
        at: "2026-05-18T00:00:01.000Z",
        sourceLabel: options?.source?.kind,
      });
      return { ok: false, message: "failed", rootPath: "C:/Hermes" };
    });

    renderSettingsPanel();

    fireEvent.click(await screen.findByRole("button", { name: /一键安装/ }));
    fireEvent.click(await screen.findByRole("button", { name: /官方 GitHub/ }));

    const retry = await screen.findByRole("button", { name: /改用国内社区镜像重试/ });
    expect(installHermes).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);

    await waitFor(() => {
      expect(installHermes).toHaveBeenLastCalledWith({ source: { kind: "mirror" } });
    });
  });

  it("saves workbench preferences from the settings center", async () => {
    renderSettingsPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Ctrl+Enter 发送" }));

    await waitFor(() => expect(saveWebUiSettings).toHaveBeenCalledWith({
      sendKey: "mod-enter",
      sendKeyHintDismissed: true,
    }));
    expect(useAppStore.getState().webUiOverview?.settings.sendKey).toBe("mod-enter");

    fireEvent.click(screen.getByRole("switch", { name: "显示 Token 用量" }));

    await waitFor(() => expect(saveWebUiSettings).toHaveBeenCalledWith({ showUsage: true }));
    expect(useAppStore.getState().webUiOverview?.settings.showUsage).toBe(true);
  });

  it("persists the Gateway startup preference", async () => {
    renderSettingsPanel();

    fireEvent.click(await screen.findByRole("button", { name: /高级设置/ }));
    fireEvent.click(screen.getByRole("combobox", { name: "启动时自动运行 Gateway" }));
    fireEvent.click(screen.getByRole("option", { name: "开启" }));

    await waitFor(() => expect(saveRuntimeConfig).toHaveBeenCalledWith({
      ...runtimeConfig,
      startupGatewayAutoStart: true,
    }));
  });
});

function renderSettingsPanel() {
  return render(
    <SettingsPanel
      onClearSession={vi.fn()}
      onOpenSessionFolder={vi.fn()}
      onOpenSettings={vi.fn()}
      onRefresh={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}
