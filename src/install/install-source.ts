import type { RuntimeConfig } from "../shared/types";

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

export interface RepoSyncStep {
  program: string;
  args: string[];
  cwd?: string;
}

/**
 * Build a sequence of git commands to sync the Hermes repo to the desired
 * commit/branch. Works for both Native (runCommand) and WSL (shell script).
 */
export function buildRepoSyncSteps(options: {
  root: string;
  repoUrl: string;
  branch?: string;
  commit?: string;
  existing: boolean;
}): RepoSyncStep[] {
  const { root, repoUrl, branch, commit, existing } = options;
  if (commit) {
    if (existing) {
      return [
        { program: "git", args: ["-C", root, "remote", "set-url", "origin", repoUrl] },
        { program: "git", args: ["-C", root, "fetch", "--depth", "1", "origin", commit] },
        { program: "git", args: ["-C", root, "checkout", "--detach", "FETCH_HEAD"] },
      ];
    }
    return [
      { program: "git", args: ["init", root] },
      { program: "git", args: ["-C", root, "remote", "add", "origin", repoUrl] },
      { program: "git", args: ["-C", root, "fetch", "--depth", "1", "origin", commit] },
      { program: "git", args: ["-C", root, "checkout", "--detach", "FETCH_HEAD"] },
    ];
  }
  const b = branch?.trim() || "main";
  if (existing) {
    return [
      { program: "git", args: ["-C", root, "remote", "set-url", "origin", repoUrl] },
      { program: "git", args: ["-C", root, "fetch", "--depth", "1", "origin", b] },
      { program: "git", args: ["-C", root, "checkout", b] },
      { program: "git", args: ["-C", root, "reset", "--hard", "FETCH_HEAD"] },
    ];
  }
  return [{ program: "git", args: ["clone", "--branch", b, "--depth", "1", repoUrl, root] }];
}

/**
 * Official Hermes stable source audited by Forge.
 *
 * Forge aligns with the official Hermes Agent repository to ensure
 * compatibility with upstream releases. Stable installs are pinned to an
 * audited release tag; users can still opt into main in advanced settings.
 */
export const DEFAULT_PINNED_HERMES_SOURCE: InstallSource = {
  repoUrl: "https://github.com/NousResearch/hermes-agent.git",
  branch: "v2026.7.30",
  sourceLabel: "official",
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
    return {
      ...DEFAULT_PINNED_HERMES_SOURCE,
      branch: option.branch?.trim() || DEFAULT_PINNED_HERMES_SOURCE.branch,
      commit: option.commit?.trim() || undefined,
      sourceLabel: option.kind,
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
