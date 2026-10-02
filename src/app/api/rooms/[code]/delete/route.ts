import { NextRequest, NextResponse } from "next/server";
import { db, isUsingLocalDb } from "@/db";
import { documents, roomMembers, rooms } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireRoomAccess } from "@/lib/roomAccess";
import { roomEngine } from "@/lib/collab/rooms";
import { evictRedisRoom, publishRedisEvent } from "@/lib/collab/redisRealtime";
import { shouldUseRedisRealtime } from "@/lib/deployment";
import { getAuthenticatedSessionFromRequest } from "@/lib/session";
import { withJsonErrors } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

async function DELETEHandler(request: NextRequest, ctx: RouteContext) {
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

  try {
    if (shouldUseRedisRealtime()) {
      await publishRedisEvent(access.code, {
        type: "access_revoked",
        reason: "kicked",
        message: "This room was deleted by the room owner.",
      });
      await evictRedisRoom(access.code);
    } else {
      const room = await roomEngine.getRoom(access.code);
      if (room) {
        // @ts-ignore - internal cleanup hook may exist in future engines
        if (typeof (room as any).teardown === "function") {
          await (room as any).teardown();
        }
      }
    }
  } catch (e) {
    console.warn("[delete] active room cleanup failed", e);
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

export const DELETE = withJsonErrors("api.rooms.[code].delete.delete", DELETEHandler);
