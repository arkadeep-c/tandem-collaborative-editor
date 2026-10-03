function appEnv(): string {
  return (process.env.APP_ENV || "").toLowerCase();
}

function vercelEnv(): string {
  return (process.env.VERCEL_ENV || "").toLowerCase();
}

function isProductionDeployment(): boolean {
  return appEnv() === "production" || vercelEnv() === "production";
}

function assertProductionDatabaseUrl(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for production. Configure a managed PostgreSQL connection string in Vercel.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL connection string.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql:// in production.");
  }
  const host = parsed.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
    throw new Error("DATABASE_URL must not point to localhost in production.");
  }
}

function assertSessionSecret(): void {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "SESSION_SECRET is missing or too short. Configure SESSION_SECRET=<long-random-secret> in Vercel and redeploy.",
    );
  }
}

/**
 * Next.js instrumentation hook — validates deployment-critical configuration.
 * Keep this file free of Node-only imports because Next also bundles an Edge
 * instrumentation entry during production builds.
 */
export async function register() {
  const production = isProductionDeployment();

  if (production) {
    assertSessionSecret();
    assertProductionDatabaseUrl();
    if (!process.env.REDIS_URL) {
      throw new Error(
        "REDIS_URL is required for production realtime collaboration on Vercel. Configure managed Redis/Valkey and redeploy.",
      );
    }
  }

  const configSummary = {
    appEnv: process.env.APP_ENV ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    production,
    redisConfigured: Boolean(process.env.REDIS_URL),
  };
  const secureEnv = process.env.SESSION_COOKIE_SECURE;
  const sameSiteEnv = process.env.SESSION_COOKIE_SAMESITE;
  const partitionedEnv = process.env.SESSION_COOKIE_PARTITIONED;
  console.log(
    `[startup] config=${JSON.stringify(configSummary)} cookie SECURE=${secureEnv ?? (production ? "true (default prod)" : "false (default dev)")} SAMESITE=${sameSiteEnv ?? "lax (default)"} PARTITIONED=${partitionedEnv ?? "false (default)"}`,
  );
}
