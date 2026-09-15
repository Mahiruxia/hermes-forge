import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../store";
import { TasksPanel } from "./TasksPanel";

describe("TasksPanel", () => {
  beforeEach(() => {
    useAppStore.getState().resetStore();
    window.workbenchClient = {
      listCronJobs: vi.fn(async () => []),
      getWebUiOverview: vi.fn(),
      getGatewayStatus: vi.fn(async () => ({ running: false, healthStatus: "stopped", autoStartState: "idle", autoStartMessage: "idle", message: "stopped" })),
    } as unknown as Window["workbenchClient"];
  });

  it("loads cron jobs without scanning unrelated overview data", async () => {
    render(<TasksPanel />);

    await waitFor(() => {
      expect(window.workbenchClient.listCronJobs).toHaveBeenCalledTimes(1);
      expect(window.workbenchClient.getWebUiOverview).not.toHaveBeenCalled();
    });
    expect(useAppStore.getState().webUiOverview?.crons).toEqual([]);
  });
});
