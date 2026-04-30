import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveActiveHermesHome } from "./hermes-home";
import type { RuntimeEnvResolver } from "./runtime-env-resolver";
import { normalizeSourceTypeForProfile, resolveHermesProvider } from "../shared/model-config";
import type { EngineRuntimeEnv, ModelProfile, ModelRole, RuntimeConfig } from "../shared/types";

const MANAGED_ENV_START = "# >>> Hermes Forge Model Runtime >>>";
const MANAGED_ENV_END = "# <<< Hermes Forge Model Runtime <<<";

export type HermesModelSyncResult = {
  ok: true;
  synced: boolean;
  skippedReason?: string;
  profileId?: string;
  model?: string;
  provider?: string;
  roles?: Partial<Record<ModelRole, { profileId: string; model: string; provider: string; baseUrl?: string; wslReachable?: boolean; wslProbeMessage?: string; consumedByHermes?: boolean; syncNote?: string }>>;
  configPath: string;
  envPath: string;
};

type HermesModelConfig = {
  provider: string;
  model: string;
  baseUrl?: string;
  contextLength?: number;
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
    let chatProfile = selectRoleProfile(config, "chat");
    let codingPlanFallback = false;

    // When no explicit chat model is configured, fall back to the Coding Plan
    // profile so that Hermes still has a usable model.
    if ((!chatProfile || !chatProfile.model.trim() || chatProfile.provider === "local") && !config.modelRoleAssignments?.chat) {
      const codingProfile = selectRoleProfile(config, "coding_plan");
      if (codingProfile && codingProfile.model.trim() && codingProfile.provider !== "local") {
        chatProfile = codingProfile;
        codingPlanFallback = true;
      }
    }

    if (!chatProfile || !chatProfile.model.trim()) {
      return { ok: true, synced: false, skippedReason: "missing-model-profile", configPath, envPath };
    }
    if (chatProfile.provider === "local") {
      return { ok: true, synced: false, skippedReason: "local-placeholder-model", profileId: chatProfile.id, configPath, envPath };
    }

    const chatRuntimeEnv = await this.runtimeEnvResolver.resolveFromConfig(config, chatProfile.id, "chat");
    const provider = toHermesProvider(chatProfile);
    const modelConfig: HermesModelConfig = {
      provider,
      model: chatRuntimeEnv.model,
      baseUrl: persistedModelBaseUrl(chatProfile, chatRuntimeEnv),
      contextLength: normalizeContextLength(chatProfile.maxTokens),
    };
    const roles: NonNullable<HermesModelSyncResult["roles"]> = {
      chat: {
        profileId: chatRuntimeEnv.profileId,
        model: chatRuntimeEnv.model,
        provider,
        baseUrl: modelConfig.baseUrl,
        consumedByHermes: true,
        ...(codingPlanFallback ? { syncNote: "Coding Plan 模型被用作 Chat fallback（未配置显式 Chat 模型）。" } : {}),
      },
    };
    const envBlocks = [await this.buildRoleEnv(config, "chat", chatRuntimeEnv, provider)];
    if (codingPlanFallback) {
      // When the coding plan is used as the chat fallback, add a marker env var
      // so downstream tooling can detect this mode.
      envBlocks.push({ HERMES_FORGE_CODING_PLAN_CONSUMED_AS_CHAT: chatProfile.id });
    }
    const codingProfile = selectRoleProfile(config, "coding_plan");
    if (codingProfile && codingProfile.id !== chatProfile.id && codingProfile.provider !== "local") {
      try {
        const codingRuntimeEnv = await this.runtimeEnvResolver.resolveFromConfig(config, codingProfile.id, "coding_plan");
        const codingProvider = toHermesProvider(codingProfile);
        const codingEnv = await this.buildRoleEnv(config, "coding_plan", codingRuntimeEnv, codingProvider);
        envBlocks.push(codingEnv);
        roles.coding_plan = {
          profileId: codingRuntimeEnv.profileId,
          model: codingRuntimeEnv.model,
          provider: codingProvider,
          baseUrl: codingEnv.HERMES_CODING_PLAN_BASE_URL ?? codingRuntimeEnv.baseUrl,
          consumedByHermes: false,
          syncNote: "已写入 Hermes Forge 托管配置；当前 Hermes Agent 未读取 HERMES_CODING_PLAN_*，不会自动切换 Coding Plan runtime。",
        };
      } catch (error) {
        console.warn("[Hermes Forge] Coding Plan runtime resolution failed, skipping:", error);
        roles.coding_plan = {
          profileId: codingProfile.id,
          model: codingProfile.model,
          provider: toHermesProvider(codingProfile),
          consumedByHermes: false,
          syncNote: `Coding Plan 运行时解析失败，已跳过：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const modelEnv = Object.assign({}, ...envBlocks);

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
      await fs.chmod(envPath, 0o600).catch((error) => {
        console.warn("[Hermes Forge] Failed to apply strict permissions to Hermes .env:", error);
      });
    }

    return {
      ok: true,
      synced: true,
      profileId: chatProfile.id,
      model: chatRuntimeEnv.model,
      provider,
      roles,
      configPath,
      envPath,
    };
  }

  private async activeHermesHome() {
    return await resolveActiveHermesHome(this.hermesHomeBase());
  }

  private async buildRoleEnv(config: RuntimeConfig, role: ModelRole, runtimeEnv: EngineRuntimeEnv, hermesProvider: string) {
    const reachableBaseUrl = await this.toRuntimeReachableBaseUrl(config, runtimeEnv.baseUrl);
    return buildModelEnv({ ...runtimeEnv, baseUrl: reachableBaseUrl }, hermesProvider, role);
  }

  private async toRuntimeReachableBaseUrl(config: RuntimeConfig, baseUrl?: string) {
    return baseUrl;
  }
}

function selectRoleProfile(config: RuntimeConfig, role: ModelRole): ModelProfile | undefined {
  const roleProfileId = config.modelRoleAssignments?.[role] ?? (role === "chat" ? config.defaultModelProfileId : undefined);
  return (
    config.modelProfiles.find((item) => item.id === roleProfileId) ??
    (role === "chat" ? config.modelProfiles.find((item) => item.id === config.defaultModelProfileId) : undefined) ??
    (role === "chat" ? config.modelProfiles[0] : undefined)
  );
}

function toHermesProvider(profile: Pick<ModelProfile, "provider" | "sourceType" | "baseUrl" | "model">) {
  const sourceType = normalizeSourceTypeForProfile(profile);
  return resolveHermesProvider({ provider: profile.provider, sourceType });
}

function buildModelEnv(runtimeEnv: EngineRuntimeEnv, hermesProvider: string, role: ModelRole = "chat") {
  if (role === "coding_plan") {
    const env: Record<string, string> = {
      HERMES_FORGE_CODING_PLAN_MODEL_PROFILE_ID: runtimeEnv.profileId,
      HERMES_CODING_PLAN_PROVIDER: hermesProvider,
      HERMES_CODING_PLAN_MODEL: runtimeEnv.model,
      HERMES_CODING_PLAN_BASE_URL: runtimeEnv.baseUrl ?? "",
      HERMES_CODING_PLAN_API_KEY: resolveCodingPlanApiKey(runtimeEnv),
    };
    return Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
    );
  }
  const env: Record<string, string> = {
    HERMES_INFERENCE_PROVIDER: hermesProvider,
    HERMES_FORGE_MODEL_PROFILE_ID: runtimeEnv.profileId,
    HERMES_FORGE_CHAT_MODEL_PROFILE_ID: role === "chat" ? runtimeEnv.profileId : "",
    AI_PROVIDER: runtimeEnv.provider,
    AI_MODEL: runtimeEnv.model,
    OPENAI_MODEL: runtimeEnv.model,
    ...runtimeEnv.env,
  };
  if (runtimeEnv.baseUrl) {
    env.AI_BASE_URL = env.AI_BASE_URL ?? runtimeEnv.baseUrl;
    env.OPENAI_BASE_URL = env.OPENAI_BASE_URL ?? runtimeEnv.baseUrl;
  }
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  );
}

function resolveRuntimeApiKey(runtimeEnv: EngineRuntimeEnv) {
  return runtimeEnv.env.OPENAI_API_KEY
    ?? runtimeEnv.env.AI_API_KEY
    ?? runtimeEnv.env.ANTHROPIC_API_KEY
    ?? undefined;
}

function resolveCodingPlanApiKey(runtimeEnv: EngineRuntimeEnv) {
  return resolveRuntimeApiKey(runtimeEnv)
    ?? runtimeEnv.env.KIMI_API_KEY
    ?? runtimeEnv.env.VOLCENGINE_API_KEY
    ?? runtimeEnv.env.DASHSCOPE_API_KEY
    ?? runtimeEnv.env.ZHIPU_API_KEY
    ?? runtimeEnv.env.ZAI_API_KEY
    ?? runtimeEnv.env.GLM_API_KEY
    ?? runtimeEnv.env.QIANFAN_API_KEY
    ?? runtimeEnv.env.MINIMAX_API_KEY
    ?? runtimeEnv.env.TENCENT_API_KEY
    ?? runtimeEnv.env.TENCENT_CODING_PLAN_API_KEY
    ?? runtimeEnv.env.TENCENT_HY_API_KEY
    ?? runtimeEnv.env.TENCENT_TOKENHUB_API_KEY
    ?? "";
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
    model.contextLength ? `  context_length: ${model.contextLength}` : undefined,
  ].filter(Boolean).join("\n");
}

function persistedModelBaseUrl(profile: Pick<ModelProfile, "baseUrl">, runtimeEnv: EngineRuntimeEnv) {
  return runtimeEnv.env.HERMES_FORGE_UPSTREAM_BASE_URL?.trim()
    || profile.baseUrl?.trim()
    || runtimeEnv.baseUrl;
}

function normalizeContextLength(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
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
  normalizeContextLength,
  persistedModelBaseUrl,
  removeManagedEnvBlock,
  removeTopLevelModelBlock,
  toHermesProvider,
  upsertManagedEnvBlock,
  upsertModelBlock,
  resolveCodingPlanApiKey,
};
