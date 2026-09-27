import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { documents, rooms } from "@/db/schema";
import { currentStore, resolveDocStore } from "@/lib/collab/store";
import { applyOp, transformOp } from "@/lib/ot";
import { opWithinBounds } from "@/lib/validation";
import type {
  ClientUser,
  PresenceState,
  ServerEvent,
  TextOp,
} from "@/lib/types";

/**
 * RoomEngine — single-process collaboration core.
 *
 * One `Room` per active room code holds the authoritative buffer, the OT
 * ring buffer (transform window), the presence registry, and the stream
 * subscriber set. All mutations for a room run through its promise
 * serializer, so op application is a single total order per room by
 * construction — no locks, no TTL expiry hazards. Honest scope: this
 * provides correct ordering for ONE application process (see README).
 *
 * Rooms load lazily from PostgreSQL, stay hot in the doc cache while
 * active, and flush back on a 5s trailing debounce or at idle teardown.
 */

export function newConnectionId(): string {
  return `c_${randomBytes(9).toString("hex")}`;
}

const OP_LOG_LIMIT = 256; // transform window; older bases force a resync
const FLUSH_DEBOUNCE_MS = 5_000;
const ROOM_IDLE_TIMEOUT_MS = 60_000;

interface LoggedOp {
  revision: number;
  op: TextOp;
}

export type Subscriber = (event: ServerEvent) => void;

export interface RoomRecord {
  id: string;
  code: string;
  ownerId: string;
  documentId: string;
  title: string;
  language: string;
}

class Room {
  content = "";
  revision = 0;
  readonly users = new Map<string, PresenceState>(); // connectionId → presence
  private readonly opLog: LoggedOp[] = [];
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private dirty = false;
  private loaded = false;

  meta: { title: string; language: string };

  constructor(readonly record: RoomRecord) {
    this.meta = { title: record.title, language: record.language };
  }

  get documentId(): string {
    return this.record.documentId;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next as Promise<T>;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    return this.enqueue(async () => {
      if (this.loaded) return;
      const store = await resolveDocStore();
      const [row] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, this.record.documentId))
        .limit(1);
      if (!row) throw new Error("DOCUMENT_NOT_FOUND");

      const cached = await store.get(this.record.code);
      const cacheWins = cached !== null && cached.revision >= row.revision;
      this.content = cacheWins && cached ? cached.content : row.content;
      this.revision = cacheWins && cached ? cached.revision : row.revision;
      this.loaded = true;
    });
  }

  /* ---------------- presence ---------------- */

  join(connectionId: string, user: ClientUser): PresenceState {
    const presence: PresenceState = {
      sessionId: connectionId,
      user,
      cursor: null,
      selection: null,
      typing: false,
      joinedAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.users.set(connectionId, presence);
    this.cancelIdleTeardown();
    this.broadcast({ type: "presence", user: presence });
    return presence;
  }

  leaveConnection(connectionId: string): void {
    const presence = this.users.get(connectionId);
    if (!presence) return;
    this.users.delete(connectionId);
    this.unsubscribeAll(connectionId);
    this.broadcast({
      type: "leave",
      sessionId: connectionId,
      userId: presence.user.id,
    });
    if (this.users.size === 0) this.scheduleIdleTeardown();
  }

  /** Drop every live connection owned by a user (explicit leave-room). */
  leaveUser(userId: string, notify = true): Subscriber[] {
    const orphans: Subscriber[] = [];
    for (const [connectionId, presence] of [...this.users]) {
      if (presence.user.id !== userId) continue;
      const bucket = this.subscribers.get(connectionId);
      if (bucket) orphans.push(...bucket);
      this.leaveConnection(connectionId);
    }
    if (notify) return orphans;
    return [];
  }

  connectionBelongsTo(connectionId: string, userId: string): boolean {
    return this.users.get(connectionId)?.user.id === userId;
  }

  /** Re-publish identity after a profile change (name/color). */
  propagateIdentity(userId: string, patch: { name: string; color: string }): void {
    for (const presence of this.users.values()) {
      if (presence.user.id !== userId) continue;
      presence.user = { ...presence.user, ...patch };
      this.broadcast({ type: "presence", user: presence });
    }
  }

  updatePresence(
    connectionId: string,
    userId: string,
    patch: Partial<Pick<PresenceState, "cursor" | "selection" | "typing">>,
  ): boolean {
    const presence = this.users.get(connectionId);
    if (!presence || presence.user.id !== userId) return false;
    Object.assign(presence, patch, { lastActiveAt: Date.now() });
    this.broadcast({ type: "presence", user: presence });
    return true;
  }

  /* ---------------- operations ---------------- */

  async applyOperations(
    connectionId: string,
    baseRevision: number,
    ops: TextOp[],
  ): Promise<{ revision: number } | { stale: true }> {
    return this.enqueue(async () => {
      // A base ABOVE the tip is as invalid as one below the window.
      if (
        baseRevision > this.revision ||
        baseRevision < this.revision - this.opLog.length
      ) {
        return { stale: true as const };
      }
      const base = this.revision - this.opLog.length;
      const missed = this.opLog.slice(baseRevision - base);
      const applied: TextOp[] = [];
      let dropped = 0;

      for (const original of ops) {
        let op: TextOp | null = original;
        for (const past of missed) op = op ? transformOp(op, past.op) : null;
        for (const done of applied) op = op ? transformOp(op, done) : null;
        if (!op) continue;
        // Post-transform bounds check — untrusted offsets can never
        // escape the live buffer; the op is dropped, order is preserved.
        if (!opWithinBounds(op, this.content.length)) {
          dropped += 1;
          continue;
        }
        this.content = applyOp(this.content, op);
        this.revision += 1;
        const logged: LoggedOp = { revision: this.revision, op };
        this.opLog.push(logged);
        applied.push(op);
        missed.push(logged);
      }
      while (this.opLog.length > OP_LOG_LIMIT) this.opLog.shift();

      if (dropped > 0) {
        console.warn(
          `[room ${this.record.code}] dropped ${dropped} out-of-bounds op(s) ` +
            `from ${this.users.get(connectionId)?.user.id ?? "unknown"}`,
        );
      }

      if (applied.length > 0) {
        this.dirty = true;
        this.scheduleFlush();
        this.broadcastExcept(connectionId, {
          type: "op",
          revision: this.revision,
          ops: applied,
          by: connectionId,
        });
      }
      // Author echo over the ordered stream: the FSM "ack" that releases
      // the client's outstanding batch (even when `applied` is empty).
      this.sendTo(connectionId, {
        type: "op",
        revision: this.revision,
        ops: applied,
        by: connectionId,
      });
      return { revision: this.revision };
    });
  }

  /* ---------------- metadata (authz enforced by the route) ---------------- */

  async updateMeta(patch: { title?: string; language?: string }): Promise<void> {
    await this.enqueue(async () => {
      if (patch.title !== undefined) this.meta.title = patch.title;
      if (patch.language !== undefined) this.meta.language = patch.language;
      await db
        .update(documents)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.language !== undefined ? { language: patch.language } : {}),
          updatedAt: new Date(),
        })
        .where(eq(documents.id, this.record.documentId));
      await db
        .update(rooms)
        .set({ updatedAt: new Date() })
        .where(eq(rooms.id, this.record.id));
    });
    this.broadcast({ type: "meta", ...patch });
  }

  /* ---------------- persistence ---------------- */

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), FLUSH_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot = { content: this.content, revision: this.revision };
    try {
      const store = await resolveDocStore();
      await store.set(this.record.code, snapshot);
      await db
        .update(documents)
        .set({
          content: snapshot.content,
          revision: snapshot.revision,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, this.record.documentId));
      this.broadcast({
        type: "saved",
        revision: snapshot.revision,
        savedAt: new Date().toISOString(),
        mode: store.mode,
      });
    } catch (err) {
      this.dirty = true; // retry on next debounce; never lose edits silently
      this.scheduleFlush();
      console.error(`[room ${this.record.code}] flush failed`, err);
    }
  }

  /* ---------------- lifecycle ---------------- */

  private cancelIdleTeardown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleTeardown(): void {
    this.cancelIdleTeardown();
    this.idleTimer = setTimeout(async () => {
      if (this.users.size > 0) return;
      await this.flush();
      const store = currentStore();
      if (store) await store.evict(this.record.code);
      roomEngine.dispose(this.record.code);
    }, ROOM_IDLE_TIMEOUT_MS);
  }

  /* ---------------- pub/sub ---------------- */

  subscribe(connectionId: string, fn: Subscriber): () => void {
    let bucket = this.subscribers.get(connectionId);
    if (!bucket) {
      bucket = new Set();
      this.subscribers.set(connectionId, bucket);
    }
    bucket.add(fn);
    return () => {
      bucket.delete(fn);
      if (bucket.size === 0) this.subscribers.delete(connectionId);
    };
  }

  private unsubscribeAll(connectionId: string): void {
    this.subscribers.delete(connectionId);
  }

  private broadcast(event: ServerEvent): void {
    this.dispatch(event, null);
  }

  private broadcastExcept(connectionId: string, event: ServerEvent): void {
    this.dispatch(event, connectionId);
  }

  private sendTo(connectionId: string, event: ServerEvent): void {
    const bucket = this.subscribers.get(connectionId);
    if (!bucket) return;
    for (const fn of bucket) {
      try {
        fn(event);
      } catch {
        /* reaped by its own disconnect handler */
      }
    }
  }

  private dispatch(event: ServerEvent, exceptConnectionId: string | null): void {
    for (const [connectionId, bucket] of this.subscribers) {
      if (connectionId === exceptConnectionId) continue;
      for (const fn of bucket) {
        try {
          fn(event);
        } catch {
          /* a dead subscriber is reaped by its own disconnect handler */
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

class RoomEngine {
  private readonly rooms = new Map<string, Room>();

  /** Resolve a room record + hot engine room; null when code doesn't exist. */
  async getRoom(code: string): Promise<Room | null> {
    const cached = this.rooms.get(code);
    if (cached) {
      await cached.ensureLoaded().catch(() => null);
      return cached;
    }

    const rows = await db
      .select({
        id: rooms.id,
        code: rooms.code,
        ownerId: rooms.ownerId,
        documentId: rooms.documentId,
        title: documents.title,
        language: documents.language,
      })
      .from(rooms)
      .innerJoin(documents, eq(rooms.documentId, documents.id))
      .where(eq(rooms.code, code))
      .limit(1);

    const record = rows[0] as RoomRecord | undefined;
    if (!record) return null;
    const room = new Room(record);
    this.rooms.set(code, room);
    await room.ensureLoaded().catch(() => {
      this.rooms.delete(code);
    });
    return this.rooms.get(code) ?? null;
  }

  getActiveCount(code: string): number {
    return this.rooms.get(code)?.users.size ?? 0;
  }

  /** Identity re-publication across every active room. */
  propagateIdentity(userId: string, patch: { name: string; color: string }): void {
    for (const room of this.rooms.values()) {
      room.propagateIdentity(userId, patch);
    }
  }

  dispose(code: string): void {
    this.rooms.delete(code);
  }
}

declare global {
  var __tandemRoomEngine: RoomEngine | undefined;
}

export const roomEngine: RoomEngine =
  globalThis.__tandemRoomEngine ??
  (globalThis.__tandemRoomEngine = new RoomEngine());
