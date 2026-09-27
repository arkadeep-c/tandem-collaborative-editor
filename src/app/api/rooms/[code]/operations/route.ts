import { NextRequest, NextResponse } from "next/server";
import { roomEngine } from "@/lib/collab/rooms";
import { operationsLimiter } from "@/lib/rateLimit";
import { requireRoomAccess } from "@/lib/roomAccess";
import { validateOps } from "@/lib/validation";
import type { OperationAck, OperationStale } from "@/lib/types";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

/**
 * POST /api/rooms/:code/operations — the edit path.
 *
 * Verification chain (nothing client-supplied is trusted):
 *   valid session → room exists → caller is a member →
 *   the connection id belongs to the caller's session user →
 *   op batch passes structural+size validation →
 *   base revision is sane → OT apply under the room serializer.
 *
 * 200 → { ok, revision }        409 → snapshot for hard resync
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;

  // Order matters: read the session first for rate-limit keying.
  const preSession = await getSessionUser();
  if (!preSession) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }

  const access = await requireRoomAccess(code);
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

  // A connection id proves nothing by itself — it must be bound to the
  // caller's user inside this room's live registry.
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
