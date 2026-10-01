import { describe, expect, it } from "vitest";
import {
  initialContentForRoomTemplateMode,
  normalizeRoomTemplateMode,
  starterTemplatesEnabled,
} from "@/lib/roomTemplates";


describe("room template modes", () => {
  it("keeps blank rooms genuinely blank with starter functionality disabled", () => {
    expect(normalizeRoomTemplateMode("blank")).toBe("blank");
    expect(starterTemplatesEnabled("blank")).toBe(false);
    expect(initialContentForRoomTemplateMode("c", "blank")).toBe("");
  });

  it("keeps starter rooms backed by language starter templates", () => {
    const content = initialContentForRoomTemplateMode("c", "starter");
    expect(normalizeRoomTemplateMode("starter")).toBe("starter");
    expect(starterTemplatesEnabled("starter")).toBe(true);
    expect(content).toContain("Hello from Tandem C");
  });

  it("treats pre-existing rooms without stored mode as starter-compatible", () => {
    expect(normalizeRoomTemplateMode(undefined)).toBe("starter");
    expect(normalizeRoomTemplateMode(null)).toBe("starter");
    expect(starterTemplatesEnabled(undefined)).toBe(true);
  });
});
