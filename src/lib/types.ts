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

export interface LanguageOption {
  id: string;
  label: string;
  accent: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { id: "typescript", label: "TypeScript", accent: "#3178c6" },
  { id: "javascript", label: "JavaScript", accent: "#f7df1e" },
  { id: "python", label: "Python", accent: "#3776ab" },
  { id: "c", label: "C", accent: "#5c99c9" },
  { id: "cpp", label: "C++", accent: "#00599c" },
  { id: "java", label: "Java", accent: "#ed8b00" },
  { id: "markdown", label: "Markdown", accent: "#a78bfa" },
  { id: "json", label: "JSON", accent: "#6ee7b7" },
  { id: "go", label: "Go", accent: "#00add8" },
  { id: "rust", label: "Rust", accent: "#f97316" },
  { id: "sql", label: "SQL", accent: "#e38c00" },
  { id: "html", label: "HTML", accent: "#e34c26" },
  { id: "css", label: "CSS", accent: "#264de4" },
  { id: "yaml", label: "YAML", accent: "#cb171e" },
];

export function languageAccent(language: string): string {
  return LANGUAGE_OPTIONS.find((l) => l.id === language)?.accent ?? "#8b5cf6";
}

/**
 * Monaco language ids. Monaco tokenizes C through its `cpp` basic-language
 * (the cpp registration officially owns `.c`/`.h` files — there is no
 * separate 'c' tokenizer), so 'c' documents deliberately use it.
 */
export function monacoLanguageFor(language: string): string {
  if (language === "c") return "cpp";
  return language;
}

export const LANGUAGE_STARTERS: Record<string, string> = {
  typescript: `// Shared TypeScript buffer.\n\nexport function main(): void {\n  console.log("hello from the room");\n}\n\nmain();\n`,
  javascript: `// Shared JavaScript buffer.\n\nfunction main() {\n  console.log("hello from the room");\n}\n\nmain();\n`,
  python: `# Shared Python buffer.\n\ndef main():\n    print("hello from the room")\n\n\nif __name__ == "__main__":\n    main()\n`,
  c: `// Shared C buffer.\n\n#include <stdio.h>\n\nint main(void) {\n    printf("hello from the room\\n");\n    return 0;\n}\n`,
  cpp: `// Shared C++ buffer.\n\n#include <iostream>\n\nint main() {\n    std::cout << "hello from the room" << std::endl;\n    return 0;\n}\n`,
  java: `// Shared Java buffer.\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("hello from the room");\n    }\n}\n`,
  markdown: `# Untitled\n\nStart writing — everyone in this room sees every keystroke.\n`,
  json: `{\n  "name": "untitled",\n  "collaborative": true\n}\n`,
  go: `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello from the room")\n}\n`,
  rust: `fn main() {\n    println!("hello from the room");\n}\n`,
  sql: `-- Shared SQL buffer.\n\nSELECT 'hello from the room' AS greeting;\n`,
  html: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Shared buffer</title>\n  </head>\n  <body></body>\n</html>\n`,
  css: `/* Shared CSS buffer. */\n\n:root {\n  color-scheme: dark;\n}\n`,
  yaml: `# Shared YAML buffer.\n\ncollaborative: true\n`,
};
