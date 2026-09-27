import { NextRequest, NextResponse } from "next/server";
import { customAlphabet } from "nanoid";
import { db } from "@/db";
import { documents, roomMembers, rooms } from "@/db/schema";
import { generateRoomCode } from "@/lib/roomCode.server";
import { roomCreateLimiter } from "@/lib/rateLimit";
import {
  createSession,
  getSessionUser,
  serializeSessionCookie,
  SESSION_COOKIE,
  sessionCookieOptions,
  type SessionUser,
} from "@/lib/session";
import { LANGUAGE_STARTERS } from "@/lib/types";
import { cleanTitle, isLanguageId } from "@/lib/validation";

export const dynamic = "force-dynamic";

const newInternalId = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyz",
  16,
);

const CODE_GENERATION_ATTEMPTS = 5;

/**
 * POST /api/rooms — create a room.
 *
 * The creator is ALWAYS the verified session user — the request body may
 * carry a title and a language, never an identity. The server mints a
 * unique human-friendly code (retrying on the UNIQUE constraint), creates
 * the backing document, and records the creator as owner-member.
 */
export async function POST(request: NextRequest) {
  let session: SessionUser | null = await getSessionUser();
  let issueCookie: string | null = null;
  if (!session) {
    const created = await createSession();
    session = { sessionId: created.sessionId, user: created.user };
    issueCookie = serializeSessionCookie(created.token);
  }

  if (!roomCreateLimiter.hit(session.user.id)) {
    return NextResponse.json(
      { error: "Too many rooms created. Try again later." },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    language?: unknown;
  } | null;
  const title = cleanTitle(body?.title) ?? "Untitled";
  const language = isLanguageId(body?.language) ? body.language : "markdown";

  let lastError: unknown = null;
  for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
    const code = generateRoomCode();
    try {
      const [doc, room] = await db.transaction(async (tx) => {
        const [d] = await tx
          .insert(documents)
          .values({
            id: newInternalId(),
            title,
            language,
            content: LANGUAGE_STARTERS[language] ?? "",
          })
          .returning();
        const [r] = await tx
          .insert(rooms)
          .values({
            id: newInternalId(),
            code,
            ownerId: session.user.id,
            documentId: d!.id,
          })
          .returning();
        await tx
          .insert(roomMembers)
          .values({ roomId: r!.id, userId: session.user.id, role: "owner" });
        return [d, r] as const;
      });

      const response = NextResponse.json(
        {
          room: {
            code: room!.code,
            title: doc!.title,
            language: doc!.language,
          },
        },
        { status: 201 },
      );
      if (issueCookie) {
        response.cookies.set(
          SESSION_COOKIE,
          issueCookie,
          sessionCookieOptions(),
        );
      }
      return response;
    } catch (err) {
      lastError = err;
      // Retry only on UNIQUE conflicts (code collision); anything else is fatal.
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        continue;
      }
      break;
    }
  }

  console.error("[rooms] create failed", lastError);
  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}
