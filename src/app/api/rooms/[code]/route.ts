import { NextRequest, NextResponse } from "next/server";
import { roomEngine } from "@/lib/collab/rooms";
import { getRedisActiveCount, getRedisPresence, updateRedisMeta } from "@/lib/collab/redisRealtime";
import { shouldUseRedisRealtime } from "@/lib/deployment";
import { metaUpdateLimiter } from "@/lib/rateLimit";
import { listRoomMembers, requireRoomAccess } from "@/lib/roomAccess";
import { getAuthenticatedSessionFromRequest, type SessionUser } from "@/lib/session";
import { normalizeRoomTemplateMode } from "@/lib/roomTemplates";
import { cleanTitle, isLanguageId } from "@/lib/validation";
import { withJsonErrors } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

function sessionOr401(session: SessionUser | null): session is SessionUser {
  return session !== null;
}

/** GET /api/rooms/:code — room info for verified members. Accepts cookie OR bearer. */
async function GETHandler(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;
  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }
  const useRedis = shouldUseRedisRealtime();
  const activePresence = useRedis ? await getRedisPresence(access.code) : null;
  const activeRoom = useRedis ? null : await roomEngine.getRoom(access.code);
  const members = await listRoomMembers(
    access.room.id,
    activePresence ?? (activeRoom ? [...activeRoom.users.values()] : []),
  );
  const activeUsers = useRedis ? await getRedisActiveCount(access.code) : roomEngine.getActiveCount(access.code);
  return NextResponse.json({
    room: {
      code: access.code,
      title: access.document.title,
      language: access.document.language,
      locked: Boolean(access.room.locked),
      templateMode: normalizeRoomTemplateMode(access.room.templateMode),
      role: access.member.role === "owner" ? "owner" : "editor",
      activeUsers,
      updatedAt: access.room.updatedAt.toISOString(),
    },
    members,
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
async function PATCHHandler(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;

  const auth = await getAuthenticatedSessionFromRequest(request);
  const session = auth.session;
  if (!sessionOr401(session)) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }
  if (!(await metaUpdateLimiter.hitAsync(session.user.id))) {
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

  if (shouldUseRedisRealtime()) {
    await updateRedisMeta(access, patch);
  } else {
    const room = await roomEngine.getRoom(access.code);
    if (room) await room.updateMeta(patch);
  }

  return NextResponse.json({ ok: true, ...patch });
}

export const GET = withJsonErrors("api.rooms.[code].get", GETHandler);
export const PATCH = withJsonErrors("api.rooms.[code].patch", PATCHHandler);
