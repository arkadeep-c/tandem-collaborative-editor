import { NextRequest, NextResponse } from "next/server";
import { db, isUsingLocalDb } from "@/db";
import { documents, roomMembers, rooms } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireRoomAccess } from "@/lib/roomAccess";
import { roomEngine } from "@/lib/collab/rooms";
import { getAuthenticatedSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;

  const auth = await getAuthenticatedSessionFromRequest(request);
  if (!auth.session) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }

  const access = await requireRoomAccess(code, request, { ownerOnly: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const roomId = access.room.id;
  const docId = access.room.documentId;

  // Remove from engine (active cache) - try to get and teardown if exists
  try {
    const room = await roomEngine.getRoom(access.code);
    if (room) {
      // @ts-ignore - internal cleanup
      if (typeof (room as any).teardown === "function") {
        await (room as any).teardown();
      }
    }
  } catch (e) {
    console.warn("[delete] engine cleanup failed", e);
  }

  // Delete from DB: members, room, document
  try {
    if (isUsingLocalDb()) {
      (db as any).transaction((tx: any) => {
        tx.delete(roomMembers).where(eq(roomMembers.roomId, roomId)).run();
        tx.delete(rooms).where(eq(rooms.id, roomId)).run();
        tx.delete(documents).where(eq(documents.id, docId)).run();
      });
    } else {
      await (db as any).transaction(async (tx: any) => {
        await tx.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
        await tx.delete(rooms).where(eq(rooms.id, roomId));
        await tx.delete(documents).where(eq(documents.id, docId));
      });
    }
  } catch (err) {
    console.error("[delete] db failed", err);
    return NextResponse.json({ error: "Failed to delete room." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, deleted: access.code });
}
