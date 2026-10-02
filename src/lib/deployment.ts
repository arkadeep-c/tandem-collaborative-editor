export class ConfigurationError extends Error {
  readonly status = 500;

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function appEnv(): string {
  return (process.env.APP_ENV || "").toLowerCase();
}

export function vercelEnv(): string {
  return (process.env.VERCEL_ENV || "").toLowerCase();
}

export function isProductionDeployment(): boolean {
  return appEnv() === "production" || vercelEnv() === "production";
}

export function isPreviewDeployment(): boolean {
  return appEnv() === "preview" || vercelEnv() === "preview";
}

export function isLocalDevelopment(): boolean {
  return process.env.NODE_ENV !== "production" || appEnv() === "development";
}

export function allowsLocalDatabaseFallback(): boolean {
  if (isProductionDeployment()) return false;
  return (
    appEnv() === "development" ||
    process.env.USE_LOCAL_DEV_DB === "true" ||
    (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production")
  );
}

export function shouldUseLocalDatabase(): boolean {
  return allowsLocalDatabaseFallback();
}

export function requireProductionDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigurationError(
      "DATABASE_URL is required for production. Configure a managed PostgreSQL connection string in Vercel; local SQLite is disabled for production.",
    );
  }

  if (isProductionDeployment()) {
    let parsed: URL;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new ConfigurationError("DATABASE_URL is not a valid PostgreSQL connection string.");
    }

    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      throw new ConfigurationError("DATABASE_URL must use a PostgreSQL protocol (postgres:// or postgresql://). SQLite/local file databases are disabled for production.");
    }

    const host = parsed.hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
      throw new ConfigurationError(
        "DATABASE_URL points at a local host. Production must use a managed PostgreSQL database reachable from Vercel.",
      );
    }
  }

  return databaseUrl;
}

export function productionRequiresRedis(): boolean {
  return isProductionDeployment();
}

export function shouldUseRedisRealtime(): boolean {
  return productionRequiresRedis() || Boolean(process.env.REDIS_URL);
}

export function publicConfigSummary() {
  return {
    appEnv: process.env.APP_ENV ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    production: isProductionDeployment(),
    preview: isPreviewDeployment(),
    localDatabase: shouldUseLocalDatabase(),
    redisConfigured: Boolean(process.env.REDIS_URL),
    redisRealtime: shouldUseRedisRealtime(),
  };
}
