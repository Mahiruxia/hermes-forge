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

  it("uses streamed or direct CLI output without waiting for session files", async () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      cleanReply(lines: string[], startedAt: number, streamReplyLines?: string[]): Promise<string>;
      readSessionReplyWithRetry(sessionId: string): Promise<string>;
      readNewestSessionReply(startedAt: number): Promise<string>;
    };
    adapter.readSessionReplyWithRetry = async () => {
      throw new Error("session file lookup should not run when stdout already has a reply");
    };
    adapter.readNewestSessionReply = async () => {
      throw new Error("newest session lookup should not run when stdout already has a reply");
    };

    await expect(adapter.cleanReply(["OK", "session_id: 20260429_010203_abcdef"], Date.now())).resolves.toBe("OK");
  });
});

describe("HermesCliAdapter prompt isolation", () => {
  it("persists Windows Native conversation history for the runner", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-adapter-"));
    const adapter = new HermesCliAdapter(
      {
        baseDir: () => baseDir,
        hermesDir: () => path.join(baseDir, "hermes"),
        sessionDir: (sessionId: string) => path.join(baseDir, "sessions", sessionId),
      } as never,
      { summarizeToBudget: (text: string) => text } as never,
      async () => "C:\\Hermes Agent",
    );

    const historyPath = await (adapter as never as {
      writeWindowsAgentHistoryFile(request: {
        sessionId: string;
        conversationId?: string;
        conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
      }): Promise<string | undefined>;
    }).writeWindowsAgentHistoryFile({
      sessionId: "task-1",
      conversationId: "chat-1",
      conversationHistory: [
        { role: "user", content: "我的名字是小夏" },
        { role: "assistant", content: "我记住了。" },
        { role: "user", content: "   " },
      ],
    });

    expect(historyPath).toContain(path.join("sessions", "chat-1", "hermes-windows-agent"));
    const parsed = JSON.parse(await fs.readFile(historyPath!, "utf8"));
    expect(parsed).toEqual([
      { role: "user", content: "我的名字是小夏" },
      { role: "assistant", content: "我记住了。" },
    ]);
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
  it("routes MiniMax Token Plan through Hermes' MiniMax handler", async () => {
    const adapter = new HermesCliAdapter(
      { hermesDir: () => "C:\\Users\\example\\AppData\\Roaming\\Hermes Forge\\hermes" } as never,
      {} as never,
      async () => "C:\\Users\\example\\Hermes Agent",
      async () => ({ modelProfiles: [] } as never),
    );

    const args = (adapter as never as {
      providerArgs(request: { runtimeEnv?: { sourceType?: string } }): string[];
    }).providerArgs({ runtimeEnv: { sourceType: "minimax_token_plan_api_key" } });

    expect(args).toEqual(["--provider", "minimax-cn"]);
  });

  it("translates Coding Plan sourceType into a canonical Hermes provider name for env runners", () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      hermesProvider(provider: string, sourceType?: string): string;
    };

    expect(adapter.hermesProvider("custom", "kimi_coding_api_key")).toBe("kimi-coding");
    expect(adapter.hermesProvider("custom", "minimax_token_plan_api_key")).toBe("minimax-cn");
    expect(adapter.hermesProvider("custom", "mimo_token_plan_api_key")).toBe("xiaomi");
    expect(adapter.hermesProvider("custom", "zhipu_coding_api_key")).toBe("custom");
    expect(adapter.hermesProvider("custom", "dashscope_coding_api_key")).toBe("custom");
    expect(adapter.hermesProvider("custom", "tencent_token_plan_api_key")).toBe("custom");
    expect(adapter.hermesProvider("custom", "volcengine_coding_api_key")).toBe("custom");
    expect(adapter.hermesProvider("custom", undefined)).toBe("custom");
    // 老的 provider-only 翻译保持不变。
    expect(adapter.hermesProvider("openai")).toBe("openai");
    expect(adapter.hermesProvider("copilot_acp")).toBe("copilot-acp");
  });

  it("does not pass unsupported Coding Plan providers to Hermes CLI --provider", () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      providerArgs(request: { runtimeEnv?: { provider: string; sourceType?: string; model: string; baseUrl?: string; env?: Record<string, string> } }): string[];
    };
    const unsupportedSourceTypes = [
      "zhipu_coding_api_key",
      "dashscope_coding_api_key",
      "baidu_qianfan_coding_api_key",
      "tencent_token_plan_api_key",
      "tencent_hunyuan_token_plan_api_key",
      "volcengine_coding_api_key",
    ];

    for (const sourceType of unsupportedSourceTypes) {
      expect(adapter.providerArgs({
        runtimeEnv: {
          provider: "custom",
          sourceType,
          model: "coding-model",
          baseUrl: "https://example.com/v1",
          env: {},
        },
      })).toEqual([]);
    }
  });

  it("propagates HERMES_INFERENCE_PROVIDER from sourceType for Coding Plan profiles in hermesEnv", async () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      activeHermesHome(): Promise<string>;
      hermesEnv(
        rootPath: string,
        runtime: { mode: "windows" },
        request: { runtimeEnv: { provider: string; sourceType?: string; model: string; baseUrl?: string; env?: Record<string, string> } },
      ): Promise<NodeJS.ProcessEnv>;
    };
    adapter.activeHermesHome = async () => "C:\\Users\\example\\Hermes Agent";

    const env = await adapter.hermesEnv(
      "C:\\Users\\example\\Hermes Agent",
      { mode: "windows" },
      {
        runtimeEnv: {
          provider: "custom",
          sourceType: "kimi_coding_api_key",
          model: "kimi-for-coding",
          baseUrl: "https://api.kimi.com/coding/v1",
          env: {
            AI_PROVIDER: "custom",
            AI_MODEL: "kimi-for-coding",
            OPENAI_BASE_URL: "https://api.kimi.com/coding/v1",
            OPENAI_API_KEY: "sk-test",
            KIMI_API_KEY: "sk-test",
          },
        },
      },
    );

    expect(env.HERMES_INFERENCE_PROVIDER).toBe("kimi-coding");
    expect(env.OPENAI_MODEL).toBe("kimi-for-coding");
    expect(env.OPENAI_API_KEY).toBe("sk-test");
  });

  it("infers MiMo Token Plan endpoints as Xiaomi and normalizes model casing for CLI launch", async () => {
    const adapter = Object.create(HermesCliAdapter.prototype) as {
      activeHermesHome(): Promise<string>;
      providerArgs(request: { runtimeEnv?: { provider: string; sourceType?: string; model: string; baseUrl?: string; env?: Record<string, string> } }): string[];
      modelArgs(request: { runtimeEnv?: { provider: string; sourceType?: string; model: string; baseUrl?: string; env?: Record<string, string> } }): string[];
      hermesEnv(
        rootPath: string,
        runtime: { mode: "windows" },
        request: { runtimeEnv: { provider: string; sourceType?: string; model: string; baseUrl?: string; env?: Record<string, string> } },
      ): Promise<NodeJS.ProcessEnv>;
    };
    adapter.activeHermesHome = async () => "C:\\Users\\example\\Hermes Agent";
    const runtimeEnv = {
      provider: "custom",
      sourceType: "openai_compatible",
      model: "MiMo-V2.5-Pro",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      env: {
        AI_MODEL: "MiMo-V2.5-Pro",
        OPENAI_MODEL: "MiMo-V2.5-Pro",
        XIAOMI_BASE_URL: "https://token-plan-cn.xiaomimimo.com/v1",
        XIAOMI_API_KEY: "sk-test",
      },
    };

    expect(adapter.providerArgs({ runtimeEnv })).toEqual(["--provider", "xiaomi"]);
    expect(adapter.modelArgs({ runtimeEnv })).toEqual(["--model", "mimo-v2.5-pro"]);

    const env = await adapter.hermesEnv(
      "C:\\Users\\example\\Hermes Agent",
      { mode: "windows" },
      { runtimeEnv },
    );
    expect(env.HERMES_INFERENCE_PROVIDER).toBe("xiaomi");
    expect(env.OPENAI_MODEL).toBe("mimo-v2.5-pro");
    expect(env.AI_MODEL).toBe("mimo-v2.5-pro");
    expect(env.XIAOMI_BASE_URL).toBe("https://token-plan-cn.xiaomimimo.com/v1");
  });

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

  it("uses the active Hermes profile for Windows HERMES_HOME and memory status", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-adapter-"));
    await fs.mkdir(path.join(baseDir, "hermes-home", "profiles", "wechat", "memories"), { recursive: true });
    await fs.writeFile(path.join(baseDir, "hermes-home", "active_profile"), "wechat", "utf8");
    await fs.writeFile(path.join(baseDir, "hermes-home", "profiles", "wechat", "memories", "USER.md"), "偏好：叫我小夏", "utf8");
    await fs.writeFile(path.join(baseDir, "hermes-home", "profiles", "wechat", "memories", "MEMORY.md"), "长期记忆：使用 Windows runtime", "utf8");
    const adapter = new HermesCliAdapter(
      { baseDir: () => baseDir, hermesDir: () => path.join(baseDir, "hermes-home") } as never,
      {} as never,
      async () => "C:\\Hermes Agent",
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
      ): Promise<{ env?: NodeJS.ProcessEnv }>;
    }).launchSpec(
      { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" },
      "C:\\Hermes Agent",
      ["C:\\Hermes Agent\\hermes", "--version"],
      "D:\\repo",
    );
    const status = await adapter.getMemoryStatus("workspace");

    expect(launch.env?.HERMES_HOME).toBe(path.join(baseDir, "hermes-home", "profiles", "wechat"));
    expect(status.filePath).toBe(path.join(baseDir, "hermes-home", "profiles", "wechat", "memories"));
    expect(status.entries).toBe(2);
  });
});

describe("HermesCliAdapter pre-startup model sync", () => {
  it("invokes HermesModelSyncService.syncRuntimeConfig with the current runtime config", async () => {
    const calls: unknown[] = [];
    const stubSync = {
      syncRuntimeConfig: async (config: unknown) => {
        calls.push(config);
        return {
          ok: true,
          synced: true,
          profileId: "kimi-coding",
          model: "kimi-for-coding",
          provider: "kimi-coding",
          configPath: "/tmp/config.yaml",
          envPath: "/tmp/.env",
        };
      },
    };
    const runtimeConfig = {
      defaultModelProfileId: "kimi-coding",
      modelRoleAssignments: { chat: "kimi-coding" },
      modelProfiles: [
        { id: "kimi-coding", provider: "custom", sourceType: "kimi_coding_api_key", model: "kimi-for-coding", baseUrl: "https://api.kimi.com/coding/v1" },
      ],
      updateSources: {},
    };
    const adapter = new HermesCliAdapter(
      { hermesDir: () => os.tmpdir() } as never,
      {} as never,
      async () => "C:\\Hermes Agent",
      async () => runtimeConfig as never,
      undefined,
      () => stubSync as never,
    );

    const result = await (adapter as never as {
      syncHermesModelEnv(): Promise<{ ok: boolean; synced?: boolean; profileId?: string } | undefined>;
    }).syncHermesModelEnv();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(runtimeConfig);
    expect(result?.ok).toBe(true);
    expect(result?.synced).toBe(true);
    expect(result?.profileId).toBe("kimi-coding");
  });

  it("returns undefined when no sync service is provided (legacy adapter wiring)", async () => {
    const adapter = new HermesCliAdapter(
      { hermesDir: () => os.tmpdir() } as never,
      {} as never,
      async () => "C:\\Hermes Agent",
      async () => ({ modelProfiles: [], updateSources: {} } as never),
    );

    const result = await (adapter as never as {
      syncHermesModelEnv(): Promise<unknown>;
    }).syncHermesModelEnv();

    expect(result).toBeUndefined();
  });

  it("captures sync errors so the chat session can still continue", async () => {
    const stubSync = {
      syncRuntimeConfig: async () => {
        throw new Error("filesystem busy");
      },
    };
    const adapter = new HermesCliAdapter(
      { hermesDir: () => os.tmpdir() } as never,
      {} as never,
      async () => "C:\\Hermes Agent",
      async () => ({ modelProfiles: [], updateSources: {} } as never),
      undefined,
      () => stubSync as never,
    );

    const result = await (adapter as never as {
      syncHermesModelEnv(): Promise<{ ok: boolean; error?: string } | undefined>;
    }).syncHermesModelEnv();

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("filesystem busy");
  });
});
