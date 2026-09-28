import { NextResponse } from "next/server";
import { getExecutionAvailability } from "@/lib/execution/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reports sandbox/runtime readiness without exposing secrets or host paths. */
export async function GET() {
  const availability = await getExecutionAvailability();
  return NextResponse.json(availability);
}
