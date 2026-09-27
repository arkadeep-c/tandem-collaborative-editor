import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Tandem — Real-time Collaborative Code & Markdown Editor",
  description:
    "Create a room, share a code, and write code together: operation-transformed sync, remote carets, presence, secure anonymous sessions, and debounced PostgreSQL persistence.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${jetbrains.variable}`}>
      <body className="bg-[#07090f] font-sans text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
