import { describe, expect, it, vi } from "vitest";
import { getExecutionAvailability } from "@/lib/execution/executor";
import { writeExecutionStdin } from "@/lib/execution/interactiveSessions";
import type { ExecutionResult, ExecutionStreamEvent } from "@/lib/execution/types";

const routeSession = {
  sessionId: "route-session-crlf",
  user: { id: "route-user-crlf", name: "Route User" },
};

vi.mock("@/lib/session", () => ({
  getAuthenticatedSessionFromRequest: vi.fn(async () => ({ session: routeSession })),
}));

vi.mock("@/lib/roomAccess", () => ({
  requireRoomAccess: vi.fn(async () => ({
    ok: true,
    code: "BASHCR",
    session: routeSession,
    document: { language: "bash" },
  })),
}));

function multilineBashCrlfSource(): string {
  return [
    "",
    "#!/usr/bin/env bash",
    "",
    "",
    "set -u",
    "",
    "greet() {",
    "  local target=\"$1\"",
    "  echo \"Hello, $target\"",
    "}",
    "",
    "echo \"Hello\"",
    "",
    "printf \"Enter name: \"",
    "read -r NAME",
    "",
    "for i in 1 2 3; do",
    "    echo \"Item $i\"",
    "done",
    "",
    "greet \"$NAME\"",
    "",
    "",
  ].join("\r\n");
}

async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
) {
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timed out reading execution stream")), timeoutMs);
    }),
  ]);
}

describe("room execute route", () => {
  it("normalizes Bash CRLF source from the editor-style streaming request before interactive execution", async () => {
    const availability = await getExecutionAvailability();
    if (!availability.languages.bash.ready) {
      expect(availability.languages.bash.reason).toBeTruthy();
      return;
    }

    const source = multilineBashCrlfSource();
    expect(source).toContain("\r\n\r\n");
    expect(source).toContain("read -r NAME\r\n");
    expect(source).toContain("for i in 1 2 3; do\r\n");

    const { POST } = await import("@/app/api/rooms/[code]/execute/route");
    const response = await POST(
      new Request("http://localhost/api/rooms/BASHCR/execute", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ language: "bash", code: source }),
      }) as never,
      { params: Promise.resolve({ code: "BASHCR" }) },
    );

    expect(response.ok).toBe(true);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let executionId: string | null = null;
    let sentInput = false;
    let result: ExecutionResult | null = null;

    while (!result) {
      const { value, done } = await readNextChunk(reader, 15_000);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ExecutionStreamEvent;

        if (event.type === "start") {
          executionId = event.executionId;
        }

        if (
          event.type === "stdout" &&
          event.chunk.includes("Enter name:") &&
          executionId &&
          !sentInput
        ) {
          sentInput = true;
          expect(
            writeExecutionStdin(
              executionId,
              {
                roomCode: "BASHCR",
                userId: routeSession.user.id,
                sessionId: routeSession.sessionId,
              },
              "Ada\n",
            ),
          ).toBe(true);
        }

        if (event.type === "result") {
          result = event.result;
        }
      }
    }

    expect(sentInput).toBe(true);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("success");
    expect(result?.stdout).toContain("Hello");
    expect(result?.stdout).toContain("Item 1");
    expect(result?.stdout).toContain("Item 2");
    expect(result?.stdout).toContain("Item 3");
    expect(result?.stdout).toContain("Hello, Ada");
    expect(result?.stderr).not.toMatch(/\$'\\r'|command not found|not a valid identifier|unexpected token|invalid option/);
  }, 25_000);
});
