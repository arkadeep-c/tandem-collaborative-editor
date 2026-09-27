import Redis from "ioredis";

/**
 * Hot-state document cache.
 *
 * During an active editing session the current buffer + revision live in this
 * cache so room reads/writes are O(1) and never touch PostgreSQL. A debounced
 * flusher persists to Postgres every 5s and on room shutdown.
 *
 * Two interchangeable backends implement `DocStore`:
 *  - `RedisDocStore`   — used when `REDIS_URL` is configured (docker topology,
 *                        any number of app instances share the same hot state)
 *  - `MemoryDocStore`  — zero-dependency fallback with identical semantics
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

/* ------------------------------------------------------------------ */
/* Redis backend                                                       */
/* ------------------------------------------------------------------ */

const REDIS_TTL_SECONDS = 60 * 60 * 6; // 6h rolling TTL for hot documents
const keyFor = (documentId: string) => `doc:${documentId}`;

class RedisDocStore implements DocStore {
  readonly mode = "redis" as const;

  constructor(private readonly redis: Redis) {}

  async get(documentId: string): Promise<CachedDocument | null> {
    const raw = await this.redis.get(keyFor(documentId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CachedDocument;
      if (typeof parsed.content !== "string" || typeof parsed.revision !== "number") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async set(documentId: string, value: CachedDocument): Promise<void> {
    await this.redis.set(
      keyFor(documentId),
      JSON.stringify(value),
      "EX",
      REDIS_TTL_SECONDS,
    );
  }

  async evict(documentId: string): Promise<void> {
    await this.redis.del(keyFor(documentId));
  }
}

/* ------------------------------------------------------------------ */
/* In-memory backend (single-process fallback)                         */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Store resolution (singleton, lazy, fail-fast Redis probe)           */
/* ------------------------------------------------------------------ */

declare global {
  var __tandemDocStore: DocStore | undefined;
  var __tandemRedisClient: Redis | undefined;
}

async function probeRedis(url: string): Promise<Redis | null> {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 900,
    retryStrategy: () => null, // never storm a dead broker
    enableOfflineQueue: false,
  });
  client.on("error", () => {
    /* swallow — resolution falls back to memory */
  });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

export async function resolveDocStore(): Promise<DocStore> {
  if (globalThis.__tandemDocStore) return globalThis.__tandemDocStore;

  const url = process.env.REDIS_URL;
  if (url) {
    const redis = await probeRedis(url);
    if (redis) {
      globalThis.__tandemRedisClient = redis;
      globalThis.__tandemDocStore = new RedisDocStore(redis);
      return globalThis.__tandemDocStore;
    }
    console.warn(
      `[store] REDIS_URL set but unreachable — falling back to in-memory cache`,
    );
  }

  globalThis.__tandemDocStore = new MemoryDocStore();
  return globalThis.__tandemDocStore;
}

/** Synchronous accessor used by reporting endpoints after first resolution. */
export function currentStore(): DocStore | null {
  return globalThis.__tandemDocStore ?? null;
}
