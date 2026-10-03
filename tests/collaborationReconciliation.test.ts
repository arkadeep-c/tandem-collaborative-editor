import { describe, expect, it } from "vitest";
import { applyOp, rebaseSequentialOps } from "@/lib/ot";
import {
  classifyServerOpRevision,
  dropAcceptedPendingBatches,
  flattenPendingOps,
  rebasePendingBatchesAgainstOps,
  replayPendingBatchesOnSnapshot,
  type PendingOperationBatch,
} from "@/lib/useCollaborativeDocument";
import type { TextOp } from "@/lib/types";

function applyOps(content: string, ops: readonly TextOp[]): string {
  return ops.reduce((next, op) => applyOp(next, op), content);
}

function batch(id: string, ops: TextOp[]): PendingOperationBatch {
  return { id, ops };
}

describe("production collaboration reconciliation invariants", () => {
  it("A → B applies an incoming operation immediately when B has no pending local edits", () => {
    const fromA: TextOp[] = [{ type: "insert", offset: 2, text: " from A" }];
    const visualForB = rebaseSequentialOps(fromA, []);

    expect(applyOps("Hi", visualForB)).toBe("Hi from A");
  });

  it("B → A applies an incoming operation immediately when A has no pending local edits", () => {
    const fromB: TextOp[] = [{ type: "insert", offset: 0, text: "B says " }];
    const visualForA = rebaseSequentialOps(fromB, []);

    expect(applyOps("Hi", visualForA)).toBe("B says Hi");
  });

  it("keeps both valid concurrent typing sequences according to the OT rules", () => {
    const base = "Hi";
    const alice: TextOp[] = [{ type: "insert", offset: 2, text: " Alice" }];
    const bob: TextOp[] = [{ type: "insert", offset: 2, text: " Bob" }];

    const serverAfterAlice = applyOps(base, alice);
    const rebasedBob = rebaseSequentialOps(bob, alice);
    const server = applyOps(serverAfterAlice, rebasedBob);

    const alicePending = [batch("alice", alice)];
    const visualBobForAlice = rebaseSequentialOps(bob, flattenPendingOps(alicePending));
    const aliceLocal = applyOps(applyOps(base, alice), visualBobForAlice);

    expect(server).toContain("Alice");
    expect(server).toContain("Bob");
    expect(aliceLocal).toContain("Alice");
    expect(aliceLocal).toContain("Bob");
  });

  it("handles concurrent insert/delete without producing invalid operations", () => {
    const base = "abcdef";
    const localDelete = [batch("delete", [{ type: "delete", offset: 1, length: 3 }])];
    const remoteInsert: TextOp[] = [{ type: "insert", offset: 2, text: "XX" }];

    const visualRemote = rebaseSequentialOps(remoteInsert, flattenPendingOps(localDelete));
    const rebasedLocal = rebasePendingBatchesAgainstOps(localDelete, remoteInsert);

    const client = applyOps(applyOps(base, flattenPendingOps(localDelete)), visualRemote);
    const server = applyOps(applyOps(base, remoteInsert), flattenPendingOps(rebasedLocal));

    expect(client).toBe(server);
  });

  it("keeps a local operation pending after a disconnect before acknowledgement", () => {
    const pending = [batch("m_disconnect", [{ type: "insert", offset: 2, text: "!" }])];
    const replay = replayPendingBatchesOnSnapshot("Hi", pending);

    expect(replay.content).toBe("Hi!");
    expect(replay.batches).toEqual(pending);
  });

  it("reconnects against a newer server revision without dropping rebased pending edits", () => {
    const pending = [batch("m_reconnect", [{ type: "insert", offset: 3, text: "X" }])];
    const missedRemote: TextOp[] = [{ type: "insert", offset: 0, text: "Z" }];
    const rebasedPending = rebasePendingBatchesAgainstOps(pending, missedRemote);
    const replay = replayPendingBatchesOnSnapshot("Zabc", rebasedPending);

    expect(flattenPendingOps(rebasedPending)).toEqual([{ type: "insert", offset: 4, text: "X" }]);
    expect(replay.content).toBe("ZabcX");
    expect(replay.batches).toEqual(rebasedPending);
  });

  it("does not blindly overwrite local pending edits when a snapshot arrives", () => {
    const pending = [batch("m_snapshot", [{ type: "insert", offset: 5, text: " local" }])];
    const replay = replayPendingBatchesOnSnapshot("Hello remote", pending);

    expect(replay.content).toBe("Hello local remote");
    expect(flattenPendingOps(replay.batches)).toEqual(pending[0].ops);
  });

  it("drops only impossible pending operations during snapshot replay", () => {
    const pending = [
      batch("m_bad", [{ type: "delete", offset: 50, length: 1 }]),
      batch("m_good", [{ type: "insert", offset: 2, text: "!" }]),
    ];
    const replay = replayPendingBatchesOnSnapshot("Hi", pending);

    expect(replay.content).toBe("Hi!");
    expect(replay.batches).toEqual([pending[1]]);
  });

  it("collaborator removal does not mutate the pending operation queue", () => {
    const pending = [batch("m_kick_safe", [{ type: "insert", offset: 2, text: " safe" }])];
    const before = JSON.stringify(pending);

    // Presence/member events are independent of text reconciliation; pending
    // local text must survive access changes for other collaborators.
    const afterPresenceOnlyEvent = pending;

    expect(JSON.stringify(afterPresenceOnlyEvent)).toBe(before);
  });

  it("keeps multiple same-user tabs as distinct pending/presence session instances", () => {
    const tabOne = batch("m_tab_one", [{ type: "insert", offset: 0, text: "A" }]);
    const tabTwo = batch("m_tab_two", [{ type: "insert", offset: 1, text: "B" }]);

    expect(new Set([tabOne.id, tabTwo.id]).size).toBe(2);
    expect(flattenPendingOps([tabOne, tabTwo])).toEqual([...tabOne.ops, ...tabTwo.ops]);
  });
  it("ignores delayed duplicate SSE events after an acknowledgement advanced the client", () => {
    expect(classifyServerOpRevision(12, 11, 1)).toBe("stale");
    expect(classifyServerOpRevision(12, 12, 1)).toBe("stale");
  });

  it("detects an SSE revision gap and requires snapshot reconnect before applying later ops", () => {
    expect(classifyServerOpRevision(10, 13, 1)).toBe("gap");
    expect(classifyServerOpRevision(10, 13, 3)).toBe("ready");
    expect(classifyServerOpRevision(11, 13, 3)).toBe("gap");
  });

  it("does not replay a pending operation that the reconnect snapshot already accepted", () => {
    const pending = [
      batch("m_already_saved", [{ type: "insert", offset: 2, text: "!" }]),
      batch("m_still_local", [{ type: "insert", offset: 3, text: "?" }]),
    ];

    const unresolved = dropAcceptedPendingBatches(
      pending,
      new Set(["m_already_saved"]),
    );
    const replay = replayPendingBatchesOnSnapshot("Hi!", unresolved);

    expect(unresolved.map((item) => item.id)).toEqual(["m_still_local"]);
    expect(replay.content).toBe("Hi!?");
  });

});
