import { NextResponse } from "next/server";
import { jsonRouteError } from "@/lib/apiErrors";
import { resolveDocStore } from "@/lib/collab/store";
import { publicConfigSummary } from "@/lib/deployment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + cache-backend report for the deployment platform. */
export async function GET() {
  try {
    const store = await resolveDocStore();
    return NextResponse.json({
      status: "ok",
      cache: store.mode,
      config: publicConfigSummary(),
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return jsonRouteError(err, "health:get");
  }
}
