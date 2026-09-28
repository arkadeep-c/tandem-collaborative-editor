import { NextRequest, NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { documents, roomMembers, rooms } from "@/db/schema";
import { roomEngine } from "@/lib/collab/rooms";
import { getAuthenticatedSessionFromRequest } from "@/lib/session";
import type { RoomSummary } from "@/lib/types";
import { count as drizzleCount } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** GET /api/rooms/mine — rooms the verified session belongs to. Accepts cookie OR bearer. */
export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedSessionFromRequest(request);
  const session = auth.session;
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
      locked: rooms.locked,
      createdAt: rooms.createdAt,
      updatedAt: rooms.updatedAt,
    })
    .from(roomMembers)
    .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
    .innerJoin(documents, eq(rooms.documentId, documents.id))
    .where(eq(roomMembers.userId, session.user.id))
    .orderBy(desc(rooms.updatedAt))
    .limit(100);

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
          memberships.map((m: any) => m.roomId),
        ),
      )
      .groupBy(roomMembers.roomId);
    for (const row of counts) memberCounts.set(row.roomId, row.total);
  }

  const payload: RoomSummary[] = memberships.map((m: any) => ({
    code: m.code,
    title: m.title,
    language: m.language,
    role: m.role === "owner" ? "owner" : "editor",
    locked: Boolean(m.locked),
    memberCount: memberCounts.get(m.roomId) ?? 1,
    activeUsers: roomEngine.getActiveCount(m.code),
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }));

  return NextResponse.json({ rooms: payload });
}
