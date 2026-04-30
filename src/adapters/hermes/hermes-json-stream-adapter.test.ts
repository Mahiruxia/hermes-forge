import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readHermesJsonStream } from "./hermes-json-stream-adapter";

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
    expect(events[0]).toMatchObject({ type: "lifecycle", stage: "started" });
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

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "stdout", line: "regular log line" });
    expect(events[1]).toMatchObject({ type: "lifecycle", stage: "started" });
    expect(events[2]).toMatchObject({ type: "stdout", line: "another log" });
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

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "usage",
      source: "actual",
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      estimatedCostUsd: 0.0123,
    });
  });

});
