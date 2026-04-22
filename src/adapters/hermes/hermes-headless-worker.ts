import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type WorkerRequest = {
  id: string;
  rootPath: string;
  query: string;
  systemPrompt?: string;
  imagePath?: string;
  sessionId?: string;
  source?: string;
  maxTurns?: number;
  env?: Record<string, string>;
};

type WorkerResponse = {
  id: string;
  ok: boolean;
  finalResponse?: string;
  error?: string;
  traceback?: string;
};

type PendingRequest = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export class HermesHeadlessWorker {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly stderrLines: string[] = [];
  private queue = Promise.resolve();

  constructor(
    private readonly launcher: () => Promise<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  run(request: Omit<WorkerRequest, "id">, signal?: AbortSignal): Promise<string> {
    const task = this.queue.then(() => this.runInternal(request, signal));
    this.queue = task.catch(() => undefined) as Promise<void>;
    return task;
  }

  async stop() {
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async runInternal(request: Omit<WorkerRequest, "id">, signal?: AbortSignal) {
    const child = await this.ensureChild();
    const id = `worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        signal?.removeEventListener("abort", abort);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        cleanup();
        callback();
      };
      const pending: PendingRequest = {
        resolve: (value) => {
          finish(() => resolve(value));
        },
        reject: (error) => {
          finish(() => reject(error));
        },
      };
      this.pending.set(id, pending);

      const abort = () => {
        void this.stop();
        finish(() => reject(new Error("Hermes 后台任务已取消。")));
      };

      timeout = setTimeout(() => {
        void this.stop();
        finish(() => reject(new Error(`Hermes 后台任务超过 ${Math.ceil(this.requestTimeoutMs / 1000)} 秒未完成，已自动中断。`)));
      }, this.requestTimeoutMs);

      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });

      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`, "utf8", (error?: Error | null) => {
        if (error) {
          finish(() => reject(new Error(`Hermes 后台 worker 写入失败：${error.message}`)));
        }
      });
    });
  }

  private async ensureChild() {
    if (this.child && !this.child.killed) {
      return this.child;
    }
    const launch = await this.launcher();
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env },
      windowsHide: true,
      shell: false,
      detached: false,
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.stderrLines.length = 0;

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));
    child.on("error", (error) => {
      if (this.child === child) {
        this.rejectAll(new Error(`Hermes 后台 worker 启动失败：${error.message}`));
      }
    });
    child.on("close", () => {
      if (this.child !== child) {
        return;
      }
      this.flushStderr();
      this.rejectAll(new Error(this.stderrLines.at(-1) || "Hermes 后台 worker 已退出。"));
      this.child = undefined;
    });
    return child;
  }

  private handleStdout(chunk: Buffer) {
    const text = this.stdoutBuffer + chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines.map((item) => item.trim()).filter(Boolean)) {
      try {
        const response = JSON.parse(line) as WorkerResponse;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        if (response.ok) {
          pending.resolve(response.finalResponse ?? "");
        } else {
          pending.reject(new Error(response.error || response.traceback || "Hermes 后台 worker 执行失败。"));
        }
      } catch {
        // Ignore non-protocol lines.
      }
    }
  }

  private handleStderr(chunk: Buffer) {
    const text = this.stderrBuffer + chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines.map((item) => item.trim()).filter(Boolean)) {
      this.stderrLines.push(line);
      if (this.stderrLines.length > 40) {
        this.stderrLines.shift();
      }
    }
  }

  private flushStderr() {
    if (this.stderrBuffer.trim()) {
      this.stderrLines.push(this.stderrBuffer.trim());
      this.stderrBuffer = "";
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
