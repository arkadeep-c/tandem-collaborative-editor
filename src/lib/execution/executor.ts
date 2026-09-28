import { randomBytes } from "crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir, platform } from "os";
import { EXECUTABLE_LANGUAGES, type ExecutionAvailability, type ExecutionLanguage, type ExecutionProblem, type ExecutionResult } from "./types";

const TIMEOUT_MS = 10_000;
const COMPILE_TIMEOUT_MS = 8_000;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MAX_CODE_SIZE = 100 * 1024;
const MAX_STDIN_SIZE = 10 * 1024;
const MEMORY_LIMIT_BYTES = 768 * 1024 * 1024;
const FILE_SIZE_BLOCKS = 4096; // 2MB with POSIX 512-byte blocks.
const PROCESS_LIMIT = 96;
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function getHostExecutionPath(
  hostPlatform: NodeJS.Platform = platform(),
  hostPath: string | undefined = process.env.PATH,
): string {
  return hostPlatform === "win32" ? hostPath ?? "" : SAFE_PATH;
}

export const JAVA_VM_ARGS = [
  "-Xmx256m",
  "-XX:+UseSerialGC",
  "-XX:ActiveProcessorCount=1",
  "-Xss256k",
  "-XX:CICompilerCount=1",
  "-XX:TieredStopAtLevel=1",
  "-XX:MaxMetaspaceSize=128m",
  "-XX:ReservedCodeCacheSize=32m",
  "-XX:-UsePerfData",
  "-Djava.io.tmpdir=.",
] as const;
export const JAVAC_VM_ARGS = JAVA_VM_ARGS.map((arg) => `-J${arg}`);

export function createDockerWorkspaceMount(workDir: string): string {
  return `${workDir}:/workspace:rw`;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  spawnError?: string;
}

interface SandboxBackend {
  readonly name: "docker" | "linux-namespace";
  readonly productionSafe: boolean;
  run(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult>;
}

interface SpawnOptions {
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface DockerImageToolProbeBackend {
  readonly image: string;
}

export interface DockerImageToolProbeResult {
  imageExists: boolean;
  availableTools: string[];
  missingTools: string[];
  error?: string;
}

export interface ExecutionAvailabilityProbeOverrides {
  commandExists?: (command: string) => Promise<boolean>;
  dockerImageToolProbe?: (
    backend: DockerImageToolProbeBackend,
    tools: readonly string[],
  ) => Promise<DockerImageToolProbeResult>;
}

function baseResult(
  status: ExecutionResult["status"],
  stderr: string,
  duration: number,
  extras: Partial<ExecutionResult> = {},
): ExecutionResult {
  return {
    status,
    stdout: "",
    stderr,
    exitCode: null,
    duration,
    problems: [],
    ...extras,
  };
}

function unavailable(message: string, start = Date.now()): ExecutionResult {
  return baseResult("unavailable", message, Date.now() - start);
}

function cleanOutput(text: string, workDir: string): string {
  return text
    .replaceAll(`${workDir}/`, "")
    .replaceAll(workDir, "")
    .replace(/\/tmp\/tandem-exec-[a-f0-9]+\//g, "")
    .replace(/\\/g, "/");
}

async function commandExists(command: string): Promise<boolean> {
  const result = platform() === "win32"
    ? await rawSpawn("where.exe", [command], { cwd: tmpdir(), timeoutMs: 1500 })
    : await rawSpawn("/bin/sh", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], { cwd: tmpdir(), timeoutMs: 1500 });
  return result.exitCode === 0;
}

async function rawSpawn(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        PATH: getHostExecutionPath(),
        HOME: options.cwd,
        TMPDIR: options.cwd,
        TEMP: options.cwd,
        TMP: options.cwd,
        LANG: "C.UTF-8",
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: platform() !== "win32",
    }) as ChildProcessWithoutNullStreams;

    const killChild = () => {
      try {
        if (platform() !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.timeoutMs || TIMEOUT_MS);

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (outputTruncated) return;
      if (target === "stdout") {
        stdoutBytes += chunk.length;
        if (stdoutBytes > OUTPUT_LIMIT_BYTES) {
          outputTruncated = true;
          stdout += chunk.toString("utf8", 0, OUTPUT_LIMIT_BYTES - stdoutBytes + chunk.length);
          stdout += "\n[Output truncated: exceeded 1MB limit]";
          killChild();
          return;
        }
        stdout += chunk.toString("utf8");
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes > OUTPUT_LIMIT_BYTES) {
          outputTruncated = true;
          stderr += chunk.toString("utf8", 0, OUTPUT_LIMIT_BYTES - stderrBytes + chunk.length);
          stderr += "\n[Output truncated: exceeded 1MB limit]";
          killChild();
          return;
        }
        stderr += chunk.toString("utf8");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: null, timedOut: false, outputTruncated, spawnError: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code, timedOut, outputTruncated });
    });

    if (options.stdin) {
      try { child.stdin.write(options.stdin); } catch {}
    }
    try { child.stdin.end(); } catch {}
  });
}

class LinuxNamespaceBackend implements SandboxBackend {
  readonly name = "linux-namespace" as const;
  readonly productionSafe = false;

  async run(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
    const repoRoot = process.cwd();
    const script = [
      "cd \"$TANDEM_WORKDIR\" || exit 111",
      `ulimit -t ${Math.ceil((options.timeoutMs || TIMEOUT_MS) / 1000) + 1}`,
      `ulimit -f ${FILE_SIZE_BLOCKS}`,
      `ulimit -v ${Math.floor(MEMORY_LIMIT_BYTES / 1024)}`,
      `ulimit -u ${PROCESS_LIMIT}`,
      "umask 077",
      `mount -t tmpfs -o size=1m tmpfs ${JSON.stringify(repoRoot)} 2>/dev/null || true`,
      "exec \"$@\"",
    ].join("; ");

    const unshareArgs = [
      "--user",
      "--map-root-user",
      "--net",
      "--pid",
      "--mount",
      "--fork",
      "/usr/bin/env",
      "-i",
      `PATH=${SAFE_PATH}`,
      `HOME=${options.cwd}`,
      `TMPDIR=${options.cwd}`,
      `TEMP=${options.cwd}`,
      `TMP=${options.cwd}`,
      `TANDEM_WORKDIR=${options.cwd}`,
      "LANG=C.UTF-8",
      "/bin/bash",
      "-lc",
      script,
      "sandbox",
      command,
      ...args,
    ];
    return rawSpawn("unshare", unshareArgs, options);
  }
}

class DockerBackend implements SandboxBackend {
  readonly name = "docker" as const;
  readonly productionSafe = true;

  constructor(readonly image: string) {}

  async run(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
    await fs.chmod(options.cwd, 0o777).catch(() => undefined);
    const script = [
      "cd /workspace || exit 111",
      `ulimit -t ${Math.ceil((options.timeoutMs || TIMEOUT_MS) / 1000) + 1}`,
      `ulimit -f ${FILE_SIZE_BLOCKS}`,
      `ulimit -v ${Math.floor(MEMORY_LIMIT_BYTES / 1024)}`,
      `ulimit -u ${PROCESS_LIMIT}`,
      "umask 077",
      "exec \"$@\"",
    ].join("; ");
    const dockerArgs = [
      "run",
      "--rm",
      "--network",
      "none",
      "--cpus",
      "0.5",
      "--memory",
      String(MEMORY_LIMIT_BYTES),
      "--pids-limit",
      String(PROCESS_LIMIT),
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "-v",
      createDockerWorkspaceMount(options.cwd),
      "-w",
      "/workspace",
      "--user",
      "65534:65534",
      "--entrypoint",
      "/usr/bin/env",
      this.image,
      "-i",
      `PATH=${SAFE_PATH}`,
      "HOME=/workspace",
      "TMPDIR=/workspace",
      "LANG=C.UTF-8",
      "/bin/bash",
      "-lc",
      script,
      "sandbox",
      command,
      ...args,
    ];
    return rawSpawn("docker", dockerArgs, options);
  }
}

async function resolveBackend(hostCommandExists: (command: string) => Promise<boolean> = commandExists): Promise<SandboxBackend | null> {
  const requested = (process.env.TANDEM_EXECUTION_BACKEND || "auto").toLowerCase();
  if (requested === "disabled" || requested === "none") return null;

  const image = process.env.TANDEM_EXECUTION_IMAGE;
  if ((requested === "docker" || (requested === "auto" && image)) && image) {
    if (await hostCommandExists("docker")) return new DockerBackend(image);
    return null;
  }

  const allowNamespace =
    requested === "linux-namespace" ||
    process.env.APP_ENV === "preview" ||
    process.env.USE_LOCAL_DEV_DB === "true" ||
    process.env.TANDEM_ENABLE_LINUX_NAMESPACE_EXECUTOR === "true" ||
    process.env.NODE_ENV !== "production";

  if (platform() === "linux" && allowNamespace && await hostCommandExists("unshare")) {
    return new LinuxNamespaceBackend();
  }

  return null;
}

function backendUnavailableMessage(): string {
  return "Code execution is unavailable because no supported isolated execution runtime is configured. Configure a Linux Docker sandbox image with TANDEM_EXECUTION_IMAGE, or use the documented Linux/WSL development sandbox. Unsafe host execution is disabled.";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function uniqueRequiredTools(): string[] {
  return Array.from(new Set(EXECUTABLE_LANGUAGES.flatMap((language) => EXECUTION_TOOL_REQUIREMENTS[language])));
}

export function createDockerRuntimeProbeScript(tools: readonly string[]): string {
  const toolList = tools.map(shellQuote).join(" ");
  return [
    "missing=0",
    `for tool in ${toolList}; do`,
    "  if command -v \"$tool\" >/dev/null 2>&1; then",
    "    printf 'READY:%s\\n' \"$tool\"",
    "  else",
    "    printf 'MISSING:%s\\n' \"$tool\"",
    "    missing=1",
    "  fi",
    "done",
    "exit \"$missing\"",
  ].join("\n");
}

export function parseDockerRuntimeProbeOutput(stdout: string, tools: readonly string[]): Pick<DockerImageToolProbeResult, "availableTools" | "missingTools"> {
  const requested = new Set(tools);
  const available = new Set<string>();
  const missing = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^(READY|MISSING):(.+)$/);
    if (!match) continue;
    const tool = match[2].trim();
    if (!requested.has(tool)) continue;
    if (match[1] === "READY") {
      available.add(tool);
      missing.delete(tool);
    } else if (!available.has(tool)) {
      missing.add(tool);
    }
  }

  for (const tool of tools) {
    if (!available.has(tool)) missing.add(tool);
  }

  return {
    availableTools: tools.filter((tool) => available.has(tool)),
    missingTools: tools.filter((tool) => missing.has(tool)),
  };
}

async function probeDockerImageTools(
  backend: DockerImageToolProbeBackend,
  tools: readonly string[],
): Promise<DockerImageToolProbeResult> {
  const inspect = await rawSpawn("docker", ["image", "inspect", backend.image], {
    cwd: tmpdir(),
    timeoutMs: 5000,
  });

  if (inspect.exitCode !== 0 || inspect.spawnError || inspect.timedOut) {
    return {
      imageExists: false,
      availableTools: [],
      missingTools: [...tools],
      error: `Docker execution image "${backend.image}" is not available locally. Build or pull it before enabling Docker execution.`,
    };
  }

  const result = await rawSpawn("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--cpus",
    "0.5",
    "--memory",
    String(MEMORY_LIMIT_BYTES),
    "--pids-limit",
    String(PROCESS_LIMIT),
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--user",
    "65534:65534",
    "--entrypoint",
    "/usr/bin/env",
    backend.image,
    "-i",
    `PATH=${SAFE_PATH}`,
    "HOME=/tmp",
    "TMPDIR=/tmp",
    "TEMP=/tmp",
    "TMP=/tmp",
    "LANG=C.UTF-8",
    "/bin/sh",
    "-lc",
    createDockerRuntimeProbeScript(tools),
  ], {
    cwd: tmpdir(),
    timeoutMs: 8000,
  });

  if (result.spawnError || result.timedOut || result.outputTruncated || (result.exitCode !== 0 && result.exitCode !== 1)) {
    return {
      imageExists: true,
      availableTools: [],
      missingTools: [...tools],
      error: `Unable to verify runtimes inside Docker execution image "${backend.image}".`,
    };
  }

  return {
    imageExists: true,
    ...parseDockerRuntimeProbeOutput(result.stdout, tools),
  };
}

export async function getExecutionAvailability(
  probeOverrides: ExecutionAvailabilityProbeOverrides = {},
): Promise<ExecutionAvailability> {
  const languages = Object.fromEntries(
    EXECUTABLE_LANGUAGES.map((language) => [
      language,
      { ready: false, reason: backendUnavailableMessage() },
    ]),
  ) as ExecutionAvailability["languages"];

  const hostCommandExists = probeOverrides.commandExists ?? commandExists;
  const backend = await resolveBackend(hostCommandExists);
  if (!backend) {
    return {
      configured: false,
      backend: null,
      productionSafe: false,
      message: backendUnavailableMessage(),
      languages,
    };
  }

  if (backend.name === "docker") {
    const dockerProbe = await (probeOverrides.dockerImageToolProbe ?? probeDockerImageTools)(
      backend as DockerBackend,
      uniqueRequiredTools(),
    );
    const missingTools = new Set(dockerProbe.missingTools);
    const probeError = dockerProbe.error;

    for (const language of EXECUTABLE_LANGUAGES) {
      const missing = EXECUTION_TOOL_REQUIREMENTS[language].filter((tool) => missingTools.has(tool));
      languages[language] = !probeError && dockerProbe.imageExists && missing.length === 0
        ? { ready: true }
        : {
            ready: false,
            reason: probeError ?? `Execution runtime missing in configured Docker image: ${missing.join(", ")}.`,
          };
    }

    return {
      configured: Object.values(languages).some((entry) => entry.ready),
      backend: backend.name,
      productionSafe: backend.productionSafe,
      message: probeError,
      languages,
    };
  }

  for (const language of EXECUTABLE_LANGUAGES) {
    const missing: string[] = [];
    for (const tool of EXECUTION_TOOL_REQUIREMENTS[language]) {
      if (!(await hostCommandExists(tool))) missing.push(tool);
    }
    languages[language] = missing.length === 0
      ? { ready: true }
      : {
          ready: false,
          reason: `Execution runtime missing in configured sandbox: ${missing.join(", ")}.`,
        };
  }

  return {
    configured: Object.values(languages).some((entry) => entry.ready),
    backend: backend.name,
    productionSafe: backend.productionSafe,
    languages,
  };
}

const EXECUTION_TOOL_REQUIREMENTS: Record<ExecutionLanguage, string[]> = {
  c: ["gcc"],
  cpp: ["g++"],
  java: ["javac", "java"],
  python: ["python3"],
  javascript: ["node"],
  typescript: ["node"],
  bash: ["bash"],
};

async function requireTools(language: ExecutionLanguage, backend: SandboxBackend): Promise<string | null> {
  if (backend.name === "docker") return null;
  for (const tool of EXECUTION_TOOL_REQUIREMENTS[language]) {
    if (!(await commandExists(tool))) {
      return `Code execution is unavailable because the ${tool} runtime is missing from the configured sandbox environment.`;
    }
  }
  return null;
}

export function parseCppErrors(stderr: string, filename: string): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  const regex = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stderr)) !== null) {
    const [, file, lineStr, colStr, severityRaw, message] = match;
    if (!(file.includes(filename) || file.endsWith(".c") || file.endsWith(".cpp"))) continue;
    problems.push({
      file: filename,
      line: Number(lineStr),
      column: Number(colStr),
      message: message.trim(),
      severity: severityRaw.includes("error") ? "error" : severityRaw === "warning" ? "warning" : "info",
    });
  }
  return problems;
}


export function parseJavaErrors(stderr: string, filename: string): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  const lines = stderr.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(.+?\.java):(\d+):\s*(error|warning):\s*(.*)$/);
    if (!match) continue;
    const [, file, lineStr, severityRaw, message] = match;
    if (!(file === filename || file.endsWith(`/${filename}`) || file.endsWith(`\\${filename}`) || file.endsWith(".java"))) {
      continue;
    }

    const caretLine = lines[index + 2] ?? "";
    const caretIndex = caretLine.indexOf("^");
    const column = caretIndex >= 0 ? caretIndex + 1 : undefined;
    const severity = severityRaw === "warning" ? "warning" : "error";
    problems.push({
      file: filename,
      line: Number(lineStr),
      column,
      message: `Java compiler ${severity}: ${message.trim()}`,
      severity,
    });
  }
  return problems;
}

export function parseJavaRuntimeErrors(stderr: string, filename: string): ExecutionProblem[] {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const message = lines.find((line) => !line.startsWith("at ")) ?? "Java runtime error";
  for (const line of lines) {
    const match = line.match(/\(([^():]+\.java):(\d+)\)/);
    if (!match) continue;
    const file = match[1];
    if (!(file === filename || file.endsWith(`/${filename}`) || file.endsWith(`\\${filename}`))) continue;
    return [{
      file: filename,
      line: Number(match[2]),
      message,
      severity: "error",
    }];
  }
  return [];
}

export function parsePythonErrors(stderr: string, filename: string): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  const lines = stderr.split("\n");
  let lastLine: number | null = null;
  for (const line of lines) {
    const fileMatch = line.match(/File "([^"]+)", line (\d+)/);
    if (fileMatch && (fileMatch[1].includes(filename) || fileMatch[1].endsWith(".py"))) {
      lastLine = Number(fileMatch[2]);
    }
  }
  const exceptionLine = [...lines].reverse().find((line) => /^[A-Za-z_][\w.]*(Error|Exception|Warning)?\s*:/u.test(line.trim()))?.trim();
  if (lastLine !== null) {
    problems.push({
      file: filename,
      line: lastLine,
      message: exceptionLine || "Python error",
      severity: "error",
    });
  }
  return problems;
}

export function parseJsErrors(stderr: string, filename: string): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  const lines = stderr.split("\n");
  for (const line of lines) {
    const m = line.match(/(?:^|[/\\])[^/\\]*\.(?:js|ts):(\d+):(\d+)/);
    if (m) {
      problems.push({
        file: filename,
        line: Number(m[1]),
        column: Number(m[2]),
        message: line.trim(),
        severity: "error",
      });
      continue;
    }
    const syntax = line.match(/^(SyntaxError|ReferenceError|TypeError|RangeError):\s*(.*)$/);
    if (syntax && problems.length === 0) {
      problems.push({ file: filename, line: 1, message: line.trim(), severity: "error" });
    }
  }
  return problems;
}

export function parseBashErrors(stderr: string, filename: string): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  const regex = /(?:^|\n)(?:.*?\/)?(?:main\.sh|script\.sh|bash):\s*line\s*(\d+):\s*(.*?)(?=\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stderr)) !== null) {
    problems.push({
      file: filename,
      line: Number(match[1]),
      message: match[2].trim() || "Shell error",
      severity: "error",
    });
  }
  return problems;
}

function isMemoryLimit(result: SpawnResult): boolean {
  return /out of memory|cannot allocate memory|memory exhausted|memory limit|std::bad_alloc/i.test(result.stderr);
}

function statusFromRun(result: SpawnResult): ExecutionResult["status"] {
  if (result.timedOut) return "timeout";
  if (result.outputTruncated) return "output_limit";
  if (isMemoryLimit(result)) return "memory_limit";
  return result.exitCode === 0 ? "success" : "runtime_error";
}

function cleanSpawnResult(result: SpawnResult, workDir: string): SpawnResult {
  const cleaned = {
    ...result,
    stdout: cleanOutput(result.stdout, workDir),
    stderr: cleanOutput(result.stderr, workDir),
    spawnError: result.spawnError ? cleanOutput(result.spawnError, workDir) : undefined,
  };
  if (isMemoryLimit(cleaned)) {
    cleaned.stderr = "Execution exceeded the sandbox memory limit.";
  }
  return cleaned;
}

async function compileTypescript(code: string, workDir: string): Promise<{ ok: true; js: string } | { ok: false; stderr: string; problems: ExecutionProblem[] }> {
  try {
    const ts = await import("typescript");
    const filename = join(workDir, "main.ts");
    const output = ts.transpileModule(code, {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        strict: false,
        esModuleInterop: true,
      },
    });
    const errors = (output.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
      const problems = errors.map((diagnostic): ExecutionProblem => {
        const pos = diagnostic.file && typeof diagnostic.start === "number"
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : null;
        return {
          file: "main.ts",
          line: pos ? pos.line + 1 : 1,
          column: pos ? pos.character + 1 : 1,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          severity: "error",
        };
      });
      return { ok: false, stderr: problems.map((p) => `${p.file}:${p.line}:${p.column}: error: ${p.message}`).join("\n"), problems };
    }
    return { ok: true, js: output.outputText };
  } catch {
    return {
      ok: false,
      stderr: "TypeScript execution is unavailable because the TypeScript compiler package is not installed on the server.",
      problems: [],
    };
  }
}

export async function executeCode(
  language: ExecutionLanguage,
  code: string,
  stdin?: string,
): Promise<ExecutionResult> {
  const start = Date.now();

  if (code.length > MAX_CODE_SIZE) {
    return baseResult("execution_error", `Code too large: ${code.length} bytes exceeds ${MAX_CODE_SIZE} limit`, 0);
  }
  if (stdin && stdin.length > MAX_STDIN_SIZE) {
    return baseResult("execution_error", `Stdin too large: ${stdin.length} bytes exceeds ${MAX_STDIN_SIZE} limit`, 0);
  }

  const backend = await resolveBackend();
  if (!backend) return unavailable(backendUnavailableMessage(), start);

  const missing = await requireTools(language, backend);
  if (missing) return unavailable(missing, start);

  const execId = randomBytes(8).toString("hex");
  const workDir = join(tmpdir(), `tandem-exec-${execId}`);
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 });

  const run = async (command: string, args: string[], timeoutMs = TIMEOUT_MS) =>
    cleanSpawnResult(await backend.run(command, args, { cwd: workDir, stdin, timeoutMs }), workDir);
  const compile = async (command: string, args: string[], timeoutMs = COMPILE_TIMEOUT_MS) =>
    cleanSpawnResult(await backend.run(command, args, { cwd: workDir, timeoutMs }), workDir);

  try {
    switch (language) {
      case "python": {
        const filename = "main.py";
        await fs.writeFile(join(workDir, filename), code, "utf8");
        const result = await run("python3", [filename]);
        const problems = parsePythonErrors(result.stderr, filename);
        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems,
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        };
      }

      case "javascript": {
        const filename = "main.js";
        await fs.writeFile(join(workDir, filename), code, "utf8");
        const result = await run("node", [filename]);
        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: parseJsErrors(result.stderr, filename),
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        };
      }

      case "typescript": {
        const compiled = await compileTypescript(code, workDir);
        if (!compiled.ok) {
          return {
            status: "compile_error",
            stdout: "",
            stderr: compiled.stderr,
            exitCode: 1,
            duration: Date.now() - start,
            compilationOutput: compiled.stderr,
            problems: compiled.problems,
          };
        }
        const filename = "main.js";
        await fs.writeFile(join(workDir, filename), compiled.js, "utf8");
        const result = await run("node", [filename]);
        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: parseJsErrors(result.stderr, "main.ts"),
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        };
      }

      case "c": {
        const filename = "main.c";
        await fs.writeFile(join(workDir, filename), code, "utf8");
        const compiled = await compile("gcc", [filename, "-o", "main", "-lm"]);
        if (compiled.exitCode !== 0 || compiled.spawnError) {
          const stderr = compiled.spawnError ? "C compiler is unavailable in the execution sandbox." : compiled.stderr;
          return {
            status: compiled.spawnError ? "unavailable" : "compile_error",
            stdout: "",
            stderr,
            exitCode: compiled.exitCode,
            duration: Date.now() - start,
            compilationOutput: stderr,
            problems: parseCppErrors(stderr, filename),
          };
        }
        const result = await run("./main", []);
        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: [],
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        };
      }

      case "cpp": {
        const filename = "main.cpp";
        await fs.writeFile(join(workDir, filename), code, "utf8");
        const compiled = await compile("g++", [filename, "-o", "main", "-std=c++17"]);
        if (compiled.exitCode !== 0 || compiled.spawnError) {
          const stderr = compiled.spawnError ? "C++ compiler is unavailable in the execution sandbox." : compiled.stderr;
          return {
            status: compiled.spawnError ? "unavailable" : "compile_error",
            stdout: "",
            stderr,
            exitCode: compiled.exitCode,
            duration: Date.now() - start,
            compilationOutput: stderr,
            problems: parseCppErrors(stderr, filename),
          };
        }
        const result = await run("./main", []);
        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: [],
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        };
      }

      case "java": {
        const filename = "Main.java";
        await fs.writeFile(join(workDir, filename), code, "utf8");
        const compiled = await compile("javac", [...JAVAC_VM_ARGS, filename]);
        if (compiled.exitCode !== 0 || compiled.spawnError || compiled.timedOut || compiled.outputTruncated) {
          const stderr = compiled.spawnError ? "Java compiler is unavailable in the execution sandbox." : compiled.stderr;
          const status = compiled.spawnError
            ? "unavailable"
            : compiled.timedOut
              ? "timeout"
              : compiled.outputTruncated
                ? "output_limit"
                : "compile_error";
          return {
            status,
            stdout: "",
            stderr,
            exitCode: compiled.exitCode,
            duration: Date.now() - start,
            compilationOutput: stderr,
            problems: parseJavaErrors(stderr, filename),
            timedOut: compiled.timedOut,
            outputTruncated: compiled.outputTruncated,
          };
        }
        const result = await run("java", [...JAVA_VM_ARGS, "Main"]);
        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: parseJavaRuntimeErrors(result.stderr, filename),
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        };
      }

      case "bash": {
        const filename = "main.sh";
        await fs.writeFile(join(workDir, filename), code, "utf8");
        const result = await run("bash", [filename]);
        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: parseBashErrors(result.stderr, filename),
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        };
      }

      default:
        return unavailable(`Language ${language} execution is not supported.`, start);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
