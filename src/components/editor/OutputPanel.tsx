"use client";

import { useState } from "react";
import { Check, Clock, Copy, Trash2, XCircle, AlertTriangle, Terminal, Square } from "lucide-react";
import clsx from "clsx";
import type { ExecutionResult } from "@/lib/execution/types";

interface OutputPanelProps {
  result: ExecutionResult | null;
  running: boolean;
  onClear: () => void;
  onStop?: () => void;
}

export default function OutputPanel({ result, running, onClear, onStop }: OutputPanelProps) {
  const [copied, setCopied] = useState(false);

  const copyOutput = async () => {
    if (!result) return;
    const text = `STDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n\nExit: ${result.exitCode} Duration: ${result.duration}ms`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  if (running) {
    return (
      <div className="flex h-full flex-col bg-[#0a0d13]">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
          <span className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            Running...
          </span>
          {onStop && (
            <button
              onClick={onStop}
              className="flex items-center gap-1.5 rounded border border-rose-300/20 bg-rose-400/10 px-2 py-1 text-[11px] font-semibold text-rose-200 transition hover:bg-rose-400/20"
              title="Stop execution"
            >
              <Square className="h-3 w-3 fill-current" />
              Stop
            </button>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-teal-400 border-t-transparent" />
            Executing code...
          </div>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex h-full flex-col bg-[#0a0d13]">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
          <span className="flex items-center gap-2 text-xs font-semibold text-slate-400">
            <Terminal className="h-3.5 w-3.5" />
            Output
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div>
            <p className="text-sm text-slate-500">No output yet</p>
            <p className="mt-1 text-xs text-slate-600">Run your code to see results here</p>
          </div>
        </div>
      </div>
    );
  }

  const isError = ["compile_error", "runtime_error", "timeout", "execution_error", "memory_limit", "unavailable"].includes(result.status);
  const isCancelled = result.status === "cancelled";
  const isSuccess = result.status === "success";

  return (
    <div className="flex h-full flex-col bg-[#0a0d13]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
        <span className="flex items-center gap-2 text-xs font-semibold">
          {isSuccess && <Check className="h-3.5 w-3.5 text-emerald-400" />}
          {isError && <XCircle className="h-3.5 w-3.5 text-rose-400" />}
          {isCancelled && <Square className="h-3.5 w-3.5 text-amber-300" />}
          {!isSuccess && !isError && !isCancelled && <Terminal className="h-3.5 w-3.5 text-slate-400" />}
          <span className={clsx(isSuccess ? "text-emerald-300" : isError ? "text-rose-300" : isCancelled ? "text-amber-300" : "text-slate-300")}>
            {result.status === "success" && "✓ Finished"}
            {result.status === "cancelled" && "■ Stopped"}
            {result.status === "compile_error" && "❌ Compilation Error"}
            {result.status === "runtime_error" && "❌ Runtime Error"}
            {result.status === "timeout" && "⏱ Timeout"}
            {result.status === "output_limit" && "⚠ Output Limit"}
            {result.status === "memory_limit" && "⚠ Memory Limit"}
            {result.status === "execution_error" && "❌ Execution Error"}
            {result.status === "unavailable" && "⚠ Unavailable"}
          </span>
          <span className="ml-2 flex items-center gap-1 text-[10px] text-slate-500">
            <Clock className="h-3 w-3" />
            {result.duration}ms
            {result.exitCode !== null && ` · exit ${result.exitCode}`}
          </span>
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void copyOutput()}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-white/10 hover:text-slate-300"
            title="Copy output"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
          <button
            onClick={onClear}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-white/10 hover:text-slate-300"
            title="Clear output"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 font-mono text-xs">
        {result.stdout && (
          <div className="mb-4">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">stdout</div>
            <pre className="whitespace-pre-wrap break-words rounded bg-white/[0.03] p-3 text-slate-200">{result.stdout}</pre>
          </div>
        )}
        {result.stderr && (
          <div className="mb-4">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-rose-400/70">stderr</div>
            <pre className="whitespace-pre-wrap break-words rounded bg-rose-400/10 p-3 text-rose-200">{result.stderr}</pre>
          </div>
        )}
        {!result.stdout && !result.stderr && (
          <div className="text-slate-500">No output</div>
        )}
        {result.timedOut && (
          <div className="mt-3 flex items-center gap-2 rounded bg-amber-400/10 px-3 py-2 text-amber-200">
            <AlertTriangle className="h-4 w-4" />
            <span>Execution timed out after 10 seconds. Host unaffected.</span>
          </div>
        )}
        {result.outputTruncated && (
          <div className="mt-3 flex items-center gap-2 rounded bg-amber-400/10 px-3 py-2 text-amber-200">
            <AlertTriangle className="h-4 w-4" />
            <span>Output truncated: exceeded 1MB limit</span>
          </div>
        )}
      </div>
    </div>
  );
}
