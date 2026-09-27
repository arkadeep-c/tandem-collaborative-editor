import { NextRequest, NextResponse } from "next/server";
import { roomEngine } from "@/lib/collab/rooms";
import { operationsLimiter } from "@/lib/rateLimit";
import { requireRoomAccess } from "@/lib/roomAccess";
import { validateOps } from "@/lib/validation";
import type { OperationAck, OperationStale } from "@/lib/types";
import { getAuthenticatedSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

/**
 * POST /api/rooms/:code/operations — edit path. Accepts cookie OR bearer.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;

  const auth = await getAuthenticatedSessionFromRequest(request);
  const preSession = auth.session;
  if (!preSession) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }

  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = (await request.json().catch(() => null)) as {
    connectionId?: unknown;
    baseRevision?: unknown;
    ops?: unknown;
  } | null;

  if (
    !body ||
    typeof body.connectionId !== "string" ||
    !/^c_[a-f0-9]{18}$/.test(body.connectionId) ||
    !Number.isInteger(body.baseRevision) ||
    (body.baseRevision as number) < 0
  ) {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!operationsLimiter.hit(body.connectionId)) {
    return NextResponse.json({ error: "Too many edits." }, { status: 429 });
  }

  const validated = validateOps(body.ops);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 400 });
  }

  const room = await roomEngine.getRoom(access.code);
  if (!room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  if (!room.connectionBelongsTo(body.connectionId, access.session.user.id)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
  }

  const result = await room.applyOperations(
    body.connectionId,
    body.baseRevision as number,
    validated.ops,
  );

  if ("stale" in result) {
    const payload: OperationStale = {
      ok: false,
      code: "STALE_REVISION",
      revision: room.revision,
      content: room.content,
    };
    return NextResponse.json(payload, { status: 409 });
  }

  const ack: OperationAck = { ok: true, revision: result.revision };
  return NextResponse.json(ack);
}
