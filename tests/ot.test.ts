import { describe, expect, it } from "vitest";
import {
  applyOp,
  rebaseSequentialOps,
  transformBatch,
  transformOffset,
  transformOp,
} from "@/lib/ot";
import type { TextOp } from "@/lib/types";

function applyOps(content: string, ops: TextOp[]): string {
  return ops.reduce(applyOp, content);
}

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

describe("sequential operation scripts", () => {
  it("keeps rapid typing buffered behind an outstanding op in sequence", () => {
    const first: TextOp = { type: "insert", offset: 0, text: "i" };
    const buffered: TextOp[] = [
      { type: "insert", offset: 1, text: "n" },
      { type: "insert", offset: 2, text: "t" },
      { type: "insert", offset: 3, text: " " },
      { type: "insert", offset: 4, text: "a" },
      { type: "insert", offset: 5, text: ";" },
      { type: "insert", offset: 6, text: "{" },
    ];

    const afterFirst = applyOp("", first);
    const rebased = rebaseSequentialOps(buffered, []);

    expect(rebased).toEqual(buffered);
    expect(applyOps(afterFirst, rebased)).toBe("int a;{");
  });

  it("keeps sequential forward deletions in sequence", () => {
    const ops: TextOp[] = [
      { type: "delete", offset: 0, length: 1 },
      { type: "delete", offset: 0, length: 1 },
      { type: "delete", offset: 0, length: 1 },
    ];

    expect(applyOps("abcdef", rebaseSequentialOps(ops, []))).toBe("def");
  });

  it("keeps sequential backspace-style deletions in sequence", () => {
    const ops: TextOp[] = [
      { type: "delete", offset: 5, length: 1 },
      { type: "delete", offset: 4, length: 1 },
      { type: "delete", offset: 3, length: 1 },
    ];

    expect(applyOps("abcdef", rebaseSequentialOps(ops, []))).toBe("abc");
  });

  it("keeps sequential newline insertion in sequence", () => {
    const ops: TextOp[] = [
      { type: "insert", offset: 0, text: "int" },
      { type: "insert", offset: 3, text: "\n" },
      { type: "insert", offset: 4, text: "a;{" },
    ];

    expect(applyOps("", rebaseSequentialOps(ops, []))).toBe("int\na;{");
  });

  it("keeps a rapid paste after an outstanding op in sequence", () => {
    const first: TextOp = { type: "insert", offset: 0, text: "hello" };
    const paste: TextOp[] = [
      { type: "insert", offset: 5, text: "\nline1\nline2" },
    ];

    expect(applyOps(applyOp("", first), rebaseSequentialOps(paste, []))).toBe(
      "hello\nline1\nline2",
    );
  });

  it("does not self-transform a multi-operation sequential batch", () => {
    const ops: TextOp[] = [
      { type: "insert", offset: 0, text: "A" },
      { type: "insert", offset: 1, text: "B" },
      { type: "insert", offset: 2, text: "C" },
    ];

    expect(rebaseSequentialOps(ops, [])).toEqual(ops);
    expect(applyOps("", rebaseSequentialOps(ops, []))).toBe("ABC");
  });

  it("rebases a stale sequential batch over missed remote operations", () => {
    const initial = "abc";
    const missed: TextOp[] = [{ type: "insert", offset: 0, text: "Z" }];
    const localSequential: TextOp[] = [
      { type: "insert", offset: 3, text: "X" },
      { type: "insert", offset: 4, text: "Y" },
    ];

    const serverAtTip = applyOps(initial, missed);
    const rebased = rebaseSequentialOps(localSequential, missed);

    expect(rebased).toEqual([
      { type: "insert", offset: 4, text: "X" },
      { type: "insert", offset: 5, text: "Y" },
    ]);
    expect(applyOps(serverAtTip, rebased)).toBe("ZabcXY");
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
