import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPaths } from "./app-paths";
import { runCommand } from "../process/command-runner";
import { defaultHermesCliPath } from "../runtime/hermes-cli-paths";
import { HermesWebUiService } from "./hermes-webui-service";

vi.mock("../process/command-runner", () => ({
  runCommand: vi.fn(),
}));

let tempRoot = "";
const nativePythonCommand = process.platform === "win32" ? "python" : "python3";

function nativeHermesCliPath() {
  return defaultHermesCliPath(path.join(tempRoot, "Hermes Agent"));
}

describe("HermesWebUiService", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-webui-service-"));
    vi.mocked(runCommand).mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("stores memory and skills under the active Hermes profile inside app HERMES_HOME", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    const service = new HermesWebUiService(
      appPaths,
      async () => path.join(tempRoot, "Hermes Agent"),
      undefined,
      undefined,
    );

    await service.createProfile("wechat");
    await service.switchProfile("wechat");
    await service.saveMemoryFile("USER.md", "偏好：中文输出");
    await service.saveMemoryFile("MEMORY.md", "长期记忆：项目代号是星图");
    await service.saveSkill("review", "# review\n\nAlways summarize findings.");

    const activeHome = path.join(appPaths.hermesDir(), "profiles", "wechat");
    await expect(fs.readFile(path.join(activeHome, "memories", "USER.md"), "utf8")).resolves.toContain("中文输出");
    await expect(fs.readFile(path.join(activeHome, "memories", "MEMORY.md"), "utf8")).resolves.toContain("项目代号是星图");
    await expect(fs.readFile(path.join(activeHome, "skills", "review.md"), "utf8")).resolves.toContain("Always summarize findings.");
    const listed = await service.listMemoryFiles();
    expect(listed.map((item) => item.path)).toEqual([
      path.join(activeHome, "memories", "USER.md"),
      path.join(activeHome, "memories", "MEMORY.md"),
    ]);
  });

  it("keeps profile switching and deletion in a valid active state", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    const created = await service.createProfile("wechat");
    expect(created).toMatchObject({ id: "wechat", memoryFiles: 2 });
    await service.switchProfile("wechat");

    await expect(service.switchProfile("missing-agent")).rejects.toThrow("Agent 不存在");
    const removed = await service.deleteProfile("wechat");

    expect(removed.profiles.find((profile) => profile.id === "default")).toMatchObject({ active: true });
    expect(removed.profiles.some((profile) => profile.id === "wechat")).toBe(false);
  });

  it("normalizes native Hermes cron jobs from jobs.json", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    const jobsPath = path.join(appPaths.hermesDir(), "cron", "jobs.json");
    await fs.mkdir(path.dirname(jobsPath), { recursive: true });
    await fs.writeFile(jobsPath, JSON.stringify({ jobs: [
      {
        id: "abc123",
        name: "Morning check",
        prompt: "Summarize project status",
        schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
        schedule_display: "0 9 * * *",
        enabled: true,
        state: "scheduled",
        next_run_at: "2026-04-25T01:00:00Z",
        repeat: { times: null, completed: 0 },
        deliver: "local",
        skills: ["review"],
      },
    ] }), "utf8");
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    const jobs = await service.listCronJobs();

    expect(jobs[0]).toMatchObject({
      id: "abc123",
      name: "Morning check",
      schedule: "0 9 * * *",
      status: "active",
      source: "cli",
      deliver: "local",
      skills: ["review"],
    });
  });

  it("creates cron jobs through the native Hermes CLI argument shape", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    vi.mocked(runCommand).mockResolvedValue({
      exitCode: 0,
      stdout: "Created job: abc123\n  Name: Morning check\n",
      stderr: "",
      diagnostics: { exitCode: 0 } as any,
    });
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    await service.saveCronJob({ name: "Morning check", schedule: "every 1h", prompt: "Summarize project status", status: "active" });

    expect(runCommand).toHaveBeenCalledWith(
      nativePythonCommand,
      [nativeHermesCliPath(), "cron", "create", "--name", "Morning check", "every 1h", "Summarize project status"],
      expect.objectContaining({ commandId: "webui.hermes" }),
    );
  });

  it("parses Kanban board/task/diagnostic JSON from Hermes CLI", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    vi.mocked(runCommand)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{ slug: "forge", name: "Forge", is_current: true, counts: { todo: 1 } }]),
        stderr: "",
        diagnostics: { exitCode: 0 } as any,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{ id: "task-1", title: "Wire UI", status: "todo" }]),
        stderr: "",
        diagnostics: { exitCode: 0 } as any,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{ task_id: "task-1", title: "Wire UI", diagnostics: [] }]),
        stderr: "",
        diagnostics: { exitCode: 0 } as any,
      });
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    await expect(service.listKanbanBoards()).resolves.toMatchObject([{ slug: "forge", name: "Forge", counts: { todo: 1 } }]);
    await expect(service.listKanbanTasks({ board: "forge" })).resolves.toMatchObject([{ id: "task-1", title: "Wire UI", status: "todo" }]);
    await expect(service.listKanbanDiagnostics({ board: "forge" })).resolves.toMatchObject([{ task_id: "task-1" }]);
  });

  it("surfaces Kanban CLI failures and bad JSON with stdout and stderr", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));
    vi.mocked(runCommand).mockResolvedValueOnce({
      exitCode: 2,
      stdout: "",
      stderr: "kanban failed",
      diagnostics: { exitCode: 2 } as any,
    });

    await expect(service.listKanbanBoards()).rejects.toThrow("kanban failed");

    vi.mocked(runCommand).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "not-json",
      stderr: "warning",
      diagnostics: { exitCode: 0 } as any,
    });

    await expect(service.listKanbanBoards()).rejects.toThrow("stdout: not-json");
  });

  it("creates no_agent cron jobs with safe script files", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    vi.mocked(runCommand).mockResolvedValue({
      exitCode: 0,
      stdout: "Created job: abc123\n",
      stderr: "",
      diagnostics: { exitCode: 0 } as any,
    });
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    await service.saveCronJob({
      name: "Watchdog",
      schedule: "every 1h",
      noAgent: true,
      script: "watchdog.py",
      scriptContent: "print('FORGE_CRON_NO_AGENT_OK')",
      status: "active",
    });

    expect(runCommand).toHaveBeenCalledWith(
      nativePythonCommand,
      [
        nativeHermesCliPath(),
        "cron", "create", "--name", "Watchdog", "--script", "watchdog.py", "--no-agent", "every 1h",
      ],
      expect.objectContaining({ commandId: "webui.hermes" }),
    );
    await expect(fs.readFile(path.join(appPaths.hermesDir(), "scripts", "watchdog.py"), "utf8")).resolves.toContain("FORGE_CRON_NO_AGENT_OK");
  });

  it("allows agent cron jobs to use scripts without no_agent", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    vi.mocked(runCommand).mockResolvedValue({
      exitCode: 0,
      stdout: "Created job: abc123\n",
      stderr: "",
      diagnostics: { exitCode: 0 } as any,
    });
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    await service.saveCronJob({
      name: "Agent with script",
      schedule: "every 1h",
      prompt: "Summarize",
      script: "collect.py",
      scriptContent: "print('context')",
      status: "active",
    });

    const args = vi.mocked(runCommand).mock.calls[0][1];
    expect(args).toContain("--script");
    expect(args).not.toContain("--no-agent");
  });

  it("rejects unsafe cron script paths and empty script content", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    await expect(service.saveCronJob({ name: "Bad", schedule: "every 1h", noAgent: true, script: "../bad.py", scriptContent: "print(1)" })).rejects.toThrow("路径穿越");
    await expect(service.saveCronJob({ name: "Bad", schedule: "every 1h", noAgent: true, script: "C:/bad.py", scriptContent: "print(1)" })).rejects.toThrow("绝对路径");
    await expect(service.saveCronJob({ name: "Bad", schedule: "every 1h", noAgent: true, script: "bad.py", scriptContent: "" })).rejects.toThrow("脚本内容不能为空");
  });

  it("edits cron jobs through the native Hermes CLI argument shape", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    const jobsPath = path.join(appPaths.hermesDir(), "cron", "jobs.json");
    await fs.mkdir(path.dirname(jobsPath), { recursive: true });
    await fs.writeFile(jobsPath, JSON.stringify({ jobs: [
      { id: "abc123", name: "Old", prompt: "Old prompt", schedule_display: "30m", schedule: { kind: "interval", minutes: 30 }, enabled: true, state: "scheduled" },
    ] }), "utf8");
    vi.mocked(runCommand).mockResolvedValue({
      exitCode: 0,
      stdout: "Updated job: abc123\n",
      stderr: "",
      diagnostics: { exitCode: 0 } as any,
    });
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    await service.saveCronJob({ id: "abc123", name: "Updated", schedule: "0 9 * * *", prompt: "New prompt", status: "active" });

    expect(runCommand).toHaveBeenCalledWith(
      nativePythonCommand,
      [nativeHermesCliPath(), "cron", "edit", "abc123", "--name", "Updated", "--schedule", "0 9 * * *", "--prompt", "New prompt"],
      expect.objectContaining({ commandId: "webui.hermes" }),
    );
  });

  it("manual cron run triggers the native scheduler tick", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    vi.mocked(runCommand)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Triggered job: Morning check (abc123)",
        stderr: "",
        diagnostics: { exitCode: 0 } as any,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Executed 1 job",
        stderr: "",
        diagnostics: { exitCode: 0 } as any,
      });
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    const result = await service.runCronJob("abc123");

    expect(result.ok).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      nativePythonCommand,
      [nativeHermesCliPath(), "cron", "run", "abc123"],
      expect.objectContaining({ timeoutMs: 30000 }),
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      nativePythonCommand,
      [nativeHermesCliPath(), "cron", "tick"],
      expect.objectContaining({ timeoutMs: 10 * 60 * 1000 }),
    );
  });

  it("lists both flat and directory skills in the same overview", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    await service.saveSkill("review.md", "# review\n\nAlways summarize findings.");
    await fs.mkdir(path.join(appPaths.hermesDir(), "skills", "software-development", "plan"), { recursive: true });
    await fs.writeFile(
      path.join(appPaths.hermesDir(), "skills", "software-development", "plan", "SKILL.md"),
      "---\nname: plan\ndescription: Plan mode for Hermes.\n---\n\n# Plan\n\nUse this skill to plan.",
      "utf8",
    );

    const skills = await service.listSkills();
    const flat = skills.find((s) => s.id === "review.md");
    const directory = skills.find((s) => s.id === "software-development/plan/SKILL.md");

    expect(flat).toMatchObject({ name: "review", format: "flat", category: "personal" });
    expect(directory).toMatchObject({ name: "plan", format: "directory", category: "software-development", summary: "Plan mode for Hermes." });
  });

  it("uploads a directory skill and lists it as directory format", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    const sourceDir = path.join(tempRoot, "source-skill");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: A test skill.\n---\n\n# My Skill\n\nContent here.",
      "utf8",
    );
    await fs.mkdir(path.join(sourceDir, "references"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "references", "note.md"), "Note", "utf8");

    const uploaded = await service.uploadSkill(sourceDir);
    expect(uploaded).toMatchObject({ name: "my-skill", format: "directory", category: "personal" });

    const targetSkillMd = path.join(appPaths.hermesDir(), "skills", "personal", "my-skill", "SKILL.md");
    await expect(fs.readFile(targetSkillMd, "utf8")).resolves.toContain("My Skill");
    await expect(fs.readFile(path.join(appPaths.hermesDir(), "skills", "personal", "my-skill", "references", "note.md"), "utf8")).resolves.toBe("Note");

    const skills = await service.listSkills();
    expect(skills.some((s) => s.id === "personal/my-skill/SKILL.md" && s.format === "directory")).toBe(true);
  });

  it("uploads a single markdown file and wraps it into a directory skill", async () => {
    const appPaths = new AppPaths(tempRoot);
    await appPaths.ensureBaseLayout();
    const service = new HermesWebUiService(appPaths, async () => path.join(tempRoot, "Hermes Agent"));

    const sourceFile = path.join(tempRoot, "legacy-skill.md");
    await fs.writeFile(sourceFile, "# Legacy Skill\n\nSome content.", "utf8");

    const uploaded = await service.uploadSkill(sourceFile);
    expect(uploaded).toMatchObject({ name: "legacy-skill", format: "directory", category: "personal" });

    const targetSkillMd = path.join(appPaths.hermesDir(), "skills", "personal", "legacy-skill", "SKILL.md");
    const content = await fs.readFile(targetSkillMd, "utf8");
    expect(content).toContain("---");
    expect(content).toContain("name: legacy-skill");
    expect(content).toContain("Some content.");

    const skills = await service.listSkills();
    expect(skills.some((s) => s.id === "personal/legacy-skill/SKILL.md" && s.format === "directory")).toBe(true);
  });
});
