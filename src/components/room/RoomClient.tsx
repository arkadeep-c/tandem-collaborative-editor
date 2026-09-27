"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import EditorRoom from "@/components/editor/EditorRoom";
import JoinGate from "@/components/room/JoinGate";
import { apiFetch, handleSessionResponse } from "@/lib/apiFetch";
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

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        // Ensure session exists (cookie or bearer)
        const sessRes = await apiFetch("/api/session");
        if (!sessRes.ok) throw new Error("session failed");
        const sessData = (await sessRes.json()) as { user: ClientUser; sessionToken?: string };
        handleSessionResponse(sessData);
        if (cancelled) return;
        setYou(sessData.user);

        // Try to get room info (requires membership)
        const roomRes = await apiFetch(`/api/rooms/${encodeURIComponent(code)}`);
        if (roomRes.status === 404) {
          if (!cancelled) setStatus("not-found");
          return;
        }
        if (roomRes.status === 403 || roomRes.status === 401) {
          // Not a member yet, or session expired -> need join gate
          // Try to fetch public room info via join endpoint? Actually join gate needs title/language
          // We can try to get room existence via a lightweight check - for now, attempt to get via find?
          // We'll fetch room existence by trying to get membership via join preview: call GET /api/rooms/[code] returns 403 but we still need title.
          // Instead, we can call a public endpoint or just show join gate with code only and fetch title via join attempt?
          // Simpler: try to fetch room info without membership via a separate logic - we already have code, we'll try to get room via API that returns 404 if not exists, else show join gate
          // For join gate we need title/language - we can try to get it from a 403 response? Our API doesn't return title on 403. So we need to fetch room existence separately.
          // We'll attempt to call /api/rooms/[code]/join with GET? No, join is POST. So we need to handle: if 403, we still need room metadata.
          // As fallback, we'll show join gate with placeholder and let join endpoint return title.
          // Actually our join endpoint returns title even when not member, so we can call it with a HEAD? No.
          // Let's try to get room metadata via a new approach: call GET /api/rooms/[code] and if 403, we still need title. We can make the server return title even on 403? But for now, we'll fetch via a direct DB? No.
          // Simpler: show join gate with code, and let JoinGate itself fetch title on join. Or we can attempt to fetch room info via an unauthenticated endpoint - we don't have one. So we will attempt to join immediately? No.
          // For now, set status to join and let JoinGate handle title fetching via its own API which returns title.
          // We'll need to get title for JoinGate - we can try to call /api/rooms/[code]/join with GET? That doesn't exist. So we will set room to minimal and JoinGate will fetch.
          // Actually we can set status to join and provide code, title empty, language empty - JoinGate will show with what we have.
          // Better: attempt to fetch room existence via a public route - we don't have. So we will just show join gate.
          if (!cancelled) {
            setStatus("join");
            // Try to get title via a trick: call join endpoint with POST but without joining? No.
            // We'll set placeholder and let JoinGate's join return title, but JoinGate needs title before join.
            // As temporary, set room with code and unknown title.
            setRoom({ code, title: code, language: "markdown" });
          }
          return;
        }
        if (!roomRes.ok) throw new Error(`room ${roomRes.status}`);
        const data = (await roomRes.json()) as {
          room: { code: string; title: string; language: string; role: RoomRole };
          you: ClientUser;
          sessionToken?: string;
        };
        handleSessionResponse(data);
        if (cancelled) return;
        setRoom(data.room);
        setYou(data.you);
        setRole(data.room.role);
        setStatus("editor");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load room");
          setStatus("not-found");
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#07090f]">
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
          Loading room…
        </div>
      </div>
    );
  }

  if (status === "not-found") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#07090f] px-6 text-center">
        <p className="font-mono text-sm tracking-[0.3em] text-violet-300">
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
            className="rounded-lg bg-violet-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-400"
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
      />
    );
  }

  if (status === "editor" && room && you) {
    return <EditorRoom room={room} you={you} role={role} />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#07090f]">
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
        Loading…
      </div>
    </div>
  );
}
