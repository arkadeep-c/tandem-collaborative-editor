import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlidingWindowLimiter } from "@/lib/rateLimit";

describe("sliding window limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    const limiter = new SlidingWindowLimiter(3, 60_000);
    expect(limiter.hit("u1")).toBe(true);
    expect(limiter.hit("u1")).toBe(true);
    expect(limiter.hit("u1")).toBe(true);
  });

  it("blocks requests over the limit", () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);
    limiter.hit("u1");
    limiter.hit("u1");
    expect(limiter.hit("u1")).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    expect(limiter.hit("u1")).toBe(true);
    expect(limiter.hit("u2")).toBe(true);
    expect(limiter.hit("u1")).toBe(false);
  });

  it("slides the window so old attempts expire", () => {
    const limiter = new SlidingWindowLimiter(2, 10_000);
    limiter.hit("u1");
    limiter.hit("u1");
    expect(limiter.hit("u1")).toBe(false);
    vi.advanceTimersByTime(10_001);
    expect(limiter.hit("u1")).toBe(true);
  });
});
