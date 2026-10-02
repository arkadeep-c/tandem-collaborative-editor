import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, isUsingLocalDb } from "@/db";
import { users } from "@/db/schema";
import { jsonRouteError } from "@/lib/apiErrors";
import { roomEngine } from "@/lib/collab/rooms";
import { propagateRedisIdentity } from "@/lib/collab/redisRealtime";
import { shouldUseRedisRealtime } from "@/lib/deployment";
import { ensureSeed } from "@/lib/seed";
import {
  createSession,
  createBearerToken,
  getAuthenticatedSessionFromRequest,
  serializeSessionCookie,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";
import { cleanName, isPresenceColor } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/session — idempotent session bootstrap.
 * PRIMARY: HttpOnly signed cookie
 * FALLBACK: Signed bearer token in JSON when cookie unavailable (Arena iframe)
 */
export async function GET(request: NextRequest) {
  try {
      await ensureSeed().catch((err) => console.error("[seed]", err));

      const auth = await getAuthenticatedSessionFromRequest(request);
      if (auth.session) {
        const responseBody: any = {
          user: {
            id: auth.session.user.id,
            name: auth.session.user.name,
            color: auth.session.user.color,
          },
          fresh: false,
        };
        // If cookie not valid (authenticated via bearer), return bearer token for client storage
        if (!auth.cookieValid) {
          responseBody.sessionToken = createBearerToken(auth.session.sessionId);
        }
        return NextResponse.json(responseBody);
      }

      const created = await createSession();
      const bearer = createBearerToken(created.sessionId);
      const response = NextResponse.json({
        user: {
          id: created.user.id,
          name: created.user.name,
          color: created.user.color,
        },
        fresh: true,
        sessionToken: bearer,
      });
      response.cookies.set(
        SESSION_COOKIE,
        serializeSessionCookie(created.token),
        sessionCookieOptions(),
      );
      return response;
  } catch (err) {
    return jsonRouteError(err, "session:get");
  }
}

/**
 * PATCH /api/session — update the CALLER'S cosmetic profile (display name,
 * presence color). Accepts cookie OR bearer fallback.
 */
export async function PATCH(request: NextRequest) {
  try {
      const auth = await getAuthenticatedSessionFromRequest(request);
      const session = auth.session;
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

      let user: any;
      if (isUsingLocalDb()) {
        user = (db as any).update(users).set(patch).where(eq(users.id, session.user.id)).returning().get();
      } else {
        const [u] = await (db as any)
          .update(users)
          .set(patch)
          .where(eq(users.id, session.user.id))
          .returning();
        user = u;
      }

      if (shouldUseRedisRealtime()) {
        await propagateRedisIdentity(session.user.id, {
          name: user!.name,
          color: user!.color,
        });
      } else {
        roomEngine.propagateIdentity(session.user.id, {
          name: user!.name,
          color: user!.color,
        });
      }

      const responseBody: any = {
        user: { id: user!.id, name: user!.name, color: user!.color },
      };
      if (!auth.cookieValid) {
        responseBody.sessionToken = createBearerToken(session.sessionId);
      }

      return NextResponse.json(responseBody);
  } catch (err) {
    return jsonRouteError(err, "session:patch");
  }
}
