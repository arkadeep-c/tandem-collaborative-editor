"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { transformBatch } from "@/lib/ot";
import type {
  ClientUser,
  CursorPosition,
  OperationBatch,
  PresenceState,
  RoomRole,
  SelectionRange,
  ServerEvent,
  TextOp,
} from "@/lib/types";

/**
 * useCollaborativeDocument — browser-side OT client for one room.
 *
 * Identity enters this hook exclusively FROM the server:
 *   GET /api/session (signed HttpOnly cookie) → stream init snapshot
 *   carries { you, sessionId } — the client never asserts who it is.
 *
 * Sync FSM (see README): revision / outstanding / buffer, with the
 * author's echo acting as the ordered ack.
 */

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
};

export function useCollaborativeDocument(roomCode: string) {
  const [state, setState] = useState<CollabState>({
    connection: "connecting",
    selfSessionId: "",
    you: null,
    role: "editor",
    users: [],
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
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failuresRef = useRef(0);

  const patchState = useCallback(
    (patch: Partial<CollabState>) => setState((prev) => ({ ...prev, ...patch })),
    [],
  );

  /* ------------------------------------------------------------------ */
  /* Ops upload                                                          */
  /* ------------------------------------------------------------------ */

  const pump = useCallback(async () => {
    if (outstandingRef.current || bufferRef.current.length === 0) return;
    if (!sourceRef.current || sourceRef.current.readyState !== EventSource.OPEN) {
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
      const res = await fetch(
        `/api/rooms/${encodeURIComponent(roomCode)}/operations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
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
        bridgeRef.current?.reset(stale.content);
        patchState({ revision: stale.revision, unsent: false });
        return;
      }
      if (!res.ok) throw new Error(`operations failed: ${res.status}`);
      // Success completes via the ordered stream echo.
    } catch {
      // Transport/security failure — close the stream and let the
      // reconnect path restore an authoritative snapshot.
      outstandingRef.current = null;
      bufferRef.current = [];
      patchState({ unsent: false });
      sourceRef.current?.close();
      sourceRef.current = null;
      patchState({ connection: "reconnecting" });
      reconnectTimerRef.current = setTimeout(
        () => void openStreamRef.current(),
        RECONNECT_DELAY_MS,
      );
    }
  }, [roomCode, patchState]);

  const pumpRef = useRef(pump);
  pumpRef.current = pump;

  /* ------------------------------------------------------------------ */
  /* Event stream                                                        */
  /* ------------------------------------------------------------------ */

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
            title: event.room.title,
            language: event.room.language,
            revision: event.revision,
            cacheMode: event.cacheMode,
            unsent: false,
          }));
          break;
        }
        case "op": {
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
          const visual = transformBatch(event.ops, preceding);
          if (outstandingRef.current) {
            outstandingRef.current = transformBatch(
              outstandingRef.current,
              event.ops,
            );
          }
          bufferRef.current = transformBatch(bufferRef.current, event.ops);
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
            return { ...prev, users };
          });
          break;
        }
        case "leave": {
          setState((prev) => ({
            ...prev,
            users: prev.users.filter((u) => u.sessionId !== event.sessionId),
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

    const open = async () => {
      if (disposed) return;
      try {
        // Ensure the cookie session exists before opening the stream
        // (covers expiry between page load and connect).
        const res = await fetch("/api/session", { credentials: "same-origin" });
        if (!res.ok) throw new Error(`session: ${res.status}`);
        (await res.json()) as SessionResponse;
      } catch {
        scheduleReconnect();
        return;
      }
      if (disposed) return;

      const source = new EventSource(
        `/api/rooms/${encodeURIComponent(roomCode)}/stream`,
      );
      sourceRef.current = source;

      for (const type of [
        "init",
        "op",
        "presence",
        "leave",
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
        return alive.length === prev.users.length
          ? prev
          : { ...prev, users: alive };
      });
    }, 5_000);

    return () => {
      disposed = true;
      sourceRef.current?.close();
      sourceRef.current = null;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
    };
  }, [roomCode, patchState]);

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

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
      void fetch(`/api/rooms/${encodeURIComponent(roomCode)}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ connectionId, ...patch }),
      }).catch(() => undefined);
    },
    [roomCode],
  );

  const updateMeta = useCallback(
    async (patch: { title?: string; language?: string }) => {
      await fetch(`/api/rooms/${encodeURIComponent(roomCode)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(patch),
      }).catch(() => undefined);
    },
    [roomCode],
  );

  return { state, setBridge, submitLocalOps, publishPresence, updateMeta };
}
