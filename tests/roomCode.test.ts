import { describe, expect, it } from "vitest";
import { generateRoomCode } from "@/lib/roomCode.server";
import {
  isValidRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "@/lib/roomCode";

describe("room code generation", () => {
  it("generates 6-character codes from the unambiguous alphabet", () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
      for (const char of code) {
        expect(ROOM_CODE_ALPHABET).toContain(char);
      }
    }
  });

  it("never emits confusing characters (0, O, 1, I)", () => {
    const sample = Array.from({ length: 2000 }, () => generateRoomCode()).join("");
    expect(sample).not.toMatch(/[0O1IL]/);
  });

  it("produces no collisions across a large batch", () => {
    const codes = new Set(
      Array.from({ length: 2000 }, () => generateRoomCode()),
    );
    expect(codes.size).toBe(2000);
  });

  it("mints codes the regex accepts, including the demo code", () => {
    expect(isValidRoomCode("TANDEM")).toBe(true);
    expect(isValidRoomCode("ABC123")).toBe(false); // contains '1'
    expect(isValidRoomCode("X7K2PQ")).toBe(true);
  });
});

describe("room code normalization", () => {
  it("uppercases lowercase input", () => {
    expect(normalizeRoomCode("abc234")).toBe("ABC234");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRoomCode("  X7K2PQ  ")).toBe("X7K2PQ");
  });

  it("strips separators and internal spaces", () => {
    expect(normalizeRoomCode("x7-k2 pq")).toBe("X7K2PQ");
  });

  it("rejects invalid codes", () => {
    expect(isValidRoomCode("")).toBe(false);
    expect(isValidRoomCode("ABC12")).toBe(false); // too short
    expect(isValidRoomCode("ABC1234")).toBe(false); // too long
    expect(isValidRoomCode("ABC1O3")).toBe(false); // contains '1' and 'O'
    expect(isValidRoomCode("abc123")).toBe(false); // lowercase
    expect(isValidRoomCode("ABC!23")).toBe(false); // punctuation
  });

  it("keeps overlong input visible to the validator (no silent truncation)", () => {
    const normalized = normalizeRoomCode("ABCDEFGH");
    expect(isValidRoomCode(normalized)).toBe(false);
  });
});
