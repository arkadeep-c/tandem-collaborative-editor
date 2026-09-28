import { describe, expect, it } from "vitest";
import { executeCode, parseBashErrors, parseCppErrors, parseJsErrors, parsePythonErrors } from "@/lib/execution/executor";
import { EXECUTABLE_LANGUAGES, isExecutionLanguage, LANGUAGE_CONFIG } from "@/lib/execution/types";
import { LANGUAGE_OPTIONS } from "@/lib/types";

describe("execution language registry", () => {
  it("keeps visible executable languages aligned with the executor", () => {
    const executableOptions = LANGUAGE_OPTIONS.filter((option) => option.executable).map((option) => option.id).sort();
    expect(executableOptions).toEqual([...EXECUTABLE_LANGUAGES].sort());
    for (const language of EXECUTABLE_LANGUAGES) {
      expect(isExecutionLanguage(language)).toBe(true);
      expect(LANGUAGE_CONFIG[language].executable).toBe(true);
    }
  });

  it("does not advertise unsupported V1 languages", () => {
    const ids = LANGUAGE_OPTIONS.map((option) => option.id);
    expect(ids).not.toContain("java");
    expect(ids).not.toContain("go");
    expect(ids).not.toContain("rust");
    expect(ids).not.toContain("sql");
    expect(ids).not.toContain("yaml");
    expect(ids).toContain("bash");
  });
});

describe("execution diagnostics parsers", () => {
  it("parses C/C++ compiler diagnostics", () => {
    expect(parseCppErrors("main.cpp:12:9: error: expected ';' before '}' token", "main.cpp")).toEqual([
      expect.objectContaining({ file: "main.cpp", line: 12, column: 9, severity: "error" }),
    ]);
  });

  it("parses Python traceback line and exception", () => {
    const stderr = 'Traceback (most recent call last):\n  File "main.py", line 7, in <module>\n    x = 1 / 0\nZeroDivisionError: division by zero\n';
    expect(parsePythonErrors(stderr, "main.py")).toEqual([
      expect.objectContaining({ file: "main.py", line: 7, message: "ZeroDivisionError: division by zero" }),
    ]);
  });

  it("parses JavaScript stack locations", () => {
    const stderr = "/tmp/tandem/main.js:5:3\nReferenceError: x is not defined";
    expect(parseJsErrors(stderr, "main.js")).toEqual([
      expect.objectContaining({ file: "main.js", line: 5, column: 3 }),
    ]);
  });

  it("parses Bash line diagnostics", () => {
    const stderr = "main.sh: line 7: pythn: command not found";
    expect(parseBashErrors(stderr, "main.sh")).toEqual([
      expect.objectContaining({ file: "main.sh", line: 7, message: "pythn: command not found" }),
    ]);
  });
});

describe("execution fail-closed mode", () => {
  it("returns unavailable instead of raw spawn errors when disabled", async () => {
    const previous = process.env.TANDEM_EXECUTION_BACKEND;
    process.env.TANDEM_EXECUTION_BACKEND = "disabled";
    try {
      const result = await executeCode("bash", 'echo "hi"');
      expect(result.status).toBe("unavailable");
      expect(result.stderr).not.toMatch(/ENOENT|spawn/i);
    } finally {
      if (previous === undefined) delete process.env.TANDEM_EXECUTION_BACKEND;
      else process.env.TANDEM_EXECUTION_BACKEND = previous;
    }
  });
});
