import http from "node:http";
import { gzipSync } from "node:zlib";
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

  it("proxies MiMo requests with api-key authentication", async () => {
    let receivedApiKey = "";
    let receivedAuth = "";
    const upstream = http.createServer((request, response) => {
      receivedApiKey = request.headers["api-key"] as string;
      receivedAuth = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "mimo-v2.5-pro" }] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => upstream.close(() => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream port");

    const service = new ModelRuntimeProxyService();
    const resolved = await service.resolve({
      profileId: "mimo",
      provider: "custom",
      sourceType: "mimo_token_plan_api_key",
      model: "mimo-v2.5-pro",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      env: {
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "mimo-key",
        MIMO_API_KEY: "mimo-key",
      },
    });

    const response = await fetch(`${resolved.baseUrl}/models`, {
      headers: { authorization: `Bearer ${resolved.env.OPENAI_API_KEY}` },
    });
    await service.shutdown();

    expect(response.ok).toBe(true);
    expect(receivedApiKey).toBe("mimo-key");
    expect(receivedAuth).toBe("Bearer mimo-key");
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

  it("preserves an upstream 401 and its JSON error for POST requests", async () => {
    await withMimoProxy((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "API key is not authorized for this endpoint." } }));
    }, async (runtime) => {
      const response = await postToProxy(runtime);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { message: "API key is not authorized for this endpoint." } });
    });
  });

  it("replays a JSON POST after a same-origin 307 without losing its model or credentials", async () => {
    const received: Array<{ url?: string; method?: string; body: string; apiKey?: string }> = [];
    await withMimoProxy(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({ url: request.url, method: request.method, body: Buffer.concat(chunks).toString("utf8"), apiKey: request.headers["api-key"] as string });
      if (request.url === "/v1/chat/completions") {
        response.writeHead(307, { location: "/canonical/chat/completions" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    }, async (runtime) => {
      const response = await postToProxy(runtime);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(received).toHaveLength(2);
      expect(received[1]).toEqual({ ...received[0], url: "/canonical/chat/completions" });
      expect(received[1].method).toBe("POST");
      expect(received[1].apiKey).toBe("private-test-key");
      expect(JSON.parse(received[1].body).model).toBe("mimo-v2.5-pro");
    });
  });

  it("blocks a redirect to another origin before sending upstream credentials there", async () => {
    let escapedRequests = 0;
    const destination = http.createServer((_request, response) => { escapedRequests += 1; response.end("unexpected"); });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const address = destination.address();
    if (!address || typeof address === "string") throw new Error("Missing redirect port");
    try {
      await withMimoProxy((_request, response) => {
        response.writeHead(307, { location: `http://127.0.0.1:${address.port}/collect` });
        response.end();
      }, async (runtime) => {
        const response = await postToProxy(runtime);
        expect(response.status).toBe(502);
        const body = await response.json() as { error: { message: string } };
        expect(body.error.message).toContain("different origin");
        expect(JSON.stringify(body)).not.toContain("private-test-key");
        expect(escapedRequests).toBe(0);
      });
    } finally {
      await new Promise<void>((resolve) => destination.close(() => resolve()));
    }
  });

  it("forwards the decoded upstream body without its original gzip wire headers", async () => {
    const payload = { choices: [{ message: { content: "MiMo response" } }] };
    const compressed = gzipSync(JSON.stringify(payload));
    await withMimoProxy((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": compressed.length });
      response.end(compressed);
    }, async (runtime) => {
      const response = await postToProxy(runtime);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.json()).toEqual(payload);
    });
  });
});

async function withMimoProxy(handler: http.RequestListener, run: (runtime: EngineRuntimeEnv) => Promise<void>) {
  const upstream = http.createServer(handler);
  const service = new ModelRuntimeProxyService();
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream port");
    const runtime = await service.resolve({
      profileId: "mimo-post", provider: "custom", sourceType: "mimo_token_plan_api_key",
      model: "mimo-v2.5-pro", baseUrl: `http://127.0.0.1:${address.port}/v1`, env: { OPENAI_API_KEY: "private-test-key" },
    });
    await run(runtime);
  } finally {
    await service.shutdown();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

function postToProxy(runtime: EngineRuntimeEnv) {
  return fetch(`${runtime.baseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${runtime.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "mimo-v2.5-pro", messages: [{ role: "user", content: "Reply OK." }] }),
  });
}
