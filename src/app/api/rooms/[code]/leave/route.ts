import { NextResponse } from "next/server";
import { roomEngine } from "@/lib/collab/rooms";
import { requireRoomAccess } from "@/lib/roomAccess";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

/**
 * POST /api/rooms/:code/leave — drop the caller's live presence and close
 * their stream. Membership is retained (refresh/rejoin stays instant);
 * rooms are never destroyed by someone leaving.
 */
export async function POST(_request: Request, ctx: RouteContext) {
  const { code } = await ctx.params;
  const access = await requireRoomAccess(code);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const room = await roomEngine.getRoom(access.code);
  room?.leaveUser(access.session.user.id);

  return NextResponse.json({ ok: true });
}
