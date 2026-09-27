import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { documents, roomMembers, rooms } from "@/db/schema";
import { roomEngine } from "@/lib/collab/rooms";
import { getSessionUser } from "@/lib/session";
import type { RoomSummary } from "@/lib/types";
import { count as drizzleCount } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** GET /api/rooms/mine — rooms the verified session belongs to. */
export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }

  const memberships = await db
    .select({
      code: rooms.code,
      role: roomMembers.role,
      title: documents.title,
      language: documents.language,
      roomId: rooms.id,
      createdAt: rooms.createdAt,
      updatedAt: rooms.updatedAt,
    })
    .from(roomMembers)
    .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
    .innerJoin(documents, eq(rooms.documentId, documents.id))
    .where(eq(roomMembers.userId, session.user.id))
    .orderBy(desc(rooms.updatedAt))
    .limit(100);

  // Member counts for just these rooms (one grouped query, no N+1).
  const memberCounts = new Map<string, number>();
  if (memberships.length > 0) {
    const counts = await db
      .select({
        roomId: roomMembers.roomId,
        total: drizzleCount(),
      })
      .from(roomMembers)
      .where(
        inArray(
          roomMembers.roomId,
          memberships.map((m) => m.roomId),
        ),
      )
      .groupBy(roomMembers.roomId);
    for (const row of counts) memberCounts.set(row.roomId, row.total);
  }

  const payload: RoomSummary[] = memberships.map((m) => ({
    code: m.code,
    title: m.title,
    language: m.language,
    role: m.role === "owner" ? "owner" : "editor",
    memberCount: memberCounts.get(m.roomId) ?? 1,
    activeUsers: roomEngine.getActiveCount(m.code),
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }));

  return NextResponse.json({ rooms: payload });
}
