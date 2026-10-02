import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import ToastContainer from "@/components/ui/Toast";

export const metadata: Metadata = {
  title: "Tandem — Real-time Collaborative Code & Markdown Editor",
  description:
    "Create a room, share a code, and write code together: operation-transformed sync, remote carets, presence, secure anonymous sessions, and debounced PostgreSQL persistence.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#050814] font-sans text-slate-200 antialiased">
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
