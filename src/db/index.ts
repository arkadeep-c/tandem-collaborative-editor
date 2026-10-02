/**
 * Database layer with PostgreSQL as the Vercel/production database and SQLite
 * only as an explicit local/ephemeral fallback.
 *
 * Production deployments (APP_ENV=production or VERCEL_ENV=production):
 *   - DATABASE_URL is required.
 *   - localhost/127.0.0.1 database URLs are rejected.
 *   - USE_LOCAL_DEV_DB is ignored and cannot silently select SQLite.
 *
 * Local/ephemeral development:
 *   - APP_ENV=development, USE_LOCAL_DEV_DB=true, or a missing DATABASE_URL
 *     outside production builds enables the SQLite fallback. Vercel Preview
 *     deployments should provide managed PostgreSQL unless they explicitly opt
 *     into the ephemeral local fallback.
 */

import { ConfigurationError, requireProductionDatabaseUrl, shouldUseLocalDatabase } from "@/lib/deployment";

const globalForDb = globalThis as typeof globalThis & {
  __arenaPgPool?: import("pg").Pool;
  __arenaSqliteDb?: import("better-sqlite3").Database;
  __arenaDrizzleDb?: any;
  __arenaDbMode?: "postgres" | "sqlite";
};

let dbInstance: any;
let poolInstance: import("pg").Pool | null = null;
let sqliteInstance: import("better-sqlite3").Database | null = null;
let roomTemplateModeColumnPromise: Promise<void> | null = null;

function initializeLocalSqlite() {
  const fs = require("fs");
  const path = require("path");
  const Database = require("better-sqlite3");
  const { drizzle } = require("drizzle-orm/better-sqlite3");

  const dbPath = process.env.SQLITE_DB_PATH || path.join(process.cwd(), "data", "tandem.db");
  const dir = path.dirname(dbPath);
  if (dbPath !== ":memory:" && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  console.log(`[db] Using SQLite local fallback at ${dbPath} (APP_ENV=${process.env.APP_ENV} USE_LOCAL_DEV_DB=${process.env.USE_LOCAL_DEV_DB})`);

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'markdown',
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS documents_updated_at_idx ON documents(updated_at);
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      locked INTEGER NOT NULL DEFAULT 0,
      template_mode TEXT NOT NULL DEFAULT 'starter',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rooms_code_unique ON rooms(code);
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor',
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS room_members_user_id_idx ON room_members(user_id);
  `);

  const roomColumns = sqlite.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>;
  if (!roomColumns.some((column) => column.name === "locked")) {
    sqlite.exec("ALTER TABLE rooms ADD COLUMN locked INTEGER NOT NULL DEFAULT 0");
  }
  if (!roomColumns.some((column) => column.name === "template_mode")) {
    sqlite.exec("ALTER TABLE rooms ADD COLUMN template_mode TEXT NOT NULL DEFAULT 'starter'");
  }

  sqliteInstance = sqlite;
  dbInstance = drizzle(sqlite);
  globalForDb.__arenaSqliteDb = sqlite;
  globalForDb.__arenaDrizzleDb = dbInstance;
  globalForDb.__arenaDbMode = "sqlite";
}

function initializePostgres() {
  const databaseUrl = requireProductionDatabaseUrl();
  const { Pool } = require("pg");
  const { drizzle } = require("drizzle-orm/node-postgres");

  const pool =
    globalForDb.__arenaPgPool ??
    new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.POSTGRES_POOL_MAX ?? (process.env.VERCEL ? 1 : 10)),
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
    });

  globalForDb.__arenaPgPool = pool;
  poolInstance = pool;
  dbInstance = drizzle(pool);
  globalForDb.__arenaDrizzleDb = dbInstance;
  globalForDb.__arenaDbMode = "postgres";
}

function initializeDb(): any {
  if (dbInstance) return dbInstance;
  if (globalForDb.__arenaDrizzleDb) {
    dbInstance = globalForDb.__arenaDrizzleDb;
    poolInstance = globalForDb.__arenaPgPool ?? null;
    sqliteInstance = globalForDb.__arenaSqliteDb ?? null;
    return dbInstance;
  }

  if (shouldUseLocalDatabase()) {
    initializeLocalSqlite();
  } else {
    initializePostgres();
  }

  return dbInstance;
}

export const db = new Proxy({} as any, {
  get(_target, prop) {
    const instance = initializeDb();
    const value = instance[prop as keyof typeof instance];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export function getDb(): any {
  return initializeDb();
}

export function getPgPool(): import("pg").Pool | null {
  initializeDb();
  return poolInstance;
}

export const pool = null as import("pg").Pool | null;
export const sqliteDb = null as import("better-sqlite3").Database | null;

export async function ensureRoomTemplateModeColumn(): Promise<void> {
  if (shouldUseLocalDatabase()) return;
  const pool = getPgPool();
  if (!pool) return;

  roomTemplateModeColumnPromise ??= pool
    .query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS template_mode TEXT NOT NULL DEFAULT 'starter'")
    .then(() => undefined);

  await roomTemplateModeColumnPromise;
}

export function isUsingLocalDb(): boolean {
  return shouldUseLocalDatabase();
}

export function getDbMode(): "postgres" | "sqlite" {
  if (globalForDb.__arenaDbMode) return globalForDb.__arenaDbMode;
  return shouldUseLocalDatabase() ? "sqlite" : "postgres";
}

export function assertDatabaseConfigured(): void {
  if (shouldUseLocalDatabase()) return;
  try {
    requireProductionDatabaseUrl();
  } catch (err) {
    if (err instanceof ConfigurationError) throw err;
    throw new ConfigurationError("DATABASE_URL is required for production PostgreSQL.");
  }
}
