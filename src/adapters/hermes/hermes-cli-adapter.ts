import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AppPaths } from "../../main/app-paths";
import { readHermesJsonStream } from "./hermes-json-stream-adapter";
import { resolveActiveHermesHome } from "../../main/hermes-home";
import type { HermesModelSyncService } from "../../main/hermes-model-sync";
import { MemoryBudgeter } from "../../memory/memory-budgeter";
import {
  createHermesLaunchMetadataSidecar,
  type HermesLaunchMetadataDelivery,
  type LaunchMetadataBridge,
} from "./hermes-launch-metadata";
import { runCommand, streamCommand } from "../../process/command-runner";
import type { CommandLineEvent } from "../../process/command-runner";
import { validateWslHermesCli, type HermesCliValidationFailureKind } from "../../runtime/hermes-cli-resolver";
import type { RuntimeAdapterFactory } from "../../runtime/runtime-adapter";
import { toWslPath as runtimeToWslPath, sanitizeEnvForWsl } from "../../runtime/runtime-resolver";
import { extractHermesCliLifecycleSessionId, isHermesCliLifecycleLine } from "../../shared/hermes-cli-output";
import { mapSourceTypeToHermesProvider, resolveHermesProvider } from "../../shared/model-config";
import { createPermissionBoundaryAudit, createPermissionPolicyBlockReason, type PermissionBoundaryAudit } from "../../shared/permission-audit";
import type { EngineAdapter, HermesToolLoopMessage } from "../engine-adapter";
import type {
  ContextBundle,
  ContextRequest,
  EngineEvent,
  EngineHealth,
  EngineRunRequest,
  EngineRuntimeEnv,
  HermesCliPermissionMode,
  HermesRuntimeConfig,
  EngineUpdateStatus,
  MemoryStatus,
  PermissionOverviewBlockReason,
  RuntimeConfig,
} from "../../shared/types";

const now = () => new Date().toISOString();
const HEADLESS_RESULT_START = "__HERMES_FORGE_RESULT_START__";
const HEADLESS_RESULT_END = "__HERMES_FORGE_RESULT_END__";

type HermesInvocation = {
  args: string[];
  permissionMode?: HermesCliPermissionMode;
  sessionPlan?: HermesCliSessionPlan;
  env?: NodeJS.ProcessEnv;
  cleanup?: () => Promise<void>;
};

type HermesPromptPayload = {
  systemPrompt: string;
  userPrompt: string;
  compatibilityLayer?: boolean;
  compatibilityReason?: string;
  queryContext?: string[];
  launchMetadata?: HermesLaunchMetadataDelivery;
  launchMetadataNativeSupported?: boolean;
  launchMetadataTransport?: HermesCliMetadataTransport;
  cliCapabilities?: HermesCliCapabilityProbe;
};

type HermesCliPermissionStrategy = {
  mode: HermesCliPermissionMode;
  cliArgs: string[];
  source: "runtime-config" | "default";
  description: string;
};

type HermesCliSessionStatus = "fresh" | "resumed" | "continued" | "degraded";

type HermesCliSessionMapping = {
  version: 1;
  forgeSessionId: string;
  cliSessionId?: string;
  cliSource: string;
  cliStateDbPath: string;
  cliStateDbRuntimePath?: string;
  createdAt: string;
  updatedAt: string;
  lastTaskRunId?: string;
  lastWorkspacePath?: string;
  lastStatus: HermesCliSessionStatus;
  lastDegradationReason?: string;
};

const hermesCliSessionMappingSchema = z.object({
  version: z.literal(1),
  forgeSessionId: z.string().trim().min(1).max(120),
  cliSessionId: z.string().trim().min(1).max(240).optional(),
  cliSource: z.string().trim().min(1).max(80),
  cliStateDbPath: z.string().trim().min(1).max(1000),
  cliStateDbRuntimePath: z.string().trim().min(1).max(1000).optional(),
  createdAt: z.string().trim().min(1).max(80),
  updatedAt: z.string().trim().min(1).max(80),
  lastTaskRunId: z.string().trim().min(1).max(120).optional(),
  lastWorkspacePath: z.string().trim().min(1).max(1000).optional(),
  lastStatus: z.enum(["fresh", "resumed", "continued", "degraded"]),
  lastDegradationReason: z.string().trim().max(1000).optional(),
});

type HermesCliSessionPlan = {
  forgeSessionId?: string;
  status: HermesCliSessionStatus;
  cliSessionId?: string;
  cliSource: string;
  mappingPath?: string;
  cliStateDbPath?: string;
  cliStateDbRuntimePath?: string;
  resumeArgs: string[];
  degradationReason?: string;
};

type HermesCliMetadataTransport = "native-arg-env" | "blocked" | "none";

type HermesCliCapabilitySupport = "native" | "legacy_compatible" | "degraded" | "resume_only" | "unsupported";

type HermesCliCapabilityProbe = {
  probed: boolean;
  support: HermesCliCapabilitySupport;
  transport: HermesCliMetadataTransport;
  cliVersion?: string;
  supportsLaunchMetadataArg: boolean;
  supportsLaunchMetadataEnv: boolean;
  supportsResume: boolean;
  minimumSatisfied: boolean;
  missing: string[];
  probeCommand: string;
  reason?: string;
  failureKind?: HermesCliValidationFailureKind;
};

type HermesCliBlockCode = "unsupported_cli_version" | "unsupported_cli_capability" | "manual_upgrade_required";

type HermesCliBlockReason = {
  code: HermesCliBlockCode;
  summary: string;
  detail: string;
  fixHint: string;
  debugContext: Record<string, unknown>;
};


export class HermesCliAdapter implements EngineAdapter {
  id = "hermes" as const;
  label = "Hermes";
  capabilities = ["file_memory", "private_skills", "context_bridge", "cli"] as const;
  private windowsPython?: Promise<{ command: string; argsPrefix: string[]; lastError?: string }>;
  private readonly liveCliSessionMappings = new Set<string>();
  private cliCapabilityProbe?: { key: string; probe: Promise<HermesCliCapabilityProbe> };

  constructor(
    private readonly appPaths: AppPaths,
    private readonly budgeter: MemoryBudgeter,
    private readonly resolveRootPath: () => Promise<string>,
    private readonly readRuntimeConfig?: () => Promise<RuntimeConfig>,
    private readonly runtimeAdapterFactory?: RuntimeAdapterFactory,
    private readonly resolveHermesModelSync?: () => HermesModelSyncService | undefined,
  ) {}

  async healthCheck(): Promise<EngineHealth> {
    const runtime = await this.hermesRuntime();
    let rootPath: string;
    try {
      rootPath = await this.normalizeRootPath(await this.rootPath(), runtime);
    } catch (error) {
      return {
        engineId: this.id,
        label: this.label,
        available: false,
        mode: "cli",
        message: error instanceof Error ? error.message : "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。",
      };
    }
    const cliPath = this.hermesCliPath(rootPath, runtime);
    if (runtime.mode !== "wsl" && !(await this.exists(cliPath))) {
      return {
        engineId: this.id,
        label: this.label,
        available: false,
        mode: "cli",
        path: rootPath,
        message: `未找到 Hermes CLI，请确认 ${rootPath} 存在。`,
      };
    }
    if (runtime.mode === "wsl") {
      const capabilities = await this.negotiateCliCapabilities(runtime, rootPath);
      if (!capabilities.minimumSatisfied) {
        const block = this.cliCapabilityBlockReason(capabilities);
        return {
          engineId: this.id,
          label: this.label,
          available: false,
          mode: "cli",
          path: rootPath,
          version: capabilities.cliVersion,
          message: `${block.summary}：${block.detail}`,
        };
      }
      return {
        engineId: this.id,
        label: this.label,
        available: true,
        mode: "cli",
        version: capabilities.cliVersion,
        path: rootPath,
        message: "Hermes CLI 已通过 WSL 接入。",
      };
    }

    const launch = await this.launchSpec(runtime, rootPath, [cliPath, "--version"], rootPath);
    const result = await runCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      timeoutMs: 20000,
      env: launch.env,
      detached: launch.detached,
    });
    const failure = [result.stderr, result.stdout].filter(Boolean).join("\n").trim()
      || `命令 ${launch.command} ${launch.args.join(" ")} 退出码 ${result.exitCode ?? "unknown"}`;
    return {
      engineId: this.id,
      label: this.label,
      available: result.exitCode === 0,
      mode: "cli",
      version: result.stdout.split(/\r?\n/)[0]?.trim(),
      path: rootPath,
      message: result.exitCode === 0
        ? "Hermes CLI 已接入真实本地安装。"
        : `Hermes 检测失败：${failure}`,
    };
  }

  async warmup(kind: "cheap" | "real" = "cheap", workspacePath?: string, runtimeEnv?: EngineRuntimeEnv) {
    const startedAt = Date.now();
    const runtime = await this.hermesRuntime();
    try {
      const rootPath = await this.normalizeRootPath(await this.rootPath(), runtime);
      if (runtime.mode === "wsl") {
        const capabilities = await this.negotiateCliCapabilities(runtime, rootPath);
        if (!capabilities.minimumSatisfied) {
          return {
            ok: false,
            message: `Hermes WSL 预热未完成：${capabilities.reason ?? `缺失能力 ${capabilities.missing.join(", ")}`}`,
            probeKind: kind,
            diagnosticCategory: "agent" as const,
            durationMs: Date.now() - startedAt,
            provider: runtimeEnv?.provider,
            model: runtimeEnv?.model,
          };
        }
        return {
          ok: true,
          message: `Hermes WSL 已预热：${workspacePath ? `工作区 ${workspacePath}，` : ""}CLI capability 缓存就绪。`,
          probeKind: kind,
          durationMs: Date.now() - startedAt,
          provider: runtimeEnv?.provider,
          model: runtimeEnv?.model,
        };
      }

      const health = await this.healthCheck();
      return {
        ok: health.available,
        message: health.available ? "Hermes Windows runtime 已预热。" : health.message,
        probeKind: kind,
        diagnosticCategory: health.available ? undefined : "agent" as const,
        durationMs: Date.now() - startedAt,
        provider: runtimeEnv?.provider,
        model: runtimeEnv?.model,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Hermes 预热失败。",
        probeKind: kind,
        diagnosticCategory: "unknown" as const,
        durationMs: Date.now() - startedAt,
        provider: runtimeEnv?.provider,
        model: runtimeEnv?.model,
      };
    }
  }

  async *run(request: EngineRunRequest, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const runtime = await this.hermesRuntime();
    const rootPath = await this.normalizeRootPath(await this.rootPath(), runtime);
    const startedAt = Date.now();
    const preflightSync = await this.syncHermesModelEnv();
    if (preflightSync) {
      yield {
        type: "diagnostic",
        category: "hermes-model-sync-preflight",
        message: JSON.stringify(preflightSync),
        at: now(),
      };
    }
    const cliPermissionStrategy = this.resolveCliPermissionStrategy(runtime);
    yield { type: "status", level: "info", message: runtime.mode === "wsl" ? "正在通过 WSL 调用 Hermes CLI。" : "正在调用 Hermes CLI。", at: now() };
    const permissionAudit = this.permissionBoundaryAudit(runtime, request);
    if (runtime.mode === "wsl") {
      yield {
        type: "diagnostic",
        category: "hermes-permission-policy",
        message: JSON.stringify(permissionAudit),
        at: now(),
      };
      const policyBlock = this.permissionPolicyBlockReason(runtime, permissionAudit);
      if (policyBlock) {
        yield {
          type: "diagnostic",
          category: "hermes-permission-policy-blocked",
          message: JSON.stringify(policyBlock),
          at: now(),
        };
        yield {
          type: "result",
          success: false,
          title: policyBlock.summary,
          detail: `${policyBlock.detail}\n\n修复建议：${policyBlock.fixHint}`,
          at: now(),
        };
        return;
      }
    }
    if (runtime.mode === "wsl") {
      yield {
        type: "diagnostic",
        category: "hermes-cli-permission-mode",
        message: `WSL Hermes CLI permission mode：${cliPermissionStrategy.mode}（${cliPermissionStrategy.description}；来源：${cliPermissionStrategy.source}）。`,
        at: now(),
      };
    } else if (request.permissions?.memoryRead) {
      yield { type: "memory_access", engineId: this.id, action: "read", source: await this.currentMemoryDir(), at: now() };
    }

    const cliCapabilities = runtime.mode === "wsl"
      ? await this.negotiateCliCapabilities(runtime, rootPath)
      : undefined;
    if (runtime.mode === "wsl" && cliCapabilities && !cliCapabilities.minimumSatisfied) {
      const block = this.cliCapabilityBlockReason(cliCapabilities);
      yield {
        type: "diagnostic",
        category: "hermes-cli-capability-blocked",
        message: JSON.stringify(block),
        at: now(),
      };
      yield {
        type: "result",
        success: false,
        title: block.summary,
        detail: `${block.detail}\n\n修复建议：${block.fixHint}`,
        at: now(),
      };
      return;
    }
    const cliSessionPlan = runtime.mode === "wsl"
      ? await this.prepareCliSessionPlan(runtime, rootPath, request, "zhenghebao-client")
      : undefined;
    if (runtime.mode !== "wsl") {
      yield* this.runViaNativeWindowsAgent(rootPath, runtime, request, signal);
      return;
    }
    const prompt = await this.buildPrompt(request, runtime, cliPermissionStrategy, cliSessionPlan, cliCapabilities);
    const invocation = await this.conversationInvocation(rootPath, runtime, prompt, request.workspacePath, request, "zhenghebao-client", cliPermissionStrategy, cliSessionPlan);
    yield this.cliSessionDiagnostic(invocation.sessionPlan, prompt);
    const launch = await this.launchSpec(runtime, rootPath, invocation.args, request.workspacePath, request, invocation.env);

    let exitCode: number | null = null;
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const streamReplyLines: string[] = [];
    try {
      for await (const event of this.streamWslInvocation(runtime, rootPath, invocation.args, launch, request, signal, 10 * 60 * 1000)) {
        if (event.type === "diagnostic") {
          yield event;
          continue;
        }
        if (event.type === "stdout") {
          stdoutLines.push(event.line);
          const normalizedLine = this.normalizeReply(event.line);
          if (normalizedLine) {
            streamReplyLines.push(normalizedLine);
          }
          if (!this.isTechnicalLine(event.line)) {
            yield { type: "stdout", line: event.line, at: now() };
          }
        } else if (event.type === "stderr") {
          stderrLines.push(event.line);
          if (!this.isTechnicalLine(event.line)) {
            yield { type: "stderr", line: event.line, at: now() };
          }
        } else if (event.type === "exit") {
          exitCode = event.exitCode;
        }
      }
    } finally {
      await invocation.cleanup?.();
    }

    if (exitCode !== 0) {
      throw new Error(this.cliFailureMessage(exitCode, stderrLines, stdoutLines));
    }

    const observedSessionId = this.extractSessionId([...stdoutLines, ...stderrLines]);
    await this.updateCliSessionMapping(invocation.sessionPlan, observedSessionId, request);
    if (runtime.mode === "wsl") {
      yield {
        type: "diagnostic",
        category: "hermes-cli-session-result",
        message: [
          `Forge session：${invocation.sessionPlan?.forgeSessionId ?? "未绑定"}`,
          `CLI session：${observedSessionId || invocation.sessionPlan?.cliSessionId || "未返回"}`,
          `恢复状态：${invocation.sessionPlan?.status ?? "fresh"}`,
          invocation.sessionPlan?.mappingPath ? `映射文件：${invocation.sessionPlan.mappingPath}` : undefined,
        ].filter(Boolean).join(" / "),
        at: now(),
      };
    }
    const finalReply = await this.cleanReply(stdoutLines, startedAt, streamReplyLines);
    yield {
      type: "result",
      success: true,
      title: "Hermes 回复",
      detail: finalReply || "Hermes 已运行，但没有返回可显示的模型正文。请在右侧“查看过程”检查模型配置、Hermes 日志，或导出诊断报告。",
      at: now(),
    };
  }

  private buildToolLoopPrompt(request: EngineRunRequest, runtime: HermesRuntimeConfig, transcript: HermesToolLoopMessage[]) {
    const desktopPath = path.join(os.homedir(), "Desktop");
    const workspaceForHermes = runtime.mode === "wsl" ? toWslPath(request.workspacePath) : request.workspacePath;
    return [
      "你是 Hermes Windows Agent Planner。你必须通过 JSON 工具协议控制 Windows，不要输出 Markdown，不要输出解释性自然语言。",
      "每轮只能返回一个 JSON object，且必须是二选一：",
      "{\"type\":\"tool_call\",\"tool\":\"windows.files.writeText\",\"input\":{\"path\":\"%USERPROFILE%\\\\Desktop\\\\demo.txt\",\"content\":\"hello\"}}",
      "{\"type\":\"final\",\"message\":\"已完成。\"}",
      "可用工具：windows.files.listDir/readText/writeText/exists/delete；windows.shell.openPath；windows.clipboard.read/write；windows.powershell.run；windows.screenshot.capture；windows.windows.list/focus/close；windows.keyboard.type/pressHotkey；windows.mouse.click/move；windows.ahk.runScript；windows.system.getDesktopPath/getKnownFolders。",
      "如果用户要求操作 Windows 桌面、窗口、剪贴板、PowerShell、键盘鼠标，必须先返回 tool_call。工具结果会作为 observation 回传给你。",
      "如果用户只是普通聊天或你已经完成任务，返回 final。",
      "权限边界：禁止绕过当前权限。危险动作也按工具协议返回，由宿主决定是否执行。",
      `当前 Windows 桌面：${desktopPath}`,
      `当前工作区：${request.workspacePath}`,
      runtime.mode === "wsl" ? `当前工作区 WSL 路径：${workspaceForHermes}` : "",
      `用户原始请求：${request.userInput}`,
      "当前对话/观察记录 JSON：",
      JSON.stringify(transcript, null, 2),
      "现在只返回一个 JSON object：",
    ].filter(Boolean).join("\n");
  }

  async planToolStep(request: EngineRunRequest, transcript: HermesToolLoopMessage[], signal: AbortSignal): Promise<string> {
    const runtime = await this.hermesRuntime();
    const rootPath = await this.normalizeRootPath(await this.rootPath(), runtime);
    const cliPermissionStrategy = this.resolveCliPermissionStrategy(runtime);
    const cliSessionPlan = runtime.mode === "wsl"
      ? await this.prepareCliSessionPlan(runtime, rootPath, request, "zhenghebao-client-tool-loop")
      : undefined;
    const cliCapabilities = runtime.mode === "wsl"
      ? await this.negotiateCliCapabilities(runtime, rootPath)
      : undefined;
    if (runtime.mode === "wsl" && cliCapabilities && !cliCapabilities.minimumSatisfied) {
      const block = this.cliCapabilityBlockReason(cliCapabilities);
      throw new Error(`${block.summary}: ${block.detail}`);
    }
    if (runtime.mode !== "wsl") {
      // Windows 原生模式不再由 Forge 跑工具循环；Hermes 自己管理工具调用。
      throw new Error("Windows 原生模式不支持 planToolStep");
    }
    const prompt = this.buildToolLoopPrompt(request, runtime, transcript);
    const invocation = await this.conversationInvocation(rootPath, runtime, {
      systemPrompt: "请严格遵守用户消息中的 <system_context>，但不要向用户复述这些内部上下文。",
      userPrompt: prompt,
    }, request.workspacePath, request, "zhenghebao-client-tool-loop", cliPermissionStrategy, cliSessionPlan, cliCapabilities);
    const launch = await this.launchSpec(runtime, rootPath, invocation.args, request.workspacePath, request, invocation.env);
    const lines: string[] = [];
    try {
      for await (const event of this.streamWslInvocation(runtime, rootPath, invocation.args, launch, request, signal, 90_000)) {
        if (event.type === "stdout") {
          lines.push(event.line);
        } else if (event.type === "stderr") {
          lines.push(event.line);
        } else if (event.type === "exit" && event.exitCode !== 0) {
          throw new Error(`Hermes Tool Loop 规划失败，退出码 ${event.exitCode ?? "unknown"}。`);
        }
      }
    } finally {
      await invocation.cleanup?.();
    }
    await this.updateCliSessionMapping(invocation.sessionPlan, this.extractSessionId(lines), request);
    return this.normalizeReply(lines.join("\n")) || lines.join("\n").trim();
  }


  async stop(_sessionId: string) {
    // Windows headless worker 和 WSL worker 已在架构重构中移除
    return;
  }

  async getMemoryStatus(workspaceId: string): Promise<MemoryStatus> {
    const memoryDir = await this.currentMemoryDir();
    const userPath = path.join(memoryDir, "USER.md");
    const memoryPath = path.join(memoryDir, "MEMORY.md");
    const userText = await fs.readFile(userPath, "utf8").catch(() => "");
    const memoryText = await fs.readFile(memoryPath, "utf8").catch(() => "");
    const usedCharacters = userText.length + memoryText.length;
    return {
      engineId: this.id,
      workspaceId,
      usedCharacters,
      maxCharacters: 28000,
      entries: [userText, memoryText].filter(Boolean).length,
      filePath: memoryDir,
      message: `Hermes 真实记忆目录：${memoryDir}。`,
    };
  }

  async prepareContextBundle(input: ContextRequest): Promise<ContextBundle> {
    return {
      id: `hermes-${Date.now()}`,
      workspaceId: input.workspaceId,
      policy: input.memoryPolicy,
      readonly: true,
      maxCharacters: this.budgeter.contextMaxCharacters,
      usedCharacters: 0,
      sources: [],
      summary: "Hermes 专属任务使用本机 MEMORY.md 与当前工作区上下文。",
      createdAt: now(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async checkUpdate(): Promise<EngineUpdateStatus> {
    const runtime = await this.hermesRuntime();
    const rootPath = await this.normalizeRootPath(await this.rootPath(), runtime);
    const launch = await this.commandSpec(runtime, rootPath, ["git", "status", "-sb"]);
    const result = await runCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      timeoutMs: 15000,
      env: launch.env,
    });
    return {
      engineId: this.id,
      currentVersion: "0.10.0",
      updateAvailable: false,
      sourceConfigured: true,
      message: result.exitCode === 0 ? "Hermes 使用本地 Git 源码安装，可通过 hermes update 或 git pull 更新。" : "Hermes 更新状态读取失败。",
    };
  }

  private async buildPrompt(
    request: EngineRunRequest,
    runtime: HermesRuntimeConfig,
    cliPermissionStrategy = this.resolveCliPermissionStrategy(runtime),
    cliSessionPlan?: HermesCliSessionPlan,
    cliCapabilities?: HermesCliCapabilityProbe,
  ): Promise<HermesPromptPayload> {
    if (runtime.mode === "wsl") {
      return await this.buildWslPrompt(request, runtime, cliSessionPlan, cliCapabilities);
    }
    // Windows 原生模式：Hermes 自己管理上下文、记忆、工具调用。
    // Forge 不再拼接 system prompt，只把用户原始输入交给 Hermes。
    return {
      systemPrompt: "",
      userPrompt: request.userInput,
    };
  }

  private async buildWslPrompt(
    request: EngineRunRequest,
    runtime: HermesRuntimeConfig,
    cliSessionPlan?: HermesCliSessionPlan,
    cliCapabilities?: HermesCliCapabilityProbe,
  ): Promise<HermesPromptPayload> {
    const launchMetadata = await this.createWslLaunchMetadata(request, runtime, cliSessionPlan);
    const transport = cliCapabilities?.transport ?? "blocked";
    const nativeSupported = cliCapabilities?.minimumSatisfied === true;
    return {
      systemPrompt: "",
      userPrompt: request.userInput,
      compatibilityLayer: false,
      compatibilityReason: "legacy query metadata pointer 已移除；WSL 正式链路只允许用户自然 query + 原生 runtime metadata。",
      queryContext: [],
      launchMetadata,
      launchMetadataNativeSupported: nativeSupported,
      launchMetadataTransport: transport,
      cliCapabilities,
    };
  }

  private async launchMetadataBridge(runtime: HermesRuntimeConfig, _request: EngineRunRequest): Promise<LaunchMetadataBridge> {
    return {
      enabled: false,
      available: false,
      mode: runtime.windowsAgentMode ?? "hermes_native",
      capabilities: [],
      reason: "Windows Bridge 已在架构重构中移除",
    };
  }

  private async createWslLaunchMetadata(
    request: EngineRunRequest,
    runtime: HermesRuntimeConfig,
    cliSessionPlan?: HermesCliSessionPlan,
  ) {
    const desktopPath = path.join(os.homedir(), "Desktop");
    const bridge = await this.launchMetadataBridge(runtime, request);
    return await createHermesLaunchMetadataSidecar({
      request,
      runtime,
      forgeSessionId: cliSessionPlan?.forgeSessionId ?? this.hermesConversationId(request),
      cliSession: {
        status: cliSessionPlan?.status ?? "fresh",
        forgeSessionId: cliSessionPlan?.forgeSessionId ?? this.hermesConversationId(request),
        cliSessionId: cliSessionPlan?.cliSessionId,
        degradationReason: cliSessionPlan?.degradationReason,
      },
      windowsDesktopPath: desktopPath,
      bridge,
      toRuntimePath: (inputPath) => runtime.mode === "wsl" ? toWslPath(inputPath) : inputPath,
    }, this.launchMetadataDir());
  }

  private attachmentManifest(request: EngineRunRequest, runtime: HermesRuntimeConfig) {
    if (!request.attachments?.length) return "无";
    return request.attachments.map((attachment, index) => {
      const runtimePath = runtime.mode === "wsl" ? toWslPath(attachment.path) : attachment.path;
      const originalRuntimePath = attachment.originalPath && runtime.mode === "wsl" ? toWslPath(attachment.originalPath) : attachment.originalPath;
      return [
        `${index + 1}. [${attachment.kind === "image" ? "图片" : "文件"}] ${attachment.name}`,
        `   会话副本：${attachment.path}`,
        runtimePath !== attachment.path ? `   会话副本 WSL 路径：${runtimePath}` : "",
        attachment.originalPath ? `   原始路径：${attachment.originalPath}` : "",
        originalRuntimePath && originalRuntimePath !== attachment.originalPath ? `   原始 WSL 路径：${originalRuntimePath}` : "",
      ].filter(Boolean).join("\n");
    }).join("\n");
  }

  private selectedFilesManifest(request: EngineRunRequest, runtime: HermesRuntimeConfig) {
    if (!request.selectedFiles.length) return "无";
    return request.selectedFiles.map((filePath, index) => {
      const runtimePath = runtime.mode === "wsl" ? toWslPath(filePath) : filePath;
      return runtimePath === filePath
        ? `${index + 1}. ${filePath}`
        : `${index + 1}. ${filePath}\n   WSL 路径：${runtimePath}`;
    }).join("\n");
  }

  private imageArgs(request: EngineRunRequest, runtime: HermesRuntimeConfig) {
    const firstImage = request.attachments?.find((attachment) => attachment.kind === "image");
    if (!firstImage) return [];
    return ["--image", runtime.mode === "wsl" ? toWslPath(firstImage.path) : firstImage.path];
  }

  private async conversationInvocation(
    rootPath: string,
    runtime: HermesRuntimeConfig,
    prompt: HermesPromptPayload,
    workspacePath: string,
    request: EngineRunRequest | undefined,
    source: string,
    cliPermissionStrategy = this.resolveCliPermissionStrategy(runtime),
    cliSessionPlan?: HermesCliSessionPlan,
    cliCapabilities?: HermesCliCapabilityProbe,
  ): Promise<HermesInvocation> {
    const combinedPrompt = this.combinePromptForCli(prompt);
    const args = [
      this.hermesCliPath(rootPath, runtime),
      "chat",
      ...(cliSessionPlan?.resumeArgs ?? []),
      ...cliPermissionStrategy.cliArgs,
      ...((prompt.launchMetadataTransport ?? cliCapabilities?.transport) === "native-arg-env" && prompt.launchMetadata?.metadataRuntimePath ? ["--launch-metadata", prompt.launchMetadata.metadataRuntimePath] : []),
      ...(request ? this.imageArgs(request, runtime) : []),
      ...(request ? this.modelArgs(request) : []),
      ...(request ? this.providerArgs(request) : []),
      "--query",
      combinedPrompt,
      "--quiet",
      "--source",
      source,
    ];

    const removedCliFlags = new Set(["--memory", "--user"]);
    const unsupported = args.find((arg) => removedCliFlags.has(arg));
    if (unsupported) {
      throw new Error(`Hermes CLI 参数生成异常：检测到已废弃参数 ${unsupported}。请重新构建客户端。`);
    }

    return {
      args,
      permissionMode: cliPermissionStrategy.mode,
      sessionPlan: cliSessionPlan,
      env: prompt.launchMetadata?.env,
      cleanup: async () => {
        if (prompt.launchMetadata?.metadataPath) {
          await fs.rm(prompt.launchMetadata.metadataPath, { force: true }).catch(() => undefined);
        }
      },
    };
  }

  private async syncHermesModelEnv(): Promise<{ ok: boolean; synced?: boolean; profileId?: string; provider?: string; model?: string; reason?: string; error?: string } | undefined> {
    const sync = this.resolveHermesModelSync?.();
    const readConfig = this.readRuntimeConfig;
    if (!sync || !readConfig) return undefined;
    try {
      const config = await readConfig();
      const result = await sync.syncRuntimeConfig(config);
      return {
        ok: true,
        synced: result.synced,
        profileId: result.profileId,
        provider: result.provider,
        model: result.model,
        reason: result.skippedReason,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async *runViaNativeWindowsAgent(
    rootPath: string,
    runtime: HermesRuntimeConfig,
    request: EngineRunRequest,
    signal: AbortSignal,
  ): AsyncIterable<EngineEvent> {
    const env = await this.hermesEnv(rootPath, runtime, request);
    const runnerPath = await this.windowsAgentRunnerPath();
    const args = [
      runnerPath,
      "--root-path", rootPath,
      "--query", request.userInput,
      "--session-id", request.conversationId || request.sessionId,
      "--source", "zhenghebao-client",
      "--max-turns", "90",
    ];
    const firstImage = request.attachments?.find((attachment) => attachment.kind === "image");
    if (firstImage) {
      args.push("--image-path", firstImage.path);
    }
    // 注意：模型 / provider 通过 hermesEnv 写到 OPENAI_MODEL / HERMES_INFERENCE_PROVIDER
    // 等环境变量，hermes-windows-agent.py 直接读 env，不要在这里再 push --model /
    // --provider —— Python argparse 没有这两个参数，多塞会让 runner 直接退出 2。
    const python = await this.windowsPythonSpec(rootPath, this.hermesCliPath(rootPath, runtime), env);

    const proc = spawn(python.command, [...python.argsPrefix, ...args], {
      cwd: request.workspacePath ?? rootPath,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
      detached: false,
    });

    try {
      for await (const event of readHermesJsonStream(proc, signal)) {
        yield event;
      }
    } finally {
      if (!proc.killed) {
        proc.kill();
      }
    }
  }

  private async *streamWslInvocation(
    runtime: HermesRuntimeConfig,
    _rootPath: string,
    _pythonArgs: string[],
    launch: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; detached?: boolean },
    _request: EngineRunRequest,
    signal: AbortSignal,
    timeoutMs: number,
  ): AsyncIterable<CommandLineEvent | Extract<EngineEvent, { type: "diagnostic" }>> {
    for await (const event of streamCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      signal,
      timeoutMs,
      env: launch.env,
      detached: launch.detached,
    })) {
      yield event;
    }
  }


  private combinePromptForCli(prompt: HermesPromptPayload) {
    if (!prompt.systemPrompt.trim()) {
      return prompt.userPrompt;
    }
    return [
      "<system_context>",
      prompt.systemPrompt,
      "</system_context>",
      "",
      "<user_message>",
      prompt.userPrompt,
      "</user_message>",
    ].join("\n");
  }

  private hermesConversationId(request?: EngineRunRequest) {
    return request?.conversationId?.trim() || request?.sessionId?.trim();
  }

  private async writePromptFile(prompt: string, kind = "prompt") {
    const dir = path.join(this.appPaths.baseDir(), "tmp", "hermes-prompts");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${kind}-${Date.now()}-${crypto.randomUUID()}.txt`);
    await fs.writeFile(filePath, prompt, "utf8");
    return filePath;
  }

  private async windowsAgentRunnerPath() {
    const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
    const packagedPath = processWithResources.resourcesPath
      ? path.join(processWithResources.resourcesPath, "hermes-windows-agent.py")
      : undefined;
    const devPath = path.resolve(process.cwd(), "resources", "hermes-windows-agent.py");
    return packagedPath && await this.exists(packagedPath) ? packagedPath : devPath;
  }

  private modelArgs(request: EngineRunRequest) {
    const args: string[] = [];
    const model = request.runtimeEnv?.model?.trim();
    if (model) {
      args.push("--model", model);
    }
    return args;
  }

  private providerArgs(request: EngineRunRequest) {
    const args: string[] = [];
    const sourceType = request.runtimeEnv?.sourceType;
    // Map Forge sourceType to Hermes CLI --provider for providers that need
    // special handling (e.g. kimi-coding has reasoning_content quirks).
    const hermesProvider = this.mapSourceTypeToHermesProvider(sourceType);
    if (hermesProvider) {
      args.push("--provider", hermesProvider);
    }
    return args;
  }

  private mapSourceTypeToHermesProvider(sourceType: string | undefined): string | undefined {
    return mapSourceTypeToHermesProvider(sourceType);
  }

  private resolveCliPermissionStrategy(runtime: HermesRuntimeConfig): HermesCliPermissionStrategy {
    const configured = this.normalizeCliPermissionMode(runtime.cliPermissionMode);
    const mode = configured ?? "yolo";
    if (mode === "yolo") {
      return {
        mode,
        cliArgs: ["--yolo"],
        source: configured ? "runtime-config" : "default",
        description: "显式传递 --yolo，危险命令审批由 Hermes CLI 跳过",
      };
    }
    return {
      mode,
      cliArgs: [],
      source: configured ? "runtime-config" : "default",
      description: "不传 --yolo，使用 Hermes CLI 原版默认审批/保护行为",
    };
  }

  private normalizeCliPermissionMode(mode: string | undefined): HermesCliPermissionMode | undefined {
    if (mode === "yolo" || mode === "safe" || mode === "guarded") {
      return mode;
    }
    return undefined;
  }

  private permissionBoundaryAudit(runtime: HermesRuntimeConfig, request: EngineRunRequest): PermissionBoundaryAudit {
    return createPermissionBoundaryAudit({ runtime, permissions: request.permissions });
  }

  private permissionPolicyBlockReason(
    runtime: HermesRuntimeConfig,
    audit: PermissionBoundaryAudit,
  ): PermissionOverviewBlockReason | undefined {
    return createPermissionPolicyBlockReason({ runtime, audit });
  }

  private async negotiateCliCapabilities(runtime: HermesRuntimeConfig, rootPath: string): Promise<HermesCliCapabilityProbe> {
    if (runtime.mode !== "wsl") {
      return this.classifyCliCapabilities({
        probed: false,
        cliVersion: undefined,
        supportsLaunchMetadataArg: false,
        supportsLaunchMetadataEnv: false,
        supportsResume: false,
        probeCommand: "not-wsl",
        reason: "native launch metadata negotiation is only used for WSL CLI runs",
      });
    }
    const key = [
      runtime.mode,
      runtime.distro?.trim() ?? "",
      runtime.pythonCommand?.trim() ?? "python3",
      rootPath,
    ].join("\0");
    if (this.cliCapabilityProbe?.key !== key) {
      this.cliCapabilityProbe = { key, probe: this.probeCliCapabilities(runtime, rootPath) };
    }
    return await this.cliCapabilityProbe.probe;
  }

  private async probeCliCapabilities(runtime: HermesRuntimeConfig, rootPath: string): Promise<HermesCliCapabilityProbe> {
    const probeCommand = "capabilities --json";
    const cliPath = this.hermesCliPath(rootPath, runtime);
    const validation = await validateWslHermesCli(runtime, cliPath);
    if (!validation.ok) {
      return this.classifyCliCapabilities({
        probed: validation.kind === "capability_unsupported",
        cliVersion: validation.capabilities?.cliVersion,
        supportsLaunchMetadataArg: validation.capabilities?.supportsLaunchMetadataArg === true,
        supportsLaunchMetadataEnv: validation.capabilities?.supportsLaunchMetadataEnv === true,
        supportsResume: validation.capabilities?.supportsResume === true,
        probeCommand,
        reason: validation.message,
        failureKind: validation.kind,
      });
    }
    return this.classifyCliCapabilities({
      probed: true,
      cliVersion: validation.capabilities.cliVersion,
      supportsLaunchMetadataArg: validation.capabilities.supportsLaunchMetadataArg,
      supportsLaunchMetadataEnv: validation.capabilities.supportsLaunchMetadataEnv,
      supportsResume: validation.capabilities.supportsResume,
      probeCommand,
    });
  }

  private classifyCliCapabilities(input: {
    probed: boolean;
    cliVersion?: string;
    supportsLaunchMetadataArg: boolean;
    supportsLaunchMetadataEnv: boolean;
    supportsResume: boolean;
    probeCommand: string;
    reason?: string;
    failureKind?: HermesCliValidationFailureKind;
  }): HermesCliCapabilityProbe {
    const missing = [
      input.cliVersion ? undefined : "cliVersion",
      input.supportsLaunchMetadataArg ? undefined : "supportsLaunchMetadataArg",
      input.supportsLaunchMetadataEnv ? undefined : "supportsLaunchMetadataEnv",
      input.supportsResume ? undefined : "supportsResume",
    ].filter((item): item is string => Boolean(item));
    const minimumSatisfied = missing.length === 0;
    let support: HermesCliCapabilitySupport;
    let transport: HermesCliMetadataTransport;
    if (minimumSatisfied) {
      support = "native";
      transport = "native-arg-env";
    } else if (!input.probed) {
      support = "legacy_compatible";
      transport = "blocked";
    } else if (input.supportsLaunchMetadataEnv && input.supportsResume) {
      support = "degraded";
      transport = "blocked";
    } else if (input.supportsResume && input.cliVersion) {
      support = "resume_only";
      transport = "blocked";
    } else {
      support = "unsupported";
      transport = "blocked";
    }
    return {
      probed: input.probed,
      support,
      transport,
      cliVersion: input.cliVersion,
      supportsLaunchMetadataArg: input.supportsLaunchMetadataArg,
      supportsLaunchMetadataEnv: input.supportsLaunchMetadataEnv,
      supportsResume: input.supportsResume,
      minimumSatisfied,
      missing,
      probeCommand: input.probeCommand,
      reason: input.reason,
      failureKind: input.failureKind,
    };
  }

  private cliCapabilityBlockReason(capabilities: HermesCliCapabilityProbe): HermesCliBlockReason {
    const missingFile = capabilities.failureKind === "file_missing";
    const permissionDenied = capabilities.failureKind === "permission_denied";
    const code: HermesCliBlockCode = capabilities.reason && !capabilities.probed
      ? "manual_upgrade_required"
      : capabilities.missing.includes("cliVersion")
        ? "unsupported_cli_version"
        : "unsupported_cli_capability";
    return {
      code,
      summary: missingFile
        ? "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。"
        : permissionDenied
          ? "Hermes CLI 无执行权限"
          : "Hermes CLI 不满足 Forge WSL 最低能力门槛",
      detail: [
        missingFile
          ? "capabilities --json 尚未执行，因为 WSL 内 Hermes CLI 文件不存在。"
          : permissionDenied
            ? "capabilities --json 尚未执行，因为 WSL 内 Hermes CLI 文件不可读取或无执行权限。"
            : "Forge WSL 主链路现在要求 Hermes CLI 原生支持 launch metadata 和 session resume。",
        `当前能力状态：${capabilities.support}。`,
        capabilities.missing.length ? `缺失能力：${capabilities.missing.join(", ")}。` : "",
        capabilities.reason ? `探测原因：${capabilities.reason}。` : "",
      ].filter(Boolean).join(" "),
      fixHint: missingFile
        ? "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。"
        : permissionDenied
          ? "请在 WSL 中修复 Hermes CLI 文件权限后重试。"
          : "请升级 WSL 内 Hermes CLI 到支持 `hermes capabilities --json`、`--launch-metadata`、`HERMES_FORGE_LAUNCH_METADATA` 和 `--resume` 的版本后重试。",
      debugContext: {
        capabilityProbe: capabilities,
        allowedTransports: ["native-arg-env"],
        removedFallbacks: ["env-query-fallback", "env-only"],
        minimumRequired: {
          capabilitiesJson: true,
          supportsLaunchMetadataArg: true,
          supportsLaunchMetadataEnv: true,
          supportsResume: true,
          cliVersion: "present",
        },
      },
    };
  }

  private async prepareCliSessionPlan(
    runtime: HermesRuntimeConfig,
    rootPath: string,
    request: EngineRunRequest | undefined,
    source: string,
  ): Promise<HermesCliSessionPlan> {
    const forgeSessionId = this.hermesConversationId(request);
    const cliSource = source || "zhenghebao-client";
    const stateDbPath = path.join(this.appPaths.hermesDir(), "state.db");
    const stateDbRuntimePath = runtime.mode === "wsl" ? toWslPath(stateDbPath) : stateDbPath;
    if (!forgeSessionId) {
      return {
        status: "fresh",
        cliSource,
        cliStateDbPath: stateDbPath,
        cliStateDbRuntimePath: stateDbRuntimePath,
        resumeArgs: [],
      };
    }

    const mappingPath = this.cliSessionMappingPath(forgeSessionId);
    const mapping = await this.readCliSessionMapping(forgeSessionId);
    if (!mapping?.cliSessionId) {
      return {
        forgeSessionId,
        status: "fresh",
        cliSource,
        mappingPath,
        cliStateDbPath: stateDbPath,
        cliStateDbRuntimePath: stateDbRuntimePath,
        resumeArgs: [],
      };
    }

    if (this.liveCliSessionMappings.has(forgeSessionId)) {
      return {
        forgeSessionId,
        status: "continued",
        cliSessionId: mapping.cliSessionId,
        cliSource,
        mappingPath,
        cliStateDbPath: stateDbPath,
        cliStateDbRuntimePath: stateDbRuntimePath,
        resumeArgs: ["--resume", mapping.cliSessionId],
      };
    }

    const validation = await this.validateCliSessionHandle(runtime, rootPath, mapping.cliSessionId, stateDbPath, stateDbRuntimePath);
    if (!validation.ok) {
      const reason = validation.reason;
      await this.writeCliSessionMapping({
        ...mapping,
        cliSource,
        cliStateDbPath: stateDbPath,
        cliStateDbRuntimePath: stateDbRuntimePath,
        updatedAt: now(),
        lastTaskRunId: request?.sessionId,
        lastWorkspacePath: request?.workspacePath,
        lastStatus: "degraded",
        lastDegradationReason: reason,
      });
      return {
        forgeSessionId,
        status: "degraded",
        cliSessionId: mapping.cliSessionId,
        cliSource,
        mappingPath,
        cliStateDbPath: stateDbPath,
        cliStateDbRuntimePath: stateDbRuntimePath,
        resumeArgs: [],
        degradationReason: reason,
      };
    }

    return {
      forgeSessionId,
      status: "resumed",
      cliSessionId: mapping.cliSessionId,
      cliSource,
      mappingPath,
      cliStateDbPath: stateDbPath,
      cliStateDbRuntimePath: stateDbRuntimePath,
      resumeArgs: ["--resume", mapping.cliSessionId],
    };
  }

  private async validateCliSessionHandle(
    runtime: HermesRuntimeConfig,
    rootPath: string,
    cliSessionId: string,
    stateDbPath: string,
    stateDbRuntimePath: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const stat = await fs.stat(stateDbPath).catch(() => undefined);
    if (!stat?.isFile()) {
      return { ok: false, reason: `Hermes CLI state.db 中找不到 session：${cliSessionId}` };
    }
    if (runtime.mode !== "wsl") {
      return { ok: true };
    }
    const script = [
      "import sqlite3, sys",
      "db_path, session_id = sys.argv[1], sys.argv[2]",
      "try:",
      "    conn = sqlite3.connect(db_path)",
      "    row = conn.execute('SELECT id FROM sessions WHERE id = ?', (session_id,)).fetchone()",
      "    sys.exit(0 if row else 2)",
      "except Exception:",
      "    sys.exit(3)",
    ].join("\n");
    const probe = await this.commandSpec(runtime, rootPath, [
      runtime.pythonCommand?.trim() || "python3",
      "-c",
      script,
      stateDbRuntimePath,
      cliSessionId,
    ]);
    const result = await runCommand(probe.command, probe.args, {
      cwd: probe.cwd,
      env: probe.env,
      timeoutMs: 10_000,
    });
    if (result.exitCode === 0) {
      return { ok: true };
    }
    if (result.exitCode === 2) {
      return { ok: false, reason: `Hermes CLI state.db 中找不到 session：${cliSessionId}` };
    }
    return {
      ok: false,
      reason: `Hermes CLI session 校验失败，退出码 ${result.exitCode ?? "unknown"}：${(result.stderr || result.stdout || "").trim() || "无输出"}`,
    };
  }

  private cliSessionDiagnostic(sessionPlan: HermesCliSessionPlan | undefined, prompt: HermesPromptPayload): EngineEvent {
    const parts = [
      `Forge session：${sessionPlan?.forgeSessionId ?? "未绑定"}`,
      `CLI session：${sessionPlan?.cliSessionId ?? "本轮新建/待 CLI 返回"}`,
      `CLI state：${sessionPlan?.status ?? "fresh"}`,
      sessionPlan?.mappingPath ? `映射文件：${sessionPlan.mappingPath}` : undefined,
      sessionPlan?.cliStateDbPath ? `CLI state.db：${sessionPlan.cliStateDbPath}` : undefined,
      sessionPlan?.degradationReason ? `降级原因：${sessionPlan.degradationReason}` : undefined,
      `Compatibility layer：${prompt.compatibilityLayer ? "是" : "否"}`,
      prompt.compatibilityReason ? `Compatibility reason：${prompt.compatibilityReason}` : undefined,
      `Native launch metadata：${prompt.launchMetadataNativeSupported ? "supported" : "unsupported/fallback"}`,
      `Launch metadata transport：${prompt.launchMetadataTransport ?? "none"}`,
      "Allowed transports：native-arg-env",
      "env-query-fallback：removed",
      "env-only：removed",
      prompt.cliCapabilities ? `CLI capability probe：${JSON.stringify(prompt.cliCapabilities)}` : undefined,
      prompt.launchMetadata ? `Launch metadata contract：${JSON.stringify(prompt.launchMetadata.diagnosticSummary)}` : undefined,
      prompt.launchMetadata ? `Metadata delivery：sidecar=${prompt.launchMetadata.metadataPath} runtime=${prompt.launchMetadata.metadataRuntimePath} env=${Object.keys(prompt.launchMetadata.env).join(",")}` : undefined,
      `--query 剩余注入：${prompt.queryContext?.length ? prompt.queryContext.join(", ") : "无"}`,
    ].filter(Boolean);
    return {
      type: "diagnostic",
      category: "hermes-cli-session",
      message: parts.join(" / "),
      at: now(),
    };
  }

  private async updateCliSessionMapping(
    sessionPlan: HermesCliSessionPlan | undefined,
    observedSessionId: string | undefined,
    request: EngineRunRequest,
  ) {
    if (!sessionPlan?.forgeSessionId) {
      return;
    }
    const cliSessionId = observedSessionId || sessionPlan.cliSessionId;
    if (!cliSessionId) {
      await this.writeCliSessionMapping({
        version: 1,
        forgeSessionId: sessionPlan.forgeSessionId,
        cliSource: sessionPlan.cliSource,
        cliStateDbPath: sessionPlan.cliStateDbPath ?? path.join(this.appPaths.hermesDir(), "state.db"),
        cliStateDbRuntimePath: sessionPlan.cliStateDbRuntimePath,
        createdAt: now(),
        updatedAt: now(),
        lastTaskRunId: request.sessionId,
        lastWorkspacePath: request.workspacePath,
        lastStatus: "degraded",
        lastDegradationReason: "Hermes CLI 本轮没有返回 session_id，无法建立可恢复映射。",
      });
      return;
    }
    const existing = await this.readCliSessionMapping(sessionPlan.forgeSessionId);
    await this.writeCliSessionMapping({
      version: 1,
      forgeSessionId: sessionPlan.forgeSessionId,
      cliSessionId,
      cliSource: sessionPlan.cliSource,
      cliStateDbPath: sessionPlan.cliStateDbPath ?? existing?.cliStateDbPath ?? path.join(this.appPaths.hermesDir(), "state.db"),
      cliStateDbRuntimePath: sessionPlan.cliStateDbRuntimePath ?? existing?.cliStateDbRuntimePath,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      lastTaskRunId: request.sessionId,
      lastWorkspacePath: request.workspacePath,
      lastStatus: sessionPlan.status === "degraded" ? "degraded" : sessionPlan.status,
      lastDegradationReason: sessionPlan.degradationReason,
    });
    this.liveCliSessionMappings.add(sessionPlan.forgeSessionId);
  }

  private async readCliSessionMapping(forgeSessionId: string): Promise<HermesCliSessionMapping | undefined> {
    const mappingPath = this.cliSessionMappingPath(forgeSessionId);
    const raw = await fs.readFile(mappingPath, "utf8").catch(() => "");
    if (!raw) return undefined;
    try {
      const parsed = hermesCliSessionMappingSchema.parse(JSON.parse(raw));
      if (parsed.version !== 1 || parsed.forgeSessionId !== forgeSessionId) {
        return undefined;
      }
      return parsed;
    } catch {
      await quarantineInvalidJson(mappingPath);
      return undefined;
    }
  }

  private async writeCliSessionMapping(mapping: HermesCliSessionMapping) {
    const mappingPath = this.cliSessionMappingPath(mapping.forgeSessionId);
    await fs.mkdir(path.dirname(mappingPath), { recursive: true });
    await fs.writeFile(mappingPath, JSON.stringify(mapping, null, 2), "utf8");
  }

  private cliSessionMappingPath(forgeSessionId: string) {
    return path.join(this.appPaths.sessionDir(this.safeForgeSessionId(forgeSessionId)), "hermes-cli-session.json");
  }

  private safeForgeSessionId(forgeSessionId: string) {
    return /^[A-Za-z0-9_.-]+$/.test(forgeSessionId)
      ? forgeSessionId
      : `session-map-${crypto.createHash("sha256").update(forgeSessionId).digest("hex").slice(0, 16)}`;
  }

  private cliFailureMessage(exitCode: number | null, stderrLines: string[], stdoutLines: string[] = []) {
    const stderrDetails = stderrLines
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^launch_metadata\s*:/i.test(line))
      .slice(-12)
      .join("\n");

    const stdoutDetails = stdoutLines
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !this.isTechnicalLine(line))
      .filter((line) => !/^launch_metadata\s*:/i.test(line))
      .slice(-12)
      .join("\n");

    if (stderrDetails && stdoutDetails) {
      return `Hermes CLI 退出码 ${exitCode ?? "unknown"}：\n--- stderr ---\n${stderrDetails}\n--- stdout ---\n${stdoutDetails}`;
    }
    if (stderrDetails) {
      return `Hermes CLI 退出码 ${exitCode ?? "unknown"}：\n${stderrDetails}`;
    }
    if (stdoutDetails) {
      return `Hermes CLI 退出码 ${exitCode ?? "unknown"}（stderr 为空）：\n${stdoutDetails}`;
    }
    return `Hermes CLI 退出码 ${exitCode ?? "unknown"}（无输出，请检查模型配置与网络环境）`;
  }

  private async cleanReply(lines: string[], startedAt: number, streamReplyLines: string[] = []) {
    const directReply = this.extractDirectReply(lines);
    const streamReply = this.normalizeReply(streamReplyLines.join("\n"));
    const sessionId = this.extractSessionId(lines);
    const sessionReply = sessionId ? await this.readSessionReplyWithRetry(sessionId) : "";
    const newestSessionReply = sessionReply ? "" : await this.readNewestSessionReply(startedAt);

    return this.pickBestReply([
      sessionReply,
      newestSessionReply,
      streamReply,
      directReply,
    ]);
  }

  private extractDirectReply(lines: string[]) {
    return this.extractHeadlessReply(lines) || this.normalizeReply(lines.join("\n"));
  }

  private extractHeadlessReply(lines: string[]) {
    const start = lines.findIndex((line) => line.trim() === HEADLESS_RESULT_START);
    if (start < 0) {
      return "";
    }
    const end = lines.findIndex((line, index) => index > start && line.trim() === HEADLESS_RESULT_END);
    const slice = lines.slice(start + 1, end > start ? end : undefined).join("\n").trim();
    return slice;
  }

  private pickBestReply(candidates: Array<string | undefined>) {
    const normalized = candidates
      .map((item) => item?.trim() ?? "")
      .filter(Boolean)
      .map((item) => this.normalizeReply(item))
      .filter(Boolean);

    if (normalized.length === 0) {
      return "";
    }

    return normalized.sort((left, right) => {
      const bySessionLikeSignal = Number(this.looksLikeFinalReply(right)) - Number(this.looksLikeFinalReply(left));
      if (bySessionLikeSignal !== 0) return bySessionLikeSignal;
      const byLength = right.length - left.length;
      if (byLength !== 0) return byLength;
      return right.localeCompare(left);
    })[0] ?? "";
  }

  private normalizeReply(reply: string) {
    return reply
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() && !this.isTechnicalLine(line))
      .join("\n")
      .trim();
  }

  private looksLikeFinalReply(reply: string) {
    const lines = reply.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return false;
    if (lines.length >= 2) return true;
    return /[。！？.!?]$/.test(lines[0]);
  }


  private extractSessionId(lines: string[]) {
    for (const line of lines) {
      const match = line.match(/session_id\s*:\s*([A-Za-z0-9_-]+)/i)
        ?? extractHermesCliLifecycleSessionId(line);
      if (typeof match === "string") {
        return match;
      }
      if (match?.[1]) {
        return match[1];
      }
    }
    return undefined;
  }

  private async readSessionReplyWithRetry(sessionId: string) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const reply = await this.readSessionReply(sessionId);
      if (reply) {
        return reply;
      }
      await this.sleep(160);
    }
    return "";
  }

  private async readSessionReply(sessionId: string) {
    const sessionPath = path.join(os.homedir(), ".hermes", "sessions", `session_${sessionId}.json`);
    const raw = await fs.readFile(sessionPath, "utf8").catch(() => "");
    if (!raw) {
      return "";
    }
    try {
      const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }> };
      const message = [...(parsed.messages ?? [])]
        .reverse()
        .find((item) => item.role === "assistant" && typeof item.content === "string" && item.content.trim() && !this.isTechnicalLine(item.content));
      return typeof message?.content === "string" ? message.content.trim() : "";
    } catch {
      return "";
    }
  }

  private async readNewestSessionReply(startedAt: number) {
    const sessionDir = path.join(os.homedir(), ".hermes", "sessions");
    const entries = await fs.readdir(sessionDir).catch(() => []);
    const candidates = await Promise.all(
      entries
        .filter((name) => /^session_.+\.json$/i.test(name))
        .map(async (name) => {
          const filePath = path.join(sessionDir, name);
          const stat = await fs.stat(filePath).catch(() => undefined);
          return stat ? { name, mtimeMs: stat.mtimeMs } : undefined;
        }),
    );
    const recent = candidates
      .filter((item): item is { name: string; mtimeMs: number } => item !== undefined && item.mtimeMs >= startedAt - 10_000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!recent) {
      return "";
    }
    const sessionId = recent.name.replace(/^session_/, "").replace(/\.json$/i, "");
    return await this.readSessionReplyWithRetry(sessionId);
  }

  private isTechnicalLine(line: string) {
    const text = line.trim();
    return (
      !text ||
      /^session_id\s*:/i.test(text) ||
      /^估算\s*token\s*:/i.test(text) ||
      /^token\s*:/i.test(text) ||
      /^usage\s*:/i.test(text) ||
      /^trace\s*:/i.test(text) ||
      /^debug\s*:/i.test(text) ||
      /^launch_metadata\s*:/i.test(text) ||
      /^任务完成[：:]/i.test(text) ||
      /^hermes\s*任务完成/i.test(text) ||
      isHermesCliLifecycleLine(text) ||
      text === HEADLESS_RESULT_START ||
      text === HEADLESS_RESULT_END ||
      /^任务完成[：:]/i.test(text) ||
      this.isEnvironmentDumpLine(text)
    );
  }

  private isEnvironmentDumpLine(text: string) {
    return /^(?:SHELL|WSL2_GUI_APPS_ENABLED|WSL_DISTRO_NAME|NAME|PWD|LOGNAME|HOME|LANG|WSL_INTEROP|WAYLAND_DISPLAY|TERM|USER|DISPLAY|SHLVL|XDG_RUNTIME_DIR|WSLENV|PATH|OLDPWD|_|PYTHONPATH|PYTHONUTF8|PYTHONIOENCODING|HERMES_HOME|OPENAI_MODEL|HERMES_WINDOWS_[A-Z_]+|HERMES_FORGE_[A-Z_]+)=/.test(text);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async activeHermesHome() {
    return await resolveActiveHermesHome(this.appPaths.hermesDir());
  }

  private async currentMemoryDir() {
    return path.join(await this.activeHermesHome(), "memories");
  }

  private launchMetadataDir() {
    return path.join(this.appPaths.baseDir(), "tmp", "hermes-launch-metadata");
  }

  private async hermesEnv(rootPath: string, runtime: HermesRuntimeConfig, request?: EngineRunRequest): Promise<NodeJS.ProcessEnv> {
    const hermesHome = await this.activeHermesHome();
    const env = {
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: runtime.mode === "wsl"
        ? [rootPath, process.env.PYTHONPATH ? toWslPath(process.env.PYTHONPATH) : ""].filter(Boolean).join(":")
        : `${rootPath}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: runtime.mode === "wsl" ? process.env.TERM ?? "xterm-256color" : "dumb",
      CI: runtime.mode === "wsl" ? process.env.CI ?? "" : "1",
      PROMPT_TOOLKIT_NO_CPR: "1",
      PROMPT_TOOLKIT_COLOR_DEPTH: "DEPTH_1_BIT",
      HERMES_HOME: runtime.mode === "wsl" ? toWslPath(hermesHome) : hermesHome,
      ...(request?.runtimeEnv ? {
        HERMES_INFERENCE_PROVIDER: this.hermesProvider(request.runtimeEnv.provider, request.runtimeEnv.sourceType),
        OPENAI_MODEL: request.runtimeEnv.model,
      } : {}),
      ...(request?.runtimeEnv?.model ? { OPENAI_MODEL: request.runtimeEnv.model } : {}),
      ...(request?.runtimeEnv?.env ?? {}),
    };
    return env;
  }

  private hermesProvider(provider: string, sourceType?: string) {
    return resolveHermesProvider({ provider, sourceType });
  }

  private hostFromUrl(url: string) {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }

  private rewriteLocalhostModelUrls(env: NodeJS.ProcessEnv, host: string): NodeJS.ProcessEnv {
    const rewritten = { ...env };
    for (const key of ["AI_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"] as const) {
      const value = rewritten[key];
      if (typeof value !== "string") continue;
      rewritten[key] = this.rewriteLocalhostUrl(value, host);
    }
    return rewritten;
  }

  private rewriteLocalhostUrl(value: string, host: string) {
    try {
      const url = new URL(value);
      if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        url.hostname = host;
      }
      return url.toString().replace(/\/$/, "");
    } catch {
      return value;
    }
  }

  private async launchSpec(
    runtime: HermesRuntimeConfig,
    rootPath: string,
    pythonArgs: string[],
    cwd: string,
    request?: EngineRunRequest,
    extraEnv?: NodeJS.ProcessEnv,
  ) {
    const env = {
      ...await this.hermesEnv(rootPath, runtime, request),
      ...(extraEnv ?? {}),
    };
    const adapter = this.runtimeAdapter(runtime);
    if (adapter) {
      return adapter.buildHermesLaunch({
        runtime,
        rootPath,
        pythonArgs,
        cwd,
        env,
      });
    }
    if (runtime.mode !== "wsl") {
      const python = await this.windowsPythonSpec(rootPath, this.hermesCliPath(rootPath, runtime), env);
      return {
        command: python.command,
        args: [...python.argsPrefix, ...pythonArgs],
        cwd,
        env,
        detached: false,
      };
    }
    const linuxCwd = toWslPath(cwd);
    return {
      command: "wsl.exe",
      args: [
        ...this.wslDistroArgs(runtime),
        "--cd",
        linuxCwd,
        "env",
        ...this.envArgs(env),
        runtime.pythonCommand?.trim() || "python3",
        ...pythonArgs,
      ],
      cwd: process.cwd(),
      env: process.env,
      detached: false,
    };
  }

  private async commandSpec(runtime: HermesRuntimeConfig, rootPath: string, commandArgs: string[]) {
    if (runtime.mode !== "wsl") {
      const [command, ...args] = commandArgs;
      return { command, args, cwd: rootPath, env: process.env };
    }
    return {
      command: "wsl.exe",
      args: [...this.wslDistroArgs(runtime), "--cd", rootPath, ...commandArgs],
      cwd: process.cwd(),
      env: process.env,
    };
  }

  private runtimeAdapter(runtime: HermesRuntimeConfig) {
    return this.runtimeAdapterFactory?.(runtime);
  }

  private async windowsPythonSpec(rootPath: string, cliPath: string, env: NodeJS.ProcessEnv) {
    this.windowsPython ??= this.detectWindowsPython(rootPath, cliPath, env);
    return await this.windowsPython;
  }

  private async detectWindowsPython(rootPath: string, cliPath: string, env: NodeJS.ProcessEnv) {
    const candidates: Array<{ command: string; argsPrefix: string[] }> = [
      { command: "python", argsPrefix: [] },
      { command: "py", argsPrefix: ["-3"] },
    ];
    let lastError = "";
    for (const candidate of candidates) {
      const result = await runCommand(candidate.command, [...candidate.argsPrefix, cliPath, "--version"], {
        cwd: rootPath,
        timeoutMs: 20_000,
        env,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode === 0 && /Hermes Agent/i.test(output)) {
        return candidate;
      }
      lastError = `${candidate.command} ${candidate.argsPrefix.join(" ")} ${cliPath} --version failed: ${output.trim() || `exit ${result.exitCode ?? "unknown"}`}`;
    }
    return { command: "python", argsPrefix: [], lastError };
  }

  private wslDistroArgs(runtime: HermesRuntimeConfig) {
    return runtime.distro?.trim() ? ["-d", runtime.distro.trim()] : [];
  }

  private envArgs(env: NodeJS.ProcessEnv) {
    return Object.entries(sanitizeEnvForWsl(env))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => `${key}=${value}`);
  }

  private async hermesRuntime(): Promise<HermesRuntimeConfig> {
    const config = await this.readRuntimeConfig?.().catch(() => undefined);
    return {
      mode: config?.hermesRuntime?.mode ?? "windows",
      distro: config?.hermesRuntime?.distro?.trim() || undefined,
      pythonCommand: config?.hermesRuntime?.pythonCommand?.trim() || "python3",
      windowsAgentMode: config?.hermesRuntime?.windowsAgentMode ?? "hermes_native",
      cliPermissionMode: config?.hermesRuntime?.cliPermissionMode ?? "yolo",
      permissionPolicy: config?.hermesRuntime?.permissionPolicy ?? "bridge_guarded",
    };
  }

  private async normalizeRootPath(rootPath: string, runtime: HermesRuntimeConfig) {
    return this.runtimeAdapter(runtime)?.toRuntimePath(rootPath) ?? (runtime.mode === "wsl" ? toWslPath(rootPath) : rootPath);
  }

  private hermesCliPath(rootPath: string, runtime: HermesRuntimeConfig) {
    return runtime.mode === "wsl"
      ? `${rootPath.replace(/\/+$/, "")}/hermes`
      : path.join(rootPath, "hermes");
  }

  private async rootPath() {
    return await this.resolveRootPath();
  }

  private async exists(filePath: string) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

export function toWslPath(inputPath: string) {
  return runtimeToWslPath(inputPath);
}

function sanitizeStringEnv(env: NodeJS.ProcessEnv) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      next[key] = value;
    }
  }
  return next;
}

async function quarantineInvalidJson(filePath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.rename(filePath, `${filePath}.invalid.${timestamp}`).catch(() => undefined);
}
