"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Copy,
  Crown,
  Database,
  GitBranch,
  HardDrive,
  Link2,
  Loader2,
  Lock,
  LogOut,
  MoreVertical,
  Play,
  Download,
  Settings,
  Unlock,
  UserMinus,
  Users,
  ShieldAlert,
  FileJson,
  Terminal as TerminalIcon,
} from "lucide-react";
import clsx from "clsx";
import CollaborativeMonaco from "@/components/editor/MonacoEditor";
import PresenceBar from "@/components/editor/PresenceBar";
import ProfileDialog from "@/components/editor/ProfileDialog";
import MarkdownPreview from "@/components/editor/MarkdownPreview";
import SafePreview from "@/components/editor/SafePreview";
import OutputPanel from "@/components/editor/OutputPanel";
import ProblemsPanel from "@/components/editor/ProblemsPanel";
import { showToast } from "@/components/ui/Toast";
import { useCollaborativeDocument } from "@/lib/useCollaborativeDocument";
import {
  LANGUAGE_OPTIONS,
  LANGUAGE_STARTERS,
  fileExtensionFor,
  languageAccent,
  type ClientUser,
  type RoomMemberInfo,
  type RoomRole,
} from "@/lib/types";
import { apiFetch, ensureClientSession } from "@/lib/apiFetch";
import { isExecutionLanguage, type ExecutionAvailability, type ExecutionProblem, type ExecutionResult } from "@/lib/execution/types";

type ViewMode = "edit" | "split" | "preview";
type BottomTab = "output" | "problems" | "input";

interface EditorRoomProps {
  room: { code: string; title: string; language: string; locked?: boolean };
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
  const [showSettings, setShowSettings] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [memberMenuUserId, setMemberMenuUserId] = useState<string | null>(null);
  const [lockUpdating, setLockUpdating] = useState(false);
  const [kickingUserId, setKickingUserId] = useState<string | null>(null);

  // Execution state
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
  const [executionAvailability, setExecutionAvailability] = useState<ExecutionAvailability | null>(null);
  const [running, setRunning] = useState(false);
  const [stdin, setStdin] = useState("");
  const [bottomTab, setBottomTab] = useState<BottomTab>("output");
  const [bottomOpen, setBottomOpen] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  const [minimap, setMinimap] = useState(false);

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const { state, setBridge, submitLocalOps, publishPresence, updateMeta } =
    useCollaborativeDocument(room.code);

  const profile = profileOverride ?? state.you ?? you;
  const selfUserId = profile.id;
  const currentMembers = state.members;
  const selfMember = currentMembers.find((member) => member.user.id === selfUserId);
  const currentRole = selfMember?.role ?? state.role ?? role;
  const isOwner = currentRole === "owner";
  const roomLocked =
    state.connection === "connected" || currentMembers.length > 0
      ? state.locked
      : Boolean(room.locked);
  const titleShown = state.title || room.title;
  const isMarkdown = state.language === "markdown";
  const isHtml = state.language === "html";
  const isCss = state.language === "css";
  const isExecutable = isExecutionLanguage(state.language);
  const hasPreview = isMarkdown || isHtml || isCss;
  const hasResultPane = isExecutable || state.language === "json";
  const hasCompanionPane = hasPreview || hasResultPane;
  const viewMode = manualViewMode ?? (hasPreview ? "split" : "edit");

  const currentExecutionAvailability = isExecutable
    ? executionAvailability?.languages[state.language as keyof ExecutionAvailability["languages"]]
    : null;
  const executionReady = !isExecutable || currentExecutionAvailability?.ready !== false;
  const executionUnavailableMessage =
    "Code execution is unavailable because the Tandem Docker execution sandbox is not configured. Configure the sandbox locally, then refresh execution readiness.";

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

  const getCurrentContent = useCallback(() => {
    return editorRef.current?.getModel()?.getValue() ?? latestMirrorRef.current ?? "";
  }, []);

  useEffect(() => {
    let disposed = false;
    void fetch("/api/execution", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ExecutionAvailability | null) => {
        if (!disposed && data) setExecutionAvailability(data);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  const setProblemMarkers = useCallback((problems: ExecutionProblem[]) => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    const markers = problems.map((p) => ({
      startLineNumber: Math.max(1, p.line),
      startColumn: Math.max(1, p.column || 1),
      endLineNumber: Math.max(1, p.line),
      endColumn: Math.max(2, (p.column || 1) + 10),
      message: p.message,
      severity:
        p.severity === "error"
          ? monaco.MarkerSeverity.Error
          : p.severity === "warning"
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
    }));
    monaco.editor.setModelMarkers(model, "tandem", markers);
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
    } catch {}
  }, []);

  const exitRoom = useCallback(() => {
    router.push("/");
  }, [router]);

  const leaveRoom = useCallback(async () => {
    if (leaving) return;
    if (!window.confirm(`Leave room ${room.code}?\n\nThis removes the room from Your Rooms for this browser session. Use Back/Home if you only want to exit the editor.`)) return;
    setLeaving(true);
    try {
      await apiFetch(`/api/rooms/${encodeURIComponent(room.code)}/leave`, {
        method: "POST",
      });
    } catch {}
    router.push("/");
  }, [leaving, room.code, router]);

  const toggleRoomLock = useCallback(async () => {
    if (!isOwner || lockUpdating) return;
    const nextLocked = !roomLocked;
    setLockUpdating(true);
    try {
      const res = await apiFetch(`/api/rooms/${encodeURIComponent(room.code)}/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked: nextLocked }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not update room lock.");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not update room lock.", "error");
    } finally {
      setLockUpdating(false);
    }
  }, [isOwner, lockUpdating, room.code, roomLocked]);

  const kickMember = useCallback(async (member: RoomMemberInfo) => {
    if (!isOwner || member.role === "owner" || member.user.id === selfUserId) return;
    if (!window.confirm(`Remove ${member.user.name} from room ${room.code}?`)) return;
    setKickingUserId(member.user.id);
    try {
      const res = await apiFetch(
        `/api/rooms/${encodeURIComponent(room.code)}/members/${encodeURIComponent(member.user.id)}/kick`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not remove that member.");
      setMemberMenuUserId(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not remove that member.", "error");
    } finally {
      setKickingUserId(null);
    }
  }, [isOwner, room.code, selfUserId]);

  const openPanelSurface = useCallback((tab: BottomTab) => {
    setBottomTab(tab);
    setBottomOpen(!(hasResultPane && viewMode !== "edit"));
  }, [hasResultPane, viewMode]);

  const runCode = useCallback(async () => {
    if (running) return;
    if (isExecutable && currentExecutionAvailability?.ready === false) {
      openPanelSurface("output");
      setExecutionResult({
        status: "unavailable",
        stdout: "",
        stderr: currentExecutionAvailability.reason
          ? `${executionUnavailableMessage}\n\n${currentExecutionAvailability.reason}`
          : executionUnavailableMessage,
        exitCode: null,
        duration: 0,
        problems: [],
      });
      return;
    }
    const code = getCurrentContent();
    if (!code.trim()) return;

    setRunning(true);
    openPanelSurface("output");
    setExecutionResult(null);

    try {
      await ensureClientSession();
      const res = await apiFetch(`/api/rooms/${encodeURIComponent(room.code)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: state.language,
          code,
          stdin: stdin || undefined,
        }),
      });

      const result = (await res.json()) as ExecutionResult & { error?: string };
      
      if (!res.ok && result.error) {
        setExecutionResult({
          status: "execution_error",
          stdout: "",
          stderr: result.error,
          exitCode: null,
          duration: 0,
          problems: [],
        });
      } else {
        setExecutionResult(result);
        if (result.problems && result.problems.length > 0) {
          setBottomTab("problems");
          setProblemMarkers(result.problems);
        } else {
          setProblemMarkers([]);
        }
      }
    } catch (err) {
      setExecutionResult({
        status: "execution_error",
        stdout: "",
        stderr: err instanceof Error ? err.message : "Failed to execute",
        exitCode: null,
        duration: 0,
        problems: [],
      });
    } finally {
      setRunning(false);
    }
  }, [currentExecutionAvailability, executionUnavailableMessage, getCurrentContent, isExecutable, openPanelSurface, running, room.code, setProblemMarkers, state.language, stdin]);

  useEffect(() => {
    const handleRun = () => {
      if (isExecutable) void runCode();
    };
    const handleSave = () => {
      showToast(state.unsent ? "Saving…" : "Saved", state.unsent ? "info" : "success");
    };
    window.addEventListener("tandem-run-code", handleRun);
    window.addEventListener("tandem-save-request", handleSave);
    return () => {
      window.removeEventListener("tandem-run-code", handleRun);
      window.removeEventListener("tandem-save-request", handleSave);
    };
  }, [isExecutable, runCode, state.unsent]);

  const jumpToError = useCallback((line: number, column?: number) => {
    if (editorRef.current) {
      editorRef.current.revealLineInCenter(line);
      editorRef.current.setPosition({ lineNumber: line, column: column || 1 });
      editorRef.current.focus();
    }
  }, []);

  const copyCode = useCallback(async () => {
    const code = getCurrentContent();
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1500);
    } catch {}
  }, [getCurrentContent]);

  const downloadCode = useCallback(() => {
    const code = getCurrentContent();
    const ext = fileExtensionFor(state.language);
    const filename = `${titleShown.replace(/[^a-z0-9]/gi, "_") || "code"}.${ext}`;
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [getCurrentContent, titleShown, state.language]);

  const makeJsonProblem = useCallback((code: string, err: unknown): ExecutionProblem => {
    const message = err instanceof Error ? err.message : "Invalid JSON";
    const match = message.match(/position (\d+)/i);
    if (!match) return { file: "data.json", line: 1, column: 1, message, severity: "error" };
    const position = Number(match[1]);
    const before = code.slice(0, Math.max(0, position));
    const lines = before.split("\n");
    return {
      file: "data.json",
      line: lines.length,
      column: (lines.at(-1)?.length ?? 0) + 1,
      message,
      severity: "error",
    };
  }, []);


  const validateJson = useCallback(() => {
    if (state.language !== "json") return false;
    const code = getCurrentContent();
    try {
      JSON.parse(code);
      setExecutionResult({
        status: "success",
        stdout: "JSON is valid.",
        stderr: "",
        exitCode: 0,
        duration: 0,
        problems: [],
      });
      setProblemMarkers([]);
      openPanelSurface("output");
      return true;
    } catch (err) {
      const problem = makeJsonProblem(code, err);
      setExecutionResult({
        status: "runtime_error",
        stdout: "",
        stderr: problem.message,
        exitCode: 1,
        duration: 0,
        problems: [problem],
      });
      setProblemMarkers([problem]);
      openPanelSurface("problems");
      return false;
    }
  }, [getCurrentContent, makeJsonProblem, openPanelSurface, setProblemMarkers, state.language]);

  const formatJson = useCallback(() => {
    if (state.language !== "json") return;
    const code = getCurrentContent();
    try {
      const parsed = JSON.parse(code);
      const formatted = JSON.stringify(parsed, null, 2);
      const model = editorRef.current?.getModel();
      if (model) {
        editorRef.current.executeEdits("format", [
          {
            range: model.getFullModelRange(),
            text: formatted,
          },
        ]);
        setProblemMarkers([]);
      }
    } catch (err) {
      const problem = makeJsonProblem(code, err);
      setExecutionResult({
        status: "runtime_error",
        stdout: "",
        stderr: problem.message,
        exitCode: 1,
        duration: 0,
        problems: [problem],
      });
      setProblemMarkers([problem]);
      openPanelSurface("problems");
    }
  }, [getCurrentContent, makeJsonProblem, openPanelSurface, setProblemMarkers, state.language]);

  const insertStarterTemplate = useCallback(() => {
    const starter = LANGUAGE_STARTERS[state.language as keyof typeof LANGUAGE_STARTERS];
    if (!starter) return;
    const current = getCurrentContent();
    if (current.trim().length > 0) {
      const ok = window.confirm(
        `Replace the current document with the ${LANGUAGE_OPTIONS.find((l) => l.id === state.language)?.label ?? state.language} starter template?\n\nThis is an explicit replace action and cannot be undone after collaborators sync it.`,
      );
      if (!ok) return;
    }
    const model = editorRef.current?.getModel();
    if (!model) return;
    editorRef.current.executeEdits("starter-template", [
      { range: model.getFullModelRange(), text: starter },
    ]);
    editorRef.current.focus();
  }, [getCurrentContent, state.language]);

  const connected = state.connection === "connected";
  const dirty =
    state.unsent ||
    (state.revision > 0 && state.syncedRevision < state.revision);
  const inviteLink =
    typeof window !== "undefined"
      ? `${window.location.origin}/room/${room.code}`
      : `/room/${room.code}`;

  const problemsCount = executionResult?.problems?.length || 0;
  const errorsCount = executionResult?.problems?.filter(p => p.severity === "error").length || 0;
  const displayedMembers: RoomMemberInfo[] = currentMembers.length > 0
    ? currentMembers
    : state.users.map((presence) => ({
        user: presence.user,
        role: presence.user.id === selfUserId ? currentRole : "editor",
        joinedAt: new Date(presence.joinedAt).toISOString(),
        online: true,
      }));
  const remoteTypingNames = Array.from(
    state.users.reduce((map, presence) => {
      if (
        presence.typing &&
        presence.sessionId !== state.selfSessionId &&
        presence.user.id !== selfUserId
      ) {
        map.set(presence.user.id, presence.user.name);
      }
      return map;
    }, new Map<string, string>()).values(),
  );
  const typingStatus =
    remoteTypingNames.length === 0
      ? null
      : remoteTypingNames.length === 1
        ? `${remoteTypingNames[0]} is typing…`
        : remoteTypingNames.length === 2
          ? `${remoteTypingNames[0]} and ${remoteTypingNames[1]} are typing…`
          : `${remoteTypingNames[0]}, ${remoteTypingNames[1]}, and ${remoteTypingNames.length - 2} more are typing…`;
  const panelSurfaceVisible =
    bottomOpen || (hasResultPane && viewMode !== "edit");

  const renderInputPanel = () => (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        Stdin (input for program)
      </div>
      <textarea
        value={stdin}
        onChange={(event) => setStdin(event.target.value)}
        placeholder="Enter input for your program, e.g.&#10;5&#10;10&#10;20"
        className="flex-1 resize-none rounded border border-white/10 bg-[#0b0e14] p-3 font-mono text-xs text-slate-200 outline-none focus:border-teal-400/50"
      />
      <div className="mt-2 text-[10px] text-slate-600">
        Max 10KB, will be fed to program&apos;s stdin
      </div>
    </div>
  );

  const renderResultPanel = (withHeader = false) => (
    <div className="flex h-full min-h-0 flex-col bg-[#0a0d13]">
      {withHeader && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 text-xs font-semibold text-slate-400">
          <TerminalIcon className="h-3.5 w-3.5 text-cyan-200" />
          <span>{bottomTab === "output" ? "Output" : bottomTab === "problems" ? "Problems" : "Input"}</span>
          {bottomTab === "problems" && problemsCount > 0 && (
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-300">
              {problemsCount}
            </span>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {bottomTab === "output" && (
          <OutputPanel
            result={executionResult}
            running={running}
            onClear={() => setExecutionResult(null)}
          />
        )}
        {bottomTab === "problems" && (
          <ProblemsPanel problems={executionResult?.problems || []} onJumpTo={jumpToError} />
        )}
        {bottomTab === "input" && renderInputPanel()}
      </div>
    </div>
  );

  const renderCompanionPane = () => {
    if (hasPreview) {
      return isMarkdown ? (
        <MarkdownPreview markdown={previewContent} />
      ) : (
        <SafePreview language={isHtml ? "html" : "css"} content={previewContent} />
      );
    }
    return renderResultPanel(true);
  };

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-[#07090f] text-slate-200">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-3 overflow-x-auto border-b border-white/[0.06] bg-[#0b0e14]/90 px-4 backdrop-blur">
        <button
          type="button"
          onClick={exitRoom}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-slate-400 transition hover:border-white/20 hover:text-slate-100"
          aria-label="Back to rooms"
          title="Back to rooms"
        >
          {leaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeft className="h-4 w-4" />}
        </button>

        <div className="hidden leading-tight sm:block">
          <div className="text-sm font-bold tracking-tight text-slate-100">Tandem</div>
          <div className="font-mono text-[10px] tracking-[0.16em] text-teal-300/80">{room.code}</div>
        </div>

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
              ? "border-transparent hover:border-white/10 focus:border-teal-400/50 focus:bg-[#0b0e14]"
              : "cursor-default border-transparent",
          )}
        />

        <span className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium">
          <span className={clsx("h-1.5 w-1.5 rounded-full", connected ? "animate-pulse bg-emerald-400" : state.connection === "error" ? "bg-rose-400" : "animate-pulse bg-amber-400")} />
          <span className="hidden text-slate-400 sm:inline">
            {connected ? "Live" : state.connection === "error" ? "Connection failed" : "Reconnecting…"}
          </span>
        </span>

        {isOwner && (
          <span className="hidden items-center gap-1 rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-[10px] font-semibold text-amber-200 md:flex">
            <Crown className="h-3 w-3" />
            Owner
          </span>
        )}


        <div className="ml-auto flex items-center gap-2">
          <PresenceBar
            users={state.users}
            selfSessionId={state.selfSessionId}
            selfUserId={selfUserId}
            onEditProfile={() => setEditingProfile(true)}
          />

          <button
            type="button"
            onClick={() => setMembersOpen((open) => !open)}
            className={clsx(
              "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition",
              membersOpen
                ? "border-teal-300/30 bg-teal-300/10 text-teal-100"
                : "border-white/10 text-slate-300 hover:border-white/20 hover:bg-white/5",
            )}
            aria-expanded={membersOpen}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="hidden lg:inline">
              {displayedMembers.length || state.users.length} collaborators
            </span>
            <span className="lg:hidden">{displayedMembers.length || state.users.length}</span>
            {roomLocked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-300/10 px-1.5 py-0.5 text-[10px] text-rose-200">
                <Lock className="h-2.5 w-2.5" />
                Locked
              </span>
            )}
          </button>

          <div className="hidden h-5 w-px bg-white/10 md:block" />

          {isOwner ? (
            <div className="relative">
              <select
                value={state.language}
                onChange={(event) => void updateMeta({ language: event.target.value })}
                className="cursor-pointer appearance-none rounded-lg border border-white/10 bg-[#11151f] py-1.5 pl-3 pr-7 text-xs font-medium outline-none transition hover:border-white/20 focus:border-teal-400/50"
                style={{ color: languageAccent(state.language) }}
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id} className="bg-[#11151f] text-slate-200">
                    {option.label}
                  </option>
                ))}
              </select>
              <GitBranch className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" />
            </div>
          ) : (
            <span
              className="rounded-md px-2 py-1 font-mono text-[11px] font-semibold"
              style={{ color: languageAccent(state.language), backgroundColor: `${languageAccent(state.language)}14` }}
            >
              {LANGUAGE_OPTIONS.find((l) => l.id === state.language)?.label ?? state.language}
            </span>
          )}

          <div className="flex items-center gap-1">
            {isExecutable && (
              <button
                onClick={() => void runCode()}
                disabled={running}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-400 disabled:opacity-50"
                title={currentExecutionAvailability?.ready === false ? currentExecutionAvailability.reason : "Run code (Ctrl+Enter)"}
              >
                {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Run
              </button>
            )}
            {isExecutable && currentExecutionAvailability && (
              <span
                className={clsx(
                  "hidden rounded-full border px-2 py-1 text-[10px] font-semibold lg:inline-flex",
                  currentExecutionAvailability.ready
                    ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200"
                    : "border-amber-300/20 bg-amber-300/10 text-amber-200",
                )}
                title={currentExecutionAvailability.ready ? "Execution runtime ready" : currentExecutionAvailability.reason}
              >
                {currentExecutionAvailability.ready ? "Ready" : "Execution unavailable"}
              </span>
            )}
            {state.language === "json" && (
              <>
                <button
                  onClick={validateJson}
                  className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10"
                  title="Validate JSON"
                >
                  <FileJson className="h-3.5 w-3.5" />
                  Validate
                </button>
                <button
                  onClick={formatJson}
                  className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10"
                  title="Format JSON"
                >
                  <FileJson className="h-3.5 w-3.5" />
                  Format
                </button>
              </>
            )}
            <button
              onClick={insertStarterTemplate}
              className="hidden rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10 lg:inline-flex"
              title="Insert or replace with the selected language starter template"
            >
              Starter
            </button>
            <button
              onClick={() => void copyCode()}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-200"
              title="Copy code"
            >
              {copiedCode ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={downloadCode}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-200"
              title="Download code"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-200"
              title="Editor settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="hidden items-center gap-1.5 sm:flex">
            <button
              onClick={() => void copyValue(room.code, "code")}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-white/25"
            >
              {copiedCode ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="hidden lg:inline">Code</span>
            </button>
            <button
              onClick={() => void copyValue(inviteLink, "link")}
              className="flex items-center gap-1.5 rounded-lg border border-teal-300/30 bg-teal-300/10 px-3 py-1.5 text-xs font-semibold text-teal-100 transition hover:bg-teal-300/15"
            >
              {copiedLink ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
              <span className="hidden lg:inline">{copiedLink ? "Copied" : "Share"}</span>
            </button>
            <button
              onClick={() => void leaveRoom()}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-slate-400 transition hover:border-rose-400/40 hover:text-rose-300"
              aria-label="Leave room"
              title="Leave room"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      {membersOpen && (
        <div className="absolute right-4 top-14 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-[#10141f] shadow-2xl shadow-black/50">
          <div className="border-b border-white/[0.06] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Users className="h-4 w-4 text-teal-200" />
                Members
              </div>
              <span className="text-[11px] font-medium text-slate-500">
                {displayedMembers.length || state.users.length} collaborators
              </span>
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto p-2">
            {displayedMembers.map((member) => {
              const isSelfMember = member.user.id === selfUserId;
              const canKick = isOwner && member.role !== "owner" && !isSelfMember;
              return (
                <div
                  key={member.user.id}
                  className="relative flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/[0.04]"
                >
                  <span
                    className={clsx(
                      "h-2 w-2 shrink-0 rounded-full",
                      member.online ? "bg-emerald-400" : "bg-slate-600",
                    )}
                  />
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                    style={{
                      backgroundColor: `${member.user.color}24`,
                      color: member.user.color,
                      boxShadow: `0 0 0 1px ${member.user.color}66`,
                    }}
                  >
                    {member.user.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-100">
                        {member.user.name}
                      </span>
                      {isSelfMember && (
                        <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">
                          you
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                      <span>{member.online ? "Online" : "Away"}</span>
                      {member.role === "owner" && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/25 bg-amber-300/10 px-1.5 py-0.5 font-semibold text-amber-200">
                          <Crown className="h-2.5 w-2.5" />
                          Owner
                        </span>
                      )}
                    </div>
                  </div>
                  {canKick && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() =>
                          setMemberMenuUserId((open) => open === member.user.id ? null : member.user.id)
                        }
                        className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                        aria-label={`Manage ${member.user.name}`}
                      >
                        <MoreVertical className="h-3.5 w-3.5" />
                      </button>
                      {memberMenuUserId === member.user.id && (
                        <div className="absolute right-0 top-full z-50 mt-1 w-32 rounded-lg border border-white/10 bg-[#111722] p-1 shadow-2xl shadow-black/40">
                          <button
                            type="button"
                            onClick={() => void kickMember(member)}
                            disabled={kickingUserId === member.user.id}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-rose-200 hover:bg-rose-400/10 disabled:opacity-60"
                          >
                            {kickingUserId === member.user.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <UserMinus className="h-3.5 w-3.5" />
                            )}
                            Kick
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="border-t border-white/[0.06] p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">Room</div>
            <div className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.03] px-3 py-2">
              <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-300">
                {roomLocked ? <Lock className="h-3.5 w-3.5 text-rose-300" /> : <Unlock className="h-3.5 w-3.5 text-emerald-300" />}
                {roomLocked ? "Locked" : "Open to joins"}
              </span>
              {isOwner && (
                <button
                  type="button"
                  onClick={() => void toggleRoomLock()}
                  disabled={lockUpdating}
                  className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/10 hover:text-slate-100 disabled:opacity-60"
                >
                  {lockUpdating ? "Updating…" : roomLocked ? "Unlock room" : "Lock room"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <nav className="shrink-0 border-b border-white/[0.06] bg-[#0a0d13] px-3 py-2">
        <div className="flex overflow-x-auto">
          <div className="inline-flex rounded-xl border border-white/10 bg-[#11151f] p-0.5">
            {[
              { id: "edit", label: "Editor", disabled: false, kind: "view" },
              { id: "split", label: "Split", disabled: !hasCompanionPane, kind: "view" },
              { id: "preview", label: "Preview", disabled: !hasPreview, kind: "view" },
              { id: "output", label: "Output", disabled: false, kind: "panel" },
              { id: "problems", label: "Problems", disabled: false, kind: "panel" },
              { id: "input", label: "Input", disabled: false, kind: "panel" },
            ].map(({ id, label, disabled, kind }) => {
              const active =
                kind === "view"
                  ? viewMode === id
                  : bottomTab === id && panelSurfaceVisible;
              return (
                <button
                  key={id}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (kind === "view") setManualViewMode(id as ViewMode);
                    else openPanelSurface(id as BottomTab);
                  }}
                  className={clsx(
                    "min-w-0 shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 sm:px-3",
                    active
                      ? "bg-teal-300/15 text-teal-100 shadow-[0_0_16px_rgba(45,212,191,0.08)]"
                      : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-200",
                  )}
                >
                  <span>{label}</span>
                  {id === "problems" && problemsCount > 0 && (
                    <span className={clsx(
                      "ml-1.5 rounded px-1 text-[10px]",
                      errorsCount > 0 ? "bg-rose-400/20 text-rose-200" : "bg-white/10 text-slate-300",
                    )}>
                      {problemsCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {state.accessRevokedMessage && (
        <div className="shrink-0 border-b border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            <span className="font-semibold">{state.accessRevokedMessage}</span>
            <button
              type="button"
              onClick={exitRoom}
              className="ml-auto rounded-lg border border-rose-200/20 px-3 py-1 text-xs font-semibold hover:bg-rose-200/10"
            >
              Back home
            </button>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="border-b border-white/[0.06] bg-[#0f131d] px-4 py-3">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-2">
              <span className="text-slate-400">Font size</span>
              <input type="range" min="12" max="24" value={fontSize} onChange={(e) => setFontSize(parseInt(e.target.value))} className="w-20" />
              <span className="text-slate-300">{fontSize}px</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-slate-400">Word wrap</span>
              <select value={wordWrap} onChange={(e) => setWordWrap(e.target.value as any)} className="rounded border border-white/10 bg-[#11151f] px-2 py-1">
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={minimap} onChange={(e) => setMinimap(e.target.checked)} />
              <span className="text-slate-400">Minimap</span>
            </label>
          </div>
        </div>
      )}

      {/* Workspace */}
      <main className="flex min-h-0 flex-1 flex-col">
        <div
          className={clsx(
            "flex min-h-0 flex-1",
            viewMode === "split" && hasCompanionPane
              ? "flex-col lg:flex-row"
              : "flex-col",
          )}
        >
          {(viewMode !== "preview" || !hasCompanionPane) && (
            <div
              className={clsx(
                "min-h-0 min-w-0",
                viewMode === "split" && hasCompanionPane
                  ? "h-1/2 lg:h-full lg:w-1/2"
                  : "h-full w-full flex-1",
              )}
            >
              {state.accessRevokedMessage ? (
                <div className="flex h-full items-center justify-center bg-[#0b0e14] p-6 text-center">
                  <div className="max-w-md rounded-2xl border border-rose-400/25 bg-rose-400/10 p-6 text-rose-100">
                    <ShieldAlert className="mx-auto mb-3 h-8 w-8" />
                    <h2 className="text-lg font-bold">Room access removed</h2>
                    <p className="mt-2 text-sm text-rose-100/80">
                      {state.accessRevokedMessage}
                    </p>
                    <button
                      type="button"
                      onClick={exitRoom}
                      className="mt-5 rounded-lg bg-rose-300 px-4 py-2 text-sm font-semibold text-[#2a0d12] hover:bg-rose-200"
                    >
                      Back home
                    </button>
                  </div>
                </div>
              ) : connected || state.revision > 0 ? (
                <CollaborativeMonaco
                  language={state.language}
                  users={state.users}
                  selfSessionId={state.selfSessionId}
                  selfUserId={selfUserId}
                  setBridge={setBridge}
                  submitLocalOps={submitLocalOps}
                  publishPresence={publishPresence}
                  onMirror={handleMirror}
                  fontSize={fontSize}
                  wordWrap={wordWrap}
                  minimap={minimap}
                  onEditorMount={(editor, monaco) => {
                    editorRef.current = editor;
                    monacoRef.current = monaco;
                  }}
                />
              ) : (
                <div className="flex h-full items-center justify-center bg-[#0b0e14]">
                  <div className="flex items-center gap-3 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin text-teal-400" />
                    {state.connection === "error" ? "Could not connect — check membership, then refresh." : "Joining room…"}
                  </div>
                </div>
              )}
            </div>
          )}
          {hasCompanionPane && viewMode !== "edit" && (
            <div
              className={clsx(
                "min-h-0 min-w-0 border-white/[0.06] bg-[#0a0d13]",
                viewMode === "split"
                  ? "h-1/2 border-t lg:h-full lg:w-1/2 lg:border-l lg:border-t-0"
                  : "h-full w-full flex-1",
              )}
            >
              {renderCompanionPane()}
            </div>
          )}
        </div>

        {/* Bottom panels */}
        {bottomOpen && (
          <div className="flex h-64 shrink-0 flex-col border-t border-white/[0.06] bg-[#0a0d13]">
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2 text-xs font-semibold text-slate-400">
              <TerminalIcon className="h-3.5 w-3.5 text-cyan-200" />
              <span>{bottomTab === "output" ? "Output" : bottomTab === "problems" ? "Problems" : "Input"}</span>
              {bottomTab === "problems" && problemsCount > 0 && (
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-300">
                  {problemsCount}
                </span>
              )}
              <button
                onClick={() => setBottomOpen(false)}
                className="ml-auto rounded px-2 py-1 text-slate-500 hover:bg-white/10 hover:text-slate-300"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {renderResultPanel()}
            </div>
          </div>
        )}
      </main>

      {/* Status bar */}
      <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-white/[0.06] bg-[#0b0e14] px-4 text-[11px] text-slate-500">
        <span className={clsx("flex items-center gap-1.5 font-medium", dirty ? "text-amber-300/90" : "text-emerald-300/90")}>
          {dirty ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {dirty ? "Syncing…" : "Saved"}
        </span>
        <span className="flex items-center gap-1.5">
          <HardDrive className="h-3 w-3" />
          rev {state.revision}
        </span>
        <span className="hidden items-center gap-1.5 sm:flex">
          <Database className="h-3 w-3" />
          cache: {state.cacheMode === "redis" ? "Redis" : state.cacheMode === "memory" ? "in-memory" : "—"}
        </span>
        {typingStatus && (
          <span className="hidden items-center gap-1.5 rounded-full border border-teal-300/15 bg-teal-300/10 px-2 py-0.5 font-medium text-teal-100 md:flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300" />
            {typingStatus}
          </span>
        )}
        {!bottomOpen && (
          <button onClick={() => setBottomOpen(true)} className="flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-slate-400 hover:bg-white/20 hover:text-slate-200">
            <TerminalIcon className="h-3 w-3" />
            {isExecutable ? "Run" : "Output"} {problemsCount > 0 && `(${problemsCount})`}
          </button>
        )}
        <span className="ml-auto hidden md:block">
          room <span className="font-mono text-slate-400">{room.code}</span> · <span className="text-slate-400">{profile.name}</span>
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
