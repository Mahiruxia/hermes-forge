import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfigStore } from "../runtime-config";
import type { SetupService } from "../../setup/setup-service";
import type { RuntimeProbeService } from "../../runtime/runtime-probe-service";
import type { HermesConnectorService } from "../hermes-connector-service";
import type { HermesModelSyncService } from "../hermes-model-sync";
import type { HermesSystemAuditService } from "../hermes-system-audit-service";
import type { DiagnosticsService } from "../../diagnostics/diagnostics-service";
import type { WorkspaceLock } from "../../process/workspace-lock";
import type { TaskRunner } from "../../process/task-runner";
import type { HermesCompatibilityService } from "../../setup/hermes-compatibility-service";
import { runCommand } from "../../process/command-runner";
import type { ResolvedHermesCli } from "../../runtime/hermes-cli-resolver";
import { defaultWindowsHermesCliPath, isWindowsHermesExecutable, resolveWindowsHermesCliPath } from "../../runtime/hermes-cli-paths";
import { migrateRuntimeConfigModels } from "../../shared/model-config";
import { redactSensitiveValue } from "../../shared/redaction";
import type {
  HermesSystemAuditStep,
  OneClickDiagnosticItem,
  OneClickDiagnosticSeverity,
  OneClickDiagnosticStatus,
  OneClickDiagnosticsExportResult,
  OneClickDiagnosticsReport,
  OneClickDiagnosticsRunOptions,
  OneClickDiagnosticsStatus,
  ModelConnectionTestResult,
  RuntimeConfig,
} from "../../shared/types";

type RuntimeContext = {
  config: RuntimeConfig;
  runtime: NonNullable<RuntimeConfig["hermesRuntime"]>;
};

const STALE_LOCK_MIN_AGE_MS = 5000;

export class OneClickDiagnosticsOrchestrator {
  private lastReport?: OneClickDiagnosticsReport;
  private status: OneClickDiagnosticsStatus = { running: false, message: "空闲" };
  private running = false;

  constructor(
    private readonly configStore: RuntimeConfigStore,
    private readonly setupService: SetupService,
    private readonly runtimeProbeService: RuntimeProbeService,
    private readonly hermesConnectorService: HermesConnectorService,
    private readonly hermesModelSyncService: HermesModelSyncService,
    private readonly hermesSystemAuditService: HermesSystemAuditService,
    private readonly diagnosticsService: DiagnosticsService,
    private readonly workspaceLock: WorkspaceLock,
    private readonly taskRunner: TaskRunner,
    private readonly hermesCompatibilityService?: HermesCompatibilityService,
    private readonly testModelConnection?: (config: RuntimeConfig) => Promise<ModelConnectionTestResult>,
    private readonly hermesHomeProvider?: () => Promise<string> | string,
  ) {}

  getStatus(): OneClickDiagnosticsStatus {
    return {
      ...this.status,
      lastReport: this.lastReport,
    };
  }

  async run(options: OneClickDiagnosticsRunOptions = {}): Promise<OneClickDiagnosticsReport> {
    if (this.running) {
      throw new Error("DIAGNOSTIC_ALREADY_RUNNING: 一键诊断正在运行，请勿重复启动。");
    }
    this.running = true;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const items: OneClickDiagnosticItem[] = [];
    this.status = { running: true, startedAt, stage: "starting", message: "正在启动一键诊断..." };

    let context: RuntimeContext | undefined;
    let resolvedCli: ResolvedHermesCli | undefined;

    try {
      await this.capture(items, "setup.summary", "基础环境摘要", "setup-service", async () => {
        await this.checkSetupSummary(items, options.workspacePath);
      });

      context = await this.readRuntimeContext(items);
      if (context) {
        await this.capture(items, "runtime.windows", "Windows Native 运行环境", "runtime-probe-service", async () => {
          await this.checkWindowsRuntime(items, context!, options);
        });
        resolvedCli = await this.captureValue(items, "hermes.path", "Hermes 路径检查", "hermes-cli-resolver", async () =>
          this.checkHermesPath(items, context!, options),
        );
        await this.capture(items, "python.deps", "Python 依赖检查", "hermes-cli-resolver", async () => {
          await this.checkPythonDeps(items, context!, resolvedCli, options);
        });
        await this.capture(items, "hermes.cli", "Hermes CLI 能力检查", "hermes-cli-resolver", async () => {
          await this.checkHermesCli(items, context!, resolvedCli, options);
        });
        await this.capture(items, "gateway.status", "Gateway 检查", "hermes-connector-service", async () => {
          await this.checkGateway(items, options);
        });
        await this.capture(items, "model.schema", "模型配置检查", "runtime-config", async () => {
          await this.checkModels(items, options);
        });
      }

      await this.capture(items, "task.lock", "任务锁检查", "workspace-lock", async () => {
        await this.checkTaskLocks(items, options);
      });

      this.skipHermesSystemAudit(items);

      items.push(item({
        id: "diagnostics.export",
        title: "诊断报告导出准备",
        status: "pass",
        severity: "info",
        summary: "一键诊断结果已结构化，可通过“导出诊断报告”写入本地诊断目录。",
        autoFixable: false,
        source: "diagnostics-service",
      }));
    } finally {
      try {
        const finishedAt = new Date().toISOString();
        const report: OneClickDiagnosticsReport = {
          startedAt,
          finishedAt,
          durationMs: Date.now() - startedAtMs,
          summary: summarize(items),
          items: redactSensitiveValue(items.map(trimDiagnosticItem)),
        };
        this.lastReport = report;
        this.status = {
          running: false,
          startedAt,
          finishedAt,
          stage: "finished",
          message: report.summary.failed > 0 ? "一键诊断完成，仍有未解决问题。" : "一键诊断完成。",
          lastReport: report,
        };
      } finally {
        this.running = false;
      }
    }

    return this.lastReport!;
  }

  async exportLatest(workspacePath?: string): Promise<OneClickDiagnosticsExportResult> {
    const exported = await this.diagnosticsService.export(workspacePath);
    const oneClickReportPath = path.join(exported.path, "one-click-diagnostics.json");
    const report = this.lastReport ?? this.emptyExportReport();
    await fs.writeFile(oneClickReportPath, JSON.stringify(trimDiagnosticValue(redactSensitiveValue(report)), null, 2), "utf8");
    return {
      ...exported,
      diagnosticsPath: exported.path,
      oneClickReportPath,
      message: this.lastReport
        ? `${exported.message}；已包含 one-click-diagnostics.json。`
        : `${exported.message}；当前没有已完成的一键诊断，已写入空的一键诊断占位报告。`,
    };
  }

  private emptyExportReport(): OneClickDiagnosticsReport {
    const at = new Date().toISOString();
    return {
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      summary: {
        total: 1,
        passed: 0,
        warnings: 0,
        failed: 0,
        fixed: 0,
        skipped: 1,
        unresolved: 0,
      },
      items: [{
        id: "diagnostics.one-click.empty",
        title: "一键诊断结果",
        status: "skipped",
        severity: "info",
        summary: "当前进程中暂无已完成的一键诊断结果；本次仅导出普通诊断报告。",
        autoFixable: false,
        source: "one-click-diagnostics-orchestrator",
      }],
    };
  }

  private async checkSetupSummary(items: OneClickDiagnosticItem[], workspacePath?: string) {
    this.setStage("setup", "正在读取基础环境摘要...");
    const setup = await this.setupService.getSummary(workspacePath);
    const blocking = setup.blocking.length;
    items.push(item({
      id: "setup.summary",
      title: "基础环境摘要",
      status: setup.ready ? "pass" : blocking > 0 ? "fail" : "warn",
      severity: setup.ready ? "info" : blocking > 0 ? "error" : "warning",
      summary: setup.ready ? "基础环境检查通过。" : `基础环境仍有 ${blocking} 个阻塞项。`,
      details: setup.blocking.map((check) => `${check.label}: ${check.message}`).join("\n") || undefined,
      evidence: { ready: setup.ready, blocking: setup.blocking.map((check) => check.id), checkCount: setup.checks.length },
      autoFixable: setup.blocking.some((check) => check.canAutoFix),
      userActionRequired: setup.blocking.some((check) => !check.canAutoFix),
      suggestedActions: setup.blocking.map((check) => check.recommendedAction).filter((action): action is string => Boolean(action)),
      source: "setup-service",
    }));
  }

  private async readRuntimeContext(items: OneClickDiagnosticItem[]): Promise<RuntimeContext | undefined> {
    this.setStage("config", "正在读取运行时配置...");
    try {
      const config = await this.configStore.read();
      return {
        config,
        runtime: normalizeRuntime(config),
      };
    } catch (error) {
      items.push(failureItem("config.runtime", "运行时配置", error, {
        summary: "无法读取运行时配置，后续 Windows Hermes/Gateway 检查已跳过。",
        severity: "critical",
        suggestedActions: ["重新打开设置中心，或导出诊断报告后修复 runtime config 文件。"],
        source: "runtime-config",
      }));
      return undefined;
    }
  }

  private async checkWindowsRuntime(items: OneClickDiagnosticItem[], context: RuntimeContext, options: OneClickDiagnosticsRunOptions) {
    this.setStage("runtime.windows", "正在检查 Windows Native runtime...");
    const runtime = context.runtime;
    const probe = await this.runtimeProbeService.probe({
      workspacePath: options.workspacePath,
      runtime: { ...runtime, mode: "windows", distro: undefined, workerMode: "off" },
      persistResolvedHermesPath: Boolean(options.autoFix),
    });

    items.push(item({
      id: "runtime.windows",
      title: "Windows Native 运行环境",
      status: probe.overallStatus === "ready" ? "pass" : probe.overallStatus === "degraded" ? "warn" : "fail",
      severity: probe.overallStatus === "ready" ? "info" : probe.overallStatus === "degraded" ? "warning" : "error",
      summary: probe.overallStatus === "ready" ? "Windows Native runtime 检查通过。" : "Windows Native runtime 仍有待处理项。",
      details: probe.issues.map((issue) => `${issue.summary}${issue.detail ? `: ${issue.detail}` : ""}`).join("\n") || undefined,
      evidence: { runtimeMode: probe.runtimeMode, issues: probe.issues, commands: probe.commands },
      autoFixable: false,
      userActionRequired: probe.overallStatus !== "ready",
      suggestedActions: probe.issues.map((issue) => issue.fixHint).filter((value): value is string => Boolean(value)),
      source: "runtime-probe-service",
    }));
  }

  private async checkHermesPath(
    items: OneClickDiagnosticItem[],
    context: RuntimeContext,
    options: OneClickDiagnosticsRunOptions,
  ): Promise<ResolvedHermesCli | undefined> {
    this.setStage("hermes.path", "正在解析 Windows Hermes 路径...");
    const rootPath = await this.configStore.getEnginePath("hermes");
    const cliPath = await resolveWindowsHermesCliPath(rootPath) ?? defaultWindowsHermesCliPath(rootPath);
    const exists = await fs.access(cliPath).then(() => true).catch(() => false);
    items.push(item({
      id: "hermes.path",
      title: "Hermes 路径",
      status: exists ? "pass" : "fail",
      severity: exists ? "info" : "error",
      summary: exists ? `已解析 Windows Hermes CLI：${cliPath}` : `Windows Hermes CLI 不存在：${cliPath}`,
      evidence: { rootPath, cliPath, runtimeMode: "windows" },
      autoFixable: false,
      userActionRequired: !exists,
      suggestedActions: exists ? [] : ["点击“一键修复”安装 Windows Native Hermes，或在设置中指定正确安装目录。"],
      source: "hermes-cli-resolver",
    }));
    return {
      runtime: { ...context.runtime, mode: "windows", distro: undefined, workerMode: "off" },
      rootPath,
      cliPath,
      source: "windows",
    };
  }

  private async checkHermesCli(
    items: OneClickDiagnosticItem[],
    context: RuntimeContext,
    resolvedCli: ResolvedHermesCli | undefined,
    options: OneClickDiagnosticsRunOptions,
  ) {
    this.setStage("hermes.cli", "正在检查 Hermes CLI capabilities...");
    if (context.runtime.mode !== "wsl") {
      const rootPath = resolvedCli?.rootPath ?? await this.configStore.getEnginePath("hermes");
      const cliPath = resolvedCli?.cliPath ?? await resolveWindowsHermesCliPath(rootPath) ?? defaultWindowsHermesCliPath(rootPath);
      const compatibility = await this.hermesCompatibilityService?.inspect().catch(() => undefined);
      const exists = await fs.access(cliPath).then(() => true).catch(() => false);
      items.push(item({
        id: "hermes.version",
        title: "Hermes 版本",
        status: compatibility?.installed || exists ? "pass" : "fail",
        severity: compatibility?.installed || exists ? "info" : "error",
        summary: compatibility?.installed
          ? `Windows Hermes 可启动：${compatibility.version ?? "版本未知"}。`
          : exists ? "Windows Hermes CLI 文件存在，但版本尚未通过兼容探测。" : "Windows Hermes CLI 文件不存在。",
        evidence: { rootPath, cliPath, compatibility },
        autoFixable: false,
        userActionRequired: !exists,
        suggestedActions: exists ? [] : ["点击“一键修复”安装 Windows Native Hermes。"],
        source: "hermes-cli-resolver",
      }));
      if (!exists) {
        items.push(skippedItem("hermes.compatibility", "Hermes 兼容性", "Hermes CLI 不存在，跳过兼容性检查。", "hermes-compatibility-service"));
        return;
      }
      if (compatibility) {
        items.push(item({
          id: "hermes.compatibility",
          title: "Hermes Forge 兼容性",
          status: compatibility.forgeTaskReady ? compatibility.warnings.length ? "warn" : "pass" : "fail",
          severity: compatibility.forgeTaskReady ? compatibility.warnings.length ? "warning" : "info" : "error",
          summary: compatibility.forgeTaskReady
            ? compatibility.warnings.length
              ? "Hermes 可用于 Forge 任务，但有可完善项。"
              : "Hermes 满足 Forge Windows Native 任务要求。"
            : compatibility.blockingIssues[0] ?? "Hermes 缺少 Forge 任务能力。",
          details: [...compatibility.blockingIssues, ...compatibility.warnings].join("\n") || undefined,
          evidence: compatibility,
          autoFixable: !compatibility.forgeTaskReady || compatibility.warnings.length > 0,
          userActionRequired: !compatibility.forgeTaskReady,
          suggestedActions: compatibility.forgeTaskReady
            ? compatibility.warnings.length ? ["可运行一键修复补齐 venv 或自动修复项。"] : []
            : ["点击“一键修复”重装或修复 Windows Hermes Agent。"],
          source: "hermes-compatibility-service",
        }));
        items.push(item({
          id: "hermes.venv",
          title: "Hermes venv",
          status: compatibility.venvStatus === "present" ? "pass" : "warn",
          severity: compatibility.venvStatus === "present" ? "info" : "warning",
          summary: compatibility.venvStatus === "present" ? "Hermes venv 已存在。" : "未检测到 Hermes venv；源码 CLI 可运行，建议补齐。",
          evidence: { rootPath, venvStatus: compatibility.venvStatus, launchMode: compatibility.launchMode },
          autoFixable: compatibility.venvStatus !== "present",
          userActionRequired: false,
          suggestedActions: compatibility.venvStatus === "present" ? [] : ["运行一键修复尝试补齐 Hermes venv。"],
          source: "hermes-compatibility-service",
        }));
      }
      const result = await this.runWindowsHermesCli(rootPath, cliPath, ["capabilities", "--json"], context.runtime.pythonCommand?.trim() || "python");
      const capabilityStatus = this.classifyWindowsCapabilities(result.stdout, result.stderr, result.exitCode);
      items.push(item({
        id: "hermes.capabilities",
        title: "Hermes capabilities",
        status: capabilityStatus.ok ? "pass" : "warn",
        severity: capabilityStatus.ok ? "info" : "warning",
        summary: capabilityStatus.ok ? "capabilities --json 返回正常，增强能力可用。" : capabilityStatus.message,
        details: capabilityStatus.ok ? undefined : (result.stderr || result.stdout || "").slice(0, 1000),
        evidence: { command: result.command, cliPath, exitCode: result.exitCode, capabilities: capabilityStatus.capabilities },
        autoFixable: false,
        userActionRequired: false,
        suggestedActions: capabilityStatus.ok ? [] : ["官方 Windows Hermes 可用时，capabilities 缺失只作为增强能力 warning；主聊天以 Forge 兼容性检查为准。"],
        source: "hermes-cli-resolver",
      }));
      const doctor = await this.runWindowsHermesCli(
        rootPath,
        cliPath,
        options.autoFix ? ["doctor", "--fix"] : ["doctor"],
        context.runtime.pythonCommand?.trim() || "python",
      );
      const doctorOutput = (doctor.stdout || doctor.stderr || "").trim();
      const doctorHasIssues = /Found\s+\d+\s+issue\(s\)|issue\(s\)\s+to\s+address/i.test(doctorOutput);
      const doctorSupported = doctor.exitCode !== 0
        ? !/invalid choice|unknown command|unrecognized arguments|No module named/i.test(doctorOutput)
        : true;
      items.push(item({
        id: "hermes.doctor",
        title: "Hermes doctor",
        status: doctor.exitCode === 0 ? doctorHasIssues ? "warn" : (options.autoFix ? "fixed" : "pass") : doctorSupported ? "fail" : "skipped",
        severity: doctor.exitCode === 0 ? doctorHasIssues ? "warning" : "info" : doctorSupported ? "error" : "info",
        summary: doctor.exitCode === 0
          ? doctorHasIssues
            ? "Hermes doctor 可运行，但仍有非阻塞建议。"
            : options.autoFix ? "已运行 hermes doctor --fix。" : "已运行 hermes doctor。"
          : doctorSupported
            ? "Hermes doctor 执行失败。"
            : "当前 Hermes CLI 不支持 doctor 命令，已跳过。",
        details: doctorOutput ? doctorOutput.slice(0, 2000) : undefined,
        evidence: { command: doctor.command, exitCode: doctor.exitCode },
        autoFixable: doctorSupported,
        fixed: options.autoFix && doctor.exitCode === 0,
        userActionRequired: doctorSupported && doctor.exitCode !== 0,
        suggestedActions: doctor.exitCode === 0 || !doctorSupported ? [] : ["查看 doctor 输出；必要时点击“一键修复”运行 hermes doctor --fix。"],
        source: "hermes doctor",
      }));
      return;
    }

    items.push(skippedItem(
      "hermes.legacy-wsl",
      "Legacy WSL runtime",
      "WSL 不再作为运行、安装或修复环境；旧数据仅通过 Legacy WSL Migration 导入。",
      "hermes-cli-resolver",
    ));
  }

  private async checkGateway(items: OneClickDiagnosticItem[], options: OneClickDiagnosticsRunOptions) {
    this.setStage("gateway", "正在检查 Gateway 状态和启动前检查...");
    let status = await this.hermesConnectorService.status();
    let fixed = false;
    const canRestart = status.managedRunning || status.healthStatus === "error";
    if (options.autoFix && canRestart) {
      const restart = await this.hermesConnectorService.restart();
      status = restart.status;
      fixed = restart.ok && restart.status.running;
    }
    items.push(item({
      id: "gateway.status",
      title: "Gateway 状态",
      status: fixed ? "fixed" : status.healthStatus === "running" ? "pass" : status.healthStatus === "error" ? "fail" : "warn",
      severity: status.healthStatus === "error" ? "error" : status.healthStatus === "running" ? "info" : "warning",
      summary: fixed ? "已安全重启 Hermes Forge 托管的 Gateway。" : status.message,
      details: status.lastError || status.lastOutput,
      evidence: status,
      autoFixable: canRestart,
      fixed,
      userActionRequired: status.healthStatus !== "running" && !canRestart,
      suggestedActions: status.healthStatus === "running"
        ? []
        : canRestart
          ? ["点击“一键修复”重启 Hermes Forge 托管的 Gateway。"]
          : ["如需连接第三方平台，请在连接器页面启动 Gateway；本轮不会强杀非本项目进程。"],
      source: "hermes-connector-service",
    }));

    const preflight = await this.hermesConnectorService.checkPreflight();
    items.push(item({
      id: "gateway.preflight",
      title: "Gateway 启动前检查",
      status: preflight.ok ? "pass" : "fail",
      severity: preflight.ok ? "info" : "error",
      summary: preflight.message,
      evidence: preflight,
      autoFixable: false,
      userActionRequired: !preflight.ok,
      suggestedActions: preflight.ok ? [] : ["先修复 Hermes 路径 / CLI capabilities，再启动 Gateway。"],
      source: "hermes-connector-service",
    }));
  }

  private async runWindowsHermesCli(rootPath: string, cliPath: string, args: string[], pythonCommand: string) {
    const hermesHome = typeof this.hermesHomeProvider === "function"
      ? await this.hermesHomeProvider()
      : this.hermesHomeProvider;
    const env = hermesCliEnv(rootPath, hermesHome);
    if (isWindowsHermesExecutable(cliPath)) {
      const result = await runCommand(cliPath, args, {
        cwd: rootPath,
        timeoutMs: 20_000,
        runtimeKind: "windows",
        commandId: "one-click.hermes-cli.windows",
        env,
      }).catch((error) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
      return { ...result, command: `${cliPath} ${args.join(" ")}` };
    }
    const candidates = process.platform === "win32" ? [
      path.join(rootPath, "venv", "Scripts", "python.exe"),
      path.join(rootPath, ".venv", "Scripts", "python.exe"),
      pythonCommand,
      "py -3",
      "python",
      "python3",
    ] : [
      path.join(rootPath, "venv", "bin", "python3"),
      path.join(rootPath, ".venv", "bin", "python3"),
      path.join(rootPath, "venv", "bin", "python"),
      path.join(rootPath, ".venv", "bin", "python"),
      pythonCommand,
      "python3",
      "python",
    ];
    let last: { exitCode: number | null; stdout: string; stderr: string } = { exitCode: 1, stdout: "", stderr: "未找到可用 Python 解释器。" };
    let lastCommand = "";
    for (const candidate of candidates) {
      if (path.isAbsolute(candidate) && !(await fs.access(candidate).then(() => true).catch(() => false))) continue;
      const launch = windowsPythonLaunch(candidate);
      const result = await runCommand(launch.command, [...launch.args, cliPath, ...args], {
        cwd: rootPath,
        timeoutMs: 20_000,
        runtimeKind: "windows",
        commandId: "one-click.hermes-cli.windows",
        env,
      }).catch((error) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
      last = result;
      lastCommand = `${launch.command} ${[...launch.args, cliPath, ...args].join(" ")}`;
      if (result.exitCode === 0) return { ...result, command: lastCommand };
    }
    return { ...last, command: lastCommand || `${pythonCommand} ${cliPath} ${args.join(" ")}` };
  }

  private classifyWindowsCapabilities(stdout: string, stderr: string, exitCode: number | null) {
    if (exitCode !== 0) {
      return {
        ok: false,
        message: `capabilities --json 执行失败：${stderr || stdout || `exit ${exitCode ?? "unknown"}`}`,
        capabilities: undefined,
      };
    }
    try {
      const parsed = JSON.parse(stdout) as {
        cliVersion?: unknown;
        capabilities?: {
          supportsLaunchMetadataArg?: unknown;
          supportsLaunchMetadataEnv?: unknown;
          supportsResume?: unknown;
        };
      };
      const capabilities = {
        cliVersion: typeof parsed.cliVersion === "string" ? parsed.cliVersion : undefined,
        supportsLaunchMetadataArg: parsed.capabilities?.supportsLaunchMetadataArg === true,
        supportsLaunchMetadataEnv: parsed.capabilities?.supportsLaunchMetadataEnv === true,
        supportsResume: parsed.capabilities?.supportsResume === true,
      };
      const missing = [
        capabilities.cliVersion ? undefined : "cliVersion",
        capabilities.supportsLaunchMetadataArg ? undefined : "supportsLaunchMetadataArg",
        capabilities.supportsLaunchMetadataEnv ? undefined : "supportsLaunchMetadataEnv",
        capabilities.supportsResume ? undefined : "supportsResume",
      ].filter(Boolean);
      return missing.length
        ? { ok: false, message: `Hermes CLI 存在，但官方版本缺少 Forge capability：${missing.join(", ")}。`, capabilities }
        : { ok: true, message: "capabilities ok", capabilities };
    } catch (error) {
      return {
        ok: false,
        message: `capabilities --json 返回内容不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
        capabilities: undefined,
      };
    }
  }

  private async checkModels(items: OneClickDiagnosticItem[], options: OneClickDiagnosticsRunOptions) {
    this.setStage("model", "正在检查模型配置 schema 和默认模型...");
    const configPath = this.configStore.getConfigPath();
    const config = await this.configStore.read();
    const rawText = await fs.readFile(configPath, "utf8").catch(() => "");
    const raw = parseJsonObject(rawText);
    const rawProfiles = Array.isArray(raw?.modelProfiles)
      ? raw.modelProfiles
      : Array.isArray(raw?.models)
        ? raw.models
        : [];
    const schemaIssues = modelSchemaIssues(raw, rawProfiles);
    const migrated = migrateRuntimeConfigModels({
      ...config,
      ...(raw ?? {}),
      modelProfiles: rawProfiles.length ? rawProfiles : config.modelProfiles,
      providerProfiles: Array.isArray(raw?.providerProfiles) ? raw.providerProfiles : config.providerProfiles,
      updateSources: config.updateSources,
      enginePaths: config.enginePaths,
      enginePermissions: config.enginePermissions,
      hermesRuntime: config.hermesRuntime,
    });
    const normalizedProfiles = migrated.modelProfiles;

    if (!normalizedProfiles.length) {
      items.push(item({
        id: "model.schema",
        title: "模型配置 schema",
        status: "fail",
        severity: "error",
        summary: "当前没有可用模型配置。",
        autoFixable: false,
        userActionRequired: true,
        suggestedActions: ["打开模型设置，添加一个模型并测试连接。"],
        source: "runtime-config",
      }));
      items.push(item({
        id: "model.default",
        title: "默认模型",
        status: "fail",
        severity: "error",
        summary: "没有模型可设为默认。",
        autoFixable: false,
        userActionRequired: true,
        suggestedActions: ["先添加模型，再设为默认。"],
        source: "runtime-config",
      }));
      return;
    }

    const currentDefault = migrated.defaultModelProfileId;
    const defaultExists = Boolean(currentDefault && normalizedProfiles.some((profile) => profile.id === currentDefault));
    const shouldWrite = schemaIssues.length > 0 || !defaultExists;
    let saved: RuntimeConfig | undefined;
    let syncError: string | undefined;
    if (options.autoFix && shouldWrite) {
      const nextDefault = defaultExists ? currentDefault : normalizedProfiles[0]!.id;
      saved = await this.configStore.write({
        ...config,
        modelProfiles: normalizedProfiles,
        providerProfiles: migrated.providerProfiles ?? config.providerProfiles,
        defaultModelProfileId: nextDefault,
      });
      try {
        await this.hermesModelSyncService.syncRuntimeConfig(saved);
      } catch (error) {
        syncError = error instanceof Error ? error.message : String(error);
      }
    }
    const verified = saved ? await this.configStore.read() : undefined;
    const verifiedDefaultExists = Boolean(verified?.defaultModelProfileId && verified.modelProfiles.some((profile) => profile.id === verified.defaultModelProfileId));
    const schemaFixed = Boolean(saved && schemaIssues.length > 0 && verified?.modelProfiles.every((profile) => profile.id));
    const defaultFixed = Boolean(saved && !defaultExists && verifiedDefaultExists);

    items.push(item({
      id: "model.schema",
      title: "模型配置 schema",
      status: schemaFixed ? "fixed" : schemaIssues.length ? "warn" : "pass",
      severity: schemaIssues.length ? "warning" : "info",
      summary: schemaFixed
        ? "已迁移旧模型 schema，并为模型补齐稳定 ID。"
        : schemaIssues.length
          ? `发现旧模型 schema：${schemaIssues.join("；")}`
          : "模型配置 schema 正常。",
      details: syncError ? `Hermes 同步失败：${syncError}` : undefined,
      evidence: { configPath, modelCount: normalizedProfiles.length, issues: schemaIssues },
      autoFixable: schemaIssues.length > 0,
      fixed: schemaFixed,
      userActionRequired: false,
      suggestedActions: schemaIssues.length && !schemaFixed ? ["点击“一键修复”执行 schema migration 并保存配置。"] : [],
      source: "runtime-config",
    }));
    items.push(item({
      id: "model.default",
      title: "默认模型",
      status: defaultFixed ? "fixed" : defaultExists ? "pass" : "fail",
      severity: defaultExists || defaultFixed ? "info" : "error",
      summary: defaultFixed
        ? `已把默认模型修复为 ${verified?.defaultModelProfileId}。`
        : defaultExists
          ? `默认模型有效：${currentDefault}`
          : `默认模型指向不存在的模型：${currentDefault ?? "<empty>"}`,
      details: syncError ? `Hermes 同步失败：${syncError}` : undefined,
      evidence: { previousDefaultModelId: currentDefault, verifiedDefaultModelId: verified?.defaultModelProfileId, modelIds: normalizedProfiles.map((profile) => profile.id) },
      autoFixable: !defaultExists,
      fixed: defaultFixed,
      userActionRequired: !defaultExists && !defaultFixed,
      suggestedActions: defaultExists || defaultFixed ? [] : ["点击“一键修复”自动选择第一个可用模型作为默认模型。"],
      source: "runtime-config",
    }));

    if (!defaultExists && !defaultFixed) {
      items.push(skippedItem("model.connection", "模型真实连接", "默认模型无效，跳过真实模型连通性测试。", "model-connection-service"));
      return;
    }

    if (!this.testModelConnection) {
      items.push(skippedItem("model.connection", "模型真实连接", "当前运行环境未注入模型连通性测试器，跳过真实模型 API 检查。", "model-connection-service"));
      return;
    }

    const healthConfig = saved ?? {
      ...config,
      modelProfiles: normalizedProfiles,
      providerProfiles: migrated.providerProfiles ?? config.providerProfiles,
      defaultModelProfileId: defaultFixed ? verified?.defaultModelProfileId : currentDefault,
    };
    const health = await this.testModelConnection(healthConfig);
    items.push(item({
      id: "model.connection",
      title: "模型真实连接",
      status: health.ok ? "pass" : "fail",
      severity: health.ok ? "info" : "error",
      summary: health.ok ? "默认模型真实连接测试通过。" : `默认模型真实连接失败：${health.message}`,
      details: health.recommendedFix,
      evidence: {
        ok: health.ok,
        providerFamily: health.providerFamily,
        sourceType: health.sourceType,
        profileId: health.profileId,
        normalizedBaseUrl: health.normalizedBaseUrl,
        failureCategory: health.failureCategory,
        healthChecks: health.healthChecks,
      },
      autoFixable: false,
      userActionRequired: !health.ok,
      suggestedActions: health.ok ? [] : [health.recommendedFix || "打开模型设置，重新测试密钥、Base URL 和模型名。"],
      source: "model-connection-service",
    }));
  }

  private async checkTaskLocks(items: OneClickDiagnosticItem[], options: OneClickDiagnosticsRunOptions) {
    this.setStage("task.lock", "正在检查任务锁状态...");
    const locks = this.workspaceLock.listActive();
    const runningSessionIds = new Set(this.taskRunner.listRunningSessionIds());
    const now = Date.now();
    const staleLocks = locks.filter((lock) => !runningSessionIds.has(lock.sessionId) && now - Date.parse(lock.createdAt) >= STALE_LOCK_MIN_AGE_MS);
    const youngOrRunningLocks = locks.filter((lock) => !staleLocks.includes(lock));

    let fixed = false;
    if (options.autoFix && staleLocks.length > 0) {
      for (const lock of staleLocks) {
        this.workspaceLock.release(lock.workspaceId, lock.sessionId);
      }
      const remaining = this.workspaceLock.listActive().filter((lock) => staleLocks.some((stale) => stale.workspaceId === lock.workspaceId && stale.sessionId === lock.sessionId));
      fixed = remaining.length === 0;
    }

    items.push(item({
      id: "task.lock",
      title: "任务锁",
      status: fixed ? "fixed" : staleLocks.length ? "warn" : locks.length ? "pass" : "pass",
      severity: staleLocks.length ? "warning" : "info",
      summary: fixed
        ? `已清理 ${staleLocks.length} 个确认无运行任务的 stale lock。`
        : staleLocks.length
          ? `发现 ${staleLocks.length} 个疑似 stale task lock。`
          : locks.length
            ? "存在任务锁，但对应任务仍在运行或锁刚创建，未判定为 stale。"
            : "当前没有活动任务锁。",
      evidence: { locks, runningSessionIds: [...runningSessionIds], staleLocks, youngOrRunningLocks },
      autoFixable: staleLocks.length > 0,
      fixed,
      userActionRequired: staleLocks.length > 0 && !fixed,
      suggestedActions: staleLocks.length > 0 && !fixed ? ["点击“一键修复”清理确认安全的 stale lock；若仍锁定，请切换会话或重启客户端。"] : [],
      source: "workspace-lock",
    }));
  }

  private async checkPythonDeps(
    items: OneClickDiagnosticItem[],
    context: RuntimeContext,
    resolvedCli: ResolvedHermesCli | undefined,
    options: OneClickDiagnosticsRunOptions,
  ) {
    this.setStage("python.deps", "正在检查 Python 关键依赖...");
    const configuredPython = context.runtime.pythonCommand?.trim() || "python";

    if (!resolvedCli) {
      items.push(skippedItem("python.deps", "Python 依赖", "未解析到 Windows Hermes，跳过 Python 依赖检查。", "hermes-cli-resolver"));
      return;
    }

    const candidates: string[] = [];
    if (process.platform === "win32") {
      candidates.push(path.join(resolvedCli.rootPath, "venv", "Scripts", "python.exe"));
      candidates.push(path.join(resolvedCli.rootPath, ".venv", "Scripts", "python.exe"));
    } else {
      candidates.push(path.join(resolvedCli.rootPath, "venv", "bin", "python3"));
      candidates.push(path.join(resolvedCli.rootPath, ".venv", "bin", "python3"));
      candidates.push(path.join(resolvedCli.rootPath, "venv", "bin", "python"));
      candidates.push(path.join(resolvedCli.rootPath, ".venv", "bin", "python"));
    }
    candidates.push(configuredPython);
    if (configuredPython !== "python") candidates.push("python");
    if (configuredPython !== "python3") candidates.push("python3");
    if (configuredPython !== "py -3") candidates.push("py -3");

    let pythonCmd: string | undefined;
    let pythonCheckOutput = "";
    for (const cmd of candidates) {
      const check = await this.runPythonCheck(cmd);
      if (check.ok) {
        pythonCmd = cmd;
        break;
      }
      if (check.output) pythonCheckOutput = check.output;
    }

    if (!pythonCmd) {
      items.push(item({
        id: "python.deps",
        title: "Python 依赖",
        status: "fail",
        severity: "error",
        summary: `未找到可用的 Python 解释器（已尝试：${candidates.join("、")}）。`,
        details: pythonCheckOutput || undefined,
        autoFixable: false,
        userActionRequired: true,
        suggestedActions: ["安装 Python（建议 3.10+），或在设置中指定正确的 Python 命令。"],
        source: "hermes-cli-resolver",
      }));
      return;
    }

    const pipCheck = await this.runPipVersionCheck(pythonCmd);
    if (pipCheck.exitCode !== 0) {
      items.push(item({
        id: "python.deps",
        title: "Python 依赖",
        status: "fail",
        severity: "error",
        summary: "Python 环境缺少 pip，无法安装 PyYAML / python-dotenv。",
        details: (pipCheck.stderr || pipCheck.stdout).trim() || undefined,
        evidence: { pythonCommand: pythonCmd },
        autoFixable: false,
        userActionRequired: true,
        suggestedActions: ["安装 pip：https://pip.pypa.io/en/stable/installation/"],
        source: "hermes-cli-resolver",
      }));
      return;
    }

    const probe = await this.probePythonModules(pythonCmd);

    let fixed = false;
    let pipFailure: { reason: string; stderr: string; stdout: string } | undefined;
    if (options.autoFix && !probe.ok && probe.missingModules.length > 0) {
      const installResult = await this.installPythonModules(pythonCmd, probe.missingModules);
      if (installResult.success) {
        const recheck = await this.probePythonModules(pythonCmd);
        if (recheck.ok) {
          fixed = true;
          probe.ok = true;
          probe.missingModules = [];
        }
      } else {
        pipFailure = { reason: installResult.reason, stderr: installResult.stderr, stdout: installResult.stdout };
      }
    }

    items.push(item({
      id: "python.deps",
      title: "Python 依赖",
      status: fixed ? "fixed" : probe.ok ? "pass" : "fail",
      severity: probe.ok ? "info" : "error",
      summary: fixed
        ? "已自动安装缺失的 Python 依赖（PyYAML / python-dotenv）。"
        : probe.ok
          ? "Python 关键依赖（PyYAML、python-dotenv）已就绪。"
          : pipFailure
            ? `自动安装失败：${pipFailure.reason}`
            : `Python 环境缺少关键依赖：${probe.missingModules.map((m) => (m === "yaml" ? "PyYAML" : "python-dotenv")).join("、")}。`,
      details: pipFailure ? `${pipFailure.reason}\n${pipFailure.stderr.slice(0, 800)}` : probe.details,
      evidence: { pythonCommand: pythonCmd, missingModules: probe.missingModules, rawOutput: probe.rawOutput },
      autoFixable: !probe.ok && probe.missingModules.length > 0,
      fixed,
      userActionRequired: !probe.ok && !fixed,
      suggestedActions: probe.ok
        ? []
        : pipFailure
          ? [pipFailure.reason, "或在 Hermes 官方安装目录的 venv 中手动执行 pip install。"]
          : this.pythonDepFixSuggestions(pythonCmd, probe.missingModules),
      source: "hermes-cli-resolver",
    }));
  }

  private async runPythonCheck(cmd: string): Promise<{ ok: boolean; output?: string }> {
    const script = `print("python_ok")`;
    const launch = windowsPythonLaunch(cmd);
    const result = await runCommand(launch.command, [...launch.args, "-c", script], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      commandId: "one-click.python-check",
      runtimeKind: "windows",
    });
    return { ok: result.exitCode === 0, output: (result.stderr || result.stdout).trim() || undefined };
  }

  private async probePythonModules(cmd: string): Promise<{ ok: boolean; missingModules: string[]; details?: string; rawOutput?: string }> {
    const combinedScript = `import yaml, dotenv; print("ok")`;
    const combined = await this.runPythonScript(cmd, combinedScript, "one-click.python-modules");
    if (combined.exitCode === 0) {
      return { ok: true, missingModules: [] };
    }

    const output = (combined.stderr || combined.stdout || "").trim();
    const missing: string[] = [];

    for (const mod of ["yaml", "dotenv"]) {
      const modResult = await this.runPythonScript(cmd, `import ${mod}; print("${mod}_ok")`, `one-click.python-module-${mod}`);
      if (modResult.exitCode !== 0) missing.push(mod);
    }

    return {
      ok: false,
      missingModules: missing,
      details: output || undefined,
      rawOutput: output || undefined,
    };
  }

  private async runPipVersionCheck(cmd: string) {
    const launch = windowsPythonLaunch(cmd);
    return runCommand(launch.command, [...launch.args, "-m", "pip", "--version"], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      commandId: "one-click.pip-check",
      runtimeKind: "windows",
    });
  }

  private async runPythonScript(cmd: string, script: string, commandId: string) {
    const launch = windowsPythonLaunch(cmd);
    return runCommand(launch.command, [...launch.args, "-c", script], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      commandId,
      runtimeKind: "windows",
    });
  }

  private async installPythonModules(
    cmd: string,
    missingModules: string[],
  ): Promise<{ success: boolean; reason: string; stderr: string; stdout: string }> {
    const packages = missingModules.map((m) => (m === "yaml" ? "pyyaml" : "python-dotenv"));
    const launch = windowsPythonLaunch(cmd);
    const result = await runCommand(launch.command, [...launch.args, "-m", "pip", "install", ...packages], {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      commandId: "one-click.python-install",
      runtimeKind: "windows",
    });
    if (result.exitCode === 0) return { success: true, reason: "", stderr: "", stdout: result.stdout };
    const reason = this.analyzePipFailure(result.stderr || "", result.stdout || "");
    return { success: false, reason, stderr: result.stderr || "", stdout: result.stdout || "" };
  }

  private analyzePipFailure(stderr: string, stdout: string): string {
    const combined = `${stderr}\n${stdout}`;
    if (/permission denied|permission error|Errno 13/i.test(combined)) {
      return "pip install 因权限不足失败。可尝试添加 --user 参数，或使用管理员权限重新运行。";
    }
    if (/externally-managed|PEP 668|externally managed/i.test(combined)) {
      return "当前 Python 为系统级外部管理环境（PEP 668）。请使用 python3 -m pip install --break-system-packages，或在 venv 中安装。";
    }
    if (/No module named ensurepip/i.test(combined)) {
      return "Python 环境缺少 ensurepip 模块。请安装 python3-venv 或 python3-full。";
    }
    if (/Could not find a version|Connection error|timeout|SSL|certificate|CERTIFICATE_VERIFY_FAILED/i.test(combined)) {
      return "pip install 因网络问题失败，无法连接到 PyPI。请检查网络或代理设置。";
    }
    if (/No module named pip/i.test(combined) || /pip.*not found/i.test(combined)) {
      return "Python 环境缺少 pip。请先安装 python3-pip。";
    }
    const preview = stderr.trim().slice(0, 200) || stdout.trim().slice(0, 200);
    return `pip install 失败${preview ? `：${preview}` : "。"}`;
  }

  private pythonDepFixSuggestions(pythonCmd: string, missingModules: string[]): string[] {
    const packages = missingModules.map((m) => (m === "yaml" ? "pyyaml" : "python-dotenv")).join(" ");
    return [
      `执行：${pythonCmd} -m pip install ${packages}`,
      "或者点击“一键修复”让 Forge 自动安装。",
    ];
  }

  private skipHermesSystemAudit(items: OneClickDiagnosticItem[]) {
    this.setStage("hermes.audit", "已跳过高风险 Hermes 深度审计...");
    items.push(skippedItem(
      "hermes.audit.model",
      "Hermes 深度运行能力测试",
      "安全热修复已默认跳过真实 Hermes Agent 审计，避免大文件读取、host command 或长任务导致卡顿。",
      "HermesSystemAuditService",
    ));
    items.push(skippedItem(
      "hermes.audit.filesystem",
      "Hermes 文件能力审计",
      "安全热修复已跳过极限路径、大文件和跨目录写入审计。",
      "HermesSystemAuditService",
    ));
    items.push(skippedItem(
      "hermes.audit.command",
      "Hermes 命令执行审计",
      "安全热修复已跳过 host command 审计。",
      "HermesSystemAuditService",
    ));
  }

  private async capture(
    items: OneClickDiagnosticItem[],
    fallbackId: string,
    fallbackTitle: string,
    source: string,
    task: () => Promise<void>,
  ) {
    try {
      await task();
    } catch (error) {
      items.push(failureItem(fallbackId, fallbackTitle, error, { source }));
    }
  }

  private async captureValue<T>(
    items: OneClickDiagnosticItem[],
    fallbackId: string,
    fallbackTitle: string,
    source: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await task();
    } catch (error) {
      items.push(failureItem(fallbackId, fallbackTitle, error, { source }));
      return undefined;
    }
  }

  private setStage(stage: string, message: string) {
    this.status = {
      ...this.status,
      running: true,
      stage,
      message,
    };
  }
}

function item(input: OneClickDiagnosticItem): OneClickDiagnosticItem {
  return trimDiagnosticItem(redactSensitiveValue(input));
}

function skippedItem(id: string, title: string, summary: string, source?: string): OneClickDiagnosticItem {
  return item({
    id,
    title,
    status: "skipped",
    severity: "info",
    summary,
    autoFixable: false,
    source,
  });
}

function failureItem(
  id: string,
  title: string,
  error: unknown,
  extra: Partial<OneClickDiagnosticItem> = {},
): OneClickDiagnosticItem {
  const message = error instanceof Error ? error.message : String(error);
  return item({
    id,
    title,
    status: "fail",
    severity: "error",
    summary: extra.summary ?? message,
    details: extra.details ?? message,
    autoFixable: extra.autoFixable ?? false,
    userActionRequired: extra.userActionRequired ?? true,
    suggestedActions: extra.suggestedActions ?? ["导出诊断报告并根据错误信息修复。"],
    source: extra.source,
    evidence: extra.evidence,
    fixed: extra.fixed,
  });
}

function auditItem(id: string, title: string, step: HermesSystemAuditStep | undefined, source: string): OneClickDiagnosticItem {
  if (!step) {
    return skippedItem(id, title, "本项审计没有返回结果。", source);
  }
  return item({
    id,
    title,
    status: step.status === "passed" ? "pass" : step.status === "skipped" ? "skipped" : "fail",
    severity: step.status === "failed" ? "error" : "info",
    summary: step.message,
    details: step.detail,
    evidence: step,
    autoFixable: false,
    userActionRequired: step.status === "failed",
    suggestedActions: step.status === "failed" ? ["检查模型配置、Hermes runtime 和运行权限。"] : [],
    source,
  });
}

function summarize(items: OneClickDiagnosticItem[]): OneClickDiagnosticsReport["summary"] {
  const count = (status: OneClickDiagnosticStatus) => items.filter((item) => item.status === status).length;
  const warnings = count("warn");
  const failed = count("fail");
  const fixed = count("fixed");
  const skipped = count("skipped");
  return {
    total: items.length,
    passed: count("pass"),
    warnings,
    failed,
    fixed,
    skipped,
    unresolved: items.filter((item) => (item.status === "fail" || item.status === "warn") && !item.fixed).length,
  };
}

function normalizeRuntime(config: RuntimeConfig): NonNullable<RuntimeConfig["hermesRuntime"]> {
  return {
    mode: "windows",
    distro: undefined,
    pythonCommand: config.hermesRuntime?.pythonCommand?.trim() || "python",
    managedRoot: config.hermesRuntime?.managedRoot?.trim() || undefined,
    windowsAgentMode: config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
    cliPermissionMode: config.hermesRuntime?.cliPermissionMode ?? "yolo",
    permissionPolicy: config.hermesRuntime?.permissionPolicy ?? "bridge_guarded",
    installSource: config.hermesRuntime?.installSource,
    workerMode: "off",
  };
}

function trimDiagnosticItem(value: OneClickDiagnosticItem): OneClickDiagnosticItem {
  return trimDiagnosticValue(value) as OneClickDiagnosticItem;
}

function trimDiagnosticValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return previewDiagnosticText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (depth >= 4) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => trimDiagnosticValue(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value)) {
    result[key] = trimDiagnosticValue(itemValue, depth + 1);
  }
  return result;
}

function previewDiagnosticText(value: string | undefined) {
  if (!value) return value;
  return value.length > 6000 ? `${value.slice(0, 6000)}\n...[truncated]` : value;
}

function hermesCliEnv(rootPath: string, hermesHome?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: `${rootPath}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...(hermesHome ? { HERMES_HOME: hermesHome } : {}),
  };
}

function windowsPythonLaunch(command: string) {
  const trimmed = command.trim();
  const pyLauncher = trimmed.match(/^py(?:\.exe)?\s+(-3(?:\.\d+)?)$/i);
  if (pyLauncher) {
    return { command: "py", args: [pyLauncher[1] ?? "-3"] };
  }
  return { command: trimmed, args: [] };
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function modelSchemaIssues(raw: Record<string, unknown> | undefined, rawProfiles: unknown[]) {
  const issues: string[] = [];
  if (!raw) {
    issues.push("配置文件为空或不是有效 JSON，当前使用运行时默认配置");
    return issues;
  }
  if ("models" in raw) issues.push("存在旧字段 models");
  for (const field of ["defaultModelId", "defaultModel", "default_model", "default_model_id"]) {
    if (field in raw) issues.push(`存在旧默认模型字段 ${field}`);
  }
  const missingIdCount = rawProfiles.filter((profile) => profile && typeof profile === "object" && !("id" in profile)).length;
  if (missingIdCount > 0) issues.push(`${missingIdCount} 个模型缺少稳定 id`);
  const isDefaultCount = rawProfiles.filter((profile) => profile && typeof profile === "object" && (profile as { isDefault?: unknown }).isDefault === true).length;
  if (isDefaultCount > 1) issues.push(`存在 ${isDefaultCount} 个 isDefault=true`);
  return issues;
}
