/**
 * Centralized Hermes CLI version thresholds.
 *
 * These constants are the single source of truth for version-gated features.
 * When Hermes releases a new version, update these values and audit
 * callers in:
 *   - src/runtime/hermes-cli-resolver.ts
 *   - src/runtime/hermes-contract.ts
 *   - src/setup/hermes-compatibility-service.ts
 */

/** Minimum stable Hermes version that Forge targets for full capability support. */
export const MINIMUM_HERMES_VERSION = "0.21.3";

/** Latest Hermes stable release audited with this Forge build. */
export const AUDITED_HERMES_RELEASE_TAG = "v2026.9.14";

/** Immutable revision used for reproducible official installs and updates. */
export const AUDITED_HERMES_COMMIT = "345cd2b057a452236de401d3534b8502a7465e8d";

/** Version displayed when the CLI cannot be reached. */
export const UNKNOWN_HERMES_VERSION = "unknown";
