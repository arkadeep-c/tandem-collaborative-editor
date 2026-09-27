import { NextRequest, NextResponse } from "next/server";
import { roomEngine } from "@/lib/collab/rooms";
import { metaUpdateLimiter } from "@/lib/rateLimit";
import { requireRoomAccess } from "@/lib/roomAccess";
import { getAuthenticatedSessionFromRequest, type SessionUser } from "@/lib/session";
import { cleanTitle, isLanguageId } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

function sessionOr401(session: SessionUser | null): session is SessionUser {
  return session !== null;
}

/** GET /api/rooms/:code — room info for verified members. Accepts cookie OR bearer. */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;
  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }
  return NextResponse.json({
    room: {
      code: access.code,
      title: access.document.title,
      language: access.document.language,
      role: access.member.role === "owner" ? "owner" : "editor",
      activeUsers: roomEngine.getActiveCount(access.code),
      updatedAt: access.room.updatedAt.toISOString(),
    },
    you: {
      id: access.session.user.id,
      name: access.session.user.name,
      color: access.session.user.color,
    },
  });
}

/**
 * PATCH /api/rooms/:code — room metadata (title / language).
 * Owner-only, accepts cookie OR bearer.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;

  const auth = await getAuthenticatedSessionFromRequest(request);
  const session = auth.session;
  if (!sessionOr401(session)) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }
  if (!metaUpdateLimiter.hit(session.user.id)) {
    return NextResponse.json({ error: "Too many updates." }, { status: 429 });
  }

  const access = await requireRoomAccess(code, request, { ownerOnly: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    language?: unknown;
  } | null;

  const patch: { title?: string; language?: string } = {};
  if (body?.title !== undefined) {
    const title = cleanTitle(body.title);
    if (!title) {
      return NextResponse.json({ error: "Invalid title." }, { status: 400 });
    }
    patch.title = title;
  }
  if (body?.language !== undefined) {
    if (!isLanguageId(body.language)) {
      return NextResponse.json({ error: "Invalid language." }, { status: 400 });
    }
    patch.language = body.language;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const room = await roomEngine.getRoom(access.code);
  if (room) await room.updateMeta(patch);

  return NextResponse.json({ ok: true, ...patch });
}
