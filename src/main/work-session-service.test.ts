// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    await fs.writeFile(path.join(appPaths.workspaceSnapshotDir(workspaceId), "latest.txt"), snapshotId, "utf8");
    await fs.mkdir(path.dirname(insightFile), { recursive: true });
    await fs.writeFile(insightFile, JSON.stringify({ sessionId: session.id }), "utf8");

    const result = await service.clearSessionFiles(session.id);

    expect(result.ok).toBe(true);
    await expect(fs.stat(sessionLogFile)).rejects.toBeTruthy();
    await expect(fs.stat(snapshotDir)).rejects.toBeTruthy();
    await expect(fs.stat(insightFile)).rejects.toBeTruthy();
  });
});
