import fs from "node:fs/promises";
import path from "node:path";
import { shell } from "electron";
import type { AppPaths } from "./app-paths";
import { ensureHermesHomeLayout, resolveActiveHermesHome } from "./hermes-home";
import { runCommand } from "../process/command-runner";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import {
  defaultHermesCliPath,
  defaultWindowsHermesCliPath,
  resolveHermesCliPathSync,
  resolveWindowsHermesCliPathSync,
} from "../runtime/hermes-cli-paths";
import { getDefaultPythonCommand, getPlatformKind } from "../platform";
import { validateSkillId, validateProfileName, validateCronSchedule, validateSkillDirectoryName, validateSkillUploadPath } from "../security";
import type {
  FilePreviewResult,
  FileBreadcrumbItem,
  HermesKanbanActionResult,
  HermesKanbanAssignee,
  HermesKanbanBoard,
  HermesKanbanCreateBoardInput,
  HermesKanbanCreateTaskInput,
  HermesKanbanDiagnostic,
  HermesKanbanTask,
  HermesKanbanTaskActionInput,
  HermesKanbanTaskListOptions,
  HermesCronJob,
  HermesMemoryFile,
  HermesProfile,
  HermesSkill,
  HermesWebUiOverview,
  HermesWebUiSettings,
  ProjectGroup,
  SlashCommand,
  ThemePreference,
  WorkspaceSpace,
  RuntimeConfig,
} from "../shared/types";

const DEFAULT_SETTINGS: HermesWebUiSettings = {
  theme: "green-light",
  language: "zh",
  sendKey: "enter",
  sendKeyHintDismissed: false,
  showUsage: false,
  showCliSessions: true,
};

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "显示可用命令", usage: "/help" },
  { name: "/clear", description: "清空当前会话", usage: "/clear" },
  { name: "/compact", description: "压缩当前上下文", usage: "/compact [重点]" },
  { name: "/model", description: "切换或查看模型", usage: "/model <模型名>" },
  { name: "/workspace", description: "切换工作区", usage: "/workspace <名称或路径>" },
  { name: "/new", description: "新建会话", usage: "/new" },
  { name: "/usage", description: "显示/隐藏用量", usage: "/usage" },
  { name: "/theme", description: "切换主题", usage: "/theme <green-light|light|slate|oled>" },
  { name: "/goal", description: "设置或查看 Hermes 持久目标", usage: "/goal [text | pause | resume | clear | status]" },
];

export class HermesWebUiService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly resolveHermesRoot: () => Promise<string>,
    private readonly runtimeAdapterFactory?: RuntimeAdapterFactory,
    private readonly readRuntimeConfig?: () => Promise<RuntimeConfig>,
  ) {}

  async overview(): Promise<HermesWebUiOverview> {
    const [settings, projects, spaces, skills, memory, crons, profiles] = await Promise.all([
      this.getSettings(),
      this.listProjects(),
      this.listSpaces(),
      this.listSkills(),
      this.listMemoryFiles(),
      this.listCronJobs(),
      this.listProfiles(),
    ]);
    return { settings, projects, spaces, skills, memory, crons, profiles, slashCommands: SLASH_COMMANDS };
  }

  async getSettings(): Promise<HermesWebUiSettings> {
    const raw = await fs.readFile(this.settingsPath(), "utf8").catch(() => "");
    if (!raw) return DEFAULT_SETTINGS;
    try {
      const parsed = JSON.parse(raw) as Partial<HermesWebUiSettings>;
      return {
        theme: this.theme(parsed.theme),
        language: parsed.language === "en" ? "en" : "zh",
        sendKey: parsed.sendKey === "mod-enter" ? "mod-enter" : "enter",
        sendKeyHintDismissed: parsed.sendKeyHintDismissed === true,
        showUsage: Boolean(parsed.showUsage),
        showCliSessions: parsed.showCliSessions !== false,
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async saveSettings(input: Partial<HermesWebUiSettings>): Promise<HermesWebUiSettings> {
    const current = await this.getSettings();
    const next: HermesWebUiSettings = {
      ...current,
      ...input,
      theme: this.theme(input.theme ?? current.theme),
      language: input.language === "en" || input.language === "zh" ? input.language : current.language,
      sendKey: input.sendKey === "mod-enter" || input.sendKey === "enter" ? input.sendKey : current.sendKey,
      sendKeyHintDismissed: input.sendKeyHintDismissed ?? current.sendKeyHintDismissed,
    };
    await this.writeJson(this.settingsPath(), next);
    return next;
  }

  async listProjects(): Promise<ProjectGroup[]> {
    return (await this.readJson<ProjectGroup[]>(this.projectsPath(), [])).filter((item) => !item.archived);
  }

  async saveProject(input: Partial<ProjectGroup>): Promise<ProjectGroup> {
    const projects = await this.listProjects();
    const at = new Date().toISOString();
    const id = input.id?.trim() || `project-${Date.now().toString(36)}`;
    const next: ProjectGroup = {
      id,
      name: input.name?.trim() || "未命名项目",
      color: input.color?.trim() || "#10b981",
      sessionCount: input.sessionCount,
      archived: input.archived,
      createdAt: projects.find((item) => item.id === id)?.createdAt ?? at,
      updatedAt: at,
    };
    await this.writeJson(this.projectsPath(), [next, ...projects.filter((item) => item.id !== id)]);
    return next;
  }

  async deleteProject(id: string) {
    const projects = await this.listProjects();
    await this.writeJson(this.projectsPath(), projects.filter((item) => item.id !== id));
    return { ok: true, id };
  }

  async listSpaces(): Promise<WorkspaceSpace[]> {
    return await this.readJson<WorkspaceSpace[]>(this.spacesPath(), []);
  }

  async saveSpace(input: Partial<WorkspaceSpace>): Promise<WorkspaceSpace> {
    const spaces = await this.listSpaces();
    const at = new Date().toISOString();
    const id = input.id?.trim() || `space-${Date.now().toString(36)}`;
    const targetPath = input.path?.trim() || "";
    if (!targetPath) throw new Error("工作区路径不能为空。");
    const stat = await fs.stat(targetPath).catch(() => undefined);
    if (!stat?.isDirectory()) throw new Error(`工作区不存在或不是目录：${targetPath}`);
    const next: WorkspaceSpace = {
      id,
      name: input.name?.trim() || path.basename(targetPath) || targetPath,
      path: targetPath,
      description: input.description?.trim(),
      pinned: Boolean(input.pinned),
      lastOpenedAt: at,
      createdAt: spaces.find((item) => item.id === id)?.createdAt ?? at,
      updatedAt: at,
    };
    await this.writeJson(this.spacesPath(), [next, ...spaces.filter((item) => item.id !== id)]);
    return next;
  }

  async deleteSpace(id: string) {
    const spaces = await this.listSpaces();
    await this.writeJson(this.spacesPath(), spaces.filter((item) => item.id !== id));
    return { ok: true, id };
  }

  async listSkills(): Promise<HermesSkill[]> {
    const root = path.join(await this.currentHermesHome(), "skills");
    const files = await this.walkFiles(root, 3);

    const flatSkills = await Promise.all(
      files
        .filter((file) => this.isValidSkillFile(file) && path.basename(file) !== "SKILL.md")
        .map(async (file) => {
          const stat = await fs.stat(file);
          const content = await fs.readFile(file, "utf8").catch(() => "");
          const relativePath = path.relative(root, file);
          const name = path.basename(file, path.extname(file));
          return {
            id: relativePath.replace(/\\/g, "/"),
            name,
            path: file,
            relativePath,
            category: path.dirname(relativePath) === "." ? "personal" : path.dirname(relativePath).split(/[\\/]/)[0] ?? "personal",
            summary: firstContentLine(content) || "暂无说明",
            updatedAt: stat.mtime.toISOString(),
            size: stat.size,
            format: "flat" as const,
          };
        }),
    );

    const directorySkills = await Promise.all(
      files
        .filter((file) => path.basename(file) === "SKILL.md" && this.isValidSkillDirectoryPath(file))
        .map(async (file) => {
          const stat = await fs.stat(file);
          const content = await fs.readFile(file, "utf8").catch(() => "");
          const { frontmatter } = parseFrontmatter(content);
          const relativePath = path.relative(root, file);
          const dirName = path.dirname(relativePath);
          const name = String(frontmatter.name || path.basename(dirName));
          const category = path.dirname(dirName) === "." ? "personal" : path.dirname(dirName).split(/[\\/]/)[0] ?? "personal";
          return {
            id: relativePath.replace(/\\/g, "/"),
            name,
            path: file,
            relativePath,
            category,
            summary: String(frontmatter.description || firstContentLine(content) || "暂无说明"),
            updatedAt: stat.mtime.toISOString(),
            size: stat.size,
            format: "directory" as const,
          };
        }),
    );

    return [...flatSkills, ...directorySkills].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private isValidSkillFile(filePath: string): boolean {
    const fileName = path.basename(filePath).toLowerCase();
    if (!fileName.endsWith(".md")) return false;
    if (fileName.startsWith(".")) return false;
    if (fileName.startsWith("_")) return false;
    if (fileName.endsWith(".bak.md")) return false;
    if (fileName.includes(".backup.")) return false;
    if (fileName.includes(".tmp.")) return false;
    const dirName = path.dirname(filePath).toLowerCase();
    if (dirName.includes("__pycache__")) return false;
    if (dirName.includes(".git")) return false;
    return true;
  }

  private isValidSkillDirectoryPath(filePath: string): boolean {
    const dirName = path.dirname(filePath).toLowerCase();
    if (dirName.includes("__pycache__")) return false;
    if (dirName.includes(".git")) return false;
    if (dirName.includes(".github")) return false;
    if (dirName.includes(".hub")) return false;
    return true;
  }

  async readSkill(id: string) {
    const skillsRoot = path.join(await this.currentHermesHome(), "skills");
    const filePath = await this.resolveUnder(skillsRoot, id);
    return { id, path: filePath, content: await fs.readFile(filePath, "utf8") };
  }

  async saveSkill(id: string, content: string) {
    const skillsRoot = path.join(await this.currentHermesHome(), "skills");
    const isDirectorySkill = id.includes("/SKILL.md") || id.endsWith("\\SKILL.md");
    const skillId = isDirectorySkill || id.endsWith(".md") ? id : `${id}.md`;
    const validation = validateSkillId(skillId);
    if (!validation.valid) {
      throw new Error(`技能验证失败: ${validation.errors.join(", ")}`);
    }
    const filePath = await this.resolveUnder(skillsRoot, skillId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await this.backupPath(filePath);
    await fs.writeFile(filePath, content, "utf8");
    return this.readSkill(path.relative(skillsRoot, filePath));
  }

  async deleteSkill(id: string) {
    const skillsRoot = path.join(await this.currentHermesHome(), "skills");
    const filePath = await this.resolveUnder(skillsRoot, id);
    await this.moveToTrash(filePath);
    return { ok: true, id };
  }

  async uploadSkill(sourcePath: string): Promise<HermesSkill> {
    const validation = validateSkillUploadPath(sourcePath);
    if (!validation.valid) {
      throw new Error(`上传路径验证失败: ${validation.errors.join(", ")}`);
    }

    const stat = await fs.stat(sourcePath).catch(() => undefined);
    if (!stat) {
      throw new Error("上传路径不存在或无法访问。");
    }

    const skillsRoot = path.join(await this.currentHermesHome(), "skills");

    if (stat.isDirectory()) {
      const skillMdPath = path.join(sourcePath, "SKILL.md");
      const skillMdStat = await fs.stat(skillMdPath).catch(() => undefined);
      if (!skillMdStat?.isFile()) {
        throw new Error("选中的目录不包含 SKILL.md 文件，无法识别为 Hermes 技能包。");
      }
      const content = await fs.readFile(skillMdPath, "utf8");
      const { frontmatter } = parseFrontmatter(content);
      const name = String(frontmatter.name || path.basename(sourcePath)).trim();
      const category = String(frontmatter.category || "personal").trim();
      const dirValidation = validateSkillDirectoryName(name);
      if (!dirValidation.valid) {
        throw new Error(`技能名称验证失败: ${dirValidation.errors.join(", ")}`);
      }

      const targetDir = path.join(skillsRoot, category, name);
      const targetSkillMd = path.join(targetDir, "SKILL.md");
      await this.moveToTrash(targetDir);
      await fs.mkdir(targetDir, { recursive: true });

      const entries = await fs.readdir(sourcePath, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const src = path.join(sourcePath, entry.name);
          const dest = path.join(targetDir, entry.name);
          if (entry.isDirectory()) {
            await fs.cp(src, dest, { recursive: true });
          } else if (entry.isFile()) {
            await fs.copyFile(src, dest);
          }
        }),
      );

      const relativePath = path.relative(skillsRoot, targetSkillMd);
      return {
        id: relativePath.replace(/\\/g, "/"),
        name,
        path: targetSkillMd,
        relativePath,
        category,
        summary: String(frontmatter.description || firstContentLine(content) || "暂无说明"),
        updatedAt: new Date().toISOString(),
        size: (await fs.stat(targetSkillMd)).size,
        format: "directory",
      };
    }

    if (stat.isFile()) {
      if (!sourcePath.toLowerCase().endsWith(".md")) {
        throw new Error("只能上传 .md 文件或包含 SKILL.md 的目录。");
      }
      const content = await fs.readFile(sourcePath, "utf8");
      const baseName = path.basename(sourcePath, path.extname(sourcePath));
      const { frontmatter: existingFm } = parseFrontmatter(content);
      const name = String(existingFm.name || baseName).trim();
      const description = String(existingFm.description || firstContentLine(content) || "User uploaded skill").trim();
      const dirValidation = validateSkillDirectoryName(name);
      if (!dirValidation.valid) {
        throw new Error(`技能名称验证失败: ${dirValidation.errors.join(", ")}`);
      }

      const targetDir = path.join(skillsRoot, "personal", name);
      const targetSkillMd = path.join(targetDir, "SKILL.md");
      await this.moveToTrash(targetDir);
      await fs.mkdir(targetDir, { recursive: true });

      let skillContent = content;
      if (!content.trimStart().startsWith("---")) {
        skillContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`;
      }
      await fs.writeFile(targetSkillMd, skillContent, "utf8");

      const relativePath = path.relative(skillsRoot, targetSkillMd);
      return {
        id: relativePath.replace(/\\/g, "/"),
        name,
        path: targetSkillMd,
        relativePath,
        category: "personal",
        summary: description,
        updatedAt: new Date().toISOString(),
        size: (await fs.stat(targetSkillMd)).size,
        format: "directory",
      };
    }

    throw new Error("上传路径既不是文件也不是目录。");
  }

  async listMemoryFiles(): Promise<HermesMemoryFile[]> {
    const currentHome = await this.currentHermesHome();
    const files: Array<HermesMemoryFile["id"]> = ["USER.md", "MEMORY.md"];
    return await Promise.all(files.map(async (fileName) => {
      const filePath = path.join(currentHome, "memories", fileName);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "", { flag: "a" });
      const stat = await fs.stat(filePath);
      return {
        id: fileName,
        label: fileName === "USER.md" ? "用户偏好" : "长期记忆",
        path: filePath,
        content: await fs.readFile(filePath, "utf8"),
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
      };
    }));
  }

  async saveMemoryFile(id: HermesMemoryFile["id"], content: string) {
    const filePath = path.join(await this.currentHermesHome(), "memories", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.copyFile(filePath, `${filePath}.${Date.now()}.bak`).catch(() => undefined);
    await fs.writeFile(filePath, content, "utf8");
    return (await this.listMemoryFiles()).find((item) => item.id === id);
  }

  async importMemoryFile(sourcePath: string, targetId: HermesMemoryFile["id"]) {
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error("源路径不是文件。");
    }
    const content = await fs.readFile(sourcePath, "utf8");
    return this.saveMemoryFile(targetId, content);
  }

  async listProfiles(): Promise<HermesProfile[]> {
    const base = await this.baseHermesHome();
    const active = await this.activeProfileName(base);
    const profileRoot = path.join(base, "profiles");
    const entries = await fs.readdir(profileRoot, { withFileTypes: true }).catch(() => []);
    const names = ["default", ...entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)];
    return await Promise.all([...new Set(names)].map(async (name) => {
      const profilePath = name === "default" ? base : path.join(profileRoot, name);
      const [skills, memories, stat] = await Promise.all([
        fs.readdir(path.join(profilePath, "skills")).catch(() => []),
        fs.readdir(path.join(profilePath, "memories")).catch(() => []),
        fs.stat(profilePath).catch(() => undefined),
      ]);
      return {
        id: name,
        name,
        path: profilePath,
        active: active === name,
        hasConfig: Boolean(await fs.stat(path.join(profilePath, "config.yaml")).catch(() => undefined)),
        skillCount: skills.length,
        memoryFiles: memories.filter((item) => item.endsWith(".md")).length,
        updatedAt: stat?.mtime.toISOString(),
      };
    }));
  }

  async switchProfile(name: string) {
    const base = await this.baseHermesHome();
    const safe = await this.resolveProfileName(base, name);
    await fs.writeFile(path.join(base, "active_profile"), safe === "default" ? "" : safe, "utf8");
    return { ok: true, active: safe, profiles: await this.listProfiles() };
  }

  async createProfile(name: string) {
    const validation = validateProfileName(name);
    if (!validation.valid) {
      throw new Error(`Profile 验证失败: ${validation.errors.join(", ")}`);
    }
    
    const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    if (!safe) throw new Error("Profile 名称不能为空。");
    if (safe === "default") throw new Error("default Agent 已存在。");
    const profilePath = path.join(await this.baseHermesHome(), "profiles", safe);
    await fs.mkdir(path.join(profilePath, "skills"), { recursive: true });
    await fs.mkdir(path.join(profilePath, "memories"), { recursive: true });
    await fs.mkdir(path.join(profilePath, "cron"), { recursive: true });
    await fs.writeFile(path.join(profilePath, "memories", "USER.md"), "# USER\n\n", { flag: "a" });
    await fs.writeFile(path.join(profilePath, "memories", "MEMORY.md"), "# MEMORY\n\n", { flag: "a" });
    return (await this.listProfiles()).find((item) => item.id === safe);
  }

  async deleteProfile(name: string) {
    if (name === "default") throw new Error("不能删除 default profile。");
    const base = await this.baseHermesHome();
    const safe = await this.resolveProfileName(base, name);
    if (safe === "default") throw new Error("不能删除 default profile。");
    const profilePath = await this.resolveUnder(path.join(base, "profiles"), safe);
    const wasActive = await this.activeProfileName(base) === safe;
    await this.moveToTrash(profilePath);
    if (wasActive) {
      await fs.writeFile(path.join(base, "active_profile"), "", "utf8");
    }
    return { ok: true, id: safe, profiles: await this.listProfiles() };
  }

  async listCronJobs(): Promise<HermesCronJob[]> {
    const jobsPath = path.join(await this.currentHermesHome(), "cron", "jobs.json");
    const raw = this.cronJobRecords(await this.readJson<unknown>(jobsPath, []));
    return raw.map((item, index) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const id = String(record.id ?? record.name ?? `job-${index}`);
      const state = typeof record.state === "string" ? record.state : undefined;
      const repeat = record.repeat && typeof record.repeat === "object" ? record.repeat as Record<string, unknown> : undefined;
      const deliver = Array.isArray(record.deliver) ? record.deliver.join(", ") : typeof record.deliver === "string" ? record.deliver : undefined;
      return {
        id,
        name: String(record.name ?? record.title ?? id),
        prompt: typeof record.prompt === "string" ? record.prompt : undefined,
        schedule: this.displayCronSchedule(record),
        status: record.enabled === false || record.paused === true || state === "paused" ? "paused" : state === "scheduled" ? "active" : "unknown",
        source: typeof record.source === "string" && record.source === "json-fallback" ? "json-fallback" : "cli",
        lastOutput: this.cronLastOutput(record),
        path: jobsPath,
        lastRunAt: typeof record.last_run_at === "string" ? record.last_run_at : undefined,
        nextRunAt: typeof record.next_run_at === "string" ? record.next_run_at : undefined,
        repeat: typeof repeat?.times === "number" ? repeat.times : null,
        deliver,
        skills: Array.isArray(record.skills) ? record.skills.map(String).filter(Boolean) : typeof record.skill === "string" ? [record.skill] : undefined,
        script: typeof record.script === "string" ? record.script : undefined,
        noAgent: Boolean(record.no_agent ?? record.noAgent),
        workdir: typeof record.workdir === "string" ? record.workdir : typeof record.cwd === "string" ? record.cwd : undefined,
      };
    });
  }

  async saveCronJob(input: Partial<HermesCronJob>): Promise<HermesCronJob> {
    if (!input.name?.trim()) {
      throw new Error("定时任务名称不能为空");
    }
    
    if (input.schedule) {
      const validation = validateCronSchedule(input.schedule);
      if (!validation.valid) {
        throw new Error(`定时计划验证失败: ${validation.errors.join(", ")}`);
      }
    }
    
    const id = input.id?.trim() || `job-${Date.now().toString(36)}`;
    const existing = input.id ? await this.getCronJob(input.id) : undefined;
    const name = input.name.trim();
    const schedule = input.schedule?.trim() || existing?.schedule || "30m";
    const prompt = input.prompt ?? existing?.prompt ?? "";
    const noAgent = input.noAgent ?? existing?.noAgent ?? false;
    const script = await this.prepareCronScript(input, existing, name);
    const deliver = input.deliver ?? existing?.deliver;
    const workdir = input.workdir ?? existing?.workdir;
    const skills = input.skills ?? existing?.skills;
    if (noAgent && !script) {
      throw new Error("脚本看门狗模式需要指定脚本文件或填写脚本内容。");
    }
    if (!noAgent && !prompt.trim()) {
      throw new Error("Agent 任务需要填写 prompt。");
    }
    const cliArgs = this.buildCronSaveArgs({
      id: input.id,
      name,
      schedule,
      prompt,
      noAgent,
      script,
      deliver,
      workdir,
      skills,
      noAgentChanged: typeof input.noAgent === "boolean",
    });
    const cliResult = await this.runHermes(cliArgs);
    if (!cliResult.ok) {
      throw new Error(`Hermes 原生定时任务保存失败：${cliResult.message || `exit ${cliResult.exitCode}`}`);
    }
    if (input.status === "paused") {
      await this.tryRunHermes(["cron", "pause", input.id || this.extractCreatedCronId(cliResult.message) || id]);
    }
    const cliJobs = await this.listCronJobs();
    return cliJobs.find((item) => item.id === input.id || item.id === this.extractCreatedCronId(cliResult.message) || item.name === name) ?? {
      id,
      name,
      prompt,
      schedule,
      status: input.status ?? "active",
      source: "cli",
      lastOutput: cliResult.message,
      noAgent,
      script,
      deliver,
      workdir,
      skills,
    };
  }

  async listKanbanBoards(): Promise<HermesKanbanBoard[]> {
    return this.normalizeKanbanBoards(await this.runHermesJson<unknown>(["kanban", "boards", "list", "--json"]));
  }

  async createKanbanBoard(input: HermesKanbanCreateBoardInput): Promise<HermesKanbanActionResult> {
    const slug = this.requireSlug(input.slug, "看板 slug");
    const args = ["kanban", "boards", "create", slug];
    this.pushOptional(args, "--name", input.name);
    this.pushOptional(args, "--description", input.description);
    this.pushOptional(args, "--icon", input.icon);
    this.pushOptional(args, "--color", input.color);
    if (input.switchTo !== false) args.push("--switch");
    return this.runKanbanAction(args);
  }

  async switchKanbanBoard(slug: string): Promise<HermesKanbanActionResult> {
    return this.runKanbanAction(["kanban", "boards", "switch", this.requireSlug(slug, "看板 slug")]);
  }

  async deleteKanbanBoard(slug: string): Promise<HermesKanbanActionResult> {
    return this.runKanbanAction(["kanban", "boards", "rm", this.requireSlug(slug, "看板 slug"), "--delete"]);
  }

  async renameKanbanBoard(slug: string, name: string): Promise<HermesKanbanActionResult> {
    return this.runKanbanAction(["kanban", "boards", "rename", this.requireSlug(slug, "看板 slug"), name.trim()]);
  }

  async dispatchKanban(board?: string): Promise<HermesKanbanActionResult> {
    return this.runKanbanAction([...this.kanbanBaseArgs(board), "dispatch"]);
  }

  async listKanbanTasks(options: HermesKanbanTaskListOptions = {}): Promise<HermesKanbanTask[]> {
    const args = [...this.kanbanBaseArgs(options.board), "list", "--json"];
    this.pushOptional(args, "--status", options.status);
    this.pushOptional(args, "--assignee", options.assignee);
    this.pushOptional(args, "--tenant", options.tenant);
    if (options.archived) args.push("--archived");
    if (options.mine) args.push("--mine");
    return this.normalizeKanbanTasks(await this.runHermesJson<unknown>(args));
  }

  async createKanbanTask(input: HermesKanbanCreateTaskInput): Promise<HermesKanbanTask> {
    const title = input.title?.trim();
    if (!title) throw new Error("任务标题不能为空。");
    const args = [...this.kanbanBaseArgs(input.board), "create", title, "--json"];
    this.pushOptional(args, "--body", input.body);
    this.pushOptional(args, "--assignee", input.assignee);
    this.pushOptional(args, "--priority", input.priority);
    this.pushOptional(args, "--tenant", input.tenant);
    if (input.triage) args.push("--triage");
    if (input.workspaceKind) args.push("--workspace", input.workspaceKind === "dir" && input.workspacePath ? `dir:${input.workspacePath}` : input.workspaceKind);
    for (const skill of input.skills ?? []) this.pushOptional(args, "--skill", skill);
    if (typeof input.maxRetries === "number") args.push("--max-retries", String(input.maxRetries));
    return this.normalizeKanbanTask(await this.runHermesJson<unknown>(args));
  }

  async getKanbanTask(input: { board?: string; taskId: string }): Promise<HermesKanbanTask> {
    const args = [...this.kanbanBaseArgs(input.board), "show", this.requireId(input.taskId, "任务 ID"), "--json"];
    return this.normalizeKanbanTask(await this.runHermesJson<unknown>(args));
  }

  async runKanbanTaskAction(input: HermesKanbanTaskActionInput): Promise<HermesKanbanActionResult> {
    const taskId = this.requireId(input.taskId, "任务 ID");
    const args = [...this.kanbanBaseArgs(input.board)];
    if (input.action === "assign") {
      const assignee = input.assignee?.trim();
      if (!assignee) throw new Error("assign 操作需要指定 assignee。");
      args.push("assign", taskId, assignee);
    } else if (input.action === "reassign") {
      const assignee = input.assignee?.trim();
      if (!assignee) throw new Error("reassign 操作需要指定 assignee。");
      args.push("reassign", taskId, assignee);
      if (input.reclaim) args.push("--reclaim");
      this.pushOptional(args, "--reason", input.reason);
    } else if (input.action === "reclaim") {
      args.push("reclaim", taskId);
      this.pushOptional(args, "--reason", input.reason);
    } else if (input.action === "complete") {
      args.push("complete", taskId);
      this.pushOptional(args, "--result", input.result);
    } else if (input.action === "edit") {
      args.push("edit", taskId);
      if (!input.result?.trim()) throw new Error("edit 操作需要指定 result。");
      args.push("--result", input.result.trim());
      this.pushOptional(args, "--summary", input.summary);
    } else if (input.action === "specify") {
      args.push("specify", taskId);
    } else if (input.action === "block") {
      const reason = input.reason?.trim();
      if (!reason) throw new Error("block 操作需要填写原因。");
      args.push("block", taskId, reason);
    } else if (input.action === "unblock") {
      args.push("unblock", taskId);
    } else if (input.action === "archive") {
      args.push("archive", taskId);
    } else {
      throw new Error(`不支持的 Kanban 操作：${input.action}`);
    }
    return this.runKanbanAction(args);
  }

  async listKanbanDiagnostics(input: { board?: string; taskId?: string; severity?: string } = {}): Promise<HermesKanbanDiagnostic[]> {
    const args = [...this.kanbanBaseArgs(input.board), "diagnostics", "--json"];
    this.pushOptional(args, "--task", input.taskId);
    this.pushOptional(args, "--severity", input.severity);
    const parsed = await this.runHermesJson<unknown>(args);
    return Array.isArray(parsed) ? parsed.map((item) => item as HermesKanbanDiagnostic) : [];
  }

  async listKanbanAssignees(board?: string): Promise<HermesKanbanAssignee[]> {
    const parsed = await this.runHermesJson<unknown>([...this.kanbanBaseArgs(board), "assignees", "--json"]);
    if (Array.isArray(parsed)) return parsed.map((item) => this.normalizeKanbanAssignee(item));
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({
        name,
        ...(value && typeof value === "object" ? value as Record<string, unknown> : {}),
      }));
    }
    return [];
  }

  async readKanbanTaskLog(input: { board?: string; taskId: string; tail?: number }): Promise<HermesKanbanActionResult> {
    const tail = Math.max(1, Math.min(5000, Math.floor(input.tail ?? 400)));
    return this.runKanbanAction([...this.kanbanBaseArgs(input.board), "log", this.requireId(input.taskId, "任务 ID"), "--tail", String(tail)], { timeoutMs: 30000 });
  }

  async commentKanbanTask(input: { board?: string; taskId: string; text: string; author?: string }): Promise<HermesKanbanActionResult> {
    const taskId = this.requireId(input.taskId, "任务 ID");
    const text = input.text?.trim();
    if (!text) throw new Error("评论内容不能为空。");
    const args = [...this.kanbanBaseArgs(input.board), "comment", taskId, text];
    this.pushOptional(args, "--author", input.author);
    return this.runKanbanAction(args);
  }

  async runCronJob(id: string) {
    const trigger = await this.runHermes(["cron", "run", id]);
    if (!trigger.ok) return trigger;
    const tick = await this.runHermes(["cron", "tick"], { timeoutMs: 10 * 60 * 1000 });
    return {
      ok: tick.ok,
      message: [trigger.message, tick.message || "已触发 Hermes cron scheduler tick。"].filter(Boolean).join("\n"),
      exitCode: tick.exitCode,
    };
  }

  async pauseCronJob(id: string) {
    return this.runHermes(["cron", "pause", id]);
  }

  async resumeCronJob(id: string) {
    return this.runHermes(["cron", "resume", id]);
  }

  async deleteCronJob(id: string) {
    return await this.runHermes(["cron", "delete", id]);
  }

  private async getCronJob(id: string) {
    return (await this.listCronJobs()).find((item) => item.id === id);
  }

  private displayCronSchedule(record: Record<string, unknown>) {
    if (typeof record.schedule_display === "string") return record.schedule_display;
    if (typeof record.schedule === "string") return record.schedule;
    if (typeof record.cron === "string") return record.cron;
    const schedule = record.schedule && typeof record.schedule === "object" ? record.schedule as Record<string, unknown> : undefined;
    if (!schedule) return undefined;
    if (typeof schedule.display === "string") return schedule.display;
    if (typeof schedule.expr === "string") return schedule.expr;
    if (schedule.kind === "interval" && typeof schedule.minutes === "number") return `${schedule.minutes}m`;
    if (schedule.kind === "once" && typeof schedule.run_at === "string") return schedule.run_at;
    return undefined;
  }

  private cronLastOutput(record: Record<string, unknown>) {
    if (typeof record.last_output === "string") return record.last_output;
    const lastStatus = typeof record.last_status === "string" ? record.last_status : undefined;
    const lastError = typeof record.last_error === "string" ? record.last_error : undefined;
    const deliveryError = typeof record.last_delivery_error === "string" ? record.last_delivery_error : undefined;
    if (lastError) return `${lastStatus ?? "failed"}: ${lastError}`;
    if (deliveryError) return `delivery: ${deliveryError}`;
    return lastStatus;
  }

  private extractCreatedCronId(message: string) {
    return message.match(/Created job:\s*([a-zA-Z0-9_-]+)/)?.[1];
  }

  private cronJobRecords(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).jobs)) {
      return (raw as Record<string, unknown>).jobs as unknown[];
    }
    return [];
  }

  private buildCronSaveArgs(input: {
    id?: string;
    name: string;
    schedule: string;
    prompt: string;
    noAgent: boolean;
    script?: string;
    deliver?: string;
    workdir?: string;
    skills?: string[];
    noAgentChanged: boolean;
  }) {
    const args = input.id
      ? ["cron", "edit", input.id, "--name", input.name, "--schedule", input.schedule]
      : ["cron", "create", "--name", input.name];
    if (input.id) {
      args.push("--prompt", input.noAgent && !input.prompt.trim() ? "" : input.prompt);
    }
    this.pushOptional(args, "--deliver", input.deliver);
    this.pushOptional(args, "--script", input.script);
    this.pushOptional(args, "--workdir", input.workdir);
    if (input.noAgent) {
      args.push("--no-agent");
    } else if (input.noAgentChanged && input.id) {
      args.push("--agent");
    }
    if (input.id && input.skills) {
      if (input.skills.length === 0) args.push("--clear-skills");
      for (const skill of input.skills) this.pushOptional(args, "--skill", skill);
    } else {
      for (const skill of input.skills ?? []) this.pushOptional(args, "--skill", skill);
    }
    if (!input.id) {
      args.push(input.schedule);
      if (!input.noAgent || input.prompt.trim()) args.push(input.prompt);
    }
    return args;
  }

  private async prepareCronScript(input: Partial<HermesCronJob>, existing: HermesCronJob | undefined, name: string) {
    const scriptFromInput = typeof input.script === "string" ? input.script.trim() : undefined;
    const scriptContent = typeof input.scriptContent === "string" ? input.scriptContent : undefined;
    if (scriptContent !== undefined) {
      const relativeName = scriptFromInput || existing?.script || `${this.safeScriptBaseName(name)}.py`;
      return this.writeCronScript(relativeName, scriptContent);
    }
    return scriptFromInput ?? existing?.script;
  }

  private async writeCronScript(relativeName: string, content: string) {
    if (!content.trim()) throw new Error("脚本内容不能为空。");
    const normalized = this.validateCronScriptRelativePath(relativeName);
    const scriptsRoot = path.resolve(await this.currentHermesHome(), "scripts");
    const target = path.resolve(scriptsRoot, normalized);
    if (!target.toLowerCase().startsWith(`${scriptsRoot.toLowerCase()}${path.sep}`) && target.toLowerCase() !== scriptsRoot.toLowerCase()) {
      throw new Error("脚本路径必须位于 Hermes Home 的 scripts/ 目录内。");
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return path.relative(scriptsRoot, target).replace(/\\/g, "/");
  }

  private validateCronScriptRelativePath(relativeName: string) {
    const value = relativeName.trim().replace(/\\/g, "/");
    if (!value) throw new Error("脚本文件名不能为空。");
    if (path.isAbsolute(value) || /^[a-zA-Z]:\//.test(value)) throw new Error("脚本文件名不能是绝对路径。");
    const parts = value.split("/").filter(Boolean);
    if (parts.some((part) => part === ".." || part === ".")) throw new Error("脚本文件名不能包含路径穿越。");
    if (parts.some((part) => part.startsWith("."))) throw new Error("脚本文件名不能是隐藏路径。");
    return parts.join("/");
  }

  private safeScriptBaseName(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || `watchdog-${Date.now().toString(36)}`;
  }

  private kanbanBaseArgs(board?: string) {
    const args = ["kanban"];
    const slug = board?.trim();
    if (slug) args.push("--board", this.requireSlug(slug, "看板 slug"));
    return args;
  }

  private async runKanbanAction(args: string[], options: { timeoutMs?: number } = {}): Promise<HermesKanbanActionResult> {
    const result = await this.runHermes(args, options);
    if (!result.ok) {
      throw new Error(`Hermes Kanban 命令失败：${result.stderr || result.stdout || result.message || `exit ${result.exitCode}`}`);
    }
    return result;
  }

  private normalizeKanbanBoards(raw: unknown): HermesKanbanBoard[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((item, index) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        ...record,
        slug: String(record.slug ?? record.id ?? record.name ?? `board-${index}`),
        name: typeof record.name === "string" ? record.name : undefined,
        counts: record.counts && typeof record.counts === "object" ? this.numberRecord(record.counts as Record<string, unknown>) : undefined,
      } as HermesKanbanBoard;
    });
  }

  private normalizeKanbanTasks(raw: unknown): HermesKanbanTask[] {
    return Array.isArray(raw) ? raw.map((item) => this.normalizeKanbanTask(item)) : [];
  }

  private normalizeKanbanTask(raw: unknown): HermesKanbanTask {
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const task = record.task && typeof record.task === "object" ? record.task as Record<string, unknown> : record;
    return {
      ...record,
      ...task,
      id: String(task.id ?? record.id ?? ""),
      title: String(task.title ?? record.title ?? "Untitled task"),
      status: String(task.status ?? record.status ?? "todo"),
      runs: Array.isArray(record.runs) ? record.runs as HermesKanbanTask["runs"] : Array.isArray(task.runs) ? task.runs as HermesKanbanTask["runs"] : undefined,
      diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics as HermesKanbanDiagnostic[] : Array.isArray(task.diagnostics) ? task.diagnostics as HermesKanbanDiagnostic[] : undefined,
    };
  }

  private normalizeKanbanAssignee(raw: unknown): HermesKanbanAssignee {
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return {
      ...record,
      name: String(record.name ?? record.id ?? record.assignee ?? "unknown"),
    };
  }

  private numberRecord(record: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, typeof value === "number" ? value : Number(value) || 0]));
  }

  private pushOptional(args: string[], flag: string, value: unknown) {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed) args.push(flag, trimmed);
  }

  private requireSlug(value: string, label: string) {
    const trimmed = value.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(trimmed)) {
      throw new Error(`${label} 只能包含字母、数字、下划线和短横线，且不能以符号开头。`);
    }
    return trimmed;
  }

  private requireId(value: string, label: string) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 160) throw new Error(`${label} 无效。`);
    return trimmed;
  }

  async previewFile(filePath: string): Promise<FilePreviewResult> {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return { path: filePath, name: path.basename(filePath), kind: "directory", size: stat.size, modifiedAt: stat.mtime.toISOString() };
    }
    const ext = path.extname(filePath).toLowerCase();
    const imageExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
    if (imageExts.has(ext)) {
      return { path: filePath, name: path.basename(filePath), kind: "image", mimeType: mimeFromExt(ext), size: stat.size, modifiedAt: stat.mtime.toISOString() };
    }
    if (stat.size > 512 * 1024) {
      return { path: filePath, name: path.basename(filePath), kind: "binary", size: stat.size, modifiedAt: stat.mtime.toISOString() };
    }
    const content = await fs.readFile(filePath, "utf8").catch(() => "");
    return { path: filePath, name: path.basename(filePath), kind: ext === ".md" ? "markdown" : "text", content, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }

  async gitInfo(workspacePath: string) {
    const branch = await runCommand("git", ["branch", "--show-current"], { cwd: workspacePath, timeoutMs: 5000 }).catch(() => undefined);
    const status = await runCommand("git", ["status", "--porcelain"], { cwd: workspacePath, timeoutMs: 5000 }).catch(() => undefined);
    const allDirtyFiles = status?.exitCode === 0 ? status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.trim()) : [];
    return {
      branch: branch?.exitCode === 0 ? branch.stdout.trim() || "detached" : "",
      dirtyCount: allDirtyFiles.length,
      dirtyFiles: allDirtyFiles.slice(0, 20),
      available: branch?.exitCode === 0 || status?.exitCode === 0,
    };
  }

  async fileBreadcrumb(filePath: string): Promise<FileBreadcrumbItem[]> {
    const resolved = path.resolve(filePath);
    const parsed = path.parse(resolved);
    const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
    const items: FileBreadcrumbItem[] = [{ name: parsed.root.replace(/[\\/]$/, "") || parsed.root, path: parsed.root }];
    let current = parsed.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      items.push({ name: segment, path: current });
    }
    return items;
  }

  async openExternalPath(targetPath: string) {
    const error = await shell.openPath(targetPath);
    return { ok: !error, message: error || `已打开：${targetPath}` };
  }

  private async runHermesJson<T>(args: string[], options: { timeoutMs?: number } = {}): Promise<T> {
    const result = await this.runHermes(args, options);
    if (!result.ok) {
      throw new Error(`Hermes CLI 调用失败：${result.stderr || result.stdout || result.message || `exit ${result.exitCode}`}`);
    }
    const stdout = result.stdout.trim();
    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      const detail = [
        `stdout: ${stdout || "(empty)"}`,
        `stderr: ${result.stderr.trim() || "(empty)"}`,
      ].join("\n");
      throw new Error(`Hermes CLI 没有返回有效 JSON。\n${detail}`);
    }
  }

  private async runHermes(args: string[], options: { timeoutMs?: number } = {}) {
    const root = await this.resolveHermesRoot();
    const currentHermesHome = await this.currentHermesHome();
    const runtime = await this.currentRuntime();
    const adapter = runtime ? this.runtimeAdapterFactory!(runtime) : undefined;
    const runtimeRoot = adapter?.toRuntimePath(root);
    const launch = runtime && adapter && runtimeRoot
      ? await adapter.buildHermesLaunch({
        runtime,
        rootPath: runtimeRoot,
        pythonArgs: [
          runtime.mode === "wsl"
            ? `${runtimeRoot.replace(/\/+$/, "")}/hermes`
            : runtime.mode === "darwin"
              ? this.nativeHermesCliPath(root)
              : this.windowsHermesCliPath(root),
          ...args,
        ],
        cwd: root,
        env: {
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONPATH: runtimeRoot,
          HERMES_HOME: adapter?.toRuntimePath(currentHermesHome) ?? currentHermesHome,
        },
      })
      : await this.legacyHermesLaunch(root, args, currentHermesHome);
    const result = await runCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      timeoutMs: options.timeoutMs ?? 30000,
      env: launch.env,
      commandId: "webui.hermes",
      runtimeKind: runtime?.mode ?? this.nativeRuntimeMode(),
    });
    return {
      ok: result.exitCode === 0,
      message: result.stdout || result.stderr,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  private async currentRuntime() {
    if (!this.runtimeAdapterFactory || !this.readRuntimeConfig) return undefined;
    const config = await this.readRuntimeConfig();
    return {
      mode: config.hermesRuntime?.mode ?? "windows",
      distro: config.hermesRuntime?.distro?.trim() || undefined,
      pythonCommand: config.hermesRuntime?.pythonCommand?.trim() || "python",
      windowsAgentMode: config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
    } satisfies NonNullable<RuntimeConfig["hermesRuntime"]>;
  }

  private async legacyHermesLaunch(root: string, args: string[], hermesHome: string) {
    // Legacy fallback: kept for tests/standalone construction paths until all WebUI callers inject RuntimeAdapterFactory.
    const cliPath = this.nativeHermesCliPath(root);
    return {
      command: getDefaultPythonCommand(getPlatformKind()),
      args: [cliPath, ...args],
      cwd: root,
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONPATH: root, HERMES_HOME: hermesHome },
    };
  }

  private async tryRunHermes(args: string[]) {
    try {
      return await this.runHermes(args);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Hermes CLI 调用失败。", exitCode: null };
    }
  }

  private windowsHermesCliPath(root: string) {
    return resolveWindowsHermesCliPathSync(root) ?? defaultWindowsHermesCliPath(root);
  }

  private nativeHermesCliPath(root: string) {
    return resolveHermesCliPathSync(root) ?? defaultHermesCliPath(root);
  }

  private nativeRuntimeMode(): "windows" | "darwin" {
    return process.platform === "win32" ? "windows" : "darwin";
  }

  private theme(value: unknown): ThemePreference["id"] {
    return value === "light" || value === "slate" || value === "oled" || value === "default-large" ? value : "green-light";
  }

  private async baseHermesHome() {
    const baseHome = this.appPaths.hermesDir();
    await ensureHermesHomeLayout(baseHome);
    return baseHome;
  }

  private async currentHermesHome() {
    return await resolveActiveHermesHome(await this.baseHermesHome());
  }

  private async activeProfileName(baseHome: string) {
    const active = (await fs.readFile(path.join(baseHome, "active_profile"), "utf8").catch(() => "")).trim();
    if (!active || /[\\/]/.test(active)) return "default";
    const stat = await fs.stat(path.join(baseHome, "profiles", active)).catch(() => undefined);
    return stat?.isDirectory() ? active : "default";
  }

  private async resolveProfileName(baseHome: string, name: string) {
    const validation = validateProfileName(name);
    if (!validation.valid) {
      throw new Error(`Profile 验证失败: ${validation.errors.join(", ")}`);
    }
    const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    if (!safe) throw new Error("Profile 名称不能为空。");
    if (safe === "default") return safe;
    const stat = await fs.stat(path.join(baseHome, "profiles", safe)).catch(() => undefined);
    if (!stat?.isDirectory()) throw new Error(`Agent 不存在：${safe}`);
    return safe;
  }

  private settingsPath() {
    return path.join(this.appPaths.baseDir(), "webui-settings.json");
  }

  private projectsPath() {
    return path.join(this.appPaths.baseDir(), "webui-projects.json");
  }

  private spacesPath() {
    return path.join(this.appPaths.baseDir(), "webui-spaces.json");
  }

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(filePath: string, value: unknown) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  }

  private async backupPath(targetPath: string) {
    const stat = await fs.stat(targetPath).catch(() => undefined);
    if (!stat?.isFile()) return;
    const backupDir = path.join(path.dirname(targetPath), ".hermes-workbench-backups");
    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(targetPath, path.join(backupDir, `${path.basename(targetPath)}.${Date.now()}.bak`)).catch(() => undefined);
  }

  private async moveToTrash(targetPath: string) {
    const stat = await fs.stat(targetPath).catch(() => undefined);
    if (!stat) return;
    const trashDir = path.join(await this.baseHermesHome(), ".workbench-trash", new Date().toISOString().slice(0, 10));
    await fs.mkdir(trashDir, { recursive: true });
    const target = path.join(trashDir, `${path.basename(targetPath)}.${Date.now()}`);
    await fs.rename(targetPath, target).catch(async () => {
      await fs.rm(targetPath, { recursive: stat.isDirectory(), force: true });
    });
  }

  private async walkFiles(root: string, maxDepth: number, depth = 0): Promise<string[]> {
    if (depth > maxDepth) return [];
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return this.walkFiles(entryPath, maxDepth, depth + 1);
      if (entry.isFile()) return [entryPath];
      return [];
    }));
    return nested.flat();
  }

  private async resolveUnder(root: string, relativePath: string) {
    const target = path.resolve(root, relativePath);
    const resolvedRoot = path.resolve(root);
    if (!target.toLowerCase().startsWith(resolvedRoot.toLowerCase())) {
      throw new Error("路径越界。");
    }
    return target;
  }
}

function firstContentLine(content: string) {
  return content.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean);
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.trimStart().match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const lines = match[1].split(/\r?\n/);
  const frontmatter: Record<string, unknown> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0) frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter, body: match[2] };
}

function mimeFromExt(ext: string) {
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return `image/${ext.replace(".", "") || "png"}`;
}
