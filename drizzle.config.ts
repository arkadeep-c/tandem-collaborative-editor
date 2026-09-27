import { defineConfig } from "drizzle-kit";

/**
 * Schema management config. DATABASE_URL comes from the environment
 * (.env locally, compose env in Docker); the localhost fallback matches
 * the sandbox default.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  },
});
