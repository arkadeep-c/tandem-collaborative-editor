"use client";

import { useEffect, useMemo, useRef } from "react";
import clsx from "clsx";

interface AmbientBackgroundProps {
  variant?: "home" | "editor" | "footer";
  className?: string;
}

export default function AmbientBackground({ variant = "home", className }: AmbientBackgroundProps) {
  const ref = useRef<HTMLDivElement>(null);
  const nodes = useMemo(
    () => [
      { left: "12%", top: "18%", delay: "-1s" },
      { left: "28%", top: "42%", delay: "-6s" },
      { left: "46%", top: "20%", delay: "-3s" },
      { left: "62%", top: "58%", delay: "-8s" },
      { left: "78%", top: "30%", delay: "-4s" },
      { left: "88%", top: "72%", delay: "-10s" },
    ],
    [],
  );

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const finePointer = window.matchMedia("(pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!finePointer.matches || reducedMotion.matches) return;

    const handlePointerMove = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
      const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
      element.style.setProperty("--ambient-x", `${x}%`);
      element.style.setProperty("--ambient-y", `${y}%`);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, []);

  return (
    <div
      ref={ref}
      className={clsx(
        "pointer-events-none absolute inset-0 overflow-hidden",
        variant === "editor" && "opacity-50",
        className,
      )}
      aria-hidden
    >
      <div className="living-grid absolute inset-0" />
      <div className="ambient-spotlight absolute inset-0" />
      <div className="aurora absolute -top-44 left-1/2 h-[520px] w-[760px] -translate-x-1/2 rounded-full bg-cyan-500/16" />
      <div className="aurora absolute -left-36 top-1/4 h-[420px] w-[420px] rounded-full bg-violet-500/10 [animation-delay:-7s]" />
      <div className="aurora absolute bottom-0 right-0 h-[360px] w-[520px] rounded-full bg-teal-500/10 [animation-delay:-12s]" />
      <div className="data-trail data-trail-a" />
      <div className="data-trail data-trail-b" />
      {variant === "home" && (
        <div className="absolute inset-0 hidden md:block">
          <svg className="absolute inset-0 h-full w-full opacity-30" role="presentation">
            <line x1="12%" y1="18%" x2="46%" y2="20%" className="network-line" />
            <line x1="28%" y1="42%" x2="62%" y2="58%" className="network-line" />
            <line x1="46%" y1="20%" x2="78%" y2="30%" className="network-line" />
            <line x1="62%" y1="58%" x2="88%" y2="72%" className="network-line" />
          </svg>
          {nodes.map((node, index) => (
            <span
              key={`${node.left}-${node.top}`}
              className="network-node absolute h-1.5 w-1.5 rounded-full bg-cyan-200/70 shadow-[0_0_16px_rgba(125,211,252,0.45)]"
              style={{ left: node.left, top: node.top, animationDelay: node.delay }}
            >
              <span className="absolute inset-[-7px] rounded-full border border-cyan-200/10" />
              <span className="sr-only">network node {index + 1}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
