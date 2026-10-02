"use client";

import { type ReactNode } from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";

interface ScrollRevealProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  stagger?: number;
}

const container: Variants = {
  hidden: { opacity: 0, y: 28, scale: 0.985 },
  visible: (custom: { delay: number; stagger: number }) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.62,
      delay: custom.delay,
      ease: [0.22, 1, 0.36, 1],
      staggerChildren: custom.stagger,
    },
  }),
};

export const revealChild: Variants = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.48, ease: [0.22, 1, 0.36, 1] } },
};

export default function ScrollReveal({ children, className, delay = 0, stagger = 0.07 }: ScrollRevealProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className={className}
      variants={reduceMotion ? undefined : container}
      custom={{ delay, stagger }}
      initial={reduceMotion ? false : "hidden"}
      whileInView={reduceMotion ? undefined : "visible"}
      viewport={{ once: true, margin: "-80px" }}
    >
      {children}
    </motion.div>
  );
}
