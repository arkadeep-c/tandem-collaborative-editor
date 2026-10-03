"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import type { PresenceState } from "@/lib/types";
import clsx from "clsx";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

/**
 * PresenceBar — overlapping avatar stack with per-user color rings,
 * typing pulse, and a live headcount chip.
 */

interface PresenceBarProps {
  users: PresenceState[];
  selfSessionId: string;
  selfUserId?: string;
  onEditProfile: () => void;
}

const MAX_VISIBLE = 6;

export function distinctPresenceConnections(
  users: PresenceState[],
): PresenceState[] {
  return Array.from(
    users.reduce((map, presence) => {
      map.set(presence.sessionId, presence);
      return map;
    }, new Map<string, PresenceState>()).values(),
  ).sort((a, b) => a.joinedAt - b.joinedAt);
}

export default function PresenceBar({
  users,
  selfSessionId,
  selfUserId,
  onEditProfile,
}: PresenceBarProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const deduped = distinctPresenceConnections(users);
  const visible = deduped.slice(0, MAX_VISIBLE);
  const overflow = deduped.length - visible.length;

  return (
    <div className="flex items-center">
      <div className="flex -space-x-2">
        {visible.map((presence) => {
          const isSelf =
            presence.sessionId === selfSessionId ||
            Boolean(!selfSessionId && selfUserId && presence.user.id === selfUserId);
          const isRemoteTyping = !isSelf && presence.typing;
          return (
            <div
              key={presence.sessionId}
              className="group relative"
              onMouseEnter={() => setHovered(presence.sessionId)}
              onMouseLeave={() => setHovered(null)}
            >
              <button
                type="button"
                onClick={isSelf ? onEditProfile : undefined}
                className={clsx(
                  "flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold tracking-wide transition-transform duration-200",
                  "ring-2 ring-offset-2 ring-offset-[#0b0e14] hover:z-10 hover:scale-110",
                  isSelf && "cursor-pointer",
                )}
                style={{
                  backgroundColor: `${presence.user.color}26`,
                  color: presence.user.color,
                  boxShadow: `0 0 0 2px ${presence.user.color}`,
                }}
                aria-label={presence.user.name}
              >
                {initialsOf(presence.user.name)}
                {isRemoteTyping && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full border-2 border-[#0b0e14]"
                    style={{ backgroundColor: presence.user.color }}
                  />
                )}
              </button>

              {hovered === presence.sessionId && (
                <div className="pointer-events-none absolute left-1/2 top-full z-40 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-[#141926] px-2.5 py-1.5 text-[11px] shadow-xl shadow-black/40">
                  <span className="font-semibold text-slate-100">
                    {presence.user.name}
                  </span>
                  {isSelf && (
                    <span className="ml-1.5 inline-flex items-center gap-1 text-slate-400">
                      <Pencil className="h-2.5 w-2.5" />
                      you
                    </span>
                  )}
                  {isRemoteTyping && (
                    <span className="ml-1.5 text-emerald-400">typing…</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {overflow > 0 && (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-[11px] font-semibold text-slate-300 ring-2 ring-white/10">
            +{overflow}
          </div>
        )}
      </div>
      <span className="ml-3 hidden text-xs font-medium text-slate-500 sm:block">
        {deduped.length} online
      </span>
    </div>
  );
}
