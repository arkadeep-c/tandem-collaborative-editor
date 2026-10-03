import { NextRequest, NextResponse } from "next/server";
import { roomEngine } from "@/lib/collab/rooms";
import { applyRedisOperations } from "@/lib/collab/redisRealtime";
import { operationsLimiter } from "@/lib/rateLimit";
import { requireRoomAccess } from "@/lib/roomAccess";
import { validateOps } from "@/lib/validation";
import type { OperationAck, OperationStale } from "@/lib/types";
import { getAuthenticatedSessionFromRequest } from "@/lib/session";
import { shouldUseRedisRealtime } from "@/lib/deployment";
import { withJsonErrors } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

/**
 * POST /api/rooms/:code/operations — edit path. Accepts cookie OR bearer.
 */
async function POSTHandler(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;

  const auth = await getAuthenticatedSessionFromRequest(request);
  const preSession = auth.session;
  if (!preSession) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }

  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = (await request.json().catch(() => null)) as {
    connectionId?: unknown;
    clientMutationId?: unknown;
    baseRevision?: unknown;
    ops?: unknown;
  } | null;

  if (
    !body ||
    typeof body.connectionId !== "string" ||
    !/^c_[a-f0-9]{18}$/.test(body.connectionId) ||
    (body.clientMutationId !== undefined &&
      (typeof body.clientMutationId !== "string" ||
        !/^m_[a-zA-Z0-9_-]{12,96}$/.test(body.clientMutationId))) ||
    !Number.isInteger(body.baseRevision) ||
    (body.baseRevision as number) < 0
  ) {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!(await operationsLimiter.hitAsync(body.connectionId))) {
    return NextResponse.json({ error: "Too many edits." }, { status: 429 });
  }

  const clientMutationId =
    typeof body.clientMutationId === "string" ? body.clientMutationId : undefined;

  const validated = validateOps(body.ops);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 400 });
  }

  if (shouldUseRedisRealtime()) {
    try {
      const result = await applyRedisOperations(
        access,
        body.connectionId,
        body.baseRevision as number,
        validated.ops,
        clientMutationId,
      );
      if ("stale" in result) {
        const payload: OperationStale = {
          ok: false,
          code: "STALE_REVISION",
          revision: result.revision,
          content: result.content,
        };
        return NextResponse.json(payload, { status: 409 });
      }
      const ack: OperationAck = {
        ok: true,
        revision: result.revision,
        clientMutationId: result.clientMutationId,
        ops: result.ops,
        content: result.content,
        savedAt: result.savedAt,
        mode: "redis",
        duplicate: result.duplicate,
      };
      return NextResponse.json(ack);
    } catch (err) {
      if (err instanceof Error && err.message === "UNAUTHORIZED_CONNECTION") {
        return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
      }
      throw err;
    }
  }

  const room = await roomEngine.getRoom(access.code);
  if (!room) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  if (!room.connectionBelongsTo(body.connectionId, access.session.user.id)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
  }

  const result = await room.applyOperations(
    body.connectionId,
    body.baseRevision as number,
    validated.ops,
    clientMutationId,
  );

  if ("stale" in result) {
    const payload: OperationStale = {
      ok: false,
      code: "STALE_REVISION",
      revision: room.revision,
      content: room.content,
    };
    return NextResponse.json(payload, { status: 409 });
  }

  const ack: OperationAck = {
    ok: true,
    revision: result.revision,
    clientMutationId: result.clientMutationId,
    ops: result.ops,
    content: result.content,
    mode: "memory",
    duplicate: result.duplicate,
  };
  return NextResponse.json(ack);
}

export const POST = withJsonErrors("api.rooms.[code].operations.post", POSTHandler);
