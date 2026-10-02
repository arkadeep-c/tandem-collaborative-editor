import { NextResponse } from "next/server";
import { ConfigurationError } from "@/lib/deployment";

export function jsonRouteError(error: unknown, context: string) {
  if (error instanceof ConfigurationError) {
    console.error(`[${context}] configuration error: ${error.message}`);
    return NextResponse.json(
      { error: "Server configuration error.", detail: error.message },
      { status: 500 },
    );
  }

  console.error(`[${context}] unhandled error`, error);
  return NextResponse.json(
    { error: "Internal server error." },
    { status: 500 },
  );
}

export function withJsonErrors<Args extends unknown[]>(
  context: string,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return jsonRouteError(error, context);
    }
  };
}
