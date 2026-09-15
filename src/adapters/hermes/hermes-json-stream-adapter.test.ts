import { describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { EngineEvent, EngineInteractionRequest } from "../../shared/types";
import { readHermesJsonStream, type HermesJsonStreamOptions } from "./hermes-json-stream-adapter";

const emitScript = "function emit(event){console.log('__FORGE_EVENT__'+JSON.stringify(event)+'__FORGE_EVENT_END__');}";
function fakeProcess(script: string) {
  return spawn(process.execPath, ["-e", `${emitScript}\n${script}`], { windowsHide: true, detached: process.platform !== "win32" });
}
async function collect(proc: ChildProcessWithoutNullStreams, options: HermesJsonStreamOptions = {}, signal = new AbortController().signal) {
  const events: EngineEvent[] = [];
  for await (const event of readHermesJsonStream(proc, signal, options)) events.push(event);
  return events;
}

describe("readHermesJsonStream", () => {
  it("parses lifecycle and result events from a Python echo script", async () => {
    const script = `
import sys
print('__FORGE_EVENT__{"type": "lifecycle", "stage": "started", "session_id": "s1"}__FORGE_EVENT_END__')
print('__FORGE_EVENT__{"type": "message_chunk", "content": "hi", "session_id": "s1"}__FORGE_EVENT_END__')
print('__FORGE_EVENT__{"type": "result", "success": true, "content": "done", "session_id": "s1"}__FORGE_EVENT_END__')
    `;
    const proc = spawn("python", ["-c", script]);
    const controller = new AbortController();
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const event of readHermesJsonStream(proc, controller.signal)) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "lifecycle", stage: "running" });
    expect(events[1]).toMatchObject({ type: "message_chunk", content: "hi" });
    expect(events[2]).toMatchObject({ type: "result", success: true, detail: "done" });
  });

  it("yields plain stdout lines as stdout events", async () => {
    const script = `
print('regular log line')
print('__FORGE_EVENT__{"type": "lifecycle", "stage": "started"}__FORGE_EVENT_END__')
print('another log')
    `;
    const proc = spawn("python", ["-c", script]);
    const controller = new AbortController();
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const event of readHermesJsonStream(proc, controller.signal)) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ type: "stdout", line: "regular log line" });
    expect(events[1]).toMatchObject({ type: "lifecycle", stage: "running" });
    expect(events[2]).toMatchObject({ type: "stdout", line: "another log" });
    expect(events[3]).toMatchObject({ type: "result", success: false, outcome: "failed" });
  });

  it("parses actual token usage events from the Windows bridge", async () => {
    const script = `
print('__FORGE_EVENT__{"type": "usage", "source": "actual", "input_tokens": 123, "output_tokens": 45, "total_tokens": 168, "estimated_cost_usd": 0.0123, "session_id": "s1"}__FORGE_EVENT_END__')
    `;
    const proc = spawn("python", ["-c", script]);
    const controller = new AbortController();
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const event of readHermesJsonStream(proc, controller.signal)) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "usage",
      source: "actual",
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      estimatedCostUsd: 0.0123,
    });
  });

  it("passes through camelCase token usage fields", async () => {
    const script = `
print('__FORGE_EVENT__{"type": "usage", "source": "actual", "inputTokens": 100, "outputTokens": 30, "totalTokens": 150, "promptTokens": 90, "completionTokens": 25, "cacheReadTokens": 10, "cacheWriteTokens": 5, "reasoningTokens": 20, "contextTokens": 1234, "contextWindow": 128000, "contextPercent": 1, "estimatedCostUsd": 0.01, "costSource": "provider", "session_id": "s1"}__FORGE_EVENT_END__')
    `;
    const proc = spawn("python", ["-c", script]);
    const controller = new AbortController();
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const event of readHermesJsonStream(proc, controller.signal)) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "usage",
      source: "actual",
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 150,
      promptTokens: 90,
      completionTokens: 25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 20,
      contextTokens: 1234,
      contextWindow: 128000,
      contextPercent: 1,
      estimatedCostUsd: 0.01,
      costSource: "provider",
    });
  });

  it("finishes a silent process on cancellation and terminates the child", async () => {
    const proc = fakeProcess("setInterval(() => {}, 1000)");
    const controller = new AbortController();
    const start = Date.now();
    const timer = setTimeout(() => controller.abort(), 80);
    try {
      const events = await collect(proc, { taskRunId: "task-1", stopGraceMs: 20 }, controller.signal);
      expect(events.at(-1)).toMatchObject({ type: "result", success: false, outcome: "cancelled" });
      expect(Date.now() - start).toBeLessThan(5000);
      expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it("fails visibly if process creation fails", async () => {
    const proc = spawn("forge-nonexistent-executable-4914", [], { windowsHide: true });
    expect((await collect(proc)).at(-1)).toMatchObject({ type: "result", success: false, outcome: "failed" });
  });

  it("ends a running process tree within five seconds using the production cancellation grace", async () => {
    const proc = fakeProcess(`
      const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
      console.log('DESCENDANT_PID=' + child.pid);
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    let childPid: number | undefined;
    let cancelledAt = 0;
    const childReady = (buffer: Buffer) => {
      const match = /DESCENDANT_PID=(\d+)/.exec(buffer.toString());
      if (!match) return;
      childPid = Number(match[1]);
      cancelledAt = Date.now();
      controller.abort();
    };
    proc.stdout.on('data', childReady);
    try {
      const events = await collect(proc, { taskRunId: "tree-cancel" }, controller.signal);
      expect(childPid).toBeTypeOf('number');
      expect(Date.now() - cancelledAt).toBeLessThan(5000);
      expect(events.filter(event => event.type === 'result')).toEqual([
        expect.objectContaining({ success: false, outcome: 'cancelled' }),
      ]);
      expect(() => process.kill(proc.pid!, 0)).toThrow();
      expect(() => process.kill(childPid!, 0)).toThrow();
    } finally {
      proc.stdout.off('data', childReady);
      controller.abort();
      // Exact fixture PIDs only; cleanup also covers assertion failures.
      for (const pid of [proc.pid, childPid]) {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
      }
    }
  }, 10000);

  it("requires both an official result and a successful exit", async () => {
    const noResult = await collect(fakeProcess("process.stderr.write('runner broke');process.exitCode=2;"));
    expect(noResult.at(-1)).toMatchObject({ type: "result", success: false, outcome: "failed", detail: expect.stringContaining("runner broke") });
    const emptySuccess = await collect(fakeProcess("process.exitCode=0;"));
    expect(emptySuccess.at(-1)).toMatchObject({ type: "result", success: false, outcome: "failed" });
    const falseSuccess = await collect(fakeProcess("emit({type:'result',success:true,content:'draft'});process.exitCode=2;"));
    expect(falseSuccess.filter((event) => event.type === "result")).toEqual([
      expect.objectContaining({ success: false, outcome: "failed" }),
    ]);
  });

  it("marks a silent runtime timeout as failure", async () => {
    const events = await collect(fakeProcess("setInterval(() => {}, 1000)"), { timeoutMs: 80, stopGraceMs: 20 });
    expect(events.at(-1)).toMatchObject({ type: "result", success: false, outcome: "failed", detail: expect.stringContaining("时限") });
  });

  it("correlates concurrent approvals and enforces allowed scopes", async () => {
    const proc = fakeProcess(`
      const replies = [];
      require('readline').createInterface({input:process.stdin}).on('line', (line) => {
        const reply = JSON.parse(line); replies.push(reply);
        if(replies.length === 2){emit({type:'result',success:true,content:JSON.stringify(replies)});process.exit(0);}
      });
      for(const requestId of ['slow','fast']) emit({type:'interaction_request',kind:'approval',taskRunId:'task-1',requestId,timeoutMs:1000,command:'echo ok',description:'run',allowSession:false,allowPermanent:false,smartDenied:false});
    `);
    const events = await collect(proc, { taskRunId: "task-1", onInteraction: async (request) => {
      if (request.requestId === "slow") await new Promise((resolve) => setTimeout(resolve, 30));
      return { kind: "approval", taskRunId: request.taskRunId, requestId: request.requestId, choice: request.requestId === "slow" ? "once" : "always" };
    } });
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "result", success: true });
    if (result?.type !== "result") throw new Error("Missing result");
    const replies = JSON.parse(result.detail) as Array<{ requestId: string; choice: string }>;
    expect(replies.map((reply) => [reply.requestId, reply.choice])).toEqual([["fast", "deny"], ["slow", "once"]]);
  });

  it("aborts a pending clarification when its task is cancelled", async () => {
    const controller = new AbortController();
    let interactionSignal: AbortSignal | undefined;
    const events = await collect(fakeProcess(`
      emit({type:'interaction_request',kind:'clarify',taskRunId:'task-1',requestId:'ask',timeoutMs:2000,question:'Choose'});
      setInterval(() => {}, 1000);
    `), { taskRunId: "task-1", stopGraceMs: 20, onInteraction: async (_request, signal) => {
      interactionSignal = signal;
      setTimeout(() => controller.abort(), 20);
      return new Promise(() => {});
    } }, controller.signal);
    expect(interactionSignal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "cancelled" });
  });

  it("rejects a request for another task before invoking the UI handler", async () => {
    let called = false;
    const events = await collect(fakeProcess(`
      emit({type:'interaction_request',kind:'clarify',taskRunId:'other-task',requestId:'ask',timeoutMs:500,question:'Choose'});
      setInterval(() => {}, 1000);
    `), { taskRunId: "task-1", stopGraceMs: 20, onInteraction: async (request: EngineInteractionRequest) => {
      called = true;
      return { kind: "clarify", requestId: request.requestId, taskRunId: request.taskRunId, answer: "yes" };
    } });
    expect(called).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "result", outcome: "failed" });
  });
});
