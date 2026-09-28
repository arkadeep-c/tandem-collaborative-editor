/**
 * Shared collaboration protocol contract.
 *
 * One wire format used by the realtime gateway (server) and the React
 * client. Identity fields (`you`, `user`) are ALWAYS server-verified;
 * a client only ever supplies edit ops, presence geometry, and cosmetic
 * profile preferences.
 */

/* ------------------------------------------------------------------ */
/* Text operations (OT-lite)                                           */
/* ------------------------------------------------------------------ */

export type TextOp =
  | { type: "insert"; offset: number; text: string }
  | { type: "delete"; offset: number; length: number };

export interface OperationBatch {
  /** Server-issued connection id (from the init snapshot). Verified
   *  server-side: the connection must exist and belong to the caller. */
  connectionId: string;
  /** Document revision the client computed these ops against. */
  baseRevision: number;
  ops: TextOp[];
}

/* ------------------------------------------------------------------ */
/* Identity & presence                                                 */
/* ------------------------------------------------------------------ */

export type RoomRole = "owner" | "editor";

export interface ClientUser {
  id: string;
  name: string;
  color: string;
}

export interface CursorPosition {
  line: number;
  column: number;
  offset: number;
}

export interface SelectionRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface PresenceState {
  /** Server-generated id of one live connection (not a user id). */
  sessionId: string;
  user: ClientUser;
  cursor: CursorPosition | null;
  selection: SelectionRange | null;
  typing: boolean;
  joinedAt: number;
  lastActiveAt: number;
}

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

export interface RoomInfo {
  code: string;
  title: string;
  language: string;
  memberCount: number;
  activeUsers: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoomSummary extends RoomInfo {
  role: RoomRole;
}

/* ------------------------------------------------------------------ */
/* Server → client events                                              */
/* ------------------------------------------------------------------ */

export type ServerEvent =
  | {
      type: "init";
      room: { code: string; title: string; language: string };
      you: { user: ClientUser; role: RoomRole };
      content: string;
      revision: number;
      sessionId: string;
      users: PresenceState[];
      cacheMode: "redis" | "memory";
    }
  | {
      type: "op";
      revision: number;
      ops: TextOp[];
      by: string; // connection id of the author
    }
  | { type: "presence"; user: PresenceState }
  | { type: "leave"; sessionId: string; userId: string }
  | { type: "meta"; title?: string; language?: string }
  | { type: "saved"; revision: number; savedAt: string; mode: "redis" | "memory" }
  | { type: "error"; message: string };

/* ------------------------------------------------------------------ */
/* HTTP responses                                                      */
/* ------------------------------------------------------------------ */

export interface OperationAck {
  ok: true;
  revision: number;
}

export interface OperationStale {
  ok: false;
  code: "STALE_REVISION";
  revision: number;
  content: string;
}

export interface ApiError {
  error: string;
}

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

export type { LanguageId, LanguageOption } from "@/lib/languageConfig";
export {
  LANGUAGE_DEFINITIONS,
  LANGUAGE_DEFINITION_BY_ID,
  LANGUAGE_IDS,
  LANGUAGE_OPTIONS,
  LANGUAGE_STARTERS,
  EXECUTABLE_LANGUAGE_IDS,
  fileExtensionFor,
  getLanguageDefinition,
  isExecutableLanguage,
  isKnownLanguageId,
  languageAccent,
  languageLabel,
  monacoLanguageFor,
} from "@/lib/languageConfig";
