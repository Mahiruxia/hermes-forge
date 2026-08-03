import path from "node:path";
import { fileURLToPath } from "node:url";

export type TrustedAppUrlOptions = {
  builtEntryPath: string;
  devServerUrl?: string;
  platform?: NodeJS.Platform;
};

export function isTrustedAppUrl(value: string, options: TrustedAppUrlOptions) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return normalizeComparablePath(fileURLToPath(url), options.platform)
        === normalizeComparablePath(options.builtEntryPath, options.platform);
    }
    return options.devServerUrl
      ? url.origin === new URL(options.devServerUrl).origin
      : false;
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function normalizeComparablePath(value: string, platform = process.platform) {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}
