import fs from "node:fs/promises";
import path from "node:path";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { RuntimeProbeService } from "../runtime/runtime-probe-service";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import { runCommand } from "../process/command-runner";
import type { RuntimeConfig } from "../shared/types";
import { installStep } from "./install-types";
import type { WslDoctorService } from "./wsl-doctor-service";
import type { WslDistroCreateResult } from "./wsl-doctor-types";
import type { ManagedWslInstallerFailureCommand } from "./managed-wsl-recovery-types";

const DEFAULT_MANAGED_WSL_DISTRO = process.env.HERMES_MANAGED_WSL_DISTRO?.trim() || "Ubuntu";
const CREATE_TIMEOUT_MS = 15 * 60 * 1000;

export class WslDistroService {
  private lastCreateResult?: WslDistroCreateResult;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly configStore: RuntimeConfigStore,
    private readonly runtimeProbeService: RuntimeProbeService,
    private readonly runtimeAdapterFactory: RuntimeAdapterFactory,
    private readonly doctorService: WslDoctorService,
  ) {}

  getLastCreateResult() {
    return this.lastCreateResult;
  }

  async createOrAttach(options: { requestedBy?: "install" | "debug"; explicitCreate?: boolean } = {}): Promise<WslDistroCreateResult> {
    const requestedAt = new Date().toISOString();
    const requestedBy = options.requestedBy ?? "install";
    const config = await this.configStore.read();
    const distroName = this.resolveManagedDistroName(config);
    const runtime = {
      mode: "wsl" as const,
      distro: distroName,
      pythonCommand: config.hermesRuntime?.pythonCommand?.trim() || "python3",
      windowsAgentMode: config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
    };
    const beforeProbe = await this.runtimeProbeService.probe({ runtime });
    const existedBefore = beforeProbe.distroExists === true;
    const steps = [
      installStep({
        phase: "plan",
        step: "resolve-managed-distro",
        status: "passed",
        code: "managed_distro_resolved",
        summary: `Managed distro 已确定为 ${distroName}。`,
        debugContext: { configuredDistro: config.hermesRuntime?.distro, defaultDistro: DEFAULT_MANAGED_WSL_DISTRO },
      }),
    ];

    let createdNow = false;
    let command = "";
    let stdoutPreview = "";
    let stderrPreview = "";

    if (!beforeProbe.wslAvailable && !options.explicitCreate) {
      return this.finalize({
        requestedAt,
        requestedBy,
        distroName,
        explicitCreate: false,
        existedBefore,
        createdNow: false,
        reachableAfterCreate: false,
        lastSuccessfulStage: undefined,
        recovery: {
          failureStage: "create_distro",
          disposition: "manual_action_required",
          code: "unsupported",
          summary: "当前环境不支持 Managed WSL Create Distro。",
          detail: beforeProbe.commands.wsl.message,
          fixHint: beforeProbe.recommendations[0],
          nextAction: "manual_create_distro",
        },
        failureArtifacts: {
          distroName,
          lastSuccessfulStage: undefined,
          recommendedRecoveryAction: "manual_create_distro",
        },
        steps: [
          ...steps,
          installStep({
            phase: "preflight",
            step: "wsl-available",
            status: "failed",
            code: "unsupported",
            summary: "WSL 不可用，无法创建 Managed distro。",
            detail: beforeProbe.commands.wsl.message,
            fixHint: beforeProbe.recommendations[0],
            debugContext: { runtimeProbe: beforeProbe },
          }),
        ],
        debugContext: { runtimeProbe: beforeProbe },
      });
    }

    if (!beforeProbe.wslAvailable && options.explicitCreate) {
      command = `wsl.exe --install -d ${distroName}`;
      const result = await runCommand("wsl.exe", ["--install", "-d", distroName], {
        cwd: process.cwd(),
        timeoutMs: CREATE_TIMEOUT_MS,
        commandId: "install.wsl.bootstrap-distro",
        runtimeKind: "wsl",
      });
      stdoutPreview = result.diagnostics?.stdoutPreview ?? result.stdout.slice(0, 4000);
      stderrPreview = result.diagnostics?.stderrPreview ?? result.stderr.slice(0, 4000);
      if (result.exitCode !== 0) {
        return this.finalize({
          requestedAt,
          requestedBy,
          distroName,
          explicitCreate: true,
          existedBefore,
          createdNow: false,
          reachableAfterCreate: false,
          lastSuccessfulStage: undefined,
          recovery: {
            failureStage: "create_distro",
            disposition: "manual_action_required",
            code: "unsupported",
            summary: "无法自动安装 WSL/Ubuntu。",
            detail: stderrPreview || stdoutPreview || beforeProbe.commands.wsl.message || `exit ${result.exitCode}`,
            fixHint: "请以管理员权限启用 Windows Subsystem for Linux，或手动执行 wsl.exe --install -d Ubuntu；如系统提示重启，请重启后再次点击安装。",
            nextAction: "manual_create_distro",
          },
          failureArtifacts: {
            failedCommand: commandSummary(result, command),
            distroName,
            lastSuccessfulStage: undefined,
            recommendedRecoveryAction: "manual_create_distro",
          },
          steps: [
            ...steps,
            installStep({
              phase: "preflight",
              step: "wsl-bootstrap-install",
              status: "failed",
              code: "unsupported",
              summary: "自动安装 WSL/Ubuntu 未成功。",
              detail: stderrPreview || stdoutPreview || beforeProbe.commands.wsl.message || `exit ${result.exitCode}`,
              fixHint: "请按 Windows 提示启用 WSL/虚拟化并重启，然后再次点击安装。",
              debugContext: { command, exitCode: result.exitCode, runtimeProbe: beforeProbe },
            }),
          ],
          command,
          stdoutPreview,
          stderrPreview,
          debugContext: { runtimeProbe: beforeProbe },
        });
      }
      createdNow = true;
      steps.push(installStep({
        phase: "preflight",
        step: "wsl-bootstrap-install",
        status: "passed",
        code: "distro_created",
        summary: `已发起 WSL/Ubuntu 安装：${distroName}。`,
        detail: stdoutPreview || stderrPreview,
        fixHint: "如果 Windows 要求重启或 Ubuntu 首次初始化，请完成后再次点击安装按钮继续。",
        debugContext: { command, runtimeProbe: beforeProbe },
      }));
    }

    if (!existedBefore && !createdNow) {
      if (!options.explicitCreate) {
        return this.finalize({
          requestedAt,
          requestedBy,
          distroName,
          explicitCreate: false,
          existedBefore,
          createdNow: false,
          reachableAfterCreate: false,
          lastSuccessfulStage: undefined,
          recovery: {
            failureStage: "create_distro",
            disposition: "manual_action_required",
            code: "manual_action_required",
            summary: `目标 distro ${distroName} 不存在，且当前未请求显式创建。`,
            fixHint: "请显式执行 install 流程以创建 Managed distro。",
            nextAction: "retry_create_distro",
          },
          failureArtifacts: {
            distroName,
            lastSuccessfulStage: undefined,
            recommendedRecoveryAction: "retry_create_distro",
          },
          steps: [
            ...steps,
            installStep({
              phase: "preflight",
              step: "distro-missing",
              status: "failed",
              code: "manual_action_required",
              summary: `目标 distro ${distroName} 不存在。`,
              fixHint: "请显式执行 install 流程以创建 Managed distro。",
              debugContext: { runtimeProbe: beforeProbe },
            }),
          ],
          debugContext: { runtimeProbe: beforeProbe },
        });
      }

      command = `wsl.exe --install -d ${distroName}`;
      const result = await runCommand("wsl.exe", ["--install", "-d", distroName], {
        cwd: process.cwd(),
        timeoutMs: CREATE_TIMEOUT_MS,
        commandId: "install.wsl.create-distro",
        runtimeKind: "wsl",
      });
      stdoutPreview = result.diagnostics?.stdoutPreview ?? result.stdout.slice(0, 4000);
      stderrPreview = result.diagnostics?.stderrPreview ?? result.stderr.slice(0, 4000);
      if (result.exitCode === 0) {
        createdNow = true;
        steps.push(installStep({
          phase: "preflight",
          step: "create-distro",
          status: "passed",
          code: "distro_created",
          summary: `已显式创建 Managed distro：${distroName}。`,
          detail: stdoutPreview || stderrPreview,
          debugContext: { command },
        }));
      } else {
        return this.finalize({
          requestedAt,
          requestedBy,
          distroName,
          explicitCreate: true,
          existedBefore,
          createdNow: false,
          reachableAfterCreate: false,
          lastSuccessfulStage: undefined,
          recovery: {
            failureStage: "create_distro",
            disposition: "retryable",
            code: "distro_unavailable",
            summary: `创建 Managed distro 失败：${distroName}`,
            detail: stderrPreview || stdoutPreview || `exit ${result.exitCode}`,
            fixHint: "请检查 WSL/发行版初始化状态后重试；如多次失败，请改为人工创建。",
            nextAction: "retry_create_distro",
          },
          failureArtifacts: {
            failedCommand: commandSummary(result, command),
            distroName,
            lastSuccessfulStage: undefined,
            recommendedRecoveryAction: "retry_create_distro",
          },
          steps: [
            ...steps,
            installStep({
              phase: "preflight",
              step: "create-distro",
              status: "failed",
              code: "distro_unavailable",
              summary: `创建 Managed distro 失败：${distroName}`,
              detail: stderrPreview || stdoutPreview || `exit ${result.exitCode}`,
              fixHint: "请检查 wsl.exe 输出；本轮不会删除或覆盖任何已有 distro。",
              debugContext: { command, exitCode: result.exitCode },
            }),
          ],
          command,
          stdoutPreview,
          stderrPreview,
          debugContext: { runtimeProbe: beforeProbe },
        });
      }
    } else if (existedBefore) {
      steps.push(installStep({
        phase: "preflight",
        step: "attach-existing-distro",
        status: "passed",
        code: "distro_exists",
        summary: `Managed distro 已存在，转入 attach/verify：${distroName}。`,
      }));
    }

    const nextConfig = cloneConfig(config);
    nextConfig.hermesRuntime = {
      ...(nextConfig.hermesRuntime ?? { pythonCommand: "python3" }),
      mode: "wsl",
      distro: distroName,
      pythonCommand: nextConfig.hermesRuntime?.pythonCommand?.trim() || "python3",
      windowsAgentMode: nextConfig.hermesRuntime?.windowsAgentMode ?? "hermes_native",
    };
    await this.configStore.write(nextConfig);

    const adapter = this.runtimeAdapterFactory(nextConfig.hermesRuntime);
    const reachable = await runCommand("wsl.exe", ["-d", distroName, "sh", "-lc", "uname -a && echo ready"], {
      cwd: process.cwd(),
      timeoutMs: 20_000,
      commandId: "install.wsl.verify-distro",
      runtimeKind: "wsl",
    });
    const reachableAfterCreate = reachable.exitCode === 0;
    steps.push(installStep({
      phase: "health_check",
      step: "verify-distro-entry",
      status: reachableAfterCreate ? "passed" : "failed",
      code: reachableAfterCreate ? "ok" : "distro_unavailable",
      summary: reachableAfterCreate ? "Managed distro 可进入。" : "Managed distro 不可进入。",
      detail: reachable.stdout || reachable.stderr,
      fixHint: reachableAfterCreate ? undefined : "请手动启动该 distro 完成初始化后再重试。",
    }));
    await adapter.getBridgeAccessHost().catch(() => undefined);
    const reprobe = await this.runtimeProbeService.probe({ runtime: nextConfig.hermesRuntime });
    const reDoctor = await this.doctorService.diagnose({ runtime: nextConfig.hermesRuntime });
    steps.push(installStep({
      phase: "health_check",
      step: "reprobe-runtime",
      status: reprobe.overallStatus === "ready" || reprobe.overallStatus === "degraded" ? "passed" : "failed",
      code: "runtime_reprobed",
      summary: `reprobe 完成：${reprobe.overallStatus}`,
      debugContext: { overallStatus: reprobe.overallStatus },
    }));
    steps.push(installStep({
      phase: "health_check",
      step: "redoctor-runtime",
      status: reDoctor.overallStatus === "ready_to_attach_existing_wsl" || reDoctor.overallStatus === "repair_needed" ? "passed" : "failed",
      code: "doctor_reran",
      summary: `re-doctor 完成：${reDoctor.overallStatus}`,
      debugContext: { overallStatus: reDoctor.overallStatus },
    }));

    return this.finalize({
      requestedAt,
      requestedBy,
      distroName,
      explicitCreate: options.explicitCreate === true,
      existedBefore,
      createdNow,
      reachableAfterCreate,
      lastSuccessfulStage: reachableAfterCreate ? "create_distro" : undefined,
      recovery: reachableAfterCreate ? undefined : {
        failureStage: "create_distro",
        disposition: "manual_action_required",
        code: "distro_unavailable",
        summary: "Managed distro 已创建/选中，但当前仍无法进入。",
        detail: reachable.stderr || reachable.stdout,
        fixHint: "请先手动打开该 distro 完成初始化，再重新点击 install。",
        nextAction: "manual_create_distro",
      },
      failureArtifacts: {
        failedCommand: reachableAfterCreate ? undefined : commandSummary(reachable, `wsl.exe -d ${distroName} sh -lc "uname -a && echo ready"`),
        distroName,
        lastSuccessfulStage: reachableAfterCreate ? "create_distro" : undefined,
        recommendedRecoveryAction: reachableAfterCreate ? "none" : "manual_create_distro",
      },
      reprobeStatus: reprobe.overallStatus,
      reDoctorStatus: reDoctor.overallStatus,
      steps,
      command,
      stdoutPreview,
      stderrPreview,
      debugContext: {
        runtimeProbe: reprobe,
        doctor: reDoctor,
      },
    });
  }

  async exportLatest() {
    return this.lastCreateResult;
  }

  private async finalize(result: WslDistroCreateResult) {
    this.lastCreateResult = result;
    const dir = path.join(this.appPaths.baseDir(), "diagnostics", "install-logs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "wsl-distro-last.json"), JSON.stringify(result, null, 2), "utf8");
    return result;
  }

  private resolveManagedDistroName(config: RuntimeConfig) {
    return config.hermesRuntime?.distro?.trim() || DEFAULT_MANAGED_WSL_DISTRO;
  }
}

function cloneConfig(config: RuntimeConfig): RuntimeConfig {
  return JSON.parse(JSON.stringify(config)) as RuntimeConfig;
}

function commandSummary(
  result: Awaited<ReturnType<typeof runCommand>>,
  commandOverride?: string,
): ManagedWslInstallerFailureCommand {
  return {
    commandSummary: commandOverride ?? [result.diagnostics?.binary ?? "wsl.exe", ...(result.diagnostics?.argv ?? [])].join(" ").trim(),
    commandId: result.diagnostics?.commandId,
    exitCode: result.exitCode,
    stdoutPreview: result.diagnostics?.stdoutPreview ?? result.stdout.slice(0, 4000),
    stderrPreview: result.diagnostics?.stderrPreview ?? result.stderr.slice(0, 4000),
  };
}
