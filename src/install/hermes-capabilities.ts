import type { CommandResult } from "../process/command-runner";
import { isAtLeastVersion, parseHermesVersion } from "./hermes-version";
import { RESUME_SUPPORT_VERSION } from "./hermes-version-constants";

/**
 * Capability probe shape used by both WSL and Native install verifiers.
 *
 * Forge requires the four boolean signals below to be true *and* a non-empty
 * cliVersion. When any are missing, `minimumSatisfied` is false and the
 * `missing` array names what's absent — used downstream for user-facing
 * fix hints and for the Phase 2 native-install gate.
 */
export interface CapabilityProbe {
  minimumSatisfied: boolean;
  cliVersion: string | undefined;
  supportsLaunchMetadataArg: boolean;
  supportsLaunchMetadataEnv: boolean;
  supportsResume: boolean;
  missing: string[];
}

/**
 * Pure function: parse `hermes capabilities --json` stdout into a CapabilityProbe.
 *
 * Inputs:
 *   - result: the raw CommandResult from running `hermes capabilities --json`
 *
 * Outputs: never throws. On parse failure or non-zero exit, returns a probe
 * with `minimumSatisfied: false` and a sensible `missing` entry.
 */
export function parseCapabilityProbe(result: CommandResult): CapabilityProbe {
  const base: CapabilityProbe = {
    minimumSatisfied: false,
    cliVersion: undefined,
    supportsLaunchMetadataArg: false,
    supportsLaunchMetadataEnv: false,
    supportsResume: false,
    missing: [],
  };
  if (result.exitCode !== 0) {
    return { ...base, missing: ["capabilities --json"] };
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      cliVersion?: string;
      capabilities?: {
        supportsLaunchMetadataArg?: boolean;
        supportsLaunchMetadataEnv?: boolean;
        supportsResume?: boolean;
      };
    };
    const probe: CapabilityProbe = {
      minimumSatisfied: Boolean(parsed.cliVersion)
        && parsed.capabilities?.supportsLaunchMetadataArg === true
        && parsed.capabilities?.supportsLaunchMetadataEnv === true
        && parsed.capabilities?.supportsResume === true,
      cliVersion: parsed.cliVersion,
      supportsLaunchMetadataArg: parsed.capabilities?.supportsLaunchMetadataArg === true,
      supportsLaunchMetadataEnv: parsed.capabilities?.supportsLaunchMetadataEnv === true,
      supportsResume: parsed.capabilities?.supportsResume === true,
      missing: [],
    };
    if (!probe.cliVersion) probe.missing.push("cliVersion");
    if (!probe.supportsLaunchMetadataArg) probe.missing.push("supportsLaunchMetadataArg");
    if (!probe.supportsLaunchMetadataEnv) probe.missing.push("supportsLaunchMetadataEnv");
    if (!probe.supportsResume) probe.missing.push("supportsResume");
    return probe;
  } catch {
    return { ...base, missing: ["capability_json_parse"] };
  }
}

/**
 * v0.11.0+ fallback recognition.
 *
 * Official NousResearch/hermes-agent v0.11.0+ ships `--resume` but may not
 * support `capabilities --json` or `--launch-metadata`. When the capability
 * probe fails but `hermes --version` reports >= RESUME_SUPPORT_VERSION, we
 * patch the probe so downstream code can render a precise "use the fork" hint
 * instead of a generic "capability check failed".
 *
 * The probe stays `minimumSatisfied: false` — this is purely a diagnostic
 * enrichment, not an approval.
 */
export function applyV011Fallback(probe: CapabilityProbe, versionStdout: string): CapabilityProbe {
  if (probe.minimumSatisfied) return probe;
  const detectedVersion = parseHermesVersion(versionStdout);
  if (!detectedVersion || !isAtLeastVersion(detectedVersion, RESUME_SUPPORT_VERSION)) {
    return probe;
  }
  return {
    minimumSatisfied: false,
    cliVersion: detectedVersion,
    supportsLaunchMetadataArg: false,
    supportsLaunchMetadataEnv: false,
    supportsResume: true,
    missing: ["supportsLaunchMetadataArg", "supportsLaunchMetadataEnv"],
  };
}
