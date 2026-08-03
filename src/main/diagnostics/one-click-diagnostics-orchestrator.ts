import fs from "node:fs/promises";
import path from "node:path";
import { defaultOfficialHermesHome } from "../hermes-home";
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

type ManagedInstallMarker = {
  source?: string;
  installer?: string;
  repoUrl?: string;
  branch?: string;
  commit?: string;
  installedCommit?: string;
  sourceLabel?: string;
  editable?: boolean;
  installedAt?: string;
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
    private readonly managedHermesHomeProvider?: () => Promise<string> | string,
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
        await this.capture(items, "hermes.install-source", "Hermes 安装来源", "runtime-config", async () => {
          await this.checkInstallSourceAndHome(items, context!);
        });
        await this.capture(items, "runtime.windows", "Windows Native 运行环境", "runtime-probe-service", async () => {
          await this.checkWindowsRuntime(items, context!, options);
        });
        resolvedCli = await this.captureValue(items, "hermes.path", "Hermes 路径检查", "hermes-cli-resolver", async () =>
          this.checkHermesPath(items, context!, options),
        );
        await this.capture(items, "hermes.toolchain", "Hermes Windows 工具链", "one-click-diagnostics-orchestrator", async () => {
          await this.checkWindowsToolchain(items, resolvedCli?.rootPath ?? await this.configStore.getEnginePath("hermes"));
        });
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

  private async checkInstallSourceAndHome(items: OneClickDiagnosticItem[], context: RuntimeContext) {
    this.setStage("hermes.source", "正在检查 Hermes 安装来源和 home 隔离状态...");
    const source = context.runtime.installSource;
    const label = normalizeInstallSourceLabel(source?.sourceLabel);
    const repoUrl = source?.repoUrl || "https://github.com/NousResearch/hermes-agent.git";
    const ref = source?.commit || source?.branch || "main";
    const sourceMeta = installSourceDiagnostic(label, repoUrl, ref);
    const rootPath = typeof this.configStore.getEnginePath === "function"
      ? await this.configStore.getEnginePath("hermes").catch(() => undefined)
      : undefined;
    const marker = rootPath ? await readManagedInstallMarker(rootPath) : undefined;

    items.push(item({
      id: "hermes.install-source",
      title: "Hermes 安装来源",
      status: sourceMeta.status,
      severity: sourceMeta.severity,
      summary: sourceMeta.summary,
      details: sourceMeta.details,
      evidence: { sourceLabel: label, repoUrl, ref, configuredSource: source, installRoot: rootPath, marker },
      autoFixable: false,
      userActionRequired: sourceMeta.userActionRequired,
      suggestedActions: sourceMeta.suggestedActions,
      source: "runtime-config",
    }));

    items.push(installMarkerDiagnostic(rootPath, marker));

    const officialHome = defaultOfficialHermesHome();
    const managedHome = await resolveOptionalPath(this.managedHermesHomeProvider);
    const activeHermesHome = await resolveOptionalPath(this.hermesHomeProvider);
    const officialStat = await fs.lstat(officialHome).catch(() => undefined);
    if (!officialStat) {
      items.push(item({
        id: "hermes.home-link",
        title: "Hermes home 与原版 CLI",
        status: "warn",
        severity: "warning",
        summary: "未检测到原版 Hermes 默认 home；Forge 会继续使用托管 home，但独立 hermes CLI 可能看不到 Forge 配置。",
        evidence: { officialHome, managedHome, activeHermesHome, linkState: "missing" },
        autoFixable: false,
        userActionRequired: false,
        suggestedActions: ["重启客户端会再次尝试把原版 Hermes home 安全链接到 Forge 托管 home；不要手动覆盖含密钥目录。"],
        source: "hermes-home",
      }));
      return;
    }

    if (officialStat.isSymbolicLink()) {
      const target = await fs.realpath(officialHome).catch(() => undefined);
      const realManagedHome = managedHome ? await fs.realpath(managedHome).catch(() => managedHome) : undefined;
      const pointsToForge = Boolean(target && realManagedHome && samePath(target, realManagedHome));
      items.push(item({
        id: "hermes.home-link",
        title: "Hermes home 与原版 CLI",
        status: pointsToForge || !realManagedHome ? "pass" : "warn",
        severity: pointsToForge || !realManagedHome ? "info" : "warning",
        summary: pointsToForge
          ? "原版 Hermes 默认 home 已安全链接到 Forge 托管 home，配置可共享。"
          : "原版 Hermes 默认 home 是链接，但没有指向当前 Forge 托管 home。",
        evidence: { officialHome, managedHome, activeHermesHome, linkTarget: target, linkState: pointsToForge ? "forge_link" : "external_link" },
        autoFixable: false,
        userActionRequired: !pointsToForge && Boolean(realManagedHome),
        suggestedActions: pointsToForge ? [] : ["检查原版 Hermes home 的链接目标；如需共享配置，请通过迁移/导入流程处理，避免直接覆盖。"],
        source: "hermes-home",
      }));
      return;
    }

    if (officialStat.isDirectory()) {
      const realOfficialHome = await fs.realpath(officialHome).catch(() => officialHome);
      const realManagedHome = managedHome ? await fs.realpath(managedHome).catch(() => managedHome) : undefined;
      const sameAsManaged = Boolean(realManagedHome && samePath(realOfficialHome, realManagedHome));
      items.push(item({
        id: "hermes.home-link",
        title: "Hermes home 与原版 CLI",
        status: sameAsManaged ? "pass" : "warn",
        severity: sameAsManaged ? "info" : "warning",
        summary: sameAsManaged
          ? "原版 Hermes 默认 home 与 Forge 托管 home 指向同一目录。"
          : "检测到原版 Hermes 默认 home 独立存在；Forge 不会覆盖它，原版 CLI 与 Forge 配置可能分离。",
        evidence: { officialHome, managedHome, activeHermesHome, linkState: sameAsManaged ? "same_directory" : "independent_directory" },
        autoFixable: false,
        userActionRequired: false,
        suggestedActions: sameAsManaged ? [] : ["这是安全隔离状态，不会破坏原版 Hermes；如需合并配置，请先备份并使用迁移/导入流程。"],
        source: "hermes-home",
      }));
      return;
    }

    items.push(item({
      id: "hermes.home-link",
      title: "Hermes home 与原版 CLI",
      status: "fail",
      severity: "error",
      summary: "原版 Hermes 默认 home 已存在但不是目录或链接，可能影响原版 CLI 与 Forge 配置共享。",
      evidence: { officialHome, managedHome, activeHermesHome, linkState: "unexpected_file" },
      autoFixable: false,
      userActionRequired: true,
      suggestedActions: ["检查该路径内容并备份后手动处理；不要让 Forge 自动覆盖含密钥或记忆的文件。"],
      source: "hermes-home",
    }));
  }

  private async checkWindowsToolchain(items: OneClickDiagnosticItem[], rootPath: string) {
    this.setStage("hermes.toolchain", "正在检查 Hermes Windows 工具链...");
    const hermesHome = path.dirname(rootPath);
    const gitBashCandidates = [
      process.env.HERMES_GIT_BASH_PATH,
      path.join(hermesHome, "git", "bin", "bash.exe"),
      path.join(hermesHome, "git", "usr", "bin", "bash.exe"),
    ].filter((value): value is string => Boolean(value?.trim()));
    const managedNode = path.join(hermesHome, "node", "node.exe");

    const [gitBash, node, uv, rg, ffmpeg] = await Promise.all([
      firstExistingPath(gitBashCandidates),
      this.probeCommandChain([{ command: managedNode, args: ["--version"], label: "Hermes-managed Node.js" }, { command: "node", args: ["--version"], label: "Node.js" }]),
      this.probeCommandChain([{ command: "uv", args: ["--version"], label: "uv" }]),
      this.probeCommandChain([{ command: "rg", args: ["--version"], label: "ripgrep" }]),
      this.probeCommandChain([{ command: "ffmpeg", args: ["-version"], label: "ffmpeg" }]),
    ]);
    const missing = [
      gitBash ? undefined : "Git Bash",
      node.available ? undefined : "Node.js",
      uv.available ? undefined : "uv",
      rg.available ? undefined : "ripgrep",
      ffmpeg.available ? undefined : "ffmpeg",
    ].filter((value): value is string => Boolean(value));
    const coreMissing = [
      gitBash ? undefined : "Git Bash",
      uv.available ? undefined : "uv",
    ].filter((value): value is string => Boolean(value));
    items.push(item({
      id: "hermes.toolchain",
      title: "Hermes Windows 工具链",
      status: missing.length ? "warn" : "pass",
      severity: missing.length ? "warning" : "info",
      summary: missing.length
        ? `发现 ${missing.length} 个官方安装工具链组件缺失或不可见：${missing.join("、")}。`
        : "官方 Windows 工具链组件可见：Git Bash、Node.js、uv、ripgrep、ffmpeg。",
      details: [
        gitBash ? `Git Bash: ${gitBash}` : "Git Bash: 未检测到 HERMES_GIT_BASH_PATH 或 Hermes-managed git\\bin\\bash.exe",
        `Node.js: ${node.message}`,
        `uv: ${uv.message}`,
        `ripgrep: ${rg.message}`,
        `ffmpeg: ${ffmpeg.message}`,
      ].join("\n"),
      evidence: { rootPath, hermesHome, gitBash, node, uv, rg, ffmpeg },
      autoFixable: false,
      userActionRequired: coreMissing.length > 0,
      suggestedActions: missing.length
        ? ["重跑 Hermes Windows 安装脚本可补齐官方工具链；如果是企业网络限制，请展开安装日志确认 Node/PortableGit/uv 的下载源。"]
        : [],
      source: "one-click-diagnostics-orchestrator",
    }));
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
        summary: capabilityStatus.ok ? "Hermes CLI 增强能力可用。" : capabilityStatus.message,
        details: capabilityStatus.ok ? undefined : "原始输出已记录到诊断报告，可通过导出功能查看。",
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
        details: doctorOutput ? "原始输出已记录到诊断报告，可通过导出功能查看。" : undefined,
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

  private async probeCommandChain(candidates: Array<{ command: string; args: string[]; label: string }>) {
    const failures: string[] = [];
    for (const candidate of candidates) {
      if (looksLikeFilePath(candidate.command) && !(await pathExists(candidate.command))) {
        failures.push(`${candidate.label}: 文件不存在`);
        continue;
      }
      const result = await runCommand(candidate.command, candidate.args, {
        cwd: process.cwd(),
        timeoutMs: 8_000,
        runtimeKind: "windows",
        commandId: `one-click.toolchain.${candidate.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      }).catch((error) => ({ exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
      const output = (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0]?.trim() ?? "";
      if (result.exitCode === 0) {
        return {
          available: true,
          command: candidate.command,
          args: candidate.args,
          label: candidate.label,
          version: output,
          message: output ? `${candidate.label} 可用：${output}` : `${candidate.label} 可用。`,
        };
      }
      failures.push(`${candidate.label}: ${output || `exit ${result.exitCode ?? "unknown"}`}`);
    }
    return {
      available: false,
      message: failures.slice(0, 3).join("；") || "未检测到可用命令。",
    };
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
        summary: "未找到可用的 Python 解释器。",
        details: "原始检测输出已记录到诊断报告。",
        autoFixable: false,
        userActionRequired: true,
        suggestedActions: ["安装 Python（建议 3.10+），或在设置中指定正确的 Python 命令。"],
        source: "hermes-cli-resolver",
      }));
      return;
    }

    const pipCheck = await this.runPipVersionCheck(pythonCmd);
    let hasPip = pipCheck.exitCode === 0;

    const probe = await this.probePythonModules(pythonCmd);

    // 如果 pip 不可用，但关键模块都已就绪，降级为 warn（避免误报）。
    // Windows Native 运行时可能通过其他方式已具备 yaml/dotenv，pip 缺失不阻塞主链路。
    if (!hasPip && probe.ok) {
      items.push(item({
        id: "python.deps",
        title: "Python 依赖",
        status: "warn",
        severity: "warning",
        summary: "当前 Python 环境没有 pip，但 PyYAML / python-dotenv 已就绪，不影响运行。",
        details: undefined,
        evidence: { pythonCommand: pythonCmd, pipError: (pipCheck.stderr || pipCheck.stdout).trim() || undefined },
        autoFixable: false,
        userActionRequired: false,
        suggestedActions: ["如需在 venv 中安装新包，可手动安装 pip。"],
        source: "hermes-cli-resolver",
      }));
      return;
    }

    // pip 缺失且模块也不全，才是真正的阻塞错误
    if (!hasPip && !probe.ok) {
      items.push(item({
        id: "python.deps",
        title: "Python 依赖",
        status: "fail",
        severity: "error",
        summary: "Python 环境缺少 pip，无法安装 PyYAML / python-dotenv。",
        details: undefined,
        evidence: { pythonCommand: pythonCmd, pipError: (pipCheck.stderr || pipCheck.stdout).trim() || undefined },
        autoFixable: false,
        userActionRequired: true,
        suggestedActions: ["安装 pip。"],
        source: "hermes-cli-resolver",
      }));
      return;
    }

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
      details: pipFailure ? pipFailure.reason : probe.details,
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
    summary: extra.summary ?? "检查执行异常。",
    details: extra.details ?? "原始错误已记录到诊断报告，可通过导出功能查看。",
    autoFixable: extra.autoFixable ?? false,
    userActionRequired: extra.userActionRequired ?? true,
    suggestedActions: extra.suggestedActions ?? ["导出诊断报告并根据错误信息修复。"],
    source: extra.source,
    evidence: { ...(extra.evidence ?? {}), rawError: message },
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

function normalizeInstallSourceLabel(label: unknown): "official" | "mirror" | "custom" | "pinned" {
  if (label === "official" || label === "mirror" || label === "pinned") return label;
  if (label === "custom" || label === "fork") return "custom";
  return "official";
}

function installSourceDiagnostic(label: "official" | "mirror" | "custom" | "pinned", repoUrl: string, ref: string): {
  status: OneClickDiagnosticStatus;
  severity: OneClickDiagnosticSeverity;
  summary: string;
  details?: string;
  suggestedActions: string[];
  userActionRequired: boolean;
} {
  if (label === "official") {
    return {
      status: "pass",
      severity: "info",
      summary: "安装来源为 Nous 官方 GitHub。",
      details: `${repoUrl}@${ref}`,
      suggestedActions: [],
      userActionRequired: false,
    };
  }
  if (label === "mirror") {
    return {
      status: "warn",
      severity: "warning",
      summary: "安装来源为中文社区/国内镜像，非 Nous 官方源。",
      details: `${repoUrl}@${ref}`,
      suggestedActions: ["网络恢复后建议切回 Nous 官方 GitHub；只在 GitHub 下载受限时使用国内社区镜像。"],
      userActionRequired: false,
    };
  }
  return {
    status: "warn",
    severity: "warning",
    summary: label === "pinned" ? "安装来源为固定版本，请确认该 commit 仍符合预期。" : "安装来源为自定义仓库/分支，请确认来源可信。",
    details: `${repoUrl}@${ref}`,
    suggestedActions: ["仅在测试、内部 fork 或固定版本回滚时使用自定义来源；生产环境优先切回 Nous 官方 GitHub。"],
    userActionRequired: false,
  };
}

function installMarkerDiagnostic(rootPath: string | undefined, marker: ManagedInstallMarker | undefined): OneClickDiagnosticItem {
  if (!rootPath) {
    return skippedItem("hermes.install-marker", "Forge 安装标记", "Hermes 安装路径未配置，跳过安装标记检查。", "native-install-strategy");
  }
  if (!marker) {
    return item({
      id: "hermes.install-marker",
      title: "Forge 安装标记",
      status: "warn",
      severity: "warning",
      summary: "未找到 Forge 托管安装标记；可能是原版手动安装或旧版本 Forge 安装。",
      evidence: { rootPath, markerPath: path.join(rootPath, ".zhenghebao-managed-install.json") },
      autoFixable: false,
      userActionRequired: false,
      suggestedActions: ["如需让 Forge 记录来源、commit 和安装器信息，可通过设置中心重跑安装/修复。"],
      source: "native-install-strategy",
    });
  }
  return item({
    id: "hermes.install-marker",
    title: "Forge 安装标记",
    status: "pass",
    severity: "info",
    summary: marker.installedCommit
      ? `Forge 托管安装标记存在，当前安装 commit：${marker.installedCommit.slice(0, 12)}。`
      : "Forge 托管安装标记存在，但未记录安装 commit。",
    details: [
      `repo: ${marker.repoUrl ?? "unknown"}`,
      `ref: ${marker.commit ?? marker.branch ?? "main"}`,
      `installer: ${marker.installer ?? "unknown"}`,
      `installedAt: ${marker.installedAt ?? "unknown"}`,
    ].join("\n"),
    evidence: { rootPath, marker },
    autoFixable: false,
    userActionRequired: false,
    suggestedActions: [],
    source: "native-install-strategy",
  });
}

async function readManagedInstallMarker(rootPath: string): Promise<ManagedInstallMarker | undefined> {
  const markerPath = path.join(rootPath, ".zhenghebao-managed-install.json");
  const raw = await fs.readFile(markerPath, "utf8").catch(() => "");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ManagedInstallMarker;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function resolveOptionalPath(provider?: (() => Promise<string> | string) | string): Promise<string | undefined> {
  if (!provider) return undefined;
  const value = typeof provider === "function" ? await provider() : provider;
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function looksLikeFilePath(value: string) {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

async function firstExistingPath(candidates: string[]) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

async function pathExists(targetPath: string) {
  return fs.access(targetPath).then(() => true).catch(() => false);
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
    cliPermissionMode: config.hermesRuntime?.cliPermissionMode ?? "guarded",
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
