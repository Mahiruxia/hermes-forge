import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { RuntimeProbeService } from "../runtime/runtime-probe-service";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import { runCommand, type CommandResult } from "../process/command-runner";
import type { RuntimeConfig } from "../shared/types";
import { installStep } from "./install-types";
import type { WslDoctorService } from "./wsl-doctor-service";
import type { WslDoctorReport, WslHermesInstallResult } from "./wsl-doctor-types";
import {
  compareInstallerStage,
  type ManagedWslInstallerFailureCommand,
  type ManagedWslInstallerRecoveryAction,
  type ManagedWslInstallerResumeStage,
} from "./managed-wsl-recovery-types";

const DEFAULT_HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";
const DEFAULT_PINNED_SOURCE = {
  repoUrl: "https://github.com/Mahiruxia/hermes-agent.git",
  branch: "codex/launch-metadata-capabilities",
  commit: "55af678ec474bfd21ca5697dac08ef4f3fb59c37",
  sourceLabel: "pinned" as const,
};

type PythonCheckResult = {
  ok: boolean;
  python?: string;
  step: ReturnType<typeof installStep>;
  failedCommand?: ManagedWslInstallerFailureCommand;
};

type RepoEnsureResult = {
  ok: boolean;
  steps: Array<ReturnType<typeof installStep>>;
  repoStatus: NonNullable<WslHermesInstallResult["repoStatus"]>;
  failedCommand?: ManagedWslInstallerFailureCommand;
};

type VenvEnsureResult = {
  ok: boolean;
  python: string;
  venvPath?: string;
  step: ReturnType<typeof installStep>;
  venvStatus: NonNullable<WslHermesInstallResult["venvStatus"]>;
  failedCommand?: ManagedWslInstallerFailureCommand;
};

type InstallDepsResult = {
  ok: boolean;
  executed: boolean;
  steps: Array<ReturnType<typeof installStep>>;
  failedCommand?: ManagedWslInstallerFailureCommand;
};

type VerifyResult = {
  ok: boolean;
  version: string;
  capabilityProbe?: {
    minimumSatisfied: boolean;
    cliVersion?: string;
    missing?: string[];
    supportsLaunchMetadataArg: boolean;
    supportsLaunchMetadataEnv: boolean;
    supportsResume: boolean;
  };
  steps: Array<ReturnType<typeof installStep>>;
  failedCommand?: ManagedWslInstallerFailureCommand;
};

type ExistingHermesAttachResult = {
  ok: boolean;
  rootPath?: string;
  cliPath?: string;
  python?: string;
  version?: string;
  capabilityProbe?: VerifyResult["capabilityProbe"];
  steps: Array<ReturnType<typeof installStep>>;
};

export class WslHermesInstallService {
  private lastInstallResult?: WslHermesInstallResult;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly configStore: RuntimeConfigStore,
    private readonly runtimeProbeService: RuntimeProbeService,
    private readonly runtimeAdapterFactory: RuntimeAdapterFactory,
    private readonly doctorService: WslDoctorService,
  ) {}

  getLastInstallResult() {
    return this.lastInstallResult;
  }

  async install(options: {
    report?: WslDoctorReport;
    resumeFromStage?: ManagedWslInstallerResumeStage;
    previousResult?: WslHermesInstallResult;
  } = {}): Promise<WslHermesInstallResult> {
    const requestedAt = new Date().toISOString();
    const report = options.report ?? await this.doctorService.diagnose();
    const runtime = report.runtime;
    const resumedFromStage = options.resumeFromStage;
    const previousResult = options.previousResult;
    const steps = [
      installStep({
        phase: "preflight",
        step: "doctor-preconditions",
        status: report.overallStatus === "unsupported" ? "failed" : "passed",
        code: report.overallStatus === "unsupported" ? "unsupported" : "ok",
        summary: report.overallStatus === "unsupported"
          ? "当前环境还不能进入受管 WSL Hermes 安装。"
          : "WSL 环境前置检查完成。",
        detail: report.blockingIssues.map((issue) => issue.summary).join("；"),
      }),
    ];
    let lastSuccessfulStage: ManagedWslInstallerResumeStage | undefined;
    let failedCommand: ManagedWslInstallerFailureCommand | undefined;
    let repoStatus: WslHermesInstallResult["repoStatus"] = {
      state: "missing",
      detail: "Repo 尚未检查。",
    };
    let venvStatus: WslHermesInstallResult["venvStatus"] = {
      state: "missing",
      detail: "Venv 尚未检查。",
    };

    if (report.overallStatus === "unsupported" || report.blockingIssues.some((issue) => ["wsl_missing", "wsl_distro_missing", "wsl_distro_unreachable"].includes(issue.code))) {
      return this.finalize({
        requestedAt,
        distroName: runtime.distro ?? "unknown",
        hermesRoot: runtime.managedRoot ?? "",
        repoReady: false,
        installExecuted: false,
        healthCheckPassed: false,
        resumedFromStage,
        lastSuccessfulStage,
        repoStatus,
        venvStatus,
        bridgeStatus: report.runtimeProbe.bridge,
        failureArtifacts: {
          distroName: runtime.distro,
          managedRoot: runtime.managedRoot,
          repoStatus,
          venvStatus,
          bridgeStatus: report.runtimeProbe.bridge,
          lastSuccessfulStage,
          recommendedRecoveryAction: "manual_create_distro",
        },
        steps: [
          ...steps,
          installStep({
            phase: "preflight",
            step: "block-install",
            status: "failed",
            code: report.blockingIssues.some((issue) => issue.code === "bridge_unreachable") ? "bridge_unreachable" : "distro_unavailable",
            summary: "当前 WSL 环境不可用，已停止 Hermes 安装。",
            detail: report.blockingIssues.map((issue) => `${issue.code}: ${issue.summary}`).join("\n"),
            fixHint: report.recommendedActions[0],
          }),
        ],
        debugContext: { doctor: report },
      });
    }

    const hermesRoot = await this.ensureHermesRoot(runtime);
    await this.persistManagedRoot(hermesRoot);
    steps.push(installStep({
      phase: "preflight",
      step: "ensure-hermes-root",
      status: "passed",
      code: "hermes_root_resolved",
      summary: "已准备 Hermes 安装目录。",
      detail: hermesRoot,
      debugContext: this.managedRootPolicy(hermesRoot),
    }));

    const python = await this.ensurePython(runtime);
    steps.push(python.step);
    if (!python.ok) {
      failedCommand = python.failedCommand;
      return this.finalize({
        requestedAt,
        distroName: runtime.distro ?? "unknown",
        hermesRoot,
        pythonResolved: python.python,
        repoReady: false,
        installExecuted: false,
        healthCheckPassed: false,
        resumedFromStage,
        lastSuccessfulStage,
        repoStatus,
        venvStatus,
        bridgeStatus: report.runtimeProbe.bridge,
        failedCommand,
        failureArtifacts: this.failureArtifacts({
          failedCommand,
          distroName: runtime.distro,
          managedRoot: hermesRoot,
          repoStatus,
          venvStatus,
          bridgeStatus: report.runtimeProbe.bridge,
          lastSuccessfulStage,
          recommendedRecoveryAction: "run_execute_repair",
        }),
        steps,
        debugContext: { doctor: report },
      });
    }
    lastSuccessfulStage = "ensure_python";

    const existingHermes = await this.tryAttachExistingHermes(runtime, hermesRoot, python.python ?? "python3");
    steps.push(...existingHermes.steps);
    if (existingHermes.ok && existingHermes.rootPath && existingHermes.python) {
      const attachedRuntime = { ...runtime, managedRoot: existingHermes.rootPath };
      await this.persistManagedRoot(existingHermes.rootPath);
      const reprobe = await this.runtimeProbeService.probe({ runtime: attachedRuntime, persistResolvedHermesPath: true });
      const reDoctor = await this.doctorService.diagnose({ runtime: attachedRuntime });
      const reprobeHasHermesFailure = reprobe.issues.some((issue) =>
        issue.severity === "error" && ["hermes_root_missing", "hermes_cli_missing", "wsl_missing", "wsl_distro_missing", "wsl_distro_unreachable", "wsl_python_missing"].includes(issue.code),
      );
      const doctorHasHermesFailure = reDoctor.blockingIssues.some((issue) =>
        ["hermes_root_missing", "hermes_cli_missing", "wsl_missing", "wsl_distro_missing", "wsl_distro_unreachable", "wsl_python_missing"].includes(issue.code),
      );
      steps.push(installStep({
        phase: "health_check",
        step: "reprobe-after-import",
        status: !reprobeHasHermesFailure ? "passed" : "failed",
        code: "runtime_reprobed",
        summary: `导入已有 Hermes 后 reprobe 完成：${reprobe.overallStatus}`,
        detail: reprobeHasHermesFailure
          ? reprobe.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.code}: ${issue.summary}`).join("\n")
          : undefined,
        debugContext: { overallStatus: reprobe.overallStatus, importedRoot: existingHermes.rootPath },
      }));
      steps.push(installStep({
        phase: "health_check",
        step: "redoctor-after-import",
        status: !doctorHasHermesFailure ? "passed" : "failed",
        code: "doctor_reran",
        summary: `导入已有 Hermes 后 re-doctor 完成：${reDoctor.overallStatus}`,
        detail: doctorHasHermesFailure
          ? reDoctor.blockingIssues.map((issue) => `${issue.code}: ${issue.summary}`).join("\n")
          : undefined,
        debugContext: { overallStatus: reDoctor.overallStatus, importedRoot: existingHermes.rootPath },
      }));
      const importHealthy = !reprobeHasHermesFailure && !doctorHasHermesFailure;
      lastSuccessfulStage = importHealthy ? "health_check" : "ensure_python";
      return this.finalize({
        requestedAt,
        distroName: runtime.distro ?? "unknown",
        hermesRoot: existingHermes.rootPath,
        pythonResolved: existingHermes.python,
        venvPath: existingHermes.python.includes("/.venv/bin/python") ? existingHermes.python.replace(/\/bin\/python$/, "") : undefined,
        hermesVersion: existingHermes.version,
        capabilityProbe: existingHermes.capabilityProbe,
        repoReady: true,
        installExecuted: false,
        healthCheckPassed: importHealthy,
        resumedFromStage,
        lastSuccessfulStage,
        repoStatus: {
          state: "reused",
          root: existingHermes.rootPath,
          detail: `已导入 WSL 中已有 Hermes CLI：${existingHermes.cliPath}`,
        },
        venvStatus: {
          state: existingHermes.python.includes("/.venv/bin/python") ? "reused" : "skipped",
          path: existingHermes.python.includes("/.venv/bin/python") ? existingHermes.python.replace(/\/bin\/python$/, "") : undefined,
          detail: `使用已有 Python 启动方式：${existingHermes.python}`,
        },
        bridgeStatus: reprobe.bridge,
        reprobeStatus: reprobe.overallStatus,
        reDoctorStatus: reDoctor.overallStatus,
        failureArtifacts: this.failureArtifacts({
          distroName: runtime.distro,
          managedRoot: existingHermes.rootPath,
          repoStatus: { state: "reused", root: existingHermes.rootPath },
          venvStatus: { state: "reused", path: existingHermes.python },
          bridgeStatus: reprobe.bridge,
          lastSuccessfulStage,
          recommendedRecoveryAction: importHealthy ? "none" : "retry_install",
        }),
        steps,
        debugContext: {
          managedRootPolicy: this.managedRootPolicy(existingHermes.rootPath),
          importedCliPath: existingHermes.cliPath,
          version: existingHermes.version,
        },
      });
    }

    const repo = this.shouldReuseRepo(resumedFromStage, previousResult, hermesRoot)
      ? await this.reuseExistingRepo(runtime, hermesRoot)
      : await this.ensureHermesRepo(runtime, hermesRoot);
    steps.push(...repo.steps);
    repoStatus = repo.repoStatus;
    if (!repo.ok) {
      failedCommand = repo.failedCommand;
      return this.finalize({
        requestedAt,
        distroName: runtime.distro ?? "unknown",
        hermesRoot,
        pythonResolved: python.python,
        repoReady: false,
        installExecuted: false,
        healthCheckPassed: false,
        resumedFromStage,
        lastSuccessfulStage,
        repoStatus,
        venvStatus,
        bridgeStatus: report.runtimeProbe.bridge,
        failedCommand,
        failureArtifacts: this.failureArtifacts({
          failedCommand,
          distroName: runtime.distro,
          managedRoot: hermesRoot,
          repoStatus,
          venvStatus,
          bridgeStatus: report.runtimeProbe.bridge,
          lastSuccessfulStage,
          recommendedRecoveryAction: repoStatus?.state === "invalid" ? "manual_repo_cleanup" : "retry_install",
        }),
        steps,
        debugContext: { repo: repoStatus },
      });
    }
    lastSuccessfulStage = "ensure_repo";

    const basePython = python.python ?? "python3";
    const venv = await this.ensureVirtualEnv(runtime, hermesRoot, basePython);
    steps.push(venv.step);
    venvStatus = venv.venvStatus;
    if (!venv.ok) {
      failedCommand = venv.failedCommand;
      return this.finalize({
        requestedAt,
        distroName: runtime.distro ?? "unknown",
        hermesRoot,
        pythonResolved: basePython,
        venvPath: venv.venvPath,
        repoReady: true,
        installExecuted: false,
        healthCheckPassed: false,
        resumedFromStage,
        lastSuccessfulStage,
        repoStatus,
        venvStatus,
        bridgeStatus: report.runtimeProbe.bridge,
        failedCommand,
        failureArtifacts: this.failureArtifacts({
          failedCommand,
          distroName: runtime.distro,
          managedRoot: hermesRoot,
          repoStatus,
          venvStatus,
          bridgeStatus: report.runtimeProbe.bridge,
          lastSuccessfulStage,
          recommendedRecoveryAction: "run_execute_repair",
        }),
        steps,
        debugContext: { repoStatus, venvStatus },
      });
    }
    const installPython = venv.python ?? basePython;
    lastSuccessfulStage = "ensure_venv";

    const installDeps = this.shouldSkipPipInstall(resumedFromStage, previousResult, hermesRoot)
      ? this.skipPipInstallForHealthRetry()
      : await this.installHermesDependencies(runtime, hermesRoot, installPython);
    steps.push(...installDeps.steps);
    if (!installDeps.ok) {
      failedCommand = installDeps.failedCommand;
      return this.finalize({
        requestedAt,
        distroName: runtime.distro ?? "unknown",
        hermesRoot,
        pythonResolved: installPython,
        venvPath: venv.venvPath,
        repoReady: true,
        installExecuted: installDeps.executed,
        healthCheckPassed: false,
        resumedFromStage,
        lastSuccessfulStage,
        repoStatus,
        venvStatus,
        bridgeStatus: report.runtimeProbe.bridge,
        failedCommand,
        failureArtifacts: this.failureArtifacts({
          failedCommand,
          distroName: runtime.distro,
          managedRoot: hermesRoot,
          repoStatus,
          venvStatus,
          bridgeStatus: report.runtimeProbe.bridge,
          lastSuccessfulStage,
          recommendedRecoveryAction: "retry_install",
        }),
        steps,
        debugContext: { installPython, repoStatus, venvStatus },
      });
    }
    lastSuccessfulStage = "pip_install";

    const verify = await this.verifyHermesInstall(runtime, hermesRoot, installPython);
    steps.push(...verify.steps);
    const reprobe = await this.runtimeProbeService.probe({ runtime, persistResolvedHermesPath: true });
    const reDoctor = await this.doctorService.diagnose({ runtime });
    const hermesVerified = verify.ok && verify.capabilityProbe?.minimumSatisfied !== false;
    const reprobeHasHermesFailure = reprobe.issues.some((issue) =>
      issue.severity === "error" && ["hermes_root_missing", "hermes_cli_missing", "wsl_missing", "wsl_distro_missing", "wsl_distro_unreachable", "wsl_python_missing"].includes(issue.code),
    );
    const doctorHasHermesFailure = reDoctor.blockingIssues.some((issue) =>
      ["hermes_root_missing", "hermes_cli_missing", "wsl_missing", "wsl_distro_missing", "wsl_distro_unreachable", "wsl_python_missing"].includes(issue.code),
    );
    steps.push(installStep({
      phase: "health_check",
      step: "reprobe-after-install",
      status: hermesVerified && !reprobeHasHermesFailure ? "passed" : "failed",
      code: "runtime_reprobed",
      summary: `安装后 reprobe 完成：${reprobe.overallStatus}`,
      detail: reprobeHasHermesFailure
        ? reprobe.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.code}: ${issue.summary}`).join("\n")
        : undefined,
      debugContext: { overallStatus: reprobe.overallStatus, hermesVerified },
    }));
    steps.push(installStep({
      phase: "health_check",
      step: "redoctor-after-install",
      status: hermesVerified && !doctorHasHermesFailure ? "passed" : "failed",
      code: "doctor_reran",
      summary: `安装后 re-doctor 完成：${reDoctor.overallStatus}`,
      detail: doctorHasHermesFailure
        ? reDoctor.blockingIssues.map((issue) => `${issue.code}: ${issue.summary}`).join("\n")
        : undefined,
      debugContext: { overallStatus: reDoctor.overallStatus, hermesVerified },
    }));

    if (!hermesVerified || reprobeHasHermesFailure || doctorHasHermesFailure) {
      failedCommand = verify.failedCommand;
      return this.finalize({
        requestedAt,
        distroName: runtime.distro ?? "unknown",
        hermesRoot,
        pythonResolved: installPython,
        venvPath: venv.venvPath,
        hermesVersion: verify.version,
        capabilityProbe: verify.capabilityProbe,
        repoReady: true,
        installExecuted: installDeps.executed,
        healthCheckPassed: false,
        resumedFromStage,
        lastSuccessfulStage,
        repoStatus,
        venvStatus,
        bridgeStatus: reprobe.bridge,
        failedCommand,
        reprobeStatus: reprobe.overallStatus,
        reDoctorStatus: reDoctor.overallStatus,
        failureArtifacts: this.failureArtifacts({
          failedCommand,
          distroName: runtime.distro,
          managedRoot: hermesRoot,
          repoStatus,
          venvStatus,
          bridgeStatus: reprobe.bridge,
          lastSuccessfulStage,
          recommendedRecoveryAction: "retry_install",
        }),
        steps,
        debugContext: {
          managedRootPolicy: this.managedRootPolicy(hermesRoot),
          version: verify.version,
        },
      });
    }
    lastSuccessfulStage = "health_check";

    return this.finalize({
      requestedAt,
      distroName: runtime.distro ?? "unknown",
      hermesRoot,
      pythonResolved: installPython,
      venvPath: venv.venvPath,
      hermesVersion: verify.version,
      capabilityProbe: verify.capabilityProbe,
      repoReady: true,
      installExecuted: installDeps.executed,
      healthCheckPassed: true,
      resumedFromStage,
      lastSuccessfulStage,
      repoStatus,
      venvStatus,
      bridgeStatus: reprobe.bridge,
      reprobeStatus: reprobe.overallStatus,
      reDoctorStatus: reDoctor.overallStatus,
      failureArtifacts: this.failureArtifacts({
        distroName: runtime.distro,
        managedRoot: hermesRoot,
        repoStatus,
        venvStatus,
        bridgeStatus: reprobe.bridge,
        lastSuccessfulStage,
        recommendedRecoveryAction: "none",
      }),
      steps,
      debugContext: {
        managedRootPolicy: this.managedRootPolicy(hermesRoot),
        version: verify.version,
      },
    });
  }

  private async ensurePython(runtime: WslDoctorReport["runtime"]): Promise<PythonCheckResult> {
    const result = await this.runInDistro(runtime, "python3 --version", "install.wsl.ensure-python");
    if (result.exitCode !== 0) {
      return {
        ok: false,
        python: undefined,
        failedCommand: commandSummary(result),
        step: installStep({
          phase: "preflight",
          step: "ensure-python",
          status: "failed",
          code: "python_missing",
          summary: "WSL 中缺少可用的 Python 3。",
          detail: result.stderr || result.stdout,
          fixHint: "请先执行 Managed WSL repair，或在该 distro 内手动安装 python3。",
        }),
      };
    }
    return {
      ok: true,
      python: "python3",
      step: installStep({
        phase: "preflight",
        step: "ensure-python",
        status: "passed",
        code: "python3_available",
        summary: "已确认 WSL 中的 Python 3 可用。",
        detail: result.stdout.trim(),
      }),
    };
  }

  private async ensureHermesRoot(runtime: WslDoctorReport["runtime"]) {
    const home = await this.runInDistro(runtime, "printf %s \"$HOME\"", "install.wsl.resolve-home");
    const baseHome = (home.stdout || "").trim();
    const hermesRoot = runtime.managedRoot?.trim() || `${baseHome}/.hermes-forge/hermes-agent`;
    await this.runInDistro(runtime, `mkdir -p ${shellQuote(hermesRoot)}`, "install.wsl.mkdir-root");
    return hermesRoot;
  }

  private shouldReuseRepo(
    resumedFromStage: ManagedWslInstallerResumeStage | undefined,
    previousResult: WslHermesInstallResult | undefined,
    hermesRoot: string,
  ) {
    return Boolean(
      resumedFromStage
      && compareInstallerStage(resumedFromStage, "ensure_repo") >= 0
      && previousResult?.repoReady
      && previousResult.hermesRoot === hermesRoot,
    );
  }

  private async tryAttachExistingHermes(
    runtime: WslDoctorReport["runtime"],
    hermesRoot: string,
    basePython: string,
  ): Promise<ExistingHermesAttachResult> {
    const candidates = await this.discoverExistingHermesCandidates(runtime, hermesRoot);
    const failures: string[] = [];
    for (const cliPath of candidates) {
      const file = await this.runInDistro(runtime, `[ -f ${shellQuote(cliPath)} ] && [ -r ${shellQuote(cliPath)} ] && echo yes || echo no`, "install.wsl.existing-hermes-file");
      if ((file.stdout || "").trim() !== "yes") {
        failures.push(`${cliPath}: 文件不存在或不可读`);
        continue;
      }
      const rootPath = dirnamePosix(cliPath);
      const python = await this.resolveExistingHermesPython(runtime, rootPath, basePython);
      const version = await this.runInDistro(runtime, `cd ${shellQuote(rootPath)} && ${shellQuote(python)} ${shellQuote(cliPath)} --version`, "install.wsl.existing-hermes-version");
      const capabilities = await this.runInDistro(runtime, `cd ${shellQuote(rootPath)} && ${shellQuote(python)} ${shellQuote(cliPath)} capabilities --json`, "install.wsl.existing-hermes-capabilities");
      const capabilityProbe = this.parseCapabilityProbe(capabilities);
      if (version.exitCode === 0 && capabilityProbe.minimumSatisfied) {
        return {
          ok: true,
          rootPath,
          cliPath,
          python,
          version: version.stdout.trim(),
          capabilityProbe,
          steps: [installStep({
            phase: "preflight",
            step: "import-existing-hermes",
            status: "passed",
            code: "ok",
            summary: "已发现并导入 WSL 中已有 Hermes Agent。",
            detail: [`CLI: ${cliPath}`, `Python: ${python}`, version.stdout.trim(), capabilities.stdout.trim()].filter(Boolean).join("\n"),
            fixHint: "已复用现有安装，本轮不会覆盖该目录。",
          })],
        };
      }
      const existingHermesOutput = [version.stderr, version.stdout, capabilities.stderr, capabilities.stdout].filter(Boolean).join("\n");
      if (shouldRepairExistingHermesDependencies(existingHermesOutput)) {
        const repaired = await this.createDependencyRepairedHermesWrapper(runtime, cliPath, rootPath, basePython);
        if (repaired.ok) {
          const repairedVersion = await this.runInDistro(runtime, `cd ${shellQuote(repaired.rootPath)} && ${shellQuote(repaired.python)} ${shellQuote(repaired.cliPath)} --version`, "install.wsl.repaired-existing-hermes-version");
          const repairedCapabilities = await this.runInDistro(runtime, `cd ${shellQuote(repaired.rootPath)} && ${shellQuote(repaired.python)} ${shellQuote(repaired.cliPath)} capabilities --json`, "install.wsl.repaired-existing-hermes-capabilities");
          const repairedCapabilityProbe = this.parseCapabilityProbe(repairedCapabilities);
          if (repairedVersion.exitCode === 0 && repairedCapabilityProbe.minimumSatisfied) {
            return {
              ok: true,
              rootPath: repaired.rootPath,
              cliPath: repaired.cliPath,
              python: repaired.python,
              version: repairedVersion.stdout.trim(),
              capabilityProbe: repairedCapabilityProbe,
              steps: [installStep({
                phase: "preflight",
                step: "repair-existing-hermes-deps",
                status: "passed",
                code: "ok",
                summary: "已复用已有 Hermes，并为它补齐 WSL Python 依赖。",
                detail: [
                  `Original CLI: ${cliPath}`,
                  `Wrapper: ${repaired.cliPath}`,
                  `Python: ${repaired.python}`,
                  repaired.detail,
                  repairedVersion.stdout.trim(),
                  repairedCapabilities.stdout.trim(),
                ].filter(Boolean).join("\n"),
                fixHint: "已在 WSL HOME 下创建 Forge 管理的轻量 wrapper；原 Hermes 目录没有被覆盖。",
              })],
            };
          }
          failures.push(`${cliPath}: 依赖修复 wrapper 已创建，但 capability 仍未通过：${repairedCapabilities.stderr || repairedCapabilities.stdout || `exit ${repairedCapabilities.exitCode}`}`);
          continue;
        }
        failures.push(`${cliPath}: 检测到 Python 依赖缺失，但自动创建 WSL venv wrapper 失败：${repaired.detail}`);
        continue;
      }
      const directVersion = await this.runInDistro(runtime, `cd ${shellQuote(rootPath)} && ${shellQuote(cliPath)} --version`, "install.wsl.existing-hermes-direct-version");
      const directCapabilities = await this.runInDistro(runtime, `cd ${shellQuote(rootPath)} && ${shellQuote(cliPath)} capabilities --json`, "install.wsl.existing-hermes-direct-capabilities");
      const directCapabilityProbe = this.parseCapabilityProbe(directCapabilities);
      if (directVersion.exitCode === 0 && directCapabilityProbe.minimumSatisfied) {
        const wrapper = await this.createAttachedHermesWrapper(runtime, cliPath, basePython);
        if (wrapper.ok) {
          return {
            ok: true,
            rootPath: wrapper.rootPath,
            cliPath: wrapper.cliPath,
            python: basePython,
            version: directVersion.stdout.trim(),
            capabilityProbe: directCapabilityProbe,
            steps: [installStep({
              phase: "preflight",
              step: "import-existing-hermes",
              status: "passed",
              code: "ok",
              summary: "已发现并导入 WSL 中已有 Hermes 命令。",
              detail: [`Original CLI: ${cliPath}`, `Wrapper: ${wrapper.cliPath}`, `Python: ${basePython}`, directVersion.stdout.trim(), directCapabilities.stdout.trim()].filter(Boolean).join("\n"),
              fixHint: "已创建轻量 wrapper 连接到现有 Hermes 命令，本轮不会覆盖原目录。",
            })],
          };
        }
        failures.push(`${cliPath}: 直接执行可用，但创建 Forge wrapper 失败：${wrapper.detail}`);
        continue;
      }
      failures.push(`${cliPath}: ${version.stderr || version.stdout || `version exit ${version.exitCode}`} ${capabilities.stderr || capabilities.stdout || `capabilities exit ${capabilities.exitCode}`}`.trim());
    }
    return {
      ok: false,
      steps: [installStep({
        phase: "preflight",
        step: "import-existing-hermes",
        status: "skipped",
        code: "ok",
        summary: candidates.length ? "未发现可直接导入的已有 Hermes，将继续安装/修复流程。" : "未发现 WSL 中已有 Hermes，将继续安装流程。",
        detail: failures.slice(0, 8).join("\n"),
        fixHint: candidates.length ? "如果你已有 Hermes，请确认该目录下的 hermes 能执行 capabilities --json，并满足 Forge 最低能力。" : undefined,
      })],
    };
  }

  private async discoverExistingHermesCandidates(runtime: WslDoctorReport["runtime"], hermesRoot: string) {
    const rootCandidates = [
      `${hermesRoot.replace(/\/+$/, "")}/hermes`,
      runtime.managedRoot?.trim() ? `${runtime.managedRoot.trim().replace(/\/+$/, "")}/hermes` : undefined,
    ].filter((item): item is string => Boolean(item));
    const script = [
      "set +e",
      "{",
      ...rootCandidates.map((candidate) => `printf '%s\\n' ${shellQuote(candidate)}`),
      "printf '%s\\n' \"$HOME/.hermes-forge/hermes-agent/hermes\"",
      "printf '%s\\n' \"$HOME/hermes-agent/hermes\"",
      "printf '%s\\n' \"$HOME/Hermes Agent/hermes\"",
      "command -v hermes 2>/dev/null || true",
      "find \"$HOME\" -maxdepth 4 -type f -name hermes 2>/dev/null | head -20",
      "} | awk 'NF && !seen[$0]++'",
    ].join("\n");
    const result = await this.runInDistro(runtime, script, "install.wsl.find-existing-hermes");
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  private async resolveExistingHermesPython(runtime: WslDoctorReport["runtime"], rootPath: string, basePython: string) {
    const result = await this.runInDistro(
      runtime,
      `[ -x ${shellQuote(`${rootPath}/.venv/bin/python`)} ] && printf %s ${shellQuote(`${rootPath}/.venv/bin/python`)} || printf %s ${shellQuote(basePython)}`,
      "install.wsl.existing-hermes-python",
    );
    return (result.stdout || "").trim() || basePython;
  }

  private async createAttachedHermesWrapper(runtime: WslDoctorReport["runtime"], targetCliPath: string, python: string) {
    const home = await this.runInDistro(runtime, "printf %s \"$HOME\"", "install.wsl.attached-wrapper-home");
    const baseHome = (home.stdout || "").trim();
    if (!baseHome) return { ok: false, detail: home.stderr || home.stdout || "无法解析 WSL HOME" };
    const rootPath = `${baseHome.replace(/\/+$/, "")}/.hermes-forge/attached-hermes`;
    const cliPath = `${rootPath}/hermes`;
    const wrapper = [
      "#!/usr/bin/env python3",
      "import os",
      "import sys",
      `TARGET = ${JSON.stringify(targetCliPath)}`,
      "os.execv(TARGET, [TARGET, *sys.argv[1:]])",
      "",
    ].join("\n");
    const create = await this.runInDistro(
      runtime,
      `mkdir -p ${shellQuote(rootPath)} && cat > ${shellQuote(cliPath)} <<'PY'\n${wrapper}PY\nchmod +x ${shellQuote(cliPath)} && ${shellQuote(python)} ${shellQuote(cliPath)} capabilities --json >/dev/null`,
      "install.wsl.create-attached-wrapper",
    );
    return create.exitCode === 0
      ? { ok: true, rootPath, cliPath }
      : { ok: false, detail: create.stderr || create.stdout || `exit ${create.exitCode}` };
  }

  private async createDependencyRepairedHermesWrapper(
    runtime: WslDoctorReport["runtime"],
    targetCliPath: string,
    targetRootPath: string,
    basePython: string,
  ) {
    const home = await this.runInDistro(runtime, "printf %s \"$HOME\"", "install.wsl.repaired-wrapper-home");
    const baseHome = (home.stdout || "").trim();
    if (!baseHome) return { ok: false as const, detail: home.stderr || home.stdout || "无法解析 WSL HOME" };
    const hash = createHash("sha1").update(targetCliPath).digest("hex").slice(0, 12);
    const rootPath = `${baseHome.replace(/\/+$/, "")}/.hermes-forge/attached-hermes-${hash}`;
    const cliPath = `${rootPath}/hermes`;
    const venvPython = `${rootPath}/.venv/bin/python`;
    const wrapper = [
      "#!/usr/bin/env python3",
      "import os",
      "import sys",
      `VENV_PYTHON = ${JSON.stringify(venvPython)}`,
      `TARGET = ${JSON.stringify(targetCliPath)}`,
      "os.execv(VENV_PYTHON, [VENV_PYTHON, TARGET, *sys.argv[1:]])",
      "",
    ].join("\n");
    const installScript = [
      "set -e",
      `mkdir -p ${shellQuote(rootPath)}`,
      `[ -x ${shellQuote(venvPython)} ] || ${shellQuote(basePython)} -m venv ${shellQuote(`${rootPath}/.venv`)}`,
      `${shellQuote(venvPython)} -m pip install --upgrade pip`,
      `[ -f ${shellQuote(`${targetRootPath}/pyproject.toml`)} ] && (cd ${shellQuote(targetRootPath)} && ${shellQuote(venvPython)} -m pip install -e .) || ${shellQuote(venvPython)} -m pip install python-dotenv PyYAML`,
      `cat > ${shellQuote(cliPath)} <<'PY'\n${wrapper}PY`,
      `chmod +x ${shellQuote(cliPath)}`,
      `${shellQuote(venvPython)} ${shellQuote(cliPath)} capabilities --json >/dev/null`,
    ].join("\n");
    const create = await this.runInDistro(runtime, installScript, "install.wsl.repair-existing-hermes-deps");
    return create.exitCode === 0
      ? { ok: true as const, rootPath, cliPath, python: venvPython, detail: create.stdout || create.stderr }
      : { ok: false as const, detail: create.stderr || create.stdout || `exit ${create.exitCode}` };
  }

  private async reuseExistingRepo(runtime: WslDoctorReport["runtime"], hermesRoot: string): Promise<RepoEnsureResult> {
    const valid = await this.runInDistro(
      runtime,
      `[ -d ${shellQuote(`${hermesRoot}/.git`)} ] && [ -f ${shellQuote(`${hermesRoot}/hermes`)} ] && [ -f ${shellQuote(`${hermesRoot}/pyproject.toml`)} ] && echo valid || echo invalid`,
      "install.wsl.resume-repo",
    );
    if ((valid.stdout || "").trim() === "valid") {
      return {
        ok: true,
        repoStatus: {
          state: "reused",
          root: hermesRoot,
          detail: "根据上次成功阶段复用现有 repo。",
        },
        steps: [installStep({
          phase: "cloning",
          step: "reuse-existing-repo",
          status: "skipped",
          code: "ok",
          summary: "根据上次成功阶段复用现有 repo。",
          detail: hermesRoot,
        })],
      };
    }
    return this.ensureHermesRepo(runtime, hermesRoot);
  }

  private async ensureHermesRepo(runtime: WslDoctorReport["runtime"], hermesRoot: string): Promise<RepoEnsureResult> {
    const source = await this.resolveInstallSource();
    const git = await this.runInDistro(runtime, "git --version", "install.wsl.git-version");
    if (git.exitCode !== 0) {
      return {
        ok: false,
        repoStatus: {
          state: "failed",
          root: hermesRoot,
          detail: git.stderr || git.stdout,
        },
        failedCommand: commandSummary(git),
        steps: [installStep({
          phase: "preflight",
          step: "ensure-git",
          status: "failed",
          code: "git_missing",
          summary: "WSL 中缺少 git，当前无法获取 Hermes 源码。",
          detail: git.stderr || git.stdout,
          fixHint: "请先执行 Managed WSL repair，或在该 distro 内手动安装 git。",
        })],
      };
    }
    const repoMarker = await this.runInDistro(runtime, `[ -d ${shellQuote(`${hermesRoot}/.git`)} ] && echo yes || echo no`, "install.wsl.check-repo");
    if ((repoMarker.stdout || "").trim() === "yes") {
      const valid = await this.runInDistro(runtime, `[ -f ${shellQuote(`${hermesRoot}/hermes`)} ] && [ -f ${shellQuote(`${hermesRoot}/pyproject.toml`)} ] && echo valid || echo invalid`, "install.wsl.validate-repo");
      if ((valid.stdout || "").trim() !== "valid") {
        return {
          ok: false,
          repoStatus: {
            state: "invalid",
            root: hermesRoot,
            detail: `目录：${hermesRoot}`,
          },
          steps: [installStep({
            phase: "preflight",
            step: "validate-existing-repo",
            status: "failed",
            code: "repo_invalid",
            summary: "现有 Hermes 目录看起来不是有效安装，本轮不会直接覆盖。",
            detail: `目录：${hermesRoot}`,
            fixHint: "请手动清理或修复该目录；本轮不会删除已有 repo。",
          })],
        };
      }
      const update = await this.runInDistro(runtime, await this.repoSyncScript(hermesRoot, source, true), "install.wsl.repo-sync");
      return {
        ok: update.exitCode === 0,
        repoStatus: {
          state: update.exitCode === 0 ? "updated" : "invalid",
          root: hermesRoot,
          detail: `${source.sourceLabel} ${source.commit ?? source.branch ?? source.repoUrl}\n${update.stdout || update.stderr}`,
        },
        failedCommand: update.exitCode === 0 ? undefined : commandSummary(update),
        steps: [installStep({
          phase: "cloning",
          step: "update-existing-repo",
          status: update.exitCode === 0 ? "passed" : "failed",
          code: update.exitCode === 0 ? "ok" : "repo_invalid",
          summary: update.exitCode === 0 ? "已更新现有 Hermes 安装目录。" : "更新现有 Hermes 安装目录失败。",
          detail: update.stdout || update.stderr,
          fixHint: update.exitCode === 0 ? undefined : "请手动处理该 repo 的 git 状态；本轮不会删除它。",
        })],
      };
    }
    const localSource = await this.runInDistro(
      runtime,
      `[ -f ${shellQuote(`${hermesRoot}/hermes`)} ] && [ -f ${shellQuote(`${hermesRoot}/pyproject.toml`)} ] && echo valid || echo invalid`,
      "install.wsl.check-local-source",
    );
    if ((localSource.stdout || "").trim() === "valid") {
      return {
        ok: true,
        repoStatus: {
          state: "reused",
          root: hermesRoot,
          detail: "复用已有 Hermes 源码目录（非 git 管理），本轮不会覆盖该目录。",
        },
        steps: [installStep({
          phase: "cloning",
          step: "reuse-local-source",
          status: "skipped",
          code: "ok",
          summary: "已识别已有 Hermes 源码目录，将直接复用。",
          detail: hermesRoot,
          fixHint: "该目录不是 git repo，因此本轮不会自动拉取或重置源码。",
        })],
      };
    }
    const nonEmpty = await this.runInDistro(
      runtime,
      `find ${shellQuote(hermesRoot)} -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q . && echo yes || echo no`,
      "install.wsl.check-root-nonempty",
    );
    if ((nonEmpty.stdout || "").trim() === "yes") {
      return {
        ok: false,
        repoStatus: {
          state: "invalid",
          root: hermesRoot,
          detail: `目录：${hermesRoot}`,
        },
        steps: [installStep({
          phase: "preflight",
          step: "validate-existing-repo",
          status: "failed",
          code: "repo_invalid",
          summary: "现有 Hermes 目录不是可复用安装或源码目录，本轮不会直接覆盖。",
          detail: `目录：${hermesRoot}`,
          fixHint: "请在设置中改成已有 Hermes 的真实源码目录，或清空/更换该受管安装目录后重试。",
        })],
      };
    }
    const clone = await this.runInDistro(runtime, await this.repoSyncScript(hermesRoot, source, false), "install.wsl.git-clone");
    return {
      ok: clone.exitCode === 0,
      repoStatus: {
        state: clone.exitCode === 0 ? "cloned" : "failed",
        root: hermesRoot,
        detail: `${source.sourceLabel} ${source.commit ?? source.branch ?? source.repoUrl}\n${clone.stdout || clone.stderr}`,
      },
      failedCommand: clone.exitCode === 0 ? undefined : commandSummary(clone),
      steps: [installStep({
        phase: "cloning",
        step: "clone-repo",
        status: clone.exitCode === 0 ? "passed" : "failed",
        code: clone.exitCode === 0 ? "ok" : "repo_clone_failed",
        summary: clone.exitCode === 0 ? "已在 WSL 中拉取 Hermes 源码。" : "在 WSL 中拉取 Hermes 源码失败。",
        detail: clone.stdout || clone.stderr,
        fixHint: clone.exitCode === 0 ? undefined : "请检查网络/代理或手动 clone；本轮不会做复杂回滚。",
      })],
    };
  }

  private async ensureVirtualEnv(runtime: WslDoctorReport["runtime"], hermesRoot: string, python: string): Promise<VenvEnsureResult> {
    const venvPath = `${hermesRoot}/.venv`;
    const exists = await this.runInDistro(runtime, `[ -x ${shellQuote(`${venvPath}/bin/python`)} ] && echo yes || echo no`, "install.wsl.check-venv");
    if ((exists.stdout || "").trim() === "yes") {
      return {
        ok: true,
        venvPath,
        python: `${venvPath}/bin/python`,
        venvStatus: {
          state: "reused",
          path: venvPath,
          detail: "复用现有 virtualenv。",
        },
        step: installStep({
          phase: "installing_dependencies",
          step: "ensure-venv",
          status: "passed",
          code: "venv_exists",
          summary: "复用现有 Python 虚拟环境。",
          detail: venvPath,
        }),
      };
    }
    const create = await this.runInDistro(runtime, `${python} -m venv ${shellQuote(venvPath)}`, "install.wsl.create-venv");
    if (create.exitCode !== 0) {
      return {
        ok: false,
        venvPath,
        python,
        venvStatus: {
          state: "failed",
          path: venvPath,
          detail: create.stderr || create.stdout,
        },
        failedCommand: commandSummary(create),
        step: installStep({
          phase: "installing_dependencies",
          step: "ensure-venv",
          status: "failed",
          code: "venv_unavailable",
          summary: "创建 Python 虚拟环境失败，已停止后续 pip 安装。",
          detail: create.stderr || create.stdout,
          fixHint: "请先修复 python3-venv 或 ensurepip 环境，再重新执行 install；当前不会回退到系统 Python。",
        }),
      };
    }
    return {
      ok: true,
      venvPath,
      python: `${venvPath}/bin/python`,
      venvStatus: {
        state: "created",
        path: venvPath,
        detail: "已创建 virtualenv。",
      },
      step: installStep({
        phase: "installing_dependencies",
        step: "ensure-venv",
        status: "passed",
        code: "venv_created",
        summary: "已创建 Python 虚拟环境。",
        detail: venvPath,
      }),
    };
  }

  private shouldSkipPipInstall(
    resumedFromStage: ManagedWslInstallerResumeStage | undefined,
    previousResult: WslHermesInstallResult | undefined,
    hermesRoot: string,
  ) {
    return Boolean(
      resumedFromStage
      && compareInstallerStage(resumedFromStage, "health_check") >= 0
      && previousResult?.installExecuted
      && previousResult.hermesRoot === hermesRoot,
    );
  }

  private skipPipInstallForHealthRetry(): InstallDepsResult {
    return {
      ok: true,
      executed: false,
      steps: [installStep({
        phase: "installing_dependencies",
        step: "pip-install",
        status: "skipped",
        code: "ok",
        summary: "根据上次成功阶段跳过 pip install，直接重试 health check。",
      })],
    };
  }

  private async installHermesDependencies(runtime: WslDoctorReport["runtime"], hermesRoot: string, python: string): Promise<InstallDepsResult> {
    const steps = [];
    const pip = await this.runInDistro(runtime, `${python} -m pip --version`, "install.wsl.pip-version");
    if (pip.exitCode !== 0) {
      return {
        ok: false,
        executed: false,
        failedCommand: commandSummary(pip),
        steps: [installStep({
        phase: "installing_dependencies",
        step: "pip-check",
        status: "failed",
        code: "pip_missing",
        summary: "WSL 中的 Python 缺少可用 pip。",
        detail: pip.stderr || pip.stdout,
        fixHint: "请先执行 Managed WSL repair，或在该 distro 内为 Python 准备 pip。",
      })],
      };
    }
    const editable = await this.runInDistro(runtime, `cd ${shellQuote(hermesRoot)} && ${python} -m pip install -e .`, "install.wsl.pip-install");
    steps.push(installStep({
      phase: "installing_dependencies",
      step: "pip-install",
      status: editable.exitCode === 0 ? "passed" : "failed",
      code: editable.exitCode === 0 ? "ok" : "pip_install_failed",
      summary: editable.exitCode === 0 ? "已完成 Hermes 依赖安装。" : "Hermes 依赖安装失败。",
      detail: editable.stdout || editable.stderr,
      fixHint: editable.exitCode === 0 ? undefined : "请检查 pip 输出、网络和 Python 包构建环境。",
    }));
    return {
      ok: editable.exitCode === 0,
      executed: true,
      failedCommand: editable.exitCode === 0 ? undefined : commandSummary(editable),
      steps,
    };
  }

  private async verifyHermesInstall(runtime: WslDoctorReport["runtime"], hermesRoot: string, python: string): Promise<VerifyResult> {
    const version = await this.runInDistro(runtime, `${python} ${shellQuote(`${hermesRoot}/hermes`)} --version`, "install.wsl.hermes-version");
    const capabilities = await this.runInDistro(runtime, `${python} ${shellQuote(`${hermesRoot}/hermes`)} capabilities --json`, "install.wsl.hermes-capabilities");
    const capabilityProbe = this.parseCapabilityProbe(capabilities);
    return {
      ok: version.exitCode === 0 && capabilityProbe.minimumSatisfied,
      version: version.stdout.trim(),
      failedCommand: version.exitCode === 0 ? undefined : commandSummary(version),
      steps: [installStep({
        phase: "health_check",
        step: "verify-hermes",
        status: version.exitCode === 0 && capabilityProbe.minimumSatisfied ? "passed" : "failed",
        code: version.exitCode === 0 && capabilityProbe.minimumSatisfied ? "ok" : "hermes_healthcheck_failed",
        summary: version.exitCode === 0 && capabilityProbe.minimumSatisfied ? "Hermes 版本与能力检查通过。" : "Hermes 版本与能力检查未通过。",
        detail: `${version.stdout || version.stderr}\n${capabilities.stdout || capabilities.stderr}`.trim(),
        fixHint: version.exitCode === 0 && capabilityProbe.minimumSatisfied ? undefined : "请检查 WSL repo/commit、venv、pip install，以及 capabilities --json / --launch-metadata / --resume 是否可用。",
      })],
      capabilityProbe,
    };
  }

  private async resolveInstallSource() {
    const config = await this.configStore.read();
    return config.hermesRuntime?.installSource ?? DEFAULT_PINNED_SOURCE;
  }

  private async repoSyncScript(hermesRoot: string, source: { repoUrl: string; branch?: string; commit?: string; sourceLabel: string }, existing: boolean) {
    const root = shellQuote(hermesRoot);
    const repo = shellQuote(source.repoUrl);
    if (source.commit) {
      return existing
        ? `git -C ${root} remote set-url origin ${repo} && git -C ${root} fetch --depth 1 origin ${shellQuote(source.commit)} && git -C ${root} checkout --detach FETCH_HEAD`
        : `mkdir -p ${root} && git init ${root} && git -C ${root} remote add origin ${repo} && git -C ${root} fetch --depth 1 origin ${shellQuote(source.commit)} && git -C ${root} checkout --detach FETCH_HEAD`;
    }
    const branch = shellQuote(source.branch?.trim() || "main");
    return existing
      ? `git -C ${root} remote set-url origin ${repo} && git -C ${root} fetch --depth 1 origin ${branch} && git -C ${root} checkout ${branch} && git -C ${root} reset --hard FETCH_HEAD`
      : `git clone --branch ${branch} --depth 1 ${repo} ${root}`;
  }

  private parseCapabilityProbe(result: CommandResult) {
    if (result.exitCode !== 0) {
      return {
        minimumSatisfied: false,
        supportsLaunchMetadataArg: false,
        supportsLaunchMetadataEnv: false,
        supportsResume: false,
        missing: ["capabilities --json"],
      };
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
      const probe = {
        minimumSatisfied: Boolean(parsed.cliVersion)
          && parsed.capabilities?.supportsLaunchMetadataArg === true
          && parsed.capabilities?.supportsLaunchMetadataEnv === true
          && parsed.capabilities?.supportsResume === true,
        cliVersion: parsed.cliVersion,
        supportsLaunchMetadataArg: parsed.capabilities?.supportsLaunchMetadataArg === true,
        supportsLaunchMetadataEnv: parsed.capabilities?.supportsLaunchMetadataEnv === true,
        supportsResume: parsed.capabilities?.supportsResume === true,
        missing: [] as string[],
      };
      if (!probe.cliVersion) probe.missing.push("cliVersion");
      if (!probe.supportsLaunchMetadataArg) probe.missing.push("supportsLaunchMetadataArg");
      if (!probe.supportsLaunchMetadataEnv) probe.missing.push("supportsLaunchMetadataEnv");
      if (!probe.supportsResume) probe.missing.push("supportsResume");
      return probe;
    } catch {
      return {
        minimumSatisfied: false,
        supportsLaunchMetadataArg: false,
        supportsLaunchMetadataEnv: false,
        supportsResume: false,
        missing: ["capability_json_parse"],
      };
    }
  }

  private async persistManagedRoot(hermesRoot: string) {
    const config = await this.configStore.read();
    const next = cloneConfig(config);
    next.hermesRuntime = {
      ...(next.hermesRuntime ?? { mode: "wsl", pythonCommand: "python3" }),
      mode: "wsl",
      managedRoot: hermesRoot,
      pythonCommand: next.hermesRuntime?.pythonCommand?.trim() || "python3",
      windowsAgentMode: next.hermesRuntime?.windowsAgentMode ?? "hermes_native",
      distro: next.hermesRuntime?.distro,
      cliPermissionMode: next.hermesRuntime?.cliPermissionMode ?? "yolo",
      permissionPolicy: next.hermesRuntime?.permissionPolicy ?? "bridge_guarded",
      installSource: next.hermesRuntime?.installSource,
    };
    await this.configStore.write(next);
  }

  private async runInDistro(runtime: WslDoctorReport["runtime"], script: string, commandId: string) {
    return runCommand("wsl.exe", [...(runtime.distro ? ["-d", runtime.distro] : []), "sh", "-lc", script], {
      cwd: process.cwd(),
      timeoutMs: 10 * 60 * 1000,
      commandId,
      runtimeKind: "wsl",
    });
  }

  private managedRootPolicy(hermesRoot: string) {
    return {
      root: hermesRoot,
      persistent: true,
      owner: "wsl-user-home",
      description: "WSL managed Hermes root stored in distro user home under ~/.hermes-forge/hermes-agent",
      relationToWindowsProfileHermes: "Windows profile Hermes continues to store desktop-managed config/.env; WSL repo and venv live entirely inside distro.",
      configPath: "Windows app profile Hermes config.yaml",
      repoPath: hermesRoot,
      venvPath: `${hermesRoot}/.venv`,
      logPath: path.join(this.appPaths.baseDir(), "diagnostics", "install-logs"),
    };
  }

  private failureArtifacts(input: {
    failedCommand?: ManagedWslInstallerFailureCommand;
    distroName?: string;
    managedRoot?: string;
    repoStatus?: Record<string, unknown>;
    venvStatus?: Record<string, unknown>;
    bridgeStatus?: Record<string, unknown>;
    lastSuccessfulStage?: ManagedWslInstallerResumeStage;
    recommendedRecoveryAction: ManagedWslInstallerRecoveryAction;
  }) {
    return {
      failedCommand: input.failedCommand,
      distroName: input.distroName,
      managedRoot: input.managedRoot,
      repoStatus: input.repoStatus,
      venvStatus: input.venvStatus,
      bridgeStatus: input.bridgeStatus,
      lastSuccessfulStage: input.lastSuccessfulStage,
      recommendedRecoveryAction: input.recommendedRecoveryAction,
    };
  }

  private async finalize(result: WslHermesInstallResult) {
    const source = await this.resolveInstallSource().catch(() => DEFAULT_PINNED_SOURCE);
    result.hermesSource ??= source;
    if (result.repoReady && result.hermesRoot) {
      const runtime = (await this.configStore.read()).hermesRuntime;
      const distro = runtime?.distro;
    const commit = await this.runInDistro({ distro, managedRoot: result.hermesRoot, mode: "wsl", pythonCommand: runtime?.pythonCommand ?? "python3", windowsAgentMode: runtime?.windowsAgentMode ?? "hermes_native", cliPermissionMode: runtime?.cliPermissionMode ?? "yolo", permissionPolicy: runtime?.permissionPolicy ?? "bridge_guarded", installSource: runtime?.installSource }, `git -C ${shellQuote(result.hermesRoot)} rev-parse HEAD`, "install.wsl.git-rev-parse").catch(() => undefined);
      const resolvedCommit = commit?.exitCode === 0 ? commit.stdout.trim() : undefined;
      if (resolvedCommit) {
        result.hermesCommit ??= resolvedCommit;
      }
    }
    this.lastInstallResult = result;
    const dir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "wsl-hermes-install-last.json"), JSON.stringify(result, null, 2), "utf8");
    return result;
  }
}

function commandSummary(result: CommandResult): ManagedWslInstallerFailureCommand {
  return {
    commandSummary: [result.diagnostics?.binary ?? "wsl.exe", ...(result.diagnostics?.argv ?? [])].join(" ").trim(),
    commandId: result.diagnostics?.commandId,
    exitCode: result.exitCode,
    stdoutPreview: result.diagnostics?.stdoutPreview ?? preview(result.stdout),
    stderrPreview: result.diagnostics?.stderrPreview ?? preview(result.stderr),
  };
}

function preview(value: string) {
  const text = value.trim();
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...[truncated]` : text;
}

function dirnamePosix(inputPath: string) {
  const normalized = inputPath.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "/";
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shouldRepairExistingHermesDependencies(output: string) {
  return /ModuleNotFoundError:\s+No module named ['"](?:dotenv|yaml)['"]|No module named ['"](?:dotenv|yaml)['"]/i.test(output);
}

function cloneConfig(config: RuntimeConfig): RuntimeConfig {
  return JSON.parse(JSON.stringify(config)) as RuntimeConfig;
}
