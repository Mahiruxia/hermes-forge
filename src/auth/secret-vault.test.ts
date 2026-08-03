import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const decryptString = vi.fn((buffer: Buffer) => buffer.toString("utf8"));
const tempDirs: string[] = [];

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString,
  },
}));

describe("SecretVault", () => {
  beforeEach(() => {
    decryptString.mockImplementation((buffer: Buffer) => buffer.toString("utf8"));
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("returns undefined instead of throwing when a stored ciphertext is corrupted", async () => {
    const { SecretVault } = await import("./secret-vault");
    const dir = await fs.mkdtemp(path.join(tmpdir(), "secret-vault-"));
    tempDirs.push(dir);
    const vaultPath = path.join(dir, "secrets.enc");
    await fs.writeFile(vaultPath, JSON.stringify({
      mode: "safe-storage",
      items: { "provider.openrouter.apiKey": Buffer.from("broken").toString("base64") },
      metadata: {},
    }), "utf8");
    decryptString.mockImplementation(() => {
      throw new Error("cannot decrypt");
    });

    const vault = new SecretVault(vaultPath);

    await expect(vault.readSecret("provider.openrouter.apiKey")).resolves.toBeUndefined();
    await expect(vault.hasSecret("provider.openrouter.apiKey")).resolves.toBe(false);
    await expect(vault.getSecretMeta("provider.openrouter.apiKey")).resolves.toMatchObject({
      lastError: "cannot decrypt",
    });
  });

  it("serializes concurrent writes without losing secrets", async () => {
    const { SecretVault } = await import("./secret-vault");
    const dir = await fs.mkdtemp(path.join(tmpdir(), "secret-vault-"));
    tempDirs.push(dir);
    const vaultPath = path.join(dir, "secrets.enc");
    const vault = new SecretVault(vaultPath);

    await Promise.all([
      vault.saveSecret("provider.openai.apiKey", "openai-key"),
      vault.saveSecret("provider.anthropic.apiKey", "anthropic-key"),
      vault.saveSecret("provider.openrouter.apiKey", "openrouter-key"),
    ]);

    await expect(vault.readSecret("provider.openai.apiKey")).resolves.toBe("openai-key");
    await expect(vault.readSecret("provider.anthropic.apiKey")).resolves.toBe("anthropic-key");
    await expect(vault.readSecret("provider.openrouter.apiKey")).resolves.toBe("openrouter-key");
    await expect(fs.readdir(dir)).resolves.toEqual(["secrets.enc"]);
  });
});
