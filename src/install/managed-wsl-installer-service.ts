import fs from "node:fs/promises";
import path from "node:path";
import type { AppPaths } from "../main/app-paths";
import type { HermesInstallEvent } from "../shared/types";
import type { WslDoctorService } from "./wsl-doctor-service";
import type { WslDistroService } from "./wsl-distro-service";
import type { WslHermesInstallService } from "./wsl-hermes-install-service";
import type { WslRepairService } from "./wsl-repair-service";
import type {
  WslDoctorReport,
  WslRepairDependencyCheck,
  WslRepairDependencyId,
  WslRepairResult,
} from "./wsl-doctor-types";
import {
  compareInstallerStage,
  nextInstallerStage,
  type ManagedWslInstallerFailureArtifacts,
  type ManagedWslInstallerRecovery,
  type ManagedWslInstallerRecoveryAction,
  type ManagedWslInstallerResumeStage,
} from "./managed-wsl-recovery-types";
import {
  emptyDependencyResult,
  installerStep,
  type ManagedWslInstallerCode,
  type ManagedWslInstallerDependencyResult,
  type ManagedWslInstallerPhase,
  type ManagedWslInstallerReport,
  type ManagedWslInstallerState,
  type ManagedWslInstallerStatus,
  type ManagedWslInstallerStepResult,
} from "./managed-wsl-installer-types";

type InstallPublisher = (event: HermesInstallEvent) => void;

export class ManagedWslInstallerService {
  private lastInstallReport?: ManagedWslInstallerReport;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly doctorService: WslDoctorService,
    private readonly repairService: WslRepairService,
    private readonly distroService: WslDistroService,
    private readonly hermesInstallService: WslHermesInstallService,
  ) {}

  getLastInstallReport() {
    return this.lastInstallReport;
  }

  async planInstall(): Promise<ManagedWslInstallerReport> {
    const startedAt = new Date().toISOString();
    const report = this.createReport(startedAt);
    this.push(report, "doctor_started", {
      phase: "doctor",
      step: "doctor",
      status: "running",
      code: "ok",
      summary: "开始检查 WSL 环境。",
    });
    const doctor = await this.doctorService.diagnose();
    report.lastDoctor = doctor;
    report.distroName = doctor.runtime.distro ?? doctor.runtimeProbe.distroName;
    report.managedRoot = doctor.runtime.managedRoot;
    report.failureArtifacts = this.baseArtifacts(report, doctor);
    const dryRun = await this.repairService.dryRun(doctor);
    report.lastDryRunRepair = dryRun;
    this.applyDependencyChecks(report, dryRun.dependencyChecks);

    const unsupported = this.resolveDoctorBlock(doctor);
    if (unsupported) {
      this.fail(report, "doctor_blocked", unsupported.step, unsupported.recovery);
      return this.finalize(report);
    }

    if (dryRun.actions.some((action) => action.wouldChange)) {
      report.nextRecommendedStep = dryRun.actions.some((action) => action.manualActionRequired) ? "manual_fix_then_retry" : "run_execute_repair";
      this.push(report, "repair_planned", {
        phase: "repair",
        step: "plan-repair",
        status: "ready",
        code: dryRun.actions.some((action) => action.manualActionRequired) ? "manual_action_required" : this.primaryDependencyCode(dryRun.dependencyChecks),
        summary: dryRun.summary,
        detail: dryRun.actions.filter((action) => action.wouldChange).map((action) => action.description).join("；"),
        fixHint: dryRun.actions.find((action) => action.manualActionRequired)?.expectedOutcome ?? "建议先查看修复预演，再决定是否执行自动修复。",
        debugContext: { actions: dryRun.actions },
      });
      return this.finalize(report);
    }

    this.recordDeferredBridgeIssue(report, doctor);

    this.markSuccessful(report, "doctor");
    this.push(report, "distro_ready", {
      phase: "distro",
      step: "distro-ready",
      status: "ready",
      code: "ok",
      summary: "WSL 环境已就绪，可以继续安装 Hermes。",
      detail: doctor.runtime.distro ?? doctor.runtimeProbe.distroName,
    });
    report.nextRecommendedStep = "retry_install";
    this.push(report, "hermes_install_ready", {
      phase: "install",
      step: "install-ready",
      status: "ready",
      code: "ok",
      summary: "现在可以开始安装受管 Hermes。",
    });
    return this.finalize(report);
  }

  async dryRunRepair(): Promise<ManagedWslInstallerReport> {
    const report = await this.planInstall();
    if (report.finalInstallerState === "repair_planned") {
      return report;
    }
    report.nextRecommendedStep = report.code === "manual_action_required" ? "manual_fix_then_retry" : "run_execute_repair";
    this.push(report, "repair_planned", {
      phase: "repair",
      step: "plan-repair",
      status: "ready",
      code: report.code,
      summary: report.summary,
      detail: report.detail,
      fixHint: report.fixHint,
      debugContext: report.debugContext,
    });
    return this.finalize(report);
  }

  async executeRepair(): Promise<ManagedWslInstallerReport> {
    const startedAt = new Date().toISOString();
    const report = this.createReport(startedAt);
    this.push(report, "doctor_started", {
      phase: "doctor",
      step: "doctor",
      status: "running",
      code: "ok",
      summary: "开始检查 WSL 环境。",
    });
    const doctor = await this.doctorService.diagnose();
    report.lastDoctor = doctor;
    report.distroName = doctor.runtime.distro ?? doctor.runtimeProbe.distroName;
    report.managedRoot = doctor.runtime.managedRoot;
    report.failureArtifacts = this.baseArtifacts(report, doctor);
    const dryRun = await this.repairService.dryRun(doctor);
    report.lastDryRunRepair = dryRun;
    this.applyDependencyChecks(report, dryRun.dependencyChecks);

    const block = this.resolveDoctorBlock(doctor);
    if (block) {
      this.fail(report, "doctor_blocked", block.step, block.recovery);
      return this.finalize(report);
    }

    this.push(report, "repair_planned", {
      phase: "repair",
      step: "plan-repair",
      status: "ready",
      code: dryRun.actions.some((action) => action.manualActionRequired) ? "manual_action_required" : this.primaryDependencyCode(dryRun.dependencyChecks),
      summary: dryRun.summary,
      detail: dryRun.actions.filter((action) => action.wouldChange).map((action) => action.description).join("；"),
      fixHint: dryRun.actions.find((action) => action.manualActionRequired)?.expectedOutcome,
      debugContext: { actions: dryRun.actions },
    });

    this.push(report, "repair_executing", {
      phase: "repair",
      step: "execute-repair",
      status: "running",
      code: "ok",
      summary: "正在执行 WSL 自动修复。",
    });
    const repair = await this.repairService.repair(doctor);
    report.lastRepairExecution = repair;
    this.applyDependencyChecks(report, repair.dependencyChecks);
    report.nextRecommendedStep = repair.nextRecommendedStep;

    const repairFailure = this.resolveRepairFailure(repair, report);
    if (repairFailure) {
      this.fail(report, "doctor_blocked", repairFailure.step, repairFailure.recovery);
      return this.finalize(report);
    }

    this.markSuccessful(report, "repair");
    this.push(report, "distro_ready", {
      phase: "distro",
      step: "distro-ready",
      status: "ready",
      code: "ok",
      summary: "修复完成，WSL 环境现在可以继续安装 Hermes。",
      detail: repair.after?.runtime.distro ?? doctor.runtime.distro,
    });
    return this.finalize(report);
  }

  async install(publish?: InstallPublisher): Promise<ManagedWslInstallerReport> {
    const startedAt = new Date().toISOString();
    const report = this.createReport(startedAt);
    this.push(report, "doctor_started", {
      phase: "doctor",
      step: "doctor",
      status: "running",
      code: "ok",
      summary: "开始检查 WSL 环境。",
    }, publish);

    let doctor = await this.doctorService.diagnose();
    report.lastDoctor = doctor;
    report.distroName = doctor.runtime.distro ?? doctor.runtimeProbe.distroName;
    report.managedRoot = doctor.runtime.managedRoot;
    report.failureArtifacts = this.baseArtifacts(report, doctor);
    let dryRun = await this.repairService.dryRun(doctor);
    report.lastDryRunRepair = dryRun;
    this.applyDependencyChecks(report, dryRun.dependencyChecks);

    const bootstrapDistro = await this.createOrAttachDistroIfNeeded(report, doctor, publish);
    if (!bootstrapDistro.ok) {
      return this.finalize(report);
    }
    if (bootstrapDistro.doctor) {
      doctor = bootstrapDistro.doctor;
      report.lastDoctor = doctor;
      report.distroName = doctor.runtime.distro ?? doctor.runtimeProbe.distroName;
      report.managedRoot = doctor.runtime.managedRoot;
      report.failureArtifacts = this.baseArtifacts(report, doctor);
      dryRun = await this.repairService.dryRun(doctor);
      report.lastDryRunRepair = dryRun;
      this.applyDependencyChecks(report, dryRun.dependencyChecks);
    }

    const unsupportedBlock = this.resolveDoctorBlock(doctor);
    if (unsupportedBlock) {
      this.fail(report, "doctor_blocked", unsupportedBlock.step, unsupportedBlock.recovery, publish);
      return this.finalize(report);
    }
    this.markSuccessful(report, "doctor");

    if (dryRun.actions.some((action) => action.wouldChange)) {
      this.push(report, "repair_planned", {
        phase: "repair",
        step: "plan-repair",
        status: "ready",
        code: dryRun.actions.some((action) => action.manualActionRequired) ? "manual_action_required" : this.primaryDependencyCode(dryRun.dependencyChecks),
        summary: dryRun.summary,
        detail: dryRun.actions.filter((action) => action.wouldChange).map((action) => action.description).join("；"),
        fixHint: dryRun.actions.find((action) => action.manualActionRequired)?.expectedOutcome,
        debugContext: { actions: dryRun.actions },
      }, publish);
      this.push(report, "repair_executing", {
        phase: "repair",
        step: "execute-repair",
        status: "running",
        code: "ok",
        summary: "Managed WSL repair 正在执行。",
      }, publish);
      const repair = await this.repairService.repair(doctor);
      report.lastRepairExecution = repair;
      this.applyDependencyChecks(report, repair.dependencyChecks);
      report.nextRecommendedStep = repair.nextRecommendedStep;
      const repairFailure = this.resolveRepairFailure(repair, report);
      if (repairFailure) {
        this.fail(report, "doctor_blocked", repairFailure.step, repairFailure.recovery, publish);
        return this.finalize(report);
      }
      this.markSuccessful(report, "repair");
      doctor = repair.after ?? await this.doctorService.diagnose();
      report.lastDoctor = doctor;
      report.distroName = doctor.runtime.distro ?? doctor.runtimeProbe.distroName;
      report.managedRoot = doctor.runtime.managedRoot;
      report.failureArtifacts = this.baseArtifacts(report, doctor);
      dryRun = await this.repairService.dryRun(doctor);
      report.lastDryRunRepair = dryRun;
      this.applyDependencyChecks(report, dryRun.dependencyChecks);
    }

    const postRepairDistro = await this.createOrAttachDistroIfNeeded(report, doctor, publish);
    if (!postRepairDistro.ok) {
      return this.finalize(report);
    }
    if (postRepairDistro.doctor) {
      doctor = postRepairDistro.doctor;
      report.lastDoctor = doctor;
      report.distroName = doctor.runtime.distro ?? doctor.runtimeProbe.distroName;
      report.managedRoot = doctor.runtime.managedRoot;
      report.failureArtifacts = this.baseArtifacts(report, doctor);
    }

    this.push(report, "distro_ready", {
      phase: "distro",
      step: "distro-ready",
      status: "ready",
      code: "ok",
      summary: "Managed distro 已可进入 Hermes 安装阶段。",
      detail: doctor.runtime.distro ?? doctor.runtimeProbe.distroName,
    }, publish);
    if (!report.lastSuccessfulStage || compareInstallerStage(report.lastSuccessfulStage, "create_distro") < 0) {
      this.markSuccessful(report, "create_distro");
    }

    this.recordDeferredBridgeIssue(report, doctor, publish);

    const resumeFromStage = this.determineResumeFromStage(this.lastInstallReport, doctor);
    report.resumedFromStage = resumeFromStage;
    report.nextRecommendedStep = "retry_install";
    this.push(report, "hermes_install_started", {
      phase: "install",
      step: "install-hermes",
      status: "running",
      code: "ok",
      summary: resumeFromStage
        ? `WSL 内 Hermes 安装已启动，将从 ${resumeFromStage} 继续恢复。`
        : "WSL 内 Hermes 安装已启动。",
      detail: resumeFromStage ? `lastSuccessfulStage=${this.lastInstallReport?.lastSuccessfulStage ?? "none"}` : undefined,
    }, publish);
    const hermesInstall = await this.hermesInstallService.install({
      report: doctor,
      resumeFromStage,
      previousResult: this.lastInstallReport?.lastHermesInstall,
    });
    report.lastHermesInstall = hermesInstall;
    report.distroName = hermesInstall.distroName;
    report.managedRoot = hermesInstall.hermesRoot;
    report.reprobeStatus = hermesInstall.reprobeStatus;
    report.reDoctorStatus = hermesInstall.reDoctorStatus;
    report.resumedFromStage = hermesInstall.resumedFromStage ?? resumeFromStage;
    report.failureArtifacts = this.mergeArtifacts(report.failureArtifacts, hermesInstall.failureArtifacts);
    this.applyHermesInstallResult(report, hermesInstall);

    const installFailure = this.resolveHermesInstallFailure(hermesInstall, report);
    if (installFailure) {
      this.fail(report, "hermes_install_failed", installFailure.step, installFailure.recovery, publish);
      return this.finalize(report);
    }

    this.markSuccessful(report, hermesInstall.lastSuccessfulStage ?? "health_check");
    this.push(report, "hermes_install_ready", {
      phase: "health_check",
      step: "install-ready",
      status: "ready",
      code: "ok",
      summary: "Hermes in WSL 已通过当前 health check。",
      detail: hermesInstall.pythonResolved,
    }, publish);
    report.recovery = undefined;
    report.nextRecommendedStep = "none";
    this.push(report, "completed", {
      phase: "completed",
      step: "completed",
      status: "completed",
      code: "ok",
      summary: "Managed WSL 安装链路已完成，可正式使用。",
      detail: hermesInstall.hermesRoot,
    }, publish);
    return this.finalize(report);
  }

  private createReport(startedAt: string): ManagedWslInstallerReport {
    const current = installerStep({
      phase: "doctor",
      step: "doctor",
      status: "pending",
      code: "ok",
      summary: "Managed WSL installer 已创建。",
    });
    return {
      startedAt,
      finishedAt: startedAt,
      finalInstallerState: "doctor_started",
      phase: current.phase,
      step: current.step,
      status: current.status,
      code: current.code,
      summary: current.summary,
      current,
      timeline: [],
      pythonStatus: emptyDependencyResult("python3"),
      gitStatus: emptyDependencyResult("git"),
      pipStatus: emptyDependencyResult("pip"),
      venvStatus: emptyDependencyResult("venv"),
      repoStatus: installerStep({
        phase: "install",
        step: "repo",
        status: "pending",
        code: "ok",
        summary: "Repo 尚未检查。",
      }),
      installStatus: installerStep({
        phase: "install",
        step: "pip-install",
        status: "pending",
        code: "ok",
        summary: "安装步骤尚未开始。",
      }),
      healthStatus: installerStep({
        phase: "health_check",
        step: "health-check",
        status: "pending",
        code: "ok",
        summary: "Health check 尚未开始。",
      }),
      nextRecommendedStep: "run_dry_run_repair",
    };
  }

  private push(
    report: ManagedWslInstallerReport,
    state: ManagedWslInstallerState,
    step: ManagedWslInstallerStepResult,
    publish?: InstallPublisher,
  ) {
    const normalized = installerStep({
      ...step,
      code: this.normalizeCode(step.code),
    });
    report.finalInstallerState = state;
    report.current = normalized;
    report.phase = normalized.phase;
    report.step = normalized.step;
    report.status = normalized.status;
    report.code = normalized.code;
    report.summary = normalized.summary;
    report.detail = normalized.detail;
    report.fixHint = normalized.fixHint;
    report.debugContext = normalized.debugContext;
    report.timeline.push(normalized);
    publish?.({
      stage: this.toPublishStage(normalized.phase, normalized.status),
      message: normalized.summary,
      detail: normalized.detail,
      progress: this.progressForState(state),
      startedAt: report.startedAt,
      at: new Date().toISOString(),
    });
  }

  private markSuccessful(report: ManagedWslInstallerReport, stage: ManagedWslInstallerResumeStage) {
    report.lastSuccessfulStage = stage;
    report.failureArtifacts = {
      ...(report.failureArtifacts ?? {}),
      lastSuccessfulStage: stage,
    };
  }

  private fail(
    report: ManagedWslInstallerReport,
    state: ManagedWslInstallerState,
    step: ManagedWslInstallerStepResult,
    recovery: ManagedWslInstallerRecovery,
    publish?: InstallPublisher,
  ) {
    report.recovery = recovery;
    report.nextRecommendedStep = recovery.nextAction;
    report.failureArtifacts = {
      ...(report.failureArtifacts ?? {}),
      recommendedRecoveryAction: recovery.nextAction,
      lastSuccessfulStage: report.lastSuccessfulStage,
    };
    this.push(report, state, step, publish);
  }

  private applyDependencyChecks(report: ManagedWslInstallerReport, checks: WslRepairDependencyCheck[]) {
    report.pythonStatus = this.toDependencyResult(checks.find((check) => check.dependency === "python3"), "python3");
    report.gitStatus = this.toDependencyResult(checks.find((check) => check.dependency === "git"), "git");
    report.pipStatus = this.toDependencyResult(checks.find((check) => check.dependency === "pip"), "pip");
    report.venvStatus = this.toDependencyResult(checks.find((check) => check.dependency === "venv"), "venv");
  }

  private applyHermesInstallResult(report: ManagedWslInstallerReport, result: NonNullable<ManagedWslInstallerReport["lastHermesInstall"]>) {
    report.repoStatus = this.installStepFromResult(result, ["cloning"], "repo", "Repo 尚未处理。");
    report.installStatus = this.installStepFromResult(result, ["installing_dependencies"], "pip-install", "pip install 尚未开始。");
    report.healthStatus = this.installStepFromResult(result, ["health_check"], "health-check", "Health check 尚未开始。");
    report.hermesSource = result.hermesSource;
    report.hermesCommit = result.hermesCommit;
    report.hermesVersion = result.hermesVersion;
    report.hermesCapabilityProbe = result.capabilityProbe;
    if (result.lastSuccessfulStage) {
      this.markSuccessful(report, result.lastSuccessfulStage);
    }
  }

  private installStepFromResult(
    result: NonNullable<ManagedWslInstallerReport["lastHermesInstall"]>,
    phases: string[],
    stepName: string,
    fallbackSummary: string,
  ): ManagedWslInstallerStepResult {
    const match = [...result.steps].reverse().find((step) => phases.includes(step.phase));
    if (!match) {
      return installerStep({
        phase: phases[0] === "health_check" ? "health_check" : "install",
        step: stepName,
        status: "pending",
        code: "ok",
        summary: fallbackSummary,
      });
    }
    return installerStep({
      phase: match.phase === "health_check" ? "health_check" : "install",
      step: match.step,
      status: match.status === "failed" ? "failed" : match.status === "passed" ? "ready" : match.status === "running" ? "running" : match.status === "skipped" ? "skipped" : "pending",
      code: this.normalizeCode(match.code),
      summary: match.summary,
      detail: match.detail,
      fixHint: match.fixHint,
      debugContext: match.debugContext,
    });
  }

  private resolveDoctorBlock(doctor: WslDoctorReport) {
    const unsupported = doctor.blockingIssues.find((issue) => issue.code === "wsl_missing");
    if (unsupported || doctor.overallStatus === "unsupported") {
      return {
        step: installerStep({
          phase: "doctor",
          step: "doctor",
          status: "blocked",
          code: "unsupported",
          summary: unsupported?.summary ?? "当前环境不支持 Managed WSL 安装链路。",
          detail: unsupported?.detail ?? doctor.blockingIssues.map((issue) => issue.summary).join("；"),
          fixHint: unsupported?.fixHint ?? doctor.recommendedActions[0],
          debugContext: unsupported?.debugContext,
        }),
        recovery: {
          failureStage: "doctor",
          disposition: "manual_action_required",
          code: "unsupported",
          summary: unsupported?.summary ?? "当前环境不支持 Managed WSL。",
          detail: unsupported?.detail,
          fixHint: unsupported?.fixHint ?? doctor.recommendedActions[0],
          nextAction: "export_diagnostics",
          debugContext: unsupported?.debugContext,
        } satisfies ManagedWslInstallerRecovery,
      };
    }
    return undefined;
  }

  private hasBridgeBlock(doctor: WslDoctorReport) {
    return doctor.blockingIssues.find((issue) => issue.code === "bridge_unreachable");
  }

  private recordDeferredBridgeIssue(report: ManagedWslInstallerReport, doctor: WslDoctorReport, publish?: InstallPublisher) {
    const bridgeBlock = this.hasBridgeBlock(doctor);
    if (!bridgeBlock) {
      return;
    }
    this.push(report, report.finalInstallerState, {
      phase: "doctor",
      step: "bridge-deferred",
      status: "skipped",
      code: "bridge_unreachable",
      summary: "Windows Bridge 当前不可达，已跳过 Bridge 预检并继续修复 Hermes Agent。",
      detail: bridgeBlock.detail,
      fixHint: bridgeBlock.fixHint ?? "Hermes 修复完成后可重启客户端或手动刷新 Bridge 状态。",
      debugContext: bridgeBlock.debugContext,
    }, publish);
  }

  private async createOrAttachDistroIfNeeded(
    report: ManagedWslInstallerReport,
    doctor: WslDoctorReport,
    publish?: InstallPublisher,
  ): Promise<{ ok: true; doctor?: WslDoctorReport } | { ok: false }> {
    const distroIssue = doctor.blockingIssues.find((issue) => ["wsl_missing", "wsl_distro_missing", "wsl_distro_unreachable"].includes(issue.code));
    if (!distroIssue) {
      return { ok: true };
    }

    this.push(report, "distro_ready", {
      phase: "distro",
      step: "create-or-attach-distro",
      status: "running",
      code: "ok",
      summary: distroIssue.code === "wsl_missing"
        ? "正在尝试安装或启用 WSL，并准备 Ubuntu 环境。"
        : "正在创建或连接 Ubuntu WSL 环境。",
      detail: distroIssue.summary,
      fixHint: "首次安装可能需要 Windows 授权、重启或打开 Ubuntu 完成初始化。",
    }, publish);

    const create = await this.distroService.createOrAttach({ requestedBy: "install", explicitCreate: true });
    report.lastCreateDistro = create;
    report.distroName = create.distroName;
    report.failureArtifacts = this.mergeArtifacts(report.failureArtifacts, create.failureArtifacts);
    if (!create.reachableAfterCreate) {
      this.fail(report, "doctor_blocked", {
        phase: "distro",
        step: "create-or-attach-distro",
        status: "blocked",
        code: "distro_unavailable",
        summary: create.steps.at(-1)?.summary ?? "Managed distro 仍不可用。",
        detail: create.steps.at(-1)?.detail ?? create.stderrPreview ?? create.stdoutPreview,
        fixHint: create.steps.at(-1)?.fixHint ?? create.recovery?.fixHint,
        debugContext: create.debugContext,
      }, create.recovery ?? {
        failureStage: "create_distro",
        disposition: "retryable",
        code: "distro_unavailable",
        summary: create.steps.at(-1)?.summary ?? "Create distro 失败。",
        detail: create.stderrPreview ?? create.stdoutPreview,
        fixHint: "请检查 WSL/Ubuntu 初始化状态后再重试。",
        nextAction: "retry_create_distro",
        debugContext: create.debugContext,
      }, publish);
      return { ok: false };
    }

    this.markSuccessful(report, create.lastSuccessfulStage ?? "create_distro");
    const nextDoctor = await this.doctorService.diagnose({
      runtime: {
        ...doctor.runtime,
        mode: "wsl",
        distro: create.distroName,
      },
    });
    return { ok: true, doctor: nextDoctor };
  }

  private resolveRepairFailure(repair: WslRepairResult, report: ManagedWslInstallerReport) {
    const failedStep = repair.steps.find((step) => step.status === "failed");
    if (failedStep) {
      return {
        step: installerStep({
          phase: "repair",
          step: "execute-repair",
          status: "blocked",
          code: this.normalizeCode(failedStep.code),
          summary: failedStep.summary,
          detail: failedStep.detail,
          fixHint: failedStep.fixHint,
          debugContext: failedStep.debugContext,
        }),
        recovery: {
          failureStage: "repair",
          disposition: failedStep.code === "manual_action_required" ? "manual_action_required" : "retryable",
          code: this.normalizeCode(failedStep.code),
          summary: failedStep.summary,
          detail: failedStep.detail,
          fixHint: failedStep.fixHint ?? "请先处理 repair 失败项，再重新执行 execute repair。",
          nextAction: repair.nextRecommendedStep,
          debugContext: {
            repairedDependencies: repair.repairedDependencies,
            skippedDependencies: repair.skippedDependencies,
            failedDependencies: repair.failedDependencies,
            manualActionsRequired: repair.manualActionsRequired,
          },
        } satisfies ManagedWslInstallerRecovery,
      };
    }
    const unresolvedDependency = repair.dependencyChecks.find((check) => check.status !== "ok" && check.status !== "repaired");
    if (!unresolvedDependency) return undefined;
    return {
      step: installerStep({
        phase: "repair",
        step: "execute-repair",
        status: "blocked",
        code: this.normalizeCode(unresolvedDependency.code),
        summary: unresolvedDependency.summary,
        detail: unresolvedDependency.detail,
        fixHint: unresolvedDependency.fixHint,
        debugContext: unresolvedDependency.debugContext,
      }),
      recovery: {
        failureStage: "repair",
        disposition: unresolvedDependency.status === "manual_action_required" ? "manual_action_required" : "retryable",
        code: this.normalizeCode(unresolvedDependency.code),
        summary: unresolvedDependency.summary,
        detail: unresolvedDependency.detail,
        fixHint: unresolvedDependency.fixHint,
        nextAction: repair.nextRecommendedStep,
        debugContext: {
          repairedDependencies: repair.repairedDependencies,
          skippedDependencies: repair.skippedDependencies,
          failedDependencies: repair.failedDependencies,
          manualActionsRequired: repair.manualActionsRequired,
        },
      } satisfies ManagedWslInstallerRecovery,
    };
  }

  private resolveHermesInstallFailure(
    result: NonNullable<ManagedWslInstallerReport["lastHermesInstall"]>,
    report: ManagedWslInstallerReport,
  ) {
    const failed = result.steps.find((step) => step.status === "failed");
    const failureCode = this.normalizeCode(
      failed?.code ?? (result.reDoctorStatus === "unsupported" ? "unsupported" : "hermes_healthcheck_failed"),
    );
    const failureStage = this.failureStageForCode(failureCode, failed?.step);
    const recovery = this.recoveryForInstallFailure(failureCode, result, report, failed?.detail ?? result.failedCommand?.stderrPreview ?? result.failedCommand?.stdoutPreview);
    if (failed) {
      return {
        step: installerStep({
          phase: failed.phase === "health_check" ? "health_check" : "install",
          step: failed.step,
          status: "failed",
          code: failureCode,
          summary: failed.summary,
          detail: failed.detail,
          fixHint: failed.fixHint ?? recovery.fixHint,
          debugContext: {
            ...failed.debugContext,
            recovery,
            failedCommand: result.failedCommand,
          },
        }),
        recovery,
      };
    }
    if (!result.healthCheckPassed || result.reDoctorStatus === "manual_setup_required" || result.reDoctorStatus === "unsupported") {
      return {
        step: installerStep({
          phase: "health_check",
          step: "verify-hermes",
          status: "failed",
          code: failureCode,
          summary: "Hermes 安装完成后 health check 仍未通过。",
          detail: result.steps.map((step) => `${step.code}: ${step.summary}`).join("\n"),
          fixHint: recovery.fixHint,
          debugContext: { failedCommand: result.failedCommand, recovery },
        }),
        recovery,
      };
    }
    return undefined;
  }

  private recoveryForInstallFailure(
    code: ManagedWslInstallerCode,
    result: NonNullable<ManagedWslInstallerReport["lastHermesInstall"]>,
    report: ManagedWslInstallerReport,
    detail?: string,
  ): ManagedWslInstallerRecovery {
    const failureStage = this.failureStageForCode(code);
    if (code === "repo_invalid") {
      return {
        failureStage,
        disposition: "non_retryable",
        code,
        summary: "当前 repo 处于不可安全自动恢复状态。",
        detail,
        fixHint: "请人工清理/修复该 repo 后再重试 install。",
        nextAction: "manual_repo_cleanup",
        debugContext: {
          repoStatus: result.repoStatus,
          failureArtifacts: result.failureArtifacts,
        },
      };
    }
    if (code === "bridge_unreachable") {
      return {
        failureStage,
        disposition: "manual_action_required",
        code,
        summary: "Bridge 不可达，当前无法通过 health/install 阶段。",
        detail,
        fixHint: "请先重启客户端/Bridge，再重试 install。",
        nextAction: "restart_bridge_and_retry",
        debugContext: {
          bridgeStatus: result.bridgeStatus ?? report.lastDoctor?.runtimeProbe.bridge,
          failureArtifacts: result.failureArtifacts,
        },
      };
    }
    if (code === "distro_unavailable") {
      return {
        failureStage,
        disposition: "retryable",
        code,
        summary: "Create Distro 失败或 distro 仍不可进入。",
        detail,
        fixHint: "请确认 WSL/发行版初始化状态后重试；若多次失败，请改为人工接管。",
        nextAction: "retry_create_distro",
        debugContext: { failureArtifacts: result.failureArtifacts },
      };
    }
    if (code === "repo_clone_failed") {
      return {
        failureStage,
        disposition: "retryable",
        code,
        summary: "Repo clone 失败，可在当前 repo/root 上继续重试。",
        detail,
        fixHint: "请检查网络、代理或 GitHub 访问，再重新点击 install。",
        nextAction: "retry_install",
        debugContext: {
          repoStatus: result.repoStatus,
          failedCommand: result.failedCommand,
        },
      };
    }
    if (code === "pip_install_failed") {
      return {
        failureStage,
        disposition: "retryable",
        code,
        summary: "pip install 失败，可从 pip_install 阶段继续重试。",
        detail,
        fixHint: "请确认 Python 构建环境、网络和 pip 输出后重新点击 install。",
        nextAction: "retry_install",
        debugContext: {
          venvStatus: result.venvStatus,
          failedCommand: result.failedCommand,
        },
      };
    }
    if (code === "hermes_healthcheck_failed") {
      return {
        failureStage,
        disposition: "retryable",
        code,
        summary: "health check 失败，可从 health_check 阶段继续重试。",
        detail,
        fixHint: "请查看 version/health 输出，必要时再次执行 install 触发恢复。",
        nextAction: "retry_install",
        debugContext: {
          failedCommand: result.failedCommand,
          reprobeStatus: result.reprobeStatus,
          reDoctorStatus: result.reDoctorStatus,
        },
      };
    }
    if (code === "python_missing" || code === "git_missing" || code === "pip_missing") {
      return {
        failureStage,
        disposition: "manual_action_required",
        code,
        summary: "WSL 依赖缺失，当前应先回到 repair。",
        detail,
        fixHint: "请先执行 dry-run / execute repair，再重新点击 install。",
        nextAction: "run_execute_repair",
        debugContext: { failureArtifacts: result.failureArtifacts },
      };
    }
    return {
      failureStage,
      disposition: "manual_action_required",
      code,
      summary: "当前失败尚不能自动恢复。",
      detail,
      fixHint: "请先查看 diagnostics / installer report，再决定是否人工处理后重试。",
      nextAction: "export_diagnostics",
      debugContext: { failureArtifacts: result.failureArtifacts },
    };
  }

  private failureStageForCode(code: ManagedWslInstallerCode, stepName?: string): ManagedWslInstallerResumeStage {
    if (code === "distro_unavailable") return "create_distro";
    if (code === "python_missing") return "ensure_python";
    if (code === "repo_invalid" || code === "repo_clone_failed" || stepName?.includes("repo")) return "ensure_repo";
    if (code === "venv_unavailable" || stepName?.includes("venv")) return "ensure_venv";
    if (code === "pip_missing" || code === "pip_install_failed" || stepName?.includes("pip")) return "pip_install";
    if (code === "hermes_healthcheck_failed" || code === "bridge_unreachable") return "health_check";
    return "doctor";
  }

  private determineResumeFromStage(previous: ManagedWslInstallerReport | undefined, doctor: WslDoctorReport) {
    if (!previous?.recovery || previous.recovery.disposition !== "retryable" || !previous.lastSuccessfulStage) {
      return undefined;
    }
    const previousDistro = previous.distroName?.trim();
    const currentDistro = (doctor.runtime.distro ?? doctor.runtimeProbe.distroName)?.trim();
    if (previousDistro && currentDistro && previousDistro !== currentDistro) {
      return undefined;
    }
    return nextInstallerStage(previous.lastSuccessfulStage);
  }

  private toDependencyResult(check: WslRepairDependencyCheck | undefined, dependency: WslRepairDependencyId): ManagedWslInstallerDependencyResult {
    if (!check) return emptyDependencyResult(dependency);
    return {
      dependency,
      status: check.status,
      code: this.normalizeCode(check.code),
      summary: check.summary,
      detail: check.detail,
      fixHint: check.fixHint,
      debugContext: check.debugContext,
    };
  }

  private primaryDependencyCode(checks: WslRepairDependencyCheck[]): ManagedWslInstallerCode {
    const first = checks.find((check) => check.status !== "ok");
    return first ? this.normalizeCode(first.code) : "ok";
  }

  private baseArtifacts(report: ManagedWslInstallerReport, doctor: WslDoctorReport): ManagedWslInstallerFailureArtifacts {
    return this.mergeArtifacts(report.failureArtifacts, {
      distroName: doctor.runtime.distro ?? doctor.runtimeProbe.distroName,
      managedRoot: doctor.runtime.managedRoot,
      bridgeStatus: doctor.runtimeProbe.bridge,
      lastSuccessfulStage: report.lastSuccessfulStage,
      recommendedRecoveryAction: report.nextRecommendedStep,
    }) ?? {};
  }

  private mergeArtifacts(
    current: ManagedWslInstallerFailureArtifacts | undefined,
    next: ManagedWslInstallerFailureArtifacts | undefined,
  ): ManagedWslInstallerFailureArtifacts | undefined {
    if (!current) return next ? { ...next } : undefined;
    if (!next) return current;
    return {
      ...current,
      ...next,
      repoStatus: next.repoStatus ?? current.repoStatus,
      venvStatus: next.venvStatus ?? current.venvStatus,
      bridgeStatus: next.bridgeStatus ?? current.bridgeStatus,
      failedCommand: next.failedCommand ?? current.failedCommand,
      lastSuccessfulStage: next.lastSuccessfulStage ?? current.lastSuccessfulStage,
      recommendedRecoveryAction: next.recommendedRecoveryAction ?? current.recommendedRecoveryAction,
    };
  }

  private normalizeCode(code: string): ManagedWslInstallerCode {
    if (code === "python_missing" || code === "python3_missing" || code === "wsl_python_missing") return "python_missing";
    if (code === "git_missing" || code === "git_missing_in_wsl") return "git_missing";
    if (code === "pip_missing" || code === "pip_unavailable") return "pip_missing";
    if (code === "venv_unavailable" || code === "venv_create_skipped") return "venv_unavailable";
    if (code === "repo_invalid" || code === "existing_repo_invalid") return "repo_invalid";
    if (code === "repo_clone_failed" || code === "repo_update_failed") return "repo_clone_failed";
    if (code === "pip_install_failed") return "pip_install_failed";
    if (code === "hermes_healthcheck_failed" || code === "hermes_version_failed") return "hermes_healthcheck_failed";
    if (code === "bridge_unreachable") return "bridge_unreachable";
    if (code === "distro_unavailable" || code === "wsl_distro_missing" || code === "wsl_distro_unreachable" || code === "distro_create_failed" || code === "distro_unreachable") {
      return "distro_unavailable";
    }
    if (code === "unsupported" || code === "wsl_missing") return "unsupported";
    if (code === "manual_action_required" || code === "manual_create_required" || code === "repair_planned") return "manual_action_required";
    return "ok";
  }

  private toPublishStage(phase: ManagedWslInstallerPhase, status: ManagedWslInstallerStatus): HermesInstallEvent["stage"] {
    if (status === "failed" || status === "blocked") return "failed";
    if (phase === "repair") return "repairing_dependencies";
    if (phase === "health_check") return "health_check";
    if (phase === "completed") return "completed";
    if (phase === "install") return "installing_dependencies";
    return "preflight";
  }

  private progressForState(state: ManagedWslInstallerState) {
    if (state === "doctor_started") return 10;
    if (state === "repair_planned") return 20;
    if (state === "repair_executing") return 35;
    if (state === "distro_ready") return 55;
    if (state === "hermes_install_started") return 70;
    if (state === "hermes_install_ready") return 95;
    if (state === "completed") return 100;
    return 15;
  }

  private async finalize(report: ManagedWslInstallerReport) {
    report.finishedAt = new Date().toISOString();
    const dir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    await fs.mkdir(dir, { recursive: true });
    const reportPath = path.join(dir, "managed-wsl-installer-last.json");
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    report.reportPath = reportPath;
    this.lastInstallReport = report;
    return report;
  }
}
