"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  ArrowUpRight,
  Braces,
  Code2,
  Cpu,
  Crown,
  Database,
  Loader2,
  LogIn,
  MousePointer2,
  Play,
  Pencil,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
  Users,
  Zap,
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
import { ConfirmationDialog, InputDialog } from "@/components/ui/TandemDialog";
import AmbientBackground from "@/components/visual/AmbientBackground";
import CustomCursor from "@/components/visual/CustomCursor";
import MagneticButton from "@/components/visual/MagneticButton";
import ScrollReveal, { revealChild } from "@/components/visual/ScrollReveal";
import TiltCard from "@/components/visual/TiltCard";

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
    body: "Active rooms stay hot in Redis for production collaboration, while PostgreSQL remains the durable source of truth.",
  },
  {
    icon: Timer,
    title: "Ordered, then flushed",
    body: "Every room applies ops in one serialized order with position transforms, then persists accepted revisions to Postgres.",
  },
];

const EXPERIENCE_CARDS = [
  {
    icon: Activity,
    title: "Presence with intent",
    body: "Remote carets, selections, profile colors, and typing signals are surfaced as collaboration context — not visual noise.",
  },
  {
    icon: Terminal,
    title: "Execution in the flow",
    body: "Run code from the same room, keep stdin interactive, and preserve output state without leaving the shared canvas.",
  },
  {
    icon: Sparkles,
    title: "Cinematic, restrained UI",
    body: "Depth, motion, and ambient lighting respond to focus and pointer intent while respecting reduced-motion preferences.",
  },
];

const HERO_CODE_LINES = [
  { user: "Ari", text: "const room = await tandem.join(code);", color: "#67e8f9" },
  { user: "Mina", text: "room.on('change', syncSelections);", color: "#a78bfa" },
  { user: "Noor", text: "run({ stdin: 'Ada\\n42\\n' });", color: "#34d399" },
];

function HeroWorkspaceMock() {
  return (
    <TiltCard className="premium-panel premium-border code-scanline relative rounded-[2rem] p-4 sm:p-5" maxTilt={3}>
      <div className="relative z-10 overflow-hidden rounded-[1.5rem] border border-white/[0.08] bg-[#07101d]/92 shadow-2xl shadow-cyan-950/20">
        <div className="flex items-center justify-between border-b border-white/[0.07] bg-white/[0.025] px-4 py-3">
          <div className="flex items-center gap-2" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-rose-300/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-300/80" />
          </div>
          <div className="flex items-center gap-2 rounded-full border border-cyan-300/15 bg-cyan-300/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-100">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-200" />
            synced
          </div>
        </div>

        <div className="grid gap-0 lg:grid-cols-[1fr_0.46fr]">
          <div className="relative min-h-[320px] p-5 font-mono text-xs leading-6 text-slate-300 sm:text-sm">
            <div className="absolute inset-y-0 left-0 w-10 border-r border-white/[0.05] bg-white/[0.015]" aria-hidden />
            <div className="relative ml-9 space-y-2">
              <p><span className="mr-4 select-none text-slate-600">01</span><span className="text-violet-300">type</span> Session = &#123;</p>
              <p><span className="mr-4 select-none text-slate-600">02</span>  <span className="text-cyan-200">roomCode</span>: <span className="text-emerald-200">&quot;TANDEM&quot;</span>;</p>
              <p><span className="mr-4 select-none text-slate-600">03</span>  <span className="text-cyan-200">latency</span>: <span className="text-amber-200">&quot;live&quot;</span>;</p>
              <p><span className="mr-4 select-none text-slate-600">04</span>  <span className="text-cyan-200">runtime</span>: <span className="text-sky-200">&quot;isolated&quot;</span>;</p>
              <p><span className="mr-4 select-none text-slate-600">05</span>&#125;;</p>
              <div className="relative mt-5 rounded-xl border border-white/[0.07] bg-black/20 p-3">
                {HERO_CODE_LINES.map((line, index) => (
                  <div key={line.user} className="flex items-center gap-3 py-1">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: line.color }} aria-hidden />
                    <span className="min-w-9 text-[10px] uppercase tracking-[0.2em] text-slate-500">{line.user}</span>
                    <span className="text-slate-300">{line.text}</span>
                    {index === 1 && <span className="ml-1 h-4 w-px animate-pulse bg-violet-200" aria-hidden />}
                  </div>
                ))}
              </div>
            </div>
            <div className="absolute left-[52%] top-28 hidden rounded-full border border-violet-300/25 bg-violet-300/10 px-2 py-1 text-[10px] font-semibold text-violet-100 shadow-[0_0_24px_rgba(167,139,250,0.18)] sm:block">
              Mina editing
            </div>
            <div className="absolute left-[34%] top-56 hidden rounded-full border border-cyan-300/25 bg-cyan-300/10 px-2 py-1 text-[10px] font-semibold text-cyan-100 shadow-[0_0_24px_rgba(103,232,249,0.18)] sm:block">
              Ari selected
            </div>
          </div>

          <div className="border-t border-white/[0.07] bg-[#050a13]/70 p-4 lg:border-l lg:border-t-0">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Console</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">
                <Play className="h-3 w-3" /> running
              </span>
            </div>
            <div className="space-y-2 rounded-xl border border-white/[0.06] bg-black/25 p-3 font-mono text-[11px] text-slate-400">
              <p className="text-cyan-200">$ node main.ts</p>
              <p>sync: 3 peers connected</p>
              <p>stdin: Ada Lovelace</p>
              <p className="text-emerald-200">result: 42 accepted</p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              {[
                ["ops", "1.2k"],
                ["delay", "18ms"],
                ["flush", "5s"],
                ["cache", "hot"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
                  <div className="font-mono text-lg font-bold text-slate-100">{value}</div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-600">{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </TiltCard>
  );
}

type Dialog = "create" | "join" | null;
type RoomActionDialog = { type: "leave" | "delete"; room: RoomSummary } | null;

export default function HomeClient() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [user, setUser] = useState<ClientUser | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [renamingRoom, setRenamingRoom] = useState<RoomSummary | null>(null);
  const [roomAction, setRoomAction] = useState<RoomActionDialog>(null);
  const [actionBusy, setActionBusy] = useState(false);

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
        const data = (await ensureClientSession()) as {
          user: ClientUser;
          fresh?: boolean;
          sessionToken?: string;
          authMode?: "bootstrap" | "cookie" | "bearer";
        } | null | undefined;
        if (!data || !data.user || !data.user.id) {
          console.error("[HOME] SESSION_BOOTSTRAP returned invalid data", { data });
          throw new Error("Could not establish a session.");
        }
        console.log("[HOME] SESSION_READY", { id: data.user?.id?.slice(0, 8), name: data.user?.name, fresh: data.fresh });
        setUser(data.user);
        const usingBearer = data.authMode === "bearer";
        console.log("[HOME] session auth mode", { authMode: data.authMode, bearerFallback: usingBearer });
        setBearerFallback(usingBearer);

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

  useEffect(() => {
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setDialog(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, dialog]);

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

  const renameRoom = useCallback((room: RoomSummary) => {
    setRenamingRoom(room);
  }, []);

  const submitRoomRename = useCallback(async (titleValue: string) => {
    if (!renamingRoom) return;
    const next = titleValue.trim();
    if (!next || next === renamingRoom.title) {
      setRenamingRoom(null);
      return;
    }

    setActionBusy(true);
    try {
      const res = await apiFetch(`/api/rooms/${encodeURIComponent(renamingRoom.code)}`, {
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
    } finally {
      setActionBusy(false);
      setRenamingRoom(null);
    }
  }, [refresh, renamingRoom]);

  const submitRoomAction = useCallback(async () => {
    if (!roomAction) return;
    setActionBusy(true);
    try {
      if (roomAction.type === "leave") {
        await apiFetch(`/api/rooms/${encodeURIComponent(roomAction.room.code)}/leave`, { method: "POST" });
        showToast(`Left room ${roomAction.room.code}`, "success");
        void refresh();
      } else {
        const res = await apiFetch(`/api/rooms/${encodeURIComponent(roomAction.room.code)}/delete`, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as any).error || "Failed");
        }
        showToast(`Deleted room ${roomAction.room.code}`, "success");
        void refresh();
      }
    } catch (err) {
      if (roomAction.type === "leave") {
        showToast("Failed to leave room", "error");
      } else {
        showToast(err instanceof Error ? err.message : "Failed to delete", "error");
      }
    } finally {
      setActionBusy(false);
      setRoomAction(null);
    }
  }, [refresh, roomAction]);

  const heroInitial = reduceMotion ? false : { opacity: 0, y: 22 };
  const heroTransition = reduceMotion ? { duration: 0 } : { duration: 0.72, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div data-tandem-home className="relative min-h-screen overflow-hidden bg-[#050814] text-slate-100">
      <CustomCursor />
      <AmbientBackground variant="home" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(15,23,42,0)_0%,rgba(5,8,20,0.45)_52%,rgba(5,8,20,0.95)_100%)]" aria-hidden />

      <div className="relative z-10">
        <nav className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#050814]/72 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-6 lg:px-8">
            <Link href="/" className="group flex items-center gap-3" data-cursor="interactive" aria-label="Tandem home">
              <span className="premium-border relative flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-300/10 text-cyan-200 shadow-[0_0_28px_rgba(34,211,238,0.14)] transition group-hover:scale-105">
                <Braces className="h-4 w-4" />
              </span>
              <span className="text-[15px] font-bold tracking-tight text-slate-50">Tandem</span>
              <span className="hidden items-center gap-1 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-200 sm:flex">
                <ShieldCheck className="h-3 w-3" />
                session-secured
              </span>
            </Link>

            <div className="flex items-center gap-2 sm:gap-3">
              {user && (
                <button
                  type="button"
                  onClick={() => setEditingProfile(true)}
                  className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.025] py-1 pl-1 pr-3 text-left shadow-sm transition hover:border-cyan-200/25 hover:bg-white/[0.05] md:flex"
                  title="Edit your display identity"
                >
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold ring-1 ring-white/10"
                    style={{ backgroundColor: `${user.color}24`, color: user.color }}
                  >
                    {user.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="text-xs font-medium text-slate-300">{user.name}</span>
                  <Pencil className="h-3 w-3 text-slate-500" />
                </button>
              )}
              <MagneticButton
                type="button"
                onClick={() => {
                  setFormError(null);
                  setDialog("create");
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2 text-sm font-bold text-[#031018] shadow-[0_12px_38px_rgba(34,211,238,0.22)] transition hover:bg-cyan-200 active:scale-[0.98]"
              >
                <Plus className="h-4 w-4" />
                Create Room
              </MagneticButton>
            </div>
          </div>
        </nav>

        {/* Only show cookie-blocked message if bearer fallback also fails */}
        {loadError && !bearerFallback && (
          <div className="mx-auto max-w-7xl px-5 pt-6 sm:px-6 lg:px-8">
            <div className="premium-panel rounded-2xl border-amber-300/20 px-4 py-3 text-sm text-amber-100">
              <p className="font-medium">
                Could not establish a session. Your browser may be blocking both cookies and session storage. Open this app in a new browser tab.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => window.open(window.location.href, "_blank")}
                  className="rounded-lg bg-amber-300 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-amber-200"
                >
                  Open in new tab
                </button>
              </div>
            </div>
          </div>
        )}

        {bearerFallback && (
          <div className="mx-auto max-w-7xl px-5 pt-6 sm:px-6 lg:px-8">
            <div className="premium-panel rounded-2xl border-cyan-300/20 px-4 py-3 text-sm text-cyan-100">
              <p className="font-medium">
                Using secure bearer session fallback — your browser is blocking embedded cookies, but collaboration will still work in this preview.
              </p>
            </div>
          </div>
        )}

        <header className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-14 pt-14 sm:px-6 md:pt-20 lg:grid-cols-[0.92fr_1.08fr] lg:px-8 lg:pb-24">
          <motion.div initial={heroInitial} animate={{ opacity: 1, y: 0 }} transition={heroTransition}>
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-semibold text-slate-300 shadow-sm backdrop-blur">
              <Radio className="h-3.5 w-3.5 text-emerald-300" />
              Real-time rooms · OT sync · isolated execution
            </p>
            <h1 className="max-w-4xl text-5xl font-black leading-[0.98] tracking-[-0.05em] text-slate-50 sm:text-6xl lg:text-7xl">
              Build in sync inside a{" "}
              <span className="bg-gradient-to-r from-cyan-200 via-sky-300 to-violet-300 bg-clip-text text-transparent">
                futuristic code room.
              </span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-400">
              Create a room, share its code, and work through code or markdown together — every keystroke, caret, selection, and run loop stays in one polished collaborative workspace.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <MagneticButton
                type="button"
                onClick={() => {
                  setFormError(null);
                  setDialog("create");
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-3 text-sm font-bold text-[#031018] shadow-[0_18px_48px_rgba(34,211,238,0.24)] transition hover:bg-cyan-200 active:scale-[0.98]"
              >
                <Plus className="h-4 w-4" />
                Create Room
              </MagneticButton>
              <MagneticButton
                type="button"
                onClick={() => {
                  setFormError(null);
                  setDialog("join");
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.035] px-5 py-3 text-sm font-semibold text-slate-100 transition hover:border-cyan-200/35 hover:bg-white/[0.075]"
              >
                <LogIn className="h-4 w-4" />
                Join Room
              </MagneticButton>
              <button
                type="button"
                onClick={() => void joinRoom(DEMO_ROOM_CODE)}
                className="rounded-lg px-2 py-2 font-mono text-xs text-slate-500 underline decoration-dotted underline-offset-4 transition hover:text-slate-300"
                title={`Join the public demo room (${DEMO_ROOM_CODE})`}
              >
                try demo: {DEMO_ROOM_CODE}
              </button>
            </div>

            <div className="mt-9 grid max-w-xl grid-cols-3 gap-3 border-y border-white/[0.07] py-5">
              {[
                { label: "your rooms", value: stats.count, icon: Braces },
                { label: "live peers", value: stats.live, icon: Users },
                { label: "languages", value: stats.languages, icon: Cpu },
              ].map(({ label, value, icon: Icon }) => (
                <div key={label} className="rounded-2xl border border-white/[0.06] bg-white/[0.025] p-3">
                  <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-300/10 text-cyan-200 ring-1 ring-cyan-200/15">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="font-mono text-2xl font-black text-slate-50">{rooms ? value : "—"}</div>
                  <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</div>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 26, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={reduceMotion ? { duration: 0 } : { ...heroTransition, delay: 0.12 }}
            className="relative"
          >
            <div className="absolute -inset-10 rounded-full bg-cyan-400/10 blur-3xl" aria-hidden />
            <HeroWorkspaceMock />
          </motion.div>
        </header>

        <main>
          <ScrollReveal className="mx-auto max-w-7xl px-5 pb-20 sm:px-6 lg:px-8">
            <div className="mb-7 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200/70">Command center</p>
                <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">Your rooms</h2>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                className="inline-flex w-fit items-center gap-2 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2 text-xs font-semibold text-slate-400 transition hover:border-cyan-200/25 hover:bg-white/[0.06] hover:text-slate-200"
              >
                <Zap className="h-3.5 w-3.5 text-cyan-200" />
                Refresh
              </button>
            </div>

            {loadError && (
              <div className="mb-6 rounded-2xl border border-rose-300/25 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                {loadError}
              </div>
            )}

            {!rooms ? (
              <div className="premium-panel flex items-center gap-3 rounded-3xl px-6 py-16 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
                Loading rooms…
              </div>
            ) : rooms.length === 0 ? (
              <div className="premium-panel rounded-3xl border-dashed px-6 py-16 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-200 ring-1 ring-cyan-200/20">
                  <Code2 className="h-5 w-5" />
                </div>
                <p className="text-sm font-semibold text-slate-300">No rooms yet — create one, or join with a code.</p>
                <p className="mt-2 text-xs text-slate-600">Rooms are private to the people holding their code.</p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {rooms.map((room, index) => (
                  <motion.div
                    key={room.code}
                    initial={reduceMotion ? false : { opacity: 0, y: 16 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-60px" }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.45, delay: 0.04 * Math.min(index, 8), ease: [0.22, 1, 0.36, 1] }}
                  >
                    <TiltCard className="premium-panel premium-border group h-full rounded-3xl p-5 transition duration-300 hover:border-cyan-200/20 hover:shadow-[0_26px_90px_rgba(8,145,178,0.16)]" maxTilt={3}>
                      <div
                        className="absolute inset-x-6 top-0 h-px opacity-80"
                        style={{ background: `linear-gradient(90deg, transparent, ${languageAccent(room.language)}, transparent)` }}
                        aria-hidden
                      />
                      <div className="relative z-10 mb-5 flex items-start justify-between gap-3">
                        <Link href={`/room/${room.code}`} className="rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-2.5 py-1.5 font-mono text-[11px] font-bold tracking-[0.16em] text-cyan-100 transition hover:bg-cyan-300/15">
                          {room.code}
                        </Link>
                        <span className="flex items-center gap-2">
                          {room.role === "owner" && <Crown className="h-3.5 w-3.5 text-amber-300" />}
                          {room.activeUsers > 0 && (
                            <span className="flex items-center gap-1.5 rounded-full border border-emerald-300/15 bg-emerald-300/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
                              {room.activeUsers} live
                            </span>
                          )}
                        </span>
                      </div>

                      <Link href={`/room/${room.code}`} className="relative z-10 block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/70">
                        <h3 className="truncate text-base font-bold text-slate-50 transition group-hover:text-cyan-100">{room.title}</h3>
                        <div className="mt-2 font-mono text-xs text-slate-500">
                          {room.language} · {room.memberCount} member{room.memberCount === 1 ? "" : "s"} · {relativeTime(room.updatedAt)}
                        </div>
                      </Link>

                      <div className="relative z-10 mt-5 flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(room.code);
                              showToast(`Copied code ${room.code}`, "success");
                            } catch {}
                          }}
                          className="rounded-lg border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 hover:border-white/20 hover:bg-white/10 hover:text-slate-200"
                        >
                          Copy Code
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const link = `${window.location.origin}/room/${room.code}`;
                            try {
                              await navigator.clipboard.writeText(link);
                              showToast("Invite link copied", "success");
                            } catch {}
                          }}
                          className="rounded-lg border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 hover:border-white/20 hover:bg-white/10 hover:text-slate-200"
                        >
                          Copy Link
                        </button>
                        <Link href={`/room/${room.code}`} className="inline-flex items-center gap-1 rounded-lg bg-cyan-300 px-2.5 py-1.5 text-[10px] font-bold text-[#041018] hover:bg-cyan-200">
                          Open <ArrowUpRight className="h-3 w-3" />
                        </Link>
                        {room.role === "owner" && (
                          <button
                            type="button"
                            onClick={() => void renameRoom(room)}
                            className="rounded-lg border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 hover:border-white/20 hover:bg-white/10 hover:text-slate-200"
                          >
                            Rename
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setRoomAction({ type: "leave", room })}
                          className="rounded-lg border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-[10px] font-semibold text-slate-500 hover:border-rose-300/30 hover:bg-rose-400/10 hover:text-rose-200"
                        >
                          Leave
                        </button>
                        {room.role === "owner" && (
                          <button
                            type="button"
                            onClick={() => setRoomAction({ type: "delete", room })}
                            className="rounded-lg border border-rose-300/25 bg-rose-400/10 px-2.5 py-1.5 text-[10px] font-semibold text-rose-200 hover:bg-rose-400/20"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </TiltCard>
                  </motion.div>
                ))}
              </div>
            )}
          </ScrollReveal>

          <ScrollReveal className="mx-auto max-w-7xl px-5 pb-20 sm:px-6 lg:px-8">
            <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
              <div className="premium-panel premium-border rounded-3xl p-6 sm:p-8">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-200/70">Interaction system</p>
                <h2 className="mt-3 text-3xl font-black tracking-tight text-slate-50">Responsive without getting loud.</h2>
                <p className="mt-4 text-sm leading-7 text-slate-400">
                  Tandem now uses soft motion, precise focus states, ambient pointer light, and subtle card depth to make collaboration feel active while keeping editor workspaces calm.
                </p>
                <div className="mt-6 flex flex-wrap gap-2">
                  {[
                    "reduced-motion aware",
                    "keyboard-first",
                    "coarse-pointer safe",
                    "terminal-safe",
                  ].map((item) => (
                    <span key={item} className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] font-semibold text-slate-400">
                      {item}
                    </span>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                {EXPERIENCE_CARDS.map(({ icon: Icon, title: cardTitle, body }) => (
                  <motion.div key={cardTitle} variants={revealChild}>
                    <TiltCard className="premium-panel h-full rounded-3xl p-6" maxTilt={3}>
                      <div className="relative z-10 mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-200 ring-1 ring-cyan-200/15">
                        <Icon className="h-5 w-5" />
                      </div>
                      <h3 className="relative z-10 text-[15px] font-bold text-slate-50">{cardTitle}</h3>
                      <p className="relative z-10 mt-3 text-sm leading-6 text-slate-400">{body}</p>
                    </TiltCard>
                  </motion.div>
                ))}
              </div>
            </div>
          </ScrollReveal>

          <ScrollReveal className="mx-auto max-w-7xl px-5 pb-24 sm:px-6 lg:px-8">
            <div className="grid gap-4 md:grid-cols-3">
              {PILLARS.map(({ icon: Icon, title: pillarTitle, body }) => (
                <motion.div key={pillarTitle} variants={revealChild}>
                  <div className="premium-panel rounded-3xl p-6">
                    <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-2xl bg-teal-300/10 text-teal-200 ring-1 ring-teal-200/15">
                      <Icon className="h-4 w-4" />
                    </div>
                    <h3 className="text-[15px] font-bold text-slate-50">{pillarTitle}</h3>
                    <p className="mt-3 text-sm leading-6 text-slate-400">{body}</p>
                  </div>
                </motion.div>
              ))}
            </div>
            <p className="mt-8 flex items-center gap-2 text-xs text-slate-600">
              <MousePointer2 className="h-3 w-3" />
              Tip: open the same room in a second browser profile to watch remote carets, selections, and presence converge in real time.
            </p>
          </ScrollReveal>
        </main>

        <footer className="mx-auto flex max-w-7xl flex-col gap-3 border-t border-white/[0.07] px-5 py-8 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>
            <span className="font-semibold text-slate-300">Tandem</span>
            <span className="mx-2 text-slate-700">·</span>
            Built by <span className="text-cyan-200">Arkadeep Chakraborty</span>
          </p>
          <p className="max-w-md text-slate-600">
            A real-time collaborative coding environment for focused room-based editing.
          </p>
        </footer>
      </div>

      {dialog === "create" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#050814]/82 p-4 backdrop-blur-xl"
          onMouseDown={() => !busy && setDialog(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-room-title"
            className="premium-panel premium-border w-full max-w-md rounded-3xl p-7 outline-none"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-200 ring-1 ring-cyan-200/20">
              <Plus className="h-5 w-5" />
            </div>
            <h2 id="create-room-title" className="text-lg font-bold text-slate-50">Create a room</h2>
            <p className="mt-1 text-sm text-slate-400">The server mints a unique room code you can share.</p>

            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void createRoom()}
              placeholder="api-design.ts"
              maxLength={120}
              className="mt-5 w-full rounded-xl border border-white/10 bg-[#070c16] px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
            />

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {LANGUAGE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setLanguage(option.id)}
                  className={clsx(
                    "rounded-xl border px-2 py-2 font-mono text-[11px] font-semibold transition",
                    language === option.id
                      ? "border-current bg-white/[0.05] shadow-[0_0_22px_rgba(103,232,249,0.06)]"
                      : "border-white/10 opacity-75 hover:bg-white/[0.04] hover:opacity-100",
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
                  "rounded-xl border px-3 py-2 text-left text-xs transition",
                  starterMode === "blank"
                    ? "border-cyan-300/70 bg-cyan-300/10 text-cyan-100"
                    : "border-white/10 text-slate-400 hover:bg-white/[0.05] hover:text-slate-200",
                )}
              >
                <span className="block font-semibold">Blank Editor</span>
                <span className="mt-1 block text-[11px] text-slate-500">Start with an empty document.</span>
              </button>
              <button
                type="button"
                onClick={() => setStarterMode("starter")}
                className={clsx(
                  "rounded-xl border px-3 py-2 text-left text-xs transition",
                  starterMode === "starter"
                    ? "border-violet-300/70 bg-violet-300/10 text-violet-100"
                    : "border-white/10 text-slate-400 hover:bg-white/[0.05] hover:text-slate-200",
                )}
              >
                <span className="block font-semibold">Starter Template</span>
                <span className="mt-1 block text-[11px] text-slate-500">Insert editable sample code.</span>
              </button>
            </div>

            {formError && (
              <p className="mt-4 rounded-xl border border-rose-300/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">{formError}</p>
            )}

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => setDialog(null)}
                className="flex-1 rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.05] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void createRoom()}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-300 py-2.5 text-sm font-bold text-[#031018] transition hover:bg-cyan-200 active:scale-[0.98] disabled:opacity-60"
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#050814]/82 p-4 backdrop-blur-xl"
          onMouseDown={() => !busy && setDialog(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="join-room-title"
            className="premium-panel premium-border w-full max-w-sm rounded-3xl p-7 outline-none"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-300/10 text-violet-200 ring-1 ring-violet-200/20">
              <LogIn className="h-5 w-5" />
            </div>
            <h2 id="join-room-title" className="text-lg font-bold text-slate-50">Join a Room</h2>
            <p className="mt-1 text-sm text-slate-400">Enter the 6-character code from your collaborator.</p>

            <input
              autoFocus
              value={codeInput}
              onChange={(event) => setCodeInput(normalizeRoomCode(event.target.value))}
              onKeyDown={(event) => event.key === "Enter" && void joinRoom(codeInput)}
              placeholder="ABC123"
              maxLength={6}
              spellCheck={false}
              className="mt-5 w-full rounded-xl border border-white/10 bg-[#070c16] px-3.5 py-3 text-center font-mono text-lg font-bold tracking-[0.4em] text-slate-100 outline-none transition placeholder:text-slate-700 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
            />

            {formError && (
              <p className="mt-4 rounded-xl border border-rose-300/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">{formError}</p>
            )}

            <button
              type="button"
              disabled={busy || codeInput.length !== 6}
              onClick={() => void joinRoom(codeInput)}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 py-2.5 text-sm font-bold text-[#031018] transition hover:bg-cyan-200 active:scale-[0.98] disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Join Room
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDialog(null)}
              className="mt-3 w-full rounded-lg py-2 text-xs font-semibold text-slate-500 transition hover:bg-white/[0.04] hover:text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {renamingRoom && (
        <InputDialog
          title="Rename room"
          description={`Update the display title for room ${renamingRoom.code}.`}
          initialValue={renamingRoom.title}
          placeholder="Room title"
          maxLength={120}
          confirmLabel="Save title"
          busy={actionBusy}
          validate={(value) => value.length === 0 ? "Room title cannot be empty." : null}
          onClose={() => {
            if (!actionBusy) setRenamingRoom(null);
          }}
          onConfirm={submitRoomRename}
        />
      )}

      {roomAction && (
        <ConfirmationDialog
          title={
            roomAction.type === "leave"
              ? `Leave room ${roomAction.room.code}?`
              : `Delete "${roomAction.room.title}"?`
          }
          description={
            roomAction.type === "leave"
              ? "This removes the room from Your Rooms for this browser session. Other collaborators keep access."
              : "This will permanently remove the room and its document for everyone. This action cannot be undone."
          }
          confirmLabel={roomAction.type === "leave" ? "Leave room" : "Delete room"}
          tone={roomAction.type === "delete" ? "destructive" : "default"}
          busy={actionBusy}
          onClose={() => {
            if (!actionBusy) setRoomAction(null);
          }}
          onConfirm={submitRoomAction}
        />
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
