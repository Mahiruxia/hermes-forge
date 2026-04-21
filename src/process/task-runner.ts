import { BrowserWindow } from "electron";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "../main/app-paths";
import type { RuntimeEnvResolver } from "../main/runtime-env-resolver";
import type { SessionLog } from "../main/session-log";
import type { WindowsNativeIntentService, WindowsNativeIntentResult } from "../main/windows-native-intent-service";
import type { HermesToolLoopRunner } from "./hermes-tool-loop-runner";
import type { MemoryBroker } from "../memory/memory-broker";
import type { SnapshotManager } from "./snapshot-manager";
import type { TaskPreflightService } from "./task-preflight-service";
import type { WorkspaceLock } from "./workspace-lock";
import { IpcChannels } from "../shared/ipc";
import { resolveEnginePermissions } from "../shared/types";
import { deriveTaskEvents } from "./task-derived-event-parser";
import { createTaskUsageState, trackTaskUsage, type TaskUsageState } from "./task-usage-meter";
import type {
  AppError,
  ContextBundle,
  ContextRequest,
  EngineEvent,
  EngineRuntimeEnv,
  EngineRunRequest,
  RuntimeConfig,
  SessionAttachment,
  StartTaskInput,
  TaskEventEnvelope,
  TaskStartResult,
} from "../shared/types";

const now = () => new Date().toISOString();
const INLINE_IMAGE_PATH_PATTERN =
  /(?:"([^"\r\n]+\.(?:png|jpe?g|webp|gif|bmp))"|'([^'\r\n]+\.(?:png|jpe?g|webp|gif|bmp))'|([a-zA-Z]:\\[^\r\n"'<>|]+?\.(?:png|jpe?g|webp|gif|bmp)))/gi;
const MAX_INLINE_IMAGE_BYTES = 50 * 1024 * 1024;
const HERMES_WAIT_NOTICES = [
  { afterMs: 3_500, message: "Hermes 已启动，正在等待首段输出。" },
  { afterMs: 10_000, message: "Hermes 仍在运行，但暂时还没有返回可显示正文。" },
  { afterMs: 25_000, message: "Hermes 本轮等待时间偏长，建议检查本地 CLI、模型配置或网络连通性。" },
];

export class TaskRunner {
  private readonly running = new Map<string, AbortController>();
  private readonly usage = new Map<string, TaskUsageState>();
  private readonly metrics = new Map<string, { startedAt: number; preflightMs?: number; contextMs?: number; firstOutputMs?: number }>();
  private readonly lastUsagePublishAt = new Map<string, number>();
  private readonly streamingLifecyclePublished = new Set<string>();
  private readonly lastEventAt = new Map<string, number>();
  private readonly waitNoticeTimers = new Map<string, NodeJS.Timeout[]>();

  constructor(
    private readonly appPaths: AppPaths,
    private readonly memoryBroker: MemoryBroker,
    private readonly workspaceLock: WorkspaceLock,
    private readonly snapshotManager: SnapshotManager,
    private readonly preflightService: TaskPreflightService,
    private readonly runtimeEnvResolver: RuntimeEnvResolver,
    private readonly hermesAdapter: EngineAdapter,
    private readonly sessionLog: SessionLog,
    private readonly getMainWindow: () => BrowserWindow | undefined,
    private readonly hermesToolLoopRunner?: HermesToolLoopRunner,
    private readonly windowsNativeIntentService?: WindowsNativeIntentService,
  ) {}

  async start(input: StartTaskInput): Promise<TaskStartResult> {
    const startAt = Date.now();
    const targetPath = input.workspacePath?.trim() || input.sessionFilesPath;
    const workspaceId = await this.appPaths.ensureWorkspaceLayout(targetPath);
    const workSessionId = input.sessionId?.trim() || input.sessionFilesPath;
    const taskRunId = input.clientTaskId?.trim() || crypto.randomUUID();
    const actualEngine = "hermes" as const;
    const attachments = await resolveInlineImageAttachments(input.userInput, input.attachments ?? []);
    this.metrics.set(taskRunId, { startedAt: startAt });

    await this.publishStage(workspaceId, workSessionId, taskRunId, actualEngine, "preflight", "正在执行 Hermes 运行前检查。");
    await this.publishStep(workspaceId, workSessionId, taskRunId, actualEngine, "stage-preflight-entered", false, "已进入 Hermes 运行前检查阶段。");

    const earlyNative = await this.tryStartWindowsNativeFastPath(input, attachments, {
      startAt,
      targetPath,
      workspaceId,
      workSessionId,
      sessionId: taskRunId,
      actualEngine,
    });
    if (earlyNative) {
      return earlyNative;
    }

    const preflightAt = Date.now();
    await this.preflightService.assertCanStart(input, actualEngine, workspaceId);
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
    const [runtimeEnv, contextBundle, runtimeConfig] = await Promise.all([
      this.runtimeEnvResolver.resolve(input.modelProfileId),
      this.memoryBroker.prepareContextBundle(contextRequest),
      this.runtimeEnvResolver.readConfig(),
    ]);
    await this.publishStep(workspaceId, workSessionId, taskRunId, actualEngine, "context-complete", true, `Hermes 运行环境和 MEMORY.md 上下文已准备，耗时 ${Date.now() - contextAt}ms。`);
    this.metrics.get(taskRunId)!.contextMs = Date.now() - contextAt;

    const permissions = resolveEnginePermissions(runtimeConfig, actualEngine);
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
        markLatest: snapshotMode !== "manifest",
        manifestOnly: snapshotMode === "manifest",
        scopedPaths: input.selectedFiles,
      });
      await this.publishStep(
        workspaceId,
        workSessionId,
        sessionId,
        actualEngine,
        "snapshot-complete",
        true,
        snapshotMode === "manifest"
          ? `已记录 Hermes 快照清单，未复制工作区文件，耗时 ${Date.now() - snapshotAt}ms。`
          : `Hermes 任务前快照已建立，复制 ${snapshot.copiedFiles} 个文件，耗时 ${Date.now() - snapshotAt}ms。`,
      );
    } catch (error) {
      this.workspaceLock.release(workspaceId, sessionId);
      throw new Error(`建立 Hermes 写前快照失败：${error instanceof Error ? error.message : "未知错误"}`);
    }

    const controller = new AbortController();
    this.running.set(sessionId, controller);
    this.usage.set(
      sessionId,
      createTaskUsageState(
        this.estimateTokens(input.userInput) + this.estimateTokens(contextBundle.summary),
        runtimeEnv,
        runtimeConfig,
      ),
    );

    const runRequest: EngineRunRequest = {
      sessionId,
      conversationId: workSessionId,
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
    };

    const windowsAgentMode = runtimeConfig.hermesRuntime?.windowsAgentMode ?? "hermes_native";
    if (windowsAgentMode === "host_tool_loop" && this.hermesToolLoopRunner?.canRun()) {
      void this.consumeToolLoopRun(runRequest, controller, workSessionId);
      await this.publishStep(workspaceId, workSessionId, sessionId, actualEngine, "tool-loop-dispatched", true, `任务已交给宿主 Hermes Tool Loop fallback，启动链路总耗时 ${Date.now() - startAt}ms。`);
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

    const nativeResult = await this.windowsNativeIntentService?.tryHandle(
      runRequest,
      async (event) => this.publish(workspaceId, workSessionId, sessionId, actualEngine, event),
    );
    if (nativeResult) {
      void this.consumeNativeRun(runRequest, nativeResult, controller, workSessionId);
      await this.publishStep(workspaceId, workSessionId, sessionId, actualEngine, "windows-native-dispatched", true, `任务已交给 Windows 原生兼容执行层，启动链路总耗时 ${Date.now() - startAt}ms。`);
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

  private async consumeToolLoopRun(request: EngineRunRequest, controller: AbortController, workSessionId?: string) {
    const adapterStartedAt = Date.now();
    const actualEngine = "hermes" as const;
    try {
      await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, "running", "Hermes Tool Loop 已接手任务。");
      await this.publishStep(request.workspaceId, workSessionId, request.sessionId, actualEngine, "stage-tool-loop-entered", false, "已进入 Hermes Windows 工具循环。");
      let failedResult = false;
      for await (const event of this.hermesToolLoopRunner!.run(
        request,
        controller.signal,
        async (approvalEvent) => this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, approvalEvent),
      )) {
        this.captureFirstOutputMetric(request.sessionId, event);
        if (event.type === "result" && !event.success) {
          failedResult = true;
        }
        await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, event);
      }
      await this.publishTaskMetrics(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        adapterMs: Date.now() - adapterStartedAt,
        outcome: failedResult ? "failed" : "completed",
      });
      await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, failedResult ? "failed" : "completed", "Hermes Tool Loop 任务生命周期已完成。");
    } catch (error) {
      const failure = this.classifyFailure(error, controller.signal.aborted);
      await this.publishTaskMetrics(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        adapterMs: Date.now() - adapterStartedAt,
        outcome: controller.signal.aborted ? "cancelled" : "failed",
      });
      await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        type: "result",
        success: false,
        title: controller.signal.aborted ? "任务已取消" : failure.title,
        detail: failure.message,
        at: now(),
      });
      await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, controller.signal.aborted ? "cancelled" : "failed", failure.stageMessage);
    } finally {
      this.stopWaitNotices(request.sessionId);
      this.running.delete(request.sessionId);
      this.usage.delete(request.sessionId);
      this.lastUsagePublishAt.delete(request.sessionId);
      this.metrics.delete(request.sessionId);
      this.streamingLifecyclePublished.delete(request.sessionId);
      this.lastEventAt.delete(request.sessionId);
      this.workspaceLock.release(request.workspaceId, request.sessionId);
    }
  }

  private async tryStartWindowsNativeFastPath(
    input: StartTaskInput,
    attachments: SessionAttachment[],
    meta: {
      startAt: number;
      targetPath: string;
      workspaceId: string;
      workSessionId: string;
      sessionId: string;
      actualEngine: "hermes";
    },
  ): Promise<TaskStartResult | undefined> {
    if (!this.windowsNativeIntentService) {
      return undefined;
    }

    const runtimeConfig = await this.runtimeEnvResolver.readConfig();
    const permissions = resolveEnginePermissions(runtimeConfig, meta.actualEngine);
    const contextBundle = this.emptyContextBundle(meta.workspaceId);
    const runtimeEnv = this.nativeRuntimeEnv(runtimeConfig, input.modelProfileId);
    const request: EngineRunRequest = {
      sessionId: meta.sessionId,
      workspaceId: meta.workspaceId,
      workspacePath: meta.targetPath,
      userInput: input.userInput,
      taskType: input.taskType,
      selectedFiles: input.selectedFiles,
      attachments,
      memoryPolicy: "isolated",
      modelProfileId: input.modelProfileId,
      runtimeEnv,
      contextBundle,
      permissions,
    };

    const lock = this.workspaceLock.acquire(meta.workspaceId, meta.sessionId, {
      engineId: meta.actualEngine,
      taskType: input.taskType,
      lockedPaths: input.selectedFiles,
    });
    if (!lock.acquired) {
      throw new Error(lock.message);
    }

    let dispatched = false;
    try {
      const nativeResult = await this.windowsNativeIntentService.tryHandle(
        request,
        async (event) => this.publish(meta.workspaceId, meta.workSessionId, meta.sessionId, meta.actualEngine, event),
      );
      if (!nativeResult) {
        return undefined;
      }
      const controller = new AbortController();
      dispatched = true;
      this.running.set(meta.sessionId, controller);
      this.usage.set(meta.sessionId, createTaskUsageState(0, runtimeEnv, runtimeConfig));
      void this.consumeNativeRun(request, nativeResult, controller, meta.workSessionId);
      await this.publishStep(
        meta.workspaceId,
        meta.workSessionId,
        meta.sessionId,
        meta.actualEngine,
        "windows-native-fastpath-dispatched",
        true,
        `Windows 原生任务已由桌面端直接执行，跳过 Hermes 模型链路，启动耗时 ${Date.now() - meta.startAt}ms。`,
      );
      return {
        taskRunId: meta.sessionId,
        workSessionId: meta.workSessionId,
        workspaceId: meta.workspaceId,
        contextBundle,
        snapshotId: "windows-native-direct",
        runtime: {
          engineId: meta.actualEngine,
          runtimeMode: "local_fast",
          providerId: runtimeEnv.provider,
          modelId: runtimeEnv.model,
        },
      };
    } finally {
      if (!dispatched) {
        this.workspaceLock.release(meta.workspaceId, meta.sessionId);
      }
    }
  }

  private emptyContextBundle(workspaceId: string): ContextBundle {
    const createdAt = now();
    return {
      id: `windows-native-${crypto.randomUUID()}`,
      workspaceId,
      policy: "isolated",
      readonly: true,
      maxCharacters: 0,
      usedCharacters: 0,
      sources: [],
      summary: "",
      createdAt,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }

  private nativeRuntimeEnv(config: RuntimeConfig, modelProfileId?: string): EngineRuntimeEnv {
    const profile = config.modelProfiles.find((item) => item.id === (modelProfileId ?? config.defaultModelProfileId)) ?? config.modelProfiles[0];
    return {
      profileId: profile?.id ?? "windows-native",
      provider: profile?.provider ?? "local",
      model: profile?.model ?? "windows-native",
      baseUrl: profile?.baseUrl,
      executionMode: "local_fast",
      env: {},
    };
  }

  private async consumeNativeRun(
    request: EngineRunRequest,
    result: WindowsNativeIntentResult,
    controller: AbortController,
    workSessionId?: string,
  ) {
    const actualEngine = "hermes" as const;
    const startedAt = Date.now();
    try {
      await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, "running", "Windows 原生执行层已接手任务。");
      await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        type: "status",
        level: "info",
        message: "已跳过模型推理，直接执行可确定的 Windows 原生操作。",
        at: now(),
      });
      for (const event of result.events) {
        await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, event);
      }
      await this.publishTaskMetrics(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        adapterMs: Date.now() - startedAt,
        outcome: result.events.some((event) => event.type === "result" && !event.success) ? "failed" : "completed",
      });
      await this.publishStage(
        request.workspaceId,
        workSessionId,
        request.sessionId,
        actualEngine,
        result.events.some((event) => event.type === "result" && !event.success) ? "failed" : "completed",
        "Windows 原生执行层任务生命周期已完成。",
      );
    } catch (error) {
      await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        type: "result",
        success: false,
        title: "Windows 原生执行失败",
        detail: error instanceof Error ? error.message : "未知错误",
        at: now(),
      });
      await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, "failed", "Windows 原生执行失败。");
    } finally {
      this.running.delete(request.sessionId);
      this.usage.delete(request.sessionId);
      this.lastUsagePublishAt.delete(request.sessionId);
      this.metrics.delete(request.sessionId);
      this.streamingLifecyclePublished.delete(request.sessionId);
      this.lastEventAt.delete(request.sessionId);
      this.workspaceLock.release(request.workspaceId, request.sessionId);
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
  }

  async cancel(sessionId: string) {
    const controller = this.running.get(sessionId);
    if (controller) {
      controller.abort();
      this.running.delete(sessionId);
      return true;
    }
    return false;
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

  private async consumeRun(request: EngineRunRequest, controller: AbortController, workSessionId?: string) {
    const adapterStartedAt = Date.now();
    const actualEngine = "hermes" as const;
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
        if ((event.type === "stdout" || event.type === "stderr") && !this.streamingLifecyclePublished.has(request.sessionId)) {
          this.streamingLifecyclePublished.add(request.sessionId);
          await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, "streaming", "正在接收 Hermes 流式输出。");
        }
        await this.publish(request.workspaceId, workSessionId, request.sessionId, actualEngine, event);
      }
      await this.publishStep(request.workspaceId, workSessionId, request.sessionId, actualEngine, "adapter-complete", true, `Hermes 适配器完成，耗时 ${Date.now() - adapterStartedAt}ms。`);
      await this.publishTaskMetrics(request.workspaceId, workSessionId, request.sessionId, actualEngine, {
        adapterMs: Date.now() - adapterStartedAt,
        outcome: "completed",
      });
      await this.publishUsage(request.workspaceId, workSessionId, request.sessionId, actualEngine, true);
      await this.publishStage(request.workspaceId, workSessionId, request.sessionId, actualEngine, "completed", "Hermes 任务生命周期已完成。");
    } catch (error) {
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
        title: controller.signal.aborted ? "任务已取消" : failure.title,
        detail: failure.message,
        at: now(),
      });
    } finally {
      this.stopWaitNotices(request.sessionId);
      this.running.delete(request.sessionId);
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
    if (/NoConsoleScreenBufferError|No Windows console found|prompt_toolkit\.output\.win32/i.test(message)) {
      return {
        category: "cli-console-missing",
        title: "Hermes CLI 缺少可用控制台",
        message: `${message}。这更像是 Windows 下的 CLI 启动方式与控制台环境不兼容，并不是模型或密钥本身有问题。建议优先检查 Hermes 运行模式、Python 环境，或切到 WSL 模式后重试。`,
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
    if (event.type === "stdout" || event.type === "stderr") {
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
      message: `估算 Token：输入 ${usage.inputTokens}，输出 ${usage.outputTokens}。费用约 $${usage.estimatedCostUsd.toFixed(4)}。`,
      at: now(),
    };
    const envelope: TaskEventEnvelope = { taskRunId, workSessionId, sessionId: taskRunId, engineId, event };
    await this.sessionLog.append(workspaceId, envelope);
    this.getMainWindow()?.webContents.send(IpcChannels.taskEvent, envelope);
    this.lastUsagePublishAt.set(taskRunId, Date.now());
  }

  private trackUsage(sessionId: string, event: EngineEvent) {
    trackTaskUsage(this.usage.get(sessionId), event, (text) => this.estimateTokens(text));
  }

  private estimateTokens(text: string) {
    return Math.ceil(text.length / 4);
  }

  private captureFirstOutputMetric(sessionId: string, event: EngineEvent) {
    if (event.type !== "stdout" && event.type !== "stderr" && event.type !== "result") return;
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
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(INLINE_IMAGE_PATH_PATTERN)) {
    const candidate = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!candidate || !isSupportedImagePath(candidate)) {
      continue;
    }
    const key = normalizeAttachmentPathKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    paths.push(candidate);
  }
  return paths;
}

export async function resolveInlineImageAttachments(text: string, existing: SessionAttachment[]): Promise<SessionAttachment[]> {
  const result = [...existing];
  const seen = new Set(existing.flatMap((item) => [item.path, item.originalPath]).filter(Boolean).map(normalizeAttachmentPathKey));
  for (const imagePath of extractInlineImagePaths(text)) {
    const key = normalizeAttachmentPathKey(imagePath);
    if (seen.has(key)) {
      continue;
    }
    try {
      const stat = await fs.stat(imagePath);
      if (!stat.isFile() || stat.size > MAX_INLINE_IMAGE_BYTES) {
        continue;
      }
      result.push({
        id: `inline-image-${crypto.randomUUID()}`,
        name: path.basename(imagePath),
        path: imagePath,
        originalPath: imagePath,
        kind: "image",
        mimeType: mimeTypeForImagePath(imagePath),
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
  return /^[a-zA-Z]:\\/.test(imagePath) && mimeTypeForImagePath(imagePath) !== undefined;
}

function normalizeAttachmentPathKey(imagePath: string) {
  return process.platform === "win32" ? imagePath.toLowerCase() : imagePath;
}
