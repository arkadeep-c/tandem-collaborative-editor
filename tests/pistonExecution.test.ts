import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCode, getExecutionAvailability } from "@/lib/execution/executor";

const runtimes = [
  { language: "c", version: "1" },
  { language: "cpp", version: "1", aliases: ["c++"] },
  { language: "java", version: "17" },
  { language: "python", version: "3.11", aliases: ["python3"] },
  { language: "javascript", version: "20", aliases: ["node"] },
  { language: "typescript", version: "5" },
  { language: "bash", version: "5" },
];

describe("Piston production execution backend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reports executable languages ready when a Piston-compatible sandbox exposes runtimes", async () => {
    vi.stubEnv("TANDEM_EXECUTION_BACKEND", "piston");
    vi.stubEnv("TANDEM_PISTON_API_URL", "https://executor.example.test");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://executor.example.test/api/v2/runtimes");
      return Response.json(runtimes);
    }));

    const availability = await getExecutionAvailability();

    expect(availability.backend).toBe("piston");
    expect(availability.productionSafe).toBe(true);
    expect(Object.values(availability.languages).every((entry) => entry.ready)).toBe(true);
  });

  it("executes code through Piston without invoking local child processes", async () => {
    vi.stubEnv("TANDEM_EXECUTION_BACKEND", "piston");
    vi.stubEnv("TANDEM_PISTON_API_URL", "https://executor.example.test/");

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) === "https://executor.example.test/api/v2/runtimes") {
        return Response.json(runtimes);
      }

      expect(String(url)).toBe("https://executor.example.test/api/v2/execute");
      const body = JSON.parse(String(init?.body));
      expect(body.language).toBe("python");
      expect(body.files[0].name).toBe("main.py");
      expect(body.stdin).toBe("Ada\n");
      return Response.json({
        run: {
          stdout: "Hello Ada\n",
          stderr: "",
          code: 0,
          signal: null,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeCode("python", "print(input())\n", "Ada\n");

    expect(result.status).toBe("success");
    expect(result.stdout).toBe("Hello Ada\n");
    expect(result.stderr).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps execution unavailable when Piston is selected without a sandbox URL", async () => {
    vi.stubEnv("TANDEM_EXECUTION_BACKEND", "piston");
    vi.stubEnv("TANDEM_PISTON_API_URL", "");

    const availability = await getExecutionAvailability();

    expect(availability.backend).toBe("piston");
    expect(availability.configured).toBe(false);
    expect(availability.message).toContain("TANDEM_PISTON_API_URL");
  });
  it("returns a safe execution error for malformed executor responses", async () => {
    vi.stubEnv("TANDEM_EXECUTION_BACKEND", "piston");
    vi.stubEnv("TANDEM_PISTON_API_URL", "https://executor.example.test");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v2/runtimes")) {
        return Response.json(runtimes);
      }
      return new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const result = await executeCode("python", "print('hello')\n");

    expect(result.status).toBe("execution_error");
    expect(result.stderr).toContain("malformed response");
  });

  it("fails closed for non-HTTPS Piston URLs in production", async () => {
    vi.stubEnv("TANDEM_EXECUTION_BACKEND", "piston");
    vi.stubEnv("TANDEM_PISTON_API_URL", "http://executor.example.test");
    vi.stubEnv("APP_ENV", "production");

    const availability = await getExecutionAvailability();

    expect(availability.configured).toBe(false);
    expect(availability.message).toContain("HTTPS");
  });

});
