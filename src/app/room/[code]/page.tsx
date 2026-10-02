import type { Metadata } from "next";
import { normalizeRoomCode } from "@/lib/roomCode";
import RoomClient from "@/components/room/RoomClient";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  return { title: `Room ${normalizeRoomCode(code) || code} — Tandem` };
}

export default async function RoomPage({ params }: PageProps) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(decodeURIComponent(rawCode));
  // Client component will handle auth via cookie OR bearer fallback (sessionStorage)
  // This ensures Arena preview works even when cookies are blocked
  return <RoomClient code={code} />;
}
