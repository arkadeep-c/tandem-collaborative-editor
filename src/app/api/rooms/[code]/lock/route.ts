import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, isUsingLocalDb } from "@/db";
import { rooms } from "@/db/schema";
import { roomEngine } from "@/lib/collab/rooms";
import { requireRoomAccess } from "@/lib/roomAccess";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

/** POST /api/rooms/:code/lock — owner-only lock/unlock joining. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;
  const access = await requireRoomAccess(code, request, { ownerOnly: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = (await request.json().catch(() => null)) as { locked?: unknown } | null;
  if (!body || typeof body.locked !== "boolean") {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const locked = body.locked;
  try {
    if (isUsingLocalDb()) {
      (db as any)
        .update(rooms)
        .set({ locked, updatedAt: new Date() })
        .where(eq(rooms.id, access.room.id))
        .run();
    } else {
      await (db as any)
        .update(rooms)
        .set({ locked, updatedAt: new Date() })
        .where(eq(rooms.id, access.room.id));
    }
  } catch (err) {
    console.error("[room lock] failed", err);
    return NextResponse.json(
      { error: "Could not update the room lock." },
      { status: 500 },
    );
  }

  const activeRoom = await roomEngine.getRoom(access.code);
  if (typeof activeRoom?.setLocked === "function") {
    activeRoom.setLocked(locked);
  }

  return NextResponse.json({ ok: true, locked });
}
