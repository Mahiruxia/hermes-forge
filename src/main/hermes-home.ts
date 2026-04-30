import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Returns the path the official Hermes CLI would use as its home directory
 * when no HERMES_HOME environment variable is set.
 *
 * On Windows this is `%USERPROFILE%\.hermes`; elsewhere `~/.hermes`.
 */
export function defaultOfficialHermesHome(): string {
  return path.join(os.homedir(), ".hermes");
}

/**
 * Ensures the official Hermes home directory (the one the standalone CLI would
 * use) points at the Forge-managed home so that configurations written by Forge
 * are visible to `hermes` invocations that happen outside of Forge.
 *
 * On Windows this is implemented via an NTFS junction (no elevated permissions
 * required). On other platforms a symlink is used.
 *
  * If the official home already exists and is not already pointing at Forge,
  * the function refuses to modify it. Even dotfiles can contain API keys,
  * OAuth tokens, memory, or other Hermes state, so startup must never delete
  * or replace a real user-owned home automatically.
 */
export async function ensureOfficialHermesHomeLink(
  forgeHome: string,
  officialHome: string = defaultOfficialHermesHome(),
): Promise<{ linked: boolean; reason?: string }> {
  // Nothing to do when both paths resolve to the same location.
  const realForge = await fs.realpath(forgeHome).catch(() => forgeHome);
  try {
    const stat = await fs.lstat(officialHome);
    if (stat.isSymbolicLink()) {
      const target = await fs.realpath(officialHome).catch(() => officialHome);
      if (target === realForge) return { linked: true };
      return {
        linked: false,
        reason: `官方 Hermes home (${officialHome}) 已链接到其他位置 (${target})，未自动替换。`,
      };
    } else if (stat.isDirectory()) {
      return {
        linked: false,
        reason: `官方 Hermes home (${officialHome}) 已存在，未自动覆盖。如需合并请通过迁移/导入流程处理。`,
      };
    } else {
      return {
        linked: false,
        reason: `官方 Hermes home (${officialHome}) 已存在但不是目录或链接，未自动修改。`,
      };
    }
  } catch {
    // Does not exist — fine, we'll create it.
  }

  // Ensure parent directory exists.
  await fs.mkdir(path.dirname(officialHome), { recursive: true });

  if (process.platform === "win32") {
    // NTFS junction — no elevation required, works across volumes.
    await fs.symlink(realForge, officialHome, "junction");
  } else {
    await fs.symlink(realForge, officialHome, "dir");
  }
  return { linked: true };
}

export async function resolveActiveHermesHome(baseHome: string) {
  const activeProfile = (await fs.readFile(path.join(baseHome, "active_profile"), "utf8").catch(() => "")).trim();
  if (!activeProfile || /[\\/]/.test(activeProfile)) {
    return baseHome;
  }
  const candidate = path.join(baseHome, "profiles", activeProfile);
  const stat = await fs.stat(candidate).catch(() => undefined);
  return stat?.isDirectory() ? candidate : baseHome;
}

export async function ensureHermesHomeLayout(baseHome: string) {
  await fs.mkdir(baseHome, { recursive: true });
  await fs.mkdir(path.join(baseHome, "skills"), { recursive: true });
  await fs.mkdir(path.join(baseHome, "memories"), { recursive: true });
  await fs.mkdir(path.join(baseHome, "cron"), { recursive: true });
  await fs.mkdir(path.join(baseHome, "profiles"), { recursive: true });
  await migrateLegacyMemoryFile(baseHome, "USER.md", "# USER\n\n");
  await migrateLegacyMemoryFile(baseHome, "MEMORY.md", "# MEMORY\n\n");
}

async function migrateLegacyMemoryFile(baseHome: string, fileName: "USER.md" | "MEMORY.md", defaultContent: string) {
  const modernPath = path.join(baseHome, "memories", fileName);
  const legacyPath = path.join(baseHome, fileName);
  const modernExists = await fs.stat(modernPath).then((stat) => stat.isFile()).catch(() => false);
  if (!modernExists) {
    const legacyContent = await fs.readFile(legacyPath, "utf8").catch(() => "");
    await fs.writeFile(modernPath, legacyContent || defaultContent, "utf8");
  }
}
