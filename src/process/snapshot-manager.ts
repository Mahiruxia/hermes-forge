import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppPaths } from "../main/app-paths";
import type { SnapshotRecord, SnapshotRestoreResult } from "../shared/types";

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "release",
  ".cache",
  ".pnpm-store",
  "__pycache__",
]);

type SnapshotManifest = SnapshotRecord;
const snapshotManifestSchema = z.object({
  snapshotId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  workspacePath: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  copiedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  copiedBytes: z.number().nonnegative().optional(),
  maxFiles: z.number().int().nonnegative().optional(),
  maxBytes: z.number().nonnegative().optional(),
  truncated: z.boolean().optional(),
  limitReason: z.string().optional(),
  mode: z.enum(["full", "scoped", "manifest"]).optional(),
  manifestOnly: z.boolean().optional(),
  scopedPaths: z.array(z.string()).optional(),
}).passthrough();
type SnapshotOptions = {
  markLatest?: boolean;
  manifestOnly?: boolean;
  scopedPaths?: string[];
  maxFiles?: number;
  maxBytes?: number;
};

export class SnapshotManager {
  constructor(private readonly appPaths: AppPaths) {}

  async createSnapshot(workspaceId: string, workspacePath: string, sessionId: string, options: SnapshotOptions = {}) {
    const snapshotId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${sessionId.slice(0, 8)}`;
    const snapshotDir = this.snapshotDir(workspaceId, snapshotId);
    const manifest: SnapshotManifest = {
      snapshotId,
      workspaceId,
      workspacePath,
      createdAt: new Date().toISOString(),
      copiedFiles: 0,
      skippedFiles: 0,
      copiedBytes: 0,
      maxFiles: options.maxFiles,
      maxBytes: options.maxBytes,
      mode: options.manifestOnly ? "manifest" : (options.scopedPaths?.length ? "scoped" : "full"),
      manifestOnly: Boolean(options.manifestOnly),
      scopedPaths: [],
    };

    await fs.mkdir(snapshotDir, { recursive: true });
    const scopedPaths = this.normalizeScopedPaths(workspacePath, options.scopedPaths ?? []);
    manifest.scopedPaths = scopedPaths.map((target) => path.relative(workspacePath, target) || ".");
    if (options.manifestOnly) {
      manifest.skippedFiles += 1;
    } else if (scopedPaths.length > 0) {
      await this.copySelected(workspacePath, snapshotDir, scopedPaths, manifest, options);
    } else {
      await this.copyTree(workspacePath, snapshotDir, manifest, undefined, options);
    }
    await fs.writeFile(path.join(snapshotDir, "snapshot.manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    if (options.markLatest ?? true) {
      await fs.writeFile(path.join(this.snapshotsRoot(workspaceId), "latest.txt"), snapshotId, "utf8");
    }
    return manifest;
  }

  async restoreLatest(workspaceId: string): Promise<SnapshotRestoreResult> {
    const latestPath = path.join(this.snapshotsRoot(workspaceId), "latest.txt");
    const snapshotId = (await fs.readFile(latestPath, "utf8").catch(() => "")).trim();
    if (!snapshotId) {
      return { restored: false, message: "没有找到可撤销的快照。" };
    }

    const snapshotDir = this.snapshotDir(workspaceId, snapshotId);
    const manifestPath = path.join(snapshotDir, "snapshot.manifest.json");
    const manifest = await readSnapshotManifest(manifestPath);
    if (!manifest) {
      return { restored: false, message: "快照清单已损坏，已跳过恢复并隔离坏文件。" };
    }
    await this.createSnapshot(workspaceId, manifest.workspacePath, "before-restore", { markLatest: false });
    await this.copyTree(snapshotDir, manifest.workspacePath, {
      ...manifest,
      copiedFiles: 0,
      skippedFiles: 0,
      copiedBytes: 0,
      truncated: false,
      limitReason: undefined,
      maxFiles: undefined,
      maxBytes: undefined,
    }, new Set(["snapshot.manifest.json"]));

    return {
      restored: true,
      snapshotId,
      message: "已把最新快照覆盖回工作区。为避免误删，撤销不会删除快照后新增的文件。",
    };
  }

  async listSnapshots(workspaceId: string): Promise<SnapshotRecord[]> {
    const root = this.snapshotsRoot(workspaceId);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const snapshots = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const manifestPath = path.join(root, entry.name, "snapshot.manifest.json");
          const raw = await fs.readFile(manifestPath, "utf8").catch(() => "");
          if (!raw) {
            return undefined;
          }
          return parseSnapshotManifest(raw, manifestPath);
        }),
    );

    return snapshots
      .filter((snapshot): snapshot is SnapshotRecord => Boolean(snapshot))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 12);
  }

  private snapshotsRoot(workspaceId: string) {
    return path.join(this.appPaths.workspaceDir(workspaceId), "snapshots");
  }

  private snapshotDir(workspaceId: string, snapshotId: string) {
    return path.join(this.snapshotsRoot(workspaceId), snapshotId);
  }

  private async copyTree(
    source: string,
    target: string,
    manifest: SnapshotManifest,
    excludedFiles = new Set<string>(),
    options: SnapshotOptions = {},
  ) {
    await fs.mkdir(target, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (manifest.truncated) {
        return;
      }
      if (excludedFiles.has(entry.name) || EXCLUDED_DIRS.has(entry.name)) {
        manifest.skippedFiles += 1;
        continue;
      }

      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);

      if (entry.isDirectory()) {
        await this.copyTree(sourcePath, targetPath, manifest, excludedFiles, options);
        continue;
      }

      if (!entry.isFile()) {
        manifest.skippedFiles += 1;
        continue;
      }

      const stat = await fs.stat(sourcePath).catch(() => undefined);
      if (!stat?.isFile()) {
        manifest.skippedFiles += 1;
        continue;
      }
      if (this.wouldExceedBudget(manifest, stat.size, options)) {
        manifest.skippedFiles += 1;
        return;
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
      manifest.copiedFiles += 1;
      manifest.copiedBytes = (manifest.copiedBytes ?? 0) + stat.size;
    }
  }

  private async copySelected(
    workspacePath: string,
    snapshotDir: string,
    scopedPaths: string[],
    manifest: SnapshotManifest,
    options: SnapshotOptions = {},
  ) {
    for (const scopedPath of scopedPaths) {
      if (manifest.truncated) {
        return;
      }
      const relativePath = path.relative(workspacePath, scopedPath);
      if (!relativePath || relativePath.startsWith("..")) {
        manifest.skippedFiles += 1;
        continue;
      }
      const targetPath = path.join(snapshotDir, relativePath);
      const stat = await fs.stat(scopedPath).catch(() => undefined);
      if (!stat) {
        manifest.skippedFiles += 1;
        continue;
      }
      if (stat.isDirectory()) {
        await this.copyTree(scopedPath, targetPath, manifest, undefined, options);
        continue;
      }
      if (!stat.isFile()) {
        manifest.skippedFiles += 1;
        continue;
      }
      if (this.wouldExceedBudget(manifest, stat.size, options)) {
        manifest.skippedFiles += 1;
        return;
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(scopedPath, targetPath);
      manifest.copiedFiles += 1;
      manifest.copiedBytes = (manifest.copiedBytes ?? 0) + stat.size;
    }
  }

  private wouldExceedBudget(manifest: SnapshotManifest, nextFileBytes: number, options: SnapshotOptions) {
    const maxFiles = options.maxFiles;
    if (typeof maxFiles === "number" && maxFiles >= 0 && manifest.copiedFiles >= maxFiles) {
      this.markTruncated(manifest, `已达到快照文件数预算 ${maxFiles}。`);
      return true;
    }
    const maxBytes = options.maxBytes;
    const copiedBytes = manifest.copiedBytes ?? 0;
    if (typeof maxBytes === "number" && maxBytes >= 0 && copiedBytes + nextFileBytes > maxBytes) {
      this.markTruncated(manifest, `已达到快照体积预算 ${formatBytes(maxBytes)}。`);
      return true;
    }
    return false;
  }

  private markTruncated(manifest: SnapshotManifest, reason: string) {
    manifest.truncated = true;
    manifest.limitReason = reason;
  }

  private normalizeScopedPaths(workspacePath: string, scopedPaths: string[]) {
    const workspaceRoot = path.resolve(workspacePath);
    return [...new Set(scopedPaths.map((target) => path.resolve(target).trim()).filter(Boolean))]
      .filter((target) => target === workspaceRoot || target.startsWith(`${workspaceRoot}${path.sep}`))
      .sort((a, b) => a.length - b.length)
      .filter((target, index, items) => !items.slice(0, index).some((parent) => target.startsWith(`${parent}${path.sep}`)));
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Math.round(kib)}KB`;
  return `${Math.round(kib / 1024)}MB`;
}

async function readSnapshotManifest(manifestPath: string): Promise<SnapshotManifest | undefined> {
  const raw = await fs.readFile(manifestPath, "utf8").catch(() => "");
  if (!raw) return undefined;
  const parsed = parseSnapshotManifest(raw, manifestPath);
  if (!parsed) await quarantineInvalidJson(manifestPath);
  return parsed;
}

function parseSnapshotManifest(raw: string, manifestPath: string): SnapshotManifest | undefined {
  try {
    return snapshotManifestSchema.parse(JSON.parse(raw)) as SnapshotManifest;
  } catch {
    void quarantineInvalidJson(manifestPath);
    return undefined;
  }
}

async function quarantineInvalidJson(filePath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.rename(filePath, `${filePath}.invalid.${timestamp}`).catch(() => undefined);
}
