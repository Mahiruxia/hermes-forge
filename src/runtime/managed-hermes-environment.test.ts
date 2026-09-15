import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { managedHermesEnvironmentAt, managedHermesEnvironmentEnv, resolveManagedHermesEnvironment } from "./managed-hermes-environment";

let root = "";
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-env-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function fixture(name: "venv" | ".venv", platform: "win32" | "darwin" = "win32") {
  const env = managedHermesEnvironmentAt(root, name, platform);
  await fs.mkdir(path.dirname(env.pythonPath), { recursive: true });
  await fs.writeFile(env.pythonPath, "fixture");
  return env;
}

describe("managed Hermes environment", () => {
  it("prefers venv when both environments exist", async () => {
    const venv = await fixture("venv");
    await fixture(".venv");
    expect(await resolveManagedHermesEnvironment(root, "win32")).toEqual(venv);
  });
  it("finds .venv without incorrectly short-circuiting on the first missing path", async () => {
    const venv = await fixture(".venv");
    expect(await resolveManagedHermesEnvironment(root, "win32")).toEqual(venv);
  });
  it("uses macOS bin/python and does not accept Windows executable leftovers", async () => {
    await fixture("venv");
    expect(await resolveManagedHermesEnvironment(root, "darwin")).toBeUndefined();
    const venv = await fixture(".venv", "darwin");
    expect(await resolveManagedHermesEnvironment(root, "darwin")).toEqual(venv);
  });
  it("pins the runtime and uv environment while preserving the active Hermes home", async () => {
    const venv = await fixture("venv");
    const env = managedHermesEnvironmentEnv(venv, { HERMES_HOME: "/profiles/work", Path: "system-bin", VIRTUAL_ENV: "wrong", HERMES_DISABLE_LAZY_INSTALLS: "0", HERMES_LAZY_INSTALL_TARGET: "/unlocked-packages" });
    expect(env).toMatchObject({ HERMES_HOME: "/profiles/work", VIRTUAL_ENV: venv.venvPath, UV_PROJECT_ENVIRONMENT: venv.venvPath, PYTHONNOUSERSITE: "1", HERMES_DISABLE_LAZY_INSTALLS: "1" });
    expect(env.HERMES_LAZY_INSTALL_TARGET).toBeUndefined();
    expect(env.Path).toBeUndefined();
    expect(env.PATH).toBe(path.dirname(venv.pythonPath) + path.delimiter + "system-bin");
  });
});
