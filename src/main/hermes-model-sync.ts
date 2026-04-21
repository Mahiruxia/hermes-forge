import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimeEnvResolver } from "./runtime-env-resolver";
import type { EngineRuntimeEnv, ModelProfile, ProviderId, RuntimeConfig } from "../shared/types";

const MANAGED_ENV_START = "# >>> Hermes Forge Model Runtime >>>";
const MANAGED_ENV_END = "# <<< Hermes Forge Model Runtime <<<";

export type HermesModelSyncResult = {
  ok: true;
  synced: boolean;
  skippedReason?: string;
  profileId?: string;
  model?: string;
  provider?: string;
  configPath: string;
  envPath: string;
};

type HermesModelConfig = {
  provider: string;
  model: string;
  baseUrl?: string;
};

export class HermesModelSyncService {
  constructor(
    private readonly runtimeEnvResolver: RuntimeEnvResolver,
    private readonly hermesHomeBase: () => string = () => path.join(os.homedir(), ".hermes"),
  ) {}

  async syncRuntimeConfig(config: RuntimeConfig): Promise<HermesModelSyncResult> {
    const hermesHome = await this.activeHermesHome();
    const configPath = path.join(hermesHome, "config.yaml");
    const envPath = path.join(hermesHome, ".env");
    const profile = selectDefaultProfile(config);
    if (!profile || !profile.model.trim()) {
      return { ok: true, synced: false, skippedReason: "missing-model-profile", configPath, envPath };
    }
    if (profile.provider === "local") {
      return { ok: true, synced: false, skippedReason: "local-placeholder-model", profileId: profile.id, configPath, envPath };
    }

    const runtimeEnv = await this.runtimeEnvResolver.resolveFromConfig(config, profile.id);
    const provider = toHermesProvider(profile.provider);
    const modelConfig: HermesModelConfig = {
      provider,
      model: runtimeEnv.model,
      baseUrl: runtimeEnv.baseUrl,
    };
    const modelEnv = buildModelEnv(runtimeEnv, provider);

    await fs.mkdir(hermesHome, { recursive: true });
    const existingConfig = await fs.readFile(configPath, "utf8").catch(() => "");
    const nextConfig = upsertModelBlock(existingConfig, modelConfig);
    if (nextConfig !== existingConfig) {
      await fs.writeFile(configPath, nextConfig, "utf8");
    }

    const existingEnv = await fs.readFile(envPath, "utf8").catch(() => "");
    const nextEnv = upsertManagedEnvBlock(existingEnv, modelEnv);
    if (nextEnv !== existingEnv) {
      await fs.writeFile(envPath, nextEnv, "utf8");
    }

    return {
      ok: true,
      synced: true,
      profileId: profile.id,
      model: runtimeEnv.model,
      provider,
      configPath,
      envPath,
    };
  }

  private async activeHermesHome() {
    const base = this.hermesHomeBase();
    const activeProfile = (await fs.readFile(path.join(base, "active_profile"), "utf8").catch(() => "")).trim();
    if (!activeProfile || /[\\/]/.test(activeProfile)) {
      return base;
    }
    const candidate = path.join(base, "profiles", activeProfile);
    const stat = await fs.stat(candidate).catch(() => undefined);
    return stat?.isDirectory() ? candidate : base;
  }
}

function selectDefaultProfile(config: RuntimeConfig): ModelProfile | undefined {
  return (
    config.modelProfiles.find((item) => item.id === config.defaultModelProfileId) ??
    config.modelProfiles[0]
  );
}

function toHermesProvider(provider: ProviderId) {
  if (provider === "openai") {
    // Hermes routes plain OpenAI-compatible API keys through its OpenRouter/custom-compatible path.
    return "openrouter";
  }
  return provider;
}

function buildModelEnv(runtimeEnv: EngineRuntimeEnv, hermesProvider: string) {
  const env: Record<string, string> = {
    HERMES_INFERENCE_PROVIDER: hermesProvider,
    HERMES_FORGE_MODEL_PROFILE_ID: runtimeEnv.profileId,
    AI_PROVIDER: runtimeEnv.provider,
    AI_MODEL: runtimeEnv.model,
    OPENAI_MODEL: runtimeEnv.model,
    ...runtimeEnv.env,
  };
  if (runtimeEnv.baseUrl) {
    env.AI_BASE_URL = runtimeEnv.baseUrl;
    env.OPENAI_BASE_URL = runtimeEnv.baseUrl;
  }
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  );
}

function upsertModelBlock(content: string, model: HermesModelConfig) {
  const withoutModel = removeTopLevelModelBlock(content);
  const block = buildModelBlock(model);
  const rest = withoutModel.trim();
  return rest ? `${block}\n\n${rest}\n` : `${block}\n`;
}

function buildModelBlock(model: HermesModelConfig) {
  return [
    "model:",
    "  managed_by: \"Hermes Forge\"",
    `  provider: ${yamlString(model.provider)}`,
    `  default: ${yamlString(model.model)}`,
    model.baseUrl ? `  base_url: ${yamlString(model.baseUrl)}` : undefined,
  ].filter(Boolean).join("\n");
}

function removeTopLevelModelBlock(content: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const next: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^model\s*:/.test(line)) {
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate.trim() && !candidate.startsWith(" ") && !candidate.startsWith("\t")) {
          index -= 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    next.push(line);
  }
  return trimTrailingBlankLines(next).join("\n");
}

function upsertManagedEnvBlock(content: string, env: Record<string, string>) {
  const withoutBlock = removeManagedEnvBlock(content).trimEnd();
  const block = buildEnvBlock(env);
  return `${withoutBlock ? `${withoutBlock}\n\n` : ""}${block}\n`;
}

function buildEnvBlock(env: Record<string, string>) {
  const lines = [
    MANAGED_ENV_START,
    "# Managed by Hermes Forge. Edit model settings in the desktop app.",
    ...Object.entries(env)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${quoteEnv(value)}`),
    MANAGED_ENV_END,
  ];
  return lines.join("\n");
}

function removeManagedEnvBlock(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/# >>> Hermes Forge Model Runtime >>>\n[\s\S]*?# <<< Hermes Forge Model Runtime <<<\n?/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function trimTrailingBlankLines(lines: string[]) {
  const next = [...lines];
  while (next.length && next[next.length - 1].trim() === "") {
    next.pop();
  }
  return next;
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function quoteEnv(value: string) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export const testOnly = {
  buildEnvBlock,
  buildModelBlock,
  removeManagedEnvBlock,
  removeTopLevelModelBlock,
  toHermesProvider,
  upsertManagedEnvBlock,
  upsertModelBlock,
};
