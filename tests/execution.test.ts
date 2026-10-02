import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  createDockerContainerName,
  createDockerRunArgs,
  createDockerWorkspaceMount,
  createInteractiveTerminalCommand,
  executeCode,
  EXECUTION_TIMEOUT_MS,
  OUTPUT_LIMIT_BYTES,
  getExecutionAvailability,
  getExecutionTimeoutMs,
  INTERACTIVE_TERMINAL_WRAPPER,
  startInteractiveExecution,
  type InteractiveExecutionHandle,
  getHostExecutionPath,
  JAVAC_VM_ARGS,
  JAVA_COMPILE_TIMEOUT_MS,
  JAVA_MAIN_CLASS,
  JAVA_SOURCE_FILENAME,
  JAVA_VM_ARGS,
  normalizeBashSourceLineEndings,
  normalizeExecutionSource,
  prepareJavaWorkspace,
  writeInteractiveStdin,
  parseBashErrors,
  parseCppErrors,
  parseJavaErrors,
  parseJavaRuntimeErrors,
  parseJsErrors,
  parsePythonErrors,
  statusFromCompileLifecycle,
} from "@/lib/execution/executor";
import {
  EXECUTABLE_LANGUAGES,
  isExecutionLanguage,
  LANGUAGE_CONFIG,
  type ExecutionLanguage,
  type ExecutionResult,
  type ExecutionStreamEvent,
} from "@/lib/execution/types";
import {
  getActiveExecutionId,
  startExecutionSession,
  stopExecutionSession,
  writeExecutionStdin,
} from "@/lib/execution/interactiveSessions";
import { LANGUAGE_OPTIONS } from "@/lib/types";

let cachedJavaAvailability: Promise<{ ready: boolean; reason?: string }> | null = null;
let cachedDockerReady: Promise<boolean> | null = null;

async function dockerExecutionReady(): Promise<boolean> {
  cachedDockerReady ??= getExecutionAvailability().then(
    (availability) => availability.backend === "docker" && EXECUTABLE_LANGUAGES.every((language) => availability.languages[language].ready),
  );
  return cachedDockerReady;
}

async function runDockerWhenReady(language: ExecutionLanguage, code: string, stdin?: string) {
  if (!(await dockerExecutionReady())) return { skipped: true as const };
  return { skipped: false as const, result: await executeCode(language, code, stdin) };
}

async function waitForInteractiveEvent(
  events: ExecutionStreamEvent[],
  predicate: (event: ExecutionStreamEvent) => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for interactive execution event");
}

async function withExecutionTimeoutForTest<T>(
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.TANDEM_EXECUTION_TIMEOUT_MS;
  process.env.TANDEM_EXECUTION_TIMEOUT_MS = String(timeoutMs);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TANDEM_EXECUTION_TIMEOUT_MS;
    else process.env.TANDEM_EXECUTION_TIMEOUT_MS = previous;
  }
}

async function runInteractiveDockerWhenReady(
  language: ExecutionLanguage,
  code: string,
  drive?: (
    handle: InteractiveExecutionHandle,
    events: ExecutionStreamEvent[],
  ) => Promise<void> | void,
) {
  if (!(await dockerExecutionReady())) return { skipped: true as const };

  const events: ExecutionStreamEvent[] = [];
  const handle = startInteractiveExecution(language, code, {
    onEvent: (event) => events.push(event),
  });

  await drive?.(handle, events);
  const result = await handle.result;
  return { skipped: false as const, result, events };
}

async function javaAvailability(): Promise<{ ready: boolean; reason?: string }> {
  cachedJavaAvailability ??= getExecutionAvailability().then((availability) => availability.languages.java);
  return cachedJavaAvailability;
}

async function runJavaWhenAvailable(code: string, stdin?: string) {
  const availability = await javaAvailability();
  if (!availability.ready) return { skipped: true as const, availability };
  return { skipped: false as const, result: await executeCode("java", code, stdin) };
}

async function bashAvailability(): Promise<{ ready: boolean; reason?: string }> {
  return getExecutionAvailability().then((availability) => availability.languages.bash);
}

async function runBashWhenAvailable(code: string, stdin?: string) {
  const availability = await bashAvailability();
  if (!availability.ready) return { skipped: true as const, availability };
  return { skipped: false as const, result: await executeCode("bash", code, stdin) };
}

function multilineBashCrlfSource(): string {
  return [
    "",
    "#!/usr/bin/env bash",
    "",
    "",
    "set -u",
    "",
    "greet() {",
    "  local target=\"$1\"",
    "  echo \"Hello, $target\"",
    "}",
    "",
    "echo \"Hello\"",
    "",
    "printf \"Enter name: \"",
    "read -r NAME",
    "",
    "for i in 1 2 3; do",
    "    echo \"Item $i\"",
    "done",
    "",
    "greet \"$NAME\"",
    "",
    "",
  ].join("\r\n");
}

function expectMultilineBashCrlfSource(source: string) {
  expect(source).toContain("\r\n\r\n");
  expect(source).toContain("read -r NAME\r\n");
  expect(source).toContain("for i in 1 2 3; do\r\n");
  expect(source.endsWith("\r\n")).toBe(true);
}

async function requireDockerReadyForTest(): Promise<boolean> {
  if (await dockerExecutionReady()) return true;
  expect(await dockerExecutionReady()).toBe(false);
  return false;
}

type DockerCase = {
  language: ExecutionLanguage;
  code: string;
  stdin?: string;
  stdout?: string | RegExp;
  stderr?: string | RegExp;
  status?: ExecutionResult["status"];
  exitCode?: number | null;
};

function expectText(actual: string, expected: string | RegExp, label: string) {
  if (typeof expected === "string") {
    expect(actual, label).toBe(expected);
    return;
  }

  expect(actual, label).toMatch(expected);
}

async function runDockerCase(testCase: DockerCase): Promise<ExecutionResult | null> {
  const execution = await runDockerWhenReady(
    testCase.language,
    testCase.code,
    testCase.stdin,
  );

  expect(execution.skipped, testCase.language).toBe(false);
  if (execution.skipped) return null;

  expect(execution.result.status, testCase.language).toBe(testCase.status ?? "success");

  if (testCase.stdout !== undefined) {
    expectText(execution.result.stdout.trim(), testCase.stdout, `${testCase.language} stdout`);
  }

  if (testCase.stderr !== undefined) {
    expectText(execution.result.stderr.trim(), testCase.stderr, `${testCase.language} stderr`);
  }

  if (testCase.exitCode !== undefined) {
    expect(execution.result.exitCode, `${testCase.language} exitCode`).toBe(testCase.exitCode);
  }

  return execution.result;
}

function repeatedOutputCases(byteCount: number): DockerCase[] {
  const jsCode = `process.stdout.write("x".repeat(${byteCount}));\n`;
  const bashChunk = "x".repeat(1024);
  const bashFullChunks = Math.floor(byteCount / 1024);
  const bashRemainder = byteCount % 1024;

  return [
    {
      language: "c",
      code: `#include <stdio.h>
int main(void) { for (int i = 0; i < ${byteCount}; i++) putchar('x'); return 0; }
`,
    },
    {
      language: "cpp",
      code: `#include <iostream>
int main() { for (int i = 0; i < ${byteCount}; i++) std::cout.put('x'); return 0; }
`,
    },
    {
      language: "java",
      code: `import java.util.Arrays;
public class Main {
  public static void main(String[] args) {
    char[] chunk = new char[1024];
    Arrays.fill(chunk, 'x');
    String value = new String(chunk);
    int fullChunks = ${Math.floor(byteCount / 1024)};
    int remainder = ${byteCount % 1024};
    for (int i = 0; i < fullChunks; i++) System.out.print(value);
    for (int i = 0; i < remainder; i++) System.out.print('x');
  }
}
`,
    },
    { language: "python", code: `import sys
sys.stdout.write("x" * ${byteCount})
sys.stdout.flush()
` },
    { language: "javascript", code: jsCode },
    { language: "typescript", code: jsCode },
    {
      language: "bash",
      code: `chunk='${bashChunk}'
for ((i=0; i<${bashFullChunks}; i++)); do printf "%s" "$chunk"; done
if [ ${bashRemainder} -gt 0 ]; then printf "%.*s" ${bashRemainder} "$chunk"; fi
`,
    },
  ];
}

describe("execution language registry", () => {
  it("keeps visible executable languages aligned with the executor", () => {
    const executableOptions = LANGUAGE_OPTIONS.filter((option) => option.executable).map((option) => option.id).sort();
    expect(executableOptions).toEqual([...EXECUTABLE_LANGUAGES].sort());
    for (const language of EXECUTABLE_LANGUAGES) {
      expect(isExecutionLanguage(language)).toBe(true);
      expect(LANGUAGE_CONFIG[language].executable).toBe(true);
    }
  });

  it("advertises only supported executable V1 languages", () => {
    const ids = LANGUAGE_OPTIONS.map((option) => option.id);
    expect(ids).toContain("java");
    expect(isExecutionLanguage("java")).toBe(true);
    expect(ids).not.toContain("go");
    expect(ids).not.toContain("rust");
    expect(ids).not.toContain("sql");
    expect(ids).not.toContain("yaml");
    expect(ids).toContain("bash");
  });
});

describe("host executor environment", () => {
  it("preserves the host PATH for Windows Docker CLI discovery", () => {
    const windowsPath = "C:\\Windows\\System32;C:\\Tools\\Docker\\bin";
    expect(getHostExecutionPath("win32", windowsPath)).toBe(windowsPath);
    expect(getHostExecutionPath("win32", windowsPath)).toContain("Docker");
    expect(getHostExecutionPath("win32", windowsPath)).not.toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  });

  it("keeps the restricted Linux PATH for Linux host sandbox commands", () => {
    expect(getHostExecutionPath("linux", "/custom/docker/bin")).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  });
});

describe("Docker execution readiness", () => {
  it("uses a Docker-valid writable workspace bind mount", () => {
    const mount = createDockerWorkspaceMount("C:\\Users\\Ada\\AppData\\Local\\Temp\\tandem-exec-1234");
    expect(mount).toBe("C:\\Users\\Ada\\AppData\\Local\\Temp\\tandem-exec-1234:/workspace:rw");
    expect(mount).not.toContain("nosuid");
    expect(mount.endsWith(":/workspace:rw")).toBe(true);
  });

  it("derives a stable Docker container name from the isolated workspace", () => {
    expect(createDockerContainerName("C:\\Users\\Ada\\AppData\\Local\\Temp\\tandem-exec-1234")).toBe("tandem-exec-1234");
    expect(createDockerContainerName("/tmp/tandem-exec-abcd1234")).toBe("tandem-exec-abcd1234");
  });

  it("passes stdin to docker run without allocating a TTY", () => {
    const args = createDockerRunArgs({
      image: "tandem-executor:test",
      containerName: "tandem-exec-stdin-test",
      workDir: "C:\\Users\\Ada\\AppData\\Local\\Temp\\tandem-exec-stdin-test",
      command: "python3",
      args: ["main.py"],
      timeoutMs: 10_000,
    });
    const imageIndex = args.indexOf("tandem-executor:test");
    const dockerStdinIndex = args.indexOf("-i");
    const script = args[args.indexOf("-lc") + 1];

    expect(args[0]).toBe("run");
    expect(args[1]).toBe("--rm");
    expect(dockerStdinIndex).toBeGreaterThanOrEqual(0);
    expect(dockerStdinIndex).toBeLessThan(imageIndex);
    expect(args).not.toContain("-t");
    expect(args[imageIndex + 1]).toBe("-i"); // /usr/bin/env -i still clears the container env.
    expect(args).toEqual(expect.arrayContaining([
      "--network", "none",
      "--cpus", "0.5",
      "--memory", String(768 * 1024 * 1024),
      "--pids-limit", "96",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "--user", "65534:65534",
    ]));
    expect(script).toContain("ulimit -t 11");
    expect(script).toContain("ulimit -f 4096");
    expect(script).toContain("ulimit -u 96");
    expect(script).not.toContain("ulimit -v");
  });

  it("defaults Docker execution CPU limit to the 10 minute hard timeout", () => {
    const previous = process.env.TANDEM_EXECUTION_TIMEOUT_MS;
    try {
      delete process.env.TANDEM_EXECUTION_TIMEOUT_MS;
      const args = createDockerRunArgs({
        image: "tandem-executor:test",
        containerName: "tandem-exec-timeout-test",
        workDir: "/tmp/tandem-exec-timeout-test",
        command: "node",
        args: ["main.js"],
      });
      const script = args[args.indexOf("-lc") + 1];
      expect(script).toContain("ulimit -t 601");
    } finally {
      if (previous === undefined) delete process.env.TANDEM_EXECUTION_TIMEOUT_MS;
      else process.env.TANDEM_EXECUTION_TIMEOUT_MS = previous;
    }
  });

  it("wraps interactive programs in an in-container PTY without changing Docker TTY flags", () => {
    const terminal = createInteractiveTerminalCommand("./main", ["--sample"]);
    expect(terminal.command).toBe("python3");
    expect(terminal.args.slice(0, 3)).toEqual(["-c", INTERACTIVE_TERMINAL_WRAPPER, "./main"]);
    expect(terminal.args).toContain("--sample");
    expect(INTERACTIVE_TERMINAL_WRAPPER).toContain("os.openpty()");
    expect(INTERACTIVE_TERMINAL_WRAPPER).toContain("termios.ECHO");
    expect(INTERACTIVE_TERMINAL_WRAPPER).toContain("stderr=subprocess.PIPE");

    const args = createDockerRunArgs({
      image: "tandem-executor:test",
      containerName: "tandem-exec-pty-test",
      workDir: "/tmp/tandem-exec-pty-test",
      command: terminal.command,
      args: terminal.args,
      timeoutMs: 10_000,
    });

    const imageIndex = args.indexOf("tandem-executor:test");
    expect(args).toContain("-i");
    expect(args).not.toContain("-t");
    expect(args[imageIndex + 1]).toBe("-i");
    expect(args).toEqual(expect.arrayContaining([
      "--network", "none",
      "--cpus", "0.5",
      "--memory", String(768 * 1024 * 1024),
      "--pids-limit", "96",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "--user", "65534:65534",
    ]));
  });

  it("checks language runtimes inside the Docker image instead of on the host", async () => {
    const previousBackend = process.env.TANDEM_EXECUTION_BACKEND;
    const previousImage = process.env.TANDEM_EXECUTION_IMAGE;
    const hostChecks: string[] = [];

    process.env.TANDEM_EXECUTION_BACKEND = "docker";
    process.env.TANDEM_EXECUTION_IMAGE = "tandem-executor:test";

    try {
      const availability = await getExecutionAvailability({
        commandExists: async (command) => {
          hostChecks.push(command);
          return command === "docker";
        },
        dockerImageToolProbe: async (backend, tools) => {
          expect(backend.image).toBe("tandem-executor:test");
          expect(tools).toEqual(expect.arrayContaining(["gcc", "g++", "javac", "java", "python3", "node", "bash"]));
          return { imageExists: true, availableTools: [...tools], missingTools: [] };
        },
      });

      expect(hostChecks).toEqual(["docker"]);
      expect(hostChecks).not.toEqual(expect.arrayContaining(["gcc", "g++", "javac", "java", "python3", "node", "bash"]));
      expect(availability.configured).toBe(true);
      expect(availability.backend).toBe("docker");
      expect(availability.productionSafe).toBe(true);
      for (const language of EXECUTABLE_LANGUAGES) {
        expect(availability.languages[language].ready).toBe(true);
      }
    } finally {
      if (previousBackend === undefined) delete process.env.TANDEM_EXECUTION_BACKEND;
      else process.env.TANDEM_EXECUTION_BACKEND = previousBackend;
      if (previousImage === undefined) delete process.env.TANDEM_EXECUTION_IMAGE;
      else process.env.TANDEM_EXECUTION_IMAGE = previousImage;
    }
  });
});

describe("Java sandbox configuration", () => {
  it("uses a Java-specific bounded compile timeout", () => {
    expect(JAVA_COMPILE_TIMEOUT_MS).toBe(20_000);
  });

  it("uses container-friendly JVM flags for both javac and java", () => {
    expect(JAVA_VM_ARGS).toEqual(expect.arrayContaining([
      "-Xmx256m",
      "-XX:+UseSerialGC",
      "-XX:ActiveProcessorCount=1",
      "-Xss512k",
      "-XX:CICompilerCount=1",
      "-XX:TieredStopAtLevel=1",
      "-XX:MaxMetaspaceSize=128m",
      "-XX:ReservedCodeCacheSize=32m",
      "-XX:-UsePerfData",
      "-Djava.io.tmpdir=.",
    ]));
    expect(JAVAC_VM_ARGS).toEqual(JAVA_VM_ARGS.map((arg) => `-J${arg}`));
  });

  it("always prepares Java source as Main.java and removes stale Java artifacts", async () => {
    const workDir = await fs.mkdtemp(join(tmpdir(), "tandem-java-test-"));
    try {
      await fs.writeFile(join(workDir, "test.java"), "public class test {}", "utf8");
      await fs.writeFile(join(workDir, "test.class"), "stale", "utf8");
      await fs.writeFile(join(workDir, "Main.class"), "stale", "utf8");
      const source = "public class Main { public static void main(String[] args) {} }";

      await prepareJavaWorkspace(workDir, source);

      expect(JAVA_SOURCE_FILENAME).toBe("Main.java");
      expect(JAVA_MAIN_CLASS).toBe("Main");
      expect(await fs.readFile(join(workDir, "Main.java"), "utf8")).toBe(source);
      await expect(fs.access(join(workDir, "test.java"))).rejects.toThrow();
      await expect(fs.access(join(workDir, "test.class"))).rejects.toThrow();
      await expect(fs.access(join(workDir, "Main.class"))).rejects.toThrow();
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("execution lifecycle classification", () => {
  it("uses a 10 minute hard execution timeout and caps test overrides to that limit", () => {
    const previous = process.env.TANDEM_EXECUTION_TIMEOUT_MS;
    try {
      delete process.env.TANDEM_EXECUTION_TIMEOUT_MS;
      expect(EXECUTION_TIMEOUT_MS).toBe(600_000);
      expect(getExecutionTimeoutMs()).toBe(600_000);

      process.env.TANDEM_EXECUTION_TIMEOUT_MS = "1200";
      expect(getExecutionTimeoutMs()).toBe(1200);

      process.env.TANDEM_EXECUTION_TIMEOUT_MS = "900000";
      expect(getExecutionTimeoutMs()).toBe(600_000);
    } finally {
      if (previous === undefined) delete process.env.TANDEM_EXECUTION_TIMEOUT_MS;
      else process.env.TANDEM_EXECUTION_TIMEOUT_MS = previous;
    }
  });

  it("normalizes multiline Bash CRLF and lone-CR source without changing LF-only scripts", () => {
    const crlfSource = multilineBashCrlfSource();
    expectMultilineBashCrlfSource(crlfSource);

    const lfOnly = crlfSource.replace(/\r\n/g, "\n");
    expect(normalizeBashSourceLineEndings(lfOnly)).toBe(lfOnly);
    expect(normalizeBashSourceLineEndings(crlfSource)).toBe(lfOnly);
    expect(normalizeBashSourceLineEndings(lfOnly.replace(/\n/g, "\r"))).toBe(lfOnly);
    expect(normalizeExecutionSource("bash", crlfSource)).toBe(lfOnly);
    expect(normalizeExecutionSource("python", crlfSource)).toBe(crlfSource);
  });

  it("preserves timeout state for killed compile processes", () => {
    expect(statusFromCompileLifecycle({ timedOut: true, outputTruncated: false, stderr: "" })).toBe("timeout");
    expect(statusFromCompileLifecycle({ timedOut: false, outputTruncated: false, stderr: "Main.java:1: error: ';' expected" })).toBe("compile_error");
  });

  it("treats stdin pipe backpressure as an accepted interactive write", () => {
    let received = "";
    const stream = {
      destroyed: false,
      writableEnded: false,
      write(chunk: string) {
        received += chunk;
        return false;
      },
    };

    expect(writeInteractiveStdin(stream, "3\n")).toBe(true);
    expect(received).toBe("3\n");

    stream.writableEnded = true;
    expect(writeInteractiveStdin(stream, "4\n")).toBe(false);
    expect(received).toBe("3\n");
  });

  it("delivers repeated complete stdin lines without coalescing or dropping the first line", () => {
    const chunks: string[] = [];
    const stream = {
      destroyed: false,
      writableEnded: false,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    };

    expect(writeInteractiveStdin(stream, "10\n")).toBe(true);
    expect(writeInteractiveStdin(stream, "11\n")).toBe(true);
    expect(chunks).toEqual(["10\n", "11\n"]);
  });
});

describe("execution diagnostics parsers", () => {
  it("parses C/C++ compiler diagnostics", () => {
    expect(parseCppErrors("main.cpp:12:9: error: expected ';' before '}' token", "main.cpp")).toEqual([
      expect.objectContaining({ file: "main.cpp", line: 12, column: 9, severity: "error" }),
    ]);
  });

  it("parses Java compiler diagnostics with line and column", () => {
    const stderr = [
      "Main.java:6: error: ';' expected",
      "        System.out.println(\"oops\")",
      "                                  ^",
      "1 error",
    ].join("\n");
    expect(parseJavaErrors(stderr, "Main.java")).toEqual([
      expect.objectContaining({
        file: "Main.java",
        line: 6,
        column: 35,
        severity: "error",
        message: "Java compiler error: ';' expected",
      }),
    ]);
  });

  it("parses Java runtime stack locations", () => {
    const stderr = [
      'Exception in thread "main" java.lang.RuntimeException: boom',
      "\tat Main.main(Main.java:4)",
    ].join("\n");
    expect(parseJavaRuntimeErrors(stderr, "Main.java")).toEqual([
      expect.objectContaining({ file: "Main.java", line: 4, message: 'Exception in thread "main" java.lang.RuntimeException: boom' }),
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

describe("Java execution", () => {
  it("executes Hello World through the sandbox when Java is available", async () => {
    const execution = await runJavaWhenAvailable(`public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, Tandem!");
    }
}
`);
    if (execution.skipped) {
      expect(execution.availability.ready).toBe(false);
      expect(execution.availability.reason).toBeTruthy();
      return;
    }
    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout.trim()).toBe("Hello, Tandem!");
    expect(execution.result.stderr).toBe("");
    expect(execution.result.exitCode).toBe(0);
  }, 20_000);

  it("executes Java arithmetic", async () => {
    const execution = await runJavaWhenAvailable(`public class Main {
    public static void main(String[] args) {
        int left = 6;
        int right = 7;
        System.out.println(left * right);
    }
}
`);
    if (execution.skipped) {
      expect(execution.availability.ready).toBe(false);
      return;
    }
    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout.trim()).toBe("42");
  }, 20_000);

  it("passes stdin to Java Scanner", async () => {
    const execution = await runJavaWhenAvailable(`import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        String name = scanner.nextLine();
        int value = scanner.nextInt();
        System.out.println(name + ":" + (value * 2));
    }
}
`, "Tandem\n21\n");
    if (execution.skipped) {
      expect(execution.availability.ready).toBe(false);
      return;
    }
    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout.trim()).toBe("Tandem:42");
  }, 20_000);

  it("returns Java compilation diagnostics as Problems", async () => {
    const execution = await runJavaWhenAvailable(`public class Main {
    public static void main(String[] args) {
        System.out.println("missing semicolon")
    }
}
`);
    if (execution.skipped) {
      expect(execution.availability.ready).toBe(false);
      return;
    }
    expect(execution.result.status).toBe("compile_error");
    expect(execution.result.stdout).toBe("");
    expect(execution.result.stderr).toContain("Main.java:3: error");
    expect(execution.result.stderr).not.toMatch(/tandem-exec|\/tmp\//i);
    expect(execution.result.problems).toEqual([
      expect.objectContaining({ file: "Main.java", line: 3, severity: "error" }),
    ]);
  }, 20_000);

  it("captures Java runtime errors without host internals", async () => {
    const execution = await runJavaWhenAvailable(`public class Main {
    public static void main(String[] args) {
        throw new RuntimeException("boom");
    }
}
`);
    if (execution.skipped) {
      expect(execution.availability.ready).toBe(false);
      return;
    }
    expect(execution.result.status).toBe("runtime_error");
    expect(execution.result.stdout).toBe("");
    expect(execution.result.stderr).toContain("RuntimeException: boom");
    expect(execution.result.stderr).toContain("Main.java:3");
    expect(execution.result.stderr).not.toMatch(/docker|tandem-exec|\/tmp\//i);
  }, 20_000);

  it("times out runaway Java programs", async () => {
    const execution = await withExecutionTimeoutForTest(1_500, () =>
      runJavaWhenAvailable(`public class Main {
    public static void main(String[] args) {
        while (true) {
        }
    }
}
`),
    );
    if (execution.skipped) {
      expect(execution.availability.ready).toBe(false);
      return;
    }
    expect(execution.result.status).toBe("timeout");
    expect(execution.result.timedOut).toBe(true);
  }, 25_000);
});

describe("interactive execution sessions", () => {
  it("runs a program that reads one integer from stdin", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "python",
      `value = int(input())
print(value * 2)
`,
      async (handle) => {
        handle.writeStdin("21\n");
      },
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout.trim()).toBe("42");
    expect(execution.events.some((event) => event.type === "stdout" && event.chunk.includes("42"))).toBe(true);
  }, 20_000);

  it("runs a program that reads multiple values sequentially", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "python",
      `first = int(input())
second = int(input())
third = int(input())
print(first + second + third)
`,
      async (handle) => {
        handle.writeStdin("10\n");
        handle.writeStdin("20\n");
        handle.writeStdin("5\n");
      },
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout.trim()).toBe("35");
  }, 20_000);

  it("keeps interactive sessions alive while waiting more than 10 seconds for stdin", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "python",
      [
        "import sys",
        "sys.stdout.write('ready for stdin\\n')",
        "sys.stdout.flush()",
        "value = sys.stdin.readline().strip()",
        "print(f'Received: {value}')",
      ].join("\n"),
      async (handle, events) => {
        await waitForInteractiveEvent(
          events,
          (event) => event.type === "stdout" && event.chunk.includes("ready for stdin"),
          15_000,
        );
        const waitStartedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 10_500));
        expect(Date.now() - waitStartedAt).toBeGreaterThanOrEqual(10_000);
        expect(handle.writeStdin("10\n")).toBe(true);
      },
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout).toContain("Received: 10");
  }, 35_000);

  it("delivers the first submitted C stdin line immediately", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "c",
      `#include <stdio.h>
int main(void) {
    int n;
    printf("Enter number of students: ");
    fflush(stdout);
    if (scanf("%d", &n) != 1) return 2;
    printf("Received: %d\\n", n);
    return 0;
}
`,
      async (handle, events) => {
        await waitForInteractiveEvent(
          events,
          (event) => event.type === "stdout" && event.chunk.includes("Enter number of students:"),
        );
        expect(handle.writeStdin("10\n")).toBe(true);
      },
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout).toContain("Received: 10");
  }, 20_000);

  it("streams an unflushed C prompt before accepting stdin", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "c",
      `#include <stdio.h>
int main(void) {
    int a, b;
    printf("Enter two numbers: ");
    if (scanf("%d %d", &a, &b) != 2) return 2;
    printf("Sum = %d\\n", a + b);
    return 0;
}
`,
      async (handle, events) => {
        await waitForInteractiveEvent(
          events,
          (event) => event.type === "stdout" && event.chunk.includes("Enter two numbers:"),
        );
        expect(events.some((event) => event.type === "stdout" && event.chunk.includes("Sum ="))).toBe(false);
        handle.writeStdin("2 3\n");
      },
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout).toContain("Enter two numbers:");
    expect(execution.result.stdout).toContain("Sum = 5");
  }, 20_000);

  it("accepts browser-style sequential lines for one scanf format", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "c",
      `#include <stdio.h>
int main(void) {
    int a, b;
    printf("Enter two numbers: ");
    if (scanf("%d %d", &a, &b) != 2) return 2;
    printf("Sum = %d\\n", a + b);
    return 0;
}
`,
      async (handle, events) => {
        await waitForInteractiveEvent(
          events,
          (event) => event.type === "stdout" && event.chunk.includes("Enter two numbers:"),
        );
        expect(handle.writeStdin("2\n")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(events.some((event) => event.type === "stdout" && event.chunk.includes("Sum ="))).toBe(false);
        expect(handle.writeStdin("3\n")).toBe(true);
      },
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout).toContain("Enter two numbers:");
    expect(execution.result.stdout).toContain("Sum = 5");
  }, 20_000);

  it("streams a prompt before accepting stdin", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "python",
      `print("Enter number:", end="", flush=True)
value = input()
print(" got " + value)
`,
      async (handle, events) => {
        await waitForInteractiveEvent(
          events,
          (event) => event.type === "stdout" && event.chunk.includes("Enter number:"),
        );
        handle.writeStdin("7\n");
      },
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout).toContain("Enter number:");
    expect(execution.result.stdout).toContain("got 7");
  }, 20_000);

  it("streams sequential C prompts before each stdin line", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "c",
      `#include <stdio.h>
int main(void) {
    int n;
    printf("Enter 1: ");
    if (scanf("%d", &n) != 1) return 2;
    printf("Enter 2: ");
    if (scanf("%d", &n) != 1) return 3;
    printf("Done\\n");
    return 0;
}
`,
      async (handle, events) => {
        await waitForInteractiveEvent(
          events,
          (event) => event.type === "stdout" && event.chunk.includes("Enter 1:"),
        );
        expect(events.some((event) => event.type === "stdout" && event.chunk.includes("Enter 2:"))).toBe(false);
        handle.writeStdin("2\n");
        await waitForInteractiveEvent(
          events,
          (event) => event.type === "stdout" && event.chunk.includes("Enter 2:"),
        );
        expect(events.some((event) => event.type === "stdout" && event.chunk.includes("Done"))).toBe(false);
        handle.writeStdin("3\n");
      },
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout).toContain("Enter 1:");
    expect(execution.result.stdout).toContain("Enter 2:");
    expect(execution.result.stdout).toContain("Done");
  }, 20_000);

  it("runs programs that exit without stdin", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "python",
      "print('no input needed')\n",
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout.trim()).toBe("no input needed");
  }, 20_000);

  it("times out programs that exceed the configured timeout", async () => {
    const execution = await withExecutionTimeoutForTest(1_500, () =>
      runInteractiveDockerWhenReady(
        "python",
        "import time\ntime.sleep(20)\n",
      ),
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("timeout");
    expect(execution.result.timedOut).toBe(true);
  }, 25_000);

  it("stops programs that exceed the existing output limit", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "python",
      "import sys\nsys.stdout.write('x' * (1024 * 1024 + 4096))\nsys.stdout.flush()\n",
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("output_limit");
    expect(execution.result.outputTruncated).toBe(true);
    expect(execution.result.stdout).toContain("[Output truncated: exceeded 1MB limit]");
  }, 25_000);

  it("cancels a running interactive execution", async () => {
    const execution = await runInteractiveDockerWhenReady(
      "python",
      "import time\nprint('ready', flush=True)\nwhile True:\n    time.sleep(0.1)\n",
      async (handle, events) => {
        await waitForInteractiveEvent(
          events,
          (event) => event.type === "stdout" && event.chunk.includes("ready"),
        );
        handle.stop();
      },
    );

    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("cancelled");
    expect(execution.result.stderr).toBe("Execution stopped by user.");
  }, 20_000);

  it("keeps interactive Bash read working through execution sessions with multiline CRLF source", async () => {
    const availability = await bashAvailability();
    if (!availability.ready) {
      expect(availability.reason).toBeTruthy();
      return;
    }

    const crlfScript = multilineBashCrlfSource();
    expectMultilineBashCrlfSource(crlfScript);

    const events: ExecutionStreamEvent[] = [];
    const owner = {
      roomCode: "BASHCR",
      userId: "user-bash-crlf",
      sessionId: "session-bash-crlf",
    };
    const session = startExecutionSession({
      ...owner,
      language: "bash",
      code: crlfScript,
      onEvent: (event) => events.push(event),
    });

    if ("error" in session) {
      throw new Error(session.error);
    }

    try {
      await waitForInteractiveEvent(
        events,
        (event) => event.type === "stdout" && event.chunk.includes("Enter name:"),
      );
      expect(writeExecutionStdin(session.id, owner, "Ada\n")).toBe(true);
      const result = await session.done;

      expect(result.status).toBe("success");
      expect(result.stdout).toContain("Hello");
      expect(result.stdout).toContain("Item 1");
      expect(result.stdout).toContain("Item 2");
      expect(result.stdout).toContain("Item 3");
      expect(result.stdout).toContain("Hello, Ada");
      expect(result.stderr).not.toMatch(/not a valid identifier|\$'\\r'|command not found|unexpected token/);
    } finally {
      session.stop();
      await session.done.catch(() => undefined);
    }
  }, 20_000);

  it("does not route stdin to another user or room execution", async () => {
    const session = startExecutionSession({
      roomCode: "ROOMA1",
      userId: "user-a",
      sessionId: "session-a",
      language: "python",
      code: "value = input()\nprint(value)\n",
    });

    if ("error" in session) {
      throw new Error(session.error);
    }

    try {
      expect(
        writeExecutionStdin(
          session.id,
          { roomCode: "ROOMA1", userId: "user-b", sessionId: "session-a" },
          "wrong-user\n",
        ),
      ).toBe(false);
      expect(
        writeExecutionStdin(
          session.id,
          { roomCode: "ROOMB2", userId: "user-a", sessionId: "session-a" },
          "wrong-room\n",
        ),
      ).toBe(false);
      expect(
        writeExecutionStdin(
          session.id,
          { roomCode: "ROOMA1", userId: "user-a", sessionId: "session-b" },
          "wrong-session\n",
        ),
      ).toBe(false);
      expect(
        writeExecutionStdin(
          session.id,
          { roomCode: "ROOMA1", userId: "user-a", sessionId: "session-a" },
          "right-owner\n",
        ),
      ).toBe(true);
    } finally {
      session.stop();
      await session.done.catch(() => undefined);
    }
  });
});

describe("Docker-backed execution audit matrix", () => {
  it("runs deterministic successful programs for every executable language", async () => {
    if (!(await requireDockerReadyForTest())) return;

    const cases: DockerCase[] = [
      {
        language: "c",
        code: `#include <stdio.h>
int main(void) { printf("c-basic:%d\\n", 6 * 7); return 0; }
`,
        stdout: "c-basic:42",
        stderr: "",
        exitCode: 0,
      },
      {
        language: "cpp",
        code: `#include <iostream>
int main() { std::cout << "cpp-basic:" << (6 * 7) << std::endl; return 0; }
`,
        stdout: "cpp-basic:42",
        stderr: "",
        exitCode: 0,
      },
      {
        language: "java",
        code: `public class Main {
  public static void main(String[] args) { System.out.println("java-basic:" + (6 * 7)); }
}
`,
        stdout: "java-basic:42",
        stderr: "",
        exitCode: 0,
      },
      { language: "python", code: "print(f'python-basic:{6 * 7}')\n", stdout: "python-basic:42", stderr: "", exitCode: 0 },
      { language: "javascript", code: "console.log(`js-basic:${6 * 7}`);\n", stdout: "js-basic:42", stderr: "", exitCode: 0 },
      { language: "typescript", code: "const value: number = 6 * 7;\nconsole.log(`ts-basic:${value}`);\n", stdout: "ts-basic:42", stderr: "", exitCode: 0 },
      { language: "bash", code: "echo \"bash-basic:$((6 * 7))\"\n", stdout: "bash-basic:42", stderr: "", exitCode: 0 },
    ];

    for (const testCase of cases) {
      await runDockerCase(testCase);
    }
  }, 90_000);

  it("handles stdin whitespace, multiple lines, numbers, strings, empty input, EOF, and invalid values", async () => {
    if (!(await requireDockerReadyForTest())) return;

    const structuredInput = "Ada Lovelace\n21 token\n";
    const structuredCases: DockerCase[] = [
      {
        language: "c",
        stdin: structuredInput,
        code: `#include <stdio.h>
#include <string.h>
int main(void) {
  char name[80] = {0};
  char word[80] = {0};
  int value = 0;
  if (!fgets(name, sizeof(name), stdin)) return 2;
  name[strcspn(name, "\\n")] = 0;
  if (scanf("%d %79s", &value, word) != 2) return 3;
  printf("name=%s;number=%d;word=%s\\n", name, value * 2, word);
  return 0;
}
`,
        stdout: "name=Ada Lovelace;number=42;word=token",
      },
      {
        language: "cpp",
        stdin: structuredInput,
        code: `#include <iostream>
#include <string>
int main() {
  std::string name, word;
  int value = 0;
  std::getline(std::cin, name);
  std::cin >> value >> word;
  std::cout << "name=" << name << ";number=" << value * 2 << ";word=" << word << std::endl;
  return 0;
}
`,
        stdout: "name=Ada Lovelace;number=42;word=token",
      },
      {
        language: "java",
        stdin: structuredInput,
        code: `import java.util.Scanner;
public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    String name = sc.nextLine();
    int value = sc.nextInt();
    String word = sc.next();
    System.out.println("name=" + name + ";number=" + (value * 2) + ";word=" + word);
  }
}
`,
        stdout: "name=Ada Lovelace;number=42;word=token",
      },
      {
        language: "python",
        stdin: structuredInput,
        code: `name = input()
value, word = input().split()
print(f"name={name};number={int(value) * 2};word={word}")
`,
        stdout: "name=Ada Lovelace;number=42;word=token",
      },
      {
        language: "javascript",
        stdin: structuredInput,
        code: `const fs = require("fs");
const lines = fs.readFileSync(0, "utf8").split(/\\r?\\n/);
const name = lines[0];
const [value, word] = lines[1].split(/\\s+/);
console.log(` + "`name=${name};number=${Number(value) * 2};word=${word}`" + `);
`,
        stdout: "name=Ada Lovelace;number=42;word=token",
      },
      {
        language: "typescript",
        stdin: structuredInput,
        code: `const fs = require("fs");
const lines = fs.readFileSync(0, "utf8").split(/\\r?\\n/);
const name = lines[0];
const [value, word] = lines[1].split(/\\s+/);
console.log(` + "`name=${name};number=${Number(value) * 2};word=${word}`" + `);
`,
        stdout: "name=Ada Lovelace;number=42;word=token",
      },
      {
        language: "bash",
        stdin: structuredInput,
        code: `read -r name
read -r value word
echo "name=$name;number=$((value * 2));word=$word"
`,
        stdout: "name=Ada Lovelace;number=42;word=token",
      },
    ];

    for (const testCase of structuredCases) {
      await runDockerCase(testCase);
    }

    const eofCases: DockerCase[] = [
      { language: "c", stdin: "", code: `#include <stdio.h>
int main(void) { int value = 123; int rc = scanf("%d", &value); printf("eof=%d;value=%d\\n", rc == EOF, value); return 0; }
`, stdout: "eof=1;value=123" },
      { language: "cpp", stdin: "", code: `#include <iostream>
int main() { int value = 123; std::cout << "eof=" << (!(std::cin >> value)) << ";value=" << value << std::endl; return 0; }
`, stdout: "eof=1;value=123" },
      { language: "java", stdin: "", code: `import java.util.Scanner;
public class Main { public static void main(String[] args) { Scanner sc = new Scanner(System.in); System.out.println("eof=" + (!sc.hasNext()) + ";value=123"); } }
`, stdout: "eof=true;value=123" },
      { language: "python", stdin: "", code: "import sys\nprint(f'eof={sys.stdin.read() == \"\"};value=123')\n", stdout: "eof=True;value=123" },
      { language: "javascript", stdin: "", code: "const fs = require('fs'); const data = fs.readFileSync(0, 'utf8'); console.log(`eof=${data.length === 0};value=123`);\n", stdout: "eof=true;value=123" },
      { language: "typescript", stdin: "", code: "const fs = require('fs'); const data = fs.readFileSync(0, 'utf8'); console.log(`eof=${data.length === 0};value=123`);\n", stdout: "eof=true;value=123" },
      { language: "bash", stdin: "", code: "if read -r value; then echo \"eof=false;value=$value\"; else echo \"eof=true;value=123\"; fi\n", stdout: "eof=true;value=123" },
    ];

    for (const testCase of eofCases) {
      await runDockerCase(testCase);
    }

    const invalidInputCases: DockerCase[] = [
      { language: "c", stdin: "not-a-number\n", code: `#include <stdio.h>
int main(void) { int value = 0; if (scanf("%d", &value) != 1) puts("invalid"); else printf("valid:%d\\n", value); return 0; }
`, stdout: "invalid" },
      { language: "cpp", stdin: "not-a-number\n", code: `#include <iostream>
int main() { int value = 0; if (!(std::cin >> value)) std::cout << "invalid" << std::endl; else std::cout << "valid:" << value << std::endl; return 0; }
`, stdout: "invalid" },
      { language: "java", stdin: "not-a-number\n", code: `import java.util.Scanner;
public class Main { public static void main(String[] args) { Scanner sc = new Scanner(System.in); System.out.println(sc.hasNextInt() ? "valid:" + sc.nextInt() : "invalid"); } }
`, stdout: "invalid" },
      { language: "python", stdin: "not-a-number\n", code: "try:\n    print(f'valid:{int(input())}')\nexcept ValueError:\n    print('invalid')\n", stdout: "invalid" },
      { language: "javascript", stdin: "not-a-number\n", code: "const fs = require('fs'); const value = Number(fs.readFileSync(0, 'utf8').trim()); console.log(Number.isFinite(value) ? `valid:${value}` : 'invalid');\n", stdout: "invalid" },
      { language: "typescript", stdin: "not-a-number\n", code: "const fs = require('fs'); const value: number = Number(fs.readFileSync(0, 'utf8').trim()); console.log(Number.isFinite(value) ? `valid:${value}` : 'invalid');\n", stdout: "invalid" },
      { language: "bash", stdin: "not-a-number\n", code: "read -r value\nif [[ $value =~ ^-?[0-9]+$ ]]; then echo \"valid:$value\"; else echo invalid; fi\n", stdout: "invalid" },
    ];

    for (const testCase of invalidInputCases) {
      await runDockerCase(testCase);
    }
  }, 120_000);

  it("surfaces syntax, compilation, runtime, stderr, and explicit non-zero failures then recovers", async () => {
    if (!(await requireDockerReadyForTest())) return;

    const failureCases: DockerCase[] = [
      { language: "c", code: "int main(void) { return }\n", status: "compile_error", stderr: /error/i },
      { language: "cpp", code: "int main() { return }\n", status: "compile_error", stderr: /error/i },
      { language: "java", code: "public class Main { public static void main(String[] args) { System.out.println( } }\n", status: "compile_error", stderr: /error/i },
      { language: "python", code: "if True print('missing colon')\n", status: "runtime_error", stderr: /SyntaxError/ },
      { language: "javascript", code: "function nope( {\n", status: "runtime_error", stderr: /SyntaxError/ },
      { language: "typescript", code: "const value: = 1;\n", status: "compile_error", stderr: /error/i },
      { language: "bash", code: "if true; then echo missing\n", status: "runtime_error", stderr: /syntax error/i },
      { language: "c", code: `#include <stdio.h>
int main(void) { fprintf(stderr, "c-stderr\\n"); return 7; }
`, status: "runtime_error", stderr: "c-stderr", exitCode: 7 },
      { language: "cpp", code: `#include <stdexcept>
int main() { throw std::runtime_error("cpp-boom"); }
`, status: "runtime_error", stderr: /cpp-boom/ },
      { language: "java", code: `public class Main { public static void main(String[] args) { throw new RuntimeException("java-boom"); } }
`, status: "runtime_error", stderr: /java-boom/ },
      { language: "python", code: "import sys\nprint('py-stderr', file=sys.stderr)\nsys.exit(7)\n", status: "runtime_error", stderr: "py-stderr", exitCode: 7 },
      { language: "javascript", code: "console.error('js-stderr'); process.exit(7);\n", status: "runtime_error", stderr: "js-stderr", exitCode: 7 },
      { language: "typescript", code: "console.error('ts-stderr'); process.exit(7);\n", status: "runtime_error", stderr: "ts-stderr", exitCode: 7 },
      { language: "bash", code: "echo bash-stderr >&2\nexit 7\n", status: "runtime_error", stderr: "bash-stderr", exitCode: 7 },
    ];

    const recoveryCode: Record<ExecutionLanguage, string> = {
      c: `#include <stdio.h>
int main(void) { puts("recovered"); return 0; }
`,
      cpp: `#include <iostream>
int main() { std::cout << "recovered" << std::endl; return 0; }
`,
      java: `public class Main { public static void main(String[] args) { System.out.println("recovered"); } }
`,
      python: "print('recovered')\n",
      javascript: "console.log('recovered');\n",
      typescript: "console.log('recovered');\n",
      bash: "echo recovered\n",
    };

    for (const testCase of failureCases) {
      const result = await runDockerCase(testCase);
      expect(result?.status).not.toBe("success");

      await runDockerCase({
        language: testCase.language,
        code: recoveryCode[testCase.language],
        stdout: "recovered",
        stderr: "",
        exitCode: 0,
      });
    }
  }, 180_000);

  it("covers language-specific supported features and bounded computational work", async () => {
    if (!(await requireDockerReadyForTest())) return;

    const cases: DockerCase[] = [
      {
        language: "c",
        code: `#include <stdio.h>
#include <stdlib.h>
typedef struct { int left; int right; } Pair;
int main(void) {
  Pair *pair = malloc(sizeof(Pair));
  if (!pair) return 2;
  pair->left = 19;
  pair->right = 23;
  long total = 0;
  for (int i = 0; i < 10000; i++) total += i;
  printf("c-feature:%d:%ld\\n", pair->left + pair->right, total);
  free(pair);
  return 0;
}
`,
        stdout: "c-feature:42:49995000",
      },
      {
        language: "cpp",
        code: `#include <algorithm>
#include <atomic>
#include <iostream>
#include <thread>
#include <vector>
int main() {
  std::vector<int> values = {5, 1, 3, 2, 4};
  std::sort(values.begin(), values.end());
  std::atomic<int> total{0};
  std::thread left([&] { for (int i = 0; i < 21; i++) total.fetch_add(1); });
  std::thread right([&] { for (int i = 0; i < 21; i++) total.fetch_add(1); });
  left.join();
  right.join();
  std::cout << "cpp-feature:" << values.front() << values.back() << ":" << total.load() << std::endl;
  return 0;
}
`,
        stdout: "cpp-feature:15:42",
      },
      {
        language: "java",
        code: `import java.util.*;
import java.util.concurrent.*;
public class Main {
  public static void main(String[] args) throws Exception {
    List<Integer> values = new ArrayList<>(Arrays.asList(5, 1, 3, 2, 4));
    Collections.sort(values);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    Future<Integer> left = pool.submit(() -> 21);
    Future<Integer> right = pool.submit(() -> 21);
    int total = left.get() + right.get();
    pool.shutdown();
    System.out.println("java-feature:" + values.get(0) + values.get(4) + ":" + total);
  }
}
`,
        stdout: "java-feature:15:42",
      },
      { language: "python", code: "total = sum(i * i for i in range(50))\nprint(f'python-feature:✓:{total}')\n", stdout: "python-feature:✓:40425" },
      { language: "javascript", code: "Promise.resolve(21).then((value) => console.log(`js-feature:${value * 2}`));\n", stdout: "js-feature:42" },
      { language: "typescript", code: "interface Item { value: number }\nconst item: Item = { value: 21 };\nPromise.resolve(item.value).then((value) => console.log(`ts-feature:${value * 2}`));\n", stdout: "ts-feature:42" },
      { language: "bash", code: "total=0\nwhile read -r value; do total=$((total + value)); done < <(printf '3\\n1\\n2\\n' | sort -n)\necho \"bash-feature:$total\"\n", stdout: "bash-feature:6" },
    ];

    for (const testCase of cases) {
      await runDockerCase(testCase);
    }
  }, 120_000);

  it("supports interactive prompts, sequential lines, and rapid stdin for every language", async () => {
    if (!(await requireDockerReadyForTest())) return;

    const nodeInteractive = `const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const values = [];
process.stdout.write("Enter number: ");
rl.on("line", (line) => {
  values.push(Number(line.trim()));
  if (values.length === 1) process.stdout.write("Next: ");
  if (values.length === 4) {
    console.log(` + "`total=${values.reduce((sum, value) => sum + value, 0)}`" + `);
    rl.close();
  }
});
`;

    const cases: Array<{ language: ExecutionLanguage; code: string }> = [
      {
        language: "c",
        code: `#include <stdio.h>
int main(void) {
  int a, b, c, d;
  printf("Enter number: ");
  fflush(stdout);
  if (scanf("%d", &a) != 1) return 2;
  printf("Next: ");
  fflush(stdout);
  if (scanf("%d %d %d", &b, &c, &d) != 3) return 3;
  printf("total=%d\\n", a + b + c + d);
  return 0;
}
`,
      },
      {
        language: "cpp",
        code: `#include <iostream>
int main() {
  int a, b, c, d;
  std::cout << "Enter number: " << std::flush;
  if (!(std::cin >> a)) return 2;
  std::cout << "Next: " << std::flush;
  if (!(std::cin >> b >> c >> d)) return 3;
  std::cout << "total=" << (a + b + c + d) << std::endl;
  return 0;
}
`,
      },
      {
        language: "java",
        code: `import java.util.Scanner;
public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    System.out.print("Enter number: ");
    System.out.flush();
    int a = sc.nextInt();
    System.out.print("Next: ");
    System.out.flush();
    int b = sc.nextInt();
    int c = sc.nextInt();
    int d = sc.nextInt();
    System.out.println("total=" + (a + b + c + d));
  }
}
`,
      },
      {
        language: "python",
        code: `import sys
print("Enter number: ", end="", flush=True)
a = int(sys.stdin.readline())
print("Next: ", end="", flush=True)
b = int(sys.stdin.readline())
c = int(sys.stdin.readline())
d = int(sys.stdin.readline())
print(f"total={a + b + c + d}")
`,
      },
      { language: "javascript", code: nodeInteractive },
      { language: "typescript", code: nodeInteractive },
      {
        language: "bash",
        code: `printf "Enter number: "
read -r a
printf "Next: "
read -r b
read -r c
read -r d
echo "total=$((a + b + c + d))"
`,
      },
    ];

    for (const testCase of cases) {
      const execution = await runInteractiveDockerWhenReady(
        testCase.language,
        testCase.code,
        async (handle, events) => {
          await waitForInteractiveEvent(
            events,
            (event) => event.type === "stdout" && event.chunk.includes("Enter number:"),
            15_000,
          );
          expect(events.some((event) => event.type === "stdout" && event.chunk.includes("total=")), testCase.language).toBe(false);
          expect(handle.writeStdin("2\n"), testCase.language).toBe(true);
          await waitForInteractiveEvent(
            events,
            (event) => event.type === "stdout" && event.chunk.includes("Next:"),
            15_000,
          );
          expect(handle.writeStdin("3\n4\n5\n"), testCase.language).toBe(true);
        },
      );

      expect(execution.skipped, testCase.language).toBe(false);
      if (execution.skipped) continue;
      expect(execution.result.status, testCase.language).toBe("success");
      expect(execution.result.stdout, testCase.language).toContain("Enter number:");
      expect(execution.result.stdout, testCase.language).toContain("Next:");
      expect(execution.result.stdout, testCase.language).toContain("total=14");
    }
  }, 180_000);

  it("preserves ordered high-volume output and valid near-limit output for every language", async () => {
    if (!(await requireDockerReadyForTest())) return;

    const orderedCases: DockerCase[] = [
      { language: "c", code: `#include <stdio.h>
int main(void) { for (int i = 0; i < 2000; i++) printf("L%04d\\n", i); return 0; }
` },
      { language: "cpp", code: `#include <iomanip>
#include <iostream>
int main() { for (int i = 0; i < 2000; i++) std::cout << "L" << std::setw(4) << std::setfill('0') << i << "\\n"; return 0; }
` },
      { language: "java", code: `public class Main { public static void main(String[] args) { for (int i = 0; i < 2000; i++) System.out.printf("L%04d%n", i); } }
` },
      { language: "python", code: "for i in range(2000):\n    print(f'L{i:04d}')\n" },
      { language: "javascript", code: "for (let i = 0; i < 2000; i++) console.log(`L${String(i).padStart(4, '0')}`);\n" },
      { language: "typescript", code: "for (let i = 0; i < 2000; i++) console.log(`L${String(i).padStart(4, '0')}`);\n" },
      { language: "bash", code: "for ((i=0; i<2000; i++)); do printf 'L%04d\\n' \"$i\"; done\n" },
    ];

    for (const testCase of orderedCases) {
      const result = await runDockerCase({ ...testCase, status: "success", stderr: "", exitCode: 0 });
      if (!result) continue;
      const lines = result.stdout.trim().split("\n");
      expect(lines.length, testCase.language).toBe(2000);
      expect(lines[0], testCase.language).toBe("L0000");
      expect(lines[1999], testCase.language).toBe("L1999");
    }

    for (const testCase of repeatedOutputCases(OUTPUT_LIMIT_BYTES - 4096)) {
      const result = await runDockerCase({ ...testCase, status: "success", stderr: "", exitCode: 0 });
      if (!result) continue;
      expect(result.stdout.length, testCase.language).toBe(OUTPUT_LIMIT_BYTES - 4096);
      expect(result.outputTruncated, testCase.language).not.toBe(true);
    }
  }, 180_000);

  it("enforces the output limit for every language and recovers afterward", async () => {
    if (!(await requireDockerReadyForTest())) return;

    for (const testCase of repeatedOutputCases(OUTPUT_LIMIT_BYTES + 4096)) {
      const result = await runDockerCase({ ...testCase, status: "output_limit" });
      if (!result) continue;
      expect(result.outputTruncated, testCase.language).toBe(true);
      expect(result.stdout, testCase.language).toContain("[Output truncated: exceeded 1MB limit]");

      await runDockerCase({
        language: testCase.language,
        code: {
          c: `#include <stdio.h>
int main(void) { puts("after-limit"); return 0; }
`,
          cpp: `#include <iostream>
int main() { std::cout << "after-limit" << std::endl; return 0; }
`,
          java: `public class Main { public static void main(String[] args) { System.out.println("after-limit"); } }
`,
          python: "print('after-limit')\n",
          javascript: "console.log('after-limit');\n",
          typescript: "console.log('after-limit');\n",
          bash: "echo after-limit\n",
        }[testCase.language],
        stdout: "after-limit",
        stderr: "",
        exitCode: 0,
      });
    }
  }, 180_000);

  it("keeps Docker sandbox runtime restrictions intact", async () => {
    if (!(await requireDockerReadyForTest())) return;

    await runDockerCase({
      language: "bash",
      code: "echo uid=$(id -u)\necho gid=$(id -g)\necho nproc=$(ulimit -u)\necho file=$(ulimit -f)\n",
      stdout: /uid=65534\ngid=65534\nnproc=96\nfile=4096/,
      stderr: "",
      exitCode: 0,
    });

    await runDockerCase({
      language: "python",
      code: `from pathlib import Path
Path('/workspace/workspace-write.txt').write_text('ok')
print(Path('/workspace/workspace-write.txt').read_text())
`,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });

    await runDockerCase({
      language: "python",
      code: `from pathlib import Path
try:
    Path('/etc/tandem-denied').write_text('x')
except OSError as exc:
    print(type(exc).__name__)
else:
    raise SystemExit(9)
`,
      stdout: /OSError|PermissionError/,
      stderr: "",
      exitCode: 0,
    });

    await runDockerCase({
      language: "bash",
      code: `cat > /tmp/tandem-noexec.sh <<'SCRIPT'
echo should-not-run
SCRIPT
chmod +x /tmp/tandem-noexec.sh
if /tmp/tandem-noexec.sh >/tmp/noexec.out 2>/tmp/noexec.err; then
  echo noexec-bypassed
  exit 9
fi
echo noexec-enforced
`,
      stdout: "noexec-enforced",
      exitCode: 0,
    });

    await runDockerCase({
      language: "python",
      code: `import socket
sock = socket.socket()
sock.settimeout(1)
try:
    sock.connect(("1.1.1.1", 80))
except OSError as exc:
    print(type(exc).__name__)
else:
    raise SystemExit(9)
`,
      stdout: /OSError|TimeoutError|PermissionError/,
      stderr: "",
      exitCode: 0,
    });
  }, 60_000);

  it("keeps workspace cleanup and fresh execution isolation intact", async () => {
    if (!(await requireDockerReadyForTest())) return;

    await runDockerCase({
      language: "python",
      code: "from pathlib import Path\nPath('marker.txt').write_text('leak')\nprint('created')\n",
      stdout: "created",
    });

    await runDockerCase({
      language: "python",
      code: "from pathlib import Path\nprint('exists=' + str(Path('marker.txt').exists()))\n",
      stdout: "exists=False",
    });
  }, 30_000);

  it("isolates stdin and Stop across rooms, users, sessions, and execution ids", async () => {
    if (!(await requireDockerReadyForTest())) return;

    const ownerA = { roomCode: "AUDITA", userId: "user-a", sessionId: "session-a" };
    const ownerB = { roomCode: "AUDITB", userId: "user-b", sessionId: "session-b" };
    const eventsA: ExecutionStreamEvent[] = [];
    const eventsB: ExecutionStreamEvent[] = [];
    const codeA = "import sys\nprint('ready-a', flush=True)\nvalue = sys.stdin.readline().strip()\nprint('got-a:' + value)\n";
    const codeB = "import sys\nprint('ready-b', flush=True)\nvalue = sys.stdin.readline().strip()\nprint('got-b:' + value)\n";

    const sessionA = startExecutionSession({ ...ownerA, language: "python", code: codeA, onEvent: (event) => eventsA.push(event) });
    const sessionB = startExecutionSession({ ...ownerB, language: "python", code: codeB, onEvent: (event) => eventsB.push(event) });

    if ("error" in sessionA) throw new Error(sessionA.error);
    if ("error" in sessionB) throw new Error(sessionB.error);

    try {
      await waitForInteractiveEvent(eventsA, (event) => event.type === "stdout" && event.chunk.includes("ready-a"), 15_000);
      await waitForInteractiveEvent(eventsB, (event) => event.type === "stdout" && event.chunk.includes("ready-b"), 15_000);

      expect(getActiveExecutionId(ownerA)).toBe(sessionA.id);
      expect(getActiveExecutionId(ownerB)).toBe(sessionB.id);
      expect(writeExecutionStdin("not-an-execution", ownerA, "ignored\n")).toBe(false);
      expect(writeExecutionStdin(sessionA.id, ownerB, "wrong-owner\n")).toBe(false);
      expect(stopExecutionSession(sessionA.id, ownerB)).toBe(false);

      const duplicate = startExecutionSession({ ...ownerA, language: "python", code: "print('duplicate')\n" });
      expect("error" in duplicate).toBe(true);
      if (!("error" in duplicate)) {
        duplicate.stop();
        await duplicate.done.catch(() => undefined);
      }

      expect(stopExecutionSession(sessionA.id, ownerA)).toBe(true);
      const cancelled = await sessionA.done;
      expect(cancelled.status).toBe("cancelled");
      expect(getActiveExecutionId(ownerA)).toBeNull();

      expect(writeExecutionStdin(sessionB.id, ownerB, "survivor\n")).toBe(true);
      const survived = await sessionB.done;
      expect(survived.status).toBe("success");
      expect(survived.stdout).toContain("got-b:survivor");
      expect(getActiveExecutionId(ownerB)).toBeNull();
    } finally {
      sessionA.stop();
      sessionB.stop();
      await Promise.allSettled([sessionA.done, sessionB.done]);
    }
  }, 45_000);
});

describe("Bash CRLF execution", () => {
  it("executes multiline Bash source with CRLF blank lines, read, and loops", async () => {
    const crlfScript = multilineBashCrlfSource();
    expectMultilineBashCrlfSource(crlfScript);

    const execution = await runBashWhenAvailable(crlfScript, "Ada\n");
    if (execution.skipped) {
      expect(execution.availability.ready).toBe(false);
      expect(execution.availability.reason).toBeTruthy();
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout).toContain("Hello");
    expect(execution.result.stdout).toContain("Enter name:");
    expect(execution.result.stdout).toContain("Item 1");
    expect(execution.result.stdout).toContain("Item 2");
    expect(execution.result.stdout).toContain("Item 3");
    expect(execution.result.stdout).toContain("Hello, Ada");
    expect(execution.result.stderr).not.toMatch(/\$'\\r'|command not found|not a valid identifier|unexpected token|invalid option/);
    expect(execution.result.exitCode).toBe(0);
  }, 20_000);
});

describe("Docker-backed execution integration", () => {
  it("executes multiline Bash scripts with CRLF line endings without carriage-return command errors", async () => {
    const crlfScript = multilineBashCrlfSource();
    expectMultilineBashCrlfSource(crlfScript);

    const execution = await runDockerWhenReady("bash", crlfScript, "Ada\n");
    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    expect(execution.result.status).toBe("success");
    expect(execution.result.stdout).toContain("Hello");
    expect(execution.result.stdout).toContain("Item 1");
    expect(execution.result.stdout).toContain("Item 2");
    expect(execution.result.stdout).toContain("Item 3");
    expect(execution.result.stdout).toContain("Hello, Ada");
    expect(execution.result.stderr).not.toMatch(/\$'\\r'|command not found|not a valid identifier|unexpected token|invalid option/);
    expect(execution.result.exitCode).toBe(0);
  }, 20_000);

  it("executes stdin arithmetic for every executable language when Docker is configured", async () => {
    const cases: Array<[ExecutionLanguage, string, string]> = [
      ["c", `#include <stdio.h>
int main(void) { int a, b; if (scanf("%d %d", &a, &b) != 2) return 2; printf("%d\\n", a + b); return 0; }
`, "10\n25\n"],
      ["cpp", `#include <iostream>
int main() { int a, b; if (!(std::cin >> a >> b)) return 2; std::cout << (a + b) << std::endl; return 0; }
`, "10\n25\n"],
      ["java", `import java.util.*;
public class Main { public static void main(String[] args) { Scanner sc = new Scanner(System.in); int a = sc.nextInt(); int b = sc.nextInt(); System.out.println(a + b); } }
`, "10\n25\n"],
      ["python", `a = int(input())
b = int(input())
print(a + b)
`, "10\n25\n"],
      ["javascript", `const fs = require("fs");
const [a, b] = fs.readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);
console.log(a + b);
`, "10\n25\n"],
      ["typescript", `const fs = require("fs");
const [a, b] = fs.readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);
console.log(a + b);
`, "10\n25\n"],
      ["bash", `read a
read b
echo $((a + b))
`, "10\n25\n"],
    ];

    if (!(await dockerExecutionReady())) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    for (const [language, code, stdin] of cases) {
      const execution = await runDockerWhenReady(language, code, stdin);
      expect(execution.skipped).toBe(false);
      if (!execution.skipped) {
        expect(execution.result.status, language).toBe("success");
        expect(execution.result.stdout.trim(), language).toBe("35");
        expect(execution.result.stderr, language).toBe("");
        expect(execution.result.exitCode, language).toBe(0);
      }
    }
  }, 90_000);

  it("keeps stdout, stderr, and non-zero exit code separate when Docker is configured", async () => {
    const execution = await runDockerWhenReady("python", `import sys
print("stdout-test")
print("stderr-test", file=sys.stderr)
sys.exit(7)
`);
    if (execution.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }
    expect(execution.result.status).toBe("runtime_error");
    expect(execution.result.stdout.trim()).toBe("stdout-test");
    expect(execution.result.stderr.trim()).toBe("stderr-test");
    expect(execution.result.exitCode).toBe(7);
  }, 20_000);

  it("enforces timeout and recovers for the next Docker execution", async () => {
    const timedOut = await withExecutionTimeoutForTest(1_500, () =>
      runDockerWhenReady("javascript", "while (true) {}\n"),
    );
    if (timedOut.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }
    expect(timedOut.result.status).toBe("timeout");
    expect(timedOut.result.timedOut).toBe(true);

    const recovered = await runDockerWhenReady("javascript", "console.log('after-timeout');\n");
    expect(recovered.skipped).toBe(false);
    if (!recovered.skipped) {
      expect(recovered.result.status).toBe("success");
      expect(recovered.result.stdout.trim()).toBe("after-timeout");
    }
  }, 35_000);

  it("enforces output limits and recovers for the next Docker execution", async () => {
    const limited = await runDockerWhenReady("python", "while True:\n    print('x' * 1000)\n");
    if (limited.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }
    expect(limited.result.status).toBe("output_limit");
    expect(limited.result.outputTruncated).toBe(true);
    expect(limited.result.stdout).toContain("[Output truncated: exceeded 1MB limit]");

    const recovered = await runDockerWhenReady("python", "print('after-output-limit')\n");
    expect(recovered.skipped).toBe(false);
    if (!recovered.skipped) {
      expect(recovered.result.status).toBe("success");
      expect(recovered.result.stdout.trim()).toBe("after-output-limit");
    }
  }, 35_000);

  it("isolates repeated and parallel Docker executions", async () => {
    if (!(await dockerExecutionReady())) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }

    for (let index = 0; index < 10; index += 1) {
      const result = await executeCode("python", "import sys\nprint(sys.stdin.read().strip())\n", `run-${index}\n`);
      expect(result.status).toBe("success");
      expect(result.stdout.trim()).toBe(`run-${index}`);
      expect(result.stderr).toBe("");
    }

    const [left, right] = await Promise.all([
      executeCode("python", "print('parallel-left')\n"),
      executeCode("bash", "echo parallel-right\n"),
    ]);
    expect(left.status).toBe("success");
    expect(right.status).toBe("success");
    expect(left.stdout.trim()).toBe("parallel-left");
    expect(right.stdout.trim()).toBe("parallel-right");
  }, 90_000);

  it("keeps Docker networking disabled and root filesystem read-only", async () => {
    const network = await runDockerWhenReady("python", `import socket
sock = socket.socket()
sock.settimeout(1)
try:
    sock.connect(("1.1.1.1", 80))
except OSError as exc:
    print(type(exc).__name__)
else:
    raise SystemExit(9)
`);
    if (network.skipped) {
      expect(await dockerExecutionReady()).toBe(false);
      return;
    }
    expect(network.result.status).toBe("success");
    expect(network.result.stdout.trim()).toMatch(/OSError|TimeoutError|PermissionError/);

    const filesystem = await runDockerWhenReady("python", `from pathlib import Path
try:
    Path('/root/tandem-write-test').write_text('x')
except OSError as exc:
    print(type(exc).__name__)
else:
    raise SystemExit(9)
`);
    expect(filesystem.skipped).toBe(false);
    if (!filesystem.skipped) {
      expect(filesystem.result.status).toBe("success");
      expect(filesystem.result.stdout.trim()).toMatch(/OSError|PermissionError/);
    }
  }, 30_000);
});

describe("execution cancellation", () => {
  it("returns a cancelled result when the request is aborted before execution starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeCode("python", "print('nope')", undefined, controller.signal);
    expect(result.status).toBe("cancelled");
    expect(result.stderr).toBe("Execution stopped by user.");
    expect(result.exitCode).toBeNull();
  });
});

describe("execution fail-closed mode", () => {
  it("reports execution availability as unconfigured when disabled", async () => {
    const previous = process.env.TANDEM_EXECUTION_BACKEND;
    process.env.TANDEM_EXECUTION_BACKEND = "disabled";
    try {
      const availability = await getExecutionAvailability();
      expect(availability.configured).toBe(false);
      expect(availability.backend).toBeNull();
      expect(availability.languages.c.ready).toBe(false);
      expect(availability.languages.java.ready).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TANDEM_EXECUTION_BACKEND;
      else process.env.TANDEM_EXECUTION_BACKEND = previous;
    }
  });

  it("returns unavailable instead of raw spawn errors when disabled", async () => {
    const previous = process.env.TANDEM_EXECUTION_BACKEND;
    process.env.TANDEM_EXECUTION_BACKEND = "disabled";
    try {
      const result = await executeCode("java", 'public class Main { public static void main(String[] args) { System.out.println("hi"); } }');
      expect(result.status).toBe("unavailable");
      expect(result.stderr).not.toMatch(/ENOENT|spawn/i);
    } finally {
      if (previous === undefined) delete process.env.TANDEM_EXECUTION_BACKEND;
      else process.env.TANDEM_EXECUTION_BACKEND = previous;
    }
  });
});
