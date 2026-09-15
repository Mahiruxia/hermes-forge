import type { RuntimeConfig } from "../shared/types";
import { AUDITED_HERMES_COMMIT, AUDITED_HERMES_RELEASE_TAG } from "./hermes-version-constants";

export type InstallSourceLabel = "official" | "mirror" | "custom" | "fork" | "pinned";

export interface InstallSource {
  repoUrl: string;
  branch?: string;
  commit?: string;
  sourceLabel: InstallSourceLabel;
}

export type InstallSourceOption =
  | { kind: "official" | "mirror"; repoUrl?: string; branch?: string; commit?: string }
  | { kind: "custom"; repoUrl?: string; branch?: string; commit?: string };


/**
 * Official Hermes stable source audited by Forge.
 *
 * Forge aligns with the official Hermes Agent repository to ensure
 * compatibility with upstream releases. Stable installs are pinned to an
 * audited release tag; explicit advanced branch selections are recorded as custom.
 */
export const DEFAULT_PINNED_HERMES_SOURCE: InstallSource = {
  repoUrl: "https://github.com/NousResearch/hermes-agent.git",
  branch: AUDITED_HERMES_RELEASE_TAG,
  commit: AUDITED_HERMES_COMMIT,
  sourceLabel: "official",
};

/**
 * Resolve the install source to use for the current install/update.
 *
 * Priority:
 *   1. `config.hermesRuntime.installSource` (UI / IPC override)
 *   2. `HERMES_INSTALL_REPO_URL` env var (legacy power-user override; only
 *      overrides repoUrl, drops branch/commit since they cannot be inferred)
 *   3. `DEFAULT_PINNED_HERMES_SOURCE` (the audited official release)
 */
export function resolveInstallSource(config: RuntimeConfig): InstallSource {
  const configured = config.hermesRuntime?.installSource;
  if (configured?.repoUrl?.trim()) {
    // Old bundled main/date-tag defaults advance with Forge. Explicit commits
    // and custom development branches remain user-owned selections.
    if ((configured.sourceLabel === "official" || configured.sourceLabel === "mirror")
      && configured.repoUrl.trim() === DEFAULT_PINNED_HERMES_SOURCE.repoUrl
      && !configured.commit?.trim()
      && (!configured.branch?.trim() || configured.branch.trim() === "main" || /^v\d{4}\.\d{1,2}\.\d{1,2}$/.test(configured.branch.trim()))) {
      return { ...DEFAULT_PINNED_HERMES_SOURCE, sourceLabel: configured.sourceLabel };
    }
    return {
      repoUrl: configured.repoUrl.trim(),
      branch: configured.branch?.trim() || undefined,
      commit: configured.commit?.trim() || undefined,
      sourceLabel: normalizeSourceLabel(configured.sourceLabel),
    };
  }
  const envOverride = process.env.HERMES_INSTALL_REPO_URL?.trim();
  if (envOverride) {
    return {
      repoUrl: envOverride,
      sourceLabel: "custom",
    };
  }
  return DEFAULT_PINNED_HERMES_SOURCE;
}

export function resolveInstallSourceFromOption(config: RuntimeConfig, option?: InstallSourceOption): InstallSource {
  if (!option) return resolveInstallSource(config);
  if (option.kind === "official" || option.kind === "mirror") {
    const branch = option.branch?.trim();
    return {
      ...DEFAULT_PINNED_HERMES_SOURCE,
      branch: branch || DEFAULT_PINNED_HERMES_SOURCE.branch,
      commit: option.commit?.trim() || (branch ? undefined : DEFAULT_PINNED_HERMES_SOURCE.commit),
      sourceLabel: branch && branch !== DEFAULT_PINNED_HERMES_SOURCE.branch ? "custom" : option.kind,
    };
  }
  const repoUrl = option.repoUrl?.trim();
  if (!repoUrl) return resolveInstallSource(config);
  return {
    repoUrl,
    branch: option.branch?.trim() || undefined,
    commit: option.commit?.trim() || undefined,
    sourceLabel: "custom",
  };
}

export function normalizeSourceLabel(label?: string): InstallSourceLabel {
  if (label === "official" || label === "mirror" || label === "custom" || label === "pinned") return label;
  if (label === "fork") return "custom";
  return "custom";
}
