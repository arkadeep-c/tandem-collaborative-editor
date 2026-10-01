import {
  EXECUTABLE_LANGUAGE_IDS,
  LANGUAGE_DEFINITION_BY_ID,
  LANGUAGE_DEFINITIONS,
  type LanguageId,
} from "@/lib/languageConfig";

export type ExecutionLanguage = Extract<
  LanguageId,
  "c" | "cpp" | "java" | "python" | "javascript" | "typescript" | "bash"
>;

export type ExecutionStatus =
  | "idle"
  | "compiling"
  | "running"
  | "success"
  | "compile_error"
  | "runtime_error"
  | "cancelled"
  | "timeout"
  | "output_limit"
  | "memory_limit"
  | "execution_error"
  | "unavailable";

export interface ExecutionProblem {
  file: string;
  line: number;
  column?: number;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface ExecutionResult {
  status: ExecutionStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  duration: number;
  compilationOutput?: string;
  problems: ExecutionProblem[];
  timedOut?: boolean;
  outputTruncated?: boolean;
}

export interface ExecutionRequest {
  language: ExecutionLanguage;
  code: string;
  stdin?: string;
  roomCode?: string;
}

export type ExecutionStreamStatus =
  | "starting"
  | "compiling"
  | "running"
  | "waiting"
  | "finished";

export type ExecutionStreamEvent =
  | { type: "start"; executionId: string }
  | { type: "status"; status: ExecutionStreamStatus; message?: string }
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "stdin"; chunk: string }
  | { type: "result"; result: ExecutionResult }
  | { type: "error"; message: string };

export interface ExecutionLanguageAvailability {
  ready: boolean;
  reason?: string;
}

export interface ExecutionAvailability {
  configured: boolean;
  backend: "docker" | "linux-namespace" | null;
  productionSafe: boolean;
  message?: string;
  languages: Record<ExecutionLanguage, ExecutionLanguageAvailability>;
}

export const EXECUTABLE_LANGUAGES = EXECUTABLE_LANGUAGE_IDS as ExecutionLanguage[];

export const LANGUAGE_CONFIG = LANGUAGE_DEFINITIONS.reduce(
  (acc, language) => {
    acc[language.id] = {
      label: language.label,
      executable: language.executable,
      extension: language.extension,
      needsCompilation: language.needsCompilation,
    };
    return acc;
  },
  {} as Record<
    LanguageId,
    {
      label: string;
      executable: boolean;
      extension: string;
      needsCompilation?: boolean;
    }
  >,
);

export function isExecutionLanguage(language: string): language is ExecutionLanguage {
  return (EXECUTABLE_LANGUAGES as readonly string[]).includes(language);
}

export function executionLabel(language: string): string {
  return LANGUAGE_DEFINITION_BY_ID[language as LanguageId]?.label ?? language;
}
