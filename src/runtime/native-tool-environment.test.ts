// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeProcessEnvironment, nativeToolEnvironment } from "./native-tool-environment";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-tools-")); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

describe("native tool discovery", () => {
  it("finds private tools after restart without modifying the inherited environment", async () => {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    const inherited = { PATH: "system-bin", HERMES_HOME: root };
    const env = nativeToolEnvironment(path.join(root, "hermes-agent"), inherited);
    expect(env.PATH?.split(path.delimiter)).toContain(bin);
    expect(env.PATH?.split(path.delimiter).filter((item) => item === bin)).toHaveLength(1);
    expect(env.PATH?.split(path.delimiter)[0]).toBe("system-bin");
    expect(inherited).toEqual({ PATH: "system-bin", HERMES_HOME: root });
  });

  it.skipIf(process.platform !== "win32")("restores managed Git and Bash with no system installation", async () => {
    const gitBin = path.join(root, "git", "bin");
    const gitCmd = path.join(root, "git", "cmd");
    await fs.mkdir(gitBin, { recursive: true });
    await fs.mkdir(gitCmd);
    await fs.writeFile(path.join(gitBin, "bash.exe"), "fixture");
    const env = nativeToolEnvironment(path.join(root, "hermes-agent"), { Path: "" });
    expect(env.PATH?.split(path.delimiter)).toEqual(expect.arrayContaining([gitBin, gitCmd]));
    expect(env.HERMES_GIT_BASH_PATH).toBe(path.join(gitBin, "bash.exe"));
    expect(env.Path).toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")("overrides PATH once regardless of Windows key casing", () => {
    vi.stubEnv("Path", "wrong-bin");
    const env = mergeProcessEnvironment({ PATH: "managed-bin", PYTHONHOME: undefined });
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toBe("managed-bin");
    expect(env.PYTHONHOME).toBeUndefined();
  });
});
