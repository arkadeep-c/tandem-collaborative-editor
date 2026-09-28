import { NextRequest, NextResponse } from "next/server";
import { requireRoomAccess } from "@/lib/roomAccess";
import { getAuthenticatedSessionFromRequest } from "@/lib/session";
import { executeCode } from "@/lib/execution/executor";
import { EXECUTABLE_LANGUAGES, isExecutionLanguage } from "@/lib/execution/types";
import { isLanguageId } from "@/lib/validation";
import { SlidingWindowLimiter } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const executionLimiter = new SlidingWindowLimiter(20, 60 * 1000);

type RouteContext = { params: Promise<{ code: string }> };

export async function POST(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;

  // Auth check
  const auth = await getAuthenticatedSessionFromRequest(request);
  if (!auth.session) {
    return NextResponse.json({ error: "Session expired." }, { status: 401 });
  }

  // Rate limiting
  if (!executionLimiter.hit(auth.session.user.id)) {
    return NextResponse.json({ error: "Too many execution requests. Try again later." }, { status: 429 });
  }

  // Room access check
  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = await request.json().catch(() => null) as {
    language?: unknown;
    code?: unknown;
    stdin?: unknown;
  } | null;

  if (!body || typeof body.code !== "string") {
    return NextResponse.json({ error: "Code is required." }, { status: 400 });
  }

  const language = typeof body.language === "string" ? body.language : access.document.language;
  const sourceCode = body.code as string;
  const stdin = typeof body.stdin === "string" ? body.stdin : undefined;

  // Validate language
  if (!isLanguageId(language)) {
    return NextResponse.json({ error: "Invalid language." }, { status: 400 });
  }

  // Validate sizes
  if (sourceCode.length > 100 * 1024) {
    return NextResponse.json({ error: "Code too large (max 100KB)." }, { status: 400 });
  }

  if (stdin && stdin.length > 10 * 1024) {
    return NextResponse.json({ error: "Stdin too large (max 10KB)." }, { status: 400 });
  }

  if (!isExecutionLanguage(language)) {
    return NextResponse.json({
      error: `Language ${language} is not executable. Supported: ${EXECUTABLE_LANGUAGES.join(", ")}`,
      supported: EXECUTABLE_LANGUAGES,
    }, { status: 400 });
  }

  try {
    const result = await executeCode(language, sourceCode, stdin, request.signal);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[execute] error", err);
    return NextResponse.json({
      status: "execution_error",
      stdout: "",
      stderr: "Execution failed safely. Please try again or contact the room owner if it persists.",
      exitCode: null,
      duration: 0,
      problems: [],
    }, { status: 500 });
  }
}
