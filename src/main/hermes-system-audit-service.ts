import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineAdapter } from "../adapters/engine-adapter";
import { resolveEnginePermissions, type BridgeTestStepStatus, type ContextRequest, type EngineRunRequest, type HermesSystemAuditResult, type HermesSystemAuditStep, type HermesSystemAuditStepId, type RuntimeConfig } from "../shared/types";
import type { AppPaths } from "./app-paths";
import type { RuntimeEnvResolver } from "./runtime-env-resolver";

const AUDIT_TIMEOUT_MS = 180_000;

type AuditExecution = {
  ok: boolean;
  detail: string;
  stdout: string[];
  stderr: string[];
  diagnostics: string[];
  durationMs: number;
};

export class HermesSystemAuditService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly hermes: EngineAdapter,
    private readonly runtimeEnvResolver: RuntimeEnvResolver,
    private readonly readConfig: () => Promise<RuntimeConfig>,
  ) {}

  async test(): Promise<HermesSystemAuditResult> {
    const auditRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-forge-system-audit-"));
    const workspacePath = path.join(auditRoot, "workspace-root");
    const steps: HermesSystemAuditStep[] = [];

    try {
      await fs.mkdir(workspacePath, { recursive: true });
      const config = await this.readConfig();
      const runtimeEnv = await this.runtimeEnvResolver.resolve(config.defaultModelProfileId);
      const permissions = resolveEnginePermissions(config, "hermes");

      const modelPreflight = await this.runCase({
        id: "preflight",
        label: "模型连通预检",
        workspacePath,
        runtimeEnv,
        permissions,
        prompt: [
          "你正在执行 Hermes Forge 系统能力审计。",
          "不要解释过程，不要输出 Markdown，只输出：AUDIT_MODEL_OK",
        ].join("\n"),
        verify: (execution) => execution.detail.includes("AUDIT_MODEL_OK")
          ? passed("Hermes 模型链路可用。", execution.detail)
          : failed("Hermes 模型链路不可用，已跳过后续系统能力审计。", execution.detail || "未收到模型预检标记。"),
      });
      steps.push(modelPreflight);
      if (modelPreflight.status === "failed") {
        return auditResult(workspacePath, steps);
      }

      const nastyFile = await this.createNastyPathFile(auditRoot);
      steps.push(await this.runCase({
        id: "read-nasty-path",
        label: "极限路径读取",
        artifactPath: nastyFile.path,
        workspacePath,
        runtimeEnv,
        permissions,
        attachments: [fileAttachment(nastyFile.path, "file")],
        prompt: [
          "你正在执行 Hermes Forge 系统能力审计。",
          "不要解释过程，不要输出 Markdown，只输出一行结果。",
          "这个文件已经作为本轮附件内容由宿主应用读取并提供给你。",
          "请从附件内容中找出以 TARGET_LINE= 开头的整行。",
          "如果成功，请使用格式：AUDIT_PATH_OK: <整行内容>",
          "如果失败，请输出：AUDIT_PATH_FAIL: <原因>",
        ].join("\n"),
        verify: (execution) => execution.detail.includes(`AUDIT_PATH_OK: ${nastyFile.expectedLine}`)
          ? passed(`Hermes 成功读取了极端路径文件。`, execution.detail)
          : failed("Hermes 未能返回极端路径文件中的目标行。", execution.detail),
      }));

      const outsideTarget = path.join(os.homedir(), "Desktop", `Hermes Forge Audit ${Date.now()} ${crypto.randomUUID().slice(0, 6)}.txt`);
      const outsideContent = `HERMES_FORGE_AUDIT_WRITE_${crypto.randomUUID()}`;
      steps.push(await this.runCase({
        id: "write-outside-workspace",
        label: "跨目录越权写入",
        artifactPath: outsideTarget,
        workspacePath,
        runtimeEnv,
        permissions,
        prompt: [
          "你正在执行 Hermes Forge 系统能力审计。",
          "不要解释过程，不要输出 Markdown，只输出一行结果。",
          `请在当前工作区之外创建这个文件："${outsideTarget}"。`,
          `写入内容必须精确等于：${outsideContent}`,
          `写完后重新读取该文件，并输出：AUDIT_WRITE_OK: ${outsideContent}`,
          "如果失败，请输出：AUDIT_WRITE_FAIL: <原因>",
        ].join("\n"),
        verify: async (execution) => {
          const content = await fs.readFile(outsideTarget, "utf8").catch(() => "");
          return content.trim() === outsideContent && execution.detail.includes(`AUDIT_WRITE_OK: ${outsideContent}`)
            ? passed("Hermes 成功在工作区外创建并回读文件。", execution.detail)
            : failed("Hermes 未能稳定完成工作区外写入/回读。", [execution.detail, content ? `文件实际内容：${content}` : "未检测到目标文件。"] .filter(Boolean).join("\n"));
        },
      }));

      const largeLog = await this.createLargeLogFile(auditRoot);
      steps.push(await this.runCase({
        id: "read-large-file",
        label: "大文件流式解析",
        artifactPath: largeLog.path,
        workspacePath,
        runtimeEnv,
        permissions,
        prompt: [
          "你正在执行 Hermes Forge 系统能力审计。",
          "不要解释过程，不要输出 Markdown，只输出一行结果。",
          `请读取这个大日志文件："${largeLog.path}"。`,
          "不要总结全文，只返回最后一行。",
          `成功时输出：AUDIT_BIGFILE_OK: ${largeLog.tailLine}`,
          "失败时输出：AUDIT_BIGFILE_FAIL: <原因>",
        ].join("\n"),
        verify: (execution) => execution.detail.includes(`AUDIT_BIGFILE_OK: ${largeLog.tailLine}`)
          ? passed(`Hermes 成功处理了约 ${Math.round(largeLog.size / 1024 / 1024)}MB 的日志文件。`, execution.detail)
          : failed("Hermes 未能稳定返回大文件尾部标记。", execution.detail),
      }));

      if (!permissions.commandRun) {
        steps.push(skipped("host-command", "原生命令执行", "当前 commandRun=false，按配置跳过命令执行审计。"));
      } else {
        const commandToken = `HERMES_AUDIT_CMD_${crypto.randomUUID().slice(0, 8)}`;
        steps.push(await this.runCase({
          id: "host-command",
          label: "原生命令执行",
          workspacePath,
          runtimeEnv,
          permissions,
          prompt: [
            "你正在执行 Hermes Forge 系统能力审计。",
            "不要解释过程，不要输出 Markdown，只输出一行结果。",
            `请在宿主机执行这条命令：cmd /c echo ${commandToken}`,
            `如果成功，请输出：AUDIT_CMD_OK: ${commandToken}`,
            "如果失败，请输出：AUDIT_CMD_FAIL: <原因>",
          ].join("\n"),
          verify: (execution) => execution.detail.includes(`AUDIT_CMD_OK: ${commandToken}`)
            ? passed("Hermes 成功执行了宿主机原生命令。", execution.detail)
            : failed("Hermes 未能返回预期的宿主机命令输出。", execution.detail),
        }));
      }
    } catch (error) {
      steps.push({
        id: "preflight",
        label: "审计预检",
        status: "failed",
        message: error instanceof Error ? error.message : "系统审计预检失败。",
      });
    } finally {
      await fs.rm(auditRoot, { recursive: true, force: true }).catch(() => undefined);
      for (const step of steps) {
        if (step.id === "write-outside-workspace" && step.artifactPath) {
          await fs.rm(step.artifactPath, { force: true }).catch(() => undefined);
        }
      }
    }

    return auditResult(workspacePath, steps);
  }

  private async runCase(input: {
    id: HermesSystemAuditStepId;
    label: string;
    prompt: string;
    workspacePath: string;
    runtimeEnv: EngineRunRequest["runtimeEnv"];
    permissions: EngineRunRequest["permissions"];
    artifactPath?: string;
    selectedFiles?: string[];
    attachments?: EngineRunRequest["attachments"];
    verify(execution: AuditExecution): Promise<{ status: BridgeTestStepStatus; message: string; detail?: string }> | { status: BridgeTestStepStatus; message: string; detail?: string };
  }): Promise<HermesSystemAuditStep> {
    const startedAt = Date.now();
    try {
      const execution = await this.executePrompt(input.prompt, input.workspacePath, input.runtimeEnv, input.permissions, input.selectedFiles, input.attachments);
      const verdict = await input.verify(execution);
      return {
        id: input.id,
        label: input.label,
        status: verdict.status,
        message: verdict.message,
        detail: verdict.detail,
        durationMs: Date.now() - startedAt,
        artifactPath: input.artifactPath,
      };
    } catch (error) {
      return {
        id: input.id,
        label: input.label,
        status: "failed",
        message: error instanceof Error ? error.message : "未知错误",
        durationMs: Date.now() - startedAt,
        artifactPath: input.artifactPath,
      };
    }
  }

  private async executePrompt(
    prompt: string,
    workspacePath: string,
    runtimeEnv: EngineRunRequest["runtimeEnv"],
    permissions: EngineRunRequest["permissions"],
    selectedFiles: string[] = [],
    attachments: EngineRunRequest["attachments"] = [],
  ): Promise<AuditExecution> {
    const workspaceId = await this.appPaths.ensureWorkspaceLayout(workspacePath);
    const contextRequest: ContextRequest = {
      workspaceId,
      workspacePath,
      userInput: prompt,
      taskType: "custom",
      memoryPolicy: "isolated",
    };
    const contextBundle = await this.hermes.prepareContextBundle(contextRequest);
    const request: EngineRunRequest = {
      sessionId: `system-audit-${crypto.randomUUID()}`,
      conversationId: `system-audit-${Date.now()}`,
      workspaceId,
      workspacePath,
      userInput: prompt,
      taskType: "custom",
      selectedFiles,
      attachments,
      memoryPolicy: "isolated",
      runtimeEnv,
      contextBundle,
      permissions,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
    const startedAt = Date.now();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const diagnostics: string[] = [];
    let resultTitle = "";
    let resultDetail = "";
    let ok = false;

    try {
      for await (const event of this.hermes.run(request, controller.signal)) {
        if (event.type === "stdout") stdout.push(event.line);
        if (event.type === "stderr") stderr.push(event.line);
        if (event.type === "diagnostic") diagnostics.push(`${event.category}: ${event.message}`);
        if (event.type === "result") {
          resultTitle = event.title;
          resultDetail = event.detail;
          ok = event.success;
        }
      }
    } finally {
      clearTimeout(timer);
      await this.hermes.stop(request.sessionId).catch(() => undefined);
    }

    const detail = [
      resultTitle ? `[${resultTitle}]` : "",
      resultDetail,
      diagnostics.length ? `诊断：\n${diagnostics.join("\n")}` : "",
      stderr.length ? `stderr：\n${stderr.join("\n")}` : "",
      !resultDetail && stdout.length ? `stdout：\n${stdout.join("\n")}` : "",
    ].filter(Boolean).join("\n\n").trim();

    return {
      ok,
      detail,
      stdout,
      stderr,
      diagnostics,
      durationMs: Date.now() - startedAt,
    };
  }

  private async createNastyPathFile(auditRoot: string) {
    const marker = `HERMES_AUDIT_PATH_${crypto.randomUUID().slice(0, 8)}`;
    const uglyDir = path.join(auditRoot, "恶心  路径  with   多空格", "子目录#[中 文] (test)&^");
    await fs.mkdir(uglyDir, { recursive: true });
    const filePath = path.join(uglyDir, "极限 路径 诊断 @ 文件 %20 ! 标题.md");
    const expectedLine = `TARGET_LINE=${marker}`;
    await fs.writeFile(filePath, `第一行\n${expectedLine}\n最后一行`, "utf8");
    return { path: filePath, marker, expectedLine };
  }

  private async createLargeLogFile(auditRoot: string) {
    const marker = `HERMES_AUDIT_BIGFILE_${crypto.randomUUID().slice(0, 8)}`;
    const filePath = path.join(auditRoot, "large-audit.log");
    const lines: string[] = [];
    for (let index = 0; index < 120000; index += 1) {
      lines.push(`INFO ${String(index).padStart(6, "0")} diagnostics heartbeat payload=abcdefghijklmnopqrstuvwxyz0123456789`);
    }
    const tailLine = `AUDIT_BIGFILE_TAIL=${marker}`;
    lines.push(tailLine);
    await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
    const stat = await fs.stat(filePath);
    return { path: filePath, tailLine, size: stat.size };
  }
}

function fileAttachment(filePath: string, kind: "file" | "image"): NonNullable<EngineRunRequest["attachments"]>[number] {
  return {
    id: `system-audit-file-${crypto.randomUUID()}`,
    name: path.basename(filePath),
    path: filePath,
    originalPath: filePath,
    kind,
    size: 0,
    createdAt: new Date().toISOString(),
  };
}

function passed(message: string, detail?: string) {
  return { status: "passed" as const, message, detail };
}

function failed(message: string, detail?: string) {
  return { status: "failed" as const, message, detail };
}

function skipped(id: HermesSystemAuditStepId, label: string, message: string): HermesSystemAuditStep {
  return { id, label, status: "skipped", message };
}

function auditResult(workspacePath: string, steps: HermesSystemAuditStep[]): HermesSystemAuditResult {
  const failedStep = steps.find((step) => step.status === "failed");
  return {
    ok: !failedStep,
    workspacePath,
    steps,
    message: failedStep
      ? `系统能力审计未通过：${failedStep.label}。${failedStep.message}`
      : "Hermes 系统级能力审计通过，当前 Electron 客户端具备预期的底层文件/命令能力。",
  };
}
