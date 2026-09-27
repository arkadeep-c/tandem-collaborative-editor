import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { roomEngine } from "@/lib/collab/rooms";
import { ensureSeed } from "@/lib/seed";
import {
  createSession,
  getSessionUser,
  serializeSessionCookie,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";
import { cleanName, isPresenceColor } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * GET /api/session — idempotent session bootstrap.
 * Returns the verified anonymous user; provisions one (user + signed
 * HttpOnly cookie) when the browser arrives empty-handed or expired.
 */
export async function GET() {
  await ensureSeed().catch((err) => console.error("[seed]", err));

  const existing = await getSessionUser();
  if (existing) {
    return NextResponse.json({
      user: {
        id: existing.user.id,
        name: existing.user.name,
        color: existing.user.color,
      },
      fresh: false,
    });
  }

  const created = await createSession();
  const response = NextResponse.json({
    user: {
      id: created.user.id,
      name: created.user.name,
      color: created.user.color,
    },
    fresh: true,
  });
  response.cookies.set(
    SESSION_COOKIE,
    serializeSessionCookie(created.token),
    sessionCookieOptions(),
  );
  return response;
}

/**
 * PATCH /api/session — update the CALLER'S cosmetic profile (display name,
 * presence color). The user id is never accepted from the client.
 */
export async function PATCH(request: NextRequest) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    color?: unknown;
  } | null;

  const patch: { name?: string; color?: string } = {};
  if (body?.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) {
      return NextResponse.json({ error: "Invalid display name." }, { status: 400 });
    }
    patch.name = name;
  }
  if (body?.color !== undefined) {
    if (!isPresenceColor(body.color)) {
      return NextResponse.json({ error: "Invalid color." }, { status: 400 });
    }
    patch.color = body.color;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const [user] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, session.user.id))
    .returning();

  // Live rooms re-publish the new identity immediately.
  roomEngine.propagateIdentity(session.user.id, {
    name: user!.name,
    color: user!.color,
  });

  return NextResponse.json({
    user: { id: user!.id, name: user!.name, color: user!.color },
  });
}
