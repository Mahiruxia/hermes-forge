// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>());
vi.mock("electron", () => ({
  app: {}, BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {},
  ipcMain: { handle: (channel: string, listener: (...args: any[]) => Promise<any>) => handlers.set(channel, listener) },
}));
import { registerIpcHandlers } from "./ipc";
import { IpcChannels } from "../shared/ipc";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false, send: vi.fn() };
  const event = { sender: webContents, senderFrame: mainFrame };
  const services = {
    taskRunner: { listRunningSessionIds: vi.fn(() => []), isWorkSessionRunning: vi.fn(() => false), start: vi.fn(async () => ({ ok: true })) },
    configStore: { read: vi.fn(async () => ({ extensionSettings: { cronEnabled: false } })) },
    setupService: { updateHermes: vi.fn(async () => ({ ok: true })) },
    preflightService: { invalidateCaches: vi.fn() },
    hermesConnectorService: { setMaintenance: vi.fn(), status: vi.fn(async () => ({ running: false })), shutdown: vi.fn(async () => {}), start: vi.fn() },
    hermesWebUiService: { runCronJob: vi.fn(async () => ({ ok: true })), listCronJobs: vi.fn(async () => []) },
    workSessionService: { clearSessionFiles: vi.fn(async () => ({ ok: true })), delete: vi.fn(async () => ({ ok: true })) },
  };
  registerIpcHandlers({ webContents } as never, services as never);
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return { services, invoke };
}

beforeEach(() => handlers.clear());
describe("IPC maintenance coordination", () => {
  it("blocks manual cron execution while the extension is disabled", async () => {
    const { services, invoke } = harness();
    await expect(invoke(IpcChannels.runCronJob, "job-a")).rejects.toThrow("启用定时任务");
    expect(services.hermesWebUiService.runCronJob).not.toHaveBeenCalled();
  });

  it("holds maintenance until a manual cron operation has finished", async () => {
    const { services, invoke } = harness();
    services.configStore.read.mockResolvedValue({ extensionSettings: { cronEnabled: true } });
    const running = deferred<{ ok: boolean }>();
    services.hermesWebUiService.runCronJob.mockReturnValue(running.promise);
    const task = invoke(IpcChannels.runCronJob, "job-a");
    await expect(invoke(IpcChannels.updateHermes)).rejects.toThrow("执行任务或维护");
    expect(services.setupService.updateHermes).not.toHaveBeenCalled();
    running.resolve({ ok: true });
    await task;
    await expect(invoke(IpcChannels.updateHermes)).resolves.toEqual({ ok: true });
  });

  it("blocks new runtime reads and Gateway starts during maintenance and releases the guard", async () => {
    const { services, invoke } = harness();
    const updating = deferred<{ ok: boolean }>();
    services.setupService.updateHermes.mockReturnValue(updating.promise);
    const update = invoke(IpcChannels.updateHermes);
    await expect(invoke(IpcChannels.startGateway)).rejects.toThrow("正在维护");
    await expect(invoke(IpcChannels.listCronJobs)).rejects.toThrow("正在维护");
    expect(services.hermesConnectorService.setMaintenance).toHaveBeenCalledWith(true);
    updating.resolve({ ok: true });
    await update;
    expect(services.hermesConnectorService.setMaintenance).toHaveBeenLastCalledWith(false);
    await expect(invoke(IpcChannels.listCronJobs)).resolves.toEqual([]);
  });

  it("prevents a task from starting while its session is being cleared", async () => {
    const { services, invoke } = harness();
    const clearing = deferred<{ ok: boolean }>();
    services.workSessionService.clearSessionFiles.mockReturnValue(clearing.promise);
    const clear = invoke(IpcChannels.clearSessionFiles, "session-a");
    await expect(invoke(IpcChannels.startTask, { sessionId: "session-a", sessionFilesPath: process.cwd(), workspacePath: process.cwd(), userInput: "hello", taskType: "custom", selectedFiles: [] })).rejects.toThrow("清空或删除");
    expect(services.taskRunner.start).not.toHaveBeenCalled();
    clearing.resolve({ ok: true });
    await clear;
  });
});
