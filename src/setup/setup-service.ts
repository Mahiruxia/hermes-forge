import fs from "node:fs/promises";
import path from "node:path";
import { resolveActiveHermesHome } from "../main/hermes-home";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { SecretVault } from "../auth/secret-vault";
import { runCommand } from "../process/command-runner";
import type {
  EngineMaintenanceResult,
  HermesCompatibilityReport,
  HermesInstallEvent,
  HermesInstallResult,
  RuntimeConfig,
  SetupCheck,
  SetupDependencyRepairId,
  SetupDependencyRepairResult,
  SetupSummary,
} from "../shared/types";
import { missingSecretMessage, normalizeOpenAiCompatibleBaseUrl, requiresStoredSecret } from "../shared/model-config";
import type { RuntimeProbeService } from "../runtime/runtime-probe-service";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import type { RuntimeProbeResult } from "../runtime/runtime-types";
import { InstallOrchestrator } from "../install/install-orchestrator";
import { NativeInstallStrategy } from "../install/native-install-strategy";
import { HermesCompatibilityService } from "./hermes-compatibility-service";
import { managedHermesEnvironmentEnv, resolveManagedHermesEnvironment } from "../runtime/managed-hermes-environment";

type InstallPublisher = (event: HermesInstallEvent) => void;
export type HermesInstallOptions = {
  rootPath?: string;
  source?: {
    kind: "official" | "mirror" | "custom";
    repoUrl?: string;
    branch?: string;
    commit?: string;
  };
};

export class SetupService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly hermes: EngineAdapter,
    private readonly configStore: RuntimeConfigStore,
    private readonly secretVault: SecretVault,
    private readonly runtimeProbeService?: RuntimeProbeService,
    private readonly runtimeAdapterFactory?: RuntimeAdapterFactory,
    private readonly installOrchestrator?: InstallOrchestrator,
    private readonly hermesCompatibilityService?: HermesCompatibilityService,
  ) {}

  async getSummary(workspacePath?: string): Promise<SetupSummary> {
    const config = await this.configStore.read();
    const runtimeProbe = await this.runtimeProbeService?.probe({ workspacePath }).catch(() => undefined);
    const hermesCompatibility = await this.hermesCompatibilityService?.inspect().catch(() => undefined);
    const checks: SetupCheck[] = [
      runtimeProbe ? this.gitCheckFromProbe(runtimeProbe) : await this.checkCommand("git", ["--version"], "git", "Git", {
        statusOnFailure: "missing",
        description: "Hermes 首次自动安装需要 Git 拉取核心仓库；已安装 Hermes 的用户不一定受影响。",
        recommendedAction: "点击一键安装 Git，或手动安装 Git for Windows 后重启客户端。",
        fixAction: "install_git",
        autoFixId: "git",
        blocking: false,
      }),
      runtimeProbe ? this.pythonCheckFromProbe(runtimeProbe) : await this.checkManagedPython(),
      ...(runtimeProbe?.runtimeMode === "wsl" ? [this.wslCheckFromProbe(runtimeProbe)] : []),
      runtimeProbe ? this.hermesCheckFromProbe(runtimeProbe) : await this.checkHermes(),
      await this.checkHermesAgentCompatibility(hermesCompatibility),
      await this.checkHermesPythonPackageWithRuntime(runtimeProbe, "hermes-pyyaml", "Hermes 配置依赖", "yaml", "PyYAML", {
        description: "Hermes CLI 读取 config.yaml 时需要 PyYAML；缺失时会出现 No module named 'yaml'。",
        recommendedAction: "点击修复 Hermes 依赖，按当前锁文件同步受管环境。",
        fixAction: "install_hermes_dependency",
        autoFixId: "hermes_pyyaml",
        blocking: true,
      }),
      await this.checkHermesPythonPackageWithRuntime(runtimeProbe, "hermes-dotenv", "Hermes 环境变量依赖", "dotenv", "python-dotenv", {
        description: "Hermes CLI 读取 .env 时需要 python-dotenv；缺失时会出现 No module named 'dotenv'。",
        recommendedAction: "点击修复 Hermes 依赖，按当前锁文件同步受管环境。",
        fixAction: "install_hermes_dependency",
        autoFixId: "hermes_python_dotenv",
        blocking: true,
      }),
      ...await this.checkEnabledConnectorDependencies(config, runtimeProbe),
      await this.checkModelConfig(config),
      await this.checkWritable("user-data", "用户数据目录", this.appPaths.baseDir()),
    ];

    if (workspacePath?.trim()) {
      checks.push(await this.checkWritable("workspace", "当前工作区", workspacePath));
    }

    const suggestions = this.buildSuggestions(checks);
    const suggestionChecks = suggestions.map((message, index) => ({
      id: `suggestion-${index + 1}`,
      label: "建议",
      status: "warning" as const,
      message,
      blocking: false,
    }));
    const mergedChecks = [...checks, ...suggestionChecks];
    const blocking = mergedChecks.filter((check) =>
      check.blocking !== false && (check.status === "missing" || check.status === "failed"),
    );
    return { ready: blocking.length === 0, blocking, checks: mergedChecks, hermesCompatibility };
  }

  private gitCheckFromProbe(probe: RuntimeProbeResult): SetupCheck {
    return {
      id: "git",
      label: "Git",
      status: probe.gitAvailable ? "ok" : "missing",
      message: probe.commands.git.message,
      description: "Hermes 首次自动安装需要 Git 拉取核心仓库；该结果来自统一 RuntimeProbe。",
      recommendedAction: probe.gitAvailable ? undefined : "点击一键安装 Git，或手动安装 Git for Windows 后重启客户端。",
      fixAction: probe.gitAvailable ? undefined : "install_git",
      canAutoFix: probe.gitAvailable ? undefined : true,
      autoFixId: probe.gitAvailable ? undefined : "git",
      blocking: false,
    };
  }

  private pythonCheckFromProbe(probe: RuntimeProbeResult): SetupCheck {
    const available = probe.runtimeMode === "wsl" ? Boolean(probe.wslPythonAvailable) : probe.pythonAvailable;
    return {
      id: "python",
      label: probe.runtimeMode === "wsl" ? "WSL Python" : "Python",
      status: available ? "ok" : "missing",
      message: probe.runtimeMode === "wsl" ? probe.commands.wsl.message : probe.commands.python.message,
      description: "Hermes CLI、微信连接器和部分本地桥接能力依赖 Python；该结果来自统一 RuntimeProbe。",
      recommendedAction: available ? undefined : "请修复 Hermes 受管环境；安装流程会准备独立的 Python。",
      fixAction: available ? undefined : "install_python",
      canAutoFix: available || probe.runtimeMode === "wsl" ? undefined : true,
      autoFixId: available || probe.runtimeMode === "wsl" ? undefined : "python",
      blocking: false,
    };
  }

  private async checkManagedPython(): Promise<SetupCheck> {
    const environment = await resolveManagedHermesEnvironment(await this.configStore.getEnginePath("hermes"));
    const result = environment ? await runCommand(environment.pythonPath, ["--version"], {
      cwd: environment.rootPath, env: managedHermesEnvironmentEnv(environment), timeoutMs: 8000,
    }) : undefined;
    const ok = result?.exitCode === 0;
    return {
      id: "python", label: "Hermes Python", status: ok ? "ok" : "missing",
      message: ok ? (result?.stdout || result?.stderr || "Hermes Python 可用。").trim() : "Hermes 受管 Python 不可用，请修复安装。",
      description: "与聊天和升级使用同一个 Hermes 虚拟环境。",
      recommendedAction: ok ? undefined : "点击修复 Hermes 环境。", fixAction: ok ? undefined : "install_python",
      autoFixId: ok ? undefined : "python", canAutoFix: !ok, blocking: false,
    };
  }

  private wslCheckFromProbe(probe: RuntimeProbeResult): SetupCheck {
    const ok = probe.wslAvailable && probe.distroExists !== false && probe.distroReachable !== false;
    return {
      id: "wsl",
      label: "WSL Runtime",
      status: ok ? "ok" : "missing",
      message: probe.commands.wsl.message,
      description: "当前 Hermes runtime 处于 WSL 模式；该结果来自统一 RuntimeProbe。",
      recommendedAction: ok ? undefined : "请启用 WSL、安装目标发行版，或切回 Windows runtime。",
      fixAction: ok ? undefined : "open_settings",
      blocking: !ok,
    };
  }

  private hermesCheckFromProbe(probe: RuntimeProbeResult): SetupCheck {
    if (!probe.hermesRootExists || !probe.hermesCliExists) {
      const issue = probe.issues.find((item) => item.code === "hermes_root_missing" || item.code === "hermes_cli_missing");
      return {
        id: "hermes",
        label: "Hermes",
        status: "missing",
        message: [issue?.summary ?? "Hermes 未完全就绪。", issue?.detail].filter(Boolean).join(" "),
        description: "核心 Agent 未就绪时，桌面端可以打开配置页，但无法可靠执行真实任务。该结果来自统一 RuntimeProbe。",
        recommendedAction: issue?.fixHint ?? "优先点击自动安装 Hermes；如果已经手动安装，请在常规设置里指定 Hermes 根目录。",
        fixAction: "install_hermes",
        blocking: true,
      };
    }
    return {
      id: "hermes",
      label: "Hermes",
      status: "ok",
      message: `Hermes CLI 已解析。`,
      description: "Hermes root/CLI 结果来自统一 RuntimeProbe。",
      blocking: false,
    };
  }

  private buildSuggestions(checks: SetupCheck[]) {
    const suggestions: string[] = [];
    const git = checks.find((check) => check.id === "git");
    const python = checks.find((check) => check.id === "python");
    const hermes = checks.find((check) => check.id === "hermes");
    const weixin = checks.find((check) => check.id === "weixin-aiohttp");
    const model = checks.find((check) => check.id === "model" || check.id === "model-placeholder" || check.id === "model-secret");
    if (git?.status !== "ok") {
      suggestions.push("首次自动安装 Hermes 需要 Git；如果客户机器没有 Git，请在系统状态页一键安装或改用手动 Hermes 路径。");
    }
    if (python?.status !== "ok") {
      suggestions.push("建议优先修复 Python 环境，否则 Hermes CLI 与更新动作可能无法正常运行。");
    }
    if (hermes?.status !== "ok") {
      suggestions.push("建议先完成 Hermes 路径和 CLI 自检，再进行真实任务执行。");
    }
    if (weixin && weixin.status !== "ok") {
      suggestions.push("微信端需要 Python aiohttp 依赖；未安装时桌面聊天仍可用，但微信扫码/网关可能失败。");
    }
    if (model?.status !== "ok") {
      suggestions.push("建议先确认默认模型与密钥配置，避免任务启动后才失败。");
    }
    return suggestions;
  }

  private fallbackOrchestrator?: InstallOrchestrator;

  private maintenanceOrchestrator() {
    this.fallbackOrchestrator ??= this.installOrchestrator
      ?? new InstallOrchestrator(this.configStore, new NativeInstallStrategy(this.appPaths, this.hermes, this.configStore, this.runtimeProbeService, this.runtimeAdapterFactory));
    return this.fallbackOrchestrator;
  }

  async updateHermes(publish?: InstallPublisher): Promise<EngineMaintenanceResult> {
    const startedAt = new Date().toISOString();
    publish?.({ stage: "preflight", progress: 10, message: "正在准备 Hermes 更新。", startedAt, at: startedAt });
    const result = await this.maintenanceOrchestrator().update();
    publish?.({ stage: result.ok ? "completed" : "failed", progress: 100, message: result.message, startedAt, at: new Date().toISOString() });
    return { ...result, engineId: "hermes" };
  }

  async installHermes(publish?: InstallPublisher, options: HermesInstallOptions = {}): Promise<HermesInstallResult> {
    return this.maintenanceOrchestrator().install(publish, options);
  }

  async cancelInstallHermes(): Promise<{ ok: boolean; message: string }> {
    return this.maintenanceOrchestrator().cancelInstall();
  }

  async repairDependency(id: SetupDependencyRepairId): Promise<SetupDependencyRepairResult> {
    return this.maintenanceOrchestrator().repairDependency(id);
  }

  private async checkHermes(): Promise<SetupCheck> {
    const health = await this.hermes.healthCheck();
    if (!health.available) {
      if (/No module named ['"]?yaml|ModuleNotFoundError.*yaml|PyYAML/i.test(health.message)) {
        return {
          id: "hermes",
          label: "Hermes",
          status: "missing",
          message: `Hermes 未完全就绪：${health.message}`,
          description: "Hermes CLI 已存在，但当前 Python 环境缺少 PyYAML，导致读取 config.yaml 时崩溃。",
          recommendedAction: "点击修复 Hermes 依赖，按当前锁文件同步受管环境。",
          fixAction: "install_hermes_dependency",
          autoFixId: "hermes_pyyaml",
          canAutoFix: true,
          blocking: true,
        };
      }
      if (/No module named ['"]?dotenv|ModuleNotFoundError.*dotenv|python-dotenv/i.test(health.message)) {
        return {
          id: "hermes",
          label: "Hermes",
          status: "missing",
          message: `Hermes 未完全就绪：${health.message}`,
          description: "Hermes CLI 已存在，但当前 Python 环境缺少 python-dotenv，导致读取 .env 时崩溃。",
          recommendedAction: "点击修复 Hermes 依赖，按当前锁文件同步受管环境。",
          fixAction: "install_hermes_dependency",
          autoFixId: "hermes_python_dotenv",
          canAutoFix: true,
          blocking: true,
        };
      }
      return {
        id: "hermes",
        label: "Hermes",
        status: "missing",
        message: `Hermes 未完全就绪：${health.message}`,
        description: "核心 Agent 未就绪时，桌面端可以打开配置页，但无法可靠执行真实任务。",
        recommendedAction: "优先点击自动安装 Hermes；如果已经手动安装，请在常规设置里指定 Hermes 根目录。",
        fixAction: "install_hermes",
        blocking: true,
      };
    }

    return {
      id: "hermes",
      label: "Hermes",
      status: "ok",
      message: `${health.message}`,
      blocking: false,
    };
  }

  private async checkModelConfig(config: RuntimeConfig): Promise<SetupCheck> {
    const profile = config.modelProfiles.find((item) => item.id === config.defaultModelProfileId) ?? config.modelProfiles[0];
    if (!profile) {
      return {
        id: "model",
        label: "模型配置",
        status: "missing",
        message: "尚未配置默认模型。",
        fixAction: "configure_model",
        blocking: true,
      };
    }
    if (profile.provider === "local" && profile.model === "mock-model") {
      return {
        id: "model-placeholder",
        label: "模型配置",
        status: "missing",
        message: "当前默认模型仍是示例占位配置 mock-model，请在设置中改成真实可用模型。保存为默认前必须先通过连接测试。",
        fixAction: "configure_model",
        blocking: true,
      };
    }
    if (profile.provider === "custom") {
      try {
        normalizeOpenAiCompatibleBaseUrl(profile.baseUrl);
      } catch {
        return {
          id: "model",
          label: "模型配置",
          status: "missing",
          message: "本地/自定义模型缺少有效 Base URL，请填写例如 http://127.0.0.1:1234/v1。",
          fixAction: "configure_model",
          blocking: true,
        };
      }
    }
    if (requiresStoredSecret(profile) && (!profile.secretRef || !(await this.secretVault.hasSecret(profile.secretRef)))) {
      return {
        id: "model-secret",
        label: "模型密钥",
        status: "missing",
        message: `${missingSecretMessage(profile)} 请在模型配置向导里重新输入 API Key 并点击「保存密钥」，然后再测试连接。`,
        fixAction: "configure_model",
        blocking: true,
      };
    }
    return {
      id: "model",
      label: "模型配置",
      status: "ok",
      message: `默认模型：${profile.provider}/${profile.model}`,
      blocking: false,
    };
  }

  private async checkWritable(id: string, label: string, targetPath: string): Promise<SetupCheck> {
    try {
      await fs.mkdir(targetPath, { recursive: true });
      const probe = path.join(targetPath, `.zhenghebao-write-test-${Date.now()}`);
      await fs.writeFile(probe, "ok", "utf8");
      await fs.unlink(probe);
      return { id, label, status: "ok", message: `目录可写。`, blocking: false };
    } catch (error) {
      return {
        id,
        label,
        status: "failed",
        message: `目录不可写，请检查权限或更换安装位置。`,
        fixAction: "open_settings",
        blocking: true,
      };
    }
  }


  private async checkCommand(
    id: string,
    args: string[],
    checkId: string,
    label: string,
    options: {
      statusOnFailure?: SetupCheck["status"];
      description?: string;
      recommendedAction?: string;
      fixAction?: SetupCheck["fixAction"];
      autoFixId?: SetupDependencyRepairId;
      blocking?: boolean;
    } = {},
  ): Promise<SetupCheck> {
    const result = await runCommand(id, args, { cwd: process.cwd(), timeoutMs: 8000 });
    const ok = result.exitCode === 0;
    return {
      id: checkId,
      label,
      status: ok ? "ok" : options.statusOnFailure ?? "warning",
      message:
        ok
          ? (result.stdout || result.stderr).trim() || `${label} 可用。`
          : `${label} 检测失败：${result.stderr || result.stdout}。建议先修复该基础环境后再运行 Hermes 任务。`,
      description: options.description,
      recommendedAction: ok ? undefined : options.recommendedAction,
      fixAction: ok ? undefined : options.fixAction,
      canAutoFix: ok ? undefined : Boolean(options.autoFixId),
      autoFixId: ok ? undefined : options.autoFixId,
      blocking: options.blocking ?? false,
    };
  }

  private async checkEnabledConnectorDependencies(config: RuntimeConfig, probe?: RuntimeProbeResult): Promise<SetupCheck[]> {
    if (config.extensionSettings?.connectorsEnabled !== true) return [];
    const raw = await fs.readFile(path.join(this.appPaths.baseDir(), "connectors-config.json"), "utf8").catch(() => undefined);
    if (!raw) return [];
    let stored: { platforms?: Record<string, { enabled?: boolean; instances?: Record<string, { enabled?: boolean }> }> };
    try { stored = JSON.parse(raw) as typeof stored; } catch {
      return [{ id: "connectors-config", label: "连接器配置", status: "warning", message: "连接器配置无法解析，请检查连接器设置。", blocking: false }];
    }
    const specs: Array<[string, string, string, string, SetupDependencyRepairId]> = [
      ["weixin", "微信", "aiohttp", "aiohttp", "weixin_aiohttp"],
      ["feishu", "飞书", "lark_oapi", "lark-oapi", "feishu_lark_oapi"],
      ["telegram", "Telegram", "telegram", "python-telegram-bot", "telegram_bot"],
      ["discord", "Discord", "discord", "discord.py", "discord_py"],
      ["slack", "Slack", "slack_bolt", "slack-bolt", "slack_bolt"],
    ];
    const checks: SetupCheck[] = [];
    for (const [platform, label, module, pkg, repair] of specs) {
      const settings = stored.platforms?.[platform];
      if (!settings || settings.enabled === false) continue;
      if (settings.instances && !Object.values(settings.instances).some((instance) => instance.enabled !== false)) continue;
      checks.push(await this.checkHermesPythonPackageWithRuntime(probe, `connector-${platform}`, `${label} 连接依赖`, module, pkg, {
        autoFixId: repair, fixAction: "install_hermes_dependency", blocking: false,
        recommendedAction: "点击修复连接器依赖，按当前 Hermes 锁文件同步受管环境。",
      }));
    }
    return checks;
  }

  private async checkHermesPythonPackageWithRuntime(
    _probe: RuntimeProbeResult | undefined,
    id: string, label: string, moduleName: string, packageName: string,
    options: Partial<Pick<SetupCheck, "description" | "recommendedAction" | "fixAction" | "autoFixId" | "blocking">> = {},
  ): Promise<SetupCheck> {
    const rootPath = await this.configStore.getEnginePath("hermes").catch(() => undefined);
    const environment = rootPath ? await resolveManagedHermesEnvironment(rootPath) : undefined;
    const result = environment ? await runCommand(environment.pythonPath, ["-c", `import ${moduleName}; print("${packageName} ok")`], {
      cwd: environment.rootPath, timeoutMs: 15_000,
      env: managedHermesEnvironmentEnv(environment, { NO_COLOR: "1" }),
      commandId: `setup.package.${id}.venv`,
    }) : undefined;
    const ok = result?.exitCode === 0;
    return {
      id, label, status: ok ? "ok" : options.blocking === true ? "missing" : "warning",
      message: ok ? `${label} 可用。` : `${label} 不可用：${environment ? result?.stderr || result?.stdout || "导入失败" : "Hermes 受管环境缺失"}`,
      description: options.description ?? "使用实际 Hermes 运行环境检测依赖。",
      recommendedAction: ok ? undefined : "点击修复 Hermes 依赖，按官方锁文件同步受管环境。",
      fixAction: ok ? undefined : options.fixAction,
      canAutoFix: ok ? undefined : true, autoFixId: ok ? undefined : options.autoFixId,
      blocking: options.blocking ?? false,
    };
  }

  async checkHermesAgentCompatibility(report?: HermesCompatibilityReport): Promise<SetupCheck> {
    const compatibility = report ?? await (this.hermesCompatibilityService
      ?? new HermesCompatibilityService(this.configStore, () => resolveActiveHermesHome(this.appPaths.hermesDir()))).inspect();
    const ready = compatibility.installed && compatibility.forgeTaskReady;
    return {
      id: "hermes-agent-compat", label: "Hermes Agent 兼容性",
      status: ready ? "ok" : "missing",
      message: ready ? `Hermes ${compatibility.version ?? ""} 满足任务运行接口要求。` : compatibility.blockingIssues[0] ?? "Hermes 尚未就绪。",
      description: "核验官方 Agent、流式回调、审批和会话接口。",
      recommendedAction: ready ? undefined : "点击更新或修复 Hermes，完成后重新检测。",
      fixAction: ready ? undefined : "update_hermes", blocking: !ready,
    };
  }
}
