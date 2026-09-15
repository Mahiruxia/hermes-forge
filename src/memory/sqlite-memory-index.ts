import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { ContextBundle, ContextSource } from "../shared/types";

let sqlPromise: Promise<SqlJsStatic> | undefined;

function locateSqlWasm(file: string) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, file) : "",
    path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
    path.join(__dirname, "..", "..", "..", "node_modules", "sql.js", "dist", file),
  ].filter(Boolean);

  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: locateSqlWasm });
  }
  return sqlPromise;
}

export class SqliteMemoryIndex {
  private db?: Database;

  constructor(private readonly dbPath: string) {}

  async open() {
    if (this.db) {
      return this.db;
    }

    const SQL = await getSql();
    const existing = await fs.readFile(this.dbPath).catch(() => undefined);
    this.db = existing ? new SQL.Database(existing) : new SQL.Database();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS context_sources (
        id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        engine_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        pointer TEXT NOT NULL,
        characters INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_bundles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        policy TEXT NOT NULL,
        summary TEXT NOT NULL,
        used_characters INTEGER NOT NULL,
        max_characters INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    await this.flush();
    return this.db;
  }

  async recordBundle(bundle: ContextBundle) {
    const db = await this.open();
    db.run(
      `INSERT OR REPLACE INTO context_bundles
       (id, workspace_id, policy, summary, used_characters, max_characters, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bundle.id,
        bundle.workspaceId,
        bundle.policy,
        bundle.summary,
        bundle.usedCharacters,
        bundle.maxCharacters,
        bundle.expiresAt,
        bundle.createdAt,
      ],
    );

    for (const source of bundle.sources) {
      await this.recordSource(bundle.id, source);
    }

    await this.flush();
  }

  private async recordSource(bundleId: string, source: ContextSource) {
    const db = await this.open();
    db.run(
      `INSERT OR REPLACE INTO context_sources
       (id, bundle_id, engine_id, title, summary, pointer, characters, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        source.id,
        bundleId,
        source.engineId,
        source.title,
        source.summary,
        source.pointer,
        source.characters,
        source.createdAt,
      ],
    );
  }

  private async flush() {
    if (!this.db) {
      return;
    }
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    await fs.writeFile(this.dbPath, Buffer.from(this.db.export()));
  }
}
