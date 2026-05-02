import { describe, expect, it } from "vitest";
import { runtimeConfigSchema, startTaskInputSchema } from "./schemas";

const baseInput = {
  taskType: "custom" as const,
  workspacePath: "D:/workspace",
  sessionFilesPath: "D:/workspace/.sessions/session-active",
  selectedFiles: [],
};

describe("startTaskInputSchema", () => {
  it("accepts a normal Hermes task", () => {
    const parsed = startTaskInputSchema.parse({
      ...baseInput,
      userInput: "帮我分析这个文件",
    });

    expect(parsed.userInput).toBe("帮我分析这个文件");
  });

  it("rejects empty userInput", () => {
    expect(() =>
      startTaskInputSchema.parse({
        ...baseInput,
        userInput: "   ",
      }),
    ).toThrow();
  });

  it("rejects removed engine routing fields", () => {
    const parsed = startTaskInputSchema.safeParse({
      ...baseInput,
      userInput: "hello",
      ["manual" + "Engine"]: "hermes",
      ["mention" + "Engines"]: ["hermes"],
    });

    expect(parsed.success).toBe(true);
    expect(("manual" + "Engine") in parsed.data!).toBe(false);
    expect(("mention" + "Engines") in parsed.data!).toBe(false);
  });
});

describe("runtimeConfigSchema", () => {
  it("defaults Hermes runtime to Windows mode", () => {
    const parsed = runtimeConfigSchema.parse({
      modelProfiles: [{ id: "local", provider: "local", model: "mock" }],
    });

    expect(parsed.hermesRuntime).toEqual({
      mode: "windows",
      distro: undefined,
      pythonCommand: "python",
      windowsAgentMode: "hermes_native",
      cliPermissionMode: "yolo",
      permissionPolicy: "bridge_guarded",
      workerMode: "off",
    });
  });

  it("migrates legacy WSL runtime settings to Windows", () => {
    const parsed = runtimeConfigSchema.parse({
      modelProfiles: [{ id: "local", provider: "local", model: "mock" }],
      hermesRuntime: {
        mode: "wsl",
        distro: "Ubuntu",
        pythonCommand: "python3",
        windowsAgentMode: "host_tool_loop",
        cliPermissionMode: "safe",
        permissionPolicy: "passthrough",
        workerMode: "experimental_wsl",
        installSource: {
          repoUrl: "https://github.com/example/hermes-agent.git",
          branch: "main",
          commit: "abcdef1234567",
          sourceLabel: "pinned",
        },
      },
    });

    expect(parsed.hermesRuntime).toEqual({
      mode: "windows",
      distro: undefined,
      pythonCommand: "python3",
      windowsAgentMode: "host_tool_loop",
      cliPermissionMode: "safe",
      permissionPolicy: "passthrough",
      workerMode: "off",
      installSource: {
        repoUrl: "https://github.com/example/hermes-agent.git",
        branch: "main",
        commit: "abcdef1234567",
        sourceLabel: "pinned",
      },
    });
  });

  it("rejects invalid Hermes runtime modes", () => {
    expect(() =>
      runtimeConfigSchema.parse({
        modelProfiles: [{ id: "local", provider: "local", model: "mock" }],
        hermesRuntime: { mode: "linux" },
      }),
    ).toThrow();
  });
});
