import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfigStore } from "../main/runtime-config";
import { managedHermesEnvironmentAt } from "../runtime/managed-hermes-environment";
import { HermesCompatibilityService } from "./hermes-compatibility-service";
const run = vi.fn();
vi.mock("../process/command-runner", () => ({ runCommand: (...args: unknown[]) => run(...args) }));
let root = "";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-contract-"));
  const env = managedHermesEnvironmentAt(root, ".venv");
  await fs.mkdir(path.dirname(env.pythonPath), { recursive: true });
  await fs.writeFile(env.pythonPath, "fixture");
  await fs.writeFile(env.cliPath, "fixture");
  run.mockReset();
  run.mockImplementation(async (_cmd, args) => ({ exitCode: 0, stdout: args[0] === "--version" ? "Hermes Agent 0.21.3" : '{"compatible":true}', stderr: "" }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const service = () => new HermesCompatibilityService({ getEnginePath: async () => root } as RuntimeConfigStore, () => path.join(root, "profile"));
describe("official Hermes compatibility", () => {
  it("accepts an official .venv install without the old fork capability command", async () => {
    expect(await service().inspect()).toMatchObject({ installed: true, venvStatus: "present", forgeTaskReady: true, warnings: [] });
    expect(run.mock.calls.some(([, args]) => args.includes("capabilities"))).toBe(false);
    expect(run.mock.calls[1][0]).toBe(managedHermesEnvironmentAt(root, ".venv").pythonPath);
    expect(run.mock.calls[1][2].env.HERMES_HOME).toBe(path.join(root, "profile"));
  });
  it("blocks an older version even when its CLI and basic Agent import work", async () => {
    run.mockImplementation(async (_cmd, args) => ({ exitCode: 0, stdout: args[0] === "--version" ? "Hermes Agent 0.14.0" : '{"compatible":true}', stderr: "" }));
    expect(await service().inspect()).toMatchObject({ installed: true, forgeTaskReady: false, blockingIssues: [expect.stringContaining("0.21.3")] });
  });
  it("blocks a missing callback instead of reporting the installation healthy", async () => {
    run.mockImplementation(async (_cmd, args) => ({ exitCode: 0, stdout: args[0] === "--version" ? "Hermes Agent 0.21.3" : '{"compatible":false,"missing":["AIAgent.clarify_callback"]}', stderr: "" }));
    expect(await service().inspect()).toMatchObject({ forgeTaskReady: false, blockingIssues: [expect.stringContaining("clarify_callback")] });
  });
});
