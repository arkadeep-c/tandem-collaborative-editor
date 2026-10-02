import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, isUsingLocalDb } from "@/db";
import { roomMembers, users } from "@/db/schema";
import { roomEngine } from "@/lib/collab/rooms";
import { getRedisPresence, publishRedisEvent, removeRedisUserPresence } from "@/lib/collab/redisRealtime";
import { shouldUseRedisRealtime } from "@/lib/deployment";
import { getMembership, listRoomMembers, requireRoomAccess } from "@/lib/roomAccess";
import type { ClientUser } from "@/lib/types";
import { withJsonErrors } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string; userId: string }> };

/** POST /api/rooms/:code/members/:userId/kick — owner-only member removal. */
async function POSTHandler(request: NextRequest, ctx: RouteContext) {
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

  if (shouldUseRedisRealtime()) {
    await publishRedisEvent(access.code, {
      type: "access_revoked",
      reason: "kicked",
      userId: targetUser.id,
      message: "You were removed from this coding room by the room owner.",
    });
    await removeRedisUserPresence(access.code, targetUser.id);
    const presence = await getRedisPresence(access.code);
    const members = await listRoomMembers(access.room.id, presence);
    await publishRedisEvent(access.code, { type: "member_kick", user: targetUser, members });
  } else {
    const activeRoom = await roomEngine.getRoom(access.code);
    const members = await listRoomMembers(
      access.room.id,
      activeRoom ? [...activeRoom.users.values()] : [],
    );
    if (typeof activeRoom?.notifyMemberKicked === "function") {
      activeRoom.notifyMemberKicked(targetUser, members);
    }
  }

  return NextResponse.json({ ok: true, removed: targetUser });
}

export const POST = withJsonErrors("api.rooms.[code].members.[userId].kick.post", POSTHandler);
