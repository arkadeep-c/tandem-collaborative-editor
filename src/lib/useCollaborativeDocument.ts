"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyOp, rebaseSequentialOps } from "@/lib/ot";
import { opWithinBounds } from "@/lib/validation";
import type {
  ClientUser,
  CursorPosition,
  OperationAck,
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

export interface PendingOperationBatch {
  id: string;
  ops: TextOp[];
  /** The live SSE stream already applied this batch to the hot snapshot. */
  serverAccepted?: boolean;
}

function createClientMutationId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, "")
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `m_${random}`.slice(0, 98);
}

export function flattenPendingOps(
  batches: readonly PendingOperationBatch[],
): TextOp[] {
  return batches.flatMap((batch) => batch.ops);
}

export function replayPendingBatchesOnSnapshot(
  content: string,
  batches: readonly PendingOperationBatch[],
): { content: string; batches: PendingOperationBatch[] } {
  let nextContent = content;
  const replayed: PendingOperationBatch[] = [];

  for (const batch of batches) {
    // A failed POST can be retried after its SSE echo has already applied the
    // operation to this server snapshot. Keep that id in the send queue, but
    // never visually replay its text a second time.
    if (batch.serverAccepted) {
      replayed.push(batch);
      continue;
    }

    const ops: TextOp[] = [];
    for (const op of batch.ops) {
      if (!opWithinBounds(op, nextContent.length)) continue;
      nextContent = applyOp(nextContent, op);
      ops.push(op);
    }
    if (ops.length > 0) replayed.push({ ...batch, ops });
  }

  return { content: nextContent, batches: replayed };
}

export function visualReplayOps(
  batches: readonly PendingOperationBatch[],
): TextOp[] {
  return flattenPendingOps(batches.filter((batch) => !batch.serverAccepted));
}

export function rebasePendingBatchesAgainstOps(
  batches: readonly PendingOperationBatch[],
  against: readonly TextOp[],
): PendingOperationBatch[] {
  return batches
    .map((batch) => batch.serverAccepted
      ? batch
      : {
          ...batch,
          ops: rebaseSequentialOps(batch.ops, [...against]),
        })
    .filter((batch) => batch.ops.length > 0);
}

export function dropAcceptedPendingBatches(
  batches: readonly PendingOperationBatch[],
  acceptedMutationIds: ReadonlySet<string>,
): PendingOperationBatch[] {
  if (acceptedMutationIds.size === 0) return [...batches];
  return batches.filter((batch) => !acceptedMutationIds.has(batch.id));
}

function roleForSelf(members: RoomMemberInfo[], userId?: string): RoomRole | null {
  if (!userId) return null;
  return members.find((member) => member.user.id === userId)?.role ?? null;
}

export function replayLocalOpsOnSnapshot(
  content: string,
  ops: TextOp[],
): { content: string; ops: TextOp[] } {
  const replay = replayPendingBatchesOnSnapshot(content, [
    { id: "legacy", ops },
  ]);
  return {
    content: replay.content,
    ops: flattenPendingOps(replay.batches),
  };
}

export function classifyServerOpRevision(
  currentRevision: number,
  eventRevision: number,
  opCount: number,
): "ready" | "stale" | "gap" {
  if (eventRevision <= currentRevision) return "stale";
  const eventBaseRevision = eventRevision - opCount;
  return eventBaseRevision === currentRevision ? "ready" : "gap";
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
  const selfUserIdRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const outstandingRef = useRef<PendingOperationBatch | null>(null);
  const bufferRef = useRef<PendingOperationBatch[]>([]);
  const sseAcknowledgedMutationIdsRef = useRef(new Set<string>());
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

  const hasPending = useCallback(
    () => Boolean(outstandingRef.current || bufferRef.current.length > 0),
    [],
  );

  const pendingBatches = useCallback((): PendingOperationBatch[] => {
    return [
      ...(outstandingRef.current ? [outstandingRef.current] : []),
      ...bufferRef.current,
    ];
  }, []);

  const updatePendingState = useCallback(
    (patch: Partial<CollabState> = {}) => {
      setState((prev) => ({
        ...prev,
        ...patch,
        unsent: hasPending(),
      }));
    },
    [hasPending],
  );

  const pump = useCallback(async () => {
    if (outstandingRef.current || bufferRef.current.length === 0) return;
    const hasEventSource = sourceRef.current && sourceRef.current.readyState === EventSource.OPEN;
    const hasFetchStream = fetchControllerRef.current && !fetchControllerRef.current.signal.aborted;
    if (!hasEventSource && !hasFetchStream) {
      return;
    }
    if (!connectionIdRef.current) return;

    const pending = bufferRef.current.shift();
    if (!pending) return;

    const batch: OperationBatch = {
      connectionId: connectionIdRef.current,
      clientMutationId: pending.id,
      baseRevision: revisionRef.current,
      ops: pending.ops,
    };
    outstandingRef.current = pending;
    updatePendingState();

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
        // The op SSE echo can release this batch and start a newer one before
        // this POST response arrives. A stale response must never reset that
        // newer local state.
        if (outstandingRef.current?.id !== pending.id) return;

        const stale = (await res.json()) as {
          revision: number;
          content: string;
        };
        const replay = replayPendingBatchesOnSnapshot(
          stale.content,
          pendingBatches(),
        );
        outstandingRef.current = null;
        bufferRef.current = replay.batches;
        revisionRef.current = stale.revision;
        snapshotRef.current = { content: stale.content };
        bridgeRef.current?.reset(stale.content);
        const replayOps = visualReplayOps(replay.batches);
        if (replayOps.length > 0) bridgeRef.current?.applyRemote(replayOps);
        updatePendingState({
          revision: stale.revision,
          syncedRevision: stale.revision,
        });
        if (replayOps.length > 0) queueMicrotask(() => void pumpRef.current());
        return;
      }
      if (!res.ok) throw new Error(`operations failed: ${res.status}`);

      const ack = (await res.json().catch(() => null)) as OperationAck | null;
      const ackMatchesPending = !ack?.clientMutationId || ack.clientMutationId === pending.id;
      const completed = outstandingRef.current?.id === pending.id
        ? outstandingRef.current
        : null;

      if (!ackMatchesPending || !completed) {
        // The server may have sent the SSE self-echo first. Never let this
        // late HTTP acknowledgement clear or rebase a later outstanding batch;
        // it can only contribute durable-save metadata for its own revision.
        if (ack?.savedAt) {
          sseAcknowledgedMutationIdsRef.current.delete(pending.id);
          const savedAt = ack.savedAt;
          const savedRevision = ack.revision;
          const savedMode = ack.mode;
          setState((prev) => {
            const canAdvanceSavedAt =
              savedRevision > prev.syncedRevision ||
              (savedRevision === prev.syncedRevision && prev.savedAt === null);
            return canAdvanceSavedAt
              ? {
                  ...prev,
                  syncedRevision: savedRevision,
                  savedAt,
                  cacheMode: savedMode ?? prev.cacheMode,
                }
              : prev;
          });
        }
        return;
      }

      const ackOps = ack?.ops ?? completed.ops;
      const ackRevision = ack?.revision ?? revisionRef.current;
      const hasUnseenServerOps = ackRevision > revisionRef.current + ackOps.length;
      const needsAuthoritativeContentReset = Boolean(
        ack?.content !== undefined && (hasUnseenServerOps || ack.duplicate),
      );

      outstandingRef.current = null;

      if (needsAuthoritativeContentReset && ack?.content !== undefined) {
        const replay = replayPendingBatchesOnSnapshot(ack.content, bufferRef.current);
        bufferRef.current = replay.batches;
        snapshotRef.current = { content: ack.content };
        bridgeRef.current?.reset(ack.content);
        const replayOps = visualReplayOps(replay.batches);
        if (replayOps.length > 0) bridgeRef.current?.applyRemote(replayOps);
      } else if (snapshotRef.current) {
        for (const op of ackOps) {
          if (opWithinBounds(op, snapshotRef.current.content.length)) {
            snapshotRef.current.content = applyOp(snapshotRef.current.content, op);
          }
        }
      }

      const nextRevision = hasUnseenServerOps
        ? ackRevision
        : Math.max(revisionRef.current, ackRevision);
      revisionRef.current = nextRevision;
      if (ack?.savedAt) sseAcknowledgedMutationIdsRef.current.delete(pending.id);
      setState((prev) => {
        const canAdvanceSavedAt = Boolean(
          ack?.savedAt &&
          (ackRevision > prev.syncedRevision ||
            (ackRevision === prev.syncedRevision && prev.savedAt === null)),
        );
        return {
          ...prev,
          revision: nextRevision,
          syncedRevision: canAdvanceSavedAt ? ackRevision : prev.syncedRevision,
          savedAt: canAdvanceSavedAt ? ack?.savedAt ?? prev.savedAt : prev.savedAt,
          cacheMode: canAdvanceSavedAt ? ack?.mode ?? prev.cacheMode : prev.cacheMode,
          unsent: hasPending(),
        };
      });
      void pumpRef.current();
    } catch {
      // Requeue the request's immutable mutation id, even if its SSE echo
      // already released it. The server can safely identify it as a duplicate
      // and retry persistence without applying the text operation again.
      const stillOutstanding = outstandingRef.current?.id === pending.id;
      const alreadyQueued = bufferRef.current.some((batch) => batch.id === pending.id);
      if (!alreadyQueued) {
        const retry = sseAcknowledgedMutationIdsRef.current.has(pending.id)
          ? { ...pending, serverAccepted: true }
          : pending;
        bufferRef.current = [retry, ...bufferRef.current];
      }
      if (stillOutstanding) outstandingRef.current = null;
      updatePendingState();
      sourceRef.current?.close();
      sourceRef.current = null;
      fetchControllerRef.current?.abort();
      fetchControllerRef.current = null;
      patchState({ connection: "reconnecting" });
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(
        () => void openStreamRef.current(),
        RECONNECT_DELAY_MS,
      );
    }
  }, [roomCode, patchState, pendingBatches, updatePendingState, hasPending]);

  const pumpRef = useRef(pump);
  useEffect(() => {
    // A stable pump ref lets async stream handlers call the latest sender without
    // re-subscribing the SSE connection on every queue-state change.
    // eslint-disable-next-line react-hooks/immutability
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
          selfUserIdRef.current = event.you.user.id;
          const acceptedMutationIds = new Set(event.acceptedMutationIds ?? []);
          const pending = dropAcceptedPendingBatches(
            pendingBatches(),
            acceptedMutationIds,
          );
          const replay = replayPendingBatchesOnSnapshot(event.content, pending);
          const replayOps = visualReplayOps(replay.batches);

          revisionRef.current = event.revision;
          outstandingRef.current = null;
          bufferRef.current = replay.batches;
          snapshotRef.current = { content: event.content };
          bridgeRef.current?.reset(event.content);
          if (replayOps.length > 0) bridgeRef.current?.applyRemote(replayOps);
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
            unsent: hasPending(),
          }));
          if (replayOps.length > 0) queueMicrotask(() => void pumpRef.current());
          break;
        }
        case "op": {
          const revisionState = classifyServerOpRevision(
            revisionRef.current,
            event.revision,
            event.ops.length,
          );
          if (revisionState === "stale") break;
          if (revisionState === "gap") {
            sourceRef.current?.close();
            sourceRef.current = null;
            fetchControllerRef.current?.abort();
            fetchControllerRef.current = null;
            scheduleReconnect();
            break;
          }

          if (event.by === connectionIdRef.current) {
            const outstanding = outstandingRef.current;
            const matchesOutstanding = Boolean(
              outstanding &&
                (!event.clientMutationId || outstanding.id === event.clientMutationId),
            );

            if (matchesOutstanding && snapshotRef.current && event.ops.length > 0) {
              for (const op of event.ops) {
                if (opWithinBounds(op, snapshotRef.current.content.length)) {
                  snapshotRef.current.content = applyOp(snapshotRef.current.content, op);
                }
              }
            }

            if (matchesOutstanding) {
              sseAcknowledgedMutationIdsRef.current.add(
                event.clientMutationId ?? outstanding!.id,
              );
              outstandingRef.current = null;
            } else if (event.clientMutationId) {
              bufferRef.current = bufferRef.current.filter(
                (batch) => batch.id !== event.clientMutationId,
              );
            }

            revisionRef.current = event.revision;
            setState((prev) => ({
              ...prev,
              revision: event.revision,
              unsent: hasPending(),
            }));
            void pumpRef.current();
            break;
          }

          if (snapshotRef.current && event.ops.length > 0) {
            for (const op of event.ops) {
              if (opWithinBounds(op, snapshotRef.current.content.length)) {
                snapshotRef.current.content = applyOp(snapshotRef.current.content, op);
              }
            }
          }

          const preceding = visualReplayOps(pendingBatches());
          const visual = rebaseSequentialOps(event.ops, preceding);
          if (outstandingRef.current) {
            outstandingRef.current =
              rebasePendingBatchesAgainstOps([outstandingRef.current], event.ops)[0] ?? null;
          }
          bufferRef.current = rebasePendingBatchesAgainstOps(bufferRef.current, event.ops);
          if (visual.length > 0) bridgeRef.current?.applyRemote(visual);
          revisionRef.current = event.revision;
          setState((prev) => ({
            ...prev,
            revision: event.revision,
            unsent: hasPending(),
          }));
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
          if (event.userId && event.userId !== selfUserIdRef.current) break;
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
          setState((prev) => {
            // Durable writes may finish out of order after their live ops have
            // already been delivered. Do not let an older saved event replace
            // the timestamp associated with a newer confirmed revision.
            const canAdvanceSavedAt =
              event.revision > prev.syncedRevision ||
              (event.revision === prev.syncedRevision && prev.savedAt === null);
            return canAdvanceSavedAt
              ? {
                  ...prev,
                  syncedRevision: event.revision,
                  savedAt: event.savedAt,
                  cacheMode: event.mode,
                }
              : prev;
          });
          break;
        }
        case "error":
          break;
      }
    };

    const streamUrl = () => {
      const params = new URLSearchParams();
      const replace = connectionIdRef.current;
      if (/^c_[a-f0-9]{18}$/.test(replace)) params.set("replace", replace);
      const query = params.toString();
      return `/api/rooms/${encodeURIComponent(roomCode)}/stream${query ? `?${query}` : ""}`;
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
          streamUrl(),
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

        if (!disposed && !controller.signal.aborted) {
          fetchControllerRef.current = null;
          scheduleReconnect();
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
        streamUrl(),
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
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
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
  }, [roomCode, patchState, pendingBatches, hasPending]);

  const setBridge = useCallback((bridge: EditorBridge | null) => {
    bridgeRef.current = bridge;
    if (bridge && snapshotRef.current) {
      bridge.reset(snapshotRef.current.content);
      const replayOps = visualReplayOps(pendingBatches());
      if (replayOps.length > 0) bridge.applyRemote(replayOps);
    }
  }, [pendingBatches]);

  const submitLocalOps = useCallback(
    (ops: TextOp[]) => {
      if (ops.length === 0) return;
      bufferRef.current.push({ id: createClientMutationId(), ops });
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
