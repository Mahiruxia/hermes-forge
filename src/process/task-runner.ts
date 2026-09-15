import { BrowserWindow } from "electron";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeEnvResolver } from "../main/runtime-env-resolver";
import type { SessionLog } from "../main/session-log";
import type { SessionAgentInsightService } from "../main/session-agent-insight-service";
import type { WorkSessionService } from "../main/work-session-service";
import type { SnapshotManager } from "./snapshot-manager";
import type { TaskPreflightService } from "./task-preflight-service";
import type { WorkspaceLock } from "./workspace-lock";
import { IpcChannels } from "../shared/ipc";
import { extractInlineLocalFilePaths, normalizeLocalFilePathKey } from "../shared/local-file-paths";
import { estimateTextTokens } from "../shared/token-estimator";
import { resolveEnginePermissions } from "../shared/types";
import { deriveTaskEvents } from "./task-derived-event-parser";
import { createTaskUsageState, trackTaskUsage, type TaskUsageState } from "./task-usage-meter";
import type {
  AppError,
  ContextBundle,
  ContextRequest,
  EngineEvent,
  EngineInteractionRequest,
  EngineInteractionResponse,
  EngineRuntimeEnv,
  EngineRunRequest,
  RuntimeConfig,
  SessionAttachment,
  StartTaskInput,
  TaskEventEnvelope,
  TaskStartResult,
  WorkSession,
} from "../shared/types";

const now = () => new Date().toISOString();
const MAX_INLINE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const FULL_SNAPSHOT_MAX_FILES = 600;
const FULL_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
const HERMES_WAIT_NOTICES = [
  { afterMs: 3_500, message: "Hermes 已启动，正在等待首段输出。" },
  { afterMs: 10_000, message: "Hermes 仍在运行，但暂时还没有返回可显示正文。" },
  { afterMs: 25_000, message: "Hermes 本轮等待时间偏长，建议检查本地 CLI、模型配置或网络连通性。" },
];

export function resolveHermesConversationIdForRuntime(input: {
  workSessionId: string;
  workSession?: Pick<WorkSession, "hermesSessionId" | "model">;
  runtimeEnv: Pick<EngineRuntimeEnv, "profileId" | "provider" | "model" | "baseUrl" | "sourceType">;
}) {
  const currentModel = normalizeModelName(input.runtimeEnv.model);
  const previousModel = normalizeModelName(input.workSession?.model);
  if (currentModel && previousModel && currentModel !== previousModel) {
    const identity = [
      input.workSession?.hermesSessionId || input.workSessionId,
      input.runtimeEnv.profileId,
      input.runtimeEnv.provider,
      input.runtimeEnv.model,
      input.runtimeEnv.baseUrl ?? "",
      input.runtimeEnv.sourceType ?? "",
    ].join("|");
    const suffix = crypto.createHash("sha1").update(identity).digest("hex").slice(0, 10);
    return `${input.workSessionId}-model-${suffix}`;
  }
  return input.workSession?.hermesSessionId || input.workSessionId;
}

function normalizeModelName(model: string | undefined) {
  return model?.trim().toLowerCase() ?? "";
}

export type TaskInteractionHandler = (
  request: EngineInteractionRequest,
  context: {
    signal: AbortSignal;
    workSessionId?: string;
    workspaceId: string;
    publish: (event: EngineEvent) => Promise<void>;
  },
) => Promise<EngineInteractionResponse>;

export class TaskRunner {
  private readonly running = new Map<string, AbortController>();
  private readonly runSessions = new Map<string, string>();
  private readonly usage = new Map<string, TaskUsageState>();
  private readonly metrics = new Map<string, { startedAt: number; preflightMs?: number; contextMs?: number; firstOutputMs?: number }>();
  private readonly lastUsagePublishAt = new Map<string, number>();
  private readonly streamingLifecyclePublished = new Set<string>();
  private readonly lastEventAt = new Map<string, number>();
  private readonly waitNoticeTimers = new Map<string, NodeJS.Timeout[]>();

  constructor(
    private readonly appPaths: AppPaths,
    private readonly workspaceLock: WorkspaceLock,
    private readonly snapshotManager: SnapshotManager,
    private readonly preflightService: TaskPreflightService,
    private readonly runtimeEnvResolver: RuntimeEnvResolver,
    private readonly hermesAdapter: EngineAdapter,
    private readonly sessionLog: SessionLog,
    private readonly sessionAgentInsightService: SessionAgentInsightService,
    private readonly getMainWindow: () => BrowserWindow | undefined,
    private readonly workSessionService?: WorkSessionService,
    private readonly interactionHandler?: TaskInteractionHandler,
  ) {}

  private cliOwnedContextBundle(workspaceId: string): ContextBundle {
    return {
      id: `cli-${Date.now()}`,
      workspaceId,
      policy: "isolated",
      readonly: true,
      maxCharacters: 0,
      usedCharacters: 0,
      sources: [],
      summary: "Windows 原生模式：Hermes 自行管理记忆与上下文。",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async start(input: StartTaskInput): Promise<TaskStartResult> {
    const taskRunId = input.clientTaskId?.trim() || crypto.randomUUID();
    if (this.runSessions.has(taskRunId)) throw new Error("任务已在启动或运行中。");
    this.runSessions.set(taskRunId, input.sessionId?.trim() || input.sessionFilesPath);
    const controller = new AbortController();
    this.running.set(taskRunId, controller);
    try {
      return await this.startInternal({ ...input, clientTaskId: taskRunId }, controller);
    } catch (error) {
      this.runSessions.delete(taskRunId);
      this.running.delete(taskRunId);
      this.metrics.delete(taskRunId);
      throw error;
    }
  }

  private async startInternal(input: StartTaskInput, controller: AbortController): Promise<TaskStartResult> {
    const startAt = Date.now();
    const targetPath = input.workspacePath?.trim() || input.sessionFilesPath;
    const workspaceId = await this.appPaths.ensureWorkspaceLayout(targetPath);
    controller.signal.throwIfAborted();
    const workSessionId = input.sessionId?.trim() || input.sessionFilesPath;
    const taskRunId = input.clientTaskId?.trim() || crypto.randomUUID();
    const actualEngine = "hermes" as const;
    const attachments = await resolveInlineFileAttachments(input.userInput, input.attachments ?? []);
    controller.signal.throwIfAborted();
    this.metrics.set(taskRunId, { startedAt: startAt });

    await this.publishStage(workspaceId, workSessionId, taskRunId, actualEngine, "preflight", "正在执行 Hermes 运行前检查。");
    await this.publishStep(workspaceId, workSessionId, taskRunId, actualEngine, "stage-preflight-entered", false, "已进入 Hermes 运行前检查阶段。");

    const preflightAt = Date.now();
    await this.preflightService.assertCanStart(input, actualEngine, workspaceId);
    controller.signal.throwIfAborted();
    await this.publishStep(workspaceId, workSessionId, taskRunId, actualEngine, "preflight-complete", true, `Hermes 运行前检查通过，耗时 ${Date.now() - preflightAt}ms。`);
    this.metrics.get(taskRunId)!.preflightMs = Date.now() - preflightAt;

    const contextRequest: ContextRequest = {
      workspaceId,
      workspacePath: targetPath,
      userInput: input.userInput,
      taskType: input.taskType,
      memoryPolicy: "isolated",
    };
    await this.publishStep(workspaceId, workSessionId, taskRunId, actualEngine, "stage-context-entered", false, "已进入 Hermes 上下文准备阶段。");
    const contextAt = Date.now();
    const [runtimeEnv, runtimeConfig] = await Promise.all([
      this.runtimeEnvResolver.resolve(input.modelProfileId),
      this.runtimeEnvResolver.readConfig(),
    ]);
    controller.signal.throwIfAborted();
    const runtimeMode = runtimeConfig.hermesRuntime?.mode ?? "windows";
    // Windows / WSL 统一让 Hermes 自己管理上下文与记忆，Forge 不再注入。
    const contextBundle = this.cliOwnedContextBundle(workspaceId);
    await this.publishStep(
      workspaceId,
      workSessionId,
      taskRunId,
      actualEngine,
      "context-complete",
      true,
      `Hermes 将自行处理 session/memory，上下文预注入已关闭，耗时 ${Date.now() - contextAt}ms。`,
    );
    this.metrics.get(taskRunId)!.contextMs = Date.now() - contextAt;

    const permissions = resolveEnginePermissions(runtimeConfig, actualEngine);
    const workSession = await this.workSessionService?.read(workSessionId).catch(() => undefined);
    controller.signal.throwIfAborted();
    const hermesSessionId = resolveHermesConversationIdForRuntime({ workSessionId, workSession, runtimeEnv });
    void this.sessionAgentInsightService.recordTaskStart({
      sessionId: workSessionId,
      taskRunId,
      runtimeConfig,
      runtimeEnv,
      contextBundle,
      updatedAt: now(),
    }).catch((error) => {
      console.warn("[Hermes Forge] Failed to record session insight on task start:", error);
    });
    const sessionId = taskRunId;
    const lock = this.workspaceLock.acquire(workspaceId, sessionId, {
      engineId: actualEngine,
      taskType: input.taskType,
      lockedPaths: input.selectedFiles,
    });
    if (!lock.acquired) {
      throw new Error(lock.message);
    }

    let snapshot: Awaited<ReturnType<SnapshotManager["createSnapshot"]>>;
    try {
      const snapshotMode = this.snapshotMode(input);
      await this.publishStage(
        workspaceId,
        workSessionId,
        sessionId,
        actualEngine,
        "snapshot",
        snapshotMode === "scoped"
          ? `正在为 ${input.selectedFiles.length} 个已选文件建立 Hermes 任务前快照。`
          : snapshotMode === "manifest"
            ? "只读/轻量任务跳过全量文件复制，正在记录 Hermes 快照清单。"
            : "正在建立 Hermes 任务前全量快照。",
      );
      await this.publishStep(workspaceId, workSessionId, sessionId, actualEngine, "stage-snapshot-entered", false, "已进入 Hermes 快照建立阶段。");
      const snapshotAt = Date.now();
      snapshot = await this.snapshotManager.createSnapshot(workspaceId, targetPath, sessionId, {
        workSessionId,
        markLatest: snapshotMode !== "manifest",
        manifestOnly: snapshotMode === "manifest",
        scopedPaths: input.selectedFiles,
        ...(snapshotMode === "full" ? {
          maxFiles: FULL_SNAPSHOT_MAX_FILES,
          maxBytes: FULL_SNAPSHOT_MAX_BYTES,
        } : {}),
      });
      controller.signal.throwIfAborted();
      await this.publishStep(
        workspaceId,
        workSessionId,
        sessionId,
        actualEngine,
        "snapshot-complete",
        true,
        snapshotMode === "manifest"
          ? `已记录 Hermes 快照清单，未复制工作区文件，耗时 ${Date.now() - snapshotAt}ms。`
          : `${this.snapshotCompleteMessage(snapshot)}，耗时 ${Date.now() - snapshotAt}ms。`,
      );
      controller.signal.throwIfAborted();
    } catch (error) {
      this.workspaceLock.release(workspaceId, sessionId);
      throw new Error(`建立 Hermes 写前快照失败：${error instanceof Error ? error.message : "未知错误"}`);
    }

    this.usage.set(
      sessionId,
      createTaskUsageState(
        this.initialInputTokens(input, contextBundle),
        runtimeEnv,
        runtimeConfig,
      ),
    );

    const runRequest: EngineRunRequest = {
      sessionId,
      conversationId: hermesSessionId,
      conversationHistory: runtimeMode === "wsl" ? [] : input.conversationHistory ?? [],
      workspaceId,
      workspacePath: targetPath,
      userInput: input.userInput,
      taskType: input.taskType,
      selectedFiles: input.selectedFiles,
      attachments,
      memoryPolicy: "isolated",
      modelProfileId: input.modelProfileId,
      runtimeEnv: { ...runtimeEnv, executionMode: "local_fast" },
      contextBundle,
      permissions,
      onInteraction: this.interactionHandler ? (interaction, signal) => {
        if (interaction.taskRunId !== taskRunId || this.running.get(taskRunId) !== controller || signal.aborted) {
          throw new Error("交互请求不属于当前运行任务。");
        }
        return this.interactionHandler!(interaction, {
          signal,
          workSessionId,
          workspaceId,
          publish: (event) => this.publish(workspaceId, workSessionId, taskRunId, actualEngine, event),
        });
      } : undefined,
    };

    void this.consumeRun(runRequest, controller, workSessionId);
    await this.publishStep(workspaceId, workSessionId, sessionId, actualEngine, "runner-dispatched", true, `任务已交给 Hermes，启动链路总耗时 ${Date.now() - startAt}ms。`);

    return {
      taskRunId: sessionId,
      workSessionId,
      workspaceId,
      contextBundle,
      snapshotId: snapshot.snapshotId,
      runtime: {
        engineId: actualEngine,
        runtimeMode: "local_fast",
        providerId: runtimeEnv.provider,
        modelId: runtimeEnv.model,
      },
    };
  }

  async cancel(sessionId: string) {
    const controller = this.running.get(sessionId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  isRunning(sessionId: string) {
    return this.running.has(sessionId);
  }

  isWorkSessionRunning(workSessionId: string) {
    return [...this.runSessions.values()].includes(workSessionId);
  }

  listRunningSessionIds() {
    return [...new Set([...this.runSessions.keys(), ...this.running.keys()])];
  }

  async shutdown(reason = "shutdown", timeoutMs = 5000) {
    for (const [sessionId, controller] of this.running) {
      console.info("[Hermes Forge] Aborting active task during shutdown:", { sessionId, reason });
      controller.abort();
    }
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.running.size > 0) {
      const residual = [...this.running.keys()];
      throw new Error(`TaskRunner shutdown timed out; residual tasks: ${residual.join(", ")}`);
    }
  }

  private snapshotMode(input: StartTaskInput): "scoped" | "full" | "manifest" {
    if (input.selectedFiles.length > 0) {
      return "scoped";
    }
    if (input.taskType === "fix_error" || input.taskType === "generate_web" || input.taskType === "organize_files") {
      return "full";
    }
    return "manifest";
  }

  private snapshotCompleteMessage(snapshot: Awaited<ReturnType<SnapshotManager["createSnapshot"]>>) {
    const copiedBytes = snapshot.copiedBytes ? `，约 ${this.formatBytes(snapshot.copiedBytes)}` : "";
    if (snapshot.truncated) {
      return `Hermes 任务前快照已按预算建立，复制 ${snapshot.copiedFiles} 个文件${copiedBytes}，跳过 ${snapshot.skippedFiles} 项；${snapshot.limitReason ?? "已停止继续复制大工作区"}`;
    }
    return `Hermes 任务前快照已建立，复制 ${snapshot.copiedFiles} 个文件${copiedBytes}`;
  }

  private formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    const kib = bytes / 1024;
    if (kib < 1024) return `${Math.round(kib)}KB`;
    return `${Math.round(kib / 1024)}MB`;
  }

  private async consumeRun(request: EngineRunRequest, controller: AbortController, workSessionId?: string) {
    const adapterStartedAt = Date.now();
    const actualEngine = "hermes" as const;
    let bufferedMessageChunk = "";
    let bufferedMessageAt = "";
    let lastMessageFlushAt = 0;
    let terminalResult: Extract<EngineEvent, { type: "result" }> | undefined;
    const flushMessageChunk = async () => {
      if (!bufferedMessageChunk) return;
      const event: EngineEvent = {
        type: "message_chunk",
        content: bufferedMessageChunk,
        at: bufferedMessageAt || now(),
      };
      bufferedMessageChunk = "";
      bufferedMessageAt = "";
      lastMessageFlushAt = Date.now();
      await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, event);
    };
    try {
      await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, "running", "Hermes 已接手任务。");
      await this.publishStep(request.workspaceId, workSessionId, request.sessionId, actualEngine, "stage-running-entered", false, "已进入 Hermes 执行阶段。");
      await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        type: "status",
        level: "info",
        message: "已锁定工作区并建立写前快照。任务期间不会允许另一个写入任务同时修改同一目录。",
        at: now(),
      });
      await this.publishUsage(request.workspaceId, workSessionId, request.sessionId, actualEngine);
      this.startWaitNotices(request, controller, workSessionId);

      for await (const event of this.hermesAdapter.run(request, controller.signal)) {
        this.captureFirstOutputMetric(request.sessionId, event);
        if (event.type === "result") {
          if (!terminalResult || terminalResult.success) terminalResult = event;
          continue;
        }
        // The runner owns terminal state; an adapter lifecycle frame is not process completion.
        if (event.type === "lifecycle" && ["completed", "failed", "cancelled"].includes(event.stage)) continue;
        if (event.type === "message_chunk") {
          if (!this.streamingLifecyclePublished.has(request.sessionId)) {
            this.streamingLifecyclePublished.add(request.sessionId);
            await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, "streaming", "正在接收 Hermes 流式输出。");
          }
          bufferedMessageChunk += event.content;
          bufferedMessageAt ||= event.at;
          if (Date.now() - lastMessageFlushAt >= 80 || bufferedMessageChunk.length >= 600) {
            await flushMessageChunk();
          }
          continue;
        }
        await flushMessageChunk();
        if (event.type === "session_update" && workSessionId) {
          await this.workSessionService?.syncHermesSession(workSessionId, {
            hermesSessionId: event.hermesSessionId,
            parentHermesSessionId: event.previousHermesSessionId,
            title: event.title,
            messageCount: event.messageCount,
            model: event.model,
          }).catch((error) => {
            console.warn("[Hermes Forge] Failed to sync official Hermes session:", error);
          });
        }
        if ((event.type === "stdout" || event.type === "stderr") && !this.streamingLifecyclePublished.has(request.sessionId)) {
          this.streamingLifecyclePublished.add(request.sessionId);
          await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, "streaming", "正在接收 Hermes 流式输出。");
        }
        await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, event);
      }
      await flushMessageChunk();
      if (!terminalResult && !controller.signal.aborted) throw new Error("Hermes 未返回完整执行结果。");
      const outcome = controller.signal.aborted || terminalResult?.outcome === "cancelled"
        ? "cancelled" : terminalResult?.success ? "completed" : "failed";
      const finalResult: Extract<EngineEvent, { type: "result" }> = outcome === "cancelled"
        ? { type: "result", success: false, outcome, title: "任务已取消", detail: "任务已取消。", at: now() }
        : { ...terminalResult!, outcome };
      await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, finalResult);
      await this.publishStep(request.workspaceId, workSessionId, request.sessionId, actualEngine, "adapter-complete", true, `Hermes 适配器完成，耗时 ${Date.now() - adapterStartedAt}ms。`);
      await this.publishTaskMetrics(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        adapterMs: Date.now() - adapterStartedAt,
        outcome,
      });
      if (workSessionId) {
        await this.sessionAgentInsightService.recordTaskTerminal({
          sessionId: workSessionId,
          taskRunId: request.sessionId,
          status: outcome === "completed" ? "complete" : outcome,
          updatedAt: now(),
        }).catch((error) => {
          console.warn("[Hermes Forge] Failed to record session insight terminal state:", error);
        });
      }
      await this.publishUsage(request.workspaceId, workSessionId, request.sessionId, actualEngine, true);
      await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, outcome,
        outcome === "completed" ? "Hermes 任务已完成。" : outcome === "cancelled" ? "Hermes 任务已取消。" : "Hermes 任务执行失败。");
    } catch (error) {
      await flushMessageChunk();
      const failure = this.classifyFailure(error, controller.signal.aborted);
      await this.publishTaskMetrics(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        adapterMs: Date.now() - adapterStartedAt,
        outcome: controller.signal.aborted ? "cancelled" : "failed",
      });
      await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        type: "diagnostic",
        category: failure.category,
        message: failure.message,
        at: now(),
      });
      await this.publishStage(
        request.workspaceId,
        workSessionId,
        request.sessionId,
        actualEngine,
        controller.signal.aborted ? "cancelled" : "failed",
        controller.signal.aborted ? "Hermes 任务已取消。" : failure.stageMessage,
      );
      await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        type: "result",
        success: false,
        outcome: controller.signal.aborted ? "cancelled" : "failed",
        title: controller.signal.aborted ? "任务已取消" : failure.title,
        detail: failure.message,
        at: now(),
      });
      if (workSessionId) {
        await this.sessionAgentInsightService.recordTaskTerminal({
          sessionId: workSessionId,
          taskRunId: request.sessionId,
          status: controller.signal.aborted ? "cancelled" : "failed",
          updatedAt: now(),
        }).catch((insightError) => {
          console.warn("[Hermes Forge] Failed to record session insight terminal failure:", insightError);
        });
      }
    } finally {
      this.stopWaitNotices(request.sessionId);
      this.running.delete(request.sessionId);
      this.runSessions.delete(request.sessionId);
      this.usage.delete(request.sessionId);
      this.lastUsagePublishAt.delete(request.sessionId);
      this.metrics.delete(request.sessionId);
      this.streamingLifecyclePublished.delete(request.sessionId);
      this.lastEventAt.delete(request.sessionId);
      this.workspaceLock.release(request.workspaceId, request.sessionId);
    }
  }

  private classifyFailure(error: unknown, aborted: boolean) {
    if (aborted) {
      return {
        category: "task-cancelled",
        title: "任务已取消",
        message: "本轮 Hermes 任务已按请求取消。可在确认上下文仍然有效后重新发起。",
        stageMessage: "Hermes 任务已取消。",
        retryable: true,
      };
    }

    const appError = this.extractAppError(error);
    if (appError) {
      const retryable = appError.code === "WORKSPACE_LOCKED";
      return {
        category: `app-error:${appError.code}`,
        title: appError.title,
        message: `${appError.message}${retryable ? " 建议在锁释放后重试。" : " 建议先修复配置或环境问题，再重试。"}`,
        stageMessage: `${appError.title}：${appError.message}`,
        retryable,
      };
    }

    const message = error instanceof Error ? error.message : "未知错误";
    if (/NoConsoleScreenBufferError|No Windows console found|prompt_toolkit\.output\.win32|控制台初始化失败/i.test(message)) {
      return {
        category: "cli-console-missing",
        title: "Hermes CLI 在 Windows 原生模式下无法初始化控制台",
        message: "Hermes CLI 在 Windows 原生模式下无法初始化控制台。这通常与 Python prompt_toolkit 或 Windows 终端环境有关，并不是模型或密钥配置错误。建议：1) 在「设置 > Hermes 运行环境」中切换到 WSL 模式；2) 或确保从标准 Windows Terminal / CMD 启动 Forge。",
        stageMessage: `Hermes CLI 控制台初始化失败：${message}`,
        retryable: true,
      };
    }
    if (/退出码/i.test(message)) {
      return {
        category: "cli-failed",
        title: "Hermes CLI 执行失败",
        message: `${message}。建议先检查 Hermes CLI、模型配置与工作区上下文后再重试。`,
        stageMessage: `Hermes CLI 执行失败：${message}`,
        retryable: true,
      };
    }
    if (/timeout|超时|未完成/i.test(message)) {
      return {
        category: "timeout",
        title: "Hermes 执行超时",
        message: `${message}。建议缩小任务范围、减少上下文或稍后重试。`,
        stageMessage: `Hermes 执行超时：${message}`,
        retryable: true,
      };
    }
    return {
      category: "unknown-failure",
      title: "Hermes 任务失败",
      message: `${message}。可尝试重新执行；若重复出现，建议导出诊断信息后排查。`,
      stageMessage: `Hermes 任务失败：${message}`,
      retryable: true,
    };
  }

  private extractAppError(error: unknown): AppError | undefined {
    if (!(error instanceof Error)) return undefined;
    const candidate = (error as Error & { appError?: AppError }).appError;
    if (!candidate?.code || !candidate?.title || !candidate?.message) return undefined;
    return candidate;
  }

  private async publishStage(
    workspaceId: string,
    workSessionId: string | undefined,
    taskRunId: string,
    engineId: "hermes",
    stage: Extract<EngineEvent, { type: "lifecycle" }>["stage"],
    message: string,
  ) {
    await this.publish(workspaceId, workSessionId, taskRunId, engineId, {
      type: "lifecycle",
      stage,
      message,
      at: now(),
    });
  }

  private async publishStep(
    workspaceId: string,
    workSessionId: string | undefined,
    taskRunId: string,
    engineId: "hermes",
    step: string,
    done: boolean,
    message: string,
  ) {
    await this.publish(workspaceId, workSessionId, taskRunId, engineId, {
      type: "progress",
      step,
      done,
      message,
      at: now(),
    });
  }

  private async publish(workspaceId: string, workSessionId: string | undefined, taskRunId: string, engineId: "hermes", event: EngineEvent) {
    this.lastEventAt.set(taskRunId, Date.now());
    this.trackUsage(taskRunId, event);
    const envelope: TaskEventEnvelope = { taskRunId, workSessionId, sessionId: taskRunId, engineId, event };
    const safeEnvelope = this.sessionLog.redact(envelope);
    await this.sessionLog.append(workspaceId, safeEnvelope);
    this.getMainWindow()?.webContents.send(IpcChannels.taskEvent, safeEnvelope);
    await this.publishDerivedEvents(workspaceId, workSessionId, taskRunId, engineId, event);
    if (event.type === "stdout" || event.type === "stderr" || event.type === "message_chunk" || event.type === "reasoning") {
      await this.publishUsage(workspaceId, workSessionId, taskRunId, engineId);
    }
  }

  private async publishUsage(workspaceId: string, workSessionId: string | undefined, taskRunId: string, engineId: "hermes", force = false) {
    const usage = this.usage.get(taskRunId);
    if (!usage) return;
    const lastPublishedAt = this.lastUsagePublishAt.get(taskRunId) ?? 0;
    if (!force && Date.now() - lastPublishedAt < 1200) return;
    const event: EngineEvent = {
      type: "usage",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd: usage.estimatedCostUsd,
      totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      contextTokens: usage.contextTokens,
      contextWindow: usage.contextWindow,
      contextPercent: usage.contextPercent,
      source: usage.source,
      message: `${usage.source === "actual" ? "实测" : "估算"} Token：输入 ${usage.inputTokens}，输出 ${usage.outputTokens}，总计 ${usage.totalTokens ?? usage.inputTokens + usage.outputTokens}${usage.contextTokens ? `，上下文 ${usage.contextTokens}` : ""}。费用约 $${usage.estimatedCostUsd.toFixed(4)}。`,
      at: now(),
    };
    const envelope: TaskEventEnvelope = { taskRunId, workSessionId, sessionId: taskRunId, engineId, event };
    await this.sessionLog.append(workspaceId, envelope);
    this.getMainWindow()?.webContents.send(IpcChannels.taskEvent, envelope);
    if (workSessionId) {
      void this.sessionAgentInsightService.recordUsage({
        sessionId: workSessionId,
        workspaceId,
      }).catch((error) => {
        console.warn("[Hermes Forge] Failed to record session insight usage:", error);
      });
    }
    this.lastUsagePublishAt.set(taskRunId, Date.now());
  }

  private trackUsage(sessionId: string, event: EngineEvent) {
    trackTaskUsage(this.usage.get(sessionId), event, (text) => this.estimateTokens(text));
  }

  private estimateTokens(text: string) {
    return estimateTextTokens(text);
  }

  private initialInputTokens(input: StartTaskInput, contextBundle: ContextBundle) {
    const selectedFiles = input.selectedFiles.join("\n");
    const attachments = (input.attachments ?? []).map((attachment) => `${attachment.name} ${attachment.kind} ${attachment.path}`).join("\n");
    const history = (input.conversationHistory ?? []).map((entry) => `${entry.role}: ${entry.content}`).join("\n");
    return this.estimateTokens([
      input.userInput,
      contextBundle.summary,
      selectedFiles,
      attachments,
      history,
    ].filter(Boolean).join("\n"));
  }

  private captureFirstOutputMetric(sessionId: string, event: EngineEvent) {
    if (event.type !== "stdout" && event.type !== "stderr" && event.type !== "message_chunk" && event.type !== "result") return;
    const metrics = this.metrics.get(sessionId);
    if (!metrics || metrics.firstOutputMs !== undefined) return;
    metrics.firstOutputMs = Date.now() - metrics.startedAt;
  }

  private async publishTaskMetrics(
    workspaceId: string,
    workSessionId: string | undefined,
    sessionId: string,
    engineId: "hermes",
    summary: { adapterMs: number; outcome: "completed" | "failed" | "cancelled" },
  ) {
    const metrics = this.metrics.get(sessionId);
    if (!metrics) return;
    const totalMs = Date.now() - metrics.startedAt;
    const parts = [
      `总耗时 ${totalMs}ms`,
      metrics.preflightMs !== undefined ? `预检 ${metrics.preflightMs}ms` : undefined,
      metrics.contextMs !== undefined ? `上下文 ${metrics.contextMs}ms` : undefined,
      metrics.firstOutputMs !== undefined ? `首输出 ${metrics.firstOutputMs}ms` : "首输出 未收到",
      `执行 ${summary.adapterMs}ms`,
      `结果 ${summary.outcome}`,
    ].filter(Boolean);
    await this.publish(workspaceId, workSessionId, sessionId, engineId, {
      type: "diagnostic",
      category: "task-metrics",
      message: parts.join(" / "),
      durationMs: totalMs,
      at: now(),
    });
  }

  private startWaitNotices(request: EngineRunRequest, controller: AbortController, workSessionId?: string) {
    this.stopWaitNotices(request.sessionId);
    this.lastEventAt.set(request.sessionId, Date.now());
    const timers = HERMES_WAIT_NOTICES.map((notice) =>
      setTimeout(() => {
        if (!this.running.has(request.sessionId) || controller.signal.aborted) return;
        const idleMs = Date.now() - (this.lastEventAt.get(request.sessionId) ?? Date.now());
        void this.publish(request.workspaceId, workSessionId, request.sessionId, "hermes", {
          type: "progress",
          step: `hermes-wait-${notice.afterMs}`,
          done: false,
          message: `${notice.message}${idleMs > 5000 ? ` 最近 ${Math.round(idleMs / 1000)} 秒没有新输出。` : ""}`,
          at: now(),
        });
      }, notice.afterMs),
    );
    this.waitNoticeTimers.set(request.sessionId, timers);
  }

  private stopWaitNotices(sessionId: string) {
    for (const timer of this.waitNoticeTimers.get(sessionId) ?? []) {
      clearTimeout(timer);
    }
    this.waitNoticeTimers.delete(sessionId);
  }

  private async publishDerivedEvents(workspaceId: string, workSessionId: string | undefined, sessionId: string, engineId: "hermes", event: EngineEvent) {
    if (event.type !== "stdout" && event.type !== "stderr") return;
    const derivedEvents = deriveTaskEvents(event.line);
    for (const derivedEvent of derivedEvents) {
      const envelope: TaskEventEnvelope = { taskRunId: sessionId, workSessionId, sessionId, engineId, event: derivedEvent };
      await this.sessionLog.append(workspaceId, envelope);
      this.getMainWindow()?.webContents.send(IpcChannels.taskEvent, envelope);
    }
  }
}

export function extractInlineImagePaths(text: string): string[] {
  return extractInlineLocalFilePaths(text).filter(isSupportedImagePath);
}

export async function resolveInlineFileAttachments(text: string, existing: SessionAttachment[]): Promise<SessionAttachment[]> {
  const result = [...existing];
  const seen = new Set(existing.flatMap((item) => [item.path, item.originalPath]).filter(Boolean).map(normalizeLocalFilePathKey));
  for (const filePath of extractInlineLocalFilePaths(text)) {
    const key = normalizeLocalFilePathKey(filePath);
    if (seen.has(key)) {
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_INLINE_ATTACHMENT_BYTES) {
        continue;
      }
      const mimeType = mimeTypeForImagePath(filePath);
      result.push({
        id: `inline-file-${crypto.randomUUID()}`,
        name: path.basename(filePath),
        path: filePath,
        originalPath: filePath,
        kind: mimeType ? "image" : "file",
        mimeType,
        size: stat.size,
        createdAt: now(),
      });
      seen.add(key);
    } catch {
      // Keep the original text prompt intact if the path is stale or inaccessible.
    }
  }
  return result;
}

export async function resolveInlineImageAttachments(text: string, existing: SessionAttachment[]): Promise<SessionAttachment[]> {
  return (await resolveInlineFileAttachments(text, existing)).filter((attachment) => attachment.kind === "image");
}

export function mimeTypeForImagePath(imagePath: string): string | undefined {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return undefined;
}

function isSupportedImagePath(imagePath: string) {
  return mimeTypeForImagePath(imagePath) !== undefined;
}
