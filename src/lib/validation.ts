/**
 * Dependency-free server-side input validation.
 * Pure functions — imported by API routes, the room engine, and unit tests.
 */

import { isKnownLanguageId, type LanguageId, type TextOp } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

export const MAX_TITLE_LENGTH = 120;
export const MAX_NAME_LENGTH = 40;
export const MAX_OPS_PER_BATCH = 64;
export const MAX_OP_TEXT_LENGTH = 100_000;
export const MAX_BATCH_TEXT_LENGTH = 250_000;
export const MAX_DOCUMENT_LENGTH = 1_000_000;

export const PRESENCE_COLORS = [
  "#f472b6",
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#a78bfa",
  "#fb7185",
  "#22d3ee",
  "#a3e635",
  "#f97316",
  "#e879f9",
] as const;

/* ------------------------------------------------------------------ */
/* Scalars                                                             */
/* ------------------------------------------------------------------ */

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

function cleanText(input: unknown, maxLength: number): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.replace(CONTROL_CHARS, "").trim();
  if (!cleaned || cleaned.length > maxLength) return null;
  return cleaned;
}

export function cleanTitle(input: unknown): string | null {
  return cleanText(input, MAX_TITLE_LENGTH);
}

export function cleanName(input: unknown): string | null {
  return cleanText(input, MAX_NAME_LENGTH);
}

export function isLanguageId(input: unknown): input is LanguageId {
  return isKnownLanguageId(input);
}

export function isPresenceColor(input: unknown): input is string {
  return (
    typeof input === "string" &&
    (PRESENCE_COLORS as readonly string[]).includes(input)
  );
}

/* ------------------------------------------------------------------ */
/* Operation batches                                                   */
/* ------------------------------------------------------------------ */

export type OpsValidation =
  | { ok: true; ops: TextOp[] }
  | { ok: false; reason: string };

/**
 * Structural validation of a client op batch. Offsets are additionally
 * bounds-checked against live document length at apply time (the room
 * engine drops any op that would escape the buffer).
 */
export function validateOps(input: unknown): OpsValidation {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, reason: "Operation batch is empty." };
  }
  if (input.length > MAX_OPS_PER_BATCH) {
    return { ok: false, reason: "Too many operations in one batch." };
  }

  let totalText = 0;
  const ops: TextOp[] = [];

  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, reason: "Malformed operation." };
    }
    const op = raw as Record<string, unknown>;

    if (op.type === "insert") {
      if (
        !Number.isInteger(op.offset) ||
        (op.offset as number) < 0 ||
        typeof op.text !== "string" ||
        op.text.length === 0 ||
        op.text.length > MAX_OP_TEXT_LENGTH
      ) {
        return { ok: false, reason: "Malformed insert operation." };
      }
      totalText += op.text.length;
      ops.push({ type: "insert", offset: op.offset as number, text: op.text });
    } else if (op.type === "delete") {
      if (
        !Number.isInteger(op.offset) ||
        (op.offset as number) < 0 ||
        !Number.isInteger(op.length) ||
        (op.length as number) <= 0 ||
        (op.length as number) > MAX_OP_TEXT_LENGTH
      ) {
        return { ok: false, reason: "Malformed delete operation." };
      }
      ops.push({
        type: "delete",
        offset: op.offset as number,
        length: op.length as number,
      });
    } else {
      return { ok: false, reason: "Unknown operation type." };
    }
  }

  if (totalText > MAX_BATCH_TEXT_LENGTH) {
    return { ok: false, reason: "Operation batch is too large." };
  }
  return { ok: true, ops };
}

/**
 * Bounds-check an op against the current buffer length. Called at apply
 * time inside the room engine (post-transform), so a malicious or buggy
 * client can never write outside the document.
 */
export function opWithinBounds(op: TextOp, contentLength: number): boolean {
  if (op.type === "insert") {
    return op.offset <= contentLength;
  }
  return op.offset + op.length <= contentLength;
}
