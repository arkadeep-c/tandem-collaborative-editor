"use client";

/**
 * Centralized authenticated fetch helper.
 * PRIMARY: HttpOnly cookie (credentials: include)
 * FALLBACK: Signed bearer token from sessionStorage (tandem_session_token)
 * With in-memory fallback if sessionStorage blocked (e.g., strict iframe)
 */

const TOKEN_KEY = "tandem_session_token";

// In-memory fallback when sessionStorage unavailable (e.g., blocked third-party storage)
let inMemoryToken: string | null = null;

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return inMemoryToken;
  try {
    const stored = sessionStorage.getItem(TOKEN_KEY);
    if (stored) {
      inMemoryToken = stored;
      return stored;
    }
    // If sessionStorage has no token but we have in-memory, return it
    return inMemoryToken;
  } catch {
    // sessionStorage blocked, use in-memory
    return inMemoryToken;
  }
}

export function storeToken(token: string | null | undefined): void {
  if (!token) {
    inMemoryToken = null;
    if (typeof window === "undefined") return;
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
    return;
  }

  inMemoryToken = token;
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    console.log("[AUTH] TOKEN_STORED sessionStorage", { present: true });
  } catch (e) {
    console.warn("[AUTH] sessionStorage blocked, using in-memory fallback", e);
    // Keep in-memory token, don't fail
  }
}

export function clearStoredToken(): void {
  storeToken(null);
}

/**
 * apiFetch — same-origin fetch with cookie + bearer fallback.
 * Adds Authorization: Bearer <token> if token exists in sessionStorage or in-memory.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getStoredToken();

  const headers = new Headers(init.headers || {});

  if (token) {
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const mergedInit: RequestInit = {
    ...init,
    headers,
    credentials: "include",
  };

  if (process.env.NODE_ENV === "development") {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : (input as Request).url;
    console.log("[AUTH] apiFetch", { url: url.toString().slice(0, 80), hasToken: !!token, method: init.method || "GET" });
  }

  return fetch(input, mergedInit);
}

/**
 * Handle session response that may contain sessionToken.
 * If present, store it for fallback.
 */
export function handleSessionResponse(data: any): void {
  if (data && typeof data.sessionToken === "string" && data.sessionToken.length > 10) {
    console.log("[AUTH] handleSessionResponse storing token", { len: data.sessionToken.length });
    storeToken(data.sessionToken);
  }
}
