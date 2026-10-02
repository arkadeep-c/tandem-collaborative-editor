"use client";

import { useEffect, useRef } from "react";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "[role='button']",
  "[data-cursor='interactive']",
  "[data-cursor='magnetic']",
].join(",");

export default function CustomCursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const followerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const finePointer = window.matchMedia("(pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!finePointer.matches || reducedMotion.matches) return;

    let frame = 0;
    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let followerX = targetX;
    let followerY = targetY;

    const setInteractive = (active: boolean) => {
      dotRef.current?.dataset && (dotRef.current.dataset.active = String(active));
      followerRef.current?.dataset && (followerRef.current.dataset.active = String(active));
    };

    const update = () => {
      followerX += (targetX - followerX) * 0.14;
      followerY += (targetY - followerY) * 0.14;
      followerRef.current?.style.setProperty("--cursor-x", `${followerX}px`);
      followerRef.current?.style.setProperty("--cursor-y", `${followerY}px`);
      frame = window.requestAnimationFrame(update);
    };

    const handlePointerMove = (event: PointerEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
      dotRef.current?.style.setProperty("--cursor-x", `${targetX}px`);
      dotRef.current?.style.setProperty("--cursor-y", `${targetY}px`);
      setInteractive(Boolean((event.target as Element | null)?.closest?.(INTERACTIVE_SELECTOR)));
    };

    const handlePointerLeave = () => {
      dotRef.current?.dataset && (dotRef.current.dataset.visible = "false");
      followerRef.current?.dataset && (followerRef.current.dataset.visible = "false");
    };

    const handlePointerEnter = () => {
      dotRef.current?.dataset && (dotRef.current.dataset.visible = "true");
      followerRef.current?.dataset && (followerRef.current.dataset.visible = "true");
    };

    document.documentElement.classList.add("has-custom-cursor");
    document.addEventListener("pointermove", handlePointerMove, { passive: true });
    document.addEventListener("pointerleave", handlePointerLeave);
    document.addEventListener("pointerenter", handlePointerEnter);
    frame = window.requestAnimationFrame(update);

    return () => {
      document.documentElement.classList.remove("has-custom-cursor");
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerleave", handlePointerLeave);
      document.removeEventListener("pointerenter", handlePointerEnter);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <div ref={followerRef} className="tandem-cursor-follower" aria-hidden data-visible="true" />
      <div ref={dotRef} className="tandem-cursor-dot" aria-hidden data-visible="true" />
    </>
  );
}
