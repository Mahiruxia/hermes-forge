import { describe, expect, it, vi } from "vitest";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "./app-paths";
import type { RuntimeEnvResolver } from "./runtime-env-resolver";
import type { RuntimeConfig } from "../shared/types";
import { HermesSystemAuditService } from "./hermes-system-audit-service";

describe("HermesSystemAuditService", () => {
  it("returns a failed preflight result instead of throwing when runtime resolution fails", async () => {
    const service = new HermesSystemAuditService(
      {} as AppPaths,
      {} as EngineAdapter,
      {
        resolve: vi.fn(async () => {
          throw new Error("missing model runtime");
        }),
      } as unknown as RuntimeEnvResolver,
      async () => ({ modelProfiles: [], updateSources: {}, enginePaths: {} } as RuntimeConfig),
    );

    const result = await service.test();

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      expect.objectContaining({
        id: "preflight",
        status: "failed",
        message: "missing model runtime",
      }),
    ]);
  });
});
