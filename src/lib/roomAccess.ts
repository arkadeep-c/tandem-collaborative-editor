import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import {
  documents,
  roomMembers,
  rooms,
  type DocumentRow,
  type RoomMemberRow,
  type RoomRow,
} from "@/db/schema";
import {
  getAuthenticatedSessionFromRequest,
  getSessionUser,
  type SessionUser,
} from "@/lib/session";
import { isValidRoomCode, normalizeRoomCode } from "@/lib/roomCode";

/**
 * Central authorization gate for every room-scoped route.
 * Supports cookie primary + bearer fallback.
 */

export interface RoomWithDocument {
  room: RoomRow;
  document: DocumentRow;
}

export async function findRoomByCode(
  rawCode: string,
): Promise<RoomWithDocument | null> {
  const code = normalizeRoomCode(rawCode);
  if (!isValidRoomCode(code)) return null;
  const rows = await db
    .select({ room: rooms, document: documents })
    .from(rooms)
    .innerJoin(documents, eq(rooms.documentId, documents.id))
    .where(eq(rooms.code, code))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMembership(
  roomId: string,
  userId: string,
): Promise<RoomMemberRow | null> {
  const rows = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export type RoomAccess =
  | {
      ok: true;
      session: SessionUser;
      code: string;
      room: RoomRow;
      document: DocumentRow;
      member: RoomMemberRow;
    }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string };

export interface RoomAccessOptions {
  ownerOnly?: boolean;
}

export async function requireRoomAccess(
  rawCode: string,
  request?: NextRequest,
  options: RoomAccessOptions = {},
): Promise<RoomAccess> {
  let session: SessionUser | null = null;
  if (request) {
    const auth = await getAuthenticatedSessionFromRequest(request);
    session = auth.session;
  } else {
    session = await getSessionUser();
  }

  if (!session) {
    return { ok: false, status: 401, error: "Session expired." };
  }

  const code = normalizeRoomCode(rawCode);
  if (!isValidRoomCode(code)) {
    return { ok: false, status: 400, error: "Invalid room code." };
  }

  const found = await findRoomByCode(code);
  if (!found) {
    return { ok: false, status: 404, error: "Room not found." };
  }

  const member = await getMembership(found.room.id, session.user.id);
  if (!member) {
    return { ok: false, status: 403, error: "Unauthorized." };
  }
  if (options.ownerOnly && member.role !== "owner") {
    return { ok: false, status: 403, error: "Only the room owner can do that." };
  }

  return {
    ok: true,
    session,
    code,
    room: found.room,
    document: found.document,
    member,
  };
}
