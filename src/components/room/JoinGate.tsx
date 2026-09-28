"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Users } from "lucide-react";
import { languageAccent } from "@/lib/types";
import { apiFetch, ensureClientSession, getStoredToken, handleSessionResponse } from "@/lib/apiFetch";

interface JoinGateProps {
  code: string;
  title: string;
  language: string;
  onJoined?: () => void;
}

export default function JoinGate({ code, title, language, onJoined }: JoinGateProps) {
  const router = useRouter();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = useCallback(async () => {
    console.log("[JOIN] JOIN_CLICK", { code });
    setJoining(true);
    setError(null);

    try {
      await ensureClientSession();
      const beforeToken = getStoredToken();
      console.log("[JOIN] BEFORE_JOIN_TOKEN_PRESENT", { present: !!beforeToken });
      console.log("[JOIN] JOIN_TOKEN_PRESENT", { present: !!beforeToken });
      console.log("[JOIN] JOIN_REQUEST_START", { url: `/api/rooms/${code}/join` });
      const res = await apiFetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
        method: "POST",
      });
      console.log("[JOIN] JOIN_RESPONSE", { status: res.status, ok: res.ok });

      const data = (await res.json()) as { error?: string; sessionToken?: string; room?: any };
      console.log("[JOIN] JOIN_RESPONSE_BODY", { ok: res.ok, error: data.error, hasRoom: !!data.room, hasToken: !!data.sessionToken });
      handleSessionResponse(data);

      const afterToken = getStoredToken();
      console.log("[JOIN] AFTER_JOIN_TOKEN_PRESENT", { present: !!afterToken });

      if (!res.ok) {
        throw new Error(data.error ?? "Unable to join room.");
      }

      console.log("[JOIN] JOIN_SUCCESS", { code });

      // Verify we can now load the room with bearer/cookie
      try {
        console.log("[JOIN] NEXT_REQUEST_AFTER_JOIN", { url: `/api/rooms/${code}` });
        const roomRes = await apiFetch(`/api/rooms/${encodeURIComponent(code)}`);
        console.log("[JOIN] NEXT_RESPONSE", { status: roomRes.status, ok: roomRes.ok });
        const roomData = await roomRes.json().catch(() => ({}));
        console.log("[JOIN] NEXT_RESPONSE_BODY", { hasRoom: !!(roomData as any).room, error: (roomData as any).error });
        handleSessionResponse(roomData);

        if (!roomRes.ok) {
          throw new Error((roomData as any).error ?? `Could not load editor after join: ${roomRes.status}`);
        }
      } catch (e) {
        console.error("[JOIN] ROOM_FETCH_AFTER_JOIN_FAILED", e);
        setError(e instanceof Error ? e.message : "Joined room, but could not load the editor.");
        setJoining(false);
        return;
      }

      console.log("[JOIN] JOIN_NAVIGATE_START", { code });
      try {
        if (onJoined) {
          onJoined();
          console.log("[JOIN] JOIN_NAVIGATE_SUCCESS via onJoined callback");
        } else {
          // Fallback: push to same room route which will re-mount RoomClient and fetch with bearer
          router.push(`/room/${code}`);
          console.log("[JOIN] JOIN_NAVIGATE_SUCCESS via router.push");
        }
        // Ensure loading state resets
        setJoining(false);
      } catch (navErr) {
        console.error("[JOIN] JOIN_NAVIGATE_ERROR", navErr);
        setError("Joined room, but navigation failed. Please refresh.");
        setJoining(false);
      }
    } catch (err) {
      console.error("[JOIN] JOIN_ERROR", err);
      setError(err instanceof Error ? err.message : "Unable to join room.");
      setJoining(false);
    }
  }, [code, router, onJoined]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#07090f] px-6">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#10141f] p-8 text-center shadow-2xl shadow-black/50">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-teal-500/15 text-teal-300">
          <Users className="h-5 w-5" />
        </div>
        <p className="font-mono text-xs tracking-[0.3em] text-teal-300">
          {code}
        </p>
        <h1 className="mt-3 text-xl font-bold tracking-tight text-slate-50">
          {title}
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          You&apos;ve been invited to collaborate in this room.
        </p>
        <span
          className="mt-4 inline-block rounded-md px-2 py-1 font-mono text-[11px] font-semibold"
          style={{
            color: languageAccent(language),
            backgroundColor: `${languageAccent(language)}14`,
          }}
        >
          {language}
        </span>

        {error && (
          <p className="mt-5 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={joining}
          onClick={() => void join()}
          className="mt-7 flex w-full items-center justify-center gap-2 rounded-lg bg-teal-500 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400 active:scale-[0.98] disabled:opacity-60"
        >
          {joining && <Loader2 className="h-4 w-4 animate-spin" />}
          {joining ? "Joining…" : "Join room"}
        </button>
        <Link
          href="/"
          className="mt-3 block text-xs font-medium text-slate-500 transition hover:text-slate-300"
        >
          Back home
        </Link>
      </div>
    </div>
  );
}
