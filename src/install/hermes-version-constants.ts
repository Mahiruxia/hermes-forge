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

/** Minimum stable Hermes version that Forge targets for full capability support. */
export const MINIMUM_HERMES_VERSION = "0.19.1";

/** Latest Hermes stable release audited with this Forge build. */
export const AUDITED_HERMES_RELEASE_TAG = "v2026.7.30";

/** Version displayed when the CLI cannot be reached. */
export const UNKNOWN_HERMES_VERSION = "unknown";
