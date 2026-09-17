// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn(() => { throw new Error("A cancelled command must never spawn"); }));
vi.mock("node:child_process", () => ({ spawn }));
import { executeCommand, streamCommand } from "./command-runner";

describe("cancelled command startup", () => {
  it("does not execute queued commands after the install signal was cancelled", async () => {
    const result = await executeCommand("git", ["checkout", "HEAD"], { cwd: process.cwd(), signal: AbortSignal.abort() });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("已取消");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("emits a failed terminal event without spawning the streaming installer", async () => {
    const events = [];
    for await (const event of streamCommand("powershell.exe", ["-File", "installer.ps1"], { cwd: process.cwd(), signal: AbortSignal.abort() })) events.push(event);
    expect(events.at(-1)).toEqual({ type: "exit", exitCode: null });
    expect(spawn).not.toHaveBeenCalled();
  });
});
