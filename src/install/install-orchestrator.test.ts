import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { InstallStrategy } from "./install-strategy";
import { InstallOrchestrator } from "./install-orchestrator";

describe("maintenance serialization", () => {
  it("blocks update and repair while installation runs, allows cancellation, then releases the lock", async () => {
    let finish!: (value: unknown) => void;
    const strategy = { install: vi.fn(() => new Promise((resolve) => { finish = resolve; })), update: vi.fn().mockResolvedValue({ ok: true }), repairDependency: vi.fn(), cancelInstall: vi.fn().mockResolvedValue({ ok: true, message: "cancelled" }) } as unknown as InstallStrategy;
    const service = new InstallOrchestrator({} as RuntimeConfigStore, strategy);
    const install = service.install();
    expect(service.isBusy()).toBe(true);
    await expect(service.update()).rejects.toThrow("正在进行");
    await expect(service.repairDependency("hermes_pyyaml")).rejects.toThrow("正在进行");
    await expect(service.cancelInstall()).resolves.toMatchObject({ ok: true });
    finish({ ok: false });
    await install;
    expect(service.isBusy()).toBe(false);
    await expect(service.update()).resolves.toMatchObject({ ok: true });
  });
  it("releases the lock after a failed maintenance call", async () => {
    const strategy = { update: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true }) } as unknown as InstallStrategy;
    const service = new InstallOrchestrator({} as RuntimeConfigStore, strategy);
    await expect(service.update()).rejects.toThrow("offline");
    expect(service.isBusy()).toBe(false);
    await expect(service.update()).resolves.toMatchObject({ ok: true });
  });
});
