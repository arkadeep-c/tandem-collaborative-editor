"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, UserRound } from "lucide-react";
import { PRESENCE_COLORS } from "@/lib/validation";
import type { ClientUser } from "@/lib/types";
import { apiFetch, handleSessionResponse } from "@/lib/apiFetch";

interface ProfileDialogProps {
  user: ClientUser;
  onClose: (updated: ClientUser) => void;
}

export default function ProfileDialog({ user, onClose }: ProfileDialogProps) {
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
      const data = (await res.json()) as {
        user?: ClientUser;
        error?: string;
        sessionToken?: string;
      };
      handleSessionResponse(data);
      if (!res.ok || !data.user) {
        throw new Error(data.error ?? "Could not save profile.");
      }
      onClose(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save profile.");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#07090f]/80 backdrop-blur-md">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#10141f] p-7 shadow-2xl shadow-black/60">
        <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl bg-teal-500/15 text-teal-300">
          <UserRound className="h-5 w-5" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-slate-100">
          Your presence
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">
          Anonymous session — no account. This is how collaborators see you.
        </p>

        <input
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void submit()}
          placeholder="Display name"
          maxLength={40}
          className="mt-5 w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/20"
        />

        <div className="mt-4 flex flex-wrap gap-2">
          {PRESENCE_COLORS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setColor(candidate)}
              className="h-7 w-7 rounded-full transition-transform hover:scale-110"
              style={{
                backgroundColor: candidate,
                boxShadow:
                  candidate === color
                    ? `0 0 0 2px #10141f, 0 0 0 4px ${candidate}`
                    : "none",
              }}
              aria-label={`Color ${candidate}`}
            />
          ))}
        </div>

        {error && (
          <p className="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={saving}
          onClick={() => void submit()}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-teal-500 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400 active:scale-[0.98] disabled:opacity-60"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </button>
      </div>
    </div>
  );
}
