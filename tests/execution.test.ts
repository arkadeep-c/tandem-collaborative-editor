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
  type ExecutionStreamEvent,
} from "@/lib/execution/types";
import {
  startExecutionSession,
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

describe("Docker-backed execution integration", () => {
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
