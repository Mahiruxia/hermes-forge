import fs from "node:fs/promises";
import path from "node:path";
import type { AppPaths } from "../main/app-paths";
import { resolveActiveHermesHome } from "../main/hermes-home";
import type { RuntimeConfigStore } from "../main/runtime-config";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { HermesProbe, HermesProbeSummary, MemoryStatus } from "../shared/types";
import type { RuntimeProbeService } from "../runtime/runtime-probe-service";
import type { RuntimeProbeResult } from "../runtime/runtime-types";
import { resolveWindowsHermesCliPath } from "../runtime/hermes-cli-paths";

const now = () => new Date().toISOString();

export class EngineProbeService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly hermes: EngineAdapter,
    private readonly configStore: RuntimeConfigStore,
    private readonly runtimeProbeService?: RuntimeProbeService,
  ) {}

  async probeHermes(workspacePath?: string): Promise<HermesProbeSummary> {
    const workspaceId = workspacePath
      ? await this.appPaths.ensureWorkspaceLayout(workspacePath)
      : this.appPaths.workspaceId(process.cwd());
    return {
      checkedAt: now(),
      probe: await this.probe(workspaceId, workspacePath),
    };
  }

  private async probe(workspaceId: string, workspacePath?: string): Promise<HermesProbe> {
    const rootPath = await this.configStore.getEnginePath("hermes");
    const runtimeProbe = await this.runtimeProbeService?.probe({ workspacePath }).catch(() => undefined);
    const cliExists = runtimeProbe?.hermesCliExists ?? await this.legacyCliExists(rootPath);
    const runtimeStatus = this.runtimeStatus(runtimeProbe, cliExists);
    const hermesHome = await resolveActiveHermesHome(this.appPaths.hermesDir());
    const memoryDir = path.join(hermesHome, "memories");
    const userPath = path.join(memoryDir, "USER.md");
    const memoryPath = path.join(memoryDir, "MEMORY.md");
    const skillCount = await this.countEntries(path.join(hermesHome, "skills"));
    const optionalSkillCount = await this.countEntries(path.join(hermesHome, "optional-skills"));
    const toolCount = await this.countEntries(path.join(rootPath, "tools"));
    const acpAdapter = await this.exists(path.join(rootPath, "acp_adapter"));
    const acpRegistry = await this.exists(path.join(rootPath, "acp_registry"));
    const logsCount = await this.countEntries(path.join(rootPath, "logs"));
    const [userText, memoryText, memoryStatus] = await Promise.all([
      fs.readFile(userPath, "utf8").catch(() => ""),
      fs.readFile(memoryPath, "utf8").catch(() => ""),
      this.hermes.getMemoryStatus(workspaceId).catch(() => undefined as MemoryStatus | undefined),
    ]);

    return {
      engineId: "hermes",
      checkedAt: now(),
      status: runtimeStatus,
      primaryMetric: runtimeProbe ? this.primaryMetric(runtimeProbe) : cliExists ? "Legacy CLI" : "未连接",
      secondaryMetric: runtimeProbe?.paths.profileHermesPath.path ?? rootPath,
      metrics: [
        { label: "CLI 文件", value: cliExists ? "存在" : "缺失", tone: cliExists ? "green" : "red" },
        this.runtimePythonMetric(runtimeProbe),
        ...(runtimeProbe?.runtimeMode === "wsl" ? [this.wslMetric(runtimeProbe)] : []),
        ...(runtimeProbe ? [{ label: "Runtime", value: runtimeProbe.overallStatus, tone: runtimeProbe.overallStatus === "ready" ? "green" as const : runtimeProbe.overallStatus === "degraded" ? "amber" as const : "red" as const }] : []),
        { label: "USER.md", value: `${userText.length} 字符`, tone: userText ? "blue" : "slate" },
        { label: "MEMORY.md", value: `${memoryText.length} 字符`, tone: this.memoryTone(memoryText.length, memoryStatus?.maxCharacters) },
        { label: "记忆目录", value: memoryDir, tone: memoryStatus ? "green" : "amber" },
        { label: "Skills", value: skillCount === undefined ? "未找到" : `${skillCount}`, tone: skillCount ? "blue" : "slate" },
        { label: "Optional Skills", value: optionalSkillCount === undefined ? "未找到" : `${optionalSkillCount}`, tone: optionalSkillCount ? "blue" : "slate" },
        { label: "Tools", value: toolCount === undefined ? "未找到" : `${toolCount}`, tone: toolCount ? "blue" : "slate" },
        { label: "ACP Adapter", value: acpAdapter ? "存在" : "缺失", tone: acpAdapter ? "green" : "amber" },
        { label: "ACP Registry", value: acpRegistry ? "存在" : "缺失", tone: acpRegistry ? "green" : "amber" },
        { label: "运行日志", value: logsCount === undefined ? "未找到" : `${logsCount}`, tone: logsCount ? "blue" : "slate" },
      ],
      message: runtimeProbe
        ? runtimeProbe.issues[0]?.summary ?? `Runtime ${runtimeProbe.runtimeMode} ${runtimeProbe.overallStatus}`
        : "Legacy probe: RuntimeProbeService 未注入，仅执行文件级 Hermes 诊断。",
    };
  }

  private runtimeStatus(runtimeProbe: RuntimeProbeResult | undefined, cliExists: boolean): HermesProbe["status"] {
    if (!runtimeProbe) return cliExists ? "warning" : "offline";
    if (runtimeProbe.overallStatus === "ready" || runtimeProbe.overallStatus === "degraded") {
      return runtimeProbe.hermesCliExists ? "healthy" : "warning";
    }
    return runtimeProbe.hermesCliExists ? "warning" : "offline";
  }

  private primaryMetric(runtimeProbe: RuntimeProbeResult) {
    if (runtimeProbe.runtimeMode === "wsl") {
      return runtimeProbe.overallStatus === "ready" ? "受控 WSL" : "WSL 未就绪";
    }
    return runtimeProbe.overallStatus === "ready" ? "Windows Native" : "Native 未就绪";
  }

  private runtimePythonMetric(runtimeProbe: RuntimeProbeResult | undefined) {
    if (!runtimeProbe) {
      return { label: "Python", value: "Legacy 未检测", tone: "amber" as const };
    }
    if (runtimeProbe.runtimeMode === "wsl") {
      return {
        label: "WSL Python",
        value: runtimeProbe.commands.wsl.pythonCommand ?? runtimeProbe.commands.wsl.message,
        tone: runtimeProbe.wslPythonAvailable ? "green" as const : "red" as const,
      };
    }
    return {
      label: "Python",
      value: runtimeProbe.commands.python.version ?? runtimeProbe.commands.python.message,
      tone: runtimeProbe.pythonAvailable ? "green" as const : "red" as const,
    };
  }

  private wslMetric(runtimeProbe: RuntimeProbeResult) {
    const ready = runtimeProbe.wslAvailable && runtimeProbe.distroExists !== false && runtimeProbe.distroReachable !== false;
    return {
      label: "WSL",
      value: runtimeProbe.distroName ?? runtimeProbe.commands.wsl.message,
      tone: ready ? "green" as const : "red" as const,
    };
  }

  private memoryTone(used: number, max?: number) {
    if (!max) return "blue";
    const ratio = used / max;
    if (ratio >= 0.95) return "red";
    if (ratio >= 0.85) return "amber";
    return "green";
  }

  private async countEntries(targetPath: string) {
    const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return undefined;
    return entries.filter((entry) => entry.isFile() || entry.isDirectory()).length;
  }

  private async legacyCliExists(rootPath: string) {
    // Legacy fallback: retained only for tests/standalone construction paths without RuntimeProbeService.
    return Boolean(await resolveWindowsHermesCliPath(rootPath));
  }

  private async exists(targetPath: string) {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
