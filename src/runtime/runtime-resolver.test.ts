import { describe, expect, it } from "vitest";
import { sanitizeEnvForWsl, WSL_FORWARD_BLOCKLIST } from "./runtime-resolver";

describe("sanitizeEnvForWsl", () => {
  it("strips Windows-only variables that would corrupt `wsl.exe env … bash -lc`", () => {
    const sanitized = sanitizeEnvForWsl({
      PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC",
      Path: "C:\\Windows;C:\\Windows\\System32",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\xia",
      APPDATA: "C:\\Users\\xia\\AppData\\Roaming",
      PYTHONPATH: "/mnt/d/Hermes Agent",
      PYTHONUTF8: "1",
      OPENAI_API_KEY: "secret",
      KIMI_BASE_URL: "https://api.moonshot.cn",
    });

    expect(sanitized.PATHEXT).toBeUndefined();
    expect(sanitized.Path).toBeUndefined();
    expect(sanitized.ComSpec).toBeUndefined();
    expect(sanitized.SystemRoot).toBeUndefined();
    expect(sanitized.USERPROFILE).toBeUndefined();
    expect(sanitized.APPDATA).toBeUndefined();

    expect(sanitized.PYTHONPATH).toBe("/mnt/d/Hermes Agent");
    expect(sanitized.PYTHONUTF8).toBe("1");
    expect(sanitized.OPENAI_API_KEY).toBe("secret");
    expect(sanitized.KIMI_BASE_URL).toBe("https://api.moonshot.cn");
  });

  it("matches blocked keys case-insensitively", () => {
    const sanitized = sanitizeEnvForWsl({
      pathext: ".EXE",
      PATH: "C:\\Windows",
      systemroot: "C:\\Windows",
    });
    expect(Object.keys(sanitized)).toHaveLength(0);
  });

  it("drops values with embedded newlines that would break the wsl.exe argv", () => {
    const sanitized = sanitizeEnvForWsl({
      SAFE_VALUE: "ok",
      INJECTED: "value\nrm -rf /",
      ALSO_BAD: "value\r\nbad",
    });
    expect(sanitized.SAFE_VALUE).toBe("ok");
    expect(sanitized.INJECTED).toBeUndefined();
    expect(sanitized.ALSO_BAD).toBeUndefined();
  });

  it("ignores undefined values without crashing", () => {
    const sanitized = sanitizeEnvForWsl({
      DEFINED: "x",
      MISSING: undefined,
    });
    expect(sanitized.DEFINED).toBe("x");
    expect(Object.keys(sanitized)).not.toContain("MISSING");
  });

  it("includes PATHEXT in the documented blocklist so the regression cannot be silently removed", () => {
    expect(WSL_FORWARD_BLOCKLIST).toEqual(expect.arrayContaining(["PATHEXT", "PATH", "ComSpec", "SystemRoot", "USERPROFILE"]));
  });
});
