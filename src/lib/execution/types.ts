export type ExecutionLanguage = 
  | "c"
  | "cpp"
  | "python"
  | "javascript"
  | "typescript"
  | "bash"
  | "java"
  | "go"
  | "rust"
  | "json"
  | "markdown"
  | "html"
  | "css"
  | "sql";

export type ExecutionStatus =
  | "idle"
  | "compiling"
  | "running"
  | "success"
  | "compile_error"
  | "runtime_error"
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

export const EXECUTABLE_LANGUAGES: ExecutionLanguage[] = [
  "c",
  "cpp",
  "python",
  "javascript",
  "typescript",
  "bash",
];

export const LANGUAGE_CONFIG: Record<ExecutionLanguage, { 
  label: string; 
  executable: boolean; 
  extension: string;
  needsCompilation?: boolean;
}> = {
  c: { label: "C", executable: true, extension: "c", needsCompilation: true },
  cpp: { label: "C++", executable: true, extension: "cpp", needsCompilation: true },
  python: { label: "Python", executable: true, extension: "py" },
  javascript: { label: "JavaScript", executable: true, extension: "js" },
  typescript: { label: "TypeScript", executable: true, extension: "ts", needsCompilation: true },
  bash: { label: "Bash", executable: true, extension: "sh" },
  java: { label: "Java", executable: false, extension: "java", needsCompilation: true },
  go: { label: "Go", executable: false, extension: "go", needsCompilation: true },
  rust: { label: "Rust", executable: false, extension: "rs", needsCompilation: true },
  json: { label: "JSON", executable: false, extension: "json" },
  markdown: { label: "Markdown", executable: false, extension: "md" },
  html: { label: "HTML", executable: false, extension: "html" },
  css: { label: "CSS", executable: false, extension: "css" },
  sql: { label: "SQL", executable: false, extension: "sql" },
};
