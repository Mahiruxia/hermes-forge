import type { SecretVault } from "../auth/secret-vault";
import type { RuntimeConfigStore } from "./runtime-config";
import type { EngineRuntimeEnv, ModelProfile, RuntimeConfig } from "../shared/types";
import { normalizeOpenAiCompatibleBaseUrl } from "../shared/model-config";
import type { ModelRuntimeProxyService } from "./model-runtime-proxy";

export class RuntimeEnvResolver {
  constructor(
    private readonly configStore: RuntimeConfigStore,
    private readonly secretVault: SecretVault,
    private readonly modelRuntimeProxy?: Pick<ModelRuntimeProxyService, "resolve">,
  ) {}

  readConfig() {
    return this.configStore.read();
  }

  async resolve(modelProfileId?: string): Promise<EngineRuntimeEnv> {
    const config = await this.configStore.read();
    return this.resolveFromConfig(config, modelProfileId);
  }

  async resolveFromConfig(config: RuntimeConfig, modelProfileId?: string): Promise<EngineRuntimeEnv> {
    const profile =
      config.modelProfiles.find((item) => item.id === (modelProfileId ?? config.defaultModelProfileId)) ??
      config.modelProfiles[0];

    if (!profile) {
      throw new Error("缺少模型配置，无法生成运行环境。");
    }

    const secret = profile.secretRef ? await this.secretVault.readSecret(profile.secretRef) : undefined;
    const providerProfile = config.providerProfiles?.find((item) => item.provider === profile.provider || item.id === profile.id);
    const baseUrl = normalizeOpenAiCompatibleBaseUrl(profile.baseUrl ?? providerProfile?.baseUrl);
    const runtime = {
      profileId: profile.id,
      provider: profile.provider,
      model: profile.model,
      baseUrl,
      providerProfileId: providerProfile?.id,
      env: this.toEnv({ ...profile, baseUrl }, secret),
    };
    return this.modelRuntimeProxy?.resolve(runtime) ?? runtime;
  }

  private toEnv(profile: ModelProfile, secret?: string): Record<string, string> {
    const env: Record<string, string> = {
      AI_PROVIDER: profile.provider,
      AI_MODEL: profile.model,
    };

    if (profile.baseUrl) {
      env.AI_BASE_URL = profile.baseUrl;
      env.OPENAI_BASE_URL = profile.baseUrl;
      env.ANTHROPIC_BASE_URL = profile.baseUrl;
    }

    if (profile.provider === "local") {
      return env;
    }

    if (profile.provider === "custom") {
      const apiKey = secret || "lm-studio";
      env.OPENAI_API_KEY = apiKey;
      env.AI_API_KEY = apiKey;
      env.AI_PROVIDER = "custom";
    } else if (!secret) {
      return env;
    } else if (profile.provider === "openrouter") {
      env.OPENROUTER_API_KEY = secret;
      env.OPENAI_API_KEY = secret;
      env.OPENAI_BASE_URL = profile.baseUrl ?? "https://openrouter.ai/api/v1";
      env.AI_API_KEY = secret;
      env.AI_BASE_URL = env.OPENAI_BASE_URL;
      env.AI_PROVIDER = "openrouter";
    } else if (profile.provider === "openai") {
      env.OPENAI_API_KEY = secret;
    } else if (profile.provider === "anthropic") {
      env.ANTHROPIC_API_KEY = secret;
    } else {
      env.AI_API_KEY = secret;
    }

    return env;
  }
}
