import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// Local/system font fallback — avoids Google Fonts network fetch that breaks
// `next build` in offline / sandboxed environments (Arena preview).
// Original design used Space Grotesk + JetBrains Mono; we keep the same
// aesthetic via system font stacks defined in globals.css.

export const metadata: Metadata = {
  title: "Tandem — Real-time Collaborative Code & Markdown Editor",
  description:
    "Create a room, share a code, and write code together: operation-transformed sync, remote carets, presence, secure anonymous sessions, and debounced PostgreSQL persistence.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#07090f] font-sans text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
