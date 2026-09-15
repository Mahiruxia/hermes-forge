import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { ExtensionsPanel } from "./ExtensionsPanel";

describe("extension opt in", () => {
  beforeEach(() => useAppStore.getState().resetStore());

  it("opens configuration only after persisting the selected extension", async () => {
    const config = { extensionSettings: { connectorsEnabled: false, cronEnabled: false, desktopAutomationEnabled: false } };
    const getGatewayStatus = vi.fn();
    const listCronJobs = vi.fn();
    const saveRuntimeConfig = vi.fn().mockImplementation(async value => value);
    window.workbenchClient = { ...window.workbenchClient, getRuntimeConfig: vi.fn().mockResolvedValue(config), saveRuntimeConfig, getGatewayStatus, listCronJobs };
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<ExtensionsPanel onRefresh={onRefresh} onOpenEnvironment={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^配置/ })).toBeNull();
    expect(getGatewayStatus).not.toHaveBeenCalled();
    expect(listCronJobs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "启用定时任务" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(saveRuntimeConfig).toHaveBeenCalledWith({ extensionSettings: { connectorsEnabled: false, cronEnabled: true, desktopAutomationEnabled: false } });
    fireEvent.click(screen.getByRole("button", { name: "配置定时任务" }));
    expect(useAppStore.getState().activePanel).toBe("tasks");
    expect(useAppStore.getState().view).toBe("home");
    expect(getGatewayStatus).not.toHaveBeenCalled();
  });
});
