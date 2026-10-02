"use client";

import { useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";

interface TiltCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  maxTilt?: number;
}

function canUseTiltMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function TiltCard({ children, className, maxTilt = 4, onMouseMove, onMouseLeave, style, ...props }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState("perspective(900px) rotateX(0deg) rotateY(0deg) translateY(0)");
  const [spot, setSpot] = useState({ x: 50, y: 50 });

  return (
    <div
      {...props}
      ref={ref}
      data-cursor="interactive"
      className={clsx("group/tilt relative overflow-hidden transition-transform duration-300 ease-out", className)}
      style={{
        ...style,
        transform,
        ["--spot-x" as string]: `${spot.x}%`,
        ["--spot-y" as string]: `${spot.y}%`,
      }}
      onMouseMove={(event) => {
        onMouseMove?.(event);
        if (!canUseTiltMotion()) return;
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        const px = (event.clientX - rect.left) / rect.width;
        const py = (event.clientY - rect.top) / rect.height;
        const rotateY = (px - 0.5) * maxTilt * 2;
        const rotateX = (0.5 - py) * maxTilt * 2;
        setSpot({ x: px * 100, y: py * 100 });
        setTransform(`perspective(900px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-3px)`);
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        setTransform("perspective(900px) rotateX(0deg) rotateY(0deg) translateY(0)");
        setSpot({ x: 50, y: 50 });
      }}
    >
      <div className="pointer-events-none absolute inset-0 opacity-0 transition duration-300 group-hover/tilt:opacity-100" style={{ background: "radial-gradient(circle at var(--spot-x) var(--spot-y), rgba(125, 211, 252, 0.16), transparent 34%)" }} />
      {children}
    </div>
  );
}
