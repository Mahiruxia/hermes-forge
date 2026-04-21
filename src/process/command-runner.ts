import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type CommandLineEvent =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; exitCode: number | null };

export type CommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  detached?: boolean;
};

const activeChildren = new Set<ChildProcessWithoutNullStreams>();

export function killActiveCommands() {
  for (const child of activeChildren) {
    killProcessTree(child);
  }
}

function killProcessTree(child: ChildProcessWithoutNullStreams) {
  if (child.killed) {
    return;
  }
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false });
    return;
  }
  child.kill("SIGTERM");
}

export function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      shell: false,
      detached: options.detached ?? false,
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";

    const timer = options.timeoutMs
      ? setTimeout(() => {
          killProcessTree(child);
        }, options.timeoutMs)
      : undefined;

    const abort = () => killProcessTree(child);
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (exitCode) => {
      if (timer) {
        clearTimeout(timer);
      }
      activeChildren.delete(child);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function* streamCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): AsyncIterable<CommandLineEvent> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    windowsHide: true,
    shell: false,
    detached: options.detached ?? false,
  });
  activeChildren.add(child);

  const queue: CommandLineEvent[] = [];
  let done = false;
  let notify: (() => void) | undefined;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let timedOut = false;

  const push = (event: CommandLineEvent) => {
    queue.push(event);
    notify?.();
  };

  const flushLines = (kind: "stdout" | "stderr", chunk: Buffer) => {
    const text = (kind === "stdout" ? stdoutBuffer : stderrBuffer) + chunk.toString("utf8");
    const parts = text.split(/\r?\n/);
    const rest = parts.pop() ?? "";
    if (kind === "stdout") {
      stdoutBuffer = rest;
    } else {
      stderrBuffer = rest;
    }
    for (const line of parts) {
      if (line.trim()) {
        push({ type: kind, line });
      }
    }
  };

  const abort = () => {
    push({ type: "stderr", line: "任务已请求取消，正在终止子进程。" });
    killProcessTree(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        push({ type: "stderr", line: `命令超过 ${Math.round(options.timeoutMs! / 1000)} 秒未完成，已自动中断。` });
        killProcessTree(child);
      }, options.timeoutMs)
    : undefined;

  child.stdout.on("data", (chunk: Buffer) => flushLines("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => flushLines("stderr", chunk));
  child.on("error", (error) => push({ type: "stderr", line: error.message }));
  child.on("close", (exitCode) => {
    if (stdoutBuffer.trim()) {
      push({ type: "stdout", line: stdoutBuffer.trim() });
    }
    if (stderrBuffer.trim()) {
      push({ type: "stderr", line: stderrBuffer.trim() });
    }
    push({ type: "exit", exitCode });
    done = true;
    if (timer) {
      clearTimeout(timer);
    }
    activeChildren.delete(child);
    options.signal?.removeEventListener("abort", abort);
    notify?.();
  });

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = undefined;
      continue;
    }
    yield queue.shift()!;
  }

  if (timedOut) {
    return;
  }
}
