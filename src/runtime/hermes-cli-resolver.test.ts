import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateWslHermesCli } from "./hermes-cli-resolver";

const runCommandMock = vi.fn();

vi.mock("../process/command-runner", () => ({
  runCommand: (...args: Parameters<typeof runCommandMock>) => runCommandMock(...args),
}));

describe("hermes-cli-resolver", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
  });

  it("validates managed WSL Hermes with the repo virtualenv python when available", async () => {
    runCommandMock.mockImplementation(async (_command: string, args: string[], options: { commandId: string }) => {
      if (options.commandId.startsWith("hermes-cli.path-test.")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (options.commandId === "hermes-cli.validate.capabilities") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            cliVersion: "0.10.0",
            capabilities: {
              supportsLaunchMetadataArg: true,
              supportsLaunchMetadataEnv: true,
              supportsResume: true,
            },
          }),
          stderr: "",
          args,
        };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected ${options.commandId}` };
    });

    const result = await validateWslHermesCli(
      { mode: "wsl", distro: "Ubuntu", pythonCommand: "python3", managedRoot: "/root/.hermes-forge/hermes-agent" },
      "/root/.hermes-forge/hermes-agent/hermes",
    );

    expect(result.ok).toBe(true);
    const capabilityCall = runCommandMock.mock.calls.find((call) => call[2]?.commandId === "hermes-cli.validate.capabilities");
    expect((capabilityCall?.[1] as string[] | undefined)?.join(" ")).toContain("/root/.hermes-forge/hermes-agent/.venv/bin/python");
  });

  it("explains missing python-dotenv as a Hermes dependency problem", async () => {
    runCommandMock.mockImplementation(async (_command: string, _args: string[], options: { commandId: string }) => {
      if (options.commandId.startsWith("hermes-cli.path-test.")) {
        return { exitCode: options.commandId === "hermes-cli.path-test.x" ? 1 : 0, stdout: "", stderr: "" };
      }
      if (options.commandId === "hermes-cli.validate.capabilities") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "ModuleNotFoundError: No module named 'dotenv'",
        };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected ${options.commandId}` };
    });

    const result = await validateWslHermesCli(
      { mode: "wsl", distro: "Ubuntu", pythonCommand: "python3", managedRoot: "/mnt/c/Users/Jia/Hermes Agent" },
      "/mnt/c/Users/Jia/Hermes Agent/hermes",
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("缺少依赖 python-dotenv");
    expect(result.message).toContain("不是模型配置问题");
    expect(result.message).toContain("一键修复");
  });
});
