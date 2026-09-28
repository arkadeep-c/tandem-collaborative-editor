"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  Braces,
  Cpu,
  Crown,
  Database,
  Loader2,
  LogIn,
  MousePointer2,
  Pencil,
  Plus,
  Radio,
  ShieldCheck,
  Timer,
  Users,
} from "lucide-react";
import clsx from "clsx";
import ProfileDialog from "@/components/editor/ProfileDialog";
import { normalizeRoomCode } from "@/lib/roomCode";
import {
  LANGUAGE_OPTIONS,
  languageAccent,
  type ClientUser,
  type RoomSummary,
} from "@/lib/types";
import { apiFetch, ensureClientSession, getAuthDiagnostics, getStoredToken, handleSessionResponse } from "@/lib/apiFetch";
import { showToast } from "@/components/ui/Toast";

const DEMO_ROOM_CODE = "TANDEM";

function relativeTime(iso: string): string {
  const delta = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const PILLARS = [
  {
    icon: ShieldCheck,
    title: "Server-verified sessions",
    body: "Signed HttpOnly cookies carry a server-created identity and room membership is checked on every edit, stream, and meta change.",
  },
  {
    icon: Database,
    title: "Cache-hot, Postgres-true",
    body: "Active rooms stay hot in a cache layer (Redis when configured, in-memory otherwise). PostgreSQL remains the durable source of truth.",
  },
  {
    icon: Timer,
    title: "Ordered, then flushed",
    body: "Every room applies ops in one serialized order with position transforms, then a 5s trailing debounce persists to Postgres.",
  },
];

type Dialog = "create" | "join" | null;

export default function HomeClient() {
  const router = useRouter();
  const [user, setUser] = useState<ClientUser | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editingProfile, setEditingProfile] = useState(false);

  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("typescript");
  const [starterMode, setStarterMode] = useState<"blank" | "starter">("blank");
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bearerFallback, setBearerFallback] = useState(false);

  const refresh = useCallback(async () => {
    try {
      console.log("[HOME] refresh /api/rooms/mine start");
      const res = await apiFetch("/api/rooms/mine");
      console.log("[HOME] rooms/mine response", { status: res.status, ok: res.ok });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        console.warn("[HOME] rooms/mine failed", { status: res.status, body: errBody });
        throw new Error(`${res.status}`);
      }
      const payload = (await res.json()) as { rooms: RoomSummary[]; sessionToken?: string };
      handleSessionResponse(payload);
      console.log("[HOME] rooms loaded", { count: payload.rooms.length });
      setRooms(payload.rooms);
      setLoadError(null);
    } catch (e) {
      console.error("[HOME] refresh failed", e);
      setLoadError("Could not load your rooms.");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      console.log("[HOME] SESSION_BOOTSTRAP start");
      const diagBefore = getAuthDiagnostics();
      console.log("[HOME] COOKIE_AVAILABLE", { available: diagBefore.cookieAvailable });
      console.log("[HOME] MEMORY_TOKEN_AVAILABLE", { available: diagBefore.memoryToken });
      console.log("[HOME] WINDOW_NAME_TOKEN_AVAILABLE", { available: diagBefore.windowNameToken });
      console.log("[HOME] SESSIONSTORAGE available", { available: diagBefore.sessionStorageAvailable, hasToken: diagBefore.sessionStorageToken });

      try {
        // Use singleton bootstrap — ensures only one GET /api/session, others await same promise
        const data = (await ensureClientSession()) as { user: ClientUser; fresh?: boolean; sessionToken?: string } | null | undefined;
        if (!data || !data.user || !data.user.id) {
          console.error("[HOME] SESSION_BOOTSTRAP returned invalid data", { data });
          throw new Error("Could not establish a session.");
        }
        console.log("[HOME] SESSION_READY", { id: data.user?.id?.slice(0, 8), name: data.user?.name, fresh: data.fresh });
        setUser(data.user);
        const diagAfter = getAuthDiagnostics();
        if (diagAfter.memoryToken || diagAfter.windowNameToken || diagAfter.sessionStorageToken) {
          console.log("[HOME] bearer fallback active - token stored in memory");
          setBearerFallback(true);
        } else {
          console.log("[HOME] cookie auth active");
          if (getStoredToken()) setBearerFallback(true);
        }

        // Persistence check (optional) — should be same id now that bootstrap done
        try {
          const res2 = await apiFetch("/api/session");
          const data2 = (await res2.json()) as { user: ClientUser; fresh?: boolean; sessionToken?: string };
          console.log("[HOME] session persistence check", { id1: data.user?.id?.slice(0, 8), id2: data2.user?.id?.slice(0, 8), same: data.user?.id === data2.user?.id });
          handleSessionResponse(data2);
        } catch (e) {
          console.warn("[HOME] second session check failed", e);
        }
      } catch (e) {
        console.error("[HOME] session init failed", e);
        const diag = getAuthDiagnostics();
        const hasToken = !!getStoredToken();
        console.log("[HOME] failure diagnostics", { ...diag, hasToken });
        if (!hasToken) {
          setLoadError("Could not establish a session.");
        }
      }
      console.log("[HOME] ROOMS_FETCH start");
      await refresh();
      console.log("[HOME] ROOMS_FETCH done");
    })();
  }, [refresh]);

  const stats = useMemo(() => {
    const list = rooms ?? [];
    return {
      count: list.length,
      live: list.reduce((acc, room) => acc + room.activeUsers, 0),
      languages: new Set(list.map((room) => room.language)).size,
    };
  }, [rooms]);

  const createRoom = useCallback(async () => {
    setBusy(true);
    setFormError(null);
    try {
      const res = await apiFetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || "Untitled",
          language,
          starter: starterMode === "starter",
        }),
      });
      const data = (await res.json()) as {
        room?: { code: string };
        error?: string;
        sessionToken?: string;
      };
      handleSessionResponse(data);
      if (!res.ok || !data.room) {
        throw new Error(data.error ?? "Something went wrong. Please try again.");
      }
      router.push(`/room/${data.room.code}`);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Something went wrong. Please try again.",
      );
      setBusy(false);
    }
  }, [language, router, starterMode, title]);

  const joinRoom = useCallback(
    async (rawCode: string) => {
      const code = normalizeRoomCode(rawCode);
      if (code.length !== 6) {
        setFormError("Invalid room code.");
        return;
      }
      setBusy(true);
      setFormError(null);
      try {
        const res = await apiFetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
          method: "POST",
        });
        const data = (await res.json()) as { error?: string; sessionToken?: string };
        handleSessionResponse(data);
        if (!res.ok) {
          throw new Error(data.error ?? "Unable to join room.");
        }
        router.push(`/room/${code}`);
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "Unable to join room.");
        setBusy(false);
      }
    },
    [router],
  );

  const renameRoom = useCallback(async (room: RoomSummary) => {
    const next = window.prompt("Rename room", room.title)?.trim();
    if (!next || next === room.title) return;
    try {
      const res = await apiFetch(`/api/rooms/${encodeURIComponent(room.code)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any).error ?? "Could not rename room.");
      showToast("Room renamed.", "success");
      void refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not rename room.", "error");
    }
  }, [refresh]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#07090f]">
      <div className="bg-grid absolute inset-0" aria-hidden />
      <div
        className="aurora absolute -top-40 left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-teal-600/20"
        aria-hidden
      />
      <div
        className="aurora absolute -left-40 top-1/3 h-[380px] w-[380px] rounded-full bg-cyan-500/10 [animation-delay:-6s]"
        aria-hidden
      />

      <div className="relative">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-500/15 text-teal-300 ring-1 ring-teal-400/30">
              <Braces className="h-4 w-4" />
            </div>
            <span className="text-[15px] font-bold tracking-tight text-slate-100">
              Tandem
            </span>
            <span className="hidden items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300 sm:flex">
              <ShieldCheck className="h-3 w-3" />
              session-secured
            </span>
          </div>
          <div className="flex items-center gap-3">
            {user && (
              <button
                type="button"
                onClick={() => setEditingProfile(true)}
                className="hidden items-center gap-2 rounded-full border border-white/10 py-1 pl-1 pr-3 transition hover:border-white/25 md:flex"
                title="Edit your display identity"
              >
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold"
                  style={{ backgroundColor: `${user.color}26`, color: user.color }}
                >
                  {user.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="text-xs font-medium text-slate-300">
                  {user.name}
                </span>
                <Pencil className="h-3 w-3 text-slate-500" />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setFormError(null);
                setDialog("create");
              }}
              className="flex items-center gap-2 rounded-lg bg-teal-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-400 active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" />
              Create Room
            </button>
          </div>
        </nav>

        {/* Only show cookie-blocked message if bearer fallback also fails */}
        {loadError && !bearerFallback && (
          <div className="mx-auto max-w-6xl px-6 pb-6">
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
              <p className="font-medium">
                Could not establish a session. Your browser may be blocking both cookies and session storage. Open this app in a new browser tab.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => window.open(window.location.href, "_blank")}
                  className="rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-amber-300"
                >
                  Open in new tab
                </button>
              </div>
            </div>
          </div>
        )}

        {bearerFallback && (
          <div className="mx-auto max-w-6xl px-6 pb-6">
            <div className="rounded-xl border border-teal-400/30 bg-teal-400/10 px-4 py-3 text-sm text-teal-200">
              <p className="font-medium">
                Using secure bearer session fallback — your browser is blocking embedded cookies, but collaboration will still work in this preview.
              </p>
            </div>
          </div>
        )}

        <header className="mx-auto max-w-6xl px-6 pb-14 pt-12 md:pt-16">
          <motion.div
            initial={{ opacity: 1, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-medium text-slate-400">
              <Radio className="h-3 w-3 text-emerald-400" />
              Real-time rooms · OT sync · PostgreSQL · Redis cache
            </p>
            <h1 className="max-w-3xl text-5xl font-bold leading-[1.04] tracking-tight text-slate-50 md:text-7xl">
              One room code.{" "}
              <span className="bg-gradient-to-r from-teal-300 via-cyan-300 to-cyan-300 bg-clip-text text-transparent">
                Zero setup.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-400">
              Create a room, share its code, and write code or markdown
              together — every keystroke, caret, and selection synchronized
              in real time.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  setDialog("create");
                }}
                className="flex items-center gap-2 rounded-lg bg-teal-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400 active:scale-[0.98]"
              >
                <Plus className="h-4 w-4" />
                Create Room
              </button>
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  setDialog("join");
                }}
                className="flex items-center gap-2 rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-white/30 hover:bg-white/5"
              >
                <LogIn className="h-4 w-4" />
                Join Room
              </button>
              <button
                type="button"
                onClick={() => void joinRoom(DEMO_ROOM_CODE)}
                className="font-mono text-xs text-slate-500 underline decoration-dotted underline-offset-4 transition hover:text-slate-300"
                title={`Join the public demo room (${DEMO_ROOM_CODE})`}
              >
                or try the demo room: {DEMO_ROOM_CODE}
              </button>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 1, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
            className="mt-12 flex flex-wrap items-center gap-8 border-y border-white/[0.06] py-5"
          >
            {[
              { label: "your rooms", value: stats.count, icon: Braces },
              { label: "collaborators live", value: stats.live, icon: Users },
              { label: "languages used", value: stats.languages, icon: Cpu },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="flex items-center gap-3">
                <Icon className="h-4 w-4 text-teal-300/80" />
                <span className="font-mono text-2xl font-bold text-slate-100">
                  {rooms ? value : "—"}
                </span>
                <span className="text-sm text-slate-500">{label}</span>
              </div>
            ))}
          </motion.div>
        </header>

        <section className="mx-auto max-w-6xl px-6 pb-20">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
              Your rooms
            </h2>
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-xs font-medium text-slate-500 transition hover:text-slate-300"
            >
              Refresh
            </button>
          </div>

          {loadError && (
            <div className="mb-6 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
              {loadError}
            </div>
          )}

          {!rooms ? (
            <div className="flex items-center gap-3 py-16 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin text-teal-400" />
              Loading rooms…
            </div>
          ) : rooms.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 px-6 py-16 text-center">
              <p className="text-sm text-slate-400">
                No rooms yet — create one, or join with a code.
              </p>
              <p className="mt-2 text-xs text-slate-600">
                Rooms are private to the people holding their code.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.map((room, index) => (
                <motion.div
                  key={room.code}
                  initial={{ opacity: 1, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.5,
                    delay: 0.05 * Math.min(index, 8),
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="group relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#0c101a]/80 p-5 transition duration-300 hover:-translate-y-1 hover:border-teal-400/40 hover:bg-[#0e1320] hover:shadow-2xl hover:shadow-teal-950/40"
                >
                  <div
                    className="absolute inset-x-0 top-0 h-px opacity-60"
                    style={{
                      background: `linear-gradient(90deg, transparent, ${languageAccent(room.language)}, transparent)`,
                    }}
                  />
                  <div className="mb-4 flex items-start justify-between">
                    <Link href={`/room/${room.code}`} className="rounded-md border border-teal-400/30 bg-teal-400/10 px-2 py-1 font-mono text-[11px] font-bold tracking-[0.15em] text-teal-200 hover:bg-teal-400/20">
                      {room.code}
                    </Link>
                    <span className="flex items-center gap-2">
                      {room.role === "owner" && <Crown className="h-3.5 w-3.5 text-amber-300" />}
                      {room.activeUsers > 0 && (
                        <span className="flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                          {room.activeUsers} live
                        </span>
                      )}
                    </span>
                  </div>
                  <Link href={`/room/${room.code}`} className="block">
                    <h3 className="truncate text-[15px] font-semibold text-slate-100 group-hover:text-teal-200">
                      {room.title}
                    </h3>
                    <div className="mt-1 text-xs text-slate-500 font-mono">
                      {room.language} · {room.memberCount} member{room.memberCount === 1 ? "" : "s"} · {relativeTime(room.updatedAt)}
                    </div>
                  </Link>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(room.code);
                          showToast(`Copied code ${room.code}`, "success");
                        } catch {}
                      }}
                      className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-medium text-slate-400 hover:bg-white/10 hover:text-slate-200"
                    >
                      Copy Code
                    </button>
                    <button
                      onClick={async () => {
                        const link = `${window.location.origin}/room/${room.code}`;
                        try {
                          await navigator.clipboard.writeText(link);
                          showToast("Invite link copied", "success");
                        } catch {}
                      }}
                      className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-medium text-slate-400 hover:bg-white/10 hover:text-slate-200"
                    >
                      Copy Link
                    </button>
                    <Link href={`/room/${room.code}`} className="rounded-md bg-teal-500 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-teal-400">
                      Open
                    </Link>
                    {room.role === "owner" && (
                      <button
                        onClick={() => void renameRoom(room)}
                        className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-medium text-slate-400 hover:bg-white/10 hover:text-slate-200"
                      >
                        Rename
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        if (!confirm(`Leave room ${room.code}?`)) return;
                        try {
                          await apiFetch(`/api/rooms/${encodeURIComponent(room.code)}/leave`, { method: "POST" });
                          showToast(`Left room ${room.code}`, "success");
                          void refresh();
                        } catch {
                          showToast("Failed to leave room", "error");
                        }
                      }}
                      className="rounded-md border border-white/10 px-2 py-1 text-[10px] text-slate-500 hover:border-rose-400/30 hover:text-rose-300"
                    >
                      Leave
                    </button>
                    {room.role === "owner" && (
                      <button
                        onClick={async () => {
                          if (!confirm(`Delete "${room.title}"?\n\nThis will permanently remove the room and its document.`)) return;
                          try {
                            const res = await apiFetch(`/api/rooms/${encodeURIComponent(room.code)}/delete`, { method: "DELETE" });
                            if (!res.ok) {
                              const err = await res.json().catch(() => ({}));
                              throw new Error((err as any).error || "Failed");
                            }
                            showToast(`Deleted room ${room.code}`, "success");
                            void refresh();
                          } catch (e) {
                            showToast(e instanceof Error ? e.message : "Failed to delete", "error");
                          }
                        }}
                        className="rounded-md border border-rose-400/20 bg-rose-400/10 px-2 py-1 text-[10px] font-medium text-rose-300 hover:bg-rose-400/20"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="grid gap-4 md:grid-cols-3">
            {PILLARS.map(({ icon: Icon, title: pillarTitle, body }, index) => (
              <motion.div
                key={pillarTitle}
                initial={{ opacity: 1, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.55, delay: index * 0.08 }}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6"
              >
                <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg bg-teal-500/10 text-teal-300 ring-1 ring-teal-400/20">
                  <Icon className="h-4 w-4" />
                </div>
                <h3 className="text-[15px] font-semibold text-slate-100">
                  {pillarTitle}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  {body}
                </p>
              </motion.div>
            ))}
          </div>
          <p className="mt-8 flex items-center gap-2 text-xs text-slate-600">
            <MousePointer2 className="h-3 w-3" />
            Tip: open the same room in a second browser profile to watch
            remote carets, selections, and presence converge in real time.
          </p>
        </section>

        <footer className="mx-auto flex max-w-6xl flex-col gap-2 border-t border-white/[0.06] px-6 py-8 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            <span className="font-semibold text-slate-300">Tandem</span>
            <span className="mx-2 text-slate-700">·</span>
            Built by <span className="text-teal-200">Arkadeep Chakraborty</span>
          </p>
          <p className="max-w-md text-slate-600">
            A real-time collaborative coding environment for focused room-based editing.
          </p>
        </footer>
      </div>

      {dialog === "create" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#07090f]/80 p-4 backdrop-blur-md"
          onClick={() => !busy && setDialog(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[#10141f] p-7 shadow-2xl shadow-black/60"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-slate-100">Create a room</h2>
            <p className="mt-1 text-sm text-slate-400">
              The server mints a unique room code you can share.
            </p>

            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void createRoom()}
              placeholder="api-design.ts"
              maxLength={120}
              className="mt-5 w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/20"
            />

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {LANGUAGE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setLanguage(option.id)}
                  className={clsx(
                    "rounded-lg border px-2 py-2 font-mono text-[11px] font-semibold transition",
                    language === option.id
                      ? "border-current bg-white/[0.03]"
                      : "border-white/10 opacity-70 hover:opacity-100",
                  )}
                  style={{ color: option.accent }}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2" role="group" aria-label="Initial editor content">
              <button
                type="button"
                onClick={() => setStarterMode("blank")}
                className={clsx(
                  "rounded-lg border px-3 py-2 text-left text-xs transition",
                  starterMode === "blank"
                    ? "border-teal-300/70 bg-teal-400/10 text-teal-100"
                    : "border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200",
                )}
              >
                <span className="block font-semibold">Blank Editor</span>
                <span className="mt-1 block text-[11px] text-slate-500">Start with an empty document.</span>
              </button>
              <button
                type="button"
                onClick={() => setStarterMode("starter")}
                className={clsx(
                  "rounded-lg border px-3 py-2 text-left text-xs transition",
                  starterMode === "starter"
                    ? "border-cyan-300/70 bg-cyan-400/10 text-cyan-100"
                    : "border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200",
                )}
              >
                <span className="block font-semibold">Starter Template</span>
                <span className="mt-1 block text-[11px] text-slate-500">Insert editable sample code.</span>
              </button>
            </div>

            {formError && (
              <p className="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                {formError}
              </p>
            )}

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => setDialog(null)}
                className="flex-1 rounded-lg border border-white/10 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void createRoom()}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-teal-500 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400 active:scale-[0.98] disabled:opacity-60"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Create room
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog === "join" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#07090f]/80 p-4 backdrop-blur-md"
          onClick={() => !busy && setDialog(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#10141f] p-7 shadow-2xl shadow-black/60"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-slate-100">Join a Room</h2>
            <p className="mt-1 text-sm text-slate-400">
              Enter the 6-character code from your collaborator.
            </p>

            <input
              autoFocus
              value={codeInput}
              onChange={(event) =>
                setCodeInput(normalizeRoomCode(event.target.value))
              }
              onKeyDown={(event) => event.key === "Enter" && void joinRoom(codeInput)}
              placeholder="ABC123"
              maxLength={6}
              spellCheck={false}
              className="mt-5 w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3.5 py-3 text-center font-mono text-lg font-bold tracking-[0.4em] text-slate-100 outline-none transition placeholder:text-slate-700 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/20"
            />

            {formError && (
              <p className="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                {formError}
              </p>
            )}

            <button
              type="button"
              disabled={busy || codeInput.length !== 6}
              onClick={() => void joinRoom(codeInput)}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-teal-500 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400 active:scale-[0.98] disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Join Room
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDialog(null)}
              className="mt-3 w-full text-xs font-medium text-slate-500 transition hover:text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {editingProfile && user && (
        <ProfileDialog
          user={user}
          onClose={(updated) => {
            setUser(updated);
            setEditingProfile(false);
          }}
        />
      )}
    </div>
  );
}
