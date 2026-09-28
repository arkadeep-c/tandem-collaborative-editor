export type LanguageId =
  | "c"
  | "cpp"
  | "python"
  | "javascript"
  | "typescript"
  | "bash"
  | "markdown"
  | "html"
  | "css"
  | "json";

export type LanguageKind = "code" | "markup" | "data" | "document";

export interface LanguageDefinition {
  id: LanguageId;
  label: string;
  shortLabel?: string;
  accent: string;
  extension: string;
  monacoLanguage: string;
  executable: boolean;
  needsCompilation?: boolean;
  kind: LanguageKind;
  starter: string;
}

export interface LanguageOption {
  id: LanguageId;
  label: string;
  accent: string;
  executable: boolean;
}

export const LANGUAGE_DEFINITIONS: readonly LanguageDefinition[] = [
  {
    id: "c",
    label: "C",
    accent: "#38bdf8",
    extension: "c",
    monacoLanguage: "cpp",
    executable: true,
    needsCompilation: true,
    kind: "code",
    starter: `// Starter C template. Safe to edit or delete.\n\n#include <stdio.h>\n\nint main(void) {\n    printf("Hello from Tandem C\\n");\n    return 0;\n}\n`,
  },
  {
    id: "cpp",
    label: "C++",
    accent: "#22d3ee",
    extension: "cpp",
    monacoLanguage: "cpp",
    executable: true,
    needsCompilation: true,
    kind: "code",
    starter: `// Starter C++ template. Safe to edit or delete.\n\n#include <iostream>\n\nint main() {\n    std::cout << "Hello from Tandem C++" << std::endl;\n    return 0;\n}\n`,
  },
  {
    id: "python",
    label: "Python",
    accent: "#2dd4bf",
    extension: "py",
    monacoLanguage: "python",
    executable: true,
    kind: "code",
    starter: `# Starter Python template. Safe to edit or delete.\n\nprint("Hello from Tandem Python")\n`,
  },
  {
    id: "javascript",
    label: "JavaScript",
    accent: "#67e8f9",
    extension: "js",
    monacoLanguage: "javascript",
    executable: true,
    kind: "code",
    starter: `// Starter JavaScript template. Safe to edit or delete.\n\nconsole.log("Hello from Tandem JavaScript");\n`,
  },
  {
    id: "typescript",
    label: "TypeScript",
    accent: "#60a5fa",
    extension: "ts",
    monacoLanguage: "typescript",
    executable: true,
    needsCompilation: true,
    kind: "code",
    starter: `// Starter TypeScript template. Safe to edit or delete.\n\nconst message: string = "Hello from Tandem TypeScript";\nconsole.log(message);\n`,
  },
  {
    id: "bash",
    label: "Bash / Shell",
    shortLabel: "Bash",
    accent: "#34d399",
    extension: "sh",
    monacoLanguage: "shell",
    executable: true,
    kind: "code",
    starter: `# Starter Bash template. Safe to edit or delete.\n\necho "Hello from Tandem Bash"\n`,
  },
  {
    id: "markdown",
    label: "Markdown",
    accent: "#93c5fd",
    extension: "md",
    monacoLanguage: "markdown",
    executable: false,
    kind: "document",
    starter: `# Tandem Notes\n\nStart writing. Everyone in this room sees every keystroke.\n`,
  },
  {
    id: "html",
    label: "HTML",
    accent: "#fb923c",
    extension: "html",
    monacoLanguage: "html",
    executable: false,
    kind: "markup",
    starter: `<!-- Starter HTML template. Safe to edit or delete. -->\n<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Tandem Preview</title>\n  </head>\n  <body>\n    <h1>Hello from Tandem HTML</h1>\n  </body>\n</html>\n`,
  },
  {
    id: "css",
    label: "CSS",
    accent: "#38bdf8",
    extension: "css",
    monacoLanguage: "css",
    executable: false,
    kind: "markup",
    starter: `/* Starter CSS template. Safe to edit or delete. */\n\nbody {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n  background: #0f172a;\n  color: #e2e8f0;\n}\n`,
  },
  {
    id: "json",
    label: "JSON",
    accent: "#5eead4",
    extension: "json",
    monacoLanguage: "json",
    executable: false,
    kind: "data",
    starter: `{\n  "name": "tandem",\n  "collaborative": true\n}\n`,
  },
] as const;

export const LANGUAGE_IDS = LANGUAGE_DEFINITIONS.map((language) => language.id) as LanguageId[];

export const EXECUTABLE_LANGUAGE_IDS = LANGUAGE_DEFINITIONS
  .filter((language) => language.executable)
  .map((language) => language.id) as LanguageId[];

export const LANGUAGE_OPTIONS: LanguageOption[] = LANGUAGE_DEFINITIONS.map((language) => ({
  id: language.id,
  label: language.label,
  accent: language.accent,
  executable: language.executable,
}));

export const LANGUAGE_DEFINITION_BY_ID: Record<LanguageId, LanguageDefinition> =
  LANGUAGE_DEFINITIONS.reduce((acc, language) => {
    acc[language.id] = language;
    return acc;
  }, {} as Record<LanguageId, LanguageDefinition>);

export const LANGUAGE_STARTERS: Record<LanguageId, string> = LANGUAGE_DEFINITIONS.reduce(
  (acc, language) => {
    acc[language.id] = language.starter;
    return acc;
  },
  {} as Record<LanguageId, string>,
);

export function isKnownLanguageId(input: unknown): input is LanguageId {
  return typeof input === "string" && (LANGUAGE_IDS as readonly string[]).includes(input);
}

export function getLanguageDefinition(language: string): LanguageDefinition | null {
  return isKnownLanguageId(language) ? LANGUAGE_DEFINITION_BY_ID[language] : null;
}

export function languageAccent(language: string): string {
  return getLanguageDefinition(language)?.accent ?? "#22d3ee";
}

export function monacoLanguageFor(language: string): string {
  return getLanguageDefinition(language)?.monacoLanguage ?? "plaintext";
}

export function fileExtensionFor(language: string): string {
  return getLanguageDefinition(language)?.extension ?? "txt";
}

export function languageLabel(language: string): string {
  return getLanguageDefinition(language)?.label ?? language;
}

export function isExecutableLanguage(language: string): language is LanguageId {
  const definition = getLanguageDefinition(language);
  return Boolean(definition?.executable);
}
