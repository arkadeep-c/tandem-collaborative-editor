import { NextResponse } from "next/server";
import { resolveDocStore } from "@/lib/collab/store";

export const dynamic = "force-dynamic";

/** Liveness + cache-backend report for the deployment platform. */
export async function GET() {
  const store = await resolveDocStore();
  return NextResponse.json({
    status: "ok",
    cache: store.mode,
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
}
