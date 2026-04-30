import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureOfficialHermesHomeLink } from "./hermes-home";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
  tempDirs.push(dir);
  return dir;
}

describe("ensureOfficialHermesHomeLink", () => {
  it("does not replace an existing official home that only contains dotfiles", async () => {
    const root = await tempRoot();
    const forgeHome = path.join(root, "forge-home");
    const officialHome = path.join(root, ".hermes");
    await fs.mkdir(forgeHome, { recursive: true });
    await fs.mkdir(officialHome, { recursive: true });
    await fs.writeFile(path.join(officialHome, ".env"), "OPENAI_API_KEY=keep-me", "utf8");

    const result = await ensureOfficialHermesHomeLink(forgeHome, officialHome);

    expect(result.linked).toBe(false);
    await expect(fs.readFile(path.join(officialHome, ".env"), "utf8")).resolves.toBe("OPENAI_API_KEY=keep-me");
  });

  it("does not replace an existing official home symlink that points elsewhere", async () => {
    const root = await tempRoot();
    const forgeHome = path.join(root, "forge-home");
    const otherHome = path.join(root, "other-home");
    const officialHome = path.join(root, ".hermes");
    await fs.mkdir(forgeHome, { recursive: true });
    await fs.mkdir(otherHome, { recursive: true });
    await fs.symlink(otherHome, officialHome, process.platform === "win32" ? "junction" : "dir");

    const result = await ensureOfficialHermesHomeLink(forgeHome, officialHome);

    expect(result.linked).toBe(false);
    await expect(fs.realpath(officialHome)).resolves.toBe(await fs.realpath(otherHome));
  });
});
