/**
 * Centralized Hermes CLI version thresholds.
 *
 * These constants are the single source of truth for version-gated features.
 * When Hermes releases a new version, update these values and audit
 * callers in:
 *   - src/runtime/hermes-cli-resolver.ts
 *   - src/install/hermes-capabilities.ts
 *   - src/setup/hermes-compatibility-service.ts
 */

/** Minimum Hermes version that supports session resume. */
export const RESUME_SUPPORT_VERSION = "0.11.0";

/** Minimum Hermes version that Forge targets for full capability support. */
export const MINIMUM_HERMES_VERSION = "0.12.0";

/** Version displayed when the CLI cannot be reached. */
export const UNKNOWN_HERMES_VERSION = "unknown";
