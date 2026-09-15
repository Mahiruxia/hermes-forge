import fs from "node:fs/promises";
import type { RuntimeConfigStore } from "../main/runtime-config";
import { isAtLeastVersion, parseHermesVersion } from "../install/hermes-version";
import { MINIMUM_HERMES_VERSION } from "../install/hermes-version-constants";
import { runCommand } from "../process/command-runner";
import type { HermesCompatibilityReport } from "../shared/types";
import { managedHermesEnvironmentEnv, resolveManagedHermesEnvironment, type ManagedHermesEnvironment } from "../runtime/managed-hermes-environment";

import { HERMES_FORGE_CONTRACT_PROBE } from "../runtime/hermes-contract";

export class HermesCompatibilityService {
  constructor(
    private readonly configStore: RuntimeConfigStore,
    private readonly hermesHomeProvider?: () => Promise<string> | string,
  ) {}

  async inspect(): Promise<HermesCompatibilityReport> {
    const rootPath = await this.configStore.getEnginePath("hermes").catch(() => undefined);
    if (!rootPath) return this.empty("Hermes 安装路径未配置。");
    const environment = await resolveManagedHermesEnvironment(rootPath);
    if (!environment) return this.empty("未找到 Hermes 受管虚拟环境，请安装或修复 Hermes。", rootPath);
    if (!await fs.stat(environment.cliPath).then((stat) => stat.isFile()).catch(() => false)) {
      return this.empty("Hermes 虚拟环境缺少 CLI，请修复依赖。", rootPath, environment.cliPath);
    }
    const env = await this.environment(environment);
    const versionResult = await runCommand(environment.cliPath, ["--version"], { cwd: rootPath, env, timeoutMs: 20_000 });
    const version = parseHermesVersion([versionResult.stdout, versionResult.stderr].join("\n"));
    if (versionResult.exitCode !== 0 || !version) return this.empty("Hermes CLI 版本检查失败。", rootPath, environment.cliPath);
    const blockingIssues: string[] = [];
    if (!isAtLeastVersion(version, MINIMUM_HERMES_VERSION)) blockingIssues.push(`需要 Hermes ${MINIMUM_HERMES_VERSION}+，请更新当前 ${version} 版本。`);
    const probe = await runCommand(environment.pythonPath, ["-c", HERMES_FORGE_CONTRACT_PROBE], { cwd: rootPath, env, timeoutMs: 60_000, commandId: "hermes.compat.forge-contract" });
    let ready = false;
    try {
      const parsed = JSON.parse(probe.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}") as { compatible?: boolean; missing?: string[]; error?: string };
      ready = probe.exitCode === 0 && parsed.compatible === true;
      if (!ready) blockingIssues.push(parsed.error ?? (parsed.missing?.length ? `Hermes 缺少必要接口：${parsed.missing.join(", ")}` : "Hermes 任务接口检查失败。"));
    } catch {
      blockingIssues.push("Hermes 任务接口检查未返回有效结果。");
    }
    return {
      installed: true, version, cliPath: environment.cliPath, rootPath, launchMode: "venv-exe", venvStatus: "present",
      forgeTaskReady: ready && blockingIssues.length === 0,
      enhancedCapabilities: {
        supported: false, cliVersion: version, supportsLaunchMetadataArg: false, supportsLaunchMetadataEnv: false,
        supportsResume: ready, missing: [], message: "使用官方 Hermes Agent 接口；Forge 元数据由客户端管理。",
      },
      doctorStatus: { status: "not_run", message: "doctor 由一键诊断执行。" },
      blockingIssues, warnings: [],
    };
  }

  async runDoctor(autoFix = false): Promise<{ status: "pass" | "warning" | "fail"; command: string; exitCode: number | null; output: string; message: string }> {
    const rootPath = await this.configStore.getEnginePath("hermes");
    const environment = await resolveManagedHermesEnvironment(rootPath);
    if (!environment) return { status: "fail", command: "", exitCode: null, output: "", message: "Hermes 受管虚拟环境缺失，请先修复安装。" };
    const args = autoFix ? ["doctor", "--fix"] : ["doctor"];
    const result = await runCommand(environment.cliPath, args, { cwd: rootPath, timeoutMs: 60_000, env: await this.environment(environment) });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const count = Number(/Found\s+(\d+)\s+issue/i.exec(output)?.[1] ?? 0);
    const status = result.exitCode !== 0 ? "fail" : count > 0 ? "warning" : "pass";
    return { status, command: `${environment.cliPath} ${args.join(" ")}`, exitCode: result.exitCode, output,
      message: status === "pass" ? "Hermes doctor 通过。" : status === "warning" ? "Hermes doctor 有待处理建议。" : "Hermes doctor 执行失败。" };
  }

  private async environment(environment: ManagedHermesEnvironment) {
    const hermesHome = await this.hermesHomeProvider?.();
    return managedHermesEnvironmentEnv(environment, { NO_COLOR: "1", FORCE_COLOR: "0", ...(hermesHome ? { HERMES_HOME: hermesHome } : {}) });
  }

  private empty(message: string, rootPath?: string, cliPath?: string): HermesCompatibilityReport {
    return {
      installed: false, rootPath, cliPath, launchMode: "unknown", venvStatus: "missing", forgeTaskReady: false,
      enhancedCapabilities: { supported: false, supportsLaunchMetadataArg: false, supportsLaunchMetadataEnv: false, supportsResume: false, missing: ["installed"], message },
      doctorStatus: { status: "not_run", message: "Hermes 未就绪，跳过 doctor。" }, blockingIssues: [message], warnings: [],
    };
  }
}
