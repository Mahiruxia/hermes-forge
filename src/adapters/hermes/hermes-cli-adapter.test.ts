import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HermesCliAdapter, toWslPath } from "./hermes-cli-adapter";

describe("toWslPath", () => {
  it("converts Windows drive paths", () => {
    expect(toWslPath("D:\\Projects\\hermes-desktop")).toBe("/mnt/d/Projects/hermes-desktop");
    expect(toWslPath("C:/Users/example/Desktop")).toBe("/mnt/c/Users/example/Desktop");
  });

  it("converts WSL UNC paths", () => {
    expect(toWslPath("\\\\wsl$\\Ubuntu\\home\\example\\Hermes Agent")).toBe("/home/example/Hermes Agent");
  });

  it("keeps Linux paths unchanged", () => {
    expect(toWslPath("/home/example/Hermes Agent")).toBe("/home/example/Hermes Agent");
    expect(toWslPath("/mnt/d/Projects/hermes-desktop")).toBe("/mnt/d/Projects/hermes-desktop");
  });
});

describe("HermesCliAdapter reply cleanup", () => {
  it("removes WSL environment dumps from displayable replies", () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as { normalizeReply(reply: string): string };

    expect(adapter.normalizeReply([
      "SHELL=/bin/bash WSL2_GUI_APPS_ENABLED=1 WSL_DISTRO_NAME=Ubuntu-24.04-Fresh NAME=DESKTOP",
      "PWD=/root/Hermes-Agent LOGNAME=root HOME=/root",
      "PATH=/usr/local/sbin:/usr/local/bin:/mnt/c/Program Files/nodejs",
      "我现在运行在 WSL Ubuntu-24.04-Fresh，当前目录是 /root/Hermes-Agent。",
    ].join("\n"))).toBe("我现在运行在 WSL Ubuntu-24.04-Fresh，当前目录是 /root/Hermes-Agent。");
  });

  it("removes CLI session lifecycle lines from displayable replies", () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      normalizeReply(reply: string): string;
      extractSessionId(lines: string[]): string | undefined;
    };

    const lifecycleLine = "Resumed session 20260424_121414_49cda7 (2 user messages, 4 total messages)";
    expect(adapter.normalizeReply([
      lifecycleLine,
      "已经继续上次会话，我会接着处理。",
    ].join("\n"))).toBe("已经继续上次会话，我会接着处理。");
    expect(adapter.extractSessionId([lifecycleLine])).toBe("20260424_121414_49cda7");
  });

  it("extracts the controlled headless runner result without leaking markers", () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as { extractDirectReply(lines: string[]): string };

    expect(adapter.extractDirectReply([
      "debug noise",
      "__HERMES_FORGE_RESULT_START__",
      "当前模型是 gpt-5.4。",
      "__HERMES_FORGE_RESULT_END__",
    ])).toBe("当前模型是 gpt-5.4。");
  });
});

describe("HermesCliAdapter prompt isolation", () => {
  it("keeps internal instructions outside the user query for headless runs", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-adapter-"));
    const adapter = new HermesCliAdapter(
      {
        baseDir: () => baseDir,
        hermesDir: () => path.join(baseDir, "hermes"),
      } as never,
      {} as never,
      async () => "C:\\Hermes Agent",
    );

    const invocation = await (adapter as never as {
      headlessInvocation(
        rootPath: string,
        runtime: { mode: "windows"; windowsAgentMode?: "hermes_native" },
        prompt: { systemPrompt: string; userPrompt: string },
        request: { conversationId: string; sessionId: string },
        source: string,
      ): Promise<{ args: string[]; cleanup?: () => Promise<void> }>;
    }).headlessInvocation(
      "C:\\Hermes Agent",
      { mode: "windows", windowsAgentMode: "hermes_native" },
      { systemPrompt: "内部规则：不要泄露。", userPrompt: "浙江金华" },
      { conversationId: "chat-session", sessionId: "task-run" },
      "test",
    );

    const queryPath = invocation.args[invocation.args.indexOf("--query-file") + 1];
    const systemPath = invocation.args[invocation.args.indexOf("--system-file") + 1];
    expect(invocation.args).toContain("--system-file");
    expect(invocation.args.slice(invocation.args.indexOf("--session-id"), invocation.args.indexOf("--session-id") + 2)).toEqual(["--session-id", "chat-session"]);
    await expect(fs.readFile(queryPath, "utf8")).resolves.toBe("浙江金华");
    await expect(fs.readFile(systemPath, "utf8")).resolves.toBe("内部规则：不要泄露。");
    await invocation.cleanup?.();
  });

  it("converts headless runner files for WSL and keeps the workbench session id stable", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-adapter-"));
    const adapter = new HermesCliAdapter(
      {
        baseDir: () => baseDir,
        hermesDir: () => path.join(baseDir, "hermes"),
      } as never,
      {} as never,
      async () => "C:\\Hermes Agent",
    );

    const invocation = await (adapter as never as {
      headlessInvocation(
        rootPath: string,
        runtime: { mode: "wsl"; distro?: string; pythonCommand?: string; windowsAgentMode?: "hermes_native" },
        prompt: { systemPrompt: string; userPrompt: string },
        request: { conversationId: string; sessionId: string },
        source: string,
      ): Promise<{ args: string[]; cleanup?: () => Promise<void> }>;
    }).headlessInvocation(
      "/mnt/c/Hermes Agent",
      { mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native" },
      { systemPrompt: "内部规则", userPrompt: "继续上文" },
      { conversationId: "session-stable", sessionId: "task-run" },
      "test",
    );

    expect(invocation.args).toContain("--session-id");
    expect(invocation.args.slice(invocation.args.indexOf("--session-id"), invocation.args.indexOf("--session-id") + 2)).toEqual(["--session-id", "session-stable"]);
    expect(invocation.args[0]).toMatch(/^\/mnt\//);
    expect(invocation.args[invocation.args.indexOf("--query-file") + 1]).toMatch(/^\/mnt\//);
    await invocation.cleanup?.();
  });

  it("adds recent workbench turns to the system context", () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      budgeter: { summarizeToBudget(text: string): string };
      conversationHistoryPrompt(request: {
        conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
      }): string;
    };
    adapter.budgeter = { summarizeToBudget: (text: string) => text };

    expect(adapter.conversationHistoryPrompt({
      conversationHistory: [
        { role: "user", content: "我的名字是小夏" },
        { role: "assistant", content: "好的，我记住了。" },
      ],
    })).toContain("用户：我的名字是小夏");
  });

  it("does not inject desktop memory, history, attachment text, or context bundles into WSL prompts", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-adapter-"));
    const adapter = new HermesCliAdapter(
      {
        baseDir: () => baseDir,
        hermesDir: () => path.join(baseDir, "hermes"),
      } as never,
      { summarizeToBudget: (text: string) => text } as never,
      async () => "C:\\Hermes Agent",
    );

    const prompt = await (adapter as never as {
      buildPrompt(
        request: {
          sessionId: string;
          workspaceId: string;
          workspacePath: string;
          userInput: string;
          taskType: "custom";
          selectedFiles: string[];
          attachments: Array<{ id: string; name: string; path: string; originalPath: string; kind: "file"; size: number; createdAt: string }>;
          memoryPolicy: "isolated";
          conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
          contextBundle: { summary: string };
          permissions: { workspaceRead: boolean; fileWrite: boolean; commandRun: boolean; memoryRead: boolean; contextBridge: boolean };
        },
        runtime: { mode: "wsl"; pythonCommand: string; windowsAgentMode: "hermes_native"; cliPermissionMode: "guarded" },
        strategy?: unknown,
        sessionPlan?: unknown,
        cliCapabilities?: {
          probed: boolean;
          support: "native";
          transport: "native-arg-env";
          cliVersion: string;
          supportsLaunchMetadataArg: boolean;
          supportsLaunchMetadataEnv: boolean;
          supportsResume: boolean;
          minimumSatisfied: boolean;
          missing: string[];
          probeCommand: string;
        },
      ): Promise<{ systemPrompt: string; userPrompt: string; launchMetadata?: { metadataPath: string; metadataRuntimePath: string; env: Record<string, string>; metadata: { selectedFilePaths: Array<{ runtimePath: string }>; attachmentPaths: Array<{ runtimePath: string }> } }; queryContext?: string[] }>;
    }).buildPrompt(
      {
        sessionId: "task",
        workspaceId: "workspace",
        workspacePath: "D:\\repo",
        userInput: "继续",
        taskType: "custom",
        selectedFiles: ["D:\\repo\\src\\app.ts"],
        attachments: [{
          id: "a1",
          name: "notes.md",
          path: "D:\\repo\\.sessions\\notes.md",
          originalPath: "D:\\notes.md",
          kind: "file",
          size: 100,
          createdAt: "now",
        }],
        memoryPolicy: "isolated",
        conversationHistory: [{ role: "user", content: "我的名字是小夏" }],
        contextBundle: { summary: "桌面端上下文摘要" },
        permissions: { workspaceRead: true, fileWrite: true, commandRun: true, memoryRead: true, contextBridge: true },
      },
      { mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native", cliPermissionMode: "guarded" },
      undefined,
      undefined,
      {
        probed: true,
        support: "native",
        transport: "native-arg-env",
        cliVersion: "0.10.0",
        supportsLaunchMetadataArg: true,
        supportsLaunchMetadataEnv: true,
        supportsResume: true,
        minimumSatisfied: true,
        missing: [],
        probeCommand: "capabilities --json",
      },
    );

    expect(prompt.systemPrompt).toBe("");
    expect(prompt.systemPrompt).not.toContain("/mnt/d/repo/src/app.ts");
    expect(prompt.systemPrompt).not.toContain("/mnt/d/repo/.sessions/notes.md");
    expect(prompt.systemPrompt).not.toContain("我的名字是小夏");
    expect(prompt.systemPrompt).not.toContain("桌面端上下文摘要");
    expect(prompt.systemPrompt).not.toContain("附件内容");
    expect(prompt.queryContext).toEqual([]);
    expect(prompt.launchMetadata?.metadata.selectedFilePaths[0]?.runtimePath).toBe("/mnt/d/repo/src/app.ts");
    expect(prompt.launchMetadata?.metadata.attachmentPaths[0]?.runtimePath).toBe("/mnt/d/repo/.sessions/notes.md");
    expect(prompt.launchMetadata?.env.HERMES_FORGE_LAUNCH_METADATA).toMatch(/launch-/);
    expect(prompt.userPrompt).toBe("继续");
  });

  it("removes the metadata pointer from WSL query when the CLI supports native launch metadata", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-adapter-"));
    const adapter = new HermesCliAdapter(
      {
        baseDir: () => baseDir,
        hermesDir: () => path.join(baseDir, "hermes"),
      } as never,
      { summarizeToBudget: (text: string) => text } as never,
      async () => "C:\\Hermes Agent",
    );

    const prompt = await (adapter as never as {
      buildPrompt(
        request: {
          sessionId: string;
          workspaceId: string;
          workspacePath: string;
          userInput: string;
          taskType: "custom";
          selectedFiles: string[];
          memoryPolicy: "isolated";
          permissions: { workspaceRead: boolean; fileWrite: boolean; commandRun: boolean; memoryRead: boolean; contextBridge: boolean };
        },
        runtime: { mode: "wsl"; pythonCommand: string; windowsAgentMode: "hermes_native"; cliPermissionMode: "guarded" },
        strategy: unknown,
        sessionPlan: unknown,
        cliCapabilities: {
          probed: boolean;
          support: "native";
          transport: "native-arg-env";
          cliVersion: string;
          supportsLaunchMetadataArg: boolean;
          supportsLaunchMetadataEnv: boolean;
          supportsResume: boolean;
          minimumSatisfied: boolean;
          missing: string[];
          probeCommand: string;
        },
      ): Promise<{ systemPrompt: string; userPrompt: string; launchMetadataTransport?: string; queryContext?: string[] }>;
    }).buildPrompt(
      {
        sessionId: "task",
        workspaceId: "workspace",
        workspacePath: "D:\\repo",
        userInput: "继续",
        taskType: "custom",
        selectedFiles: ["D:\\repo\\src\\app.ts"],
        memoryPolicy: "isolated",
        permissions: { workspaceRead: true, fileWrite: true, commandRun: true, memoryRead: true, contextBridge: true },
      },
      { mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native", cliPermissionMode: "guarded" },
      undefined,
      undefined,
      {
        probed: true,
        support: "native",
        transport: "native-arg-env",
        cliVersion: "0.10.0",
        supportsLaunchMetadataArg: true,
        supportsLaunchMetadataEnv: true,
        supportsResume: true,
        minimumSatisfied: true,
        missing: [],
        probeCommand: "capabilities --json",
      },
    );

    expect(prompt.systemPrompt).toBe("");
    expect(prompt.queryContext).toEqual([]);
    expect(prompt.launchMetadataTransport).toBe("native-arg-env");
    expect(prompt.userPrompt).toBe("继续");
  });
});

describe("HermesCliAdapter WSL permission mode", () => {
  it("uses yolo CLI mode by default and passes --yolo", async () => {
    const adapter = new HermesCliAdapter({ baseDir: () => os.tmpdir(), hermesDir: () => os.tmpdir() } as never, {} as never, async () => "C:\\Hermes Agent");
    const invocation = await (adapter as never as {
      conversationInvocation(
        rootPath: string,
        runtime: { mode: "wsl"; pythonCommand: string; windowsAgentMode: "hermes_native" },
        prompt: { systemPrompt: string; userPrompt: string },
        workspacePath: string,
        request: { workspacePath: string; selectedFiles: unknown[] },
        source: string,
      ): Promise<{ args: string[]; permissionMode?: string }>;
    }).conversationInvocation(
      "/mnt/c/Hermes Agent",
      { mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native" },
      { systemPrompt: "system", userPrompt: "hello" },
      "D:\\repo",
      { workspacePath: "D:\\repo", selectedFiles: [] },
      "test",
    );

    expect(invocation.permissionMode).toBe("yolo");
    expect(invocation.args).toContain("--yolo");
  });

  it("passes --yolo only when the runtime config explicitly selects yolo", async () => {
    const adapter = new HermesCliAdapter({ baseDir: () => os.tmpdir(), hermesDir: () => os.tmpdir() } as never, {} as never, async () => "C:\\Hermes Agent");
    const invocation = await (adapter as never as {
      conversationInvocation(
        rootPath: string,
        runtime: { mode: "wsl"; pythonCommand: string; windowsAgentMode: "hermes_native"; cliPermissionMode: "yolo" },
        prompt: { systemPrompt: string; userPrompt: string },
        workspacePath: string,
        request: { workspacePath: string; selectedFiles: unknown[] },
        source: string,
      ): Promise<{ args: string[]; permissionMode?: string }>;
    }).conversationInvocation(
      "/mnt/c/Hermes Agent",
      { mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native", cliPermissionMode: "yolo" },
      { systemPrompt: "system", userPrompt: "hello" },
      "D:\\repo",
      { workspacePath: "D:\\repo", selectedFiles: [] },
      "test",
    );

    expect(invocation.permissionMode).toBe("yolo");
    expect(invocation.args).toContain("--yolo");
  });

  it("passes --resume when a CLI session plan is available", async () => {
    const adapter = new HermesCliAdapter({ baseDir: () => os.tmpdir(), hermesDir: () => os.tmpdir() } as never, {} as never, async () => "C:\\Hermes Agent");
    const invocation = await (adapter as never as {
      conversationInvocation(
        rootPath: string,
        runtime: { mode: "wsl"; pythonCommand: string; windowsAgentMode: "hermes_native"; cliPermissionMode: "guarded" },
        prompt: { systemPrompt: string; userPrompt: string },
        workspacePath: string,
        request: { workspacePath: string; selectedFiles: unknown[] },
        source: string,
        strategy: { mode: "guarded"; cliArgs: string[]; source: "runtime-config"; description: string },
        sessionPlan: { status: "resumed"; cliSource: string; cliSessionId: string; resumeArgs: string[] },
      ): Promise<{ args: string[]; permissionMode?: string; sessionPlan?: { status: string; cliSessionId?: string } }>;
    }).conversationInvocation(
      "/mnt/c/Hermes Agent",
      { mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native", cliPermissionMode: "guarded" },
      { systemPrompt: "", userPrompt: "hello" },
      "D:\\repo",
      { workspacePath: "D:\\repo", selectedFiles: [] },
      "test",
      { mode: "guarded", cliArgs: [], source: "runtime-config", description: "guarded" },
      { status: "resumed", cliSource: "test", cliSessionId: "20260423_010203_abcdef", resumeArgs: ["--resume", "20260423_010203_abcdef"] },
    );

    expect(invocation.args).toEqual(expect.arrayContaining(["--resume", "20260423_010203_abcdef"]));
    expect(invocation.sessionPlan).toMatchObject({ status: "resumed", cliSessionId: "20260423_010203_abcdef" });
  });

  it("passes native --launch-metadata when supported", async () => {
    const adapter = new HermesCliAdapter({ baseDir: () => os.tmpdir(), hermesDir: () => os.tmpdir() } as never, {} as never, async () => "C:\\Hermes Agent");
    const invocation = await (adapter as never as {
      conversationInvocation(
        rootPath: string,
        runtime: { mode: "wsl"; pythonCommand: string; windowsAgentMode: "hermes_native"; cliPermissionMode: "guarded" },
        prompt: { systemPrompt: string; userPrompt: string; launchMetadata: { metadataRuntimePath: string; env: Record<string, string>; metadataPath: string } },
        workspacePath: string,
        request: { workspacePath: string; selectedFiles: unknown[] },
        source: string,
        strategy: { mode: "guarded"; cliArgs: string[]; source: "runtime-config"; description: string },
        sessionPlan: undefined,
        cliCapabilities: {
          probed: boolean;
          support: "native";
          transport: "native-arg-env";
          cliVersion: string;
          supportsLaunchMetadataArg: boolean;
          supportsLaunchMetadataEnv: boolean;
          supportsResume: boolean;
          minimumSatisfied: boolean;
          missing: string[];
          probeCommand: string;
        },
      ): Promise<{ args: string[]; env?: NodeJS.ProcessEnv }>;
    }).conversationInvocation(
      "/mnt/c/Hermes Agent",
      { mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native", cliPermissionMode: "guarded" },
      {
        systemPrompt: "",
        userPrompt: "hello",
        launchMetadata: {
          metadataRuntimePath: "/mnt/c/tmp/launch.json",
          metadataPath: "C:\\tmp\\launch.json",
          env: { HERMES_FORGE_LAUNCH_METADATA: "/mnt/c/tmp/launch.json" },
        },
      },
      "D:\\repo",
      { workspacePath: "D:\\repo", selectedFiles: [] },
      "test",
      { mode: "guarded", cliArgs: [], source: "runtime-config", description: "guarded" },
      undefined,
      {
        probed: true,
        support: "native",
        transport: "native-arg-env",
        cliVersion: "0.10.0",
        supportsLaunchMetadataArg: true,
        supportsLaunchMetadataEnv: true,
        supportsResume: true,
        minimumSatisfied: true,
        missing: [],
        probeCommand: "capabilities --json",
      },
    );

    expect(invocation.args).toEqual(expect.arrayContaining(["--launch-metadata", "/mnt/c/tmp/launch.json"]));
    expect(invocation.args.join("\n")).not.toContain("Forge launch metadata");
    expect(invocation.env).toMatchObject({ HERMES_FORGE_LAUNCH_METADATA: "/mnt/c/tmp/launch.json" });
  });

  it("persists the observed CLI session id for the Forge session", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-adapter-"));
    const adapter = new HermesCliAdapter(
      {
        baseDir: () => baseDir,
        hermesDir: () => path.join(baseDir, "hermes-home"),
        sessionDir: (sessionId: string) => path.join(baseDir, "sessions", sessionId),
      } as never,
      {} as never,
      async () => "C:\\Hermes Agent",
    );

    await (adapter as never as {
      updateCliSessionMapping(
        plan: {
          forgeSessionId: string;
          status: "fresh";
          cliSource: string;
          mappingPath: string;
          cliStateDbPath: string;
          cliStateDbRuntimePath: string;
          resumeArgs: string[];
        },
        observedSessionId: string,
        request: { sessionId: string; workspacePath: string },
      ): Promise<void>;
    }).updateCliSessionMapping(
      {
        forgeSessionId: "session-stable",
        status: "fresh",
        cliSource: "test",
        mappingPath: path.join(baseDir, "sessions", "session-stable", "hermes-cli-session.json"),
        cliStateDbPath: path.join(baseDir, "hermes-home", "state.db"),
        cliStateDbRuntimePath: "/mnt/c/state.db",
        resumeArgs: [],
      },
      "20260423_010203_abcdef",
      { sessionId: "task-run", workspacePath: "D:\\repo" },
    );

    const raw = await fs.readFile(path.join(baseDir, "sessions", "session-stable", "hermes-cli-session.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      forgeSessionId: "session-stable",
      cliSessionId: "20260423_010203_abcdef",
      lastTaskRunId: "task-run",
      lastStatus: "fresh",
    });
  });
});

describe("HermesCliAdapter WSL env", () => {
  it("rewrites localhost model URLs to the Windows host reachable from WSL", () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      rewriteLocalhostModelUrls(env: NodeJS.ProcessEnv, host: string): NodeJS.ProcessEnv;
    };

    expect(adapter.rewriteLocalhostModelUrls({
      OPENAI_BASE_URL: "http://127.0.0.1:8081/v1",
      AI_BASE_URL: "http://localhost:8081/v1",
      ANTHROPIC_BASE_URL: "https://example.com/v1",
    }, "172.17.160.1")).toMatchObject({
      OPENAI_BASE_URL: "http://172.17.160.1:8081/v1",
      AI_BASE_URL: "http://172.17.160.1:8081/v1",
      ANTHROPIC_BASE_URL: "https://example.com/v1",
    });
  });
});

describe("HermesCliAdapter WSL permission policy", () => {
  it("marks WSL shell, file, git, and network as not enforceable by desktop", () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      permissionBoundaryAudit(
        runtime: { mode: "wsl"; permissionPolicy: "bridge_guarded"; windowsAgentMode: "hermes_native" },
        request: { permissions: { contextBridge: boolean } },
      ): { policy: string; hardEnforceable: Record<string, string>; notEnforceableYet: Record<string, string>; enforcementMismatch: boolean };
    };

    const audit = adapter.permissionBoundaryAudit(
      { mode: "wsl", permissionPolicy: "bridge_guarded", windowsAgentMode: "hermes_native" },
      { permissions: { contextBridge: true } },
    );

    expect(audit.policy).toBe("bridge_guarded");
    expect(audit.hardEnforceable.windowsBridgeTools).toContain("bridge token");
    expect(audit.notEnforceableYet).toMatchObject({
      shell: expect.stringContaining("not hard-blocked"),
      fileReadWrite: expect.stringContaining("not limited to workspace"),
      git: expect.stringContaining("not hard-blocked"),
      network: expect.stringContaining("not sandboxed"),
    });
    expect(audit.enforcementMismatch).toBe(false);
  });

  it("blocks restricted_workspace because WSL workspace isolation is not enforceable yet", () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      permissionBoundaryAudit(
        runtime: { mode: "wsl"; permissionPolicy: "restricted_workspace"; windowsAgentMode: "hermes_native" },
        request: { permissions: { contextBridge: boolean } },
      ): { policy: string; enforcementMismatch: boolean; mismatchReasons: string[] };
      permissionPolicyBlockReason(
        runtime: { mode: "wsl"; permissionPolicy: "restricted_workspace"; windowsAgentMode: "hermes_native" },
        audit: { policy: string; enforcementMismatch: boolean; mismatchReasons: string[]; hardEnforceable?: unknown; notEnforceableYet?: unknown },
      ): { code: string; summary: string; debugContext: Record<string, unknown> } | undefined;
    };

    const runtime = { mode: "wsl" as const, permissionPolicy: "restricted_workspace" as const, windowsAgentMode: "hermes_native" as const };
    const audit = adapter.permissionBoundaryAudit(runtime, { permissions: { contextBridge: true } });
    const block = adapter.permissionPolicyBlockReason(runtime, audit);

    expect(audit.enforcementMismatch).toBe(true);
    expect(block).toMatchObject({
      code: "policy_not_enforceable",
      summary: "当前权限策略无法被真实执行",
    });
    expect(block?.debugContext).toMatchObject({
      policy: "restricted_workspace",
      runtimeMode: "wsl",
      enforcementMismatch: true,
    });
  });
});

describe("HermesCliAdapter Windows launch", () => {
  it("uses a hidden non-detached process for Windows CLI runs", async () => {
    const adapter = new HermesCliAdapter(
      { hermesDir: () => "C:\\Users\\example\\AppData\\Roaming\\Hermes Forge\\hermes" } as never,
      {} as never,
      async () => "C:\\Users\\example\\Hermes Agent",
      async () => ({
        hermesRuntime: {
          mode: "windows",
          pythonCommand: "python3",
          windowsAgentMode: "hermes_native",
        },
        modelProfiles: [],
      } as never),
    );

    const launch = await (adapter as never as {
      launchSpec(
        runtime: { mode: "windows"; pythonCommand: string; windowsAgentMode: "hermes_native" },
        rootPath: string,
        pythonArgs: string[],
        cwd: string,
      ): Promise<{ detached: boolean; env: NodeJS.ProcessEnv }>;
      windowsPython?: Promise<{ command: string; argsPrefix: string[] }>;
    }).launchSpec(
      { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" },
      "C:\\Users\\example\\Hermes Agent",
      ["C:\\Users\\example\\Hermes Agent\\hermes", "--version"],
      "C:\\Users\\example\\Hermes Agent",
    );

    expect(launch.detached).toBe(false);
    expect(launch.env).toMatchObject({
      CI: "1",
      FORCE_COLOR: "0",
      PROMPT_TOOLKIT_NO_CPR: "1",
      PROMPT_TOOLKIT_COLOR_DEPTH: "DEPTH_1_BIT",
      TERM: "dumb",
    });
  });

  it("uses the active Hermes profile for WSL HERMES_HOME and memory status", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-adapter-"));
    await fs.mkdir(path.join(baseDir, "hermes-home", "profiles", "wechat", "memories"), { recursive: true });
    await fs.writeFile(path.join(baseDir, "hermes-home", "active_profile"), "wechat", "utf8");
    await fs.writeFile(path.join(baseDir, "hermes-home", "profiles", "wechat", "memories", "USER.md"), "偏好：叫我小夏", "utf8");
    await fs.writeFile(path.join(baseDir, "hermes-home", "profiles", "wechat", "memories", "MEMORY.md"), "长期记忆：使用 WSL runtime", "utf8");
    const adapter = new HermesCliAdapter(
      { baseDir: () => baseDir, hermesDir: () => path.join(baseDir, "hermes-home") } as never,
      {} as never,
      async () => "C:\\Hermes Agent",
      async () => ({
        hermesRuntime: {
          mode: "wsl",
          pythonCommand: "python3",
          windowsAgentMode: "hermes_native",
        },
        modelProfiles: [],
      } as never),
    );

    const launch = await (adapter as never as {
      launchSpec(
        runtime: { mode: "wsl"; pythonCommand: string; windowsAgentMode: "hermes_native" },
        rootPath: string,
        pythonArgs: string[],
        cwd: string,
      ): Promise<{ args: string[] }>;
    }).launchSpec(
      { mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native" },
      "/mnt/c/Hermes Agent",
      ["/mnt/c/Hermes Agent/hermes", "--version"],
      "D:\\repo",
    );
    const status = await adapter.getMemoryStatus("workspace");

    expect(launch.args).toContain(`HERMES_HOME=${toWslPath(path.join(baseDir, "hermes-home", "profiles", "wechat"))}`);
    expect(status.filePath).toBe(path.join(baseDir, "hermes-home", "profiles", "wechat", "memories"));
    expect(status.entries).toBe(2);
  });
});
