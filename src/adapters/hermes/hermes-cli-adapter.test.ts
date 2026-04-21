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
        prompt: { systemPrompt: string; userPrompt: string },
        request: { conversationId: string; sessionId: string },
        source: string,
      ): Promise<{ args: string[]; cleanup?: () => Promise<void> }>;
    }).headlessInvocation(
      "C:\\Hermes Agent",
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

describe("HermesCliAdapter Windows launch", () => {
  it("uses a detached hidden console session for Windows CLI runs", async () => {
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

    expect(launch.detached).toBe(true);
    expect(launch.env).toMatchObject({
      CI: "1",
      FORCE_COLOR: "0",
      PROMPT_TOOLKIT_NO_CPR: "1",
      PROMPT_TOOLKIT_COLOR_DEPTH: "DEPTH_1_BIT",
      TERM: "dumb",
    });
  });
});
