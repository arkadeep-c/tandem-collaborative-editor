export function normalizeBashSourceLineEndings(code: string): string {
  return code.replace(/\r\n|\r/g, "\n");
}

export function normalizeExecutionSource(language: string, code: string): string {
  return language === "bash" ? normalizeBashSourceLineEndings(code) : code;
}
