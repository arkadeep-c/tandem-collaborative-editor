import { describe, expect, it } from "vitest";
import { distinctPresenceConnections } from "@/components/editor/PresenceBar";
import type { PresenceState } from "@/lib/types";

function presence(sessionId: string, lastActiveAt: number): PresenceState {
  return {
    sessionId,
    user: { id: "same-user", name: "Same User", color: "#67e8f9" },
    cursor: null,
    selection: null,
    typing: false,
    joinedAt: lastActiveAt,
    lastActiveAt,
  };
}

describe("presence connection display", () => {
  it("keeps multiple active connections for the same user identity visible", () => {
    const entries = distinctPresenceConnections([
      presence("c_one", 10),
      presence("c_two", 20),
    ]);

    expect(entries.map((entry) => entry.sessionId)).toEqual(["c_one", "c_two"]);
    expect(new Set(entries.map((entry) => entry.user.id))).toEqual(new Set(["same-user"]));
  });

  it("deduplicates only duplicate events for the same sessionId", () => {
    const entries = distinctPresenceConnections([
      presence("c_one", 10),
      { ...presence("c_one", 30), typing: true },
      presence("c_two", 20),
    ]);

    expect(entries.map((entry) => entry.sessionId)).toEqual(["c_two", "c_one"]);
    expect(entries.find((entry) => entry.sessionId === "c_one")?.typing).toBe(true);
  });
});
