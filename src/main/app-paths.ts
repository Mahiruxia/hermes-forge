import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export class AppPaths {
  constructor(public readonly userDataPath: string) {}

  profileDir(profileId = "default") {
    return path.join(this.userDataPath, "profiles", profileId);
  }

  baseDir() {
    return this.userDataPath;
  }

  hermesDir(profileId = "default") {
    return path.join(this.profileDir(profileId), "hermes");
  }

  vaultDir(profileId = "default") {
    return path.join(this.profileDir(profileId), "vault");
  }

  workspaceId(workspacePath: string) {
    return crypto.createHash("sha256").update(path.resolve(workspacePath).toLowerCase()).digest("hex").slice(0, 16);
  }

  defaultWorkspaceDir() {
    return path.join(this.userDataPath, "default-workspace");
  }

  sessionsRootDir() {
    return path.join(this.defaultWorkspaceDir(), "sessions");
  }

  sessionDir(sessionId: string) {
    return path.join(this.sessionsRootDir(), sessionId);
  }

  sessionFilesDir(sessionId: string) {
    return path.join(this.sessionDir(sessionId), "files");
  }

  sessionLogsDir(sessionId: string) {
    return path.join(this.sessionDir(sessionId), "logs");
  }

  sessionSnapshotDir(sessionId: string) {
    return path.join(this.sessionDir(sessionId), "snapshots");
  }

  sessionMetadataPath(sessionId: string) {
    return path.join(this.sessionDir(sessionId), "metadata.json");
  }

  sessionAgentInsightPath(sessionId: string) {
    return path.join(this.sessionDir(sessionId), "agent-panel-insight.json");
  }

  workspaceDir(workspaceId: string) {
    return path.join(this.userDataPath, "workspaces", workspaceId);
  }

  workspaceMemoryDir(workspaceId: string) {
    return path.join(this.workspaceDir(workspaceId), "memory");
  }

  workspaceSessionDir(workspaceId: string) {
    return path.join(this.workspaceDir(workspaceId), "sessions");
  }

  workspaceSnapshotDir(workspaceId: string) {
    return path.join(this.workspaceDir(workspaceId), "snapshots");
  }

  runtimeConfigPath() {
    return path.join(this.userDataPath, "config.json");
  }

  async ensureBaseLayout() {
    await fs.mkdir(this.hermesDir(), { recursive: true });
    await fs.mkdir(path.join(this.hermesDir(), "skills"), { recursive: true });
    await fs.mkdir(this.vaultDir(), { recursive: true });
    await fs.mkdir(this.sessionsRootDir(), { recursive: true });
    await this.ensureTextFile(path.join(this.hermesDir(), "USER.md"), "# USER\n\n");
    await this.ensureTextFile(path.join(this.hermesDir(), "MEMORY.md"), "# MEMORY\n\n");
  }

  async ensureWorkspaceLayout(workspacePath: string) {
    const workspaceId = this.workspaceId(workspacePath);
    const workspaceDir = this.workspaceDir(workspaceId);
    await fs.mkdir(this.workspaceMemoryDir(workspaceId), { recursive: true });
    await fs.mkdir(this.workspaceSessionDir(workspaceId), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "workspace.json"),
      JSON.stringify({ workspaceId, workspacePath, updatedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    return workspaceId;
  }

  private async ensureTextFile(filePath: string, content: string) {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, content, "utf8");
    }
  }
}
