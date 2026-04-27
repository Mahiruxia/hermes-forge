import type { RuntimeConfig } from "../shared/types";

export type InstallSourceLabel = "official" | "fork" | "pinned";

export interface InstallSource {
  repoUrl: string;
  branch?: string;
  commit?: string;
  sourceLabel: InstallSourceLabel;
}

/**
 * Pinned fork source: Mahiruxia/hermes-agent@codex/launch-metadata-capabilities
 *
 * Reason: Official NousResearch/hermes-agent v0.11.0 does NOT support:
 *   - `hermes capabilities --json`
 *   - `--launch-metadata <path>` CLI arg
 *   - `HERMES_FORGE_LAUNCH_METADATA` env var
 *
 * These capabilities are required for Forge integration (workspace context,
 * selected files, attachments, session resume). Both Windows native and WSL
 * install flows pull from this pinned source so that capability checks pass
 * uniformly.
 *
 * To upgrade: rebase the `codex/launch-metadata-capabilities` branch onto
 * the latest official tag, then update this commit hash.
 */
export const DEFAULT_PINNED_HERMES_SOURCE: InstallSource = {
  repoUrl: "https://github.com/Mahiruxia/hermes-agent.git",
  branch: "codex/launch-metadata-capabilities",
  commit: "0537bad534a7ce43d683f06f8ebdf7ff9dfb4816",
  sourceLabel: "pinned",
};

/**
 * Resolve the install source to use for the current install/update.
 *
 * Priority:
 *   1. `config.hermesRuntime.installSource` (UI / IPC override)
 *   2. `HERMES_INSTALL_REPO_URL` env var (legacy power-user override; only
 *      overrides repoUrl, drops branch/commit since they cannot be inferred)
 *   3. `DEFAULT_PINNED_HERMES_SOURCE` (the bundled pinned fork)
 */
export function resolveInstallSource(config: RuntimeConfig): InstallSource {
  const configured = config.hermesRuntime?.installSource;
  if (configured?.repoUrl?.trim()) {
    return {
      repoUrl: configured.repoUrl.trim(),
      branch: configured.branch?.trim() || undefined,
      commit: configured.commit?.trim() || undefined,
      sourceLabel: configured.sourceLabel ?? "fork",
    };
  }
  const envOverride = process.env.HERMES_INSTALL_REPO_URL?.trim();
  if (envOverride) {
    return {
      repoUrl: envOverride,
      sourceLabel: "fork",
    };
  }
  return DEFAULT_PINNED_HERMES_SOURCE;
}
