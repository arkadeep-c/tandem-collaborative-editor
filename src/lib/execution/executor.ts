import { randomBytes } from "crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { chmodSync, promises as fs } from "fs";
import { join } from "path";
import { tmpdir, platform } from "os";
import {
  EXECUTABLE_LANGUAGES,
  type ExecutionAvailability,
  type ExecutionLanguage,
  type ExecutionProblem,
  type ExecutionResult,
  type ExecutionStreamEvent,
} from "./types";
import { normalizeBashSourceLineEndings } from "./source";
export {
  normalizeBashSourceLineEndings,
  normalizeExecutionSource,
} from "./source";

export const EXECUTION_TIMEOUT_MS = 600_000;
const COMPILE_TIMEOUT_MS = 8_000;
export const JAVA_COMPILE_TIMEOUT_MS = 20_000;
export const OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const MAX_CODE_SIZE = 100 * 1024;
export const MAX_STDIN_SIZE = 10 * 1024;
const MEMORY_LIMIT_BYTES = 768 * 1024 * 1024;
const FILE_SIZE_BLOCKS = 4096;
const PROCESS_LIMIT = 96;
const SAFE_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const INTERACTIVE_TERMINAL_TOOLS = ["python3"] as const;

export const INTERACTIVE_TERMINAL_WRAPPER = String.raw`
import errno
import os
import select
import subprocess
import sys
import termios

if len(sys.argv) < 2:
    print("interactive terminal wrapper missing command", file=sys.stderr)
    raise SystemExit(127)

master_fd, slave_fd = os.openpty()

try:
    attrs = termios.tcgetattr(slave_fd)
    attrs[3] = attrs[3] & ~termios.ECHO
    termios.tcsetattr(slave_fd, termios.TCSANOW, attrs)
except Exception:
    pass

child = subprocess.Popen(
    sys.argv[1:],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=subprocess.PIPE,
    close_fds=True,
    preexec_fn=os.setsid,
)
os.close(slave_fd)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
stderr_fd = sys.stderr.fileno()
child_stderr_fd = child.stderr.fileno() if child.stderr else None
read_fds = [master_fd, stdin_fd]
if child_stderr_fd is not None:
    read_fds.append(child_stderr_fd)

def remove_fd(fd):
    try:
        read_fds.remove(fd)
    except ValueError:
        pass

while read_fds:
    try:
        ready, _, _ = select.select(read_fds, [], [], 0.05)
    except InterruptedError:
        continue

    saw_output = False

    for fd in ready:
        try:
            data = os.read(fd, 4096)
        except OSError as exc:
            if exc.errno != errno.EIO:
                raise
            data = b""

        if not data:
            remove_fd(fd)
            continue

        if fd == stdin_fd:
            try:
                os.write(master_fd, data)
            except OSError:
                remove_fd(stdin_fd)
        elif fd == master_fd:
            os.write(stdout_fd, data)
            saw_output = True
        elif child_stderr_fd is not None and fd == child_stderr_fd:
            os.write(stderr_fd, data)
            saw_output = True

    if child.poll() is not None:
        if saw_output:
            continue
        if master_fd not in ready:
            try:
                data = os.read(master_fd, 4096)
                if data:
                    os.write(stdout_fd, data)
                    continue
            except OSError:
                pass
        if child_stderr_fd is not None:
            try:
                data = os.read(child_stderr_fd, 4096)
                if data:
                    os.write(stderr_fd, data)
                    continue
            except OSError:
                pass
        break

try:
    os.close(master_fd)
except OSError:
    pass

code = child.wait()
if code < 0:
    raise SystemExit(128 + abs(code))
raise SystemExit(code)
`.trim();

export function createInteractiveTerminalCommand(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  return {
    command: "python3",
    args: ["-c", INTERACTIVE_TERMINAL_WRAPPER, command, ...args],
  };
}

export function getExecutionTimeoutMs(): number {
  const configured = Number(process.env.TANDEM_EXECUTION_TIMEOUT_MS);

  if (
    process.env.NODE_ENV === "test" &&
    Number.isFinite(configured) &&
    configured > 0
  ) {
    return Math.min(Math.floor(configured), EXECUTION_TIMEOUT_MS);
  }

  return EXECUTION_TIMEOUT_MS;
}

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
  "-Xss512k",
  "-XX:CICompilerCount=1",
  "-XX:TieredStopAtLevel=1",
  "-XX:MaxMetaspaceSize=128m",
  "-XX:ReservedCodeCacheSize=32m",
  "-XX:-UsePerfData",
  "-Djava.io.tmpdir=.",
] as const;

export const JAVAC_VM_ARGS = JAVA_VM_ARGS.map((arg) => `-J${arg}`);
export const JAVA_SOURCE_FILENAME = "Main.java";
export const JAVA_MAIN_CLASS = "Main";

export function createDockerContainerName(workDir: string): string {
  const baseName = workDir.split(/[\\/]/).pop() || "exec";
  const safeName = baseName.replace(/[^a-zA-Z0-9_.-]/g, "-");

  return /^[a-zA-Z0-9]/.test(safeName)
    ? safeName
    : `tandem-${safeName}`;
}

export function createDockerWorkspaceMount(workDir: string): string {
  return `${workDir}:/workspace:rw`;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  aborted?: boolean;
  spawnError?: string;
}

interface InteractiveProcess {
  writeStdin(chunk: string): boolean;
  stop(): void;
  result: Promise<SpawnResult>;
}

export interface InteractiveStdinStream {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  write(chunk: string): boolean;
}

export function writeInteractiveStdin(
  stream: InteractiveStdinStream,
  chunk: string,
): boolean {
  if (stream.destroyed || stream.writableEnded) return false;

  try {
    stream.write(chunk);
    return true;
  } catch {
    return false;
  }
}

export interface InteractiveExecutionHandle {
  writeStdin(chunk: string): boolean;
  stop(): void;
  result: Promise<ExecutionResult>;
}

export interface InteractiveExecutionOptions {
  signal?: AbortSignal;
  onEvent?: (event: ExecutionStreamEvent) => void;
}

interface SandboxBackend {
  readonly name: "docker" | "linux-namespace";
  readonly productionSafe: boolean;

  run(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): Promise<SpawnResult>;

  runInteractive(
    command: string,
    args: string[],
    options: InteractiveSpawnOptions,
  ): InteractiveProcess;
}

interface SpawnOptions {
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  cleanupAfterKill?: () => Promise<void> | void;
}

interface InteractiveSpawnOptions extends SpawnOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
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

interface DockerRunArgsOptions {
  image: string;
  containerName: string;
  workDir: string;
  command: string;
  args: readonly string[];
  timeoutMs?: number;
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

function cancelled(start = Date.now()): ExecutionResult {
  return baseResult(
    "cancelled",
    "Execution stopped by user.",
    Date.now() - start,
  );
}

function cleanOutput(text: string, workDir: string): string {
  return text
    .replaceAll(`${workDir}/`, "")
    .replaceAll(workDir, "")
    .replace(/\/tmp\/tandem-exec-[a-f0-9]+\//g, "")
    .replace(/\\/g, "/");
}

async function commandExists(command: string): Promise<boolean> {
  const result =
    platform() === "win32"
      ? await rawSpawn("where.exe", [command], {
          cwd: tmpdir(),
          timeoutMs: 1500,
        })
      : await rawSpawn(
          "/bin/sh",
          [
            "-lc",
            `command -v ${JSON.stringify(command)} >/dev/null 2>&1`,
          ],
          {
            cwd: tmpdir(),
            timeoutMs: 1500,
          },
        );

  return result.exitCode === 0;
}

async function rawSpawn(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({
        stdout: "",
        stderr: "Execution stopped by user.",
        exitCode: null,
        timedOut: false,
        outputTruncated: false,
        aborted: true,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputTruncated = false;
    let aborted = false;
    let killRequested = false;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let cleanupPromise: Promise<void> | null = null;

    const startCleanup = () => {
      if (!options.cleanupAfterKill) return;

      cleanupPromise = (cleanupPromise ?? Promise.resolve())
        .then(() => options.cleanupAfterKill?.())
        .catch(() => undefined);
    };

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
      if (killRequested) return;

      killRequested = true;

      try {
        if (platform() !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }

      startCleanup();
    };

    const finish = (result: SpawnResult) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);

      if (killRequested) startCleanup();

      void (cleanupPromise ?? Promise.resolve()).finally(() =>
        resolve(result),
      );
    };

    const onAbort = () => {
      aborted = true;

      if (!stderr) {
        stderr = "Execution stopped by user.";
      }

      killChild();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.timeoutMs ?? getExecutionTimeoutMs());

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const append = (
      target: "stdout" | "stderr",
      chunk: Buffer,
    ) => {
      if (outputTruncated) return;

      if (target === "stdout") {
        stdoutBytes += chunk.length;

        if (stdoutBytes > OUTPUT_LIMIT_BYTES) {
          outputTruncated = true;

          stdout += chunk.toString(
            "utf8",
            0,
            OUTPUT_LIMIT_BYTES - stdoutBytes + chunk.length,
          );

          stdout += "\n[Output truncated: exceeded 1MB limit]";
          killChild();
          return;
        }

        stdout += chunk.toString("utf8");
      } else {
        stderrBytes += chunk.length;

        if (stderrBytes > OUTPUT_LIMIT_BYTES) {
          outputTruncated = true;

          stderr += chunk.toString(
            "utf8",
            0,
            OUTPUT_LIMIT_BYTES - stderrBytes + chunk.length,
          );

          stderr += "\n[Output truncated: exceeded 1MB limit]";
          killChild();
          return;
        }

        stderr += chunk.toString("utf8");
      }
    };

    child.stdout.on("data", (chunk: Buffer) =>
      append("stdout", chunk),
    );

    child.stderr.on("data", (chunk: Buffer) =>
      append("stderr", chunk),
    );

    child.on("error", (err) => {
      finish({
        stdout,
        stderr,
        exitCode: null,
        timedOut,
        outputTruncated,
        aborted,
        spawnError: aborted
          ? "Execution stopped by user."
          : err.message,
      });
    });

    child.on("close", (code) => {
      finish({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        outputTruncated,
        aborted,
      });
    });

    child.stdin.on("error", () => {
      // Some short-lived programs exit before stdin is written; ignore EPIPE and
      // let the normal close/error path produce the execution result.
    });
    try {
      child.stdin.end(options.stdin ?? "");
    } catch {}
  });
}

function rawSpawnInteractive(
  command: string,
  args: string[],
  options: InteractiveSpawnOptions,
): InteractiveProcess {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let outputTruncated = false;
  let aborted = false;
  let killRequested = false;
  let settled = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let cleanupPromise: Promise<void> | null = null;
  let resolveResult: (result: SpawnResult) => void = () => undefined;

  const result = new Promise<SpawnResult>((resolve) => {
    resolveResult = resolve;
  });

  if (options.signal?.aborted) {
    resolveResult({
      stdout: "",
      stderr: "Execution stopped by user.",
      exitCode: null,
      timedOut: false,
      outputTruncated: false,
      aborted: true,
    });
    return {
      writeStdin: () => false,
      stop: () => undefined,
      result,
    };
  }

  const startCleanup = () => {
    if (!options.cleanupAfterKill) return;

    cleanupPromise = (cleanupPromise ?? Promise.resolve())
      .then(() => options.cleanupAfterKill?.())
      .catch(() => undefined);
  };

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

  child.stdin.on("error", () => undefined);

  const killChild = () => {
    if (killRequested) return;

    killRequested = true;

    try {
      if (platform() !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }

    startCleanup();
  };

  const finish = (spawnResult: SpawnResult) => {
    if (settled) return;

    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);

    if (killRequested) startCleanup();

    void (cleanupPromise ?? Promise.resolve()).finally(() =>
      resolveResult(spawnResult),
    );
  };

  const onAbort = () => {
    aborted = true;

    if (!stderr) {
      stderr = "Execution stopped by user.";
    }

    killChild();
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    killChild();
  }, options.timeoutMs ?? getExecutionTimeoutMs());

  options.signal?.addEventListener("abort", onAbort, { once: true });

  const append = (
    target: "stdout" | "stderr",
    chunk: Buffer,
  ) => {
    if (outputTruncated) return;

    const currentBytes = target === "stdout" ? stdoutBytes : stderrBytes;
    const nextBytes = currentBytes + chunk.length;
    let text = chunk.toString("utf8");

    if (nextBytes > OUTPUT_LIMIT_BYTES) {
      outputTruncated = true;
      text =
        chunk.toString(
          "utf8",
          0,
          Math.max(0, OUTPUT_LIMIT_BYTES - currentBytes),
        ) + "\n[Output truncated: exceeded 1MB limit]";
    }

    if (target === "stdout") {
      stdoutBytes = nextBytes;
      stdout += text;
      options.onStdout?.(text);
    } else {
      stderrBytes = nextBytes;
      stderr += text;
      options.onStderr?.(text);
    }

    if (outputTruncated) {
      killChild();
    }
  };

  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

  child.on("error", (err) => {
    finish({
      stdout,
      stderr,
      exitCode: null,
      timedOut,
      outputTruncated,
      aborted,
      spawnError: aborted
        ? "Execution stopped by user."
        : err.message,
    });
  });

  child.on("close", (code) => {
    finish({
      stdout,
      stderr,
      exitCode: code,
      timedOut,
      outputTruncated,
      aborted,
    });
  });

  if (options.stdin) {
    try {
      child.stdin.write(options.stdin);
    } catch {}
  }

  return {
    writeStdin(chunk: string) {
      if (settled) return false;
      return writeInteractiveStdin(child.stdin, chunk);
    },
    stop() {
      aborted = true;

      if (!stderr) {
        stderr = "Execution stopped by user.";
      }

      killChild();
    },
    result,
  };
}

class LinuxNamespaceBackend implements SandboxBackend {
  readonly name = "linux-namespace" as const;
  readonly productionSafe = false;

  async run(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): Promise<SpawnResult> {
    const repoRoot = process.cwd();

    const script = [
      'cd "$TANDEM_WORKDIR" || exit 111',
      `ulimit -t ${Math.ceil(
        (options.timeoutMs ?? getExecutionTimeoutMs()) / 1000,
      ) + 1}`,
      `ulimit -f ${FILE_SIZE_BLOCKS}`,
      `ulimit -v ${Math.floor(
        MEMORY_LIMIT_BYTES / 1024,
      )}`,
      `ulimit -u ${PROCESS_LIMIT}`,
      "umask 077",
      `mount -t tmpfs -o size=1m tmpfs ${JSON.stringify(
        repoRoot,
      )} 2>/dev/null || true`,
      'exec "$@"',
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

  runInteractive(
    command: string,
    args: string[],
    options: InteractiveSpawnOptions,
  ): InteractiveProcess {
    const repoRoot = process.cwd();
    const terminalCommand = createInteractiveTerminalCommand(command, args);

    const script = [
      'cd "$TANDEM_WORKDIR" || exit 111',
      `ulimit -t ${Math.ceil(
        (options.timeoutMs ?? getExecutionTimeoutMs()) / 1000,
      ) + 1}`,
      `ulimit -f ${FILE_SIZE_BLOCKS}`,
      `ulimit -v ${Math.floor(
        MEMORY_LIMIT_BYTES / 1024,
      )}`,
      `ulimit -u ${PROCESS_LIMIT}`,
      "umask 077",
      `mount -t tmpfs -o size=1m tmpfs ${JSON.stringify(
        repoRoot,
      )} 2>/dev/null || true`,
      'exec "$@"',
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
      terminalCommand.command,
      ...terminalCommand.args,
    ];

    return rawSpawnInteractive("unshare", unshareArgs, options);
  }
}

export function createDockerRunArgs({
  image,
  containerName,
  workDir,
  command,
  args,
  timeoutMs = getExecutionTimeoutMs(),
}: DockerRunArgsOptions): string[] {
  const script = [
    "cd /workspace || exit 111",
    `ulimit -t ${Math.ceil(timeoutMs / 1000) + 1}`,
    `ulimit -f ${FILE_SIZE_BLOCKS}`,
    `ulimit -u ${PROCESS_LIMIT}`,
    "umask 077",
    'exec "$@"',
  ].join("; ");

  return [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
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
    createDockerWorkspaceMount(workDir),
    "-w",
    "/workspace",
    "--user",
    "65534:65534",
    "--entrypoint",
    "/usr/bin/env",
    image,
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
}

class DockerBackend implements SandboxBackend {
  readonly name = "docker" as const;
  readonly productionSafe = true;

  constructor(readonly image: string) {}

  async run(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): Promise<SpawnResult> {
    await fs.chmod(options.cwd, 0o777).catch(() => undefined);

    const containerName = createDockerContainerName(options.cwd);

    const dockerArgs = createDockerRunArgs({
      image: this.image,
      containerName,
      workDir: options.cwd,
      command,
      args,
      timeoutMs: options.timeoutMs,
    });

    return rawSpawn("docker", dockerArgs, {
      ...options,
      cleanupAfterKill: async () => {
        await rawSpawn(
          "docker",
          ["rm", "-f", containerName],
          {
            cwd: tmpdir(),
            timeoutMs: 5000,
          },
        );
      },
    });
  }

  runInteractive(
    command: string,
    args: string[],
    options: InteractiveSpawnOptions,
  ): InteractiveProcess {
    try {
      chmodSync(options.cwd, 0o777);
    } catch {}

    const containerName = createDockerContainerName(options.cwd);
    const terminalCommand = createInteractiveTerminalCommand(command, args);

    const dockerArgs = createDockerRunArgs({
      image: this.image,
      containerName,
      workDir: options.cwd,
      command: terminalCommand.command,
      args: terminalCommand.args,
      timeoutMs: options.timeoutMs,
    });

    return rawSpawnInteractive("docker", dockerArgs, {
      ...options,
      cleanupAfterKill: async () => {
        await rawSpawn(
          "docker",
          ["rm", "-f", containerName],
          {
            cwd: tmpdir(),
            timeoutMs: 5000,
          },
        );
      },
    });
  }
}

async function resolveBackend(
  hostCommandExists: (
    command: string,
  ) => Promise<boolean> = commandExists,
): Promise<SandboxBackend | null> {
  const requested = (
    process.env.TANDEM_EXECUTION_BACKEND || "auto"
  ).toLowerCase();

  if (requested === "disabled" || requested === "none") {
    return null;
  }

  const image = process.env.TANDEM_EXECUTION_IMAGE;

  if (
    (requested === "docker" ||
      (requested === "auto" && image)) &&
    image
  ) {
    if (await hostCommandExists("docker")) {
      return new DockerBackend(image);
    }

    return null;
  }

  const vercelDeployment = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  const productionDeployment =
    process.env.APP_ENV === "production" || process.env.VERCEL_ENV === "production";
  const allowNamespace =
    !productionDeployment &&
    !vercelDeployment &&
    (requested === "linux-namespace" ||
      process.env.TANDEM_ENABLE_LINUX_NAMESPACE_EXECUTOR === "true" ||
      process.env.NODE_ENV !== "production");

  if (
    platform() === "linux" &&
    allowNamespace &&
    (await hostCommandExists("unshare"))
  ) {
    return new LinuxNamespaceBackend();
  }

  return null;
}

function backendUnavailableMessage(): string {
  return "Code execution is unavailable because no supported isolated execution runtime is configured. Use TANDEM_EXECUTION_BACKEND=docker with TANDEM_EXECUTION_IMAGE on a host that provides Docker, or keep execution disabled on Vercel until a separate isolated execution service is added. Unsafe host execution is disabled.";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function uniqueRequiredTools(): string[] {
  return Array.from(
    new Set(
      [
        ...EXECUTABLE_LANGUAGES.flatMap(
          (language) => EXECUTION_TOOL_REQUIREMENTS[language],
        ),
        ...INTERACTIVE_TERMINAL_TOOLS,
      ],
    ),
  );
}

export function createDockerRuntimeProbeScript(
  tools: readonly string[],
): string {
  const toolList = tools.map(shellQuote).join(" ");

  return [
    "missing=0",
    `for tool in ${toolList}; do`,
    '  if command -v "$tool" >/dev/null 2>&1; then',
    "    printf 'READY:%s\\n' \"$tool\"",
    "  else",
    "    printf 'MISSING:%s\\n' \"$tool\"",
    "    missing=1",
    "  fi",
    "done",
    'exit "$missing"',
  ].join("\n");
}

export function parseDockerRuntimeProbeOutput(
  stdout: string,
  tools: readonly string[],
): Pick<
  DockerImageToolProbeResult,
  "availableTools" | "missingTools"
> {
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
    if (!available.has(tool)) {
      missing.add(tool);
    }
  }

  return {
    availableTools: tools.filter((tool) =>
      available.has(tool),
    ),
    missingTools: tools.filter((tool) =>
      missing.has(tool),
    ),
  };
}

async function probeDockerImageTools(
  backend: DockerImageToolProbeBackend,
  tools: readonly string[],
): Promise<DockerImageToolProbeResult> {
  const inspect = await rawSpawn(
    "docker",
    ["image", "inspect", backend.image],
    {
      cwd: tmpdir(),
      timeoutMs: 5000,
    },
  );

  if (
    inspect.exitCode !== 0 ||
    inspect.spawnError ||
    inspect.timedOut
  ) {
    return {
      imageExists: false,
      availableTools: [],
      missingTools: [...tools],
      error: `Docker execution image "${backend.image}" is not available locally. Build or pull it before enabling Docker execution.`,
    };
  }

  const result = await rawSpawn(
    "docker",
    [
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
    ],
    {
      cwd: tmpdir(),
      timeoutMs: 8000,
    },
  );

  if (
    result.spawnError ||
    result.timedOut ||
    result.outputTruncated ||
    (result.exitCode !== 0 && result.exitCode !== 1)
  ) {
    return {
      imageExists: true,
      availableTools: [],
      missingTools: [...tools],
      error: `Unable to verify runtimes inside Docker execution image "${backend.image}".`,
    };
  }

  return {
    imageExists: true,
    ...parseDockerRuntimeProbeOutput(
      result.stdout,
      tools,
    ),
  };
}

export async function getExecutionAvailability(
  probeOverrides: ExecutionAvailabilityProbeOverrides = {},
): Promise<ExecutionAvailability> {
  const languages = Object.fromEntries(
    EXECUTABLE_LANGUAGES.map((language) => [
      language,
      {
        ready: false,
        reason: backendUnavailableMessage(),
      },
    ]),
  ) as ExecutionAvailability["languages"];

  const hostCommandExists =
    probeOverrides.commandExists ?? commandExists;

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
    const dockerProbe =
      await (
        probeOverrides.dockerImageToolProbe ??
        probeDockerImageTools
      )(
        backend as DockerBackend,
        uniqueRequiredTools(),
      );

    const missingTools = new Set(
      dockerProbe.missingTools,
    );

    const probeError = dockerProbe.error;

    for (const language of EXECUTABLE_LANGUAGES) {
      const requiredTools = [
        ...EXECUTION_TOOL_REQUIREMENTS[language],
        ...INTERACTIVE_TERMINAL_TOOLS,
      ];
      const missing = requiredTools.filter((tool) =>
        missingTools.has(tool),
      );

      languages[language] =
        !probeError &&
        dockerProbe.imageExists &&
        missing.length === 0
          ? { ready: true }
          : {
              ready: false,
              reason:
                probeError ??
                `Execution runtime missing in configured Docker image: ${missing.join(
                  ", ",
                )}.`,
            };
    }

    return {
      configured: Object.values(languages).some(
        (entry) => entry.ready,
      ),
      backend: backend.name,
      productionSafe: backend.productionSafe,
      message: probeError,
      languages,
    };
  }

  for (const language of EXECUTABLE_LANGUAGES) {
    const missing: string[] = [];

    for (const tool of EXECUTION_TOOL_REQUIREMENTS[
      language
    ]) {
      if (!(await hostCommandExists(tool))) {
        missing.push(tool);
      }
    }

    languages[language] =
      missing.length === 0
        ? { ready: true }
        : {
            ready: false,
            reason: `Execution runtime missing in configured sandbox: ${missing.join(
              ", ",
            )}.`,
          };
  }

  return {
    configured: Object.values(languages).some(
      (entry) => entry.ready,
    ),
    backend: backend.name,
    productionSafe: backend.productionSafe,
    message: undefined,
    languages,
  };
}

const EXECUTION_TOOL_REQUIREMENTS: Record<
  ExecutionLanguage,
  string[]
> = {
  c: ["gcc"],
  cpp: ["g++"],
  java: ["javac", "java"],
  python: ["python3"],
  javascript: ["node"],
  typescript: ["node"],
  bash: ["bash"],
};

async function requireTools(
  language: ExecutionLanguage,
  backend: SandboxBackend,
): Promise<string | null> {
  if (backend.name === "docker") return null;

  for (const tool of EXECUTION_TOOL_REQUIREMENTS[
    language
  ]) {
    if (!(await commandExists(tool))) {
      return `Code execution is unavailable because the ${tool} runtime is missing from the configured sandbox environment.`;
    }
  }

  return null;
}

async function requireInteractiveTools(
  language: ExecutionLanguage,
  backend: SandboxBackend,
): Promise<string | null> {
  const missingLanguageTool = await requireTools(language, backend);
  if (missingLanguageTool) return missingLanguageTool;

  if (backend.name === "docker") return null;

  for (const tool of INTERACTIVE_TERMINAL_TOOLS) {
    if (!(await commandExists(tool))) {
      return `Interactive execution is unavailable because the ${tool} terminal wrapper runtime is missing from the configured sandbox environment.`;
    }
  }

  return null;
}

export function parseCppErrors(
  stderr: string,
  filename: string,
): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];

  const regex =
    /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/gm;

  let match: RegExpExecArray | null;

  while ((match = regex.exec(stderr)) !== null) {
    const [
      ,
      file,
      lineStr,
      colStr,
      severityRaw,
      message,
    ] = match;

    if (
      !(
        file.includes(filename) ||
        file.endsWith(".c") ||
        file.endsWith(".cpp")
      )
    ) {
      continue;
    }

    problems.push({
      file: filename,
      line: Number(lineStr),
      column: Number(colStr),
      message: message.trim(),
      severity: severityRaw.includes("error")
        ? "error"
        : severityRaw === "warning"
          ? "warning"
          : "info",
    });
  }

  return problems;
}

export function parseJavaErrors(
  stderr: string,
  filename: string,
): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  const lines = stderr.split(/\r?\n/);

  for (
    let index = 0;
    index < lines.length;
    index += 1
  ) {
    const match = lines[index].match(
      /^(.+?\.java):(\d+):\s*(error|warning):\s*(.*)$/,
    );

    if (!match) continue;

    const [
      ,
      file,
      lineStr,
      severityRaw,
      message,
    ] = match;

    if (
      !(
        file === filename ||
        file.endsWith(`/${filename}`) ||
        file.endsWith(`\\${filename}`) ||
        file.endsWith(".java")
      )
    ) {
      continue;
    }

    const caretLine = lines[index + 2] ?? "";
    const caretIndex = caretLine.indexOf("^");
    const column =
      caretIndex >= 0 ? caretIndex + 1 : undefined;

    const severity =
      severityRaw === "warning"
        ? "warning"
        : "error";

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

export function parseJavaRuntimeErrors(
  stderr: string,
  filename: string,
): ExecutionProblem[] {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const message =
    lines.find((line) => !line.startsWith("at ")) ??
    "Java runtime error";

  for (const line of lines) {
    const match = line.match(
      /\(([^():]+\.java):(\d+)\)/,
    );

    if (!match) continue;

    const file = match[1];

    if (
      !(
        file === filename ||
        file.endsWith(`/${filename}`) ||
        file.endsWith(`\\${filename}`)
      )
    ) {
      continue;
    }

    return [
      {
        file: filename,
        line: Number(match[2]),
        message,
        severity: "error",
      },
    ];
  }

  return [];
}

export function parsePythonErrors(
  stderr: string,
  filename: string,
): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  const lines = stderr.split("\n");

  let lastLine: number | null = null;

  for (const line of lines) {
    const fileMatch = line.match(
      /File "([^"]+)", line (\d+)/,
    );

    if (
      fileMatch &&
      (
        fileMatch[1].includes(filename) ||
        fileMatch[1].endsWith(".py")
      )
    ) {
      lastLine = Number(fileMatch[2]);
    }
  }

  const exceptionLine = [...lines]
    .reverse()
    .find((line) =>
      /^[A-Za-z_][\w.]*(Error|Exception|Warning)?\s*:/u.test(
        line.trim(),
      ),
    )
    ?.trim();

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

export function parseJsErrors(
  stderr: string,
  filename: string,
): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  const lines = stderr.split("\n");

  for (const line of lines) {
    const m = line.match(
      /(?:^|[/\\])[^/\\]*\.(?:js|ts):(\d+):(\d+)/,
    );

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

    const syntax = line.match(
      /^(SyntaxError|ReferenceError|TypeError|RangeError):\s*(.*)$/,
    );

    if (syntax && problems.length === 0) {
      problems.push({
        file: filename,
        line: 1,
        message: line.trim(),
        severity: "error",
      });
    }
  }

  return problems;
}

export function parseBashErrors(
  stderr: string,
  filename: string,
): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];

  const regex =
    /(?:^|\n)(?:.*?\/)?(?:main\.sh|script\.sh|bash):\s*line\s*(\d+):\s*(.*?)(?=\n|$)/g;

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
  return /out of memory|cannot allocate memory|memory exhausted|memory limit|std::bad_alloc/i.test(
    result.stderr,
  );
}

export function statusFromCompileLifecycle(
  result: {
    aborted?: boolean;
    timedOut?: boolean;
    outputTruncated?: boolean;
    stderr?: string;
  },
): ExecutionResult["status"] {
  if (result.aborted) return "cancelled";
  if (result.timedOut) return "timeout";
  if (result.outputTruncated) return "output_limit";

  if (
    /out of memory|cannot allocate memory|memory exhausted|memory limit|std::bad_alloc/i.test(
      result.stderr ?? "",
    )
  ) {
    return "memory_limit";
  }

  return "compile_error";
}

function statusFromCompile(
  result: SpawnResult,
): ExecutionResult["status"] {
  return statusFromCompileLifecycle(result);
}

function statusFromRun(
  result: SpawnResult,
): ExecutionResult["status"] {
  if (result.aborted) return "cancelled";
  if (result.timedOut) return "timeout";
  if (result.outputTruncated) return "output_limit";
  if (isMemoryLimit(result)) return "memory_limit";

  return result.exitCode === 0
    ? "success"
    : "runtime_error";
}

function cleanSpawnResult(
  result: SpawnResult,
  workDir: string,
): SpawnResult {
  const cleaned = {
    ...result,
    stdout: cleanOutput(result.stdout, workDir),
    stderr: cleanOutput(result.stderr, workDir),
    spawnError: result.spawnError
      ? cleanOutput(result.spawnError, workDir)
      : undefined,
  };

  if (isMemoryLimit(cleaned)) {
    cleaned.stderr =
      "Execution exceeded the sandbox memory limit.";
  }

  if (cleaned.aborted && !cleaned.stderr) {
    cleaned.stderr = "Execution stopped by user.";
  }

  return cleaned;
}

export async function prepareJavaWorkspace(
  workDir: string,
  code: string,
): Promise<void> {
  const entries = await fs
    .readdir(workDir)
    .catch(() => []);

  await Promise.all(
    entries
      .filter((entry) =>
        /\.(?:java|class)$/i.test(entry),
      )
      .map((entry) =>
        fs
          .rm(
            join(workDir, entry),
            {
              force: true,
              recursive: false,
            },
          )
          .catch(() => undefined),
      ),
  );

  await fs.writeFile(
    join(workDir, JAVA_SOURCE_FILENAME),
    code,
    "utf8",
  );
}

async function compileTypescript(
  code: string,
  workDir: string,
):
  Promise<
    | { ok: true; js: string }
    | {
        ok: false;
        stderr: string;
        problems: ExecutionProblem[];
      }
  > {
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

    const errors = (output.diagnostics || []).filter(
      (d) =>
        d.category === ts.DiagnosticCategory.Error,
    );

    if (errors.length > 0) {
      const problems = errors.map(
        (diagnostic): ExecutionProblem => {
          const pos =
            diagnostic.file &&
            typeof diagnostic.start === "number"
              ? diagnostic.file.getLineAndCharacterOfPosition(
                  diagnostic.start,
                )
              : null;

          return {
            file: "main.ts",
            line: pos ? pos.line + 1 : 1,
            column: pos
              ? pos.character + 1
              : 1,
            message:
              ts.flattenDiagnosticMessageText(
                diagnostic.messageText,
                "\n",
              ),
            severity: "error",
          };
        },
      );

      return {
        ok: false,
        stderr: problems
          .map(
            (p) =>
              `${p.file}:${p.line}:${p.column}: error: ${p.message}`,
          )
          .join("\n"),
        problems,
      };
    }

    return {
      ok: true,
      js: output.outputText,
    };
  } catch {
    return {
      ok: false,
      stderr:
        "TypeScript execution is unavailable because the TypeScript compiler package is not installed on the server.",
      problems: [],
    };
  }
}

export async function executeCode(
  language: ExecutionLanguage,
  code: string,
  stdin?: string,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  const start = Date.now();

  if (signal?.aborted) {
    return cancelled(start);
  }

  if (code.length > MAX_CODE_SIZE) {
    return baseResult(
      "execution_error",
      `Code too large: ${code.length} bytes exceeds ${MAX_CODE_SIZE} limit`,
      0,
    );
  }

  if (stdin && stdin.length > MAX_STDIN_SIZE) {
    return baseResult(
      "execution_error",
      `Stdin too large: ${stdin.length} bytes exceeds ${MAX_STDIN_SIZE} limit`,
      0,
    );
  }

  const backend = await resolveBackend();

  if (!backend) {
    return unavailable(
      backendUnavailableMessage(),
      start,
    );
  }

  const missing = await requireTools(
    language,
    backend,
  );

  if (missing) {
    return unavailable(missing, start);
  }

  const execId = randomBytes(8).toString("hex");

  const workDir = join(
    tmpdir(),
    `tandem-exec-${execId}`,
  );

  await fs.mkdir(workDir, {
    recursive: true,
    mode: 0o700,
  });

  const run = async (
    command: string,
    args: string[],
    timeoutMs = getExecutionTimeoutMs(),
  ) => {
    const result = await backend.run(command, args, {
      cwd: workDir,
      stdin,
      timeoutMs,
      signal,
    });

    return cleanSpawnResult(result, workDir);
  };

  const compile = async (
    command: string,
    args: string[],
    timeoutMs = COMPILE_TIMEOUT_MS,
  ) =>
    cleanSpawnResult(
      await backend.run(command, args, {
        cwd: workDir,
        timeoutMs,
        signal,
      }),
      workDir,
    );

  try {
    switch (language) {
      case "python": {
        const filename = "main.py";

        await fs.writeFile(
          join(workDir, filename),
          code,
          "utf8",
        );

        const result = await run(
          "python3",
          [filename],
        );

        const problems = parsePythonErrors(
          result.stderr,
          filename,
        );

        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems,
          timedOut: result.timedOut,
          outputTruncated:
            result.outputTruncated,
        };
      }

      case "javascript": {
        const filename = "main.js";

        await fs.writeFile(
          join(workDir, filename),
          code,
          "utf8",
        );

        const result = await run(
          "node",
          [filename],
        );

        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: parseJsErrors(
            result.stderr,
            filename,
          ),
          timedOut: result.timedOut,
          outputTruncated:
            result.outputTruncated,
        };
      }

      case "typescript": {
        const compiled =
          await compileTypescript(
            code,
            workDir,
          );

        if (!compiled.ok) {
          return {
            status: "compile_error",
            stdout: "",
            stderr: compiled.stderr,
            exitCode: 1,
            duration: Date.now() - start,
            compilationOutput:
              compiled.stderr,
            problems: compiled.problems,
          };
        }

        const filename = "main.js";

        await fs.writeFile(
          join(workDir, filename),
          compiled.js,
          "utf8",
        );

        const result = await run(
          "node",
          [filename],
        );

        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: parseJsErrors(
            result.stderr,
            "main.ts",
          ),
          timedOut: result.timedOut,
          outputTruncated:
            result.outputTruncated,
        };
      }

      case "c": {
        const filename = "main.c";

        await fs.writeFile(
          join(workDir, filename),
          code,
          "utf8",
        );

        const compiled = await compile(
          "gcc",
          [filename, "-o", "main", "-lm"],
        );

        if (
          compiled.exitCode !== 0 ||
          compiled.spawnError ||
          compiled.aborted ||
          compiled.timedOut ||
          compiled.outputTruncated
        ) {
          const stderr = compiled.spawnError
            ? "C compiler is unavailable in the execution sandbox."
            : compiled.stderr;

          return {
            status: compiled.spawnError
              ? "unavailable"
              : statusFromCompile(compiled),
            stdout: "",
            stderr,
            exitCode: compiled.exitCode,
            duration: Date.now() - start,
            compilationOutput: stderr,
            problems: parseCppErrors(
              stderr,
              filename,
            ),
          };
        }

        const result = await run(
          "./main",
          [],
        );

        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: [],
          timedOut: result.timedOut,
          outputTruncated:
            result.outputTruncated,
        };
      }

      case "cpp": {
        const filename = "main.cpp";

        await fs.writeFile(
          join(workDir, filename),
          code,
          "utf8",
        );

        const compiled = await compile(
          "g++",
          [
            filename,
            "-o",
            "main",
            "-std=c++17",
          ],
        );

        if (
          compiled.exitCode !== 0 ||
          compiled.spawnError ||
          compiled.aborted ||
          compiled.timedOut ||
          compiled.outputTruncated
        ) {
          const stderr = compiled.spawnError
            ? "C++ compiler is unavailable in the execution sandbox."
            : compiled.stderr;

          return {
            status: compiled.spawnError
              ? "unavailable"
              : statusFromCompile(compiled),
            stdout: "",
            stderr,
            exitCode: compiled.exitCode,
            duration: Date.now() - start,
            compilationOutput: stderr,
            problems: parseCppErrors(
              stderr,
              filename,
            ),
          };
        }

        const result = await run(
          "./main",
          [],
        );

        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: [],
          timedOut: result.timedOut,
          outputTruncated:
            result.outputTruncated,
        };
      }

      case "java": {
        const filename = JAVA_SOURCE_FILENAME;

        await prepareJavaWorkspace(
          workDir,
          code,
        );

        const compiled = await compile(
          "javac",
          [...JAVAC_VM_ARGS, filename],
          JAVA_COMPILE_TIMEOUT_MS,
        );

        if (
          compiled.exitCode !== 0 ||
          compiled.spawnError ||
          compiled.aborted ||
          compiled.timedOut ||
          compiled.outputTruncated
        ) {
          const stderr = compiled.spawnError
            ? "Java compiler is unavailable in the execution sandbox."
            : compiled.stderr;

          const status =
            compiled.spawnError
              ? "unavailable"
              : statusFromCompile(compiled);

          return {
            status,
            stdout: "",
            stderr,
            exitCode: compiled.exitCode,
            duration: Date.now() - start,
            compilationOutput: stderr,
            problems: parseJavaErrors(
              stderr,
              filename,
            ),
            timedOut: compiled.timedOut,
            outputTruncated:
              compiled.outputTruncated,
          };
        }

        const result = await run(
          "java",
          [
            ...JAVA_VM_ARGS,
            JAVA_MAIN_CLASS,
          ],
        );

        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems:
            parseJavaRuntimeErrors(
              result.stderr,
              filename,
            ),
          timedOut: result.timedOut,
          outputTruncated:
            result.outputTruncated,
        };
      }

      case "bash": {
        const filename = "main.sh";

        await fs.writeFile(
          join(workDir, filename),
          normalizeBashSourceLineEndings(code),
          "utf8",
        );

        const result = await run(
          "bash",
          [filename],
        );

        return {
          status: statusFromRun(result),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: parseBashErrors(
            result.stderr,
            filename,
          ),
          timedOut: result.timedOut,
          outputTruncated:
            result.outputTruncated,
        };
      }

      default:
        return unavailable(
          `Language ${language} execution is not supported.`,
          start,
        );
    }
  } finally {
    await fs
      .rm(workDir, {
        recursive: true,
        force: true,
      })
      .catch(() => undefined);
  }
}

export function startInteractiveExecution(
  language: ExecutionLanguage,
  code: string,
  options: InteractiveExecutionOptions = {},
): InteractiveExecutionHandle {
  const start = Date.now();
  const controller = new AbortController();
  let activeProcess: InteractiveProcess | null = null;
  let completed = false;
  const pendingStdin: string[] = [];

  const emit = (event: ExecutionStreamEvent) => {
    try {
      options.onEvent?.(event);
    } catch {}
  };

  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort();
    activeProcess?.stop();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      abortFromParent();
    } else {
      options.signal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  const finishResult = (result: ExecutionResult): ExecutionResult => {
    completed = true;
    options.signal?.removeEventListener("abort", abortFromParent);
    emit({ type: "result", result });
    emit({ type: "status", status: "finished" });
    return result;
  };

  const result = (async (): Promise<ExecutionResult> => {
    let workDir: string | null = null;

    try {
      emit({ type: "status", status: "starting", message: "Preparing sandbox..." });

      if (controller.signal.aborted) {
        return finishResult(cancelled(start));
      }

      if (code.length > MAX_CODE_SIZE) {
        return finishResult(
          baseResult(
            "execution_error",
            `Code too large: ${code.length} bytes exceeds ${MAX_CODE_SIZE} limit`,
            Date.now() - start,
          ),
        );
      }

      const backend = await resolveBackend();

      if (!backend) {
        return finishResult(
          unavailable(backendUnavailableMessage(), start),
        );
      }

      const missing = await requireInteractiveTools(language, backend);

      if (missing) {
        return finishResult(unavailable(missing, start));
      }

      const execId = randomBytes(8).toString("hex");
      workDir = join(tmpdir(), `tandem-exec-${execId}`);

      await fs.mkdir(workDir, {
        recursive: true,
        mode: 0o700,
      });

      const emitOutput = (type: "stdout" | "stderr", chunk: string) => {
        if (!workDir) return;
        const cleaned = cleanOutput(chunk, workDir);
        if (cleaned) emit({ type, chunk: cleaned });
      };

      const run = async (
        command: string,
        args: string[],
        timeoutMs = getExecutionTimeoutMs(),
      ) => {
        emit({ type: "status", status: "running", message: "Running program..." });

        activeProcess = backend.runInteractive(command, args, {
          cwd: workDir!,
          timeoutMs,
          signal: controller.signal,
          onStdout: (chunk) => emitOutput("stdout", chunk),
          onStderr: (chunk) => emitOutput("stderr", chunk),
        });

        for (const chunk of pendingStdin.splice(0)) {
          activeProcess.writeStdin(chunk);
        }

        return cleanSpawnResult(await activeProcess.result, workDir!);
      };

      const compile = async (
        command: string,
        args: string[],
        timeoutMs = COMPILE_TIMEOUT_MS,
      ) => {
        emit({ type: "status", status: "compiling", message: "Compiling..." });

        const compiled = cleanSpawnResult(
          await backend.run(command, args, {
            cwd: workDir!,
            timeoutMs,
            signal: controller.signal,
          }),
          workDir!,
        );

        if (compiled.stdout) emit({ type: "stdout", chunk: compiled.stdout });
        if (compiled.stderr) emit({ type: "stderr", chunk: compiled.stderr });

        return compiled;
      };

      const compileFailure = (
        compiled: SpawnResult,
        unavailableMessage: string,
        problems: ExecutionProblem[],
      ): ExecutionResult => {
        const stderr = compiled.spawnError
          ? unavailableMessage
          : compiled.stderr;

        if (compiled.spawnError && stderr) {
          emit({ type: "stderr", chunk: stderr });
        }

        return {
          status: compiled.spawnError
            ? "unavailable"
            : statusFromCompile(compiled),
          stdout: "",
          stderr,
          exitCode: compiled.exitCode,
          duration: Date.now() - start,
          compilationOutput: stderr,
          problems,
          timedOut: compiled.timedOut,
          outputTruncated: compiled.outputTruncated,
        };
      };

      const runtimeResult = (
        runResult: SpawnResult,
        problems: ExecutionProblem[],
      ): ExecutionResult => ({
        status: statusFromRun(runResult),
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        exitCode: runResult.exitCode,
        duration: Date.now() - start,
        problems,
        timedOut: runResult.timedOut,
        outputTruncated: runResult.outputTruncated,
      });

      let executionResult: ExecutionResult;

      switch (language) {
        case "python": {
          const filename = "main.py";
          await fs.writeFile(join(workDir, filename), code, "utf8");
          const runResult = await run("python3", [filename]);
          executionResult = runtimeResult(
            runResult,
            parsePythonErrors(runResult.stderr, filename),
          );
          break;
        }

        case "javascript": {
          const filename = "main.js";
          await fs.writeFile(join(workDir, filename), code, "utf8");
          const runResult = await run("node", [filename]);
          executionResult = runtimeResult(
            runResult,
            parseJsErrors(runResult.stderr, filename),
          );
          break;
        }

        case "typescript": {
          emit({ type: "status", status: "compiling", message: "Transpiling TypeScript..." });
          const compiled = await compileTypescript(code, workDir);

          if (!compiled.ok) {
            if (compiled.stderr) emit({ type: "stderr", chunk: compiled.stderr });
            executionResult = {
              status: "compile_error",
              stdout: "",
              stderr: compiled.stderr,
              exitCode: 1,
              duration: Date.now() - start,
              compilationOutput: compiled.stderr,
              problems: compiled.problems,
            };
            break;
          }

          const filename = "main.js";
          await fs.writeFile(join(workDir, filename), compiled.js, "utf8");
          const runResult = await run("node", [filename]);
          executionResult = runtimeResult(
            runResult,
            parseJsErrors(runResult.stderr, "main.ts"),
          );
          break;
        }

        case "c": {
          const filename = "main.c";
          await fs.writeFile(join(workDir, filename), code, "utf8");
          const compiled = await compile("gcc", [filename, "-o", "main", "-lm"]);

          if (
            compiled.exitCode !== 0 ||
            compiled.spawnError ||
            compiled.aborted ||
            compiled.timedOut ||
            compiled.outputTruncated
          ) {
            const stderr = compiled.spawnError
              ? "C compiler is unavailable in the execution sandbox."
              : compiled.stderr;
            executionResult = compileFailure(
              compiled,
              stderr,
              parseCppErrors(stderr, filename),
            );
            break;
          }

          const runResult = await run("./main", []);
          executionResult = runtimeResult(runResult, []);
          break;
        }

        case "cpp": {
          const filename = "main.cpp";
          await fs.writeFile(join(workDir, filename), code, "utf8");
          const compiled = await compile("g++", [filename, "-o", "main", "-std=c++17"]);

          if (
            compiled.exitCode !== 0 ||
            compiled.spawnError ||
            compiled.aborted ||
            compiled.timedOut ||
            compiled.outputTruncated
          ) {
            const stderr = compiled.spawnError
              ? "C++ compiler is unavailable in the execution sandbox."
              : compiled.stderr;
            executionResult = compileFailure(
              compiled,
              stderr,
              parseCppErrors(stderr, filename),
            );
            break;
          }

          const runResult = await run("./main", []);
          executionResult = runtimeResult(runResult, []);
          break;
        }

        case "java": {
          const filename = JAVA_SOURCE_FILENAME;
          await prepareJavaWorkspace(workDir, code);
          const compiled = await compile(
            "javac",
            [...JAVAC_VM_ARGS, filename],
            JAVA_COMPILE_TIMEOUT_MS,
          );

          if (
            compiled.exitCode !== 0 ||
            compiled.spawnError ||
            compiled.aborted ||
            compiled.timedOut ||
            compiled.outputTruncated
          ) {
            const stderr = compiled.spawnError
              ? "Java compiler is unavailable in the execution sandbox."
              : compiled.stderr;
            executionResult = compileFailure(
              compiled,
              stderr,
              parseJavaErrors(stderr, filename),
            );
            break;
          }

          const runResult = await run("java", [...JAVA_VM_ARGS, JAVA_MAIN_CLASS]);
          executionResult = runtimeResult(
            runResult,
            parseJavaRuntimeErrors(runResult.stderr, filename),
          );
          break;
        }

        case "bash": {
          const filename = "main.sh";
          await fs.writeFile(
            join(workDir, filename),
            normalizeBashSourceLineEndings(code),
            "utf8",
          );
          const runResult = await run("bash", [filename]);
          executionResult = runtimeResult(
            runResult,
            parseBashErrors(runResult.stderr, filename),
          );
          break;
        }

        default:
          executionResult = unavailable(
            `Language ${language} execution is not supported.`,
            start,
          );
      }

      return finishResult(executionResult);
    } catch (error) {
      const message =
        controller.signal.aborted
          ? "Execution stopped by user."
          : "Execution failed safely. Please try again or contact the room owner if it persists.";

      if (!controller.signal.aborted) {
        console.error("[interactive-execute] error", error);
      }

      return finishResult(
        baseResult(
          controller.signal.aborted ? "cancelled" : "execution_error",
          message,
          Date.now() - start,
        ),
      );
    } finally {
      completed = true;
      activeProcess = null;

      if (workDir) {
        await fs
          .rm(workDir, {
            recursive: true,
            force: true,
          })
          .catch(() => undefined);
      }
    }
  })();

  return {
    writeStdin(chunk: string) {
      if (completed || controller.signal.aborted) return false;
      if (chunk.length > MAX_STDIN_SIZE) return false;

      if (activeProcess) {
        return activeProcess.writeStdin(chunk);
      }

      pendingStdin.push(chunk);
      return true;
    },
    stop() {
      if (completed) return;
      if (!controller.signal.aborted) controller.abort();
      activeProcess?.stop();
    },
    result,
  };
}
