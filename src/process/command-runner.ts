import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { redactSensitiveText } from "../shared/redaction";

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  diagnostics?: CommandDiagnostics;
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
  commandId?: string;
  runtimeKind?: "windows" | "wsl";
  maxOutputBytes?: number;
  maxQueueEvents?: number;
  maxLineChars?: number;
};

export type CommandDiagnostics = {
  commandId: string;
  binary: string;
  argv: string[];
  cwd: string;
  runtimeKind?: "windows" | "wsl";
  envRedacted?: Record<string, string>;
  timeoutMs?: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal?: string;
  spawnError?: string;
  stderrPreview: string;
  stdoutPreview: string;
  category: "ok" | "spawn_error" | "timeout" | "cancelled" | "output_limit" | "non_zero_exit";
};

const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_QUEUE_EVENTS = 1000;
const DEFAULT_MAX_LINE_CHARS = 16000;

export async function killActiveCommands() {
  await Promise.all([...activeChildren].map((child) => killProcessTree(child)));
}

async function killProcessTree(child: ChildProcessWithoutNullStreams) {
  if (child.killed) {
    return;
  }
  if (process.platform === "win32" && child.pid) {
    const pid = child.pid;
    const result = await waitForTaskkill(pid);
    if (result.exitCode !== 0) {
      console.warn("[Hermes Forge] taskkill failed", { pid, exitCode: result.exitCode, stderr: result.stderr.trim() });
    }
    return;
  }
  child.kill("SIGTERM");
}

export function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return executeCommand(command, args, options);
}

export function executeCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let timedOut = false;
    let cancelled = false;
    let outputLimited = false;
    let spawnError: string | undefined;
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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          void killProcessTree(child);
        }, options.timeoutMs)
      : undefined;

    const abort = () => {
      cancelled = true;
      void killProcessTree(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimitedOutput(stdout, chunk, stdoutBytes, maxOutputBytes, (bytes) => {
        stdoutBytes = bytes;
      }, () => {
        outputLimited = true;
        void killProcessTree(child);
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimitedOutput(stderr, chunk, stderrBytes, maxOutputBytes, (bytes) => {
        stderrBytes = bytes;
      }, () => {
        outputLimited = true;
        void killProcessTree(child);
      });
    });
    child.on("error", (error) => {
      spawnError = error.message;
      stderr = appendLimitedOutput(stderr, Buffer.from(error.message), stderrBytes, maxOutputBytes, (bytes) => {
        stderrBytes = bytes;
      }, () => {
        outputLimited = true;
      });
    });
    child.on("close", (exitCode) => {
      if (timer) {
        clearTimeout(timer);
      }
      activeChildren.delete(child);
      options.signal?.removeEventListener("abort", abort);
      const endedAtMs = Date.now();
      const diagnostics: CommandDiagnostics = {
        commandId: options.commandId ?? `${command}-${startedAtMs}`,
        binary: command,
        argv: [...args],
        cwd: options.cwd,
        runtimeKind: options.runtimeKind,
        envRedacted: redactEnv(options.env),
        timeoutMs: options.timeoutMs,
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: endedAtMs - startedAtMs,
        exitCode,
        signal: timedOut ? "timeout" : cancelled ? "abort" : outputLimited ? "output_limit" : undefined,
        spawnError,
        stderrPreview: preview(stderr),
        stdoutPreview: preview(stdout),
        category: spawnError
          ? "spawn_error"
          : timedOut
            ? "timeout"
            : cancelled
              ? "cancelled"
              : outputLimited
                ? "output_limit"
                : exitCode === 0
                  ? "ok"
                  : "non_zero_exit",
      };
      logCommandDiagnostics(diagnostics);
      resolve({ exitCode, stdout, stderr, diagnostics });
    });
  });
}

export async function* streamCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): AsyncIterable<CommandLineEvent> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
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
  let outputLimited = false;
  let stderrPreview = "";
  let stdoutPreview = "";
  let totalOutputBytes = 0;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxQueueEvents = options.maxQueueEvents ?? DEFAULT_MAX_QUEUE_EVENTS;
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

  const push = (event: CommandLineEvent) => {
    if (queue.length >= maxQueueEvents) {
      outputLimited = true;
      if (!child.killed) {
        void killProcessTree(child);
      }
      return;
    }
    queue.push(event);
    notify?.();
  };

  const flushLines = (kind: "stdout" | "stderr", chunk: Buffer) => {
    totalOutputBytes += chunk.byteLength;
    if (totalOutputBytes > maxOutputBytes) {
      outputLimited = true;
      push({ type: "stderr", line: `命令输出超过 ${Math.round(maxOutputBytes / 1024)}KB，已自动中断。` });
      void killProcessTree(child);
      return;
    }
    const text = (kind === "stdout" ? stdoutBuffer : stderrBuffer) + chunk.toString("utf8");
    if (kind === "stdout") {
      stdoutPreview = preview(`${stdoutPreview}${chunk.toString("utf8")}`);
    } else {
      stderrPreview = preview(`${stderrPreview}${chunk.toString("utf8")}`);
    }
    const parts = text.split(/\r?\n/);
    const rest = parts.pop() ?? "";
    if (kind === "stdout") {
      stdoutBuffer = rest;
    } else {
      stderrBuffer = rest;
    }
    for (const line of parts) {
      if (line.trim()) {
        push({ type: kind, line: truncateLine(line, maxLineChars) });
      }
    }
  };

  const abort = () => {
    push({ type: "stderr", line: "任务已请求取消，正在终止子进程。" });
    void killProcessTree(child);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        push({ type: "stderr", line: `命令超过 ${Math.round(options.timeoutMs! / 1000)} 秒未完成，已自动中断。` });
        void killProcessTree(child);
      }, options.timeoutMs)
    : undefined;

  child.stdout.on("data", (chunk: Buffer) => flushLines("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => flushLines("stderr", chunk));
  child.on("error", (error) => push({ type: "stderr", line: error.message }));
  child.on("close", (exitCode) => {
    if (stdoutBuffer.trim()) {
      push({ type: "stdout", line: truncateLine(stdoutBuffer.trim(), maxLineChars) });
    }
    if (stderrBuffer.trim()) {
      push({ type: "stderr", line: truncateLine(stderrBuffer.trim(), maxLineChars) });
    }
    push({ type: "exit", exitCode });
    const endedAtMs = Date.now();
    logCommandDiagnostics({
      commandId: options.commandId ?? `${command}-${startedAtMs}`,
      binary: command,
      argv: [...args],
      cwd: options.cwd,
      runtimeKind: options.runtimeKind,
      envRedacted: redactEnv(options.env),
      timeoutMs: options.timeoutMs,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - startedAtMs,
      exitCode,
      signal: timedOut ? "timeout" : options.signal?.aborted ? "abort" : outputLimited ? "output_limit" : undefined,
      stderrPreview,
      stdoutPreview,
      category: timedOut
        ? "timeout"
        : options.signal?.aborted
          ? "cancelled"
          : outputLimited
            ? "output_limit"
            : exitCode === 0
              ? "ok"
              : "non_zero_exit",
    });
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

function preview(value: string) {
  const text = redactSensitiveText(value.trim());
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...[truncated]` : text;
}

function appendLimitedOutput(
  current: string,
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
  setBytes: (bytes: number) => void,
  onLimit: () => void,
) {
  if (currentBytes >= maxBytes) {
    onLimit();
    return current;
  }
  const nextBytes = currentBytes + chunk.byteLength;
  if (nextBytes <= maxBytes) {
    setBytes(nextBytes);
    return current + chunk.toString("utf8");
  }
  const remaining = Math.max(0, maxBytes - currentBytes);
  setBytes(maxBytes);
  onLimit();
  return `${current}${chunk.subarray(0, remaining).toString("utf8")}\n...[output truncated: limit exceeded]`;
}

function waitForTaskkill(pid: number) {
  return new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
    const proc = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, shell: false });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (error) => {
      resolve({ exitCode: 1, stderr: error.message });
    });
    proc.on("close", (exitCode) => {
      resolve({ exitCode, stderr });
    });
  });
}

function truncateLine(line: string, maxChars: number) {
  return line.length > maxChars ? `${line.slice(0, maxChars)}...[line truncated]` : line;
}

function redactEnv(env: NodeJS.ProcessEnv | undefined) {
  if (!env) return undefined;
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    redacted[key] = /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTHORIZATION|COOKIE|KEY)/i.test(key)
      ? "<redacted>"
      : redactSensitiveText(value);
  }
  return redacted;
}

function logCommandDiagnostics(diagnostics: CommandDiagnostics) {
  const payload = {
    commandId: diagnostics.commandId,
    command: diagnostics.binary,
    args: diagnostics.argv.map(redactArg),
    cwd: diagnostics.cwd,
    runtimeKind: diagnostics.runtimeKind,
    exitCode: diagnostics.exitCode,
    category: diagnostics.category,
    durationMs: diagnostics.durationMs,
    stderr: diagnostics.stderrPreview,
    stdout: diagnostics.stdoutPreview,
  };
  if (diagnostics.category === "ok") {
    console.info("[Hermes Forge] command ok", payload);
  } else {
    console.warn("[Hermes Forge] command failed", payload);
  }
}

function redactArg(value: string) {
  if (/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTHORIZATION|BEARER)(=|:)/i.test(value)) {
    return value.replace(/(=|:).+$/, "$1<redacted>");
  }
  if (/^[A-Za-z0-9._~+/=-]{24,}$/.test(value) && !/[\\/]/.test(value)) {
    return "<redacted>";
  }
  return redactSensitiveText(value);
}
