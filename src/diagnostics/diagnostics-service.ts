import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { SessionLog } from "../main/session-log";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { EngineProbeService } from "../probes/engine-probe-service";
import type { SetupService } from "../setup/setup-service";
import type { SnapshotManager } from "../process/snapshot-manager";
import type { WorkspaceLock } from "../process/workspace-lock";
import type { ClientInfo, DiagnosticExportResult } from "../shared/types";
import type { ManagedWslInstallerReport, PermissionOverview } from "../shared/types";
import type { RuntimeProbeService } from "../runtime/runtime-probe-service";
import type { WslDoctorReportService } from "../install/wsl-doctor-report-service";
import { redactSensitiveValue } from "../shared/redaction";

const diagnosticsSessionMappingSchema = z.record(z.string(), z.unknown());

export class DiagnosticsService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly setupService: SetupService,
    private readonly configStore: RuntimeConfigStore,
    private readonly sessionLog: SessionLog,
    private readonly hermes: EngineAdapter,
    private readonly engineProbeService: EngineProbeService,
    private readonly snapshotManager: SnapshotManager,
    private readonly workspaceLock: WorkspaceLock,
    private readonly clientInfo: () => ClientInfo,
    private readonly runtimeProbeService?: RuntimeProbeService,
    private readonly wslDoctorReportService?: WslDoctorReportService,
    private readonly permissionOverviewProvider?: () => Promise<PermissionOverview>,
    private readonly lastInstallReportProvider?: () => Promise<ManagedWslInstallerReport | undefined>,
  ) {}

  async export(workspacePath?: string): Promise<DiagnosticExportResult> {
    const createdAt = new Date().toISOString();
    const dir = path.join(this.appPaths.baseDir(), "diagnostics", createdAt.replace(/[:.]/g, "-"));
    await fs.mkdir(dir, { recursive: true });

    const diagnosticErrors: Array<{ section: string; message: string }> = [];
    const capture = async <T>(section: string, task: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await task();
      } catch (error) {
        diagnosticErrors.push({ section, message: error instanceof Error ? error.message : String(error) });
        return fallback;
      }
    };

    const workspaceId = workspacePath?.trim()
      ? await capture("workspace", () => this.appPaths.ensureWorkspaceLayout(workspacePath), undefined as string | undefined)
      : undefined;
    const config = await capture("runtimeConfig", () => this.configStore.read(), { modelProfiles: [], updateSources: {}, enginePaths: {} });
    const safeConfig = {
      ...config,
      modelProfiles: config.modelProfiles.map((profile) => ({
        ...profile,
        secretRef: profile.secretRef ? "[CONFIGURED]" : undefined,
      })),
      providerProfiles: config.providerProfiles?.map((profile) => ({
        ...profile,
        apiKeySecretRef: profile.apiKeySecretRef ? "[CONFIGURED]" : undefined,
      })),
    };

    const engine = await capture("engine", () => this.hermes.healthCheck(), undefined);
    const memory = workspaceId ? await capture("memory", () => this.hermes.getMemoryStatus(workspaceId), undefined) : undefined;
    const snapshots = workspaceId ? await capture("snapshots", () => this.snapshotManager.listSnapshots(workspaceId), []) : [];
    const events = workspaceId ? await capture("recentEvents", () => this.sessionLog.readRecent(workspaceId, 80), []) : [];
    const locks = await capture("locks", async () => this.workspaceLock.listActive(workspaceId), []);
    const probes = await capture("probes", () => this.engineProbeService.probeHermes(workspacePath), undefined);
    const runtimeProbe = await capture("runtimeProbe", () => this.runtimeProbeService?.probe({ workspacePath }) ?? Promise.resolve(undefined), undefined);
    const wslDoctor = await capture("wslDoctor", () => this.wslDoctorReportService?.build(workspacePath) ?? Promise.resolve(undefined), undefined);
    const permissionOverview = await capture("permissionOverview", () => this.permissionOverviewProvider?.() ?? Promise.resolve(undefined), undefined);
    const lastInstallReport = await capture("lastInstallReport", () => this.lastInstallReportProvider?.() ?? Promise.resolve(undefined), undefined);
    const installLogs = await capture("installLogs", () => this.listInstallLogs(), []);
    const setup = await capture("setup", () => this.setupService.getSummary(workspacePath), { ready: false, blocking: [], checks: [] });
    const sessionMappings = await capture("sessionMappings", () => this.listSessionMappings(), []);
    const taskDiagnostics = workspaceId ? await capture("taskDiagnostics", () => this.sessionLog.summarizeRecentRuns(workspaceId, 400), []) : [];

    const report = redactSensitiveValue({
      createdAt,
      clientInfo: this.clientInfo(),
      setup,
      runtimeConfigSummary: this.runtimeConfigSummary(config),
      runtimeConfig: safeConfig,
      engine,
      probes,
      runtimeProbe,
      permissionOverview,
      wslDoctor,
      lastInstallReport,
      memory,
      snapshots,
      locks,
      installLogs,
      taskDiagnostics,
      sessionMappings,
      recentEvents: events,
      diagnosticErrors,
    });

    await fs.writeFile(path.join(dir, "diagnostics.json"), JSON.stringify(report, null, 2), "utf8");
    if (wslDoctor) {
      await fs.writeFile(path.join(dir, "wsl-doctor.json"), JSON.stringify(wslDoctor, null, 2), "utf8");
      await fs.writeFile(path.join(dir, "WSL_DOCTOR_SUMMARY.txt"), wslDoctor.summaryText, "utf8");
    }
    await fs.writeFile(path.join(dir, "README.txt"), [
      "诊断报告已脱敏，不包含 API Key 明文。",
      diagnosticErrors.length ? `部分诊断项读取失败，详见 diagnostics.json 的 diagnosticErrors 字段。失败项：${diagnosticErrors.map((item) => item.section).join(", ")}` : "所有诊断项已尽量读取完成。",
      "",
    ].join("\n"), "utf8");
    return {
      ok: true,
      path: dir,
      message: diagnosticErrors.length
        ? `诊断报告已导出：${dir}。部分诊断项读取失败，已写入报告。`
        : `诊断报告已导出：${dir}`,
    };
  }

  private async listInstallLogs() {
    const dir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    const files = await fs.readdir(dir).catch(() => []);
    return files.filter((file) => file.endsWith(".log")).slice(-12);
  }

  private runtimeConfigSummary(config: Awaited<ReturnType<RuntimeConfigStore["read"]>>) {
    return {
      defaultModelProfileId: config.defaultModelProfileId,
      modelProfileCount: config.modelProfiles.length,
      providerProfileCount: config.providerProfiles?.length ?? 0,
      runtimeMode: config.hermesRuntime?.mode ?? "windows",
      permissionPolicy: config.hermesRuntime?.permissionPolicy ?? "bridge_guarded",
      cliPermissionMode: config.hermesRuntime?.cliPermissionMode ?? "yolo",
      windowsAgentMode: config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
      hermesInstallSource: config.hermesRuntime?.installSource,
    };
  }

  private async listSessionMappings() {
    const root = this.appPaths.sessionsRootDir();
    const sessions = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const mappings = await Promise.all(
      sessions
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const mappingPath = path.join(root, entry.name, "hermes-cli-session.json");
          const raw = await fs.readFile(mappingPath, "utf8").catch(() => "");
          if (!raw) return undefined;
          try {
            const parsed = diagnosticsSessionMappingSchema.parse(JSON.parse(raw));
            return {
              sessionId: entry.name,
              mappingPath,
              ...parsed,
            };
          } catch {
            await quarantineInvalidJson(mappingPath);
            return {
              sessionId: entry.name,
              mappingPath,
              parseError: true,
            };
          }
        }),
    );
    return mappings.filter(Boolean);
  }
}

async function quarantineInvalidJson(filePath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.rename(filePath, `${filePath}.invalid.${timestamp}`).catch(() => undefined);
}
