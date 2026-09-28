"use client";

import { useCallback, useEffect, useRef } from "react";
import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import type { editor as monacoEditor, IRange } from "monaco-editor";
import type { EditorBridge, PresencePatch } from "@/lib/useCollaborativeDocument";
import { monacoLanguageFor, type PresenceState, type TextOp } from "@/lib/types";

/**
 * MonacoEditor — the collaborative surface.
 *
 *  - local edits → op batches (descending offset order → sequential semantics)
 *  - remote ops  → painted via model.pushEditOperations (echo-suppressed)
 *  - remote caret/selection → decoration collection + per-user CSS (caret
 *    beam, name flag, translucent selection fill)
 */

// Pin the CDN build so the runtime editor and our compile-time types match.
loader.config({
  paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" },
});

type IStandaloneCodeEditor = monacoEditor.IStandaloneCodeEditor;

interface MonacoEditorProps {
  language: string;
  users: PresenceState[];
  selfSessionId: string;
  selfUserId?: string;
  setBridge: (bridge: EditorBridge | null) => void;
  submitLocalOps: (ops: TextOp[]) => void;
  publishPresence: (patch: PresencePatch) => void;
  /** Debounced/trailing full-content mirror (drives the markdown preview). */
  onMirror?: (content: string) => void;
  fontSize?: number;
  wordWrap?: "on" | "off";
  minimap?: boolean;
  onEditorMount?: (editor: IStandaloneCodeEditor, monaco: any) => void;
}

const PRESENCE_THROTTLE_MS = 90;
const TYPING_WINDOW_MS = 1_400;

function cssSafe(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

export default function MonacoEditor({
  language,
  users,
  selfSessionId,
  selfUserId,
  setBridge,
  submitLocalOps,
  publishPresence,
  onMirror,
  fontSize = 14,
  wordWrap,
  minimap = true,
  onEditorMount,
}: MonacoEditorProps) {
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const applyingRemoteRef = useRef(false);
  const decorationsRef = useRef<monacoEditor.IEditorDecorationsCollection | null>(
    null,
  );
  const styleTagRef = useRef<HTMLStyleElement | null>(null);
  const lastEditAtRef = useRef(0);
  const presenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Keep latest callbacks in refs so Monaco listeners never re-subscribe. */
  const submitLocalOpsRef = useRef(submitLocalOps);
  const publishPresenceRef = useRef(publishPresence);
  const onMirrorRef = useRef(onMirror);

  useEffect(() => {
    submitLocalOpsRef.current = submitLocalOps;
    publishPresenceRef.current = publishPresence;
    onMirrorRef.current = onMirror;
  }, [submitLocalOps, publishPresence, onMirror]);

  useEffect(() => {
    return () => {
      if (presenceTimeoutRef.current) clearTimeout(presenceTimeoutRef.current);
      if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current);
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Theme                                                             */
  /* ---------------------------------------------------------------- */

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    monaco.editor.defineTheme("tandem-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "5b6478", fontStyle: "italic" },
        { token: "keyword", foreground: "c792ea" },
        { token: "string", foreground: "9ece8f" },
        { token: "number", foreground: "f78c6c" },
        { token: "type", foreground: "6cb6ff" },
        { token: "identifier", foreground: "d6deeb" },
      ],
      colors: {
        "editor.background": "#0b0e14",
        "editor.foreground": "#d6deeb",
        "editor.lineHighlightBackground": "#ffffff06",
        "editor.lineHighlightBorder": "#00000000",
        "editorLineNumber.foreground": "#39415a",
        "editorLineNumber.activeForeground": "#8b93b0",
        "editorCursor.foreground": "#b9c4ff",
        "editor.selectionBackground": "#3d59a133",
        "editor.inactiveSelectionBackground": "#3d59a120",
        "editorIndentGuide.background1": "#1a2030",
        "editorIndentGuide.activeBackground1": "#2a3350",
        "editorWidget.background": "#10141f",
        "editorWidget.border": "#232a3d",
        "minimap.background": "#0b0e14",
        "scrollbar.shadow": "#00000000",
      },
    });
  }, []);

  /* ---------------------------------------------------------------- */
  /* Outgoing: local edits → ops; cursor → presence                   */
  /* ---------------------------------------------------------------- */

  const schedulePresencePush = useCallback(() => {
    if (presenceTimeoutRef.current) return;
    presenceTimeoutRef.current = setTimeout(() => {
      presenceTimeoutRef.current = null;
      const ed = editorRef.current;
      const model = ed?.getModel();
      if (!ed || !model) return;
      const selection = ed.getSelection();
      if (!selection) return;

      const position = selection.getPosition();
      const isEmpty = selection.isEmpty();
      publishPresenceRef.current({
        cursor: {
          line: position.lineNumber,
          column: position.column,
          offset: model.getOffsetAt(position),
        },
        selection: isEmpty
          ? null
          : {
              startLine: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLine: selection.endLineNumber,
              endColumn: selection.endColumn,
            },
        typing: Date.now() - lastEditAtRef.current < TYPING_WINDOW_MS,
      });
    }, PRESENCE_THROTTLE_MS);
  }, []);

  const scheduleTypingStop = useCallback(() => {
    if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current);
    typingStopTimeoutRef.current = setTimeout(() => {
      typingStopTimeoutRef.current = null;
      lastEditAtRef.current = 0;
      schedulePresencePush();
    }, TYPING_WINDOW_MS + PRESENCE_THROTTLE_MS);
  }, [schedulePresencePush]);

  const handleMount: OnMount = useCallback(
    (ed, monaco) => {
      editorRef.current = ed;
      decorationsRef.current = ed.createDecorationsCollection([]);
      onEditorMount?.(ed, monaco);

      ed.onDidChangeModelContent((event) => {
        if (applyingRemoteRef.current) return;
        const changes = [...event.changes].sort(
          (a, b) => b.rangeOffset - a.rangeOffset,
        );
        const ops: TextOp[] = [];
        for (const change of changes) {
          if (change.rangeLength > 0) {
            ops.push({
              type: "delete",
              offset: change.rangeOffset,
              length: change.rangeLength,
            });
          }
          if (change.text.length > 0) {
            ops.push({
              type: "insert",
              offset: change.rangeOffset,
              text: change.text,
            });
          }
        }
        if (ops.length > 0) {
          lastEditAtRef.current = Date.now();
          submitLocalOpsRef.current(ops);
          schedulePresencePush();
          scheduleTypingStop();
        }
      });

      ed.onDidChangeCursorSelection(() => schedulePresencePush());
      // Mirror every change (local, remote, reset) for live preview panes.
      ed.onDidChangeModelContent(() => {
        onMirrorRef.current?.(ed.getModel()?.getValue() ?? "");
      });
      // Keyboard shortcuts that should stay inside the editor/workspace.
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        window.dispatchEvent(new CustomEvent("tandem-run-code"));
      });
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        window.dispatchEvent(new CustomEvent("tandem-save-request"));
      });
      ed.focus();
    },
    [schedulePresencePush, scheduleTypingStop, onEditorMount],
  );

  /* ---------------------------------------------------------------- */
  /* Bridge: hook → editor (remote ops, resets)                       */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const bridge: EditorBridge = {
      applyRemote(ops) {
        const ed = editorRef.current;
        const model = ed?.getModel();
        if (!ed || !model) return;
        applyingRemoteRef.current = true;
        try {
          for (const op of ops) {
            if (op.type === "insert") {
              const clamped = Math.min(op.offset, model.getValueLength());
              const at = model.getPositionAt(clamped);
              const range: IRange = {
                startLineNumber: at.lineNumber,
                startColumn: at.column,
                endLineNumber: at.lineNumber,
                endColumn: at.column,
              };
              model.pushEditOperations(
                [],
                [{ range, text: op.text, forceMoveMarkers: true }],
                () => null,
              );
            } else {
              const safeOffset = Math.min(op.offset, model.getValueLength());
              const safeLength = Math.min(
                op.length,
                model.getValueLength() - safeOffset,
              );
              if (safeLength <= 0) continue;
              const from = model.getPositionAt(safeOffset);
              const to = model.getPositionAt(safeOffset + safeLength);
              const range: IRange = {
                startLineNumber: from.lineNumber,
                startColumn: from.column,
                endLineNumber: to.lineNumber,
                endColumn: to.column,
              };
              model.pushEditOperations(
                [],
                [{ range, text: "", forceMoveMarkers: true }],
                () => null,
              );
            }
          }
        } finally {
          applyingRemoteRef.current = false;
        }
      },
      reset(content) {
        const model = editorRef.current?.getModel();
        if (!model || model.getValue() === content) return;
        applyingRemoteRef.current = true;
        try {
          editorRef.current?.pushUndoStop();
          model.setValue(content);
        } finally {
          applyingRemoteRef.current = false;
        }
      },
    };
    setBridge(bridge);
    return () => setBridge(null);
  }, [setBridge]);

  /* ---------------------------------------------------------------- */
  /* Remote decorations + dynamic per-user CSS                        */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!styleTagRef.current) {
      const tag = document.createElement("style");
      tag.dataset.tandem = "remote-cursors";
      document.head.appendChild(tag);
      styleTagRef.current = tag;
    }
    return () => {
      styleTagRef.current?.remove();
      styleTagRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const tag = styleTagRef.current;
    if (!ed || !model || !tag || !decorationsRef.current) return;

    const peersBySession = new Map<string, PresenceState>();
    for (const presence of users) {
      if (!presence.sessionId || presence.sessionId === selfSessionId) continue;
      if (selfUserId && presence.user.id === selfUserId) continue;
      if (!presence.cursor) continue;
      peersBySession.set(presence.sessionId, presence);
    }
    const peers = [...peersBySession.values()].sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId),
    );

    const decorations: monacoEditor.IModelDeltaDecoration[] = [];
    const css: string[] = [];
    const maxOffset = model.getValueLength();

    for (const peer of peers) {
      const id = cssSafe(peer.sessionId);
      const color = peer.user.color;
      const name = peer.user.name.slice(0, 24);

      // Caret beam + name flag.
      const clamped = Math.min(peer.cursor!.offset, maxOffset);
      const at = model.getPositionAt(clamped);
      decorations.push({
        range: {
          startLineNumber: at.lineNumber,
          startColumn: at.column,
          endLineNumber: at.lineNumber,
          endColumn: at.column,
        },
        options: {
          beforeContentClassName: `tandem-caret tandem-caret--${id}`,
          hoverMessage: { value: `${name} is here` },
          stickiness: 1, // NeverGrowsWhenTypingAtEdges
        },
      });

      // Selection fill.
      if (peer.selection) {
        const { startLine, startColumn, endLine, endColumn } = peer.selection;
        const collapsed =
          startLine === endLine && startColumn === endColumn;
        if (!collapsed) {
          decorations.push({
            range: {
              startLineNumber: startLine,
              startColumn: startColumn,
              endLineNumber: endLine,
              endColumn: endColumn,
            },
            options: {
              className: `tandem-select--${id}`,
              stickiness: 1,
            },
          });
          css.push(`.tandem-select--${id}{background:${color}2e;border-radius:1px;}`);
        }
      }

      css.push(
        `.tandem-caret--${id}{border-left:2px solid ${color};margin-left:-1px;height:100%;box-sizing:border-box;position:relative;pointer-events:none;}`,
        `.tandem-caret--${id}::before{content:${JSON.stringify(name)};position:absolute;top:-1.5em;left:-2px;background:${color};color:#0b0e14;font-family:var(--font-jetbrains),ui-monospace,monospace;font-size:10px;font-weight:700;line-height:1.5;padding:0 6px;border-radius:4px 4px 4px 1px;white-space:nowrap;box-shadow:0 2px 10px #0008;z-index:30;}`,
      );
    }

    decorationsRef.current.set(decorations);
    tag.textContent = css.join("\n");
  }, [users, selfSessionId, selfUserId]);

  /* ---------------------------------------------------------------- */
  /* Language switching (room-wide meta event)                        */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;
    const monaco = (window as unknown as { monaco?: typeof import("monaco-editor") })
      .monaco;
    if (monaco) {
      monaco.editor.setModelLanguage(model, monacoLanguageFor(language));
    }
    ed.updateOptions({ 
      wordWrap: wordWrap ?? (language === "markdown" ? "on" : "off"),
      fontSize,
      minimap: { enabled: minimap },
    });
  }, [language, wordWrap, fontSize, minimap]);

  return (
    <Editor
      height="100%"
      language={monacoLanguageFor(language)}
      theme="tandem-dark"
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      loading={
        <div className="flex h-full items-center justify-center bg-[#0b0e14]">
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span className="h-2 w-2 animate-ping rounded-full bg-teal-400" />
            Loading Monaco…
          </div>
        </div>
      }
      options={{
        automaticLayout: true,
        fontFamily: "var(--font-jetbrains), ui-monospace, SFMono-Regular, monospace",
        fontSize,
        fontLigatures: true,
        lineHeight: 1.65,
        padding: { top: 18, bottom: 18 },
        smoothScrolling: true,
        cursorSmoothCaretAnimation: "on",
        cursorBlinking: "smooth",
        minimap: { enabled: minimap, scale: 1, showSlider: "mouseover" },
        scrollBeyondLastLine: false,
        renderLineHighlight: "all",
        bracketPairColorization: { enabled: true },
        wordWrap: wordWrap ?? (language === "markdown" ? "on" : "off"),
        tabSize: 2,
        insertSpaces: true,
        contextmenu: true,
        readOnly: false,
        domReadOnly: false,
        fixedOverflowWidgets: true,
      }}
    />
  );
}
