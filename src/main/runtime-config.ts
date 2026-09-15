import fs from "node:fs/promises";
import path from "node:path";
import { runtimeConfigSchema } from "../shared/schemas";
import { migrateRuntimeConfigModels } from "../shared/model-config";
import { defaultEnginePermissions } from "../shared/types";
import type { EngineId, RuntimeConfig } from "../shared/types";
import { getDefaultHermesHome, getDefaultInstallRoot, getDefaultPythonCommand, getPlatformKind } from "../platform";
import { DEFAULT_PINNED_HERMES_SOURCE } from "../install/install-source";
import { atomicWriteText } from "./hermes-config-files";
import { resolveActiveHermesHome } from "./hermes-home";

export type RuntimeConfigRecovery = {
  configPath: string;
  backupPath?: string;
  reason: "invalid_json" | "schema_validation_failed";
  message: string;
};

const platform = getPlatformKind();
const legacyHermesHome = path.join(process.env.USERPROFILE ?? process.cwd(), "Hermes Agent");
const defaultHermesHome = getDefaultHermesHome(platform);
const hermesPathCandidates = [
  process.env.HERMES_HOME,
  process.env.HERMES_AGENT_HOME,
  defaultHermesHome,
  legacyHermesHome,
  path.join(process.cwd(), "Hermes Agent"),
].filter((candidate): candidate is string => Boolean(candidate?.trim()));

const ENGINE_PATH_CANDIDATES: Record<EngineId, string[]> = {
  hermes: hermesPathCandidates,
};

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
  extensionSettings: { connectorsEnabled: false, cronEnabled: false, desktopAutomationEnabled: false },
  enginePermissions: defaultEnginePermissions,
  hermesRuntime: {
    mode: platform === "win32" ? "windows" : "darwin",
    pythonCommand: getDefaultPythonCommand(platform),
    managedRoot: undefined,
    windowsAgentMode: "hermes_native",
    cliPermissionMode: "guarded",
    permissionPolicy: "bridge_guarded",
    workerMode: "off",
    installSource: { ...DEFAULT_PINNED_HERMES_SOURCE },
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
    if (!migratedJson.extensionSettings) {
      migratedJson.extensionSettings = await this.migrateExtensionSettings(parsedJson);
    }
    const parsed = runtimeConfigSchema.safeParse(migratedJson);
    if (!parsed.success) {
      console.error("[RuntimeConfigStore] Schema validation failed, resetting to default config:", parsed.error);
      return await this.resetInvalidConfig("schema_validation_failed", parsed.error);
    }
    const config = parsed.data as RuntimeConfig;
    if (!parsedJson.hermesRuntime?.mode) {
      return {
        ...config,
        hermesRuntime: {
          ...defaultConfig.hermesRuntime!,
          ...normalizeRuntime(config.hermesRuntime),
        },
      };
    }
    return normalizeRuntimeConfig(config);
  }

  async write(config: RuntimeConfig) {
    const parsed = runtimeConfigSchema.parse(migrateRuntimeConfigModels(normalizeRuntimeConfig(config)));
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await atomicWriteText(this.configPath, JSON.stringify(parsed, null, 2));
    return parsed as RuntimeConfig;
  }

  getConfigPath() {
    return this.configPath;
  }

  private async migrateExtensionSettings(config: RuntimeConfig) {
    const dataRoot = path.dirname(this.configPath);
    const home = await resolveActiveHermesHome(path.join(dataRoot, "profiles", "default", "hermes"));
    const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
      try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return {}; }
    };
    const [connectors, cron] = await Promise.all([
      readJson(path.join(dataRoot, "connectors-config.json")),
      readJson(path.join(home, "cron", "jobs.json")),
    ]);
    const enabled = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      const entry = value as { enabled?: boolean; instances?: Record<string, unknown> };
      if (entry.enabled === false) return false;
      return entry.instances ? Object.values(entry.instances).some(enabled) : entry.enabled === true;
    };
    const jobs = Array.isArray(cron) ? cron : Array.isArray(cron.jobs) ? cron.jobs : Object.values(cron);
    return {
      connectorsEnabled: config.startupGatewayAutoStart === true || Object.values((connectors.platforms ?? {}) as Record<string, unknown>).some(enabled),
      cronEnabled: jobs.some((value) => value && typeof value === "object" && (value as { enabled?: boolean }).enabled !== false),
      desktopAutomationEnabled: config.hermesRuntime?.windowsAgentMode === "host_tool_loop",
    };
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
      return await this.normalizeEnginePath(engineId, configured);
    }
    const detected = await this.detectEnginePath(engineId);
    return detected ? await this.normalizeEnginePath(engineId, detected) : defaultHermesHome;
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
      message: "配置文件损坏，已自动恢复默认配置。"
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

  private async normalizeEnginePath(engineId: EngineId, configuredPath: string) {
    if (engineId !== "hermes" || process.platform !== "win32") return configuredPath;
    if (isLegacyPosixPath(configuredPath)) return defaultHermesHome;
    const normalized = path.resolve(configuredPath);
    const childInstall = path.join(normalized, "hermes-agent");
    const childLooksInstall = await pathExists(path.join(childInstall, "pyproject.toml"))
      || await pathExists(path.join(childInstall, "run_agent.py"))
      || await pathExists(path.join(childInstall, "venv", "Scripts", "hermes.exe"))
      || await pathExists(path.join(childInstall, ".venv", "Scripts", "hermes.exe"));
    if (!childLooksInstall) return configuredPath;
    const currentLooksInstall = await pathExists(path.join(normalized, "pyproject.toml"))
      || await pathExists(path.join(normalized, "run_agent.py"))
      || await pathExists(path.join(normalized, "venv", "Scripts", "hermes.exe"))
      || await pathExists(path.join(normalized, ".venv", "Scripts", "hermes.exe"));
    if (currentLooksInstall) return configuredPath;
    const currentLooksHome = await pathExists(path.join(normalized, "config.yaml"))
      || await pathExists(path.join(normalized, "state.db"))
      || await pathExists(path.join(normalized, "memories"))
      || await pathExists(path.join(normalized, "skills"))
      || await pathExists(path.join(normalized, "profiles"));
    return currentLooksHome ? childInstall : configuredPath;
  }
}

async function defaultConfigWithPreferredRuntime(): Promise<RuntimeConfig> {
  return defaultConfig;
}

export function __resetPreferredHermesRuntimeCacheForTests() {
  return;
}

function normalizeRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const enginePaths = { ...(config.enginePaths ?? {}) };
  if (process.platform === "win32" && enginePaths.hermes && isLegacyPosixPath(enginePaths.hermes)) {
    delete enginePaths.hermes;
  }
  return {
    ...config,
    enginePaths,
    hermesRuntime: normalizeRuntime(config.hermesRuntime),
  };
}

function normalizeRuntime(runtime: RuntimeConfig["hermesRuntime"]): NonNullable<RuntimeConfig["hermesRuntime"]> {
  const managedRoot = runtime?.managedRoot?.trim();
  const mode = runtime?.mode ?? defaultConfig.hermesRuntime!.mode;
  return {
    ...defaultConfig.hermesRuntime!,
    ...(runtime ?? {}),
    mode,
    distro: mode === "wsl" ? runtime?.distro : undefined,
    managedRoot: process.platform === "win32" && managedRoot && isLegacyPosixPath(managedRoot) ? undefined : managedRoot || runtime?.managedRoot,
    workerMode: "off",
  };
}

function isLegacyPosixPath(value: string) {
  return /^\/(?:root|home|mnt|tmp|var|usr|etc)(?:\/|$)/i.test(value.replace(/\\/g, "/"));
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
