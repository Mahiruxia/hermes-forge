import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../process/command-runner", () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from "../process/command-runner";
import { testModelConnection } from "./model-connection-service";

const runCommandMock = vi.mocked(runCommand);

function secretVault(overrides: Partial<{ hasSecret: (ref: string) => Promise<boolean>; readSecret: (ref: string) => Promise<string | undefined> }> = {}) {
  return {
    hasSecret: overrides.hasSecret ?? (async () => false),
    readSecret: overrides.readSecret ?? (async () => undefined),
  } as never;
}

function runtimeAdapterFactory(host = "172.20.96.1") {
  return (() => ({
    getBridgeAccessHost: async () => host,
    toRuntimePath: (input: string) => input.replace(/^([A-Za-z]):\\/, (_m, drive) => `/mnt/${String(drive).toLowerCase()}/`).replace(/\\/g, "/"),
    buildPythonLaunch: async (input: { pythonArgs: string[]; env: NodeJS.ProcessEnv; cwd: string }) => ({
      command: "wsl.exe",
      args: input.pythonArgs,
      cwd: input.cwd,
      env: input.env,
      detached: false,
    }),
  })) as never;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  runCommandMock.mockReset();
});

describe("model-connection-service", () => {
  it("does not treat Gemini OAuth as a normal API key provider", async () => {
    const result = await testModelConnection({
      draft: {
        sourceType: "gemini_oauth",
        model: "gemini-2.5-pro",
      },
      config: { modelProfiles: [], updateSources: {} } as never,
      secretVault: secretVault(),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(false);
    expect(result.sourceType).toBe("gemini_oauth");
    expect(result.failureCategory).toBe("manual_action_required");
    expect(result.message).toContain("Gemini OAuth");
  });

  it("detects custom endpoint tool calling failures and keeps it out of primary-agent role", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "my-model", context_length: 32000 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "plain text only" } }] }), { status: 200 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "my-model",
        maxTokens: 32000,
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault(),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(false);
    expect(result.failureCategory).toBe("tool_calling_unavailable");
    expect(result.agentRole).toBe("auxiliary_model");
    expect(result.healthChecks?.map((step) => step.id)).toEqual(expect.arrayContaining(["auth", "models", "chat", "agent_capability"]));
  });

  it("accepts manually typed OpenAI-compatible models when /models is unavailable", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not found" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] }), { status: 200 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "https://api.minimaxi.com/v1",
        model: "MiniMax-M2.7",
        maxTokens: 200000,
        secretRef: "secret:minimax",
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault({
        hasSecret: async () => true,
        readSecret: async () => "test-key",
      }),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(true);
    expect(result.normalizedBaseUrl).toBe("https://api.minimaxi.com/v1");
    expect(result.availableModels).toEqual([]);
    expect(result.healthChecks?.find((item) => item.id === "models")?.message).toContain("已跳过发现");
    expect(result.agentRole).toBe("primary_agent");
  });

  it.each([
    ["MiniMax", "https://api.minimaxi.com/v1", "MiniMax-M2.7"],
    ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
    ["DashScope/Qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
    ["Moonshot/Kimi", "https://api.moonshot.cn/v1", "kimi-k2"],
    ["Zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-4.6"],
    ["SiliconFlow", "https://api.siliconflow.cn/v1", "Qwen/Qwen3-Coder"],
    ["Volcengine", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1-6"],
    ["Tencent Hunyuan", "https://hunyuan.cloud.tencent.com/v1", "hunyuan-turbos-latest"],
  ])("accepts manually typed coding provider models when %s does not expose /models", async (_label, baseUrl, model) => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not found" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] }), { status: 200 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl,
        model,
        maxTokens: 256000,
        secretRef: "secret:compatible",
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault({
        hasSecret: async () => true,
        readSecret: async () => "test-key",
      }),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(true);
    expect(result.normalizedBaseUrl).toBe(baseUrl);
    expect(result.agentRole).toBe("primary_agent");
    expect(result.healthChecks?.find((item) => item.id === "models")?.message).toContain("已跳过发现");
  });

  it("still fails OpenAI-compatible model discovery on auth errors", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "https://api.minimaxi.com/v1",
        model: "MiniMax-M2.7",
        maxTokens: 200000,
        secretRef: "secret:minimax",
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault({
        hasSecret: async () => true,
        readSecret: async () => "bad-key",
      }),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(false);
    expect(result.failureCategory).toBe("auth_invalid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports WSL localhost reachability issues with a host-IP fix hint", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "my-model", context_length: 32000 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] }), { status: 200 }));
    runCommandMock
      .mockResolvedValueOnce({ exitCode: 2, stdout: "", stderr: "" } as never)
      .mockResolvedValueOnce({ exitCode: 2, stdout: "", stderr: "" } as never);

    const result = await testModelConnection({
      draft: {
        sourceType: "lm_studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "my-model",
        maxTokens: 32000,
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "wsl", pythonCommand: "python3", distro: "Ubuntu" } } as never,
      secretVault: secretVault(),
      runtimeAdapterFactory: runtimeAdapterFactory("172.20.96.1"),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(false);
    expect(result.failureCategory).toBe("wsl_unreachable");
    expect(result.recommendedFix).toContain("绑定到 0.0.0.0");
    expect(result.wslProbeUrl).toContain("172.20.96.1");
  });

  it("treats HTTP 4xx from WSL /models probe as reachable for OpenAI-compatible providers", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not found" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] }), { status: 200 }));
    runCommandMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" } as never);

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "https://api.minimaxi.com/v1",
        model: "MiniMax-M2.7",
        maxTokens: 200000,
        secretRef: "secret:minimax",
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "wsl", pythonCommand: "python3", distro: "Ubuntu" } } as never,
      secretVault: secretVault({
        hasSecret: async () => true,
        readSecret: async () => "test-key",
      }),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(true);
    expect(result.wslReachable).toBe(true);
    expect(result.wslProbeUrl).toBe("https://api.minimaxi.com/v1");
    expect(runCommandMock).toHaveBeenCalledTimes(1);
  });
});
