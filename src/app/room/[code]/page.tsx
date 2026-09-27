import type { Metadata } from "next";
import Link from "next/link";
import EditorRoom from "@/components/editor/EditorRoom";
import JoinGate from "@/components/room/JoinGate";
import { normalizeRoomCode } from "@/lib/roomCode";
import { findRoomByCode, getMembership } from "@/lib/roomAccess";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ code: string }> };

/**
 * /room/[code] — the room entry gate.
 *
 * Server-side: resolve code → room record → session → membership.
 *   - unknown code          → clean not-found panel
 *   - valid room, no member → join confirmation gate (JoinGate)
 *   - member                → the collaborative editor, with the
 *                             server-verified identity passed down
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  return { title: `Room ${normalizeRoomCode(code) || code} — Tandem` };
}

export default async function RoomPage({ params }: PageProps) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(decodeURIComponent(rawCode));
  const found = code ? await findRoomByCode(code).catch(() => null) : null;

  if (!found) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#07090f] px-6 text-center">
        <p className="font-mono text-sm tracking-[0.3em] text-violet-300">
          {code || "??????"}
        </p>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-50">
          Room not found.
        </h1>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-slate-400">
          That code doesn&apos;t match any room. Check for typos, or ask the
          host to share the invite link again.
        </p>
        <div className="mt-8 flex gap-3">
          <Link
            href="/"
            className="rounded-lg bg-violet-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-400"
          >
            Back home
          </Link>
        </div>
      </div>
    );
  }

  const session = await getSessionUser();
  const member = session
    ? await getMembership(found.room.id, session.user.id)
    : null;

  if (!session || !member) {
    return (
      <JoinGate
        code={found.room.code}
        title={found.document.title}
        language={found.document.language}
      />
    );
  }

  return (
    <EditorRoom
      room={{
        code: found.room.code,
        title: found.document.title,
        language: found.document.language,
      }}
      you={{
        id: session.user.id,
        name: session.user.name,
        color: session.user.color,
      }}
      role={member.role === "owner" ? "owner" : "editor"}
    />
  );
}
