import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const migrationsDir = join(root, "drizzle");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required to run migrations.");
  process.exit(1);
}

let parsedUrl;
try {
  parsedUrl = new URL(databaseUrl);
} catch {
  console.error("DATABASE_URL is not a valid URL.");
  process.exit(1);
}
if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
  console.error("DATABASE_URL must use postgres:// or postgresql:// for migrations.");
  process.exit(1);
}

const appEnv = (process.env.APP_ENV || "").toLowerCase();
const vercelEnv = (process.env.VERCEL_ENV || "").toLowerCase();
const production = appEnv === "production" || vercelEnv === "production";
if (production) {
  const host = parsedUrl.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
    console.error("Refusing to run production migrations against a localhost DATABASE_URL.");
    process.exit(1);
  }
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('tandem_migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS tandem_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const { rows } = await client.query("SELECT id FROM tandem_migrations WHERE id = $1", [file]);
    if (rows.length > 0) {
      console.log(`already applied ${file}`);
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), "utf8");
    console.log(`applying ${file}`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO tandem_migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  console.log("migrations complete");
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('tandem_migrations'))").catch(() => undefined);
  client.release();
  await pool.end();
}
