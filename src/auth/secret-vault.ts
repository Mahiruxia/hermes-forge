import fs from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";

type SecretMetadata = { createdAt: string; updatedAt: string; lastUsedAt?: string; corruptedAt?: string; lastError?: string };

type VaultFile = {
  mode: "safe-storage";
  items: Record<string, string>;
  metadata?: Record<string, SecretMetadata>;
};

export class SecretVault {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly vaultPath: string) {}

  async status() {
    return {
      available: safeStorage.isEncryptionAvailable(),
      mode: "safe-storage" as const,
      path: this.vaultPath,
      message: "凭证只在主进程通过 Electron safeStorage 加密保存，Renderer 不接触明文。",
    };
  }

  async saveSecret(ref: string, plainText: string) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("当前系统不可用安全存储，无法保存凭证。");
    }

    return this.withMutation(async () => {
      const vault = await this.readVault();
      const at = new Date().toISOString();
      vault.items[ref] = safeStorage.encryptString(plainText).toString("base64");
      vault.metadata ??= {};
      vault.metadata[ref] = {
        createdAt: vault.metadata[ref]?.createdAt ?? at,
        updatedAt: at,
        lastUsedAt: vault.metadata[ref]?.lastUsedAt,
      };
      await this.writeVault(vault);
      return { secretRef: ref };
    });
  }

  async readSecret(ref: string) {
    return this.withMutation(async () => {
      const vault = await this.readVault();
      const encrypted = vault.items[ref];
      if (!encrypted) {
        return undefined;
      }
      let plainText: string | undefined;
      try {
        plainText = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      } catch (error) {
        vault.metadata ??= {};
        const at = new Date().toISOString();
        vault.metadata[ref] = {
          createdAt: vault.metadata[ref]?.createdAt ?? at,
          updatedAt: vault.metadata[ref]?.updatedAt ?? at,
          lastUsedAt: vault.metadata[ref]?.lastUsedAt,
          corruptedAt: at,
          lastError: error instanceof Error ? error.message : String(error),
        };
        await this.writeVault(vault);
        return undefined;
      }

      vault.metadata ??= {};
      if (vault.metadata[ref]) {
        vault.metadata[ref] = {
          ...vault.metadata[ref],
          lastUsedAt: new Date().toISOString(),
        };
        await this.writeVault(vault);
      }
      return plainText;
    });
  }

  async hasSecret(ref: string) {
    await this.mutationQueue;
    const vault = await this.readVault();
    const encrypted = vault.items[ref];
    if (!encrypted) {
      return false;
    }
    try {
      safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      return true;
    } catch {
      return false;
    }
  }

  async getSecretMeta(ref: string) {
    await this.mutationQueue;
    const vault = await this.readVault();
    return vault.metadata?.[ref];
  }

  async listSecretMeta() {
    await this.mutationQueue;
    const vault = await this.readVault();
    return Object.keys({ ...vault.items, ...(vault.metadata ?? {}) }).map((ref) => ({
      ref,
      exists: Boolean(vault.items[ref]),
      ...(vault.metadata?.[ref] ?? {}),
    }));
  }

  async deleteSecret(ref: string) {
    return this.withMutation(async () => {
      const vault = await this.readVault();
      const existed = Boolean(vault.items[ref]);
      delete vault.items[ref];
      if (vault.metadata) {
        delete vault.metadata[ref];
      }
      await this.writeVault(vault);
      return { ref, existed };
    });
  }

  private async readVault(): Promise<VaultFile> {
    const raw = await fs.readFile(this.vaultPath, "utf8").catch(() => undefined);
    if (!raw) {
      return { mode: "safe-storage", items: {}, metadata: {} };
    }
    const parsed = JSON.parse(raw) as VaultFile;
    return {
      mode: parsed.mode ?? "safe-storage",
      items: parsed.items ?? {},
      metadata: parsed.metadata ?? {},
    };
  }

  private async writeVault(vault: VaultFile) {
    const directory = path.dirname(this.vaultPath);
    const tempPath = `${this.vaultPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(tempPath, JSON.stringify(vault, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempPath, this.vaultPath);
      await fs.chmod(this.vaultPath, 0o600).catch(() => undefined);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private withMutation<T>(operation: () => Promise<T>) {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
