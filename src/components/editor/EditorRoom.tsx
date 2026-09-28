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
  Play,
  Square,
  Download,
  Settings,
  Trash2,
  FileJson,
  Bug,
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
  type RoomRole,
} from "@/lib/types";
import { apiFetch, ensureClientSession } from "@/lib/apiFetch";
import { isExecutionLanguage, type ExecutionAvailability, type ExecutionProblem, type ExecutionResult } from "@/lib/execution/types";

type ViewMode = "edit" | "split" | "preview";
type BottomTab = "output" | "problems" | "input";

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
  const [showSettings, setShowSettings] = useState(false);

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

  const isOwner = role === "owner";
  const profile = profileOverride ?? state.you ?? you;
  const titleShown = state.title || room.title;
  const isMarkdown = state.language === "markdown";
  const isHtml = state.language === "html";
  const isCss = state.language === "css";
  const hasPreview = isMarkdown || isHtml || isCss;
  const viewMode =
    (hasPreview ? manualViewMode : null) ?? (hasPreview ? "split" : "edit");

  const isExecutable = isExecutionLanguage(state.language);
  const currentExecutionAvailability = isExecutable
    ? executionAvailability?.languages[state.language as keyof ExecutionAvailability["languages"]]
    : null;
  const executionReady = !isExecutable || currentExecutionAvailability?.ready !== false;

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

  const runCode = useCallback(async () => {
    if (running) return;
    if (isExecutable && currentExecutionAvailability?.ready === false) {
      setBottomOpen(true);
      setBottomTab("output");
      setExecutionResult({
        status: "unavailable",
        stdout: "",
        stderr: currentExecutionAvailability.reason ?? "Code execution is unavailable because the required execution runtime is not configured.",
        exitCode: null,
        duration: 0,
        problems: [],
      });
      return;
    }
    const code = getCurrentContent();
    if (!code.trim()) return;

    setRunning(true);
    setBottomOpen(true);
    setBottomTab("output");
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
  }, [currentExecutionAvailability, getCurrentContent, isExecutable, running, room.code, setProblemMarkers, state.language, stdin]);

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
      setBottomOpen(true);
      setBottomTab("output");
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
      setBottomOpen(true);
      setBottomTab("problems");
      return false;
    }
  }, [getCurrentContent, makeJsonProblem, setProblemMarkers, state.language]);

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
      setBottomOpen(true);
      setBottomTab("problems");
    }
  }, [getCurrentContent, makeJsonProblem, setProblemMarkers, state.language]);

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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#07090f] text-slate-200">
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

        <span className="flex items-center gap-1.5 rounded-md border border-teal-400/30 bg-teal-400/10 px-2 py-1 font-mono text-[11px] font-bold tracking-[0.15em] text-teal-200">
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
          <PresenceBar users={state.users} selfSessionId={state.selfSessionId} onEditProfile={() => setEditingProfile(true)} />

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

          {hasPreview && (
            <div className="hidden items-center rounded-lg border border-white/10 bg-[#11151f] p-0.5 md:flex">
              {[
                { id: "edit", icon: Code2, label: "Editor" },
                { id: "split", icon: Columns2, label: "Split" },
                { id: "preview", icon: Eye, label: "Preview" },
              ].map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setManualViewMode(id as ViewMode)}
                  className={clsx("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition", viewMode === id ? "bg-teal-500/20 text-teal-200" : "text-slate-400 hover:text-slate-200")}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden lg:inline">{label}</span>
                </button>
              ))}
            </div>
          )}

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
              className="flex items-center gap-1.5 rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-teal-400"
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
        <div className="flex min-h-0 flex-1">
          {(viewMode !== "preview" || !hasPreview) && (
            <div className={clsx("min-w-0", hasPreview && viewMode === "split" ? "w-1/2" : "w-full")}>
              {connected || state.revision > 0 ? (
                <CollaborativeMonaco
                  language={state.language}
                  users={state.users}
                  selfSessionId={state.selfSessionId}
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
          {hasPreview && viewMode !== "edit" && (
            <div className={clsx("min-w-0 border-l border-white/[0.06] bg-[#0a0d13]", viewMode === "split" ? "w-1/2" : "w-full")}>
              {isMarkdown ? (
                <MarkdownPreview markdown={previewContent} />
              ) : (
                <SafePreview language={isHtml ? "html" : "css"} content={previewContent} />
              )}
            </div>
          )}
        </div>

        {/* Bottom panels */}
        {bottomOpen && (
          <div className="flex h-64 shrink-0 flex-col border-t border-white/[0.06] bg-[#0a0d13]">
            <div className="flex items-center gap-1 border-b border-white/[0.06] px-2">
              <button
                onClick={() => setBottomTab("output")}
                className={clsx("flex items-center gap-1.5 px-3 py-2 text-xs font-medium", bottomTab === "output" ? "border-b-2 border-teal-400 text-teal-200" : "text-slate-500 hover:text-slate-300")}
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                Output
              </button>
              <button
                onClick={() => setBottomTab("problems")}
                className={clsx("flex items-center gap-1.5 px-3 py-2 text-xs font-medium", bottomTab === "problems" ? "border-b-2 border-teal-400 text-teal-200" : "text-slate-500 hover:text-slate-300")}
              >
                <Bug className="h-3.5 w-3.5" />
                Problems {problemsCount > 0 && <span className={clsx("rounded px-1.5 text-[10px]", errorsCount > 0 ? "bg-rose-400/20 text-rose-300" : "bg-white/10 text-slate-400")}>{problemsCount}</span>}
              </button>
              <button
                onClick={() => setBottomTab("input")}
                className={clsx("flex items-center gap-1.5 px-3 py-2 text-xs font-medium", bottomTab === "input" ? "border-b-2 border-teal-400 text-teal-200" : "text-slate-500 hover:text-slate-300")}
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                Input
              </button>
              <div className="ml-auto flex items-center gap-1">
                <button onClick={() => setBottomOpen(false)} className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-slate-300">
                  <span className="text-xs">Close</span>
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {bottomTab === "output" && <OutputPanel result={executionResult} running={running} onClear={() => setExecutionResult(null)} />}
              {bottomTab === "problems" && <ProblemsPanel problems={executionResult?.problems || []} onJumpTo={jumpToError} />}
              {bottomTab === "input" && (
                <div className="flex h-full flex-col p-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Stdin (input for program)</div>
                  <textarea
                    value={stdin}
                    onChange={(e) => setStdin(e.target.value)}
                    placeholder="Enter input for your program, e.g.&#10;5&#10;10&#10;20"
                    className="flex-1 resize-none rounded border border-white/10 bg-[#0b0e14] p-3 font-mono text-xs text-slate-200 outline-none focus:border-teal-400/50"
                  />
                  <div className="mt-2 text-[10px] text-slate-600">Max 10KB, will be fed to program&apos;s stdin</div>
                </div>
              )}
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
