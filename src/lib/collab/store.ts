import Redis from "ioredis";
import { ConfigurationError, productionRequiresRedis, shouldUseRedisRealtime } from "@/lib/deployment";

/**
 * Hot-state document cache.
 *
 * Local development can use an in-memory cache. Production Vercel deployments
 * require Redis because active documents, presence, pub/sub fan-out, and rate
 * limits must be shared across independent serverless function instances.
 */

export interface CachedDocument {
  content: string;
  revision: number;
}

export interface DocStore {
  readonly mode: "redis" | "memory";
  get(documentId: string): Promise<CachedDocument | null>;
  set(documentId: string, value: CachedDocument): Promise<void>;
  evict(documentId: string): Promise<void>;
}

const REDIS_TTL_SECONDS = 60 * 60 * 6;
const keyFor = (documentId: string) => `doc:${documentId}`;

class RedisDocStore implements DocStore {
  readonly mode = "redis" as const;

  constructor(private readonly redis: Redis) {}

  async get(documentId: string): Promise<CachedDocument | null> {
    const raw = await this.redis.get(keyFor(documentId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CachedDocument;
      if (typeof parsed.content !== "string" || typeof parsed.revision !== "number") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async set(documentId: string, value: CachedDocument): Promise<void> {
    await this.redis.set(keyFor(documentId), JSON.stringify(value), "EX", REDIS_TTL_SECONDS);
  }

  async evict(documentId: string): Promise<void> {
    await this.redis.del(keyFor(documentId));
  }
}

class MemoryDocStore implements DocStore {
  readonly mode = "memory" as const;
  private readonly map = new Map<string, CachedDocument>();

  async get(documentId: string): Promise<CachedDocument | null> {
    return this.map.get(documentId) ?? null;
  }

  async set(documentId: string, value: CachedDocument): Promise<void> {
    this.map.set(documentId, value);
  }

  async evict(documentId: string): Promise<void> {
    this.map.delete(documentId);
  }
}

declare global {
  var __tandemDocStore: DocStore | undefined;
  var __tandemRedisClient: Redis | undefined;
}

function redisOptions() {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_500,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  } as const;
}

async function createRedisClient(url: string): Promise<Redis> {
  const client = new Redis(url, redisOptions());
  client.on("error", () => {
    /* callers handle probe failure; avoid noisy unhandled errors */
  });
  await client.connect();
  await client.ping();
  return client;
}

export async function getRedisClient(options: { required?: boolean } = {}): Promise<Redis | null> {
  if (globalThis.__tandemRedisClient?.status === "ready") return globalThis.__tandemRedisClient;

  const url = process.env.REDIS_URL;
  const required = options.required ?? productionRequiresRedis();
  if (!url) {
    if (required) {
      throw new ConfigurationError(
        "REDIS_URL is required for production realtime collaboration on Vercel. Configure a managed Redis/Valkey service and redeploy.",
      );
    }
    return null;
  }

  try {
    const client = await createRedisClient(url);
    globalThis.__tandemRedisClient = client;
    return client;
  } catch (err) {
    if (required) {
      throw new ConfigurationError(
        "REDIS_URL is configured but unreachable. Production realtime collaboration requires a reachable managed Redis/Valkey service.",
      );
    }
    console.warn("[store] REDIS_URL set but unreachable — falling back to in-memory cache", err);
    return null;
  }
}

export async function createRedisSubscriber(): Promise<Redis> {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new ConfigurationError("REDIS_URL is required for realtime subscriptions.");
  }
  return createRedisClient(url);
}

export async function resolveDocStore(): Promise<DocStore> {
  if (globalThis.__tandemDocStore) {
    if (shouldUseRedisRealtime() && globalThis.__tandemDocStore.mode !== "redis") {
      globalThis.__tandemDocStore = undefined;
    } else {
      return globalThis.__tandemDocStore;
    }
  }

  const redis = await getRedisClient({ required: shouldUseRedisRealtime() });
  if (redis) {
    globalThis.__tandemDocStore = new RedisDocStore(redis);
    return globalThis.__tandemDocStore;
  }

  globalThis.__tandemDocStore = new MemoryDocStore();
  return globalThis.__tandemDocStore;
}

export function currentStore(): DocStore | null {
  return globalThis.__tandemDocStore ?? null;
}
