import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRedisSubscriber: vi.fn(),
  getRedisClient: vi.fn(),
}));

vi.mock("@/lib/collab/store", () => ({
  createRedisSubscriber: mocks.createRedisSubscriber,
  getRedisClient: mocks.getRedisClient,
}));

describe("Redis realtime subscriptions", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createRedisSubscriber.mockReset();
    mocks.getRedisClient.mockReset();
  });

  it("subscribes per SSE connection and cleans up unsubscribe/disconnect", async () => {
    let messageHandler: ((channel: string, message: string) => void) | null = null;
    const subscriber = {
      on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
        if (event === "message") messageHandler = handler;
      }),
      off: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      disconnect: vi.fn(),
    };
    mocks.createRedisSubscriber.mockResolvedValue(subscriber);
    const onEvent = vi.fn();

    const { subscribeRedisRoom } = await import("@/lib/collab/redisRealtime");
    const cleanup = await subscribeRedisRoom("ABC123", onEvent);

    expect(subscriber.on).toHaveBeenCalledWith("message", expect.any(Function));
    expect(subscriber.subscribe).toHaveBeenCalledWith("tandem:room:ABC123:events");
    expect(messageHandler).toBeTruthy();

    messageHandler!("tandem:room:ABC123:events", JSON.stringify({ type: "saved", revision: 2, savedAt: "now", mode: "redis" }));
    expect(onEvent).toHaveBeenCalledWith({ type: "saved", revision: 2, savedAt: "now", mode: "redis" });

    await cleanup();

    expect(subscriber.off).toHaveBeenCalledWith("message", messageHandler);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith("tandem:room:ABC123:events");
    expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  });
});
