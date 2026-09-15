// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppPaths } from "./app-paths";
import { WorkSessionService } from "./work-session-service";

const tempRoots: string[] = [];

async function createHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhenghebao-session-"));
  tempRoots.push(root);
  const appPaths = new AppPaths(root);
  await appPaths.ensureBaseLayout();
  const service = new WorkSessionService(appPaths);
  return { root, appPaths, service };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("WorkSessionService.delete", () => {
  it("reserves an empty session locally and edits the official mapping after first synchronization", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhenghebao-session-"));
    tempRoots.push(root);
    const appPaths = new AppPaths(root);
    await appPaths.ensureBaseLayout();
    const bridge = {
      createSession: vi.fn(async (input: { sessionId?: string; title?: string; source?: string }) => ({
        id: input.sessionId ?? "hermes-session",
        title: input.title,
        source: input.source,
        messageCount: 0,
      })),
      renameSession: vi.fn(async () => true),
      deleteSession: vi.fn(async () => true),
    };
    const service = new WorkSessionService(appPaths, bridge);

    const session = await service.create("官方会话");
    await service.syncHermesSession(session.id, { messageCount: 2 });
    await service.update(session.id, { title: "新标题" });
    await service.delete(session.id);

    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(session.hermesSessionId).toBe(session.id);
    expect(bridge.renameSession).toHaveBeenCalledWith(session.id, "新标题");
    expect(bridge.deleteSession).toHaveBeenCalledWith(session.id);
  });

  it("removes session workspace logs and snapshot index without touching workspace files", async () => {
    const { root, appPaths, service } = await createHarness();
    const workspacePath = path.join(root, "real-workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "keep.txt"), "workspace", "utf8");

    const session = await service.create("测试会话");
    await service.update(session.id, { workspacePath, workspaceStatus: "ready" });

    const workspaceId = appPaths.workspaceId(workspacePath);
    const sessionLogFile = path.join(appPaths.workspaceSessionDir(workspaceId), `${session.id}.jsonl`);
    const snapshotId = `snapshot-demo-${session.id.slice(0, 8)}`;
    const snapshotDir = path.join(appPaths.workspaceSnapshotDir(workspaceId), snapshotId);
    const insightFile = appPaths.sessionAgentInsightPath(session.id);
    await fs.mkdir(path.dirname(sessionLogFile), { recursive: true });
    await fs.writeFile(sessionLogFile, "log", "utf8");
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(path.join(snapshotDir, "snapshot.manifest.json"), JSON.stringify({ workSessionId: session.id }));
    await fs.writeFile(path.join(appPaths.workspaceSnapshotDir(workspaceId), "latest.txt"), snapshotId, "utf8");
    await fs.mkdir(path.dirname(insightFile), { recursive: true });
    await fs.writeFile(insightFile, JSON.stringify({ sessionId: session.id }), "utf8");

    await service.delete(session.id);

    await expect(fs.stat(path.join(workspacePath, "keep.txt"))).resolves.toBeTruthy();
    await expect(fs.stat(sessionLogFile)).rejects.toBeTruthy();
    await expect(fs.stat(snapshotDir)).rejects.toBeTruthy();
    await expect(fs.stat(path.join(appPaths.workspaceSnapshotDir(workspaceId), "latest.txt"))).rejects.toBeTruthy();
    await expect(fs.stat(insightFile)).rejects.toBeTruthy();
  });

  it("removes pure chat workspace artifacts keyed by the session files path", async () => {
    const { appPaths, service } = await createHarness();
    const session = await service.create("纯聊天");
    const workspaceId = appPaths.workspaceId(session.sessionFilesPath);
    const sessionLogFile = path.join(appPaths.workspaceSessionDir(workspaceId), `${session.id}.jsonl`);
    const snapshotId = `snapshot-demo-${session.id.slice(0, 8)}`;
    const snapshotDir = path.join(appPaths.workspaceSnapshotDir(workspaceId), snapshotId);
    const insightFile = appPaths.sessionAgentInsightPath(session.id);
    await fs.mkdir(path.dirname(sessionLogFile), { recursive: true });
    await fs.writeFile(sessionLogFile, "log", "utf8");
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(path.join(snapshotDir, "snapshot.manifest.json"), JSON.stringify({ workSessionId: session.id }));
    await fs.writeFile(path.join(appPaths.workspaceSnapshotDir(workspaceId), "latest.txt"), snapshotId, "utf8");
    await fs.mkdir(path.dirname(insightFile), { recursive: true });
    await fs.writeFile(insightFile, JSON.stringify({ sessionId: session.id }), "utf8");

    await service.delete(session.id);

    await expect(fs.stat(sessionLogFile)).rejects.toBeTruthy();
    await expect(fs.stat(snapshotDir)).rejects.toBeTruthy();
    await expect(fs.stat(path.join(appPaths.workspaceSnapshotDir(workspaceId), "latest.txt"))).rejects.toBeTruthy();
    await expect(fs.stat(insightFile)).rejects.toBeTruthy();
  });
});

describe("WorkSessionService.importFromFile", () => {
  it("imports Hermes JSONL sessions and keeps source diagnostics", async () => {
    const { root, appPaths, service } = await createHarness();
    const source = path.join(root, "hermes-session.jsonl");
    await fs.writeFile(source, [
      JSON.stringify({ role: "user", content: "分析这个项目结构" }),
      JSON.stringify({ role: "assistant", content: "入口在 src/main.tsx。" }),
    ].join("\n"), "utf8");

    const session = await service.importFromFile(source);

    expect(session.title).toContain("分析这个项目结构");
    expect(session.lastMessagePreview).toContain("入口在");
    await expect(fs.readFile(path.join(appPaths.sessionFilesDir(session.id), "import-source.txt"), "utf8")).resolves.toBe(source);
  });

  it("imports the first JSON or JSONL file from a Hermes session directory", async () => {
    const { root, service } = await createHarness();
    const directory = path.join(root, "session-dir");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "session.json"), JSON.stringify({ title: "目录会话", messages: [{ content: "hello" }] }), "utf8");

    const session = await service.importFromFile(directory);

    expect(session.title).toContain("目录会话");
    expect(session.lastMessagePreview).toBe("hello");
  });
});

describe("WorkSessionService.clearSessionFiles", () => {
  it("clears workspace artifacts and insight sidecar for the session", async () => {
    const { root, appPaths, service } = await createHarness();
    const workspacePath = path.join(root, "clear-workspace");
    await fs.mkdir(workspacePath, { recursive: true });

    const session = await service.create("待清空");
    await service.update(session.id, { workspacePath, workspaceStatus: "ready" });

    const workspaceId = appPaths.workspaceId(workspacePath);
    const sessionLogFile = path.join(appPaths.workspaceSessionDir(workspaceId), `${session.id}.jsonl`);
    const snapshotId = `snapshot-demo-${session.id.slice(0, 8)}`;
    const snapshotDir = path.join(appPaths.workspaceSnapshotDir(workspaceId), snapshotId);
    const insightFile = appPaths.sessionAgentInsightPath(session.id);
    await fs.mkdir(path.dirname(sessionLogFile), { recursive: true });
    await fs.writeFile(sessionLogFile, "log", "utf8");
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(path.join(snapshotDir, "snapshot.manifest.json"), JSON.stringify({ workSessionId: session.id }));
    await fs.writeFile(path.join(appPaths.workspaceSnapshotDir(workspaceId), "latest.txt"), snapshotId, "utf8");
    await fs.mkdir(path.dirname(insightFile), { recursive: true });
    await fs.writeFile(insightFile, JSON.stringify({ sessionId: session.id }), "utf8");

    const result = await service.clearSessionFiles(session.id);

    expect(result.ok).toBe(true);
    expect(result.session.hermesSessionId).not.toBe(session.hermesSessionId);
    expect(result.session.messageCount).toBe(0);
    expect((await service.read(session.id))?.hermesSessionId).toBe(result.session.hermesSessionId);
    await expect(fs.stat(sessionLogFile)).rejects.toBeTruthy();
    await expect(fs.stat(snapshotDir)).rejects.toBeTruthy();
    await expect(fs.stat(insightFile)).rejects.toBeTruthy();
  });
});

describe("WorkSessionService data isolation", () => {
  it("retains another session's logs and snapshots in the same workspace", async () => {
    const { root, appPaths, service } = await createHarness();
    const first = await service.create("first");
    const second = await service.create("second");
    const workspacePath = path.join(root, "shared");
    await service.update(first.id, { workspacePath });
    await service.update(second.id, { workspacePath });
    const workspaceId = appPaths.workspaceId(workspacePath);
    const log = path.join(appPaths.workspaceSessionDir(workspaceId), "combined.jsonl");
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.writeFile(log, [first, second].map((session) => JSON.stringify({ workSessionId: session.id, taskRunId: `run-${session.id}` })).join("\n"));
    const snapshotRoot = appPaths.workspaceSnapshotDir(workspaceId);
    for (const session of [first, second]) {
      await fs.mkdir(path.join(snapshotRoot, session.id), { recursive: true });
      await fs.writeFile(path.join(snapshotRoot, session.id, "snapshot.manifest.json"), JSON.stringify({ workSessionId: session.id }));
    }
    await service.clearSessionFiles(first.id);
    expect(await fs.readFile(log, "utf8")).toContain(second.id);
    expect(await fs.readFile(log, "utf8")).not.toContain(first.id);
    await expect(fs.stat(path.join(snapshotRoot, second.id))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(snapshotRoot, first.id))).rejects.toThrow();
  });

  it("exports the current official transcript and surfaces database deletion errors", async () => {
    const { appPaths } = await createHarness();
    const bridge = {
      createSession: vi.fn(), renameSession: vi.fn(),
      deleteSession: vi.fn(async () => { throw new Error("database locked"); }),
      readSession: vi.fn(async () => ({ messages: [{ role: "user" as const, content: "问题" }, { role: "assistant" as const, content: "实际回答" }] })),
    };
    const service = new WorkSessionService(appPaths, bridge);
    const session = await service.create("export");
    await service.syncHermesSession(session.id, { hermesSessionId: "official-current", messageCount: 2 });
    const exported = await service.export(session.id);
    expect(JSON.parse(await fs.readFile(exported.path, "utf8")).messages).toHaveLength(2);
    expect(bridge.readSession).toHaveBeenCalledWith("official-current");
    await expect(service.delete(session.id)).rejects.toThrow("database locked");
    expect(await service.read(session.id)).toBeDefined();
  });
});
