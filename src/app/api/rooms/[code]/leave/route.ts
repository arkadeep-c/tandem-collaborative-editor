import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, ne } from "drizzle-orm";
import { db, isUsingLocalDb } from "@/db";
import { roomMembers, rooms } from "@/db/schema";
import { roomEngine } from "@/lib/collab/rooms";
import { requireRoomAccess } from "@/lib/roomAccess";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

/**
 * POST /api/rooms/:code/leave — remove caller membership and live presence.
 * If an owner leaves while others remain, ownership transfers to the oldest
 * remaining member. Accepts cookie OR bearer.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;
  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const room = await roomEngine.getRoom(access.code);
  room?.leaveUser(access.session.user.id);

  try {
    if (isUsingLocalDb()) {
      (db as any).transaction((tx: any) => {
        if (access.member.role === "owner") {
          const replacement = tx
            .select()
            .from(roomMembers)
            .where(and(eq(roomMembers.roomId, access.room.id), ne(roomMembers.userId, access.session.user.id)))
            .orderBy(asc(roomMembers.joinedAt))
            .all()[0];
          if (replacement) {
            tx.update(roomMembers)
              .set({ role: "owner" })
              .where(and(eq(roomMembers.roomId, access.room.id), eq(roomMembers.userId, replacement.userId)))
              .run();
            tx.update(rooms)
              .set({ ownerId: replacement.userId, updatedAt: new Date() })
              .where(eq(rooms.id, access.room.id))
              .run();
          }
        }
        tx.delete(roomMembers)
          .where(and(eq(roomMembers.roomId, access.room.id), eq(roomMembers.userId, access.session.user.id)))
          .run();
      });
    } else {
      await (db as any).transaction(async (tx: any) => {
        if (access.member.role === "owner") {
          const [nextOwner] = await tx
            .select()
            .from(roomMembers)
            .where(and(eq(roomMembers.roomId, access.room.id), ne(roomMembers.userId, access.session.user.id)))
            .orderBy(asc(roomMembers.joinedAt))
            .limit(1);
          if (nextOwner) {
            await tx.update(roomMembers)
              .set({ role: "owner" })
              .where(and(eq(roomMembers.roomId, access.room.id), eq(roomMembers.userId, nextOwner.userId)));
            await tx.update(rooms)
              .set({ ownerId: nextOwner.userId, updatedAt: new Date() })
              .where(eq(rooms.id, access.room.id));
          }
        }
        await tx.delete(roomMembers)
          .where(and(eq(roomMembers.roomId, access.room.id), eq(roomMembers.userId, access.session.user.id)));
      });
    }
  } catch (err) {
    console.error("[leave] failed", err);
    return NextResponse.json({ error: "Failed to leave room." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
