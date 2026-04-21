import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowsToolExecutor } from "./windows-tool-executor";
import type { AutoHotkeyService } from "./autohotkey-service";
import type { CommandResult } from "../process/command-runner";
import type { EngineEvent, EnginePermissionPolicy } from "../shared/types";

vi.mock("electron", () => ({
  clipboard: {
    readText: vi.fn(() => "clip"),
    writeText: vi.fn(),
  },
  desktopCapturer: {
    getSources: vi.fn(async () => [{ thumbnail: { toPNG: () => Buffer.from("png") } }]),
  },
  shell: {
    openPath: vi.fn(async () => ""),
  },
}));

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "windows-tool-executor-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("WindowsToolExecutor", () => {
  it("writes and reads text files through the unified tool API", async () => {
    const executor = createExecutor();
    const filePath = path.join(tempRoot, "demo.txt");

    const write = await executor.execute({ type: "tool_call", tool: "windows.files.writeText", input: { path: filePath, content: "hello" } });
    const read = await executor.execute({ type: "tool_call", tool: "windows.files.readText", input: { path: filePath } });

    expect(write.ok).toBe(true);
    expect(read.ok).toBe(true);
    expect(read.result?.text).toBe("hello");
  });

  it("rejects file writes when fileWrite is disabled", async () => {
    const executor = createExecutor({ fileWrite: false });
    const result = await executor.execute({ type: "tool_call", tool: "windows.files.writeText", input: { path: path.join(tempRoot, "x.txt"), content: "x" } });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("File writing is disabled");
  });

  it("runs PowerShell through the command runner and truncates output shape", async () => {
    const runner = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "example", stderr: "" }));
    const executor = createExecutor({}, runner);

    const result = await executor.execute({ type: "tool_call", tool: "windows.powershell.run", input: { script: "$env:USERNAME" } });

    expect(result.ok).toBe(true);
    expect(result.result?.stdout).toBe("example");
    expect(runner).toHaveBeenCalledWith("powershell.exe", expect.any(Array), expect.any(Object));
  });

  it("reports AutoHotkey unavailable for GUI tools", async () => {
    const executor = createExecutor({}, undefined, {
      status: async () => ({ available: false, message: "missing" }),
      runScript: async () => ({ exitCode: 1, stdout: "", stderr: "missing" }),
    } as AutoHotkeyService);

    const result = await executor.execute({ type: "tool_call", tool: "windows.keyboard.type", input: { text: "hello" } });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("missing");
  });

  it("blocks dangerous tools when approval is denied", async () => {
    const publish = vi.fn(async (_event: EngineEvent) => undefined);
    const approval = vi.fn(async () => ({ approved: false }));
    const executor = createExecutor({}, undefined, undefined, approval);

    const result = await executor.execute(
      { type: "tool_call", tool: "windows.files.writeText", input: { path: path.join(tempRoot, "denied.txt"), content: "x" } },
      { taskRunId: "task-1", publish },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("用户拒绝批准");
    expect(approval).toHaveBeenCalled();
  });
});

function createExecutor(
  permissions: Partial<EnginePermissionPolicy> = {},
  runner = vi.fn(async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "", stderr: "" })),
  ahk = {
    status: async () => ({ available: true, executablePath: "AutoHotkey64.exe", message: "ok" }),
    runScript: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  } as AutoHotkeyService,
  approval = vi.fn(async () => ({ approved: true })),
) {
  return new WindowsToolExecutor(
    async () => ({
      enabled: true,
      workspaceRead: true,
      fileWrite: true,
      commandRun: true,
      memoryRead: true,
      contextBridge: true,
      ...permissions,
    }),
    ahk,
    runner,
    approval,
  );
}
