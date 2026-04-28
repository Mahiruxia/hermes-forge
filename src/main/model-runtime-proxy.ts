import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { EngineRuntimeEnv } from "../shared/types";

type ProxyMode = "openai_passthrough" | "baidu_wenxin";

type ProxyTarget = {
  key: string;
  mode: ProxyMode;
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  baiduCredential?: BaiduCredential;
  model: string;
};

type BaiduCredential = {
  apiKey: string;
  secretKey: string;
};

export class ModelRuntimeProxyService {
  private server?: http.Server;
  private proxyRoot?: string;
  private proxyApiKey = randomBytes(32).toString("hex");
  private readonly targets = new Map<string, ProxyTarget>();
  private readonly baiduTokens = new Map<string, { accessToken: string; expiresAt: number }>();

  async resolve(runtime: EngineRuntimeEnv): Promise<EngineRuntimeEnv> {
    const upstreamBaseUrl = runtime.baseUrl?.trim();
    if (!upstreamBaseUrl) return runtime;

    const sourceType = runtime.sourceType ?? runtime.env.HERMES_FORGE_MODEL_SOURCE_TYPE;
    const upstreamApiKey = runtime.env.OPENAI_API_KEY?.trim() || runtime.env.AI_API_KEY?.trim() || "";
    const baiduCredential = sourceType === "baidu_wenxin_api_key"
      ? parseBaiduCredential(runtime.env.HERMES_FORGE_BAIDU_CREDENTIAL ?? "")
      : undefined;
    const mode: ProxyMode | undefined = baiduCredential
      ? "baidu_wenxin"
      : needsProxyApiKey(upstreamApiKey)
        ? "openai_passthrough"
        : undefined;
    if (!mode) return runtime;

    const key = stableTargetKey(runtime.profileId, sourceType, upstreamBaseUrl);
    const proxyBaseUrl = await this.ensureTarget({
      key,
      mode,
      upstreamBaseUrl,
      upstreamApiKey,
      baiduCredential,
      model: runtime.model,
    });
    const env: Record<string, string> = {
      ...runtime.env,
      AI_BASE_URL: proxyBaseUrl,
      OPENAI_BASE_URL: proxyBaseUrl,
      ANTHROPIC_BASE_URL: proxyBaseUrl,
      AI_API_KEY: this.proxyApiKey,
      OPENAI_API_KEY: this.proxyApiKey,
      HERMES_FORGE_UPSTREAM_BASE_URL: upstreamBaseUrl,
      HERMES_FORGE_UPSTREAM_API_KEY_SHA: fingerprint(upstreamApiKey || runtime.env.HERMES_FORGE_BAIDU_CREDENTIAL || ""),
    };
    delete env.HERMES_FORGE_BAIDU_CREDENTIAL;

    return {
      ...runtime,
      baseUrl: proxyBaseUrl,
      env,
    };
  }

  async shutdown() {
    const server = this.server;
    this.server = undefined;
    this.proxyRoot = undefined;
    this.targets.clear();
    this.baiduTokens.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async ensureTarget(target: ProxyTarget) {
    await this.ensureStarted();
    this.targets.set(target.key, target);
    return `${this.proxyRoot}/profiles/${target.key}/v1`;
  }

  private async ensureStarted() {
    if (this.server && this.proxyRoot) return;
    this.server = http.createServer((request, response) => {
      void this.forward(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const startupError = (error: Error) => reject(error);
      this.server?.once("error", startupError);
      this.server?.listen(0, "127.0.0.1", () => {
        this.server?.off("error", startupError);
        this.server?.on("error", (error) => {
          console.warn("[Hermes Forge] model runtime proxy server error:", error);
        });
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    this.proxyRoot = `http://127.0.0.1:${address.port}`;
  }

  private async forward(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!this.isAuthorized(request)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Model runtime proxy authentication failed." } }));
      return;
    }
    const incomingUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = incomingUrl.pathname.match(/^\/profiles\/([^/]+)\/v1(\/.*)?$/);
    const target = match ? this.targets.get(match[1]) : undefined;
    if (!target) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Model runtime proxy target not found." } }));
      return;
    }

    try {
      if (target.mode === "baidu_wenxin") {
        await this.forwardBaidu(target, request, response, match?.[2] ?? "/", incomingUrl.search);
        return;
      }
      await this.forwardOpenAiCompatible(target, request, response, match?.[2] ?? "/", incomingUrl.search);
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : "Model runtime proxy request failed.",
        },
      }));
    }
  }

  private isAuthorized(request: http.IncomingMessage) {
    const authHeader = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
    const proxyHeader = request.headers["x-proxy-auth"];
    const provided = (authHeader?.replace(/^Bearer\s+/i, "") || (Array.isArray(proxyHeader) ? proxyHeader[0] : proxyHeader) || "").trim();
    if (!provided) return false;
    const expected = Buffer.from(this.proxyApiKey);
    const actual = Buffer.from(provided);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async forwardOpenAiCompatible(target: ProxyTarget, request: http.IncomingMessage, response: http.ServerResponse, suffix: string, search: string) {
    const upstream = new URL(target.upstreamBaseUrl);
    upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
    upstream.search = search;

    const headers = headersFromIncoming(request);
    headers.set("authorization", `Bearer ${target.upstreamApiKey ?? ""}`);
    const upstreamResponse = await fetch(upstream, {
      method: request.method,
      headers,
      body: allowsBody(request.method) ? request : undefined,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await writeFetchResponse(response, upstreamResponse);
  }

  private async forwardBaidu(target: ProxyTarget, request: http.IncomingMessage, response: http.ServerResponse, suffix: string, search: string) {
    if (request.method === "GET" && suffix === "/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: target.model, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || suffix !== "/chat/completions" || !target.baiduCredential) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Baidu proxy only supports /v1/models and /v1/chat/completions." } }));
      return;
    }

    const body = JSON.parse(await readRequestBody(request) || "{}") as { model?: string; messages?: unknown[]; stream?: boolean };
    const accessToken = await this.baiduAccessToken(target.baiduCredential);
    const upstream = new URL(target.upstreamBaseUrl);
    upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}/${encodeURIComponent(body.model || target.model)}`;
    upstream.search = search || `?access_token=${encodeURIComponent(accessToken)}`;

    const upstreamResponse = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: normalizeBaiduMessages(body.messages),
        stream: Boolean(body.stream),
      }),
    });
    const payload = await upstreamResponse.json().catch(() => undefined) as { result?: string; error_msg?: string; error_code?: number } | undefined;
    if (!upstreamResponse.ok || payload?.error_code) {
      response.writeHead(upstreamResponse.ok ? 502 : upstreamResponse.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: payload?.error_msg ?? "Baidu upstream request failed." } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `baidu-${Date.now()}`,
      object: "chat.completion",
      model: body.model || target.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: payload?.result ?? "" } }],
    }));
  }

  private async baiduAccessToken(credential: BaiduCredential) {
    const key = `${credential.apiKey}:${credential.secretKey}`;
    const cached = this.baiduTokens.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(credential.apiKey)}&client_secret=${encodeURIComponent(credential.secretKey)}`;
    const response = await fetch(url, { method: "POST" });
    const payload = await response.json().catch(() => undefined) as { access_token?: string; expires_in?: number } | undefined;
    if (!response.ok || !payload?.access_token) {
      throw new Error(`Baidu access_token 获取失败（HTTP ${response.status}）。`);
    }
    const expiresAt = Date.now() + Math.max(60, payload.expires_in ?? 2500) * 1000;
    this.baiduTokens.set(key, { accessToken: payload.access_token, expiresAt });
    return payload.access_token;
  }
}

function needsProxyApiKey(apiKey: string) {
  return apiKey.trim().length > 0 && apiKey.trim().length < 4;
}

function parseBaiduCredential(raw: string): BaiduCredential | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { apiKey?: unknown; secretKey?: unknown };
    if (typeof parsed.apiKey === "string" && typeof parsed.secretKey === "string") {
      return { apiKey: parsed.apiKey.trim(), secretKey: parsed.secretKey.trim() };
    }
  } catch {
    // Fall through to delimiter parsing.
  }
  const [apiKey, secretKey] = trimmed.includes(":") ? trimmed.split(":", 2) : trimmed.split(/\r?\n/, 2);
  if (!apiKey?.trim() || !secretKey?.trim()) return undefined;
  return { apiKey: apiKey.trim(), secretKey: secretKey.trim() };
}

function headersFromIncoming(request: http.IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (!value || ["host", "connection", "content-length"].includes(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function writeFetchResponse(response: http.ServerResponse, upstreamResponse: Response) {
  response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers.entries()));
  if (!upstreamResponse.body) {
    response.end();
    return;
  }
  await upstreamResponse.body.pipeTo(new WritableStream({
    write(chunk) {
      response.write(Buffer.from(chunk));
    },
    close() {
      response.end();
    },
    abort() {
      response.end();
    },
  }));
}

function normalizeBaiduMessages(messages: unknown) {
  if (!Array.isArray(messages)) return [{ role: "user", content: "Hello" }];
  return messages
    .filter((message): message is { role?: unknown; content?: unknown } => typeof message === "object" && message !== null)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
    }));
}

async function readRequestBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function allowsBody(method?: string) {
  return !["GET", "HEAD"].includes((method ?? "GET").toUpperCase());
}

function stableTargetKey(profileId: string, sourceType: string | undefined, baseUrl: string) {
  return fingerprint(`${profileId}:${sourceType ?? ""}:${baseUrl}`);
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export const testOnly = {
  needsProxyApiKey,
  parseBaiduCredential,
};
