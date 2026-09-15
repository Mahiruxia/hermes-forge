import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRunner, extractInlineImagePaths, mimeTypeForImagePath, resolveHermesConversationIdForRuntime, resolveInlineFileAttachments, resolveInlineImageAttachments } from "./task-runner";
import type { EngineEvent, EngineRunRequest, SessionAttachment, StartTaskInput, TaskEventEnvelope } from "../shared/types";

function runnerFor(run: () => AsyncIterable<EngineEvent>) {
  const events: EngineEvent[] = [];
  const release = vi.fn();
  const recordTaskTerminal = vi.fn(async () => undefined);
  const runner = new TaskRunner(
    undefined as never, { release } as never, undefined as never, undefined as never, undefined as never,
    { run } as never,
    { redact: (envelope: TaskEventEnvelope) => envelope, append: async (_workspace: string, envelope: TaskEventEnvelope) => { events.push(envelope.event); } } as never,
    { recordTaskTerminal } as never, () => undefined,
  );
  const controller = new AbortController();
  const internal = runner as unknown as {
    running: Map<string, AbortController>; runSessions: Map<string, string>;
    consumeRun(request: EngineRunRequest, controller: AbortController, workSessionId: string): Promise<void>;
  };
  internal.running.set("task-1", controller);
  internal.runSessions.set("task-1", "chat-1");
  return { runner, events, release, recordTaskTerminal, controller, consume: () => internal.consumeRun({ sessionId: "task-1", workspaceId: "workspace-1" } as EngineRunRequest, controller, "chat-1") };
}

describe("task-runner terminal lifecycle", () => {
  const at = "2026-09-15T06:00:00Z";
  it("counts preflight as active and prevents a cancelled startup from launching", async () => {
    let finishLayout!: (workspaceId: string) => void;
    const layout = new Promise<string>((resolve) => { finishLayout = resolve; });
    const assertCanStart = vi.fn();
    const run = vi.fn();
    const runner = new TaskRunner({ ensureWorkspaceLayout: () => layout } as never,
      undefined as never, undefined as never, { assertCanStart } as never, undefined as never,
      { run } as never, undefined as never, undefined as never, () => undefined);
    const pending = runner.start({ clientTaskId: "preflight-task", sessionId: "chat-1", sessionFilesPath: "D:/session" } as StartTaskInput);
    expect(runner.listRunningSessionIds()).toContain("preflight-task");
    expect(runner.isWorkSessionRunning("chat-1")).toBe(true);
    expect(await runner.cancel("preflight-task")).toBe(true);
    finishLayout("workspace-1");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(assertCanStart).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(runner.listRunningSessionIds()).toEqual([]);
  });

  it("keeps an adapter failure failed after normal generator completion", async () => {
    const fixture = runnerFor(async function* () {
      yield { type: "result", success: false, outcome: "failed", title: "Failed", detail: "Provider failed", at };
      yield { type: "lifecycle", stage: "completed", message: "Late adapter completion", at };
    });
    await fixture.consume();
    expect(fixture.events.filter((event) => event.type === "lifecycle").at(-1)).toMatchObject({ stage: "failed" });
    expect(fixture.recordTaskTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(fixture.release).toHaveBeenCalledWith("workspace-1", "task-1");
    expect(fixture.runner.isWorkSessionRunning("chat-1")).toBe(false);
  });

  it("treats a stream with no official result as failure", async () => {
    const fixture = runnerFor(async function* () { yield { type: "status", level: "info", message: "started", at }; });
    await fixture.consume();
    expect(fixture.events.filter((event) => event.type === "result")).toEqual([expect.objectContaining({ success: false, outcome: "failed" })]);
    expect(fixture.recordTaskTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("keeps the workspace occupied until cancelled process cleanup finishes", async () => {
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const fixture = runnerFor(async function* () {
      started();
      await gate;
      yield { type: "result", success: true, title: "Done", detail: "Late result", at };
    });
    const complete = fixture.consume();
    await ready;
    expect(await fixture.runner.cancel("task-1")).toBe(true);
    expect(fixture.runner.isRunning("task-1")).toBe(true);
    expect(fixture.runner.isWorkSessionRunning("chat-1")).toBe(true);
    expect(fixture.release).not.toHaveBeenCalled();
    finish();
    await complete;
    expect(fixture.events.filter((event) => event.type === "result").at(-1)).toMatchObject({ outcome: "cancelled", success: false });
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.runner.isRunning("task-1")).toBe(false);
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("task-runner inline image paths", () => {
  it("keeps the existing Hermes session when the runtime model has not changed", () => {
    const conversationId = resolveHermesConversationIdForRuntime({
      workSessionId: "session-1",
      workSession: { hermesSessionId: "hermes-session-1", model: "kimi-for-coding" },
      runtimeEnv: { profileId: "kimi", provider: "custom", model: "kimi-for-coding", baseUrl: "https://api.kimi.com/coding/v1", sourceType: "kimi_coding_api_key" },
    });

    expect(conversationId).toBe("hermes-session-1");
  });

  it("uses a model-scoped Hermes session when the user switches model in the same chat", () => {
    const conversationId = resolveHermesConversationIdForRuntime({
      workSessionId: "session-1",
      workSession: { hermesSessionId: "hermes-session-1", model: "mimo-v2.5-pro" },
      runtimeEnv: { profileId: "kimi", provider: "custom", model: "kimi-for-coding", baseUrl: "https://api.kimi.com/coding/v1", sourceType: "kimi_coding_api_key" },
    });

    expect(conversationId).toMatch(/^session-1-model-[a-f0-9]{10}$/);
    expect(conversationId).not.toBe("hermes-session-1");
  });

  it("does not restore a previous model session after the conversation was cleared", () => {
    const runtimeEnv = { profileId: "next", provider: "custom" as const, model: "model-b" };
    const before = resolveHermesConversationIdForRuntime({
      workSessionId: "session-1", workSession: { hermesSessionId: "before-clear", model: "model-a" }, runtimeEnv,
    });
    const after = resolveHermesConversationIdForRuntime({
      workSessionId: "session-1", workSession: { hermesSessionId: "after-clear", model: "model-a" }, runtimeEnv,
    });
    expect(after).not.toBe(before);
  });

  it("extracts quoted Windows image paths without treating plain text as attachments", () => {
    const paths = extractInlineImagePaths('请问"C:\\Users\\xia\\Desktop\\ScreenShot_2026-04-21_122543_618.png"是什么内容');

    expect(paths).toEqual(["C:\\Users\\xia\\Desktop\\ScreenShot_2026-04-21_122543_618.png"]);
  });

  it("deduplicates existing attachments and infers image metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-forge-inline-image-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "screen shot.PNG");
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const existing: SessionAttachment[] = [
      {
        id: "existing",
        name: "screen shot.PNG",
        path: imagePath,
        originalPath: imagePath,
        kind: "image",
        mimeType: "image/png",
        size: 4,
        createdAt: "2026-04-21T00:00:00.000Z",
      },
    ];

    const attachments = await resolveInlineImageAttachments(`看一下 "${imagePath}"`, existing);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toBe(existing[0]);
  });

  it("promotes an accessible platform-native image path into an image attachment", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-forge-inline-image-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "desktop-capture.jpg");
    await fs.writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff]));

    const attachments = await resolveInlineImageAttachments(`帮我识别 '${imagePath}'`, []);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: "desktop-capture.jpg",
      path: imagePath,
      originalPath: imagePath,
      kind: "image",
      mimeType: "image/jpeg",
      size: 3,
    });
  });

  it("ignores unsupported or inaccessible paths safely", async () => {
    const attachments = await resolveInlineImageAttachments("打开 C:\\Users\\xia\\Desktop\\notes.txt 和 C:\\missing\\ghost.png", []);

    expect(attachments).toEqual([]);
  });

  it("promotes an accessible local text path into a file attachment", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-forge-inline-file-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "论文正文格式规范.md");
    await fs.writeFile(filePath, "# 标题\n\n正文", "utf8");

    const attachments = await resolveInlineFileAttachments(`帮我总结一下 "${filePath}"`, []);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      name: "论文正文格式规范.md",
      path: filePath,
      originalPath: filePath,
      kind: "file",
    });
  });

  it("maps common image extensions to MIME types", () => {
    expect(mimeTypeForImagePath("a.png")).toBe("image/png");
    expect(mimeTypeForImagePath("a.jpeg")).toBe("image/jpeg");
    expect(mimeTypeForImagePath("a.webp")).toBe("image/webp");
    expect(mimeTypeForImagePath("a.bmp")).toBe("image/bmp");
    expect(mimeTypeForImagePath("a.txt")).toBeUndefined();
  });
});
