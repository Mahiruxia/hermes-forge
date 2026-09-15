import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const writers = new Map<string, Promise<unknown>>();

/** All Forge writers of one Hermes home share this queue, including failed writes. */
export async function withHermesHomeLock<T>(home: string, work: () => Promise<T>): Promise<T> {
  const resolved = await fs.realpath(home).catch(() => path.resolve(home));
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = writers.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  writers.set(key, current);
  try {
    return await current;
  } finally {
    if (writers.get(key) === current) writers.delete(key);
  }
}

export async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Same-directory replacement never exposes a truncated configuration to readers. */
export async function atomicWriteText(filePath: string, text: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, text, { encoding: "utf8", mode });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
