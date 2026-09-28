import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, isUsingLocalDb } from "@/db";
import { roomMembers, rooms } from "@/db/schema";
import { roomEngine } from "@/lib/collab/rooms";
import { roomJoinLimiter } from "@/lib/rateLimit";
import { isValidRoomCode, normalizeRoomCode } from "@/lib/roomCode";
import { findRoomByCode, getMembership } from "@/lib/roomAccess";
import {
  createSession,
  createBearerToken,
  getAuthenticatedSessionFromRequest,
  serializeSessionCookie,
  SESSION_COOKIE,
  sessionCookieOptions,
  type SessionUser,
} from "@/lib/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

/**
 * POST /api/rooms/:code/join — idempotent membership grant. Accepts cookie OR bearer.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
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

  if (!roomJoinLimiter.hit(session.user.id)) {
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

  if (insertedMembership) {
    const activeRoom = await roomEngine.getRoom(code);
    if (typeof activeRoom?.notifyMemberJoined === "function") {
      activeRoom.notifyMemberJoined(session.user);
    }
  }

  const responseBody: any = {
    room: {
      code,
      title: found.document.title,
      language: found.document.language,
      activeUsers: roomEngine.getActiveCount(code),
    },
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
