import { NextResponse } from "next/server";
import { getExecutionAvailability } from "@/lib/execution/executor";
import { withJsonErrors } from "@/lib/apiErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reports sandbox/runtime readiness without exposing secrets or host paths. */
async function GETHandler() {
  const availability = await getExecutionAvailability();
  return NextResponse.json(availability);
}

export const GET = withJsonErrors("api.execution.get", GETHandler);
