import { randomBytes } from "crypto";
import {
  MAX_STDIN_SIZE,
  startInteractiveExecution,
  type InteractiveExecutionHandle,
} from "./executor";
import type {
  ExecutionLanguage,
  ExecutionResult,
  ExecutionStreamEvent,
} from "./types";

const MAX_ACTIVE_EXECUTIONS = 128;

type ExecutionOwner = {
  roomCode: string;
  userId: string;
  sessionId: string;
};

export interface ExecutionSession extends ExecutionOwner {
  id: string;
  createdAt: number;
  done: Promise<ExecutionResult>;
  writeStdin(chunk: string): boolean;
  stop(): void;
}

interface StartExecutionSessionOptions extends ExecutionOwner {
  language: ExecutionLanguage;
  code: string;
  signal?: AbortSignal;
  onEvent?: (event: ExecutionStreamEvent) => void;
}

const sessions = new Map<string, ExecutionSession>();
const activeByOwner = new Map<string, string>();

function ownerKey(owner: ExecutionOwner): string {
  return `${owner.roomCode}:${owner.userId}:${owner.sessionId}`;
}

export function getActiveExecutionId(owner: ExecutionOwner): string | null {
  const executionId = activeByOwner.get(ownerKey(owner));
  return executionId && sessions.has(executionId) ? executionId : null;
}

export function getExecutionSession(
  executionId: string,
): ExecutionSession | null {
  return sessions.get(executionId) ?? null;
}

export function startExecutionSession(
  options: StartExecutionSessionOptions,
): ExecutionSession | { error: string; activeExecutionId?: string } {
  const key = ownerKey(options);
  const activeExecutionId = activeByOwner.get(key);

  if (activeExecutionId && sessions.has(activeExecutionId)) {
    return {
      error: "An execution is already running in this room.",
      activeExecutionId,
    };
  }

  if (sessions.size >= MAX_ACTIVE_EXECUTIONS) {
    return { error: "Execution service is busy. Try again shortly." };
  }

  const id = randomBytes(12).toString("hex");
  let stdinBytes = 0;

  options.onEvent?.({ type: "start", executionId: id });

  const handle: InteractiveExecutionHandle = startInteractiveExecution(
    options.language,
    options.code,
    {
      signal: options.signal,
      onEvent: options.onEvent,
    },
  );

  const session: ExecutionSession = {
    id,
    roomCode: options.roomCode,
    userId: options.userId,
    sessionId: options.sessionId,
    createdAt: Date.now(),
    done: handle.result,
    writeStdin(chunk: string) {
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (stdinBytes + bytes > MAX_STDIN_SIZE) return false;
      const written = handle.writeStdin(chunk);
      if (written) stdinBytes += bytes;
      return written;
    },
    stop() {
      handle.stop();
    },
  };

  sessions.set(id, session);
  activeByOwner.set(key, id);

  void session.done.finally(() => {
    sessions.delete(id);
    if (activeByOwner.get(key) === id) {
      activeByOwner.delete(key);
    }
  });

  return session;
}

export function writeExecutionStdin(
  executionId: string,
  owner: ExecutionOwner,
  chunk: string,
): boolean {
  const session = sessions.get(executionId);
  if (!session) return false;
  if (
    session.roomCode !== owner.roomCode ||
    session.userId !== owner.userId ||
    session.sessionId !== owner.sessionId
  ) {
    return false;
  }
  return session.writeStdin(chunk);
}

export function stopExecutionSession(
  executionId: string,
  owner: ExecutionOwner,
): boolean {
  const session = sessions.get(executionId);
  if (!session) return false;
  if (
    session.roomCode !== owner.roomCode ||
    session.userId !== owner.userId ||
    session.sessionId !== owner.sessionId
  ) {
    return false;
  }
  session.stop();
  return true;
}
