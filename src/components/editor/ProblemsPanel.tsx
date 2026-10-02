"use client";

import { AlertTriangle, XCircle, Info, ArrowUpRight } from "lucide-react";
import clsx from "clsx";
import type { ExecutionProblem } from "@/lib/execution/types";

interface ProblemsPanelProps {
  problems: ExecutionProblem[];
  onJumpTo: (line: number, column?: number) => void;
}

export default function ProblemsPanel({ problems, onJumpTo }: ProblemsPanelProps) {
  const errors = problems.filter(p => p.severity === "error");
  const warnings = problems.filter(p => p.severity === "warning");

  if (problems.length === 0) {
    return (
      <div className="flex h-full flex-col bg-[#0a0d13]">
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2">
          <span className="text-xs font-semibold text-slate-400">Problems</span>
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-500">0</span>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div>
            <p className="text-sm text-slate-500">No problems</p>
            <p className="mt-1 text-xs text-slate-600">Errors will appear here with line numbers</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#0a0d13]">
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2">
        <span className="text-xs font-semibold text-slate-300">Problems</span>
        <span className="flex items-center gap-2">
          {errors.length > 0 && (
            <span className="flex items-center gap-1 rounded bg-rose-400/15 px-2 py-0.5 text-[10px] font-semibold text-rose-300">
              <XCircle className="h-3 w-3" />
              {errors.length} Error{errors.length !== 1 ? "s" : ""}
            </span>
          )}
          {warnings.length > 0 && (
            <span className="flex items-center gap-1 rounded bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
              <AlertTriangle className="h-3 w-3" />
              {warnings.length} Warning{warnings.length !== 1 ? "s" : ""}
            </span>
          )}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        {problems.map((problem, idx) => (
          <button
            key={idx}
            onClick={() => onJumpTo(problem.line, problem.column)}
            className="flex w-full items-start gap-3 border-b border-white/[0.03] px-4 py-2.5 text-left transition hover:bg-white/[0.04]"
          >
            <div className="mt-0.5">
              {problem.severity === "error" && <XCircle className="h-3.5 w-3.5 text-rose-400" />}
              {problem.severity === "warning" && <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
              {problem.severity === "info" && <Info className="h-3.5 w-3.5 text-slate-400" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-slate-400">
                  {problem.file}:{problem.line}{problem.column ? `:${problem.column}` : ""}
                </span>
                <ArrowUpRight className="h-3 w-3 text-slate-600" />
              </div>
              <div className="mt-1 text-xs leading-relaxed text-slate-200">{problem.message}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
