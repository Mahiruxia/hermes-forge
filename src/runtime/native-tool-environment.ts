import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Discover existing tools without running installers or changing the user's PATH. */
export function nativeToolEnvironment(rootPath: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  const homes = [path.dirname(rootPath), env.HERMES_HOME, path.join(os.homedir(), ".hermes")]
    .filter((entry): entry is string => Boolean(entry));
  const candidates = homes.flatMap((home) => [
    path.join(home, "bin"),
    ...(windows ? [path.join(home, "git", "cmd"), path.join(home, "git", "bin"), path.join(home, "git", "usr", "bin")] : []),
  ]);
  candidates.push(path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".cargo", "bin"));
  if (process.platform === "darwin") candidates.push("/opt/homebrew/bin", "/usr/local/bin");
  const inherited = env.PATH ?? env.Path ?? "";
  const entries = [...inherited.split(path.delimiter), ...candidates.filter((entry) => {
    try { return fs.statSync(entry).isDirectory(); } catch { return false; }
  })].filter(Boolean);
  const seen = new Set<string>();
  const result = { ...env };
  if (windows) {
    for (const key of Object.keys(result)) if (key.toLowerCase() === "path") delete result[key];
  }
  result.PATH = entries.filter((entry) => {
    const key = windows ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(path.delimiter);
  if (windows && !result.HERMES_GIT_BASH_PATH) {
    result.HERMES_GIT_BASH_PATH = homes.flatMap((home) => [
      path.join(home, "git", "bin", "bash.exe"), path.join(home, "git", "usr", "bin", "bash.exe"),
    ]).find((entry) => { try { return fs.statSync(entry).isFile(); } catch { return false; } });
  }
  return result;
}

/** Windows environment keys are case insensitive, including PATH overrides. */
export function mergeProcessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (process.platform === "win32") {
      for (const inheritedKey of Object.keys(result)) {
        if (inheritedKey.toLowerCase() === key.toLowerCase()) delete result[inheritedKey];
      }
    }
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}
