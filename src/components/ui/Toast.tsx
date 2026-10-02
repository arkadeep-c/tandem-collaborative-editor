"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, XCircle, Info } from "lucide-react";

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
  const reduceMotion = useReducedMotion();

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex max-w-[calc(100vw-2rem)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {current.map((toast) => (
          <motion.div
            key={toast.id}
            layout={!reduceMotion}
            initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="premium-panel pointer-events-auto flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm"
            role="status"
          >
            {toast.type === "success" && <Check className="h-4 w-4 text-emerald-300" />}
            {toast.type === "error" && <XCircle className="h-4 w-4 text-rose-300" />}
            {toast.type === "info" && <Info className="h-4 w-4 text-cyan-200" />}
            <span className="text-slate-100">{toast.message}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
