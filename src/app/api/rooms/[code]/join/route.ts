import { NextRequest, NextResponse } from "next/server";
import { db, isUsingLocalDb } from "@/db";
import { roomMembers } from "@/db/schema";
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
  if (!existing) {
    if (isUsingLocalDb()) {
      (db as any)
        .insert(roomMembers)
        .values({ roomId: found.room.id, userId: session.user.id, role: "editor" })
        .onConflictDoNothing()
        .run();
    } else {
      await (db as any)
        .insert(roomMembers)
        .values({ roomId: found.room.id, userId: session.user.id, role: "editor" })
        .onConflictDoNothing();
    }
  }

  const responseBody: any = {
    room: {
      code,
      title: found.document.title,
      language: found.document.language,
      activeUsers: roomEngine.getActiveCount(code),
    },
    role: existing?.role ?? "editor",
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
