import { getRedisClient } from "@/lib/collab/store";
import { shouldUseRedisRealtime } from "@/lib/deployment";

/**
 * Sliding-window rate limiter.
 *
 * Local development uses an in-process map. Production Vercel deployments use
 * Redis so limits are shared across independent function instances.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string): boolean {
    const now = Date.now();
    this.sweep(now);
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  async hitAsync(key: string): Promise<boolean> {
    if (!shouldUseRedisRealtime()) return this.hit(key);

    const redis = await getRedisClient({ required: true });
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const redisKey = `tandem:rate:${this.limit}:${this.windowMs}:${key.replace(/[^a-zA-Z0-9:_-]/g, "_")}`;
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const results = await redis!
      .multi()
      .zremrangebyscore(redisKey, 0, cutoff)
      .zadd(redisKey, now, member)
      .zcard(redisKey)
      .pexpire(redisKey, this.windowMs)
      .exec();
    const count = Number(results?.[2]?.[1] ?? 0);
    if (count > this.limit) {
      await redis!.zrem(redisKey, member).catch(() => undefined);
      return false;
    }
    return true;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.hits) {
      const alive = list.filter((t) => t > cutoff);
      if (alive.length === 0) this.hits.delete(key);
      else this.hits.set(key, alive);
    }
  }
}

export const roomCreateLimiter = new SlidingWindowLimiter(12, 60 * 60 * 1000);
export const roomJoinLimiter = new SlidingWindowLimiter(40, 60 * 1000);
export const operationsLimiter = new SlidingWindowLimiter(600, 60 * 1000);
export const presenceLimiter = new SlidingWindowLimiter(240, 60 * 1000);
export const metaUpdateLimiter = new SlidingWindowLimiter(60, 60 * 1000);
