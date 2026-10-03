import { randomBytes } from "crypto";
import { and, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { documents, rooms } from "@/db/schema";
import { createRedisSubscriber, getRedisClient } from "@/lib/collab/store";
import { applyOp, rebaseSequentialOps } from "@/lib/ot";
import { opWithinBounds } from "@/lib/validation";
import { normalizeRoomTemplateMode } from "@/lib/roomTemplates";
import type { ClientUser, PresenceState, RoomMemberInfo, ServerEvent, TextOp } from "@/lib/types";
import type { RoomAccess as Access } from "@/lib/roomAccess";

const OP_LOG_LIMIT = 256;
const MUTATION_LOG_LIMIT = 4096;
const HOT_STATE_TTL_SECONDS = 60 * 60 * 6;
const PRESENCE_TTL_SECONDS = 45;
const LOCK_TTL_MS = 5_000;
const LOCK_RETRY_MS = 35;
const LOCK_ATTEMPTS = 80;

interface LoggedOp {
  revision: number;
  op: TextOp;
}

interface AppliedMutation {
  id: string;
  revision: number;
  ops: TextOp[];
  content: string;
  savedAt?: string;
}

interface RedisRoomState {
  content: string;
  revision: number;
  opLog: LoggedOp[];
  recentMutations: AppliedMutation[];
}

const prefix = "tandem";
const roomStateKey = (code: string) => `${prefix}:room:${code}:state`;
const roomPresenceKey = (code: string) => `${prefix}:room:${code}:presence`;
const roomPresenceIndexKey = (code: string) => `${prefix}:room:${code}:presence:index`;
const roomChannel = (code: string) => `${prefix}:room:${code}:events`;
const connectionKey = (connectionId: string) => `${prefix}:connection:${connectionId}`;
const lockKey = (code: string) => `${prefix}:room:${code}:lock`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function publish(code: string, event: ServerEvent): Promise<void> {
  const redis = await getRedisClient({ required: true });
  await redis!.publish(roomChannel(code), JSON.stringify(event));
}

async function withRoomLock<T>(code: string, fn: () => Promise<T>): Promise<T> {
  const redis = await getRedisClient({ required: true });
  const token = randomBytes(12).toString("hex");

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const acquired = await redis!.set(lockKey(code), token, "PX", LOCK_TTL_MS, "NX");
    if (acquired === "OK") {
      try {
        return await fn();
      } finally {
        const current = await redis!.get(lockKey(code)).catch(() => null);
        if (current === token) await redis!.del(lockKey(code)).catch(() => undefined);
      }
    }
    await sleep(LOCK_RETRY_MS);
  }

  throw new Error("ROOM_LOCK_TIMEOUT");
}

async function loadRoomState(access: Extract<Access, { ok: true }>): Promise<RedisRoomState> {
  const redis = await getRedisClient({ required: true });
  const raw = await redis!.get(roomStateKey(access.code));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RedisRoomState;
      if (
        typeof parsed.content === "string" &&
        typeof parsed.revision === "number" &&
        Array.isArray(parsed.opLog) &&
        parsed.revision >= access.document.revision
      ) {
        return {
          content: parsed.content,
          revision: parsed.revision,
          opLog: parsed.opLog,
          recentMutations: Array.isArray(parsed.recentMutations)
            ? parsed.recentMutations.filter((item): item is AppliedMutation =>
                item &&
                typeof item.id === "string" &&
                typeof item.revision === "number" &&
                Array.isArray(item.ops) &&
                typeof item.content === "string",
              )
            : [],
        };
      }
    } catch {
      // replace corrupt cache from durable DB snapshot below
    }
  }

  const state: RedisRoomState = {
    content: access.document.content,
    revision: access.document.revision,
    opLog: [],
    recentMutations: [],
  };
  await saveRoomState(access.code, state);
  return state;
}

async function saveRoomState(code: string, state: RedisRoomState): Promise<void> {
  const redis = await getRedisClient({ required: true });
  await redis!.set(roomStateKey(code), JSON.stringify(state), "EX", HOT_STATE_TTL_SECONDS);
}

async function cleanupPresence(code: string): Promise<void> {
  const redis = await getRedisClient({ required: true });
  const cutoff = Date.now() - PRESENCE_TTL_SECONDS * 1000;
  const stale = await redis!.zrangebyscore(roomPresenceIndexKey(code), 0, cutoff);
  if (stale.length > 0) {
    const staleValues = await redis!.hmget(roomPresenceKey(code), ...stale);
    await redis!.multi()
      .hdel(roomPresenceKey(code), ...stale)
      .zrem(roomPresenceIndexKey(code), ...stale)
      .del(...stale.map((connectionId) => connectionKey(connectionId)))
      .exec();

    await Promise.all(
      staleValues.map(async (raw, index) => {
        if (!raw) return;
        try {
          const presence = JSON.parse(raw) as PresenceState;
          if (presence.user?.id) {
            await publish(code, {
              type: "leave",
              sessionId: stale[index]!,
              userId: presence.user.id,
            });
          }
        } catch {
          // ignore corrupt stale presence records
        }
      }),
    );
  }
}

export async function getRedisPresence(code: string): Promise<PresenceState[]> {
  await cleanupPresence(code);
  const redis = await getRedisClient({ required: true });
  const values = await redis!.hvals(roomPresenceKey(code));
  return values
    .map((value) => {
      try {
        const parsed = JSON.parse(value) as PresenceState;
        return typeof parsed.sessionId === "string" ? parsed : null;
      } catch {
        return null;
      }
    })
    .filter((value): value is PresenceState => Boolean(value));
}

export async function getRedisActiveCount(code: string): Promise<number> {
  const users = await getRedisPresence(code);
  return users.length;
}

export async function joinRedisPresence(
  code: string,
  connectionId: string,
  user: ClientUser,
): Promise<PresenceState> {
  const redis = await getRedisClient({ required: true });
  const presence: PresenceState = {
    sessionId: connectionId,
    user,
    cursor: null,
    selection: null,
    typing: false,
    joinedAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  await redis!.multi()
    .hset(roomPresenceKey(code), connectionId, JSON.stringify(presence))
    .zadd(roomPresenceIndexKey(code), presence.lastActiveAt, connectionId)
    .expire(roomPresenceKey(code), HOT_STATE_TTL_SECONDS)
    .expire(roomPresenceIndexKey(code), HOT_STATE_TTL_SECONDS)
    .set(connectionKey(connectionId), JSON.stringify({ code, userId: user.id }), "EX", PRESENCE_TTL_SECONDS)
    .exec();
  await publish(code, { type: "presence", user: presence });
  return presence;
}

export async function refreshRedisPresence(code: string, connectionId: string): Promise<void> {
  const redis = await getRedisClient({ required: true });
  const raw = await redis!.hget(roomPresenceKey(code), connectionId);
  if (!raw) return;
  let presence: PresenceState;
  try {
    presence = JSON.parse(raw) as PresenceState;
  } catch {
    return;
  }
  presence.lastActiveAt = Date.now();
  await redis!.multi()
    .hset(roomPresenceKey(code), connectionId, JSON.stringify(presence))
    .zadd(roomPresenceIndexKey(code), presence.lastActiveAt, connectionId)
    .expire(connectionKey(connectionId), PRESENCE_TTL_SECONDS)
    .exec();
}

export async function leaveRedisPresence(code: string, connectionId: string): Promise<void> {
  const redis = await getRedisClient({ required: true });
  const raw = await redis!.hget(roomPresenceKey(code), connectionId);
  let userId = "";
  if (raw) {
    try {
      userId = (JSON.parse(raw) as PresenceState).user.id;
    } catch {}
  }
  await redis!.multi()
    .hdel(roomPresenceKey(code), connectionId)
    .zrem(roomPresenceIndexKey(code), connectionId)
    .del(connectionKey(connectionId))
    .exec();
  if (userId) await publish(code, { type: "leave", sessionId: connectionId, userId });
}

export async function removeRedisUserPresence(code: string, userId: string): Promise<void> {
  const users = await getRedisPresence(code);
  await Promise.all(
    users
      .filter((presence) => presence.user.id === userId)
      .map((presence) => leaveRedisPresence(code, presence.sessionId)),
  );
}

export async function propagateRedisIdentity(userId: string, patch: { name: string; color: string }): Promise<void> {
  const redis = await getRedisClient({ required: true });
  const pattern = `${prefix}:room:*:presence`;
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis!.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;
    for (const key of keys) {
      const code = key.slice(`${prefix}:room:`.length, -"presence".length - 1);
      const entries = await redis!.hgetall(key);
      for (const [connectionId, raw] of Object.entries(entries)) {
        let presence: PresenceState;
        try {
          presence = JSON.parse(raw) as PresenceState;
        } catch {
          continue;
        }
        if (presence.user.id !== userId) continue;
        presence.user = { ...presence.user, ...patch };
        presence.lastActiveAt = Date.now();
        await redis!.hset(key, connectionId, JSON.stringify(presence));
        await publish(code, { type: "presence", user: presence });
      }
    }
  } while (cursor !== "0");
}

export async function updateRedisPresence(
  code: string,
  connectionId: string,
  userId: string,
  patch: Partial<Pick<PresenceState, "cursor" | "selection" | "typing">>,
): Promise<boolean> {
  const redis = await getRedisClient({ required: true });
  const ownerRaw = await redis!.get(connectionKey(connectionId));
  if (!ownerRaw) return false;
  try {
    const owner = JSON.parse(ownerRaw) as { code: string; userId: string };
    if (owner.code !== code || owner.userId !== userId) return false;
  } catch {
    return false;
  }

  const raw = await redis!.hget(roomPresenceKey(code), connectionId);
  if (!raw) return false;
  const presence = JSON.parse(raw) as PresenceState;
  if (presence.user.id !== userId) return false;
  Object.assign(presence, patch, { lastActiveAt: Date.now() });

  await redis!.multi()
    .hset(roomPresenceKey(code), connectionId, JSON.stringify(presence))
    .zadd(roomPresenceIndexKey(code), presence.lastActiveAt, connectionId)
    .expire(connectionKey(connectionId), PRESENCE_TTL_SECONDS)
    .exec();
  await publish(code, { type: "presence", user: presence });
  return true;
}

export async function redisConnectionBelongsTo(
  code: string,
  connectionId: string,
  userId: string,
): Promise<boolean> {
  const redis = await getRedisClient({ required: true });
  const ownerRaw = await redis!.get(connectionKey(connectionId));
  if (!ownerRaw) return false;
  try {
    const owner = JSON.parse(ownerRaw) as { code: string; userId: string };
    return owner.code === code && owner.userId === userId;
  } catch {
    return false;
  }
}

interface RedisOperationResult {
  revision: number;
  ops: TextOp[];
  content: string;
  clientMutationId?: string;
  savedAt?: string;
  duplicate?: boolean;
}

interface PersistenceSnapshot {
  content: string;
  revision: number;
  clientMutationId?: string;
}

type LockedRedisOperationResult =
  | { stale: true; revision: number; content: string }
  | { result: RedisOperationResult; persistence?: PersistenceSnapshot };

async function markMutationSaved(
  access: Extract<Access, { ok: true }>,
  clientMutationId: string,
  revision: number,
  savedAt: string,
): Promise<{ savedAt: string; newlyConfirmed: boolean }> {
  return withRoomLock(access.code, async () => {
    const state = await loadRoomState(access);
    const mutation = state.recentMutations.find(
      (item) => item.id === clientMutationId && item.revision === revision,
    );

    // The mutation log is bounded. If this entry was pruned after the durable
    // write completed, the guarded database update below is still authoritative.
    if (!mutation) return { savedAt, newlyConfirmed: true };
    if (mutation.savedAt) {
      return { savedAt: mutation.savedAt, newlyConfirmed: false };
    }

    mutation.savedAt = savedAt;
    await saveRoomState(access.code, state);
    return { savedAt, newlyConfirmed: true };
  });
}

export async function applyRedisOperations(
  access: Extract<Access, { ok: true }>,
  connectionId: string,
  baseRevision: number,
  ops: TextOp[],
  clientMutationId?: string,
): Promise<RedisOperationResult | { stale: true; revision: number; content: string }> {
  if (!(await redisConnectionBelongsTo(access.code, connectionId, access.session.user.id))) {
    throw new Error("UNAUTHORIZED_CONNECTION");
  }

  // The critical section contains only Redis state changes and live delivery.
  // A database write can be slow in a serverless region, so it must never hold
  // the room lock or delay the op event that drives remote editors.
  const lockedResult: LockedRedisOperationResult = await withRoomLock(
    access.code,
    async () => {
      const state = await loadRoomState(access);
      if (clientMutationId) {
        const prior = state.recentMutations.find((item) => item.id === clientMutationId);
        if (prior) {
          return {
            result: {
              revision: prior.revision,
              ops: prior.ops,
              content: prior.content,
              clientMutationId,
              savedAt: prior.savedAt,
              duplicate: true,
            },
            // A request may have been accepted and published just before its
            // original durable write failed. Retry that exact snapshot without
            // applying or publishing the mutation a second time.
            persistence: prior.savedAt
              ? undefined
              : {
                  content: prior.content,
                  revision: prior.revision,
                  clientMutationId,
                },
          };
        }
      }

      if (baseRevision > state.revision || baseRevision < state.revision - state.opLog.length) {
        return { stale: true as const, revision: state.revision, content: state.content };
      }

      const base = state.revision - state.opLog.length;
      const missed = state.opLog.slice(baseRevision - base).map((entry) => entry.op);
      const applied: TextOp[] = [];

      for (const op of rebaseSequentialOps(ops, missed)) {
        if (!opWithinBounds(op, state.content.length)) continue;
        state.content = applyOp(state.content, op);
        state.revision += 1;
        state.opLog.push({ revision: state.revision, op });
        applied.push(op);
      }
      while (state.opLog.length > OP_LOG_LIMIT) state.opLog.shift();

      if (clientMutationId) {
        state.recentMutations.push({
          id: clientMutationId,
          revision: state.revision,
          ops: applied,
          content: state.content,
        });
        while (state.recentMutations.length > MUTATION_LOG_LIMIT) state.recentMutations.shift();
      }

      // Redis is the hot source of truth. Save it before publishing so a
      // reconnecting collaborator can always initialize at this revision.
      await saveRoomState(access.code, state);

      // This is intentionally before durable persistence. It is also emitted
      // for an empty accepted batch because the author's SSE echo is its ack.
      await publish(access.code, {
        type: "op",
        revision: state.revision,
        ops: applied,
        by: connectionId,
        clientMutationId,
      });

      return {
        result: {
          revision: state.revision,
          ops: applied,
          content: state.content,
          clientMutationId,
          duplicate: false,
        },
        persistence: applied.length > 0
          ? {
              content: state.content,
              revision: state.revision,
              clientMutationId,
            }
          : undefined,
      };
    },
  );

  if ("stale" in lockedResult) return lockedResult;

  // The lock has been released. Presence refresh and durable persistence are
  // deliberately outside the serialized hot path.
  await refreshRedisPresence(access.code, connectionId).catch(() => undefined);

  const { result, persistence } = lockedResult;
  if (!persistence) return result;

  const savedAt = new Date().toISOString();
  await (db as any)
    .update(documents)
    .set({
      content: persistence.content,
      revision: persistence.revision,
      updatedAt: new Date(savedAt),
    })
    // A delayed revision can never overwrite a document snapshot persisted by
    // a later operation. Equal revisions are safe retry writes for the same
    // deterministic snapshot.
    .where(
      and(
        eq(documents.id, access.room.documentId),
        lte(documents.revision, persistence.revision),
      ),
    );

  const confirmed = persistence.clientMutationId
    ? await markMutationSaved(
        access,
        persistence.clientMutationId,
        persistence.revision,
        savedAt,
      )
    : { savedAt, newlyConfirmed: true };

  // Only the request that confirms the marker emits saved. A racing duplicate
  // gets the same marker in its HTTP acknowledgement without producing an
  // out-of-order duplicate saved event.
  if (confirmed.newlyConfirmed) {
    await publish(access.code, {
      type: "saved",
      revision: persistence.revision,
      savedAt: confirmed.savedAt,
      mode: "redis",
    });
  }

  return { ...result, savedAt: confirmed.savedAt };
}

export async function updateRedisMeta(
  access: Extract<Access, { ok: true }>,
  patch: { title?: string; language?: string },
): Promise<void> {
  await (db as any)
    .update(documents)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.language !== undefined ? { language: patch.language } : {}),
      updatedAt: new Date(),
    })
    .where(eq(documents.id, access.room.documentId));
  await (db as any).update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, access.room.id));
  await publish(access.code, { type: "meta", ...patch });
}

export async function publishRedisEvent(code: string, event: ServerEvent): Promise<void> {
  await publish(code, event);
}

export async function evictRedisRoom(code: string): Promise<void> {
  const redis = await getRedisClient({ required: true });
  const presence = await getRedisPresence(code).catch(() => []);
  await redis!.del(
    roomStateKey(code),
    roomPresenceKey(code),
    roomPresenceIndexKey(code),
    ...presence.map((item) => connectionKey(item.sessionId)),
  );
}

export async function updateRedisLocked(code: string, locked: boolean): Promise<void> {
  await publish(code, { type: "room_lock", locked });
}

export async function buildRedisInitEvent(
  access: Extract<Access, { ok: true }>,
  connectionId: string,
  members: RoomMemberInfo[],
): Promise<ServerEvent> {
  const state = await loadRoomState(access);
  const presences = await getRedisPresence(access.code);
  const onlineIds = new Set(presences.map((presence) => presence.user.id));
  return {
    type: "init",
    room: {
      code: access.code,
      title: access.document.title,
      language: access.document.language,
      locked: Boolean(access.room.locked),
      templateMode: normalizeRoomTemplateMode(access.room.templateMode),
    },
    you: {
      user: {
        id: access.session.user.id,
        name: access.session.user.name,
        color: access.session.user.color,
      },
      role: access.member.role === "owner" ? "owner" : "editor",
    },
    content: state.content,
    revision: state.revision,
    sessionId: connectionId,
    users: presences,
    members: members.map((member) => ({ ...member, online: onlineIds.has(member.user.id) })),
    cacheMode: "redis",
    // Only durable confirmations may be discarded by a reconnecting client.
    // Mutations without this marker must be retried with the same id so their
    // snapshot persistence can recover after a failed POST response.
    acceptedMutationIds: state.recentMutations
      .filter((mutation) => Boolean(mutation.savedAt))
      .map((mutation) => mutation.id),
  };
}

export async function subscribeRedisRoom(
  code: string,
  onEvent: (event: ServerEvent) => void,
): Promise<() => Promise<void>> {
  const subscriber = await createRedisSubscriber();
  const handler = (_channel: string, message: string) => {
    try {
      onEvent(JSON.parse(message) as ServerEvent);
    } catch {
      // ignore malformed pub/sub messages
    }
  };
  subscriber.on("message", handler);
  await subscriber.subscribe(roomChannel(code));
  return async () => {
    subscriber.off("message", handler);
    await subscriber.unsubscribe(roomChannel(code)).catch(() => undefined);
    subscriber.disconnect();
  };
}
