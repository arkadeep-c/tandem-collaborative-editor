"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Loader2,
  Square,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import clsx from "clsx";
import type {
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionStreamStatus,
} from "@/lib/execution/types";

type TerminalEvent = Extract<
  ExecutionStreamEvent,
  | { type: "stdout" }
  | { type: "stderr" }
  | { type: "stdin" }
  | { type: "error" }
>;

interface OutputPanelProps {
  result: ExecutionResult | null;
  running: boolean;
  streamEvents?: ExecutionStreamEvent[];
  streamStatus?: ExecutionStreamStatus;
  onClear: () => void;
  onStop?: () => void;
  onSendInput?: (input: string) => void | Promise<void>;
}

function isTerminalEvent(event: ExecutionStreamEvent): event is TerminalEvent {
  return (
    event.type === "stdout" ||
    event.type === "stderr" ||
    event.type === "stdin" ||
    event.type === "error"
  );
}

function resultStatusLabel(result: ExecutionResult | null): string {
  if (!result) return "Output";
  switch (result.status) {
    case "success":
      return "Finished";
    case "cancelled":
      return "Stopped";
    case "compile_error":
      return "Compilation Error";
    case "runtime_error":
      return "Runtime Error";
    case "timeout":
      return "Timeout";
    case "output_limit":
      return "Output Limit";
    case "memory_limit":
      return "Memory Limit";
    case "execution_error":
      return "Execution Error";
    case "unavailable":
      return "Unavailable";
    default:
      return result.status;
  }
}

function runningStatusLabel(status: ExecutionStreamStatus | undefined, idle: boolean): string {
  if (status === "starting") return "Starting";
  if (status === "compiling") return "Compiling";
  if (idle) return "Waiting for input";
  return "Running";
}

export default function OutputPanel({
  result,
  running,
  streamEvents = [],
  streamStatus,
  onClear,
  onStop,
  onSendInput,
}: OutputPanelProps) {
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const terminalEvents = useMemo(() => {
    const events = streamEvents.filter(isTerminalEvent);

    if (events.length > 0 || running || !result) return events;

    const fallback: TerminalEvent[] = [];
    if (result.stdout) fallback.push({ type: "stdout", chunk: result.stdout });
    if (result.stderr) fallback.push({ type: "stderr", chunk: result.stderr });
    return fallback;
  }, [result, running, streamEvents]);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, [terminalEvents.length, result?.status]);

  useEffect(() => {
    if (running && streamStatus === "running") inputRef.current?.focus();
  }, [running, streamStatus]);

  const copyOutput = async () => {
    const text = terminalEvents
      .map((event) => {
        if (event.type === "stdout") return event.chunk;
        if (event.type === "stderr") return event.chunk;
        if (event.type === "stdin") return event.chunk;
        if (event.type === "error") return `[error] ${event.message}`;
        return "";
      })
      .join("");

    const summary = result
      ? `\n\nExit: ${result.exitCode} Duration: ${result.duration}ms Status: ${result.status}`
      : "";

    try {
      await navigator.clipboard.writeText(`${text}${summary}`.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const submitInput = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!running || !onSendInput) return;

    const value = inputRef.current?.value ?? input;
    setInput("");
    await onSendInput(`${value}\n`);
  };

  const isError = result
    ? ["compile_error", "runtime_error", "timeout", "execution_error", "memory_limit", "unavailable", "output_limit"].includes(result.status)
    : false;
  const isCancelled = result?.status === "cancelled";
  const isSuccess = result?.status === "success";
  const idle =
    running &&
    streamStatus === "running" &&
    terminalEvents.some((event) =>
      event.type === "stdout" || event.type === "stderr" || event.type === "stdin",
    );
  const statusLabel = running
    ? runningStatusLabel(streamStatus, idle)
    : resultStatusLabel(result);

  return (
    <div className="flex h-full flex-col bg-[#070d18]">
      <div className="flex items-center justify-between border-b border-white/[0.08] bg-white/[0.018] px-4 py-2 shadow-sm">
        <span className="flex min-w-0 items-center gap-2 text-xs font-semibold">
          {running && streamStatus === "compiling" && <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300" />}
          {running && streamStatus !== "compiling" && (
            <span className={clsx("h-2 w-2 rounded-full shadow-[0_0_14px_currentColor]", idle ? "animate-pulse bg-amber-300 text-amber-300" : "animate-pulse bg-cyan-300 text-cyan-300")} />
          )}
          {!running && isSuccess && <Check className="h-3.5 w-3.5 text-emerald-400" />}
          {!running && isError && <XCircle className="h-3.5 w-3.5 text-rose-400" />}
          {!running && isCancelled && <Square className="h-3.5 w-3.5 text-amber-300" />}
          {!running && !isSuccess && !isError && !isCancelled && <Terminal className="h-3.5 w-3.5 text-slate-400" />}
          <span
            className={clsx(
              "truncate",
              running
                ? idle
                  ? "text-amber-200"
                  : "text-cyan-200"
                : isSuccess
                  ? "text-emerald-300"
                  : isError
                    ? "text-rose-300"
                    : isCancelled
                      ? "text-amber-300"
                      : "text-slate-300",
            )}
          >
            {statusLabel}
          </span>
          {result && (
            <span className="ml-2 flex items-center gap-1 text-[10px] text-slate-500">
              <Clock className="h-3 w-3" />
              {result.duration}ms
              {result.exitCode !== null && ` · exit ${result.exitCode}`}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          {running && onStop && (
            <button
              onClick={onStop}
              className="mr-1 flex items-center gap-1.5 rounded-lg border border-rose-300/25 bg-rose-300/10 px-2 py-1 text-[11px] font-bold text-rose-100 transition hover:bg-rose-300/20"
              title="Stop execution"
            >
              <Square className="h-3 w-3 fill-current" />
              Stop
            </button>
          )}
          <button
            onClick={() => void copyOutput()}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/10 hover:text-slate-200"
            title="Copy output"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
          <button
            onClick={onClear}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/10 hover:text-slate-200"
            title="Clear output"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto bg-[radial-gradient(circle_at_12%_0%,rgba(34,211,238,0.055),transparent_22rem)] px-4 py-3 font-mono text-xs"
        onClick={() => {
          if (running) inputRef.current?.focus();
        }}
      >
        {terminalEvents.length === 0 && !running && (
          <div className="flex h-full items-center justify-center text-center">
            <div>
              <p className="text-sm text-slate-500">No output yet</p>
              <p className="mt-1 text-xs text-slate-600">Run your code to open the execution console</p>
            </div>
          </div>
        )}

        {terminalEvents.length === 0 && running && (
          <div className="mb-2 flex items-center gap-2 text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-300" />
            Starting sandbox...
          </div>
        )}

        <div className="whitespace-pre-wrap break-words leading-relaxed">
          {terminalEvents.map((event, index) => {
            if (event.type === "error") {
              return (
                <span key={index} className="text-rose-300">
                  {event.message}
                </span>
              );
            }

            if (event.type === "stdin") {
              return (
                <span key={index} className="text-cyan-200">
                  {event.chunk}
                </span>
              );
            }

            return (
              <span
                key={index}
                className={event.type === "stderr" ? "text-rose-200" : "text-slate-200"}
              >
                {event.chunk}
              </span>
            );
          })}

          {running && onSendInput && streamStatus === "running" && (
            <form onSubmit={(event) => void submitInput(event)} className="inline">
              <input
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                className="inline min-w-[6ch] max-w-full bg-transparent font-mono text-xs text-cyan-100 caret-cyan-300 outline-none placeholder:text-slate-600 focus:drop-shadow-[0_0_10px_rgba(103,232,249,0.22)]"
                placeholder={terminalEvents.length === 0 ? "stdin" : ""}
                autoComplete="off"
                spellCheck={false}
                aria-label="Program stdin"
              />
              <button type="submit" className="sr-only">
                Send input
              </button>
            </form>
          )}
        </div>

        {result?.timedOut && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-300/15 bg-amber-300/10 px-3 py-2 text-amber-100">
            <AlertTriangle className="h-4 w-4" />
            <span>Execution timed out after 10 minutes. Sandbox cleaned up.</span>
          </div>
        )}
        {result?.outputTruncated && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-300/15 bg-amber-300/10 px-3 py-2 text-amber-100">
            <AlertTriangle className="h-4 w-4" />
            <span>Output truncated: exceeded 1MB limit</span>
          </div>
        )}
      </div>
    </div>
  );
}
