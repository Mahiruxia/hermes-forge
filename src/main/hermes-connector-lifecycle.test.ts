import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermesConnectorService } from "./hermes-connector-service";

const mocks = { spawn: vi.fn(), runCommand: vi.fn() };

type FakeChild = EventEmitter & { pid: number; killed: boolean; stdout: EventEmitter; stderr: EventEmitter };
const children: FakeChild[] = [];
beforeEach(() => {
  children.length = 0;
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 10000 + children.length, killed: false, stdout: new EventEmitter(), stderr: new EventEmitter() });
    children.push(child);
    return child;
  });
  mocks.runCommand.mockReset().mockImplementation(async (_command, args) => {
    const child = children.find((item) => item.pid === Number(args[1]));
    if (child) { child.killed = true; child.emit("close", 0); }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const config = { extensionSettings: { connectorsEnabled: true, cronEnabled: true } };
  const service = new HermesConnectorService({} as never, {} as never, async () => "D:/fake-hermes", undefined, undefined, undefined, async () => config as never);
  const internal = service as any;
  internal.spawnGatewayProcess = mocks.spawn;
  internal.killGatewayProcess = (pid: number) => mocks.runCommand("taskkill", ["/pid", String(pid), "/t", "/f"]);
  internal.status = vi.fn(async () => ({ running: Boolean(internal.gatewayProcess && !internal.gatewayProcess.killed) || internal.feishuGatewayProcesses.size > 0,
    managedRunning: Boolean(internal.gatewayProcess && !internal.gatewayProcess.killed) || internal.feishuGatewayProcesses.size > 0,
    healthStatus: internal.gatewayFailures.size ? "error" : internal.gatewayProcess ? "running" : "stopped", checkedAt: new Date().toISOString(), message: "test status" }));
  internal.runtimeContext = vi.fn(async () => ({ ok: true, root: "D:/fake-hermes", runtime: { mode: "windows" } }));
  internal.preflightGatewayRuntime = vi.fn(async () => ({ ok: true }));
  internal.ensureGatewayModelRuntime = vi.fn(async () => ({ ok: true }));
  internal.clearGatewayRuntimeMarkers = vi.fn(async () => undefined);
  internal.syncEnv = vi.fn(async () => ({ ok: true }));
  internal.readConfig = vi.fn(async () => ({ platforms: {} }));
  internal.readEnvValues = vi.fn(async () => ({}));
  internal.configuredFeishuInstances = vi.fn(async () => []);
  internal.hasConfiguredNonFeishuConnector = vi.fn(async () => true);
  internal.gatewayLaunchFromRuntime = vi.fn(async () => ({ command: "fake-hermes-python", args: [], env: {}, cwd: "D:/fake-hermes", label: "fake" }));
  internal.sleep = vi.fn(async () => undefined);
  internal.cancelWeixinQrLogin = vi.fn(async () => undefined);
  return { service, internal, config };
}

function pauseMethod(internal: any, method: string, value: unknown) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  internal[method].mockImplementationOnce(async () => { enter(); await gate; return value; });
  return { entered, release };
}

describe("Gateway startup ownership", () => {
  it("cancels a preflight start and waits for it before stop returns", async () => {
    const { service, internal } = fixture();
    const gate = pauseMethod(internal, "preflightGatewayRuntime", { ok: true });
    const starting = service.start();
    await gate.entered;
    const stopping = service.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.release();
    expect(await starting).toMatchObject({ ok: false });
    expect(await stopping).toMatchObject({ ok: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(internal.gatewayUserStopped).toBe(true);
  });

  it("rechecks ownership after building the main launch", async () => {
    const { service, internal } = fixture();
    const gate = pauseMethod(internal, "gatewayLaunchFromRuntime", { command: "must-not-spawn", args: [] });
    const starting = service.start();
    await gate.entered;
    const stopping = service.stop();
    gate.release();
    await Promise.all([starting, stopping]);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rechecks ownership after building a Feishu instance launch", async () => {
    const { service, internal, config } = fixture();
    config.extensionSettings.cronEnabled = false;
    internal.hasConfiguredNonFeishuConnector.mockResolvedValue(false);
    internal.configuredFeishuInstances.mockResolvedValue([["one", {}]]);
    internal.feishuAgentHome = vi.fn(async () => ({ home: "D:/profile", profileId: "one" }));
    internal.feishuInstanceHome = vi.fn(async () => "D:/instance");
    internal.prepareFeishuInstanceRuntimeHome = vi.fn(async () => undefined);
    internal.feishuInstanceEnvPath = vi.fn(async () => "D:/instance/.env");
    internal.readEnvValuesFromPath = vi.fn(async () => ({}));
    const gate = pauseMethod(internal, "gatewayLaunchFromRuntime", { command: "must-not-spawn", args: [] });
    const starting = service.start();
    await gate.entered;
    const stopping = service.stop();
    gate.release();
    await Promise.all([starting, stopping]);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("blocks direct starts and invalidates pending starts during maintenance", async () => {
    const { service, internal } = fixture();
    const gate = pauseMethod(internal, "ensureGatewayModelRuntime", { ok: true });
    const starting = service.start();
    await gate.entered;
    service.setMaintenance(true);
    const shutdown = service.shutdown();
    expect(await service.start()).toMatchObject({ ok: false, message: expect.stringContaining("维护") });
    gate.release();
    await Promise.all([starting, shutdown]);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(internal.cancelWeixinQrLogin).toHaveBeenCalledOnce();
    service.setMaintenance(false);
    expect(await service.start()).toMatchObject({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("restarts with a fresh operation after cancelling a pending start", async () => {
    const { service, internal } = fixture();
    const gate = pauseMethod(internal, "preflightGatewayRuntime", { ok: true });
    const starting = service.start();
    await gate.entered;
    const restarting = service.restart();
    gate.release();
    expect(await starting).toMatchObject({ ok: false });
    expect(await restarting).toMatchObject({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("does not revive a start requested while stop is still waiting", async () => {
    const { service, internal } = fixture();
    const gate = pauseMethod(internal, "preflightGatewayRuntime", { ok: true });
    const starting = service.start();
    await gate.entered;
    const stopping = service.stop();
    const queuedStart = service.start();
    gate.release();
    await Promise.all([starting, stopping]);
    expect(await queuedStart).toMatchObject({ ok: false });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("replaces a managed process without reporting its expected exit as a crash", async () => {
    const { service, internal } = fixture();
    const restart = vi.spyOn(internal, "scheduleAutoRestart");
    expect(await service.start()).toMatchObject({ ok: true });
    expect(await service.start({ forceReplace: true })).toMatchObject({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(restart).not.toHaveBeenCalled();
    expect(internal.gatewayFailures.size).toBe(0);
    await service.stop();
  });
});
