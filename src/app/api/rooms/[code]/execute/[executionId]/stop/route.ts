import { NextRequest, NextResponse } from "next/server";
import { requireRoomAccess } from "@/lib/roomAccess";
import { stopExecutionSession } from "@/lib/execution/interactiveSessions";
import { SlidingWindowLimiter } from "@/lib/rateLimit";
import { withJsonErrors } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stopLimiter = new SlidingWindowLimiter(60, 60 * 1000);

type RouteContext = { params: Promise<{ code: string; executionId: string }> };

async function POSTHandler(request: NextRequest, ctx: RouteContext) {
  const { code, executionId } = await ctx.params;

  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  if (!(await stopLimiter.hitAsync(access.session.user.id))) {
    return NextResponse.json({ error: "Too many stop requests. Try again later." }, { status: 429 });
  }

  const ok = stopExecutionSession(executionId, {
    roomCode: access.code,
    userId: access.session.user.id,
    sessionId: access.session.sessionId,
  });

  if (!ok) {
    return NextResponse.json({ error: "Execution is not running or does not belong to this session." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

export const POST = withJsonErrors("api.rooms.[code].execute.[executionId].stop.post", POSTHandler);
