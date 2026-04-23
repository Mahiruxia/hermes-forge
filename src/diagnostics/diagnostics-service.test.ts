import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { SessionLog } from "../main/session-log";
import type { SetupService } from "../setup/setup-service";
import type { SnapshotManager } from "../process/snapshot-manager";
import type { WorkspaceLock } from "../process/workspace-lock";
import type { EngineProbeService } from "../probes/engine-probe-service";
import { DiagnosticsService } from "./diagnostics-service";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("DiagnosticsService", () => {
  it("exports a redacted report even when diagnostic subchecks fail", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-diagnostics-"));
    tempDirs.push(baseDir);
    const appPaths = {
      baseDir: () => baseDir,
      ensureWorkspaceLayout: vi.fn(async () => "workspace-1"),
    } as unknown as AppPaths;
    const service = new DiagnosticsService(
      appPaths,
      { getSummary: vi.fn(async () => ({ ready: true, blocking: [], checks: [] })) } as unknown as SetupService,
      {
        read: vi.fn(async () => ({
          defaultModelProfileId: "remote",
          modelProfiles: [{ id: "remote", provider: "openrouter", model: "model", secretRef: "provider.remote.apiKey" }],
          providerProfiles: [{ id: "remote-provider", provider: "openrouter", label: "Remote", apiKeySecretRef: "provider.remote.apiKey" }],
          updateSources: {},
          enginePaths: {},
        })),
      } as unknown as RuntimeConfigStore,
      { readRecent: vi.fn(async () => []) } as unknown as SessionLog,
      {
        healthCheck: vi.fn(async () => {
          throw new Error("Hermes crashed");
        }),
        getMemoryStatus: vi.fn(async () => {
          throw new Error("memory unavailable");
        }),
      } as unknown as EngineAdapter,
      {
        probeHermes: vi.fn(async () => {
          throw new Error("probe failed");
        }),
      } as unknown as EngineProbeService,
      {
        listSnapshots: vi.fn(async () => {
          throw new Error("snapshot failed");
        }),
      } as unknown as SnapshotManager,
      { listActive: vi.fn(() => []) } as unknown as WorkspaceLock,
      () => ({ appVersion: "test", userDataPath: baseDir, portable: false, rendererMode: "built" }),
    );

    const result = await service.export(baseDir);
    expect(result.ok).toBe(true);
    const report = JSON.parse(await fs.readFile(path.join(result.path, "diagnostics.json"), "utf8")) as {
      runtimeConfig: { modelProfiles: Array<{ secretRef?: string }>; providerProfiles: Array<{ apiKeySecretRef?: string }> };
      diagnosticErrors: Array<{ section: string; message: string }>;
    };

    expect(report.runtimeConfig.modelProfiles[0].secretRef).toBe("[CONFIGURED]");
    expect(report.runtimeConfig.providerProfiles[0].apiKeySecretRef).toBe("[CONFIGURED]");
    expect(report.diagnosticErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "engine", message: "Hermes crashed" }),
      expect.objectContaining({ section: "probes", message: "probe failed" }),
      expect.objectContaining({ section: "snapshots", message: "snapshot failed" }),
    ]));
  });
});
