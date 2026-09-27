"use client";

import { useEffect, useState } from "react";
import { Check, XCircle, Info, X } from "lucide-react";

export type ToastType = "success" | "error" | "info";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

let toastListeners: ((toasts: Toast[]) => void)[] = [];
let toasts: Toast[] = [];

function notify() {
  toastListeners.forEach((l) => l([...toasts]));
}

export function showToast(message: string, type: ToastType = "success") {
  const id = Math.random().toString(36).slice(2);
  toasts.push({ id, message, type });
  notify();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, 3000);
}

export function useToasts() {
  const [current, setCurrent] = useState<Toast[]>([]);
  useEffect(() => {
    const listener = (t: Toast[]) => setCurrent(t);
    toastListeners.push(listener);
    return () => {
      toastListeners = toastListeners.filter((l) => l !== listener);
    };
  }, []);
  return current;
}

export default function ToastContainer() {
  const current = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {current.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-center gap-2 rounded-lg border border-white/10 bg-[#10141f] px-4 py-2.5 text-sm shadow-2xl"
        >
          {toast.type === "success" && <Check className="h-4 w-4 text-emerald-400" />}
          {toast.type === "error" && <XCircle className="h-4 w-4 text-rose-400" />}
          {toast.type === "info" && <Info className="h-4 w-4 text-slate-400" />}
          <span className="text-slate-200">{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
