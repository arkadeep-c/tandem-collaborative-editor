import { describe, expect, it } from "vitest";
import { replayLocalOpsOnSnapshot } from "@/lib/useCollaborativeDocument";
import type { TextOp } from "@/lib/types";

describe("collaboration stale retry helpers", () => {
  it("replays outstanding and buffered local operations on a stale server snapshot", () => {
    const pending: TextOp[] = [
      { type: "insert", offset: 5, text: "!" },
      { type: "insert", offset: 6, text: "?" },
    ];

    const replay = replayLocalOpsOnSnapshot("Hello", pending);

    expect(replay.content).toBe("Hello!?");
    expect(replay.ops).toEqual(pending);
  });

  it("does not keep impossible operations when replaying after resync", () => {
    const replay = replayLocalOpsOnSnapshot("abc", [
      { type: "delete", offset: 10, length: 1 },
      { type: "insert", offset: 3, text: "!" },
    ]);

    expect(replay.content).toBe("abc!");
    expect(replay.ops).toEqual([{ type: "insert", offset: 3, text: "!" }]);
  });
});
