import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { EngineRuntimeEnv } from "../shared/types";

type ProxyTarget = {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
};

const PROXY_API_KEY = "hermes-forge-local-proxy-key";

export class ModelRuntimeProxyService {
  private server?: http.Server;
  private target?: ProxyTarget;
  private proxyBaseUrl?: string;

  async resolve(runtime: EngineRuntimeEnv): Promise<EngineRuntimeEnv> {
    const upstreamBaseUrl = runtime.baseUrl?.trim();
    const upstreamApiKey = runtime.env.OPENAI_API_KEY?.trim() || runtime.env.AI_API_KEY?.trim() || "";
    if (!upstreamBaseUrl || !needsProxyApiKey(upstreamApiKey)) {
      return runtime;
    }

    const proxyBaseUrl = await this.ensureStarted({ upstreamBaseUrl, upstreamApiKey });
    const env = {
      ...runtime.env,
      AI_BASE_URL: proxyBaseUrl,
      OPENAI_BASE_URL: proxyBaseUrl,
      ANTHROPIC_BASE_URL: proxyBaseUrl,
      AI_API_KEY: PROXY_API_KEY,
      OPENAI_API_KEY: PROXY_API_KEY,
      HERMES_FORGE_UPSTREAM_BASE_URL: upstreamBaseUrl,
      HERMES_FORGE_UPSTREAM_API_KEY_SHA: fingerprint(upstreamApiKey),
    };

    return {
      ...runtime,
      baseUrl: proxyBaseUrl,
      env,
    };
  }

  async shutdown() {
    const server = this.server;
    this.server = undefined;
    this.target = undefined;
    this.proxyBaseUrl = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async ensureStarted(target: ProxyTarget) {
    if (this.server && this.proxyBaseUrl) {
      this.target = target;
      return this.proxyBaseUrl;
    }

    this.target = target;
    this.server = http.createServer((request, response) => {
      void this.forward(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    const upstreamPath = new URL(target.upstreamBaseUrl).pathname.replace(/\/$/, "");
    this.proxyBaseUrl = `http://127.0.0.1:${address.port}${upstreamPath || "/v1"}`;
    return this.proxyBaseUrl;
  }

  private async forward(request: http.IncomingMessage, response: http.ServerResponse) {
    const target = this.target;
    if (!target) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Model runtime proxy is not ready." } }));
      return;
    }

    try {
      const upstream = new URL(target.upstreamBaseUrl);
      const proxyPrefix = new URL(this.proxyBaseUrl ?? "http://127.0.0.1/v1").pathname.replace(/\/$/, "");
      const incomingUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const incomingPath = incomingUrl.pathname;
      const suffix = proxyPrefix && incomingPath.startsWith(proxyPrefix)
        ? incomingPath.slice(proxyPrefix.length)
        : incomingPath;
      upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
      upstream.search = incomingUrl.search;

      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (!value || ["host", "connection", "content-length"].includes(key.toLowerCase())) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("authorization", `Bearer ${target.upstreamApiKey}`);

      const upstreamResponse = await fetch(upstream, {
        method: request.method,
        headers,
        body: allowsBody(request.method) ? request : undefined,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers.entries()));
      if (upstreamResponse.body) {
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
      } else {
        response.end();
      }
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : "Model runtime proxy request failed.",
        },
      }));
    }
  }
}

function needsProxyApiKey(apiKey: string) {
  return apiKey.trim().length > 0 && apiKey.trim().length < 4;
}

function allowsBody(method?: string) {
  return !["GET", "HEAD"].includes((method ?? "GET").toUpperCase());
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export const testOnly = {
  needsProxyApiKey,
};
