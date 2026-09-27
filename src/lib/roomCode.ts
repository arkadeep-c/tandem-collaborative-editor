/**
 * Human-friendly room codes: 6 characters from an unambiguous alphabet
 * (no 0/O, no 1/I/L).
 *
 * This module is shared client/server (pure — no Node APIs). Generation
 * is server-only and lives in `roomCode.server.ts`.
 */

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_REGEX = /^[A-HJ-KM-NP-Z2-9]{6}$/;

/** Normalize user input: trim, drop separators, uppercase. */
export function normalizeRoomCode(input: string): string {
  return input
    .trim()
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, ROOM_CODE_LENGTH + 2); // let validation reject overlong codes honestly
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_REGEX.test(code);
}
