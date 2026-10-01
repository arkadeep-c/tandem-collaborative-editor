import { LANGUAGE_STARTERS, type LanguageId } from "@/lib/languageConfig";

export type RoomTemplateMode = "blank" | "starter";

export function normalizeRoomTemplateMode(value: unknown): RoomTemplateMode {
  return value === "blank" ? "blank" : "starter";
}

export function starterTemplatesEnabled(value: unknown): boolean {
  return normalizeRoomTemplateMode(value) === "starter";
}

export function initialContentForRoomTemplateMode(
  language: LanguageId,
  mode: RoomTemplateMode,
): string {
  return mode === "starter" ? LANGUAGE_STARTERS[language] ?? "" : "";
}
