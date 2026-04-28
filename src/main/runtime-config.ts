import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../process/command-runner";
import { runtimeConfigSchema } from "../shared/schemas";
import { migrateRuntimeConfigModels } from "../shared/model-config";
import { defaultEnginePermissions } from "../shared/types";
import type { EngineId, RuntimeConfig } from "../shared/types";
import { DEFAULT_PINNED_HERMES_SOURCE } from "../install/install-source";

export type RuntimeConfigRecovery = {
  configPath: string;
  backupPath?: string;
  reason: "invalid_json" | "schema_validation_failed";
  message: string;
};

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

let preferredRuntimeCache: Promise<NonNullable<RuntimeConfig["hermesRuntime"]>> | undefined;

const defaultConfig: RuntimeConfig = {
  defaultModelProfileId: "default-local",
  modelRoleAssignments: { chat: "default-local" },
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
  startupWarmupMode: "off",
  startupGatewayAutoStart: false,
  enginePermissions: defaultEnginePermissions,
  hermesRuntime: {
    mode: "wsl",
    pythonCommand: "python3",
    managedRoot: undefined,
    windowsAgentMode: "hermes_native",
    cliPermissionMode: "yolo",
    permissionPolicy: "bridge_guarded",
    workerMode: "off",
    installSource: DEFAULT_PINNED_HERMES_SOURCE,
  },
};

export class RuntimeConfigStore {
  private lastRecovery?: RuntimeConfigRecovery;

  constructor(private readonly configPath: string) {}

  async read(): Promise<RuntimeConfig> {
    const raw = await fs.readFile(this.configPath, "utf8").catch(() => undefined);
    if (!raw) {
      const config = await defaultConfigWithPreferredRuntime();
      await this.write(config);
      return config;
    }
    let parsedJson: RuntimeConfig & { hermesRuntime?: RuntimeConfig["hermesRuntime"] };
    try {
      parsedJson = JSON.parse(raw) as RuntimeConfig & { hermesRuntime?: RuntimeConfig["hermesRuntime"] };
    } catch (error) {
      return await this.resetInvalidConfig("invalid_json", error);
    }
    const migratedJson = migrateRuntimeConfigModels(parsedJson);
    const parsed = runtimeConfigSchema.safeParse(migratedJson);
    if (!parsed.success) {
      console.error("[RuntimeConfigStore] Schema validation failed, resetting to default config:", parsed.error);
      return await this.resetInvalidConfig("schema_validation_failed", parsed.error);
    }
    const config = parsed.data as RuntimeConfig;
    if (!parsedJson.hermesRuntime?.mode) {
      const preferred = process.env.HERMES_FORGE_DETECT_PREFERRED_RUNTIME_ON_STARTUP === "1"
        ? await preferredHermesRuntime()
        : defaultConfig.hermesRuntime!;
      return {
        ...config,
        hermesRuntime: {
          ...preferred,
          ...(config.hermesRuntime ?? {}),
        },
      };
    }
    return config;
  }

  async write(config: RuntimeConfig) {
    const parsed = runtimeConfigSchema.parse(migrateRuntimeConfigModels(config));
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(parsed, null, 2), "utf8");
    return parsed as RuntimeConfig;
  }

  getConfigPath() {
    return this.configPath;
  }

  getLastRecovery() {
    return this.lastRecovery;
  }

  consumeLastRecovery() {
    const recovery = this.lastRecovery;
    this.lastRecovery = undefined;
    return recovery;
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

  private async resetInvalidConfig(reason: RuntimeConfigRecovery["reason"], error: unknown) {
    const backupPath = await this.backupInvalidConfig().catch((backupError) => {
      console.error("[RuntimeConfigStore] Failed to back up invalid config:", backupError);
      return undefined;
    });
    const config = await defaultConfigWithPreferredRuntime();
    await this.write(config);
    this.lastRecovery = {
      configPath: this.configPath,
      backupPath,
      reason,
      message: error instanceof Error ? error.message : String(error),
    };
    return config;
  }

  private async backupInvalidConfig() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.configPath}.bak.${timestamp}`;
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.copyFile(this.configPath, backupPath);
    return backupPath;
  }
}

async function defaultConfigWithPreferredRuntime(): Promise<RuntimeConfig> {
  if (process.env.HERMES_FORGE_DETECT_PREFERRED_RUNTIME_ON_STARTUP !== "1") {
    return defaultConfig;
  }
  return {
    ...defaultConfig,
    hermesRuntime: await preferredHermesRuntime(),
  };
}

async function preferredHermesRuntime(): Promise<NonNullable<RuntimeConfig["hermesRuntime"]>> {
  preferredRuntimeCache ??= detectPreferredHermesRuntime();
  return await preferredRuntimeCache;
}

export function __resetPreferredHermesRuntimeCacheForTests() {
  preferredRuntimeCache = undefined;
}

async function detectPreferredHermesRuntime(): Promise<NonNullable<RuntimeConfig["hermesRuntime"]>> {
  if (process.platform !== "win32") {
    return defaultConfig.hermesRuntime!;
  }
  const status = await runCommand("wsl.exe", ["--status"], {
    cwd: process.cwd(),
    timeoutMs: 8000,
    runtimeKind: "windows",
    commandId: "runtime-config.prefer-wsl.status",
  }).catch(() => undefined);
  const list = await runCommand("wsl.exe", ["-l", "-q"], {
    cwd: process.cwd(),
    timeoutMs: 8000,
    runtimeKind: "windows",
    commandId: "runtime-config.prefer-wsl.list",
  }).catch(() => undefined);
  const hasStatus = status?.exitCode === 0;
  const distros = (list?.stdout ?? "")
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (hasStatus && distros.length > 0) {
    return {
      ...defaultConfig.hermesRuntime!,
      mode: "wsl",
      distro: defaultConfig.hermesRuntime?.distro ?? distros[0],
    };
  }
  return defaultConfig.hermesRuntime!;
}
