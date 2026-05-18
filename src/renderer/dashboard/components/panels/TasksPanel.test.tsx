import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store";
import { TasksPanel } from "./TasksPanel";

describe("TasksPanel", () => {
  beforeEach(() => {
    useAppStore.getState().resetStore();
    window.workbenchClient = {
      getWebUiOverview: vi.fn(async () => ({
        settings: { theme: "green-light", language: "zh", sendKey: "enter", showUsage: false, showCliSessions: true },
        projects: [],
        spaces: [],
        skills: [],
        memory: [],
        crons: [],
        profiles: [],
        slashCommands: [],
      })),
      getGatewayStatus: vi.fn(async () => ({ running: false, healthStatus: "stopped", autoStartState: "idle", autoStartMessage: "idle", message: "stopped" })),
    } as unknown as Window["workbenchClient"];
  });

  it("refreshes the WebUI overview when the panel mounts", async () => {
    render(<TasksPanel />);

    await waitFor(() => {
      expect(window.workbenchClient.getWebUiOverview).toHaveBeenCalledTimes(1);
    });
    expect(useAppStore.getState().webUiOverview?.crons).toEqual([]);
  });
});
