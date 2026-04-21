import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntimeProxyService, testOnly } from "./model-runtime-proxy";
import type { EngineRuntimeEnv } from "../shared/types";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("ModelRuntimeProxyService", () => {
  it("detects API keys Hermes would otherwise discard as placeholders", () => {
    expect(testOnly.needsProxyApiKey("pwd")).toBe(true);
    expect(testOnly.needsProxyApiKey("sk-real")).toBe(false);
    expect(testOnly.needsProxyApiKey("")).toBe(false);
  });

  it("forwards requests with the original short upstream API key", async () => {
    let receivedAuth = "";
    const upstream = http.createServer((request, response) => {
      receivedAuth = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-5.4" }] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => upstream.close(() => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream port");

    const service = new ModelRuntimeProxyService();
    const runtime: EngineRuntimeEnv = {
      profileId: "local",
      provider: "custom",
      model: "gpt-5.4",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      env: {
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "pwd",
      },
    };

    const resolved = await service.resolve(runtime);
    const response = await fetch(`${resolved.baseUrl}/models`, {
      headers: { authorization: `Bearer ${resolved.env.OPENAI_API_KEY}` },
    });
    await service.shutdown();

    expect(response.ok).toBe(true);
    expect(resolved.env.OPENAI_API_KEY).toBe("hermes-forge-local-proxy-key");
    expect(receivedAuth).toBe("Bearer pwd");
  });
});
