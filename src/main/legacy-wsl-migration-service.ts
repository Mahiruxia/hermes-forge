import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../process/command-runner";
import type { AppPaths } from "./app-paths";
import type { RuntimeConfigStore } from "./runtime-config";
import type { SecretVault } from "../auth/secret-vault";
import type { HermesConnectorService } from "./hermes-connector-service";
import { importExistingHermesConfig } from "./hermes-existing-config-import";
import { resolveActiveHermesHome } from "./hermes-home";
import type {
  LegacyWslMigrationImportOptions,
  LegacyWslMigrationPreview,
  LegacyWslMigrationReport,
  LegacyWslMigrationSource,
} from "../shared/types";

export class LegacyWslMigrationService {
  private lastReport?: LegacyWslMigrationReport;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly configStore: RuntimeConfigStore,
    private readonly secretVault: SecretVault,
    private readonly hermesConnectorService: Pick<HermesConnectorService, "importFromEnvValues">,
  ) {}

  async detect(): Promise<LegacyWslMigrationPreview> {
    return this.preview();
  }

  async preview(sourcePath?: string): Promise<LegacyWslMigrationPreview> {
    const sources = sourcePath
      ? [await this.inspectManualSource(sourcePath)]
      : await this.detectSources();
    const source = bestMigrationSource(sources);
    return {
      ok: Boolean(source),
      source,
      sources,
      importable: {
        model: Boolean(source?.hasConfig || source?.hasEnv),
        connectors: Boolean(source?.hasEnv),
        skillsCount: source?.skillsCount ?? 0,
      },
      warnings: source ? [] : ["没有发现旧 WSL Hermes 配置。"],
      message: source
        ? `发现可迁移配置：${source.homePath}`
        : "没有发现可迁移的旧 WSL Hermes 配置。",
    };
  }

  async import(options: LegacyWslMigrationImportOptions = {}): Promise<LegacyWslMigrationReport> {
    const preview = await this.preview(options.sourcePath);
    const source = preview.source;
    if (!source) {
      const report: LegacyWslMigrationReport = {
        ok: false,
        hermesHome: options.sourcePath ?? "",
        importedModel: false,
        importedConnectors: [],
        importedSecretRefs: [],
        warnings: preview.warnings,
        message: preview.message,
        importedSkills: [],
        skippedSkills: [],
        skillConflicts: [],
      };
      this.lastReport = report;
      return report;
    }

    const imported = await importExistingHermesConfig({
      configStore: this.configStore,
      secretVault: this.secretVault,
      hermesConnectorService: this.hermesConnectorService,
      hermesHomeBase: () => source.homePath,
    });
    const skills = await this.importSkills(source.homePath, { overwrite: options.overwriteSkills === true });
    const report: LegacyWslMigrationReport = {
      ...imported,
      ok: imported.ok || skills.importedSkills.length > 0,
      source,
      importedSkills: skills.importedSkills,
      skippedSkills: skills.skippedSkills,
      skillConflicts: skills.skillConflicts,
      warnings: [
        ...imported.warnings,
        ...skills.warnings,
      ],
      message: [
        imported.message,
        skills.importedSkills.length ? `已导入 ${skills.importedSkills.length} 个 skill` : undefined,
        skills.skillConflicts.length ? `${skills.skillConflicts.length} 个 skill 因同名冲突已跳过` : undefined,
      ].filter(Boolean).join("；"),
    };
    this.lastReport = report;
    return report;
  }

  getLastReport() {
    return this.lastReport;
  }

  private async detectSources(): Promise<LegacyWslMigrationSource[]> {
    if (process.platform !== "win32") return [];
    const distros = await this.listDistros();
    const sources: LegacyWslMigrationSource[] = [];
    for (const distro of distros) {
      const homesRoot = `\\\\wsl$\\${distro}\\home`;
      const users = await fs.readdir(homesRoot, { withFileTypes: true }).catch(() => []);
      for (const user of users) {
        if (!user.isDirectory()) continue;
        sources.push(...await this.inspectWslHomeCandidates(path.join(homesRoot, user.name), distro));
      }
      sources.push(...await this.inspectWslHomeCandidates(`\\\\wsl$\\${distro}\\root`, distro));
    }
    return dedupeSources(sources).filter((source) => source.hasConfig || source.hasEnv || source.skillsCount > 0);
  }

  private async listDistros() {
    const result = await runCommand("wsl.exe", ["-l", "-q"], {
      cwd: process.cwd(),
      timeoutMs: 8000,
      runtimeKind: "windows",
      commandId: "legacy-wsl-migration.list-distros",
    }).catch(() => undefined);
    if (result?.exitCode !== 0) return [];
    return (result.stdout ?? "")
      .replace(/\0/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async inspectManualSource(sourcePath: string): Promise<LegacyWslMigrationSource> {
    return this.inspectSource(await this.normalizeHermesHome(sourcePath), { kind: "manual_path" });
  }

  private async inspectWslHomeCandidates(homePath: string, distro: string) {
    const sources: LegacyWslMigrationSource[] = [];
    const baseCandidates = [
      path.join(homePath, ".hermes"),
      path.join(homePath, ".hermes-forge", "hermes-agent"),
    ];
    for (const candidate of baseCandidates) {
      sources.push(await this.inspectSource(candidate, { distro, kind: "wsl_unc" }));
    }

    const entries = await fs.readdir(homePath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^Hermes[ -]?Agent/i.test(entry.name)) continue;
      sources.push(await this.inspectSource(path.join(homePath, entry.name), { distro, kind: "wsl_unc" }));
    }
    return sources;
  }

  private async normalizeHermesHome(sourcePath: string) {
    const trimmed = sourcePath.trim();
    if (!trimmed) return trimmed;
    const direct = await this.hasHermesMarkers(trimmed);
    if (direct) return trimmed;
    const nested = path.join(trimmed, ".hermes");
    return await this.hasHermesMarkers(nested) ? nested : trimmed;
  }

  private async hasHermesMarkers(hermesHome: string) {
    const [config, legacyConfig, env, skills] = await Promise.all([
      exists(path.join(hermesHome, "config.yaml")),
      exists(path.join(hermesHome, "cli-config.yaml")),
      exists(path.join(hermesHome, ".env")),
      exists(path.join(hermesHome, "skills")),
    ]);
    return config || legacyConfig || env || skills;
  }

  private async inspectSource(
    hermesHome: string,
    meta: { distro?: string; kind: LegacyWslMigrationSource["kind"] },
  ): Promise<LegacyWslMigrationSource> {
    const [hasModernConfig, hasLegacyConfig, hasEnv, skillsCount] = await Promise.all([
      exists(path.join(hermesHome, "config.yaml")),
      exists(path.join(hermesHome, "cli-config.yaml")),
      exists(path.join(hermesHome, ".env")),
      countSkillEntries(path.join(hermesHome, "skills")),
    ]);
    const hasConfig = hasModernConfig || hasLegacyConfig;
    return {
      id: `${meta.kind}:${meta.distro ?? "manual"}:${hermesHome}`,
      distro: meta.distro,
      homePath: hermesHome,
      kind: meta.kind,
      hasConfig,
      hasEnv,
      skillsCount,
      message: hasConfig || hasEnv || skillsCount > 0
        ? "发现旧 Hermes 配置。"
        : "该路径下没有发现 config.yaml、.env 或 skills。",
    };
  }

  private async importSkills(sourceHermesHome: string, options: { overwrite: boolean }) {
    const sourceSkillsDir = path.join(sourceHermesHome, "skills");
    const targetHermesHome = await resolveActiveHermesHome(this.appPaths.hermesDir());
    const targetSkillsDir = path.join(targetHermesHome, "skills");
    const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true }).catch(() => []);
    const importedSkills: string[] = [];
    const skippedSkills: string[] = [];
    const skillConflicts: string[] = [];
    const warnings: string[] = [];

    if (entries.length === 0) {
      return { importedSkills, skippedSkills, skillConflicts, warnings };
    }

    await fs.mkdir(targetSkillsDir, { recursive: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const sourcePath = path.join(sourceSkillsDir, entry.name);
      const targetPath = path.join(targetSkillsDir, entry.name);
      const targetExists = await exists(targetPath);
      if (targetExists && !options.overwrite) {
        skippedSkills.push(entry.name);
        skillConflicts.push(entry.name);
        continue;
      }
      try {
        await fs.cp(sourcePath, targetPath, { recursive: true, force: options.overwrite });
        importedSkills.push(entry.name);
      } catch (error) {
        skippedSkills.push(entry.name);
        warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { importedSkills, skippedSkills, skillConflicts, warnings };
  }
}

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function countSkillEntries(skillsDir: string) {
  const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() || entry.isFile()).length;
}

function bestMigrationSource(sources: LegacyWslMigrationSource[]) {
  return sources
    .filter((source) => source.hasConfig || source.hasEnv || source.skillsCount > 0)
    .sort((left, right) => migrationSourceScore(right) - migrationSourceScore(left))[0];
}

function migrationSourceScore(source: LegacyWslMigrationSource) {
  return (source.hasConfig ? 20 : 0)
    + (source.hasEnv ? 12 : 0)
    + Math.min(source.skillsCount, 8);
}

function dedupeSources(sources: LegacyWslMigrationSource[]) {
  const seen = new Set<string>();
  const deduped: LegacyWslMigrationSource[] = [];
  for (const source of sources) {
    const key = `${source.kind}:${source.distro ?? ""}:${source.homePath.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(source);
  }
  return deduped;
}
