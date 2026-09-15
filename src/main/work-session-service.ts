import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppPaths } from "./app-paths";
import type { HermesCoreBridgeService } from "./hermes-core-bridge-service";
import type { WorkSession } from "../shared/types";
import { atomicWriteText } from "./hermes-config-files";

const DEFAULT_SESSION_TITLE = "新的会话";
const DEFAULT_SESSION_LIST_LIMIT = 80;

export class WorkSessionService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly hermesCoreBridge?: Pick<HermesCoreBridgeService, "createSession" | "renameSession" | "deleteSession"> & Partial<Pick<HermesCoreBridgeService, "readSession">>,
  ) {}

  async list(includeArchived = false, limit = DEFAULT_SESSION_LIST_LIMIT): Promise<WorkSession[]> {
    await fs.mkdir(this.appPaths.sessionsRootDir(), { recursive: true });
    const entries = await fs.readdir(this.appPaths.sessionsRootDir(), { withFileTypes: true }).catch(() => []);
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.read(entry.name)),
    );
    return sessions
      .filter((session): session is WorkSession => Boolean(session))
      .filter((session) => includeArchived || session.status !== "archived")
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, Math.max(1, Math.min(limit, DEFAULT_SESSION_LIST_LIMIT)));
  }

  async ensureDefault(): Promise<WorkSession> {
    const sessions = await this.list();
    if (sessions[0]) {
      return sessions[0];
    }
    return await this.create("新的会话");
  }

  async create(title = DEFAULT_SESSION_TITLE): Promise<WorkSession> {
    const id = `session-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const at = new Date().toISOString();
    await this.ensureSessionLayout(id);
    // Reserve an ID locally. Hermes creates the database row on the first turn;
    // starting an empty workspace must also work before Hermes is installed.
    const session: WorkSession = {
      id,
      title: title.trim() || DEFAULT_SESSION_TITLE,
      status: "idle",
      sessionFilesPath: this.appPaths.sessionFilesDir(id),
      hermesSessionId: id,
      hermesSource: "zhenghebao-client",
      messageCount: 0,
      workspaceStatus: "unselected",
      createdAt: at,
      updatedAt: at,
    };
    await this.write(session);
    return session;
  }

  async update(id: string, patch: Partial<Omit<Pick<WorkSession, "title" | "status" | "lastMessagePreview" | "workspacePath" | "workspaceStatus" | "pinned" | "tags">, never>> & { projectId?: string | null }): Promise<WorkSession> {
    const current = await this.readOrThrow(id);
    const next: WorkSession = {
      ...current,
      ...patch,
      title: patch.title?.trim() || current.title,
      workspacePath: patch.workspacePath?.trim() || (patch.workspacePath === "" ? undefined : current.workspacePath),
      workspaceStatus: patch.workspaceStatus ?? current.workspaceStatus,
      pinned: patch.pinned ?? current.pinned,
      projectId: patch.projectId === null ? undefined : patch.projectId?.trim() || current.projectId,
      tags: patch.tags ?? current.tags,
      updatedAt: new Date().toISOString(),
    };
    if (patch.title && next.hermesSessionId && current.lastSyncedAt) {
      await this.hermesCoreBridge?.renameSession(next.hermesSessionId, next.title);
    }
    await this.write(next);
    return next;
  }

  async archive(id: string): Promise<WorkSession> {
    const current = await this.readOrThrow(id);
    const next: WorkSession = {
      ...current,
      status: "archived",
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  async duplicate(id: string): Promise<WorkSession> {
    const current = await this.readOrThrow(id);
    const copy = await this.create(`${current.title} 副本`);
    const sourceFiles = this.appPaths.sessionFilesDir(id);
    const targetFiles = this.appPaths.sessionFilesDir(copy.id);
    await fs.cp(sourceFiles, targetFiles, { recursive: true, force: true }).catch(() => undefined);
    const next: WorkSession = {
      ...copy,
      workspacePath: current.workspacePath,
      workspaceStatus: current.workspaceStatus,
      projectId: current.projectId,
      tags: current.tags,
      lastMessagePreview: current.lastMessagePreview,
      parentHermesSessionId: current.hermesSessionId,
      updatedAt: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  async export(id: string, format: "json" | "markdown" = "json"): Promise<{ ok: boolean; path: string; message: string }> {
    const current = await this.readOrThrow(id);
    if (!this.hermesCoreBridge?.readSession) throw new Error("Hermes 会话读取服务不可用，无法导出完整记录。");
    const transcript = await this.hermesCoreBridge.readSession(current.hermesSessionId ?? current.id);
    const messages = transcript?.messages ?? [];
    const exportDir = path.join(this.appPaths.sessionDir(id), "exports");
    await fs.mkdir(exportDir, { recursive: true });
    const safeTitle = current.title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "session";
    const exportPath = path.join(exportDir, `${safeTitle}.${format === "markdown" ? "md" : "json"}`);
    if (format === "markdown") {
      await atomicWriteText(exportPath, [`# ${current.title}`, "", `- ID: ${current.id}`, `- Workspace: ${current.workspacePath ?? "未选择"}`, "", ...messages.flatMap((message) => [`## ${message.role === "user" ? "用户" : "助手"}`, "", message.content, ""])].join("\n"));
    } else {
      await atomicWriteText(exportPath, JSON.stringify({ schemaVersion: 1, ...current, messages: transcript?.rawMessages ?? messages }, null, 2));
    }
    return { ok: true, path: exportPath, message: `已导出会话：${exportPath}` };
  }

  async importFromFile(filePath: string): Promise<WorkSession> {
    const stat = await fs.stat(filePath);
    const sourcePath = stat.isDirectory() ? await this.findImportCandidate(filePath) : filePath;
    const raw = await fs.readFile(sourcePath, "utf8");
    const parsed = this.parseImportedSession(raw, sourcePath);
    const session = await this.create(parsed.title ? `${parsed.title} 导入` : "导入会话");
    const next: WorkSession = {
      ...session,
      title: parsed.title ? `${parsed.title} 导入` : session.title,
      workspacePath: parsed.workspacePath,
      workspaceStatus: parsed.workspacePath ? "ready" : "unselected",
      lastMessagePreview: parsed.lastMessagePreview,
      tags: parsed.tags,
      projectId: parsed.projectId,
      updatedAt: new Date().toISOString(),
    };
    await this.write(next);
    await fs.writeFile(path.join(this.appPaths.sessionFilesDir(session.id), "import-source.txt"), sourcePath, "utf8").catch(() => undefined);
    return next;
  }

  async delete(id: string): Promise<{ ok: boolean; message: string; deletedId: string }> {
    const current = await this.readOrThrow(id);
    if (current.hermesSessionId && current.lastSyncedAt) {
      await this.hermesCoreBridge?.deleteSession(current.hermesSessionId);
    }
    await this.cleanupWorkspaceArtifacts(current);
    await fs.rm(this.appPaths.sessionAgentInsightPath(id), { force: true }).catch(() => undefined);
    await fs.rm(this.appPaths.sessionDir(id), { recursive: true, force: true });
    return {
      ok: true,
      deletedId: id,
      message: `已删除会话「${current.title}」及其左侧会话文件夹、运行日志与该会话快照索引。真实项目目录未被修改。`,
    };
  }

  async clearSessionFiles(id: string): Promise<{ ok: boolean; message: string; session: WorkSession }> {
    const current = await this.readOrThrow(id);
    // IPC coordinates against live tasks. Persisted "running" metadata may be
    // stale after a crash and must not make a stopped conversation uncleareable.
    const at = new Date().toISOString();
    const sessionFilesPath = this.appPaths.sessionFilesDir(id);
    await this.cleanupWorkspaceArtifacts(current);
    await fs.rm(this.appPaths.sessionAgentInsightPath(id), { force: true }).catch(() => undefined);
    await fs.rm(sessionFilesPath, { recursive: true, force: true });
    await this.ensureSessionLayout(id);
    const next: WorkSession = {
      ...current,
      hermesSessionId: `${current.id}-reset-${crypto.randomBytes(6).toString("hex")}`,
      parentHermesSessionId: undefined,
      messageCount: 0,
      lastSyncedAt: undefined,
      lastMessagePreview: undefined,
      status: "idle",
      clearedAt: at,
      updatedAt: at,
    };
    await this.write(next);
    return {
      ok: true,
      message: `已清空当前会话聊天记录与会话文件夹：${sessionFilesPath}。真实项目目录未被修改。`,
      session: next,
    };
  }

  async read(id: string): Promise<WorkSession | undefined> {
    const metadataPath = this.appPaths.sessionMetadataPath(id);
    const raw = await fs.readFile(metadataPath, "utf8").catch(() => "");
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as WorkSession;
      await this.ensureSessionLayout(parsed.id);
      return {
        ...parsed,
        sessionFilesPath: parsed.sessionFilesPath ?? (parsed as WorkSession & { defaultPath?: string }).defaultPath ?? this.appPaths.sessionFilesDir(parsed.id),
        hermesSessionId: parsed.hermesSessionId ?? parsed.id,
        hermesSource: parsed.hermesSource ?? "zhenghebao-client",
        workspaceStatus: parsed.workspaceStatus ?? (parsed.workspacePath ? "ready" : "unselected"),
      };
    } catch {
      return undefined;
    }
  }

  private async readOrThrow(id: string) {
    const session = await this.read(id);
    if (!session) {
      throw new Error(`会话不存在：${id}`);
    }
    return session;
  }

  private async write(session: WorkSession) {
    await this.ensureSessionLayout(session.id);
    await atomicWriteText(this.appPaths.sessionMetadataPath(session.id), JSON.stringify(session, null, 2));
  }

  async syncHermesSession(id: string, patch: Partial<Pick<WorkSession, "hermesSessionId" | "parentHermesSessionId" | "title" | "messageCount" | "model" | "lastMessagePreview">>): Promise<WorkSession> {
    const current = await this.readOrThrow(id);
    const next: WorkSession = {
      ...current,
      ...patch,
      title: patch.title?.trim() || current.title,
      lastSyncedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  private async ensureSessionLayout(sessionId: string) {
    await fs.mkdir(this.appPaths.sessionFilesDir(sessionId), { recursive: true });
    await fs.mkdir(this.appPaths.sessionLogsDir(sessionId), { recursive: true });
    await fs.mkdir(this.appPaths.sessionSnapshotDir(sessionId), { recursive: true });
    await fs.writeFile(path.join(this.appPaths.sessionFilesDir(sessionId), ".keep"), "", { flag: "a" });
  }

  private async findImportCandidate(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const candidate = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(directory, entry.name))
      .find((file) => /\.(json|jsonl)$/i.test(file));
    if (!candidate) throw new Error(`目录中没有找到可导入的 JSON/JSONL 会话：${directory}`);
    return candidate;
  }

  private parseImportedSession(raw: string, sourcePath: string): Partial<WorkSession> {
    if (/\.jsonl$/i.test(sourcePath)) {
      const records = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }).filter((item): item is Record<string, unknown> => Boolean(item));
      const firstUser = records.find((item) => item.role === "user" || item.type === "user");
      const lastText = [...records].reverse().map((item) => item.content ?? item.text ?? item.message).find((item): item is string => typeof item === "string");
      return {
        title: typeof firstUser?.content === "string" ? firstUser.content.slice(0, 60) : path.basename(sourcePath, path.extname(sourcePath)),
        lastMessagePreview: lastText?.slice(0, 500),
      };
    }
    const parsed = JSON.parse(raw) as Partial<WorkSession> & Record<string, unknown>;
    const messages = Array.isArray(parsed.messages) ? parsed.messages as Array<Record<string, unknown>> : [];
    const lastMessage = [...messages].reverse().map((item) => item.content ?? item.text ?? item.message).find((item): item is string => typeof item === "string");
    return {
      ...parsed,
      title: typeof parsed.title === "string" ? parsed.title : path.basename(sourcePath, path.extname(sourcePath)),
      lastMessagePreview: parsed.lastMessagePreview ?? lastMessage?.slice(0, 500),
    };
  }

  private async cleanupWorkspaceArtifacts(session: WorkSession) {
    const artifactRoots = [session.workspacePath, session.sessionFilesPath]
      .map((target) => target?.trim())
      .filter((target): target is string => Boolean(target));
    if (artifactRoots.length === 0) {
      return;
    }

    for (const artifactRoot of [...new Set(artifactRoots)]) {
      const workspaceId = this.appPaths.workspaceId(artifactRoot);
      const logRoot = this.appPaths.workspaceSessionDir(workspaceId);
      const taskRunIds = new Set<string>();
      const logFiles = await fs.readdir(logRoot).catch(() => [] as string[]);
      for (const file of logFiles.filter((name) => name.endsWith(".jsonl"))) {
        const logPath = path.join(logRoot, file);
        const lines = (await fs.readFile(logPath, "utf8")).split(/\r?\n/);
        if (file === `${session.id}.jsonl`) {
          await fs.rm(logPath, { force: true });
          continue;
        }
        const retained = lines.filter((line) => {
          try {
            const envelope = JSON.parse(line) as { workSessionId?: string; sessionId?: string; taskRunId?: string };
            if (envelope.workSessionId !== session.id) return true;
            if (envelope.taskRunId || envelope.sessionId) taskRunIds.add(envelope.taskRunId || envelope.sessionId!);
            return false;
          } catch { return true; }
        });
        if (retained.length === lines.length) continue;
        if (retained.some((line) => line.trim())) await atomicWriteText(logPath, retained.join("\n"));
        else await fs.rm(logPath, { force: true });
      }

      const snapshotRoot = this.appPaths.workspaceSnapshotDir(workspaceId);
      const snapshotEntries = await fs.readdir(snapshotRoot, { withFileTypes: true }).catch(() => []);
      const removed = new Set<string>();
      for (const entry of snapshotEntries.filter((item) => item.isDirectory())) {
        const directory = path.join(snapshotRoot, entry.name);
        const manifest = await fs.readFile(path.join(directory, "snapshot.manifest.json"), "utf8")
          .then((raw) => JSON.parse(raw) as { workSessionId?: string; taskRunId?: string }).catch(() => undefined);
        // Legacy snapshots without an owner must not be guessed from the common
        // "session-" prefix: that could delete another conversation's snapshot.
        if (manifest?.workSessionId === session.id || (manifest?.taskRunId && taskRunIds.has(manifest.taskRunId))) {
          await fs.rm(directory, { recursive: true, force: true });
          removed.add(entry.name);
        }
      }
      const latestPath = path.join(snapshotRoot, "latest.txt");
      const latestSnapshotId = (await fs.readFile(latestPath, "utf8").catch(() => "")).trim();
      if (removed.has(latestSnapshotId)) await fs.rm(latestPath, { force: true });
    }
  }
}
