import { describe, expect, it } from "vitest";
import { LANGUAGE_OPTIONS } from "@/lib/types";
import {
  cleanName,
  cleanTitle,
  isLanguageId,
  isPresenceColor,
  MAX_OPS_PER_BATCH,
  opWithinBounds,
  validateOps,
} from "@/lib/validation";

describe("text scalars", () => {
  it("cleans and accepts valid titles", () => {
    expect(cleanTitle("  api-design.ts  ")).toBe("api-design.ts");
  });

  it("rejects empty and overlong titles", () => {
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("x".repeat(121))).toBeNull();
  });

  it("strips control characters", () => {
    expect(cleanName("Ada	Lovelace")).toBe("AdaLovelace");
  });

  it("rejects non-strings", () => {
    expect(cleanTitle(42)).toBeNull();
    expect(cleanTitle(null)).toBeNull();
  });
});

describe("language registry", () => {
  it("supports all required languages", () => {
    for (const id of [
      "javascript",
      "typescript",
      "python",
      "c",
      "cpp",
      "java",
      "markdown",
      "json",
    ]) {
      expect(isLanguageId(id)).toBe(true);
      expect(LANGUAGE_OPTIONS.some((l) => l.id === id)).toBe(true);
    }
  });

  it("rejects unknown languages", () => {
    expect(isLanguageId("cobol")).toBe(false);
    expect(isLanguageId("")).toBe(false);
  });

  it("validates presence colors", () => {
    expect(isPresenceColor("#f472b6")).toBe(true);
    expect(isPresenceColor("red")).toBe(false);
    expect(isPresenceColor("#000000")).toBe(false);
  });
});

describe("operation validation", () => {
  it("accepts a well-formed batch", () => {
    const result = validateOps([
      { type: "insert", offset: 0, text: "hi" },
      { type: "delete", offset: 3, length: 2 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(validateOps([]).ok).toBe(false);
  });

  it("rejects too many ops", () => {
    const ops = Array.from({ length: MAX_OPS_PER_BATCH + 1 }, () => ({
      type: "insert" as const,
      offset: 0,
      text: "x",
    }));
    expect(validateOps(ops).ok).toBe(false);
  });

  it("rejects negative offsets", () => {
    expect(
      validateOps([{ type: "insert", offset: -1, text: "x" }]).ok,
    ).toBe(false);
    expect(validateOps([{ type: "delete", offset: -5, length: 1 }]).ok).toBe(
      false,
    );
  });

  it("rejects non-integer positions and lengths", () => {
    expect(
      validateOps([{ type: "insert", offset: 1.5, text: "x" }]).ok,
    ).toBe(false);
    expect(validateOps([{ type: "delete", offset: 0, length: 0 }]).ok).toBe(
      false,
    );
    expect(
      validateOps([{ type: "delete", offset: 0, length: -3 }]).ok,
    ).toBe(false);
  });

  it("rejects unknown op types and malformed shapes", () => {
    expect(validateOps([{ type: "replace", offset: 0 }]).ok).toBe(false);
    expect(validateOps([null]).ok).toBe(false);
    expect(validateOps("not-an-array").ok).toBe(false);
  });

  it("rejects oversized payloads", () => {
    expect(
      validateOps([{ type: "insert", offset: 0, text: "x".repeat(100_001) }]).ok,
    ).toBe(false);
  });

  it("bounds-checks ops against live content length", () => {
    expect(opWithinBounds({ type: "insert", offset: 5, text: "x" }, 5)).toBe(
      true,
    );
    expect(opWithinBounds({ type: "insert", offset: 6, text: "x" }, 5)).toBe(
      false,
    );
    expect(opWithinBounds({ type: "delete", offset: 3, length: 2 }, 5)).toBe(
      true,
    );
    expect(opWithinBounds({ type: "delete", offset: 4, length: 2 }, 5)).toBe(
      false,
    );
  });
});
