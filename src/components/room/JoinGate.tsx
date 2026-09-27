"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Users } from "lucide-react";
import { languageAccent } from "@/lib/types";

/**
 * JoinGate — confirmation step for a valid room link before entering.
 * One click: the server (auto-provisioning a session if needed) records
 * membership, then the page refreshes into the editor.
 */

interface JoinGateProps {
  code: string;
  title: string;
  language: string;
}

export default function JoinGate({ code, title, language }: JoinGateProps) {
  const router = useRouter();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = useCallback(async () => {
    setJoining(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/rooms/${encodeURIComponent(code)}/join`,
        { method: "POST", credentials: "same-origin" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Unable to join room.");
      }
      router.refresh(); // re-run the server gate: now a member
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to join room.");
      setJoining(false);
    }
  }, [code, router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#07090f] px-6">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#10141f] p-8 text-center shadow-2xl shadow-black/50">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300">
          <Users className="h-5 w-5" />
        </div>
        <p className="font-mono text-xs tracking-[0.3em] text-violet-300">
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
          className="mt-7 flex w-full items-center justify-center gap-2 rounded-lg bg-violet-500 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-400 active:scale-[0.98] disabled:opacity-60"
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
