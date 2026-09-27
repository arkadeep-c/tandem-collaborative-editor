import { describe, expect, it } from "vitest";
import { applyOp, transformBatch, transformOffset, transformOp } from "@/lib/ot";
import type { TextOp } from "@/lib/types";

describe("offset transforms", () => {
  it("shifts offsets after concurrent inserts", () => {
    const insert: TextOp = { type: "insert", offset: 2, text: "abc" };
    expect(transformOffset(5, insert)).toBe(8);
    expect(transformOffset(2, insert)).toBe(2); // same-position: arrival wins
    expect(transformOffset(1, insert)).toBe(1);
  });

  it("shifts and clamps offsets through concurrent deletes", () => {
    const del: TextOp = { type: "delete", offset: 2, length: 3 };
    expect(transformOffset(6, del)).toBe(3);
    expect(transformOffset(4, del)).toBe(2); // inside deleted span → clamp
    expect(transformOffset(3, del)).toBe(2);
    expect(transformOffset(2, del)).toBe(2);
    expect(transformOffset(1, del)).toBe(1);
  });
});

describe("op transforms", () => {
  it("transforms inserts against deletes", () => {
    const op = transformOp(
      { type: "insert", offset: 10, text: "x" },
      { type: "delete", offset: 2, length: 4 },
    );
    expect(op).toEqual({ type: "insert", offset: 6, text: "x" });
  });

  it("shrinks deletes overlapping concurrent deletes", () => {
    const op = transformOp(
      { type: "delete", offset: 0, length: 10 },
      { type: "delete", offset: 2, length: 4 },
    );
    expect(op).toEqual({ type: "delete", offset: 0, length: 6 });
  });

  it("returns null when a delete is fully swallowed", () => {
    const op = transformOp(
      { type: "delete", offset: 2, length: 3 },
      { type: "delete", offset: 0, length: 10 },
    );
    expect(op).toBeNull();
  });
});

describe("application + convergence", () => {
  it("applies inserts and deletes literally", () => {
    expect(applyOp("hello", { type: "insert", offset: 5, text: "!" })).toBe(
      "hello!",
    );
    expect(applyOp("hello", { type: "delete", offset: 0, length: 2 })).toBe(
      "llo",
    );
  });

  it("transformed batches converge regardless of apply order", () => {
    const initial = "ABCDE";
    const alice: TextOp = { type: "insert", offset: 5, text: "Z" }; // ["...E" + "Z"]
    const bob: TextOp = { type: "delete", offset: 0, length: 2 }; // remove "AB"

    // Server order: alice first, then bob transformed.
    const bobPrime = transformBatch([bob], [alice]);
    const server = bobPrime.reduce(applyOp, applyOp(initial, alice));

    // Server order: bob first, then alice transformed.
    const alicePrime = transformBatch([alice], [bob]);
    const mirror = alicePrime.reduce(applyOp, applyOp(initial, bob));

    expect(server).toBe(mirror);
    expect(server).toBe("CDEZ");
  });
});
