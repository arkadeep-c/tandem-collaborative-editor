import { NextRequest } from "next/server";
import { newConnectionId, roomEngine } from "@/lib/collab/rooms";
import { resolveDocStore } from "@/lib/collab/store";
import { requireRoomAccess } from "@/lib/roomAccess";
import type { ServerEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ code: string }> };

const PING_INTERVAL_MS = 20_000;

/**
 * GET /api/rooms/:code/stream — the realtime gateway.
 *
 * Authentication happens BEFORE the stream opens: the signed session
 * cookie resolves the user, membership is verified against the database,
 * and only then does the connection join the room. Identity comes from
 * the users table — query params carry nothing security-relevant.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const { code: rawCode } = await ctx.params;
  const access = await requireRoomAccess(rawCode);
  if (!access.ok) {
    return new Response(JSON.stringify({ error: access.error }), {
      status: access.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const room = await roomEngine.getRoom(access.code);
  if (!room) {
    return new Response(JSON.stringify({ error: "Room not found." }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = await resolveDocStore();
  const user = {
    id: access.session.user.id,
    name: access.session.user.name,
    color: access.session.user.color,
  };
  const connectionId = newConnectionId();
  const role = access.member.role === "owner" ? "owner" : "editor";
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: ServerEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
        } catch {
          closed = true;
        }
      };

      room.join(connectionId, user);
      const unsubscribe = room.subscribe(connectionId, send);

      send({
        type: "init",
        room: {
          code: access.code,
          title: room.meta.title,
          language: room.meta.language,
        },
        you: { user, role },
        content: room.content,
        revision: room.revision,
        sessionId: connectionId,
        users: [...room.users.values()],
        cacheMode: store.mode,
      });

      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, PING_INTERVAL_MS);

      const teardown = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        room.leaveConnection(connectionId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener("abort", teardown, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
