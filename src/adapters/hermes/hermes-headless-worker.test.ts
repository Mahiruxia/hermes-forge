import { describe, expect, it } from "vitest";
import { HermesHeadlessWorker } from "./hermes-headless-worker";

const workerScript = `
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const raw of chunk.split("\\n")) {
    const line = raw.trim();
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.query === "stall") continue;
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, finalResponse: "ok" }) + "\\n");
  }
});
`;

describe("HermesHeadlessWorker", () => {
  it("times out a stalled request and restarts for the next queued request", async () => {
    const worker = new HermesHeadlessWorker(
      async () => ({
        command: process.execPath,
        args: ["-e", workerScript],
        cwd: process.cwd(),
        env: process.env,
      }),
      1000,
    );

    await expect(worker.run({ rootPath: process.cwd(), query: "stall" })).rejects.toThrow(/超过/);
    await expect(worker.run({ rootPath: process.cwd(), query: "next" })).resolves.toBe("ok");
    await worker.stop();
  });
});
