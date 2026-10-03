import { afterEach, describe, expect, it, vi } from "vitest";

const user = { id: "user-cookie", name: "Cookie User", color: "#67e8f9" };
const token = "t".repeat(48);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function freshApiFetchModule() {
  vi.resetModules();
  const mod = await import("@/lib/apiFetch");
  mod.clearStoredToken();
  mod.resetSessionBootstrap();
  return mod;
}

describe("client session bootstrap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not retain a fresh bootstrap bearer when the HttpOnly cookie persists", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        user,
        fresh: true,
        sessionToken: token,
        authMode: "bootstrap",
        cookieVerificationRequired: true,
      }))
      .mockResolvedValueOnce(jsonResponse({
        user,
        fresh: false,
        authMode: "cookie",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const api = await freshApiFetchModule();
    const data = await api.ensureClientSession();

    expect(data.user.id).toBe(user.id);
    expect(data.bearerFallback).toBe(false);
    expect(api.getStoredToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).credentials).toBe("include");
    expect(((fetchMock.mock.calls[1]![1] as RequestInit).headers as Headers).get("Authorization")).toBe(`Bearer ${token}`);

    await api.ensureClientSession();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stores bearer fallback only when cookie verification still authenticates via bearer", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        user,
        fresh: true,
        sessionToken: token,
        authMode: "bootstrap",
        cookieVerificationRequired: true,
      }))
      .mockResolvedValueOnce(jsonResponse({
        user,
        fresh: false,
        sessionToken: token,
        bearerFallback: true,
        authMode: "bearer",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const api = await freshApiFetchModule();
    const data = await api.ensureClientSession();

    expect(data.user.id).toBe(user.id);
    expect(data.bearerFallback).toBe(true);
    expect(api.getStoredToken()).toBe(token);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(((fetchMock.mock.calls[1]![1] as RequestInit).headers as Headers).get("Authorization")).toBe(`Bearer ${token}`);
  });
});
