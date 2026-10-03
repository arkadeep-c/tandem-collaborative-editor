import { NextRequest } from "next/server";
import { newConnectionId, roomEngine } from "@/lib/collab/rooms";
import { resolveDocStore } from "@/lib/collab/store";
import {
  buildRedisInitEvent,
  joinRedisPresence,
  leaveRedisPresence,
  refreshRedisPresence,
  subscribeRedisRoom,
} from "@/lib/collab/redisRealtime";
import { shouldUseRedisRealtime } from "@/lib/deployment";
import { listRoomMembers, requireRoomAccess } from "@/lib/roomAccess";
import type { ServerEvent } from "@/lib/types";
import { withJsonErrors } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ code: string }> };

const PING_INTERVAL_MS = 20_000;

function jsonStreamError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function GETHandler(request: NextRequest, ctx: RouteContext) {
  const { code: rawCode } = await ctx.params;
  const access = await requireRoomAccess(rawCode, request);
  if (!access.ok) {
    return jsonStreamError(access.error, access.status);
  }

  const user = {
    id: access.session.user.id,
    name: access.session.user.name,
    color: access.session.user.color,
  };
  const connectionId = newConnectionId();
  const encoder = new TextEncoder();

  if (shouldUseRedisRealtime()) {
    const members = await listRoomMembers(access.room.id);

    let cleanup: (() => Promise<void>) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        let unsubscribe: (() => Promise<void>) | null = null;
        let ping: ReturnType<typeof setInterval> | null = null;

        const teardown = async () => {
          if (closed) return;
          closed = true;
          if (ping) clearInterval(ping);
          await unsubscribe?.().catch(() => undefined);
          await leaveRedisPresence(access.code, connectionId).catch(() => undefined);
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        cleanup = teardown;

        const send = (event: ServerEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          } catch {
            void teardown();
          }
        };

        try {
          await joinRedisPresence(access.code, connectionId, user);
          unsubscribe = await subscribeRedisRoom(access.code, send);
          send(await buildRedisInitEvent(access, connectionId, members));
          if (closed) return;
          ping = setInterval(() => {
            void refreshRedisPresence(access.code, connectionId).catch(() => undefined);
            try {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            } catch {
              void teardown();
            }
          }, PING_INTERVAL_MS);
          request.signal.addEventListener("abort", () => void teardown(), { once: true });
        } catch (err) {
          console.error("[stream] redis realtime failed", err);
          send({ type: "error", message: "Realtime service is unavailable." });
          await teardown();
        }
      },
      async cancel() {
        await cleanup?.();
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

  const room = await roomEngine.getRoom(access.code);
  if (!room) {
    return jsonStreamError("Room not found.", 404);
  }

  const store = await resolveDocStore();
  const role = access.member.role === "owner" ? "owner" : "editor";
  const members = await listRoomMembers(access.room.id);

  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => undefined;
      let ping: ReturnType<typeof setInterval> | null = null;

      const teardown = () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        unsubscribe();
        room.leaveConnection(connectionId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const send = (event: ServerEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          teardown();
        }
      };

      room.join(connectionId, user);
      unsubscribe = room.subscribe(connectionId, send);
      const activeUserIds = new Set([...room.users.values()].map((presence) => presence.user.id));

      send({
        type: "init",
        room: {
          code: access.code,
          title: room.meta.title,
          language: room.meta.language,
          locked: room.meta.locked,
          templateMode: room.meta.templateMode,
        },
        you: { user, role },
        content: room.content,
        revision: room.revision,
        sessionId: connectionId,
        users: [...room.users.values()],
        members: members.map((member) => ({ ...member, online: activeUserIds.has(member.user.id) })),
        cacheMode: store.mode,
      });
      if (closed) return;

      ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          teardown();
        }
      }, PING_INTERVAL_MS);
      cleanup = teardown;

      request.signal.addEventListener("abort", teardown, { once: true });
    },
    cancel() {
      cleanup?.();
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

export const GET = withJsonErrors("api.rooms.[code].stream.get", GETHandler);
