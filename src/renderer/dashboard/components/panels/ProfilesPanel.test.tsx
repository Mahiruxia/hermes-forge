import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store";
import type { HermesWebUiOverview } from "../../../../shared/types";
import { ProfilesPanel } from "./ProfilesPanel";

const createProfile = vi.fn();
const switchProfile = vi.fn();
const deleteProfile = vi.fn();
const listProfiles = vi.fn();

beforeEach(() => {
  useAppStore.getState().resetStore();
  createProfile.mockReset();
  switchProfile.mockReset();
  deleteProfile.mockReset();
  listProfiles.mockReset();
  Object.assign(window, {
    workbenchClient: {
      createProfile,
      switchProfile,
      deleteProfile,
      listProfiles,
    },
  });
  useAppStore.setState({
    webUiOverview: overview([
      { id: "default", name: "default", path: "C:/Hermes/default", active: true, hasConfig: true, skillCount: 1, memoryFiles: 2 },
    ]),
  });
  listProfiles.mockResolvedValue([
    { id: "default", name: "default", path: "C:/Hermes/default", active: false, hasConfig: true, skillCount: 1, memoryFiles: 2 },
    { id: "wechat", name: "wechat", path: "C:/Hermes/profiles/wechat", active: true, hasConfig: false, skillCount: 0, memoryFiles: 2 },
  ]);
});

describe("ProfilesPanel", () => {
  it("creates and switches to a new agent in one action", async () => {
    createProfile.mockResolvedValue({ id: "wechat", name: "wechat", path: "C:/Hermes/profiles/wechat", active: false, hasConfig: false, skillCount: 0, memoryFiles: 2 });
    switchProfile.mockResolvedValue({ ok: true, active: "wechat", profiles: [] });

    render(<ProfilesPanel />);

    fireEvent.change(screen.getByPlaceholderText("wechat-assistant"), { target: { value: "wechat" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并切换" }));

    await waitFor(() => {
      expect(createProfile).toHaveBeenCalledWith("wechat");
      expect(switchProfile).toHaveBeenCalledWith("wechat");
      expect(listProfiles).toHaveBeenCalled();
    });
  });

  it("validates agent names before creating", async () => {
    render(<ProfilesPanel />);

    fireEvent.change(screen.getByPlaceholderText("wechat-assistant"), { target: { value: "bad name" } });

    expect(screen.getByText("Agent 名称只能包含字母、数字、下划线和连字符。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建并切换" })).toBeDisabled();
    await waitFor(() => expect(listProfiles).toHaveBeenCalled());
  });
});

function overview(profiles: HermesWebUiOverview["profiles"]): HermesWebUiOverview {
  return {
    settings: { theme: "green-light", language: "zh", sendKey: "enter", sendKeyHintDismissed: true, showUsage: false, showCliSessions: true },
    projects: [],
    spaces: [],
    skills: [],
    memory: [],
    crons: [],
    profiles,
    slashCommands: [],
  };
}
