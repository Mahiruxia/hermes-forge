import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../process/command-runner", () => ({
  runCommand: vi.fn(),
}));

import { runCommand } from "../process/command-runner";
import { defaultProviderRegistry } from "./model-providers/registry";
import { inferSourceType, testModelConnection } from "./model-connection-service";

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
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "plain text only" } }] }), { status: 200 }));

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
    expect(result.healthChecks?.find((step) => step.id === "agent_capability")?.detail).toContain("标准 tools + required");
  });

  it("accepts OpenAI-compatible tool calling when only required mode works", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "my-model", context_length: 32000 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }] } }] }), { status: 200 }));

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

    expect(result.ok).toBe(true);
    expect(result.supportsTools).toBe(true);
    expect(result.healthChecks?.find((step) => step.id === "agent_capability")?.detail).toContain("通过：标准 tools + required");
  });

  it("accepts legacy OpenAI-compatible function_call responses", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "legacy-model", context_length: 32000 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { function_call: { name: "ping", arguments: "{}" } } }] }), { status: 200 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "legacy-model",
        maxTokens: 32000,
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault(),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(true);
    expect(result.supportsTools).toBe(true);
    expect(result.message).toContain("tool calling");
    expect(result.healthChecks?.find((step) => step.id === "agent_capability")?.detail).toContain("旧版 functions + function_call");
  });

  it("stops tool-calling probes on HTTP 429 to avoid burning relay quota", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "relay-model", context_length: 32000 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "触发限额（每小时额度）上游 429" }), { status: 429 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "https://relay.example.com/v1",
        model: "relay-model",
        maxTokens: 32000,
        secretRef: "secret:relay",
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault({
        hasSecret: async () => true,
        readSecret: async () => "test-key",
      }),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(false);
    expect(result.failureCategory).toBe("tool_calling_unavailable");
    expect(result.message).toContain("HTTP 429");
    expect(result.recommendedFix).toContain("小时额度");
    expect(result.healthChecks?.find((step) => step.id === "agent_capability")?.detail).toContain("触发限额");
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  it("uses chat as the source of truth when /models omits a manually typed model", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "listed-model", context_length: 32000 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1", type: "function", function: { name: "ping", arguments: "{\"message\":\"ok\"}" } }] } }] }), { status: 200 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "https://api.compat.example/v1",
        model: "deployment-alias",
        maxTokens: 32000,
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault(),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(true);
    expect(result.agentRole).toBe("primary_agent");
    expect(result.healthChecks?.find((item) => item.id === "models")?.message).toContain("继续用 chat 实测为准");
  });

  it("skips /models HTTP 400 and still validates chat for OpenAI-compatible endpoints", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "models endpoint disabled" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1", type: "function", function: { name: "ping", arguments: "{\"message\":\"ok\"}" } }] } }] }), { status: 200 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "https://api.compat.example/v1",
        model: "manual-model",
        maxTokens: 32000,
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault(),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(true);
    expect(result.healthChecks?.find((item) => item.id === "models")?.message).toContain("已跳过发现");
  });

  it.each([
    ["MiniMax", "https://api.minimaxi.com/v1", "MiniMax-M2.7"],
    ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-v4-pro"],
    ["DashScope/Qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"],
    ["Moonshot/Kimi", "https://api.moonshot.cn/v1", "kimi-k2"],
    ["Zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-4.6"],
    ["SiliconFlow", "https://api.siliconflow.cn/v1", "Qwen/Qwen3-Coder"],
    ["Volcengine", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1-6"],
    ["Volcengine Coding", "https://ark.cn-beijing.volces.com/api/coding/v3", "doubao-coding"],
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

  it("infers Volcengine coding endpoint separately from normal Ark API", () => {
    expect(inferSourceType("custom", "https://ark.cn-beijing.volces.com/api/coding/v3")).toBe("volcengine_coding_api_key");
    expect(inferSourceType("custom", "https://ark.cn-beijing.volces.com/api/v3")).toBe("volcengine_ark_api_key");
  });

  it("exposes real Coding Plan providers from backend definitions", () => {
    const definitions = defaultProviderRegistry.definitions();
    const codingProviders = definitions.filter((item) => item.roleCapabilities?.includes("coding_plan"));

    expect(codingProviders.map((item) => item.sourceType)).toEqual(expect.arrayContaining([
      "volcengine_coding_api_key",
      "dashscope_coding_api_key",
      "zhipu_coding_api_key",
      "baidu_qianfan_coding_api_key",
      "tencent_token_plan_api_key",
      "tencent_hunyuan_token_plan_api_key",
      "minimax_token_plan_api_key",
      "kimi_coding_api_key",
    ]));
    expect(definitions.find((item) => item.sourceType === "kimi_coding_api_key")).toMatchObject({
      roleCapabilities: ["coding_plan"],
      runtimeCompatibility: "runtime",
    });
    expect(codingProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "dashscope_coding_api_key",
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
        runtimeCompatibility: "runtime",
      }),
      expect.objectContaining({
        sourceType: "zhipu_coding_api_key",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        runtimeCompatibility: "runtime",
      }),
      expect.objectContaining({
        sourceType: "minimax_token_plan_api_key",
        baseUrl: "https://api.minimaxi.com/anthropic/v1",
        runtimeCompatibility: "runtime",
      }),
    ]));
  });

  it("infers coding-plan URLs before their general API providers", () => {
    expect(inferSourceType("custom", "https://coding-intl.dashscope.aliyuncs.com/v1")).toBe("dashscope_coding_api_key");
    expect(inferSourceType("custom", "https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe("dashscope_api_key");
    expect(inferSourceType("custom", "https://open.bigmodel.cn/api/coding/paas/v4")).toBe("zhipu_coding_api_key");
    expect(inferSourceType("custom", "https://open.bigmodel.cn/api/paas/v4")).toBe("zhipu_api_key");
    expect(inferSourceType("custom", "https://qianfan.baidubce.com/v2/coding")).toBe("baidu_qianfan_coding_api_key");
    expect(inferSourceType("custom", "https://api.kimi.com/coding/v1")).toBe("kimi_coding_api_key");
  });

  it("marks tested coding-plan endpoints as coding_plan runtime compatible", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "models endpoint disabled" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] }), { status: 200 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "zhipu_coding_api_key",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        model: "GLM-5.1",
        maxTokens: 256000,
        secretRef: "provider.zhipu-coding.apiKey",
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
    expect(result.runtimeCompatibility).toBe("runtime");
    expect(result.roleCompatibility?.coding_plan?.ok).toBe(true);
    expect(result.roleCompatibility?.chat?.ok).toBe(false);
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

  it("does not send API keys to private OpenAI-compatible endpoints", async () => {
    const fetchMock = vi.mocked(fetch);

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-model",
        secretRef: "secret:custom",
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault({
        hasSecret: async () => true,
        readSecret: async () => "real-api-key",
      }),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(false);
    expect(result.failureCategory).toBe("invalid_url");
    expect(result.message).toContain("内网或本机地址");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still allows private OpenAI-compatible endpoints when no API key will be sent", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "local-model", context_length: 32000 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] }), { status: 200 }));

    const result = await testModelConnection({
      draft: {
        sourceType: "openai_compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-model",
      },
      config: { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows" } } as never,
      secretVault: secretVault(),
      runtimeAdapterFactory: runtimeAdapterFactory(),
      resolveHermesRoot: async () => "D:\\Hermes Agent",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
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
