import { NextRequest, NextResponse } from "next/server";
import { roomEngine } from "@/lib/collab/rooms";
import { requireRoomAccess } from "@/lib/roomAccess";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

/**
 * POST /api/rooms/:code/leave — drop live presence. Accepts cookie OR bearer.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;
  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const room = await roomEngine.getRoom(access.code);
  room?.leaveUser(access.session.user.id);

  return NextResponse.json({ ok: true });
}
