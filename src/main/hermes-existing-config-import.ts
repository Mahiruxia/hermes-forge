import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveActiveHermesHome } from "./hermes-home";
import type { SecretVault } from "../auth/secret-vault";
import type { HermesConnectorService } from "./hermes-connector-service";
import type { RuntimeConfigStore } from "./runtime-config";
import type { HermesConnectorPlatformId, HermesExistingConfigImportResult, ModelProfile, ProviderId } from "../shared/types";
import { normalizeOpenAiCompatibleBaseUrl, stableModelProfileId } from "../shared/model-config";

type HermesModelBlock = {
  provider?: string;
  defaultModel?: string;
  baseUrl?: string;
};

export async function importExistingHermesConfig(input: {
  configStore: RuntimeConfigStore;
  secretVault: SecretVault;
  hermesConnectorService: Pick<HermesConnectorService, "importFromEnvValues">;
  hermesHomeBase?: () => string;
}): Promise<HermesExistingConfigImportResult> {
  const baseHome = input.hermesHomeBase?.() ?? path.join(os.homedir(), ".hermes");
  const hermesHome = await resolveActiveHermesHome(baseHome);
  const baseEnv = await readEnvValues(path.join(baseHome, ".env"));
  const activeEnv = hermesHome === baseHome ? baseEnv : await readEnvValues(path.join(hermesHome, ".env"));
  const envValues = { ...baseEnv, ...activeEnv };
  const warnings: string[] = [];

  const connectorImport = await input.hermesConnectorService.importFromEnvValues(envValues);
  if (connectorImport.importedPlatforms.length === 0) {
    warnings.push("没有在 Hermes .env 中发现可导入的连接器变量。");
  }

  const configPath = path.join(hermesHome, "config.yaml");
  const modelBlock = parseTopLevelModelBlock(await fs.readFile(configPath, "utf8").catch(() => ""));
  const modelImport = await importModelProfile({
    configStore: input.configStore,
    secretVault: input.secretVault,
    envValues,
    modelBlock,
  });
  if (!modelImport.imported) {
    warnings.push(modelImport.message ?? "没有在 Hermes 配置中识别到模型设置。");
  }

  const ok = modelImport.imported || connectorImport.importedPlatforms.length > 0;
  const message = ok
    ? [
      modelImport.imported ? `已导入模型配置为 ${modelImport.profileId}` : undefined,
      connectorImport.importedPlatforms.length ? `已导入 ${connectorImport.importedPlatforms.length} 个连接器` : undefined,
    ].filter(Boolean).join("，")
    : "没有发现可导入的 Hermes 配置。";

  return {
    ok,
    hermesHome,
    importedModel: modelImport.imported,
    modelProfileId: modelImport.profileId,
    importedConnectors: connectorImport.importedPlatforms,
    importedSecretRefs: [...new Set([...connectorImport.importedSecretRefs, ...(modelImport.secretRef ? [modelImport.secretRef] : [])])],
    warnings,
    message,
  };
}

async function importModelProfile(input: {
  configStore: RuntimeConfigStore;
  secretVault: SecretVault;
  envValues: Record<string, string>;
  modelBlock: HermesModelBlock;
}) {
  const profile = buildImportedModelProfile(input.envValues, input.modelBlock);
  if (!profile) {
    return {
      imported: false,
      message: "没有在 Hermes config.yaml 或 .env 中识别到可导入的模型配置。",
    };
  }

  if (profile.secretRef) {
    const secret = resolveImportedModelSecret(input.envValues, profile.provider, profile.baseUrl);
    if (secret) {
      await input.secretVault.saveSecret(profile.secretRef, secret);
    }
  }

  const current = await input.configStore.read();
  const nextProfiles = [
    ...current.modelProfiles.filter((item) => item.id !== profile.id),
    profile,
  ];
  await input.configStore.write({
    ...current,
    defaultModelProfileId: profile.id,
    modelProfiles: nextProfiles,
  });

  return {
    imported: true,
    profileId: profile.id,
    secretRef: profile.secretRef,
  };
}

async function readEnvValues(envPath: string) {
  const raw = await fs.readFile(envPath, "utf8").catch(() => "");
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    values[trimmed.slice(0, index).trim()] = unquoteEnv(trimmed.slice(index + 1).trim());
  }
  return values;
}

function buildImportedModelProfile(envValues: Record<string, string>, modelBlock: HermesModelBlock): ModelProfile | undefined {
  const model = envValues.AI_MODEL?.trim()
    || envValues.OPENAI_MODEL?.trim()
    || modelBlock.defaultModel?.trim();
  if (!model) return undefined;

  const sourceType = inferImportedSourceType(
    envValues.AI_PROVIDER || envValues.HERMES_INFERENCE_PROVIDER || modelBlock.provider,
    envValues.AI_BASE_URL || envValues.OPENAI_BASE_URL || modelBlock.baseUrl,
  );
  const provider = providerForImportedSource(sourceType);
  const baseUrl = normalizeImportedBaseUrl(
    envValues.AI_BASE_URL || envValues.OPENAI_BASE_URL || modelBlock.baseUrl,
    provider,
  );
  const secretRef = resolveImportedModelSecretRef(envValues, sourceType, provider, baseUrl);

  return {
    id: stableModelProfileId({ provider, model, baseUrl }),
    name: friendlyImportedProfileName(provider, model),
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(secretRef ? { secretRef } : {}),
  };
}

function inferImportedSourceType(rawProvider?: string, rawBaseUrl?: string) {
  const provider = String(rawProvider ?? "").trim().toLowerCase();
  const baseUrl = String(rawBaseUrl ?? "").trim().toLowerCase();
  if (provider === "openai") return "openai";
  if (provider === "openrouter") return "openrouter";
  if (provider === "anthropic") return "anthropic";
  if (baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost")) return "local_openai";
  if (baseUrl.includes("deepseek.com")) return "deepseek";
  if (baseUrl.includes("dashscope")) return "qwen";
  if (baseUrl.includes("moonshot")) return "kimi";
  if (baseUrl.includes("ark.cn-beijing.volces.com/api/coding")) return "volcengine_coding";
  if (baseUrl.includes("ark.cn-beijing.volces.com")) return "volcengine";
  if (baseUrl.includes("hunyuan.cloud.tencent.com")) return "tencent_hunyuan";
  if (baseUrl.includes("minimax.io") || baseUrl.includes("minimaxi.com")) return "minimax";
  if (baseUrl.includes("siliconflow.cn")) return "siliconflow";
  if (baseUrl.includes("bigmodel.cn")) return "zhipu";
  if (provider === "custom") return "custom_gateway";
  return provider || baseUrl ? "custom_gateway" : "local_openai";
}

function providerForImportedSource(sourceType: string): ProviderId {
  if (sourceType === "openai") return "openai";
  if (sourceType === "openrouter") return "openrouter";
  if (sourceType === "anthropic") return "anthropic";
  return "custom";
}

function resolveImportedModelSecretRef(envValues: Record<string, string>, sourceType: string, provider: ProviderId, baseUrl?: string) {
  const secret = resolveImportedModelSecret(envValues, provider, baseUrl);
  if (!secret) return undefined;
  if (provider === "openai") return "provider.openai.apiKey";
  if (provider === "openrouter") return "provider.openrouter.apiKey";
  if (provider === "anthropic") return "provider.anthropic.apiKey";
  if (sourceType === "deepseek") return "provider.deepseek.apiKey";
  if (sourceType === "qwen") return "provider.qwen.apiKey";
  if (sourceType === "kimi") return "provider.kimi.apiKey";
  if (sourceType === "volcengine") return "provider.volcengine.apiKey";
  if (sourceType === "volcengine_coding") return "provider.volcengine-coding.apiKey";
  if (sourceType === "tencent_hunyuan") return "provider.tencent-hunyuan.apiKey";
  if (sourceType === "minimax") return "provider.minimax.apiKey";
  if (sourceType === "siliconflow") return "provider.siliconflow.apiKey";
  if (sourceType === "zhipu") return "provider.zhipu.apiKey";
  if (sourceType === "local_openai") return "provider.local.apiKey";
  return "provider.custom.apiKey";
}

function friendlyImportedProfileName(provider: ProviderId, model: string) {
  if (provider === "custom") return `Imported · ${model}`;
  return `${provider} · ${model}`;
}

function resolveImportedModelSecret(envValues: Record<string, string>, provider: ProviderId, baseUrl?: string) {
  if (provider === "anthropic") {
    return envValues.ANTHROPIC_API_KEY?.trim() || envValues.AI_API_KEY?.trim();
  }
  if (provider === "openrouter") {
    return envValues.OPENROUTER_API_KEY?.trim() || envValues.OPENAI_API_KEY?.trim() || envValues.AI_API_KEY?.trim();
  }
  if (provider === "openai") {
    return envValues.OPENAI_API_KEY?.trim() || envValues.AI_API_KEY?.trim();
  }
  if (String(baseUrl ?? "").includes("127.0.0.1") || String(baseUrl ?? "").includes("localhost")) {
    return envValues.OPENAI_API_KEY?.trim() || envValues.AI_API_KEY?.trim();
  }
  return envValues.AI_API_KEY?.trim() || envValues.OPENAI_API_KEY?.trim();
}

function normalizeImportedBaseUrl(rawBaseUrl: string | undefined, provider: ProviderId) {
  if (rawBaseUrl?.trim()) {
    return normalizeOpenAiCompatibleBaseUrl(rawBaseUrl) ?? rawBaseUrl.trim();
  }
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "anthropic") return "https://api.anthropic.com/v1";
  return undefined;
}

function parseTopLevelModelBlock(content: string): HermesModelBlock {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^model\s*:/.test(line));
  if (start < 0) return {};
  const block: HermesModelBlock = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.startsWith(" ") && !line.startsWith("\t")) break;
    const match = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = parseYamlScalar(match[2]);
    if (key === "provider") block.provider = value;
    if (key === "default") block.defaultModel = value;
    if (key === "base_url") block.baseUrl = value;
  }
  return block;
}

function parseYamlScalar(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unquoteEnv(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return trimmed;
}

export const testOnly = {
  buildImportedModelProfile,
  inferImportedSourceType,
  parseTopLevelModelBlock,
  readEnvValues,
};
