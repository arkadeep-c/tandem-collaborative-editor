"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyOp, rebaseSequentialOps } from "@/lib/ot";
import type {
  ClientUser,
  CursorPosition,
  OperationBatch,
  PresenceState,
  RoomMemberInfo,
  RoomRole,
  SelectionRange,
  ServerEvent,
  TextOp,
} from "@/lib/types";
import { showToast } from "@/components/ui/Toast";
import { apiFetch, ensureClientSession, getAuthDiagnostics, getStoredToken } from "@/lib/apiFetch";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface EditorBridge {
  applyRemote(ops: TextOp[]): void;
  reset(content: string): void;
}

export interface CollabState {
  connection: ConnectionStatus;
  selfSessionId: string;
  you: ClientUser | null;
  role: RoomRole;
  users: PresenceState[];
  members: RoomMemberInfo[];
  locked: boolean;
  accessRevokedMessage: string | null;
  title: string;
  language: string;
  revision: number;
  syncedRevision: number;
  savedAt: string | null;
  cacheMode: "redis" | "memory" | null;
  unsent: boolean;
}

export interface PresencePatch {
  cursor: CursorPosition | null;
  selection: SelectionRange | null;
  typing: boolean;
}

const RECONNECT_DELAY_MS = 1_500;
const MAX_STREAM_FAILURES = 5;
const GONE_AFTER_MS = 15_000;

type SessionResponse = {
  user: { id: string; name: string; color: string };
  fresh: boolean;
  sessionToken?: string;
};

function roleForSelf(members: RoomMemberInfo[], userId?: string): RoomRole | null {
  if (!userId) return null;
  return members.find((member) => member.user.id === userId)?.role ?? null;
}

export function useCollaborativeDocument(roomCode: string) {
  const [state, setState] = useState<CollabState>({
    connection: "connecting",
    selfSessionId: "",
    you: null,
    role: "editor",
    users: [],
    members: [],
    locked: false,
    accessRevokedMessage: null,
    title: "",
    language: "markdown",
    revision: 0,
    syncedRevision: 0,
    savedAt: null,
    cacheMode: null,
    unsent: false,
  });

  const connectionIdRef = useRef("");
  const revisionRef = useRef(0);
  const outstandingRef = useRef<TextOp[] | null>(null);
  const bufferRef = useRef<TextOp[]>([]);
  const bridgeRef = useRef<EditorBridge | null>(null);
  const snapshotRef = useRef<{ content: string } | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failuresRef = useRef(0);

  const patchState = useCallback(
    (patch: Partial<CollabState>) => setState((prev) => ({ ...prev, ...patch })),
    [],
  );

  const pump = useCallback(async () => {
    if (outstandingRef.current || bufferRef.current.length === 0) return;
    const hasEventSource = sourceRef.current && sourceRef.current.readyState === EventSource.OPEN;
    const hasFetchStream = fetchControllerRef.current && !fetchControllerRef.current.signal.aborted;
    if (!hasEventSource && !hasFetchStream) {
      return;
    }
    if (!connectionIdRef.current) return;

    const batch: OperationBatch = {
      connectionId: connectionIdRef.current,
      baseRevision: revisionRef.current,
      ops: bufferRef.current,
    };
    bufferRef.current = [];
    outstandingRef.current = batch.ops;
    patchState({ unsent: true });

    try {
      const res = await apiFetch(
        `/api/rooms/${encodeURIComponent(roomCode)}/operations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        },
      );

      if (res.status === 409) {
        const stale = (await res.json()) as {
          revision: number;
          content: string;
        };
        outstandingRef.current = null;
        bufferRef.current = [];
        revisionRef.current = stale.revision;
        snapshotRef.current = { content: stale.content };
        bridgeRef.current?.reset(stale.content);
        patchState({ revision: stale.revision, syncedRevision: stale.revision, unsent: false });
        return;
      }
      if (!res.ok) throw new Error(`operations failed: ${res.status}`);
    } catch {
      outstandingRef.current = null;
      bufferRef.current = [];
      patchState({ unsent: false });
      sourceRef.current?.close();
      sourceRef.current = null;
      fetchControllerRef.current?.abort();
      fetchControllerRef.current = null;
      patchState({ connection: "reconnecting" });
      reconnectTimerRef.current = setTimeout(
        () => void openStreamRef.current(),
        RECONNECT_DELAY_MS,
      );
    }
  }, [roomCode, patchState]);

  const pumpRef = useRef(pump);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  const openStreamRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let disposed = false;

    const handleEvent = (event: ServerEvent) => {
      if (disposed) return;
      switch (event.type) {
        case "init": {
          failuresRef.current = 0;
          connectionIdRef.current = event.sessionId;
          revisionRef.current = event.revision;
          outstandingRef.current = null;
          bufferRef.current = [];
          snapshotRef.current = { content: event.content };
          bridgeRef.current?.reset(event.content);
          setState((prev) => ({
            ...prev,
            connection: "connected",
            selfSessionId: event.sessionId,
            you: event.you.user,
            role: event.you.role,
            users: event.users,
            members: event.members ?? [],
            locked: event.room.locked ?? false,
            accessRevokedMessage: null,
            title: event.room.title,
            language: event.room.language,
            revision: event.revision,
            syncedRevision: event.revision,
            cacheMode: event.cacheMode,
            unsent: false,
          }));
          break;
        }
        case "op": {
          if (snapshotRef.current && event.ops.length > 0) {
            for (const op of event.ops) {
              snapshotRef.current.content = applyOp(snapshotRef.current.content, op);
            }
          }
          if (event.by === connectionIdRef.current) {
            revisionRef.current = event.revision;
            outstandingRef.current = null;
            setState((prev) => ({
              ...prev,
              revision: event.revision,
              unsent: bufferRef.current.length > 0,
            }));
            void pumpRef.current();
            break;
          }
          const preceding = [
            ...(outstandingRef.current ?? []),
            ...bufferRef.current,
          ];
          const visual = rebaseSequentialOps(event.ops, preceding);
          if (outstandingRef.current) {
            outstandingRef.current = rebaseSequentialOps(
              outstandingRef.current,
              event.ops,
            );
          }
          bufferRef.current = rebaseSequentialOps(bufferRef.current, event.ops);
          if (visual.length > 0) bridgeRef.current?.applyRemote(visual);
          revisionRef.current = event.revision;
          setState((prev) => ({ ...prev, revision: event.revision }));
          break;
        }
        case "presence": {
          setState((prev) => {
            const idx = prev.users.findIndex(
              (u) => u.sessionId === event.user.sessionId,
            );
            const users =
              idx === -1
                ? [...prev.users, event.user]
                : prev.users.map((u) =>
                    u.sessionId === event.user.sessionId ? event.user : u,
                  );
            const you = prev.you?.id === event.user.user.id ? event.user.user : prev.you;
            const onlineIds = new Set(users.map((presence) => presence.user.id));
            const members = prev.members.map((member) =>
              member.user.id === event.user.user.id
                ? {
                    ...member,
                    user: event.user.user,
                    online: onlineIds.has(member.user.id),
                  }
                : { ...member, online: onlineIds.has(member.user.id) },
            );
            return { ...prev, users, members, you };
          });
          break;
        }
        case "leave": {
          setState((prev) => {
            const users = prev.users.filter((u) => u.sessionId !== event.sessionId);
            const onlineIds = new Set(users.map((presence) => presence.user.id));
            return {
              ...prev,
              users,
              members: prev.members.map((member) => ({
                ...member,
                online: onlineIds.has(member.user.id),
              })),
            };
          });
          break;
        }
        case "member_join": {
          showToast(`${event.user.name} joined your coding room`, "info");
          setState((prev) => {
            const members = event.members ?? prev.members;
            return {
              ...prev,
              members,
              role: roleForSelf(members, prev.you?.id) ?? prev.role,
            };
          });
          break;
        }
        case "member_leave": {
          showToast(`${event.user.name} left the room`, "info");
          setState((prev) => {
            const members = event.members ?? prev.members;
            return {
              ...prev,
              members,
              role: roleForSelf(members, prev.you?.id) ?? prev.role,
            };
          });
          break;
        }
        case "member_kick": {
          showToast(`${event.user.name} was removed from the room`, "info");
          setState((prev) => {
            const members = event.members ?? prev.members;
            return {
              ...prev,
              members,
              role: roleForSelf(members, prev.you?.id) ?? prev.role,
            };
          });
          break;
        }
        case "members": {
          setState((prev) => {
            const members = event.members ?? prev.members;
            return {
              ...prev,
              members,
              role: roleForSelf(members, prev.you?.id) ?? prev.role,
            };
          });
          break;
        }
        case "room_lock": {
          showToast(event.locked ? "Room locked" : "Room unlocked", "info");
          setState((prev) => ({ ...prev, locked: event.locked }));
          break;
        }
        case "access_revoked": {
          showToast(event.message, "error");
          sourceRef.current?.close();
          sourceRef.current = null;
          fetchControllerRef.current?.abort();
          fetchControllerRef.current = null;
          setState((prev) => ({
            ...prev,
            connection: "error",
            accessRevokedMessage: event.message,
            users: [],
            members: [],
          }));
          break;
        }
        case "meta": {
          setState((prev) => ({
            ...prev,
            title: event.title ?? prev.title,
            language: event.language ?? prev.language,
          }));
          break;
        }
        case "saved": {
          setState((prev) => ({
            ...prev,
            syncedRevision: Math.max(prev.syncedRevision, event.revision),
            savedAt: event.savedAt,
            cacheMode: event.mode,
          }));
          break;
        }
        case "error":
          break;
      }
    };

    const parseSseChunk = (chunk: string, buffer: { text: string }) => {
      buffer.text += chunk;
      const events: { event: string; data: string }[] = [];
      let idx: number;
      while ((idx = buffer.text.indexOf("\n\n")) !== -1) {
        const raw = buffer.text.slice(0, idx);
        buffer.text = buffer.text.slice(idx + 2);
        if (!raw.trim() || raw.startsWith(":")) continue; // ping or empty
        let eventName = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data += line.slice(5).trim();
          }
        }
        if (data) {
          events.push({ event: eventName, data });
        }
      }
      return events;
    };

    const openFetchStream = async () => {
      if (disposed) return;
      try {
        const controller = new AbortController();
        fetchControllerRef.current = controller;

        const res = await apiFetch(
          `/api/rooms/${encodeURIComponent(roomCode)}/stream`,
          {
            method: "GET",
            headers: { Accept: "text/event-stream" },
            signal: controller.signal,
          },
        );

        if (!res.ok) throw new Error(`stream: ${res.status}`);
        if (!res.body) throw new Error("no body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const buf = { text: "" };

        while (!disposed) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const evts = parseSseChunk(chunk, buf);
          for (const e of evts) {
            try {
              const parsed = JSON.parse(e.data) as ServerEvent;
              // Ensure event type matches SSE event name if needed
              if (!parsed.type) {
                (parsed as any).type = e.event;
              }
              handleEvent(parsed);
            } catch {
              // ignore malformed
            }
          }
        }
      } catch (err) {
        if (disposed) return;
        if ((err as any)?.name === "AbortError") return;
        fetchControllerRef.current = null;
        scheduleReconnect();
      }
    };

    const openEventSource = async () => {
      if (disposed) return;
      const source = new EventSource(
        `/api/rooms/${encodeURIComponent(roomCode)}/stream`,
        { withCredentials: true } as EventSourceInit,
      );
      sourceRef.current = source;

      for (const type of [
        "init",
        "op",
        "presence",
        "leave",
        "member_join",
        "member_leave",
        "member_kick",
        "members",
        "room_lock",
        "access_revoked",
        "meta",
        "saved",
      ] as const) {
        source.addEventListener(type, (raw) => {
          try {
            handleEvent(JSON.parse((raw as MessageEvent).data) as ServerEvent);
          } catch {
            /* malformed frame — ignore */
          }
        });
      }

      source.onerror = () => {
        if (disposed) return;
        source.close();
        sourceRef.current = null;
        scheduleReconnect();
      };
    };

    const open = async () => {
      if (disposed) return;
      try {
        console.log("[SSE] SESSION_BOOTSTRAP start");
        const diag = getAuthDiagnostics();
        console.log("[SSE] COOKIE_AVAILABLE", { available: diag.cookieAvailable });
        console.log("[SSE] MEMORY_TOKEN_AVAILABLE", { available: diag.memoryToken });
        console.log("[SSE] WINDOW_NAME_TOKEN_AVAILABLE", { available: diag.windowNameToken });
        const sessData = (await ensureClientSession()) as SessionResponse | null | undefined;
        if (!sessData || !sessData.user) {
          console.error("[SSE] SESSION_BOOTSTRAP invalid data", { sessData });
          throw new Error("Invalid session");
        }
        console.log("[SSE] SESSION_READY", { id: sessData.user?.id?.slice(0, 8) });
      } catch {
        scheduleReconnect();
        return;
      }
      if (disposed) return;

      const token = getStoredToken();
      console.log("[SSE] SSE_CONNECT", { mode: token ? "bearer-fetch" : "cookie-eventsource", hasToken: !!token });
      if (token) {
        await openFetchStream();
      } else {
        await openEventSource();
      }
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      failuresRef.current += 1;
      if (failuresRef.current >= MAX_STREAM_FAILURES) {
        patchState({ connection: "error" });
        return;
      }
      patchState({ connection: "reconnecting" });
      reconnectTimerRef.current = setTimeout(
        () => void openStreamRef.current(),
        RECONNECT_DELAY_MS,
      );
    };

    // A reconnect timer needs the latest opener without re-subscribing the stream effect.
    // eslint-disable-next-line react-hooks/immutability
    openStreamRef.current = open;
    void open();

    presenceTimerRef.current = setInterval(() => {
      setState((prev) => {
        const now = Date.now();
        const alive = prev.users.filter(
          (u) =>
            u.sessionId === prev.selfSessionId ||
            now - u.lastActiveAt < GONE_AFTER_MS,
        );
        if (alive.length === prev.users.length) return prev;
        const onlineIds = new Set(alive.map((presence) => presence.user.id));
        return {
          ...prev,
          users: alive,
          members: prev.members.map((member) => ({
            ...member,
            online: onlineIds.has(member.user.id),
          })),
        };
      });
    }, 5_000);

    return () => {
      disposed = true;
      sourceRef.current?.close();
      sourceRef.current = null;
      fetchControllerRef.current?.abort();
      fetchControllerRef.current = null;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
    };
  }, [roomCode, patchState]);

  const setBridge = useCallback((bridge: EditorBridge | null) => {
    bridgeRef.current = bridge;
    if (bridge && snapshotRef.current) {
      bridge.reset(snapshotRef.current.content);
    }
  }, []);

  const submitLocalOps = useCallback(
    (ops: TextOp[]) => {
      if (ops.length === 0) return;
      bufferRef.current.push(...ops);
      patchState({ unsent: true });
      void pumpRef.current();
    },
    [patchState],
  );

  const publishPresence = useCallback(
    (patch: PresencePatch) => {
      const connectionId = connectionIdRef.current;
      if (!connectionId) return;
      void apiFetch(`/api/rooms/${encodeURIComponent(roomCode)}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, ...patch }),
      }).catch(() => undefined);
    },
    [roomCode],
  );

  const updateMeta = useCallback(
    async (patch: { title?: string; language?: string }) => {
      await apiFetch(`/api/rooms/${encodeURIComponent(roomCode)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => undefined);
    },
    [roomCode],
  );

  return { state, setBridge, submitLocalOps, publishPresence, updateMeta };
}
