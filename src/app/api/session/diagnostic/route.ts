import { NextRequest, NextResponse } from "next/server";
import { getSessionDiagnostics, getAuthenticatedSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/session/diagnostic — development-only cookie persistence test.
 */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await getAuthenticatedSessionFromRequest(request);
  const session = auth.session;
  const diagnostics = getSessionDiagnostics();

  return NextResponse.json({
    hasSession: Boolean(session),
    via: auth.via,
    cookieValid: auth.cookieValid,
    user: session
      ? {
          id: session.user.id.slice(0, 8) + "...",
          name: session.user.name,
          color: session.user.color,
        }
      : null,
    diagnostics,
    checks: {
      description:
        "To verify persistence manually: GET /api/session twice should return same user id. " +
        "PATCH /api/session should keep same user. If ids differ, browser is blocking cookies. Bearer fallback should keep same id via sessionStorage.",
    },
  });
}
