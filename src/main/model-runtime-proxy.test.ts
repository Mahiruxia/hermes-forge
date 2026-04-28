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
    expect(resolved.env.OPENAI_API_KEY).toHaveLength(64);
    expect(resolved.env.OPENAI_API_KEY).not.toBe("pwd");
    expect(receivedAuth).toBe("Bearer pwd");
  });

  it("rejects unauthenticated local proxy requests", async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-5.4" }] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => upstream.close(() => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream port");

    const service = new ModelRuntimeProxyService();
    const resolved = await service.resolve({
      profileId: "local",
      provider: "custom",
      model: "gpt-5.4",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      env: { OPENAI_API_KEY: "pwd" },
    });

    const response = await fetch(`${resolved.baseUrl}/models`);
    await service.shutdown();

    expect(response.status).toBe(401);
  });

  it("keeps multiple proxied profiles isolated on the same local server", async () => {
    const receivedAuth: string[] = [];
    const upstream = http.createServer((request, response) => {
      receivedAuth.push(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: request.url?.includes("coding") ? "coding" : "chat" }] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => upstream.close(() => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream port");

    const service = new ModelRuntimeProxyService();
    const chat = await service.resolve({
      profileId: "chat",
      provider: "custom",
      model: "chat",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      env: { OPENAI_API_KEY: "one" },
    });
    const coding = await service.resolve({
      profileId: "coding",
      provider: "custom",
      model: "coding",
      baseUrl: `http://127.0.0.1:${address.port}/coding/v1`,
      env: { OPENAI_API_KEY: "two" },
    });

    await fetch(`${chat.baseUrl}/models`, { headers: { authorization: `Bearer ${chat.env.OPENAI_API_KEY}` } });
    await fetch(`${coding.baseUrl}/models`, { headers: { authorization: `Bearer ${coding.env.OPENAI_API_KEY}` } });
    await service.shutdown();

    expect(receivedAuth).toEqual(["Bearer one", "Bearer two"]);
  });
});
