import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is required for Drizzle schema commands. Use a managed PostgreSQL URL for production migrations.",
  );
}

const parsed = new URL(url);
if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
  throw new Error("DATABASE_URL must use postgres:// or postgresql:// for Drizzle schema commands.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
