"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Code2,
  Columns2,
  Copy,
  Crown,
  Database,
  Eye,
  GitBranch,
  HardDrive,
  Link2,
  Loader2,
  LogOut,
} from "lucide-react";
import clsx from "clsx";
import CollaborativeMonaco from "@/components/editor/MonacoEditor";
import PresenceBar from "@/components/editor/PresenceBar";
import ProfileDialog from "@/components/editor/ProfileDialog";
import MarkdownPreview from "@/components/editor/MarkdownPreview";
import { useCollaborativeDocument } from "@/lib/useCollaborativeDocument";
import {
  LANGUAGE_OPTIONS,
  languageAccent,
  type ClientUser,
  type RoomRole,
} from "@/lib/types";
import { apiFetch } from "@/lib/apiFetch";

/**
 * EditorRoom — the collaborative workspace for one room code.
 * Identity, role, and room record all arrive server-verified via props
 * and the stream's init snapshot.
 */

type ViewMode = "edit" | "split" | "preview";

interface EditorRoomProps {
  room: { code: string; title: string; language: string };
  you: ClientUser;
  role: RoomRole;
}

export default function EditorRoom({ room, you, role }: EditorRoomProps) {
  const router = useRouter();
  const [profileOverride, setProfileOverride] = useState<ClientUser | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [manualViewMode, setManualViewMode] = useState<ViewMode | null>(null);
  const [previewContent, setPreviewContent] = useState("");

  const { state, setBridge, submitLocalOps, publishPresence, updateMeta } =
    useCollaborativeDocument(room.code);

  const isOwner = role === "owner";
  // Derived (no mirrored state): latest server identity wins unless the
  // profile dialog produced something newer this mount.
  const profile = profileOverride ?? state.you ?? you;
  const titleShown = state.title || room.title;
  const isMarkdown = state.language === "markdown";
  const viewMode =
    (isMarkdown ? manualViewMode : null) ?? (isMarkdown ? "split" : "edit");

  /* Trailing-throttled mirror into the preview pane. */
  const latestMirrorRef = useRef("");
  const mirrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleMirror = useCallback((value: string) => {
    latestMirrorRef.current = value;
    if (mirrorTimerRef.current) return;
    mirrorTimerRef.current = setTimeout(() => {
      mirrorTimerRef.current = null;
      setPreviewContent(latestMirrorRef.current);
    }, 300);
  }, []);

  const commitTitle = useCallback(
    (rawValue: string) => {
      if (!isOwner) return;
      const next = rawValue.trim();
      if (next && next !== state.title) void updateMeta({ title: next });
    },
    [isOwner, state.title, updateMeta],
  );

  const copyValue = useCallback(async (value: string, which: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(value);
      if (which === "code") {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 1600);
      } else {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 1600);
      }
    } catch {
      /* clipboard blocked — ignore */
    }
  }, []);

  const leaveRoom = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await apiFetch(`/api/rooms/${encodeURIComponent(room.code)}/leave`, {
        method: "POST",
      });
    } catch {
      /* leaving anyway */
    }
    router.push("/");
  }, [leaving, room.code, router]);

  const connected = state.connection === "connected";
  const dirty =
    state.unsent ||
    (state.revision > 0 && state.syncedRevision < state.revision);
  const inviteLink =
    typeof window !== "undefined"
      ? `${window.location.origin}/room/${room.code}`
      : `/room/${room.code}`;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#07090f] text-slate-200">
      {/* ------------------------------ header ------------------------------ */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#0b0e14]/90 px-4 backdrop-blur">
        <button
          type="button"
          onClick={() => void leaveRoom()}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-slate-400 transition hover:border-white/20 hover:text-slate-100"
          aria-label="Leave room"
          title="Leave room"
        >
          {leaving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowLeft className="h-4 w-4" />
          )}
        </button>

        {/* room code */}
        <span
          className="flex items-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-400/10 px-2 py-1 font-mono text-[11px] font-bold tracking-[0.15em] text-violet-200"
          title="Room code"
        >
          {room.code}
        </span>

        <input
          key={titleShown}
          defaultValue={titleShown}
          onBlur={(event) => commitTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
          maxLength={120}
          spellCheck={false}
          readOnly={!isOwner}
          className={clsx(
            "w-36 truncate rounded-md border bg-transparent px-2 py-1 text-sm font-semibold text-slate-100 outline-none transition sm:w-56 md:w-72",
            isOwner
              ? "border-transparent hover:border-white/10 focus:border-violet-400/50 focus:bg-[#0b0e14]"
              : "cursor-default border-transparent",
          )}
          title={isOwner ? "Room title" : `Room title (owner: editable)`}
        />

        <span
          className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium"
          title={`Stream status: ${state.connection}`}
        >
          <span
            className={clsx(
              "h-1.5 w-1.5 rounded-full",
              connected
                ? "animate-pulse bg-emerald-400"
                : state.connection === "error"
                  ? "bg-rose-400"
                  : "animate-pulse bg-amber-400",
            )}
          />
          <span className="hidden text-slate-400 sm:inline">
            {connected
              ? "Live"
              : state.connection === "error"
                ? "Connection failed"
                : "Reconnecting…"}
          </span>
        </span>

        {isOwner && (
          <span
            className="hidden items-center gap-1 rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-[10px] font-semibold text-amber-200 md:flex"
            title="You own this room"
          >
            <Crown className="h-3 w-3" />
            Owner
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          <PresenceBar
            users={state.users}
            selfSessionId={state.selfSessionId}
            onEditProfile={() => setEditingProfile(true)}
          />

          <div className="hidden h-5 w-px bg-white/10 md:block" />

          {/* language: owner switches, editors see the badge */}
          {isOwner ? (
            <div className="relative">
              <select
                value={state.language}
                onChange={(event) =>
                  void updateMeta({ language: event.target.value })
                }
                className="cursor-pointer appearance-none rounded-lg border border-white/10 bg-[#11151f] py-1.5 pl-3 pr-7 text-xs font-medium outline-none transition hover:border-white/20 focus:border-violet-400/50"
                style={{ color: languageAccent(state.language) }}
                aria-label="Document language"
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                    className="bg-[#11151f] text-slate-200"
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              <GitBranch className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" />
            </div>
          ) : (
            <span
              className="rounded-md px-2 py-1 font-mono text-[11px] font-semibold"
              style={{
                color: languageAccent(state.language),
                backgroundColor: `${languageAccent(state.language)}14`,
              }}
              title="Only the room owner can change the language"
            >
              {LANGUAGE_OPTIONS.find((l) => l.id === state.language)?.label ??
                state.language}
            </span>
          )}

          {isMarkdown && (
            <div className="hidden items-center rounded-lg border border-white/10 bg-[#11151f] p-0.5 md:flex">
              {(
                [
                  { id: "edit", icon: Code2, label: "Editor" },
                  { id: "split", icon: Columns2, label: "Split" },
                  { id: "preview", icon: Eye, label: "Preview" },
                ] as const
              ).map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setManualViewMode(id)}
                  className={clsx(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition",
                    viewMode === id
                      ? "bg-violet-500/20 text-violet-200"
                      : "text-slate-400 hover:text-slate-200",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden lg:inline">{label}</span>
                </button>
              ))}
            </div>
          )}

          {/* share */}
          <div className="hidden items-center gap-1.5 sm:flex">
            <button
              type="button"
              onClick={() => void copyValue(room.code, "code")}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-white/25"
              title={`Copy room code: ${room.code}`}
            >
              {copiedCode ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span className="hidden lg:inline">Code</span>
            </button>
            <button
              type="button"
              onClick={() => void copyValue(inviteLink, "link")}
              className="flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-400 active:scale-[0.97]"
              title={`Copy invite link: ${inviteLink}`}
            >
              {copiedLink ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              <span className="hidden lg:inline">
                {copiedLink ? "Copied" : "Share"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => void leaveRoom()}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-slate-400 transition hover:border-rose-400/40 hover:text-rose-300"
              title="Leave room"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* ------------------------------ workspace ------------------------------ */}
      <main className="flex min-h-0 flex-1">
        {(viewMode !== "preview" || !isMarkdown) && (
          <div
            className={clsx(
              "min-w-0",
              isMarkdown && viewMode === "split" ? "w-1/2" : "w-full",
            )}
          >
            {connected || state.revision > 0 ? (
              <CollaborativeMonaco
                language={state.language}
                users={state.users}
                selfSessionId={state.selfSessionId}
                setBridge={setBridge}
                submitLocalOps={submitLocalOps}
                publishPresence={publishPresence}
                onMirror={isMarkdown ? handleMirror : undefined}
              />
            ) : (
              <div className="flex h-full items-center justify-center bg-[#0b0e14]">
                <div className="flex items-center gap-3 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
                  {state.connection === "error"
                    ? "Could not connect — check your membership, then refresh."
                    : "Joining room…"}
                </div>
              </div>
            )}
          </div>
        )}
        {isMarkdown && viewMode !== "edit" && (
          <div
            className={clsx(
              "min-w-0 border-l border-white/[0.06] bg-[#0a0d13]",
              viewMode === "split" ? "w-1/2" : "w-full",
            )}
          >
            <MarkdownPreview markdown={previewContent} />
          </div>
        )}
      </main>

      {/* ------------------------------ status bar ------------------------------ */}
      <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-white/[0.06] bg-[#0b0e14] px-4 text-[11px] text-slate-500">
        <span
          className={clsx(
            "flex items-center gap-1.5 font-medium",
            dirty ? "text-amber-300/90" : "text-emerald-300/90",
          )}
        >
          {dirty ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {dirty ? "Syncing…" : "Saved"}
        </span>

        <span className="flex items-center gap-1.5">
          <HardDrive className="h-3 w-3" />
          rev {state.revision}
        </span>

        <span className="hidden items-center gap-1.5 sm:flex">
          <Database className="h-3 w-3" />
          cache:{" "}
          {state.cacheMode === "redis"
            ? "Redis"
            : state.cacheMode === "memory"
              ? "in-memory"
              : "—"}
        </span>

        <span className="ml-auto hidden md:block">
          room <span className="font-mono text-slate-400">{room.code}</span>
          {" · "}
          <span className="text-slate-400">{profile.name}</span>
        </span>
        <span className="hidden lg:block">OT-lite · single-order engine</span>
      </footer>

      {editingProfile && (
        <ProfileDialog
          user={profile}
          onClose={(updated) => {
            setProfileOverride(updated);
            setEditingProfile(false);
          }}
        />
      )}
    </div>
  );
}
