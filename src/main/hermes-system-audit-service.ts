import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineAdapter } from "../adapters/engine-adapter";
import { normalizeModelIdForSource, normalizeSourceTypeForProfile } from "../shared/model-config";
import { redactSensitiveText } from "../shared/redaction";
import { resolveEnginePermissions, type BridgeTestStepStatus, type ContextRequest, type EngineEvent, type EngineRuntimeEnv, type EngineRunRequest, type HermesSystemAuditResult, type HermesSystemAuditStep, type HermesSystemAuditStepId, type RuntimeConfig } from "../shared/types";
import type { AppPaths } from "./app-paths";
import type { RuntimeEnvResolver } from "./runtime-env-resolver";

const AUDIT_TIMEOUT_MS = 180_000;

type AuditExecution = {
  ok: boolean;
  detail: string;
  resultText: string;
  taskRunId: string;
  sessionUpdates: Array<Extract<EngineEvent, { type: "session_update" }>>;
  stdout: string[];
  stderr: string[];
  diagnostics: string[];
  completedTools: string[];
  durationMs: number;
};

export class HermesSystemAuditService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly hermes: EngineAdapter,
    private readonly runtimeEnvResolver: RuntimeEnvResolver,
    private readonly readConfig: () => Promise<RuntimeConfig>,
  ) {}

  async test(options: { deepAudit?: boolean; releaseAudit?: boolean } = {}): Promise<HermesSystemAuditResult> {
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

      if (options.releaseAudit === true || process.env.HERMES_FORGE_RELEASE_AUDIT === "1") {
        await this.runReleaseCases(config, runtimeEnv, permissions, auditRoot, workspacePath, steps);
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

      if (!options.deepAudit) {
        steps.push(skipped("write-outside-workspace", "跨目录越权写入", "普通一键诊断默认跳过跨目录写入；开启深度审计后才会执行临时文件读写测试。"));
      } else {
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
              : failed("Hermes 未能稳定完成工作区外写入/回读。", [execution.detail, content ? `文件实际内容：${content}` : "未检测到目标文件。"].filter(Boolean).join("\n"));
          },
        }));
      }

      const largeLog = await this.createLargeLogFile(workspacePath);
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
          "成功时输出：AUDIT_BIGFILE_OK: <文件中的实际最后一行>",
          "失败时输出：AUDIT_BIGFILE_FAIL: <原因>",
        ].join("\n"),
        verify: (execution) => execution.completedTools.length > 0 && execution.detail.includes(`AUDIT_BIGFILE_OK: ${largeLog.tailLine}`)
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
            `请在宿主机执行这条命令：${process.platform === "win32" ? "cmd /c echo" : "echo"} ${commandToken}`,
            `如果成功，请输出：AUDIT_CMD_OK: ${commandToken}`,
            "如果失败，请输出：AUDIT_CMD_FAIL: <原因>",
          ].join("\n"),
          verify: (execution) => execution.completedTools.some((name) => /terminal|execute|command|shell/i.test(name)) && execution.detail.includes(`AUDIT_CMD_OK: ${commandToken}`)
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

  private async runReleaseCases(
    config: RuntimeConfig,
    defaultRuntime: EngineRuntimeEnv,
    permissions: EngineRunRequest["permissions"],
    auditRoot: string,
    workspacePath: string,
    steps: HermesSystemAuditStep[],
  ) {
    // A dedicated official SessionDB proves persistence without touching any
    // existing conversation, personal memory, or default model selection.
    const hermesHome = path.join(auditRoot, "release-hermes-home");
    await fs.mkdir(hermesHome, { recursive: true });
    const isolate = (runtime: EngineRuntimeEnv): EngineRuntimeEnv => ({
      ...runtime,
      env: { ...runtime.env, HERMES_HOME: hermesHome, HERMES_IGNORE_RULES: "1" },
    });
    const releasePermissions = permissions ? { ...permissions, memoryRead: false } : permissions;
    const runtime = isolate(defaultRuntime);
    const seedId = `release-resume-${crypto.randomUUID()}`;
    const phrase = crypto.randomBytes(18).toString("hex");
    const resumeStartedAt = Date.now();
    try {
      if (defaultRuntime.profileId !== config.defaultModelProfileId) {
        throw new Error("默认模型配置未能精确解析，不能以回退模型完成发布验收。");
      }
      const seed = await this.executePrompt(
        `这是会话恢复验收。请记住本会话的随机口令：${phrase}。不要写入文件或长期记忆，也不要调用任何工具；本轮只回复 AUDIT_SESSION_STORED。`,
        workspacePath, runtime, releasePermissions, [], [], seedId,
      );
      const seedSession = requireAuditSession(seed, defaultRuntime);
      if (seed.resultText.trim() !== "AUDIT_SESSION_STORED") {
        throw new Error("首个 Hermes 进程没有成功确认会话写入。");
      }
      // executePrompt fully drains the subprocess and awaits stop before returning.
      // Pass only the ID returned by Hermes: no history, files, or secret in prompt.
      const resumed = await this.executePrompt(
        "这是同一会话在进程重启后的检查。请仅根据本会话先前的对话，回答之前要求你记住的随机口令。不要调用工具；只输出口令本身，未知则回答 UNKNOWN。",
        workspacePath, runtime, releasePermissions, [], [], seedSession.hermesSessionId,
      );
      const resumedSession = requireAuditSession(resumed, defaultRuntime, seedSession.hermesSessionId);
      if (resumed.resultText.trim() !== phrase) {
        throw new Error("新 Hermes 进程未能从官方会话历史恢复随机口令。");
      }
      if ((resumedSession.messageCount ?? 0) <= (seedSession.messageCount ?? 0)) {
        throw new Error("官方会话消息数没有增长，无法确认本轮恢复已持久化。");
      }
      steps.push({
        id: "session-restart-resume", label: "跨进程会话恢复", status: "passed",
        message: "独立 Hermes 进程通过官方 SessionDB 恢复了新提示中未提供的随机口令。",
        durationMs: Date.now() - resumeStartedAt,
        detail: JSON.stringify({ model: defaultRuntime.model, profileId: defaultRuntime.profileId, hermesSessionId: resumedSession.hermesSessionId, taskRunIds: [seed.taskRunId, resumed.taskRunId], messageCounts: [seedSession.messageCount, resumedSession.messageCount] }),
      });
    } catch (error) {
      steps.push({
        id: "session-restart-resume", label: "跨进程会话恢复", status: "failed",
        message: auditError(error, runtime), durationMs: Date.now() - resumeStartedAt,
      });
    }

    const switchStartedAt = Date.now();
    let alternateRuntime: EngineRuntimeEnv | undefined;
    try {
      const alternate = chooseAlternateProfile(config, defaultRuntime);
      if (!alternate) throw new Error("需要另一个已配置且模型不同的 profile 才能完成真实模型切换验收。");
      alternateRuntime = await this.runtimeEnvResolver.resolve(alternate.id);
      if (alternateRuntime.profileId !== alternate.id || sameAuditModel(defaultRuntime, alternateRuntime)) {
        throw new Error("备选模型解析发生回退，无法证明模型已切换。");
      }
      const marker = `AUDIT_MODEL_SWITCH_${crypto.randomBytes(10).toString("hex")}`;
      const switched = await this.executePrompt(
        `这是模型切换验收。不要调用工具，不要解释，只输出：${marker}`,
        workspacePath, isolate(alternateRuntime), releasePermissions, [], [], `release-model-${crypto.randomUUID()}`,
      );
      const session = requireAuditSession(switched, alternateRuntime);
      if (switched.resultText.trim() !== marker) throw new Error("切换后的模型未返回本轮验收标记。");
      steps.push({
        id: "model-profile-switch", label: "真实模型切换", status: "passed",
        message: "另一已配置模型在独立 Hermes 进程中完成请求，官方会话回报的模型与选定配置一致。",
        durationMs: Date.now() - switchStartedAt,
        detail: JSON.stringify({ from: { profileId: defaultRuntime.profileId, model: defaultRuntime.model }, to: { profileId: alternateRuntime.profileId, model: session.model }, taskRunId: switched.taskRunId, hermesSessionId: session.hermesSessionId, messageCount: session.messageCount }),
      });
    } catch (error) {
      steps.push({
        id: "model-profile-switch", label: "真实模型切换", status: "failed",
        message: auditError(error, alternateRuntime), durationMs: Date.now() - switchStartedAt,
      });
    }
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
      if (!execution.ok) throw new Error(execution.detail || "Hermes 未成功完成本次审计请求。");
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
    hermesSessionId?: string,
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
      conversationId: hermesSessionId ?? `system-audit-${crypto.randomUUID()}`,
      workspaceId,
      workspacePath,
      userInput: prompt,
      taskType: "custom",
      selectedFiles,
      attachments,
      memoryPolicy: "isolated",
      runtimeEnv,
      modelProfileId: runtimeEnv?.profileId,
      contextBundle,
      permissions,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
    const startedAt = Date.now();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const diagnostics: string[] = [];
    const completedTools: string[] = [];
    const sessionUpdates: AuditExecution["sessionUpdates"] = [];
    let resultTitle = "";
    let resultDetail = "";
    let ok = false;
    let failedResult = false;

    try {
      for await (const event of this.hermes.run(request, controller.signal)) {
        if (event.type === "stdout") stdout.push(event.line);
        if (event.type === "stderr") stderr.push(event.line);
        if (event.type === "diagnostic") diagnostics.push(`${event.category}: ${event.message}`);
        if (event.type === "tool_result" && event.success !== false && event.status !== "failed") completedTools.push(event.toolName);
        if (event.type === "session_update") sessionUpdates.push(event);
        if (event.type === "result") {
          resultTitle = event.title;
          resultDetail = event.detail;
          failedResult ||= !event.success || event.outcome === "failed" || event.outcome === "cancelled";
          ok = event.success && !failedResult;
        }
      }
    } catch (error) {
      throw new Error(auditError(error, runtimeEnv));
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
      ok: ok && !controller.signal.aborted,
      detail: redactAuditText(detail, runtimeEnv),
      resultText: resultDetail,
      taskRunId: request.sessionId,
      sessionUpdates,
      stdout,
      stderr,
      diagnostics,
      completedTools,
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

function normalizedAuditModel(runtime: Pick<EngineRuntimeEnv, "model" | "sourceType" | "baseUrl">) {
  return normalizeModelIdForSource(normalizeSourceTypeForProfile(runtime), runtime.model).toLowerCase();
}

function sameAuditModel(left: EngineRuntimeEnv, right: Pick<EngineRuntimeEnv, "model" | "sourceType" | "baseUrl">) {
  return normalizedAuditModel(left) === normalizedAuditModel(right);
}

function chooseAlternateProfile(config: RuntimeConfig, runtime: EngineRuntimeEnv) {
  // Model profiles are the enabled configurations; there is no per-profile
  // enable flag. Prefer the other configured Kimi/MiMo family when available.
  const candidates = config.modelProfiles.filter((profile) => profile.id !== runtime.profileId && profile.provider !== "local" && profile.model.trim() && !sameAuditModel(runtime, profile));
  const defaultIsKimi = /kimi|k2p[56]/i.test(`${runtime.sourceType ?? ""} ${runtime.model}`);
  const preferred = defaultIsKimi ? /mimo/i : /kimi|k2p[56]/i;
  return candidates.find((profile) => preferred.test(`${profile.sourceType ?? ""} ${profile.model}`)) ?? candidates[0];
}

function requireAuditSession(execution: AuditExecution, runtime: EngineRuntimeEnv, expectedSessionId?: string) {
  if (!execution.ok) throw new Error(execution.detail || "Hermes 未成功完成发布验收请求。");
  const session = execution.sessionUpdates.at(-1);
  if (!session?.hermesSessionId || !session.model || !session.messageCount || session.messageCount < 1) {
    throw new Error("Hermes 未返回完整的官方 session_update，不能确认会话和模型。");
  }
  if (normalizedAuditModel({ ...runtime, model: session.model }) !== normalizedAuditModel(runtime)) {
    throw new Error(`Hermes 官方会话模型与选择不一致：预期 ${runtime.model}，实际 ${session.model}。`);
  }
  if (expectedSessionId && session.hermesSessionId !== expectedSessionId) {
    throw new Error("恢复进程没有返回原官方会话 ID。");
  }
  if (execution.completedTools.length) throw new Error("发布会话验收意外调用了工具，无法排除文件或记忆旁路。");
  return session;
}

function redactAuditText(value: string, runtime?: EngineRuntimeEnv) {
  let result = value;
  for (const [name, secret] of Object.entries(runtime?.env ?? {})) {
    if (/key|token|secret|password|credential|authorization/i.test(name) && secret.length >= 4) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return redactSensitiveText(result);
}

function auditError(error: unknown, runtime?: EngineRuntimeEnv) {
  return redactAuditText(error instanceof Error ? error.message : "发布验收失败。", runtime);
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
