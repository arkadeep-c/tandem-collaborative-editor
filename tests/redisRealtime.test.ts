import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRedisSubscriber: vi.fn(),
  getRedisClient: vi.fn(),
  dbUpdate: vi.fn(),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  lte: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  and: vi.fn((...conditions: unknown[]) => conditions),
}));

vi.mock("@/lib/collab/store", () => ({
  createRedisSubscriber: mocks.createRedisSubscriber,
  getRedisClient: mocks.getRedisClient,
}));

vi.mock("@/db", () => ({
  db: { update: mocks.dbUpdate },
}));

vi.mock("@/db/schema", () => ({
  documents: { id: "documents.id", revision: "documents.revision" },
  rooms: { id: "rooms.id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: mocks.eq,
  lte: mocks.lte,
  and: mocks.and,
}));

function createRedisFixture(timeline: string[]) {
  const values = new Map<string, string>();
  const published: unknown[] = [];
  const redis = {
    set: vi.fn(async (key: string, value: string, ...modifiers: string[]) => {
      if (modifiers.includes("NX")) {
        if (values.has(key)) return null;
        values.set(key, value);
        return "OK";
      }
      values.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => {
      keys.forEach((key) => values.delete(key));
      return keys.length;
    }),
    hget: vi.fn(async () => null),
    publish: vi.fn(async (_channel: string, payload: string) => {
      const event = JSON.parse(payload);
      published.push(event);
      timeline.push(event.type);
      return 1;
    }),
  };

  values.set(
    "tandem:connection:c_1234567890abcdef12",
    JSON.stringify({ code: "ABC123", userId: "user-1" }),
  );

  return { redis, published };
}

const access = {
  ok: true,
  code: "ABC123",
  session: { user: { id: "user-1", name: "Editor", color: "#123456" } },
  room: { id: "room-1", documentId: "document-1" },
  member: { role: "owner" },
  document: { content: "", revision: 0, title: "Untitled", language: "markdown" },
} as const;

describe("Redis realtime subscriptions", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createRedisSubscriber.mockReset();
    mocks.getRedisClient.mockReset();
    mocks.dbUpdate.mockReset();
    mocks.eq.mockClear();
    mocks.lte.mockClear();
    mocks.and.mockClear();
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

describe("Redis realtime operation persistence", () => {
  it("publishes the live op before durable document persistence completes", async () => {
    const timeline: string[] = [];
    const { redis, published } = createRedisFixture(timeline);
    mocks.getRedisClient.mockResolvedValue(redis);

    let releasePersistence!: () => void;
    const durableWrite = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    mocks.dbUpdate.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          timeline.push("durable-start");
          await durableWrite;
          timeline.push("durable-complete");
        }),
      })),
    });

    const { applyRedisOperations } = await import("@/lib/collab/redisRealtime");
    const applying = applyRedisOperations(
      access as any,
      "c_1234567890abcdef12",
      0,
      [{ type: "insert", offset: 0, text: "fast" }],
      "m_1234567890ab",
    );

    await vi.waitFor(() => {
      expect(timeline).toEqual(["op", "durable-start"]);
    });
    expect(published).toContainEqual(expect.objectContaining({
      type: "op",
      revision: 1,
      ops: [{ type: "insert", offset: 0, text: "fast" }],
    }));
    expect(published).not.toContainEqual(expect.objectContaining({ type: "saved" }));
    expect(mocks.lte).toHaveBeenCalledWith("documents.revision", 1);

    releasePersistence();
    await expect(applying).resolves.toMatchObject({ revision: 1, savedAt: expect.any(String) });
    expect(timeline).toEqual(["op", "durable-start", "durable-complete", "saved"]);
  });

  it("retries durable persistence for a duplicate mutation without publishing its op twice", async () => {
    const timeline: string[] = [];
    const { redis, published } = createRedisFixture(timeline);
    mocks.getRedisClient.mockResolvedValue(redis);

    let durableAttempts = 0;
    mocks.dbUpdate.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          durableAttempts += 1;
          if (durableAttempts === 1) throw new Error("temporary database failure");
        }),
      })),
    });

    const { applyRedisOperations } = await import("@/lib/collab/redisRealtime");
    const first = () => applyRedisOperations(
      access as any,
      "c_1234567890abcdef12",
      0,
      [{ type: "insert", offset: 0, text: "retry" }],
      "m_retry_12345",
    );

    await expect(first()).rejects.toThrow("temporary database failure");
    await expect(first()).resolves.toMatchObject({
      revision: 1,
      duplicate: true,
      savedAt: expect.any(String),
    });

    expect(durableAttempts).toBe(2);
    expect(published.filter((event: any) => event.type === "op")).toHaveLength(1);
    expect(published.filter((event: any) => event.type === "saved")).toHaveLength(1);
  });
});
