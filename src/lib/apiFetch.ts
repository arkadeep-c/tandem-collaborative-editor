"use client";

/**
 * Centralized authenticated fetch helper.
 * PRIMARY: HttpOnly cookie (credentials: include)
 * FALLBACK: Signed bearer token from sessionStorage (tandem_session_token)
 */

const TOKEN_KEY = "tandem_session_token";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null | undefined): void {
  if (typeof window === "undefined") return;
  try {
    if (!token) {
      sessionStorage.removeItem(TOKEN_KEY);
    } else {
      sessionStorage.setItem(TOKEN_KEY, token);
    }
  } catch {
    // storage unavailable — ignore
  }
}

export function clearStoredToken(): void {
  storeToken(null);
}

/**
 * apiFetch — same-origin fetch with cookie + bearer fallback.
 * Adds Authorization: Bearer <token> if token exists in sessionStorage.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getStoredToken();

  const headers = new Headers(init.headers || {});

  if (token) {
    // Only add if not already present
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const mergedInit: RequestInit = {
    ...init,
    headers,
    credentials: "include",
  };

  return fetch(input, mergedInit);
}

/**
 * Handle session response that may contain sessionToken.
 * If present, store it for fallback.
 */
export function handleSessionResponse(data: any): void {
  if (data && typeof data.sessionToken === "string" && data.sessionToken.length > 10) {
    storeToken(data.sessionToken);
  }
}
