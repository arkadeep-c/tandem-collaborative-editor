"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import EditorRoom from "@/components/editor/EditorRoom";
import JoinGate from "@/components/room/JoinGate";
import { apiFetch, ensureClientSession, getAuthDiagnostics, getStoredToken, handleSessionResponse } from "@/lib/apiFetch";
import type { ClientUser, RoomRole } from "@/lib/types";
import { Loader2 } from "lucide-react";

interface RoomClientProps {
  code: string;
}

export default function RoomClient({ code }: RoomClientProps) {
  const [status, setStatus] = useState<"loading" | "not-found" | "join" | "editor">("loading");
  const [room, setRoom] = useState<{ code: string; title: string; language: string } | null>(null);
  const [you, setYou] = useState<ClientUser | null>(null);
  const [role, setRole] = useState<RoomRole>("editor");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    console.log("[ROOM_CLIENT] ROOM_CLIENT_MOUNT", { code });
    const diag = getAuthDiagnostics();
    console.log("[ROOM_CLIENT] COOKIE_AVAILABLE", { available: diag.cookieAvailable });
    console.log("[ROOM_CLIENT] MEMORY_TOKEN_AVAILABLE", { available: diag.memoryToken });
    console.log("[ROOM_CLIENT] WINDOW_NAME_TOKEN_AVAILABLE", { available: diag.windowNameToken });
    console.log("[ROOM_CLIENT] SESSIONSTORAGE", { available: diag.sessionStorageAvailable, hasToken: diag.sessionStorageToken });
    const tokenPresent = !!getStoredToken();
    console.log("[ROOM_CLIENT] ROOM_CLIENT_TOKEN_PRESENT", { present: tokenPresent });
    console.log("[ROOM_CLIENT] ROOM_CLIENT_FETCH_START", { url: `/api/rooms/${code}` });

    try {
      console.log("[ROOM_CLIENT] SESSION_BOOTSTRAP start");
      const sessData = (await ensureClientSession()) as { user: ClientUser; sessionToken?: string } | null | undefined;
      if (!sessData || !sessData.user || !sessData.user.id) {
        console.error("[ROOM_CLIENT] SESSION_BOOTSTRAP returned invalid data", { sessData });
        throw new Error("Could not establish a session. Please refresh the page.");
      }
      console.log("[ROOM_CLIENT] SESSION_READY", { userId: sessData.user.id.slice(0, 8) });
      setYou(sessData.user);

      console.log("[ROOM_CLIENT] ROOM_FETCH start");
      const roomRes = await apiFetch(`/api/rooms/${encodeURIComponent(code)}`);
      console.log("[ROOM_CLIENT] ROOM_CLIENT_FETCH_RESPONSE", { status: roomRes.status, ok: roomRes.ok });

      if (roomRes.status === 404) {
        console.log("[ROOM_CLIENT] ROOM_CLIENT_FETCH_ERROR 404");
        setStatus("not-found");
        return;
      }

      if (roomRes.status === 403 || roomRes.status === 401) {
        console.log("[ROOM_CLIENT] ROOM_CLIENT_FETCH 403/401 → need join");
        // Try to get room metadata via join endpoint's public info? Our join returns title even if not member
        // Attempt to fetch via join with a dry-run? Instead, try to get room existence by calling a separate endpoint
        // For now, try to fetch room info via an unauthenticated attempt to get title from DB via a lightweight call
        // We'll attempt to call POST /join with a flag? No. Instead, we'll try to get room info from a different route that doesn't require membership
        // As fallback, we have code, and we'll try to get title by attempting to join with a test call? Actually join will succeed and return title.
        // For initial gate, show placeholder but attempt to fetch title via a best-effort: call join endpoint and if it returns room, use its title without actually joining? Our join is idempotent, so calling it now would join.
        // To avoid auto-join, we will show placeholder and let JoinGate handle real title after join.
        // But we can try to fetch room metadata via a public endpoint: we don't have one, so we will attempt to get it via a direct call to /api/rooms/[code]/join which is idempotent and returns title — this will actually join the user, which is okay for bearer flow? The spec says join gate is confirmation step, so we should NOT auto-join.
        // So we keep placeholder.
        setRoom({ code, title: code, language: "markdown" });
        setStatus("join");
        console.log("[ROOM_CLIENT] ROOM_CLIENT_FETCH → join gate");
        return;
      }

      if (!roomRes.ok) {
        const errBody = await roomRes.json().catch(() => ({}));
        console.error("[ROOM_CLIENT] ROOM_CLIENT_FETCH_ERROR", { status: roomRes.status, body: errBody });
        throw new Error(`room ${roomRes.status}`);
      }

      const data = (await roomRes.json()) as {
        room: { code: string; title: string; language: string; role: RoomRole };
        you: ClientUser;
        sessionToken?: string;
      };
      console.log("[ROOM_CLIENT] ROOM_CLIENT_FETCH_SUCCESS", { code: data.room.code, title: data.room.title });
      handleSessionResponse(data);
      setRoom(data.room);
      setYou(data.you);
      setRole(data.room.role);
      setStatus("editor");
    } catch (err) {
      console.error("[ROOM_CLIENT] ROOM_CLIENT_FETCH_ERROR", err);
      setError(err instanceof Error ? err.message : "Failed to load room");
      setStatus("not-found");
    }
  }, [code]);

  useEffect(() => {
    // load() is asynchronous; state updates happen after network/session work completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, reloadKey]);

  const handleJoined = useCallback(() => {
    console.log("[ROOM_CLIENT] JOIN_SUCCESS callback → reloading");
    setReloadKey((k) => k + 1);
  }, []);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#07090f]">
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-teal-400" />
          Loading room…
        </div>
      </div>
    );
  }

  if (status === "not-found") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#07090f] px-6 text-center">
        <p className="font-mono text-sm tracking-[0.3em] text-teal-300">
          {code || "??????"}
        </p>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-50">
          Room not found.
        </h1>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-slate-400">
          {error ?? "That code doesn't match any room."}
        </p>
        <div className="mt-8 flex gap-3">
          <Link
            href="/"
            className="rounded-lg bg-teal-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400"
          >
            Back home
          </Link>
        </div>
      </div>
    );
  }

  if (status === "join") {
    return (
      <JoinGate
        code={room?.code ?? code}
        title={room?.title ?? code}
        language={room?.language ?? "markdown"}
        onJoined={handleJoined}
      />
    );
  }

  if (status === "editor" && room && you) {
    return <EditorRoom room={room} you={you} role={role} />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#07090f]">
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin text-teal-400" />
        Loading…
      </div>
    </div>
  );
}
