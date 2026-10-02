"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Info, Loader2, PencilLine } from "lucide-react";
import clsx from "clsx";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type FocusRef = { current: HTMLElement | null };
type DialogTone = "default" | "destructive";

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
  );
}

interface DialogShellProps {
  title: string;
  description?: string;
  tone?: DialogTone;
  icon?: ReactNode;
  busy?: boolean;
  onClose: () => void;
  initialFocusRef?: FocusRef;
  children: ReactNode;
}

function DialogShell({
  title,
  description,
  tone = "default",
  icon,
  busy = false,
  onClose,
  initialFocusRef,
  children,
}: DialogShellProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);

  useEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  }, [busy, onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;

    window.setTimeout(() => {
      const target = initialFocusRef?.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? panel;
      target?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      const currentPanel = panelRef.current;
      if (!currentPanel) return;

      if (event.key === "Escape") {
        if (!busyRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusable(currentPanel);
      if (focusable.length === 0) {
        event.preventDefault();
        currentPanel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !currentPanel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [initialFocusRef]);

  const fallbackIcon = tone === "destructive" ? (
    <AlertTriangle className="h-5 w-5" />
  ) : (
    <Info className="h-5 w-5" />
  );

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[#050814]/82 p-4 backdrop-blur-xl"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className="premium-panel premium-border w-full max-w-md rounded-3xl p-7 outline-none"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className={clsx(
            "mb-4 flex h-11 w-11 items-center justify-center rounded-2xl shadow-[0_0_28px_rgba(34,211,238,0.08)]",
            tone === "destructive"
              ? "bg-rose-400/15 text-rose-200 ring-1 ring-rose-300/20"
              : "bg-cyan-300/10 text-cyan-200 ring-1 ring-cyan-200/20",
          )}
          aria-hidden
        >
          {icon ?? fallbackIcon}
        </div>
        <h2 id={titleId} className="text-lg font-bold text-slate-50">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-slate-400">
            {description}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

interface InputDialogProps {
  title: string;
  description?: string;
  initialValue?: string;
  placeholder?: string;
  maxLength?: number;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  validate?: (value: string) => string | null;
  onClose: () => void;
  onConfirm: (value: string) => void | Promise<void>;
}

export function InputDialog({
  title,
  description,
  initialValue = "",
  placeholder,
  maxLength,
  confirmLabel = "Save",
  cancelLabel = "Cancel",
  busy = false,
  validate,
  onClose,
  onConfirm,
}: InputDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const trimmed = value.trim();
  const validationMessage = validate?.(trimmed) ?? (trimmed.length === 0 ? "Enter a value to continue." : null);
  const disabled = busy || Boolean(validationMessage);

  const submit = async () => {
    if (disabled || submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onConfirm(trimmed);
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <DialogShell
      title={title}
      description={description}
      busy={busy}
      onClose={onClose}
      initialFocusRef={inputRef}
      icon={<PencilLine className="h-5 w-5" />}
    >
      <form
        className="mt-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={busy}
          className="w-full rounded-xl border border-white/10 bg-[#070c16] px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20 disabled:opacity-60"
        />
        {validationMessage && (
          <p className="mt-2 text-xs font-medium text-rose-200">{validationMessage}</p>
        )}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="flex-1 rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.05] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={disabled}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-300 py-2.5 text-sm font-bold text-[#031018] transition hover:bg-cyan-200 active:scale-[0.98] disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

interface ConfirmationDialogProps {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmationDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  busy = false,
  onClose,
  onConfirm,
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);

  const submit = async () => {
    if (busy || submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onConfirm();
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <DialogShell
      title={title}
      description={description}
      tone={tone}
      busy={busy}
      onClose={onClose}
      initialFocusRef={cancelRef}
    >
      <div className="mt-6 flex gap-3">
        <button
          ref={cancelRef}
          type="button"
          disabled={busy}
          onClick={onClose}
          className="flex-1 rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.05] disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className={clsx(
            "flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition active:scale-[0.98] disabled:opacity-60",
            tone === "destructive"
              ? "bg-rose-400 text-[#2a0d12] hover:bg-rose-300"
              : "bg-cyan-300 text-[#031018] hover:bg-cyan-200",
          )}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
