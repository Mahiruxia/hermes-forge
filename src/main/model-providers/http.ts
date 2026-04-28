import type { ModelConnectionTestResult } from "../../shared/types";

const RETRYABLE_STATUS = new Set([408, 409, 425, 500, 502, 503, 504]);

export async function fetchWithRetry(url: string, init: RequestInit, options: {
  attempts?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
} = {}) {
  const attempts = options.attempts ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 15000;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts - 1) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await sleep(initialDelayMs * 2 ** attempt);
  }

  throw lastError instanceof Error ? lastError : new Error("fetch failed");
}

export function httpFailureCategory(status: number): NonNullable<ModelConnectionTestResult["failureCategory"]> {
  if (status === 401 || status === 403) return "auth_invalid";
  if (status === 404) return "path_invalid";
  if (status >= 500) return "server_error";
  return "unknown";
}

export function httpFailureFix(status: number, baseUrl: string) {
  if (status === 401 || status === 403) return "请确认 provider 和 API Key 对得上。";
  if (status === 404) return `请确认地址是否指向兼容接口：${baseUrl}`;
  if (status === 429) return "模型服务返回限流或额度不足（HTTP 429）。请等额度恢复、降低测试频率，或更换有剩余额度的 Key/中转站；Forge 不会自动重试 429，避免继续消耗额度。";
  if (status >= 500) return "服务端当前异常，请确认模型服务已经完整启动。";
  return "请重新检查地址、模型名和鉴权方式。";
}

export function httpFailureMessage(status: number, statusText: string, baseUrl: string) {
  if (status === 404) return `已经连到服务器，但接口路径不对（HTTP 404）：${baseUrl}`;
  return `模型服务返回 HTTP ${status}${statusText ? ` ${statusText}` : ""}。`;
}

export function compactPreview(input: string, maxLength = 220) {
  const compact = input.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

export function isOptionalModelDiscoveryStatus(status: number) {
  return status === 400 || status === 404 || status === 405 || status === 501;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
