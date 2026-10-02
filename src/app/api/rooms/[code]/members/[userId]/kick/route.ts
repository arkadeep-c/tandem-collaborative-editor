import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, isUsingLocalDb } from "@/db";
import { roomMembers, users } from "@/db/schema";
import { roomEngine } from "@/lib/collab/rooms";
import { getMembership, listRoomMembers, requireRoomAccess } from "@/lib/roomAccess";
import type { ClientUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string; userId: string }> };

/** POST /api/rooms/:code/members/:userId/kick — owner-only member removal. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const { code, userId: rawUserId } = await ctx.params;
  const targetUserId = decodeURIComponent(rawUserId ?? "").trim();
  if (!targetUserId) {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const access = await requireRoomAccess(code, request, { ownerOnly: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  if (targetUserId === access.session.user.id) {
    return NextResponse.json(
      { error: "The room owner cannot kick themselves." },
      { status: 400 },
    );
  }
  if (targetUserId === access.room.ownerId) {
    return NextResponse.json(
      { error: "The room owner cannot be kicked." },
      { status: 400 },
    );
  }

  const targetMembership = await getMembership(access.room.id, targetUserId);
  if (!targetMembership) {
    return NextResponse.json({ error: "Member not found." }, { status: 404 });
  }
  if (targetMembership.role === "owner") {
    return NextResponse.json(
      { error: "The room owner cannot be kicked." },
      { status: 400 },
    );
  }

  const [targetRow] = await db
    .select({ id: users.id, name: users.name, color: users.color })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!targetRow) {
    return NextResponse.json({ error: "Member not found." }, { status: 404 });
  }
  const targetUser: ClientUser = {
    id: targetRow.id,
    name: targetRow.name,
    color: targetRow.color,
  };

  try {
    if (isUsingLocalDb()) {
      (db as any)
        .delete(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, access.room.id),
            eq(roomMembers.userId, targetUserId),
          ),
        )
        .run();
    } else {
      await (db as any)
        .delete(roomMembers)
        .where(
          and(
            eq(roomMembers.roomId, access.room.id),
            eq(roomMembers.userId, targetUserId),
          ),
        );
    }
  } catch (err) {
    console.error("[kick] failed", err);
    return NextResponse.json(
      { error: "Could not remove that member." },
      { status: 500 },
    );
  }

  const activeRoom = await roomEngine.getRoom(access.code);
  const members = await listRoomMembers(
    access.room.id,
    activeRoom ? [...activeRoom.users.values()] : [],
  );
  if (typeof activeRoom?.notifyMemberKicked === "function") {
    activeRoom.notifyMemberKicked(targetUser, members);
  }

  return NextResponse.json({ ok: true, removed: targetUser });
}
