import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppPaths } from "../main/app-paths";
import { SnapshotManager } from "./snapshot-manager";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SnapshotManager", () => {
  it("stops copying when the snapshot file budget is reached", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-snapshot-budget-"));
    tempDirs.push(baseDir);
    const workspacePath = path.join(baseDir, "workspace");
    const appDataPath = path.join(baseDir, "app-data");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "a.txt"), "a", "utf8");
    await fs.writeFile(path.join(workspacePath, "b.txt"), "b", "utf8");
    await fs.writeFile(path.join(workspacePath, "c.txt"), "c", "utf8");

    const manager = new SnapshotManager({
      workspaceDir: (workspaceId: string) => path.join(appDataPath, workspaceId),
    } as AppPaths);

    const snapshot = await manager.createSnapshot("workspace-1", workspacePath, "task-1", {
      maxFiles: 2,
    });

    expect(snapshot.copiedFiles).toBe(2);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.limitReason).toContain("文件数预算");

    const manifestPath = path.join(appDataPath, "workspace-1", "snapshots", snapshot.snapshotId, "snapshot.manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as typeof snapshot;
    expect(manifest.truncated).toBe(true);
    expect(manifest.maxFiles).toBe(2);
  });
});
