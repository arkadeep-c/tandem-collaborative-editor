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
      className="fixed inset-0 z-[90] flex items-center justify-center bg-[#07090f]/80 p-4 backdrop-blur-md"
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
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#10141f] p-7 shadow-2xl shadow-black/60 outline-none ring-1 ring-white/[0.03]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className={clsx(
            "mb-4 flex h-11 w-11 items-center justify-center rounded-xl",
            tone === "destructive"
              ? "bg-rose-500/15 text-rose-300 ring-1 ring-rose-300/20"
              : "bg-teal-500/15 text-teal-300 ring-1 ring-teal-300/20",
          )}
          aria-hidden
        >
          {icon ?? fallbackIcon}
        </div>
        <h2 id={titleId} className="text-lg font-semibold text-slate-100">
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
          className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/20 disabled:opacity-60"
        />
        {validationMessage && (
          <p className="mt-2 text-xs font-medium text-rose-200">{validationMessage}</p>
        )}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="flex-1 rounded-lg border border-white/10 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={disabled}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-teal-500 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400 active:scale-[0.98] disabled:opacity-60"
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
          className="flex-1 rounded-lg border border-white/10 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className={clsx(
            "flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-60",
            tone === "destructive"
              ? "bg-rose-500 hover:bg-rose-400"
              : "bg-teal-500 hover:bg-teal-400",
          )}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
