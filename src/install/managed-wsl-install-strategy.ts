import type { SetupDependencyRepairId } from "../shared/types";
import type { InstallStrategy } from "./install-strategy";
import type {
  InstallOptions,
  InstallPlan,
  InstallPublisher,
  InstallStrategyRepairResult,
  InstallStrategyResult,
  InstallStrategyUpdateResult,
} from "./install-types";
import { installStep } from "./install-types";
import type { ManagedWslInstallerService } from "./managed-wsl-installer-service";
import type { ManagedWslInstallerState } from "./managed-wsl-installer-types";

export class ManagedWslInstallStrategy implements InstallStrategy {
  readonly kind = "managed-wsl" as const;

  constructor(private readonly installerService: ManagedWslInstallerService) {}

  async plan(_options: InstallOptions = {}): Promise<InstallPlan> {
    const report = await this.installerService.planInstall();
    return this.reportToPlan(report);
  }

  async install(publish?: InstallPublisher, _options: InstallOptions = {}): Promise<InstallStrategyResult> {
    const report = await this.installerService.install(publish);
    return {
      ok: report.finalInstallerState === "completed",
      engineId: "hermes",
      rootPath: report.managedRoot,
      message: report.summary,
      log: report.timeline.map((step) => `[${step.phase}] ${step.code}: ${step.summary}${step.detail ? ` | ${step.detail}` : ""}`),
      plan: this.reportToPlan(report),
    };
  }

  async update(): Promise<InstallStrategyUpdateResult> {
    const plan = await this.plan({ mode: "wsl" });
    return {
      ok: false,
      engineId: "hermes",
      message: "Managed WSL update 尚未实现；当前仅提供可正式调用的安装/repair 链路。",
      log: plan.steps.map((step) => `[${step.phase}] ${step.summary}`),
      plan,
    };
  }

  async repairDependency(id: SetupDependencyRepairId): Promise<InstallStrategyRepairResult> {
    if (!["git", "python"].includes(id)) {
      return {
        ok: false,
        id,
        message: "当前 Managed WSL repair 入口只覆盖 python/git/pip/venv 这条基础依赖链路。",
        recommendedFix: "如需修复 Hermes Python 包依赖，请点击“安装 WSL 版 Hermes Agent”；安装器会优先复用现有 Hermes，并为它补齐 WSL venv 依赖。",
        plan: await this.plan({ mode: "wsl" }),
      };
    }
    const report = await this.installerService.executeRepair();
    return {
      ok: report.status !== "failed" && report.status !== "blocked",
      id,
      message: report.summary,
      recommendedFix: report.fixHint,
      plan: this.reportToPlan(report),
    };
  }

  private reportToPlan(report: Awaited<ReturnType<ManagedWslInstallerService["planInstall"]>>): InstallPlan {
    return {
      mode: "wsl",
      ok: report.finalInstallerState === "completed" || report.finalInstallerState === "hermes_install_ready",
      state: this.toPlanState(report.finalInstallerState, report.code),
      summary: report.summary,
      steps: report.timeline.map((step) => installStep({
        phase: step.phase === "repair" ? "repairing_dependencies" : step.phase === "install" ? "installing_dependencies" : step.phase === "health_check" ? "health_check" : step.phase === "completed" ? "completed" : "preflight",
        step: step.step,
        status: step.status === "running" ? "running" : step.status === "failed" || step.status === "blocked" ? "failed" : step.status === "skipped" ? "skipped" : step.status === "pending" ? "pending" : "passed",
        code: step.code,
        summary: step.summary,
        detail: step.detail,
        fixHint: step.fixHint,
        debugContext: step.debugContext,
      })),
      issues: report.lastDoctor?.runtimeProbe.issues ?? [],
      runtimeProbe: report.lastDoctor?.runtimeProbe,
      repairDryRun: report.lastDryRunRepair,
    };
  }

  private toPlanState(state: ManagedWslInstallerState, code: string): InstallPlan["state"] {
    if (state === "completed" || state === "hermes_install_ready" || state === "distro_ready") {
      return "ready_to_attach_existing_wsl";
    }
    if (state === "repair_planned" || state === "repair_executing") {
      return "repair_needed";
    }
    if (code === "unsupported") return "unsupported";
    return "manual_setup_required";
  }
}
