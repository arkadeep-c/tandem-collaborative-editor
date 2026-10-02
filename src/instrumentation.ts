/**
 * Next.js instrumentation hook — runs once at server startup.
 * Validates critical env vars and fails fast with actionable messages.
 */
export async function register() {
  // Only run on server, not in edge runtime
  if (process.env.NEXT_RUNTIME === "nodejs" || !process.env.NEXT_RUNTIME) {
    const isProd = process.env.NODE_ENV === "production";
    const isPreview = process.env.APP_ENV === "preview" || process.env.USE_LOCAL_DEV_DB === "true";

    if (isProd && !isPreview) {
      const secret = process.env.SESSION_SECRET;
      if (!secret || secret.length < 16) {
        const msg =
          "SESSION_SECRET is missing. Configure it in the deployment environment. " +
          "Open the platform's environment variables/secrets configuration, add SESSION_SECRET=<long-random-secret> (>=16 chars, e.g. 32-byte hex), then redeploy/restart. " +
          "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";
        console.error(`[startup] ${msg}`);
        throw new Error(msg);
      }

      // DATABASE_URL is validated in src/db/index.ts — it will throw if missing in production (non-preview).
    }

    if (isPreview) {
      console.log(`[startup] PREVIEW MODE: using local SQLite fallback DB and in-memory cache where needed (APP_ENV=${process.env.APP_ENV} USE_LOCAL_DEV_DB=${process.env.USE_LOCAL_DEV_DB})`);
      // In preview, still require SESSION_SECRET if provided via .env, but allow ephemeral with warning in dev
      if (isProd) {
        const secret = process.env.SESSION_SECRET;
        if (!secret || secret.length < 16) {
          const msg =
            "SESSION_SECRET is missing in preview production. Configure it in .env or environment. " +
            "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";
          console.error(`[startup] ${msg}`);
          throw new Error(msg);
        }
      }
    }

    // Log cookie mode for diagnostics (no secrets)
    const secureEnv = process.env.SESSION_COOKIE_SECURE;
    const sameSiteEnv = process.env.SESSION_COOKIE_SAMESITE;
    const partitionedEnv = process.env.SESSION_COOKIE_PARTITIONED;
    console.log(
      `[startup] cookie mode: NODE_ENV=${process.env.NODE_ENV} APP_ENV=${process.env.APP_ENV} SECURE=${secureEnv ?? (isProd ? "true (default prod)" : "false (default dev)")} SAMESITE=${sameSiteEnv ?? (isProd ? "none (default prod)" : "lax (default dev)")} PARTITIONED=${partitionedEnv ?? (isProd ? "true (default prod)" : "false (default dev)")}`,
    );
  }
}
