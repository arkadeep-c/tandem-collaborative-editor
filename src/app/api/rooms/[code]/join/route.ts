import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, isUsingLocalDb } from "@/db";
import { roomMembers, rooms } from "@/db/schema";
import { roomEngine } from "@/lib/collab/rooms";
import { getRedisPresence, publishRedisEvent } from "@/lib/collab/redisRealtime";
import { shouldUseRedisRealtime } from "@/lib/deployment";
import { roomJoinLimiter } from "@/lib/rateLimit";
import { isValidRoomCode, normalizeRoomCode } from "@/lib/roomCode";
import { findRoomByCode, getMembership, listRoomMembers } from "@/lib/roomAccess";
import { normalizeRoomTemplateMode } from "@/lib/roomTemplates";
import { withJsonErrors } from "@/lib/apiErrors";
import {
  createSession,
  createBearerToken,
  getAuthenticatedSessionFromRequest,
  serializeSessionCookie,
  SESSION_COOKIE,
  sessionCookieOptions,
  type SessionUser,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

/**
 * POST /api/rooms/:code/join — idempotent membership grant. Accepts cookie OR bearer.
 */
async function POSTHandler(request: NextRequest, ctx: RouteContext) {
  const { code: rawCode } = await ctx.params;

  const auth = await getAuthenticatedSessionFromRequest(request);
  let session: SessionUser | null = auth.session;
  let issueCookie: string | null = null;
  let issueBearer: string | null = null;

  if (!session) {
    const created = await createSession();
    session = { sessionId: created.sessionId, user: created.user };
    issueCookie = serializeSessionCookie(created.token);
    issueBearer = createBearerToken(created.sessionId);
  } else if (!auth.cookieValid) {
    issueBearer = createBearerToken(session.sessionId);
  }

  if (!(await roomJoinLimiter.hitAsync(session.user.id))) {
    return NextResponse.json(
      { error: "Too many join attempts. Slow down." },
      { status: 429 },
    );
  }

  const code = normalizeRoomCode(rawCode);
  if (!isValidRoomCode(code)) {
    return NextResponse.json({ error: "Invalid room code." }, { status: 400 });
  }

  const found = await findRoomByCode(code);
  if (!found) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  const existing = await getMembership(found.room.id, session.user.id);
  if (!existing && found.room.locked) {
    return NextResponse.json(
      { error: "This room is locked by the room owner." },
      { status: 403 },
    );
  }

  let grantedRole = existing?.role ?? "editor";
  let insertedMembership = false;
  if (!existing) {
    const [anyMember] = await (db as any)
      .select({ userId: roomMembers.userId })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, found.room.id))
      .limit(1);
    grantedRole = anyMember ? "editor" : "owner";
    if (isUsingLocalDb()) {
      (db as any)
        .insert(roomMembers)
        .values({ roomId: found.room.id, userId: session.user.id, role: grantedRole })
        .onConflictDoNothing()
        .run();
      if (grantedRole === "owner") {
        (db as any).update(rooms).set({ ownerId: session.user.id, updatedAt: new Date() }).where(eq(rooms.id, found.room.id)).run();
      }
    } else {
      await (db as any)
        .insert(roomMembers)
        .values({ roomId: found.room.id, userId: session.user.id, role: grantedRole })
        .onConflictDoNothing();
      if (grantedRole === "owner") {
        await (db as any).update(rooms).set({ ownerId: session.user.id, updatedAt: new Date() }).where(eq(rooms.id, found.room.id));
      }
    }
    insertedMembership = true;
  }

  const useRedis = shouldUseRedisRealtime();
  const activeRoom = useRedis ? null : await roomEngine.getRoom(code);
  const activePresence = useRedis ? await getRedisPresence(code) : null;
  const members = await listRoomMembers(
    found.room.id,
    activePresence ?? (activeRoom ? [...activeRoom.users.values()] : []),
  );
  if (insertedMembership) {
    if (useRedis) {
      await publishRedisEvent(code, { type: "member_join", user: session.user, members });
    } else if (typeof activeRoom?.notifyMemberJoined === "function") {
      activeRoom.notifyMemberJoined(session.user, members);
    }
  }

  const responseBody: any = {
    room: {
      code,
      title: found.document.title,
      language: found.document.language,
      locked: Boolean(found.room.locked),
      templateMode: normalizeRoomTemplateMode(found.room.templateMode),
      activeUsers: activePresence ? activePresence.length : roomEngine.getActiveCount(code),
    },
    members,
    role: grantedRole,
    alreadyMember: Boolean(existing),
  };
  if (issueBearer && !auth.cookieValid) {
    responseBody.sessionToken = issueBearer;
  }

  const response = NextResponse.json(responseBody);
  if (issueCookie) {
    response.cookies.set(SESSION_COOKIE, issueCookie, sessionCookieOptions());
  }
  return response;
}

export const POST = withJsonErrors("api.rooms.[code].join.post", POSTHandler);
