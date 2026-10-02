import { NextRequest, NextResponse } from "next/server";
import { requireRoomAccess } from "@/lib/roomAccess";
import { MAX_STDIN_SIZE } from "@/lib/execution/executor";
import { writeExecutionStdin } from "@/lib/execution/interactiveSessions";
import { SlidingWindowLimiter } from "@/lib/rateLimit";
import { withJsonErrors } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stdinLimiter = new SlidingWindowLimiter(240, 60 * 1000);

type RouteContext = { params: Promise<{ code: string; executionId: string }> };

async function POSTHandler(request: NextRequest, ctx: RouteContext) {
  const { code, executionId } = await ctx.params;

  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  if (!(await stdinLimiter.hitAsync(access.session.user.id))) {
    return NextResponse.json({ error: "Too many input requests. Try again later." }, { status: 429 });
  }

  const body = (await request.json().catch(() => null)) as { input?: unknown } | null;
  const input = typeof body?.input === "string" ? body.input : null;

  if (input === null) {
    return NextResponse.json({ error: "Input is required." }, { status: 400 });
  }

  if (input.length > MAX_STDIN_SIZE) {
    return NextResponse.json({ error: "Input too large (max 10KB)." }, { status: 400 });
  }

  const ok = writeExecutionStdin(executionId, {
    roomCode: access.code,
    userId: access.session.user.id,
    sessionId: access.session.sessionId,
  }, input);

  if (!ok) {
    return NextResponse.json({ error: "Execution is not running or does not belong to this session." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

export const POST = withJsonErrors("api.rooms.[code].execute.[executionId].stdin.post", POSTHandler);
