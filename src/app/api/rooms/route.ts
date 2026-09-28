import { NextRequest, NextResponse } from "next/server";
import { customAlphabet } from "nanoid";
import { db, isUsingLocalDb } from "@/db";
import { documents, roomMembers, rooms } from "@/db/schema";
import { generateRoomCode } from "@/lib/roomCode.server";
import { roomCreateLimiter } from "@/lib/rateLimit";
import {
  createSession,
  createBearerToken,
  getAuthenticatedSessionFromRequest,
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
 * POST /api/rooms — create a room. Accepts cookie OR bearer fallback.
 */
export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedSessionFromRequest(request);
  let session: SessionUser | null = auth.session;
  let issueCookie: string | null = null;
  let issueBearer: string | null = null;

  if (!session) {
    const created = await createSession();
    session = { sessionId: created.sessionId, user: created.user };
    issueCookie = serializeSessionCookie(created.token);
    issueBearer = createBearerToken(created.sessionId);
  } else if (!auth.cookieValid) {
    // Authenticated via bearer, ensure client keeps token
    issueBearer = createBearerToken(session.sessionId);
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
    starter?: unknown;
  } | null;
  const title = cleanTitle(body?.title) ?? "Untitled";
  const language = isLanguageId(body?.language) ? body.language : "markdown";
  const starterRequested = body?.starter === true;
  const initialContent = starterRequested ? LANGUAGE_STARTERS[language] ?? "" : "";

  let lastError: unknown = null;
  for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
    const code = generateRoomCode();
    try {
      let doc: any;
      let room: any;

      if (isUsingLocalDb()) {
        const result = (db as any).transaction((tx: any) => {
          const d = tx
            .insert(documents)
            .values({
              id: newInternalId(),
              title,
              language,
              content: initialContent,
            })
            .returning()
            .get();
          const r = tx
            .insert(rooms)
            .values({
              id: newInternalId(),
              code,
              ownerId: session!.user.id,
              documentId: d!.id,
            })
            .returning()
            .get();
          tx.insert(roomMembers).values({
            roomId: r!.id,
            userId: session!.user.id,
            role: "owner",
          }).run();
          return [d, r] as const;
        });
        [doc, room] = result;
      } else {
        const [d, r] = await (db as any).transaction(async (tx: any) => {
          const [docRow] = await tx
            .insert(documents)
            .values({
              id: newInternalId(),
              title,
              language,
              content: initialContent,
            })
            .returning();
          const [roomRow] = await tx
            .insert(rooms)
            .values({
              id: newInternalId(),
              code,
              ownerId: session!.user.id,
              documentId: docRow!.id,
            })
            .returning();
          await tx
            .insert(roomMembers)
            .values({ roomId: roomRow!.id, userId: session!.user.id, role: "owner" });
          return [docRow, roomRow] as const;
        });
        doc = d;
        room = r;
      }

      const responseBody: any = {
        room: {
          code: room!.code,
          title: doc!.title,
          language: doc!.language,
          locked: false,
        },
      };
      if (issueBearer && !auth.cookieValid) {
        responseBody.sessionToken = issueBearer;
      }

      const response = NextResponse.json(responseBody, { status: 201 });
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
      const isUniqueConflict =
        (typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code?: string }).code === "23505") ||
        (err instanceof Error && /UNIQUE|unique/i.test(err.message));
      if (isUniqueConflict) {
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
