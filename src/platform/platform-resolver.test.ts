import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHermesCliCandidates, getPythonCandidates, getWindowsPythonInstallCandidates, inferHermesRootFromCliPath } from "./platform-resolver";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of ["LOCALAPPDATA", "ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("platform python candidates", () => {
  it("keeps Windows venv paths with spaces as a single executable", () => {
    const candidates = getPythonCandidates("win32", "C:\\Users\\zheng\\Hermes Agent");

    expect(candidates[0]).toEqual({
      command: "C:\\Users\\zheng\\Hermes Agent\\.venv\\Scripts\\python.exe",
      args: [],
      label: "venv Python",
    });
    expect(candidates).toContainEqual({ command: "py", args: ["-3"], label: "py -3" });
  });

  it("adds common Windows Python install locations outside the current PATH", () => {
    process.env.LOCALAPPDATA = "C:\\Users\\zheng\\AppData\\Local";
    process.env.ProgramFiles = "C:\\Program Files";
    process.env.ProgramW6432 = "";
    process.env["ProgramFiles(x86)"] = "";

    expect(getWindowsPythonInstallCandidates("win32")).toEqual(expect.arrayContaining([
      path.normalize("C:\\Users\\zheng\\AppData\\Local\\Programs\\Python\\Python312\\python.exe"),
      path.normalize("C:\\Program Files\\Python312\\python.exe"),
    ]));
  });

  it("uses target-platform separators for Hermes paths regardless of the test host", () => {
    expect(getHermesCliCandidates("win32", "C:\\Hermes Agent")[0]).toBe("C:\\Hermes Agent\\venv\\Scripts\\hermes.exe");
    expect(inferHermesRootFromCliPath("C:\\Hermes Agent\\.venv\\Scripts\\hermes.exe", "win32")).toBe("C:\\Hermes Agent");
    expect(getHermesCliCandidates("darwin", "/Users/xia/Hermes Agent")[0]).toBe("/Users/xia/Hermes Agent/venv/bin/hermes");
    expect(inferHermesRootFromCliPath("/Users/xia/Hermes Agent/.venv/bin/hermes", "darwin")).toBe("/Users/xia/Hermes Agent");
  });
});
