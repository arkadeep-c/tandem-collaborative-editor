/**
 * Lightweight sliding-window rate limiter.
 *
 * The collaboration engine is single-process by design (see README), so an
 * in-process limiter is both sufficient and honest. Keys are server-side
 * identities (user ids / connection ids), never client-claimed values.
 */

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record one attempt; returns false when the caller exceeded the limit. */
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
