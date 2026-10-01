import { NextRequest, NextResponse } from "next/server";
import { requireRoomAccess } from "@/lib/roomAccess";
import { getAuthenticatedSessionFromRequest } from "@/lib/session";
import {
  executeCode,
  MAX_CODE_SIZE,
  MAX_STDIN_SIZE,
} from "@/lib/execution/executor";
import {
  EXECUTABLE_LANGUAGES,
  isExecutionLanguage,
  type ExecutionStreamEvent,
} from "@/lib/execution/types";
import { startExecutionSession } from "@/lib/execution/interactiveSessions";
import { isLanguageId } from "@/lib/validation";
import { SlidingWindowLimiter } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const executionLimiter = new SlidingWindowLimiter(20, 60 * 1000);

type RouteContext = { params: Promise<{ code: string }> };

function wantsStreaming(request: NextRequest): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/event-stream") || accept.includes("application/x-ndjson");
}

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

function validateExecutionPayload(
  body: { language?: unknown; code?: unknown; stdin?: unknown } | null,
  fallbackLanguage: string,
) {
  if (!body || typeof body.code !== "string") {
    return { error: "Code is required.", status: 400 as const };
  }

  const language = typeof body.language === "string" ? body.language : fallbackLanguage;
  const sourceCode = body.code;
  const stdin = typeof body.stdin === "string" ? body.stdin : undefined;

  if (!isLanguageId(language)) {
    return { error: "Invalid language.", status: 400 as const };
  }

  if (sourceCode.length > MAX_CODE_SIZE) {
    return { error: "Code too large (max 100KB).", status: 400 as const };
  }

  if (stdin && stdin.length > MAX_STDIN_SIZE) {
    return { error: "Stdin too large (max 10KB).", status: 400 as const };
  }

  if (!isExecutionLanguage(language)) {
    return {
      error: `Language ${language} is not executable. Supported: ${EXECUTABLE_LANGUAGES.join(", ")}`,
      status: 400 as const,
      supported: EXECUTABLE_LANGUAGES,
    };
  }

  return { language, sourceCode, stdin };
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const { code } = await ctx.params;

  const auth = await getAuthenticatedSessionFromRequest(request);
  if (!auth.session) {
    return jsonError("Session expired.", 401);
  }

  if (!executionLimiter.hit(auth.session.user.id)) {
    return jsonError("Too many execution requests. Try again later.", 429);
  }

  const access = await requireRoomAccess(code, request);
  if (!access.ok) {
    return jsonError(access.error, access.status);
  }

  const body = (await request.json().catch(() => null)) as {
    language?: unknown;
    code?: unknown;
    stdin?: unknown;
  } | null;

  const payload = validateExecutionPayload(body, access.document.language);
  if ("error" in payload) {
    return jsonError(
      payload.error ?? "Invalid execution request.",
      payload.status ?? 400,
      "supported" in payload ? { supported: payload.supported } : {},
    );
  }

  if (!wantsStreaming(request)) {
    try {
      const result = await executeCode(
        payload.language,
        payload.sourceCode,
        payload.stdin,
        request.signal,
      );
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

  const encoder = new TextEncoder();
  let sessionStop: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };

      const send = (event: ExecutionStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`${JSON.stringify(event)}\n`),
          );
        } catch {
          closed = true;
        }
      };

      const session = startExecutionSession({
        roomCode: access.code,
        userId: access.session.user.id,
        sessionId: access.session.sessionId,
        language: payload.language,
        code: payload.sourceCode,
        signal: request.signal,
        onEvent: send,
      });

      if ("error" in session) {
        send({ type: "error", message: session.error });
        close();
        return;
      }

      sessionStop = session.stop;

      const onAbort = () => {
        session.stop();
      };

      request.signal.addEventListener("abort", onAbort, { once: true });

      void session.done.finally(() => {
        request.signal.removeEventListener("abort", onAbort);
        close();
      });
    },
    cancel() {
      closed = true;
      sessionStop?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
