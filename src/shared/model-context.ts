import type { ModelProfile, ModelProviderProfile } from "./types";

function endpointKey(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Model IDs are not globally unique: two compatible endpoints can serve
 * the same ID with different context limits. Never borrow the other route's limit. */
export function resolveModelProviderProfile(profile: ModelProfile, providers: ModelProviderProfile[] = []) {
  const candidates = providers.filter((provider) => provider.provider === profile.provider
    && (!profile.baseUrl || !provider.baseUrl || endpointKey(provider.baseUrl) === endpointKey(profile.baseUrl)));
  const byId = candidates.find((provider) => provider.id === profile.id);
  if (byId) return byId;
  const sameEndpoint = profile.baseUrl
    ? candidates.filter((provider) => provider.baseUrl && endpointKey(provider.baseUrl) === endpointKey(profile.baseUrl!))
    : [];
  const scoped = sameEndpoint.length ? sameEndpoint : candidates;
  const withModel = scoped.filter((provider) => provider.models.some((model) => model.id === profile.model || model.label === profile.model));
  return withModel.length === 1 ? withModel[0] : scoped.length === 1 ? scoped[0] : undefined;
}

export function resolveModelContextWindow(profile: ModelProfile | undefined, providers: ModelProviderProfile[] = []) {
  if (!profile) return undefined;
  const provider = resolveModelProviderProfile(profile, providers);
  const model = provider?.models.find((item) => item.id === profile.model || item.label === profile.model);
  return model?.contextWindow ?? profile.maxTokens;
}
