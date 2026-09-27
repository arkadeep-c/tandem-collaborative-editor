import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ExecutionLanguage, ExecutionResult, ExecutionProblem } from "./types";

const TIMEOUT_MS = 10000; // 10 seconds
const OUTPUT_LIMIT_BYTES = 1024 * 1024; // 1MB
const MAX_CODE_SIZE = 100 * 1024; // 100KB
const MAX_STDIN_SIZE = 10 * 1024; // 10KB

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
}

async function spawnWithLimits(
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdin?: string;
    timeoutMs?: number;
  }
): Promise<SpawnResult> {
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
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: options.cwd,
        TMPDIR: options.cwd,
        LANG: "C.UTF-8",
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, options.timeoutMs || TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (outputTruncated) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > OUTPUT_LIMIT_BYTES) {
        outputTruncated = true;
        stdout += chunk.toString("utf8", 0, OUTPUT_LIMIT_BYTES - stdoutBytes + chunk.length);
        stdout += "\n[Output truncated: exceeded 1MB limit]";
        try { child.kill("SIGKILL"); } catch {}
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (outputTruncated) return;
      stderrBytes += chunk.length;
      if (stderrBytes > OUTPUT_LIMIT_BYTES) {
        outputTruncated = true;
        stderr += chunk.toString("utf8", 0, OUTPUT_LIMIT_BYTES - stderrBytes + chunk.length);
        stderr += "\n[Output truncated: exceeded 1MB limit]";
        try { child.kill("SIGKILL"); } catch {}
        return;
      }
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr: stderr + `\nSpawn error: ${err.message}`,
        exitCode: null,
        timedOut: false,
        outputTruncated,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        outputTruncated,
      });
    });

    if (options.stdin) {
      try {
        child.stdin.write(options.stdin);
      } catch {}
    }
    try {
      child.stdin.end();
    } catch {}
  });
}

function parseCppErrors(stderr: string, filename: string): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  // Example: main.cpp:12:9: error: 'cout' was not declared in this scope
  const regex = /^(.*):(\d+):(\d+):\s*(error|warning|note):\s*(.*)$/gm;
  let match;
  while ((match = regex.exec(stderr)) !== null) {
    const [, file, lineStr, colStr, severityRaw, message] = match;
    const line = parseInt(lineStr, 10);
    const column = parseInt(colStr, 10);
    if (file.includes(filename) || file === filename || file.endsWith(".c") || file.endsWith(".cpp")) {
      problems.push({
        file: filename,
        line,
        column,
        message: message.trim(),
        severity: severityRaw === "error" ? "error" : severityRaw === "warning" ? "warning" : "info",
      });
    }
  }
  return problems;
}

function parsePythonErrors(stderr: string, filename: string): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  // Example: File "main.py", line 5
  // SyntaxError: ...
  const lines = stderr.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fileMatch = line.match(/File "([^"]+)", line (\d+)/);
    if (fileMatch) {
      const [, file, lineStr] = fileMatch;
      const lineNum = parseInt(lineStr, 10);
      const nextLine = lines[i + 1] || "";
      if (file.includes(filename) || file === filename || file.endsWith(".py")) {
        problems.push({
          file: filename,
          line: lineNum,
          message: nextLine.trim() || line.trim(),
          severity: "error",
        });
      }
    }
    // SyntaxError without File line
    if (line.includes("SyntaxError") || line.includes("IndentationError") || line.includes("NameError") || line.includes("TypeError")) {
      // Try to find line number in previous lines
      const prev = lines.slice(Math.max(0, i - 3), i).join(" ");
      const lineMatch = prev.match(/line (\d+)/);
      if (lineMatch) {
        problems.push({
          file: filename,
          line: parseInt(lineMatch[1], 10),
          message: line.trim(),
          severity: "error",
        });
      }
    }
  }
  return problems;
}

function parseJsErrors(stderr: string, filename: string): ExecutionProblem[] {
  const problems: ExecutionProblem[] = [];
  // Example: /tmp/.../main.js:5
  // ReferenceError: x is not defined
  const regex = /.*:(\d+)(?::(\d+))?\s*\n.*?(Error|ReferenceError|SyntaxError|TypeError):\s*(.*)/g;
  let match;
  // Simpler: look for file:line:column
  const lines = stderr.split("\n");
  for (const line of lines) {
    const m = line.match(/:(\d+):(\d+)/);
    if (m && (line.includes(filename) || line.includes(".js") || line.includes(".ts"))) {
      problems.push({
        file: filename,
        line: parseInt(m[1], 10),
        column: parseInt(m[2], 10),
        message: line.trim(),
        severity: "error",
      });
    } else if (line.includes("SyntaxError") || line.includes("ReferenceError")) {
      const lm = line.match(/:(\d+)/);
      if (lm) {
        problems.push({
          file: filename,
          line: parseInt(lm[1], 10),
          message: line.trim(),
          severity: "error",
        });
      }
    }
  }
  return problems;
}

export async function executeCode(
  language: ExecutionLanguage,
  code: string,
  stdin?: string
): Promise<ExecutionResult> {
  const start = Date.now();

  // Validation
  if (code.length > MAX_CODE_SIZE) {
    return {
      status: "execution_error",
      stdout: "",
      stderr: `Code too large: ${code.length} bytes exceeds ${MAX_CODE_SIZE} limit`,
      exitCode: null,
      duration: 0,
      problems: [],
    };
  }

  if (stdin && stdin.length > MAX_STDIN_SIZE) {
    return {
      status: "execution_error",
      stdout: "",
      stderr: `Stdin too large: ${stdin.length} bytes exceeds ${MAX_STDIN_SIZE} limit`,
      exitCode: null,
      duration: 0,
      problems: [],
    };
  }

  // Create isolated temp dir
  const execId = randomBytes(8).toString("hex");
  const workDir = join(tmpdir(), `tandem-exec-${execId}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    switch (language) {
      case "python": {
        const filename = "main.py";
        const filepath = join(workDir, filename);
        await fs.writeFile(filepath, code, "utf8");

        const result = await spawnWithLimits("python3", [filename], {
          cwd: workDir,
          stdin,
          timeoutMs: TIMEOUT_MS,
        });

        const problems = parsePythonErrors(result.stderr, filename);
        const isSuccess = result.exitCode === 0 && !result.timedOut;

        return {
          status: result.timedOut ? "timeout" : result.outputTruncated ? "output_limit" : isSuccess ? "success" : "runtime_error",
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
        const filepath = join(workDir, filename);
        await fs.writeFile(filepath, code, "utf8");

        const result = await spawnWithLimits("node", [filename], {
          cwd: workDir,
          stdin,
          timeoutMs: TIMEOUT_MS,
        });

        const problems = parseJsErrors(result.stderr, filename);
        const isSuccess = result.exitCode === 0 && !result.timedOut;

        return {
          status: result.timedOut ? "timeout" : result.outputTruncated ? "output_limit" : isSuccess ? "success" : "runtime_error",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems,
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        };
      }

      case "typescript": {
        const filename = "main.ts";
        const filepath = join(workDir, filename);
        await fs.writeFile(filepath, code, "utf8");

        // Try to compile with tsc if available, else run with node --loader ts-node/esm or just check syntax
        // For simplicity, try npx tsc --noEmit to get errors, then run via node with tsx or via tsc compile
        const compileResult = await spawnWithLimits("npx", ["tsc", "--noEmit", "--skipLibCheck", filename], {
          cwd: workDir,
          timeoutMs: 5000,
        });

        if (compileResult.exitCode !== 0 && compileResult.stderr) {
          const problems = parseJsErrors(compileResult.stderr + compileResult.stdout, filename);
          return {
            status: "compile_error",
            stdout: "",
            stderr: compileResult.stderr || compileResult.stdout,
            exitCode: compileResult.exitCode,
            duration: Date.now() - start,
            compilationOutput: compileResult.stderr,
            problems,
          };
        }

        // If tsc not available or no errors, try to run with node (if ts-node available) or transpile via tsc
        const jsFile = "main.js";
        const transpileResult = await spawnWithLimits("npx", ["tsc", filename, "--outFile", jsFile, "--module", "commonjs", "--target", "es2020", "--skipLibCheck"], {
          cwd: workDir,
          timeoutMs: 5000,
        });

        if (transpileResult.exitCode === 0) {
          const runResult = await spawnWithLimits("node", [jsFile], {
            cwd: workDir,
            stdin,
            timeoutMs: TIMEOUT_MS,
          });
          const problems = parseJsErrors(runResult.stderr, filename);
          return {
            status: runResult.timedOut ? "timeout" : runResult.outputTruncated ? "output_limit" : runResult.exitCode === 0 ? "success" : "runtime_error",
            stdout: runResult.stdout,
            stderr: runResult.stderr,
            exitCode: runResult.exitCode,
            duration: Date.now() - start,
            problems,
            timedOut: runResult.timedOut,
            outputTruncated: runResult.outputTruncated,
          };
        } else {
          // Fallback: try node with --input-type module if code is JS-compatible
          const runResult = await spawnWithLimits("node", [filename], {
            cwd: workDir,
            stdin,
            timeoutMs: TIMEOUT_MS,
          });
          return {
            status: runResult.exitCode === 0 ? "success" : "runtime_error",
            stdout: runResult.stdout,
            stderr: runResult.stderr + "\n" + transpileResult.stderr,
            exitCode: runResult.exitCode,
            duration: Date.now() - start,
            problems: parseJsErrors(runResult.stderr, filename),
            timedOut: runResult.timedOut,
          };
        }
      }

      case "c": {
        const filename = "main.c";
        const filepath = join(workDir, filename);
        await fs.writeFile(filepath, code, "utf8");

        const compileResult = await spawnWithLimits("gcc", [filename, "-o", "main", "-lm"], {
          cwd: workDir,
          timeoutMs: 5000,
        });

        if (compileResult.exitCode !== 0) {
          const problems = parseCppErrors(compileResult.stderr, filename);
          return {
            status: "compile_error",
            stdout: "",
            stderr: compileResult.stderr,
            exitCode: compileResult.exitCode,
            duration: Date.now() - start,
            compilationOutput: compileResult.stderr,
            problems,
          };
        }

        const runResult = await spawnWithLimits("./main", [], {
          cwd: workDir,
          stdin,
          timeoutMs: TIMEOUT_MS,
        });

        return {
          status: runResult.timedOut ? "timeout" : runResult.outputTruncated ? "output_limit" : runResult.exitCode === 0 ? "success" : "runtime_error",
          stdout: runResult.stdout,
          stderr: runResult.stderr,
          exitCode: runResult.exitCode,
          duration: Date.now() - start,
          problems: [],
          timedOut: runResult.timedOut,
          outputTruncated: runResult.outputTruncated,
        };
      }

      case "cpp": {
        const filename = "main.cpp";
        const filepath = join(workDir, filename);
        await fs.writeFile(filepath, code, "utf8");

        const compileResult = await spawnWithLimits("g++", [filename, "-o", "main", "-std=c++17"], {
          cwd: workDir,
          timeoutMs: 8000,
        });

        if (compileResult.exitCode !== 0) {
          const problems = parseCppErrors(compileResult.stderr, filename);
          return {
            status: "compile_error",
            stdout: "",
            stderr: compileResult.stderr,
            exitCode: compileResult.exitCode,
            duration: Date.now() - start,
            compilationOutput: compileResult.stderr,
            problems,
          };
        }

        const runResult = await spawnWithLimits("./main", [], {
          cwd: workDir,
          stdin,
          timeoutMs: TIMEOUT_MS,
        });

        return {
          status: runResult.timedOut ? "timeout" : runResult.outputTruncated ? "output_limit" : runResult.exitCode === 0 ? "success" : "runtime_error",
          stdout: runResult.stdout,
          stderr: runResult.stderr,
          exitCode: runResult.exitCode,
          duration: Date.now() - start,
          problems: [],
          timedOut: runResult.timedOut,
          outputTruncated: runResult.outputTruncated,
        };
      }

      case "bash": {
        const filename = "main.sh";
        const filepath = join(workDir, filename);
        await fs.writeFile(filepath, code, "utf8");

        const result = await spawnWithLimits("bash", [filename], {
          cwd: workDir,
          stdin,
          timeoutMs: TIMEOUT_MS,
        });

        return {
          status: result.timedOut ? "timeout" : result.outputTruncated ? "output_limit" : result.exitCode === 0 ? "success" : "runtime_error",
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - start,
          problems: [],
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated,
        };
      }

      default:
        return {
          status: "unavailable",
          stdout: "",
          stderr: `Language ${language} execution is not supported in this environment. Supported: ${["c", "cpp", "python", "javascript", "typescript", "bash"].join(", ")}`,
          exitCode: null,
          duration: Date.now() - start,
          problems: [],
        };
    }
  } finally {
    // Cleanup temp dir
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {}
  }
}
