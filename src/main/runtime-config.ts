import fs from "node:fs/promises";
import path from "node:path";
import { runtimeConfigSchema } from "../shared/schemas";
import { defaultEnginePermissions } from "../shared/types";
import type { EngineId, RuntimeConfig } from "../shared/types";

const defaultHermesHome = path.join(process.env.USERPROFILE ?? process.cwd(), "Hermes Agent");
const hermesPathCandidates = [
  process.env.HERMES_HOME,
  process.env.HERMES_AGENT_HOME,
  defaultHermesHome,
  path.join(process.cwd(), "Hermes Agent"),
].filter((candidate): candidate is string => Boolean(candidate?.trim()));

const ENGINE_PATH_CANDIDATES: Record<EngineId, string[]> = {
  hermes: hermesPathCandidates,
};

const defaultConfig: RuntimeConfig = {
  defaultModelProfileId: "default-local",
  modelProfiles: [
    {
      id: "default-local",
      provider: "local",
      model: "mock-model",
      temperature: 0.2,
      maxTokens: 4096,
    },
  ],
  providerProfiles: [
    {
      id: "openrouter-default",
      provider: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeySecretRef: "provider.openrouter.apiKey",
      models: [{ id: "openrouter/auto", label: "OpenRouter Auto", supportsStreaming: true, inputCostPer1kUsd: 0.002, outputCostPer1kUsd: 0.006 }],
      status: "unknown",
    },
    {
      id: "openai-default",
      provider: "openai",
      label: "OpenAI",
      apiKeySecretRef: "provider.openai.apiKey",
      models: [{ id: "gpt-5.4", label: "GPT-5.4", supportsStreaming: true, supportsTools: true, inputCostPer1kUsd: 0.002, outputCostPer1kUsd: 0.006 }],
      status: "unknown",
    },
    {
      id: "anthropic-default",
      provider: "anthropic",
      label: "Anthropic",
      apiKeySecretRef: "provider.anthropic.apiKey",
      models: [{ id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", supportsStreaming: true, inputCostPer1kUsd: 0.002, outputCostPer1kUsd: 0.006 }],
      status: "unknown",
    },
  ],
  updateSources: {},
  enginePaths: {},
  startupWarmupMode: "cheap",
  enginePermissions: defaultEnginePermissions,
  hermesRuntime: {
    mode: "windows",
    pythonCommand: "python3",
    windowsAgentMode: "hermes_native",
  },
};

export class RuntimeConfigStore {
  constructor(private readonly configPath: string) {}

  async read(): Promise<RuntimeConfig> {
    const raw = await fs.readFile(this.configPath, "utf8").catch(() => undefined);
    if (!raw) {
      await this.write(defaultConfig);
      return defaultConfig;
    }
    const parsed = runtimeConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return defaultConfig;
    }
    return parsed.data as RuntimeConfig;
  }

  async write(config: RuntimeConfig) {
    const parsed = runtimeConfigSchema.parse(config);
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(parsed, null, 2), "utf8");
    return parsed as RuntimeConfig;
  }

  async getEnginePath(engineId: EngineId) {
    const config = await this.read();
    const configured = config.enginePaths?.[engineId]?.trim();
    if (configured) {
      return configured;
    }
    return (await this.detectEnginePath(engineId)) ?? defaultHermesHome;
  }

  async detectEnginePath(engineId: EngineId) {
    for (const candidate of ENGINE_PATH_CANDIDATES[engineId]) {
      if (!candidate) continue;
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return undefined;
  }
}
