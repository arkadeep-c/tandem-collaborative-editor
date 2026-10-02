"use client";

import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";

interface MagneticButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  intensity?: number;
}

function canUseMagneticMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function MagneticButton({
  children,
  className,
  intensity = 0.18,
  onMouseMove,
  onMouseLeave,
  style,
  ...props
}: MagneticButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  return (
    <button
      {...props}
      ref={ref}
      data-cursor="magnetic"
      className={clsx("will-change-transform", className)}
      style={{
        ...style,
        transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
      }}
      onMouseMove={(event) => {
        onMouseMove?.(event);
        if (!canUseMagneticMotion() || props.disabled) return;
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        const x = (event.clientX - (rect.left + rect.width / 2)) * intensity;
        const y = (event.clientY - (rect.top + rect.height / 2)) * intensity;
        setOffset({ x: Math.max(-8, Math.min(8, x)), y: Math.max(-6, Math.min(6, y)) });
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        setOffset({ x: 0, y: 0 });
      }}
    >
      {children}
    </button>
  );
}
