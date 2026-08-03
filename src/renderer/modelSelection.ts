import type { RuntimeConfig } from "../shared/types";

export function resolveSelectedModelProfileId(input: {
  runtimeConfig?: RuntimeConfig;
  activeSessionId?: string;
  preferredModelProfileId?: string;
  modelProfileIdBySession?: Record<string, string>;
}) {
  const profiles = input.runtimeConfig?.modelProfiles ?? [];
  const available = new Set(profiles.map((profile) => profile.id));
  const sessionSelection = input.activeSessionId
    ? input.modelProfileIdBySession?.[input.activeSessionId]
    : undefined;
  const candidates = [
    sessionSelection,
    input.preferredModelProfileId,
    input.runtimeConfig?.defaultModelProfileId,
    profiles[0]?.id,
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && available.has(candidate)));
}
