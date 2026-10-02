import { NextRequest, NextResponse } from "next/server";
import { roomEngine } from "@/lib/collab/rooms";
import { updateRedisPresence } from "@/lib/collab/redisRealtime";
import { presenceLimiter } from "@/lib/rateLimit";
import { requireRoomAccess } from "@/lib/roomAccess";
import type { CursorPosition, SelectionRange } from "@/lib/types";
import { shouldUseRedisRealtime } from "@/lib/deployment";
import { withJsonErrors } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

interface PresencePayload {
  connectionId?: unknown;
  cursor?: unknown;
  selection?: unknown;
  typing?: unknown;
}

function isCursor(value: unknown): value is CursorPosition {
  const c = value as CursorPosition | null;
  return Boolean(
    c &&
      Number.isInteger(c.line) &&
      Number.isInteger(c.column) &&
      Number.isInteger(c.offset) &&
      c.line >= 1 &&
      c.column >= 1 &&
      c.offset >= 0,
  );
}

function isSelection(value: unknown): value is SelectionRange {
  const s = value as SelectionRange | null;
  return Boolean(
    s &&
      Number.isInteger(s.startLine) &&
      Number.isInteger(s.startColumn) &&
      Number.isInteger(s.endLine) &&
      Number.isInteger(s.endColumn) &&
      s.startLine >= 1 &&
      s.startColumn >= 1 &&
      s.endLine >= 1 &&
      s.endColumn >= 1,
  );
}

/** POST /api/rooms/:code/presence — caret/selection/typing fan-out. Accepts cookie OR bearer. */
async function POSTHandler(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;
  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = (await request.json().catch(() => null)) as PresencePayload | null;
  if (!body || typeof body.connectionId !== "string") {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }
  if (!(await presenceLimiter.hitAsync(body.connectionId))) {
    return NextResponse.json({ ok: true });
  }

  const cursor =
    body.cursor === null ? null : isCursor(body.cursor) ? body.cursor : undefined;
  const selection =
    body.selection === null
      ? null
      : isSelection(body.selection)
        ? body.selection
        : undefined;
  if (cursor === undefined || selection === undefined) {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const patch = {
    cursor,
    selection,
    typing: body.typing === true,
  };

  if (shouldUseRedisRealtime()) {
    const ok = await updateRedisPresence(access.code, body.connectionId, access.session.user.id, patch);
    if (!ok) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
    }
    return NextResponse.json({ ok: true });
  }

  const room = await roomEngine.getRoom(access.code);
  if (!room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  const ok = room.updatePresence(body.connectionId, access.session.user.id, patch);
  if (!ok) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
  }

  return NextResponse.json({ ok: true });
}

export const POST = withJsonErrors("api.rooms.[code].presence.post", POSTHandler);
