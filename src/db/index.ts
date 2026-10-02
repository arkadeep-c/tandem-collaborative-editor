/**
 * Database layer with PostgreSQL as production and SQLite as preview fallback.
 *
 * Production:
 *   DATABASE_URL required (unless explicit preview mode)
 *   Uses pg Pool + drizzle-orm/node-postgres
 *
 * Preview / Development fallback:
 *   When APP_ENV=preview or USE_LOCAL_DEV_DB=true or DATABASE_URL missing in non-production,
 *   uses file-backed SQLite via better-sqlite3 + drizzle-orm/better-sqlite3
 *   File: ./data/tandem.db (or :memory: if configured)
 *
 * This fallback exists ONLY so Arena preview can be genuinely tested without external services.
 * Production must continue requiring PostgreSQL.
 */

function isPreviewMode(): boolean {
  return process.env.APP_ENV === "preview" || process.env.USE_LOCAL_DEV_DB === "true";
}

function shouldUseLocalDb(): boolean {
  // Explicit preview flag takes precedence
  if (isPreviewMode()) return true;
  // In non-production, if DATABASE_URL missing, use local fallback
  if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") return true;
  return false;
}

// Global cache to avoid multiple connections in dev HMR
const globalForDb = globalThis as typeof globalThis & {
  __arenaPgPool?: import("pg").Pool;
  __arenaSqliteDb?: import("better-sqlite3").Database;
  __arenaDrizzleDb?: any;
};

let dbInstance: any;
let poolInstance: import("pg").Pool | null = null;
let sqliteInstance: import("better-sqlite3").Database | null = null;

if (globalForDb.__arenaDrizzleDb) {
  dbInstance = globalForDb.__arenaDrizzleDb;
  // @ts-ignore
  poolInstance = globalForDb.__arenaPgPool ?? null;
  // @ts-ignore
  sqliteInstance = globalForDb.__arenaSqliteDb ?? null;
} else if (shouldUseLocalDb()) {
  // SQLite preview fallback
  const fs = require("fs");
  const path = require("path");
  const Database = require("better-sqlite3");
  const { drizzle } = require("drizzle-orm/better-sqlite3");

  const dbPath = process.env.SQLITE_DB_PATH || path.join(process.cwd(), "data", "tandem.db");

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  console.log(`[db] Using SQLite preview fallback at ${dbPath} (APP_ENV=${process.env.APP_ENV} USE_LOCAL_DEV_DB=${process.env.USE_LOCAL_DEV_DB})`);

  const sqlite = new Database(dbPath);
  // Enable WAL for better concurrency and foreign keys
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Create tables if not exist — matches schema.ts sqlite definitions
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

  dbInstance = drizzle(sqlite);
  sqliteInstance = sqlite;

  if (process.env.NODE_ENV !== "production") {
    globalForDb.__arenaSqliteDb = sqlite;
    globalForDb.__arenaDrizzleDb = dbInstance;
  }
} else {
  // PostgreSQL production path
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (set APP_ENV=preview or USE_LOCAL_DEV_DB=true for local fallback)");
  }

  const { Pool } = require("pg");
  const { drizzle } = require("drizzle-orm/node-postgres");

  const pool =
    globalForDb.__arenaPgPool ??
    new Pool({
      connectionString: databaseUrl,
    });

  if (process.env.NODE_ENV !== "production") {
    globalForDb.__arenaPgPool = pool;
  }

  dbInstance = drizzle(pool);
  poolInstance = pool;

  if (process.env.NODE_ENV !== "production") {
    globalForDb.__arenaDrizzleDb = dbInstance;
  }
}

export const pool = poolInstance;
export const sqliteDb = sqliteInstance;
export const db = dbInstance;

let roomTemplateModeColumnPromise: Promise<void> | null = null;

export async function ensureRoomTemplateModeColumn(): Promise<void> {
  if (shouldUseLocalDb()) return;
  if (!poolInstance) return;

  roomTemplateModeColumnPromise ??= poolInstance
    .query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS template_mode TEXT NOT NULL DEFAULT 'starter'")
    .then(() => undefined);

  await roomTemplateModeColumnPromise;
}

export function isUsingLocalDb(): boolean {
  return shouldUseLocalDb();
}

export function getDbMode(): "postgres" | "sqlite" {
  return shouldUseLocalDb() ? "sqlite" : "postgres";
}
