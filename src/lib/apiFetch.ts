"use client";

/**
 * Centralized authenticated fetch helper.
 * PRIMARY: HttpOnly cookie (credentials: include)
 * FALLBACK: Signed bearer token in memory (zero-storage) + optional window.name + optional sessionStorage
 * 
 * This module works even when document.cookie, localStorage, sessionStorage, IndexedDB are all blocked.
 * Authentication for active page session uses in-memory token.
 */

const TOKEN_KEY = "tandem_session_token";
const WINDOW_NAME_KEY = "tandemSessionToken";

// Zero-storage in-memory token — works even when all storage APIs blocked
let memorySessionToken: string | null = null;

// Legacy alias for backwards compatibility
let inMemoryToken: string | null = null;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

// --- Memory token API (required) ---

export function getMemorySessionToken(): string | null {
  return memorySessionToken || inMemoryToken;
}

export function setMemorySessionToken(token: string | null): void {
  memorySessionToken = token;
  inMemoryToken = token;
}

export function clearMemorySessionToken(): void {
  memorySessionToken = null;
  inMemoryToken = null;
}

// --- window.name fallback (optional preview persistence) ---

function getWindowNameToken(): string | null {
  if (!isBrowser()) return null;
  try {
    const name = window.name;
    if (!name) return null;
    // Try JSON parse first
    try {
      const parsed = JSON.parse(name);
      if (parsed && typeof parsed[WINDOW_NAME_KEY] === "string" && parsed[WINDOW_NAME_KEY].length > 10) {
        return parsed[WINDOW_NAME_KEY];
      }
    } catch {
      // window.name may not be JSON, ignore
    }
    return null;
  } catch {
    return null;
  }
}

function setWindowNameToken(token: string | null): void {
  if (!isBrowser()) return;
  try {
    let obj: any = {};
    try {
      if (window.name) {
        const parsed = JSON.parse(window.name);
        if (parsed && typeof parsed === "object") obj = parsed;
      }
    } catch {
      // If window.name not JSON, start fresh but preserve if it's not our format? We overwrite safely
      obj = {};
    }
    if (token) {
      obj[WINDOW_NAME_KEY] = token;
    } else {
      delete obj[WINDOW_NAME_KEY];
    }
    // Only set window.name if we have something to store, or if we previously stored our key
    if (Object.keys(obj).length > 0) {
      window.name = JSON.stringify(obj);
    } else {
      // If we cleared our token and obj empty, clear window.name if it was only our data
      // To be safe, if window.name was JSON with only our key, clear it
      try {
        const current = window.name ? JSON.parse(window.name) : {};
        if (current && Object.keys(current).length === 1 && current[WINDOW_NAME_KEY]) {
          window.name = "";
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // window.name may be blocked, ignore
  }
}

function clearWindowNameToken(): void {
  setWindowNameToken(null);
}

// --- sessionStorage optional optimization (not required) ---

function getSessionStorageToken(): string | null {
  if (!isBrowser()) return null;
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setSessionStorageToken(token: string | null): void {
  if (!isBrowser()) return;
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // storage blocked, ignore
  }
}

// --- Unified token access ---

export function getStoredToken(): string | null {
  // Priority: memory first (zero-storage), then window.name, then sessionStorage
  const mem = getMemorySessionToken();
  if (mem) return mem;

  const win = getWindowNameToken();
  if (win) {
    // Promote to memory for fast access
    setMemorySessionToken(win);
    return win;
  }

  const sess = getSessionStorageToken();
  if (sess) {
    setMemorySessionToken(sess);
    return sess;
  }

  return null;
}

export function storeToken(token: string | null | undefined): void {
  if (!token) {
    clearMemorySessionToken();
    clearWindowNameToken();
    setSessionStorageToken(null);
    return;
  }

  // Always store in memory (required)
  setMemorySessionToken(token);

  // Optional: window.name for preview persistence across refresh when storage blocked
  setWindowNameToken(token);

  // Optional: sessionStorage optimization when available
  setSessionStorageToken(token);

  if (process.env.NODE_ENV === "development") {
    console.log("[AUTH] TOKEN_STORED", { memory: true, hasToken: true });
  }
}

export function clearStoredToken(): void {
  storeToken(null);
}

// --- Bootstrap: try to restore token from window.name/sessionStorage into memory on module load ---

if (isBrowser()) {
  try {
    const existing = getStoredToken();
    if (existing) {
      // Already promoted to memory via getStoredToken
      if (process.env.NODE_ENV === "development") {
        console.log("[AUTH] SESSION_BOOTSTRAP restored token from storage", { 
          memory: !!getMemorySessionToken(),
          windowName: !!getWindowNameToken(),
          sessionStorage: !!getSessionStorageToken()
        });
      }
    }
  } catch {
    // ignore
  }
}

/**
 * apiFetch — same-origin fetch with cookie + bearer fallback.
 * Priority:
 * 1. HttpOnly cookie (credentials: include) — automatically sent by browser
 * 2. In-memory bearer token (zero-storage) — Authorization: Bearer <token>
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  // Ensure memory token is populated from optional storages on first call
  let token = getStoredToken();

  const headers = new Headers(init.headers || {});

  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const mergedInit: RequestInit = {
    ...init,
    headers,
    credentials: "include",
  };

  if (process.env.NODE_ENV === "development") {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.pathname : (input as Request).url;
    console.log("[AUTH] apiFetch", { 
      url: urlStr.toString().slice(0, 80), 
      hasToken: !!token, 
      method: init.method || "GET",
      cookieAvailable: isBrowser() ? document.cookie.length > 0 : false,
      memoryToken: !!getMemorySessionToken(),
      windowNameToken: !!getWindowNameToken(),
      sessionStorageToken: !!getSessionStorageToken()
    });
  }

  let response = await fetch(input, mergedInit);

  // If 401 and we had a token, try to refresh session once (token expired)
  if (response.status === 401 && token) {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    // Don't retry if the request itself is for /api/session (to avoid loop)
    const isSessionRequest = urlStr.includes("/api/session");
    if (!isSessionRequest) {
      console.warn("[AUTH] 401 with token, attempting refresh", { url: urlStr.slice(0, 80) });
      // Clear expired tokens
      clearStoredToken();

      try {
        // Get new session
        const refreshRes = await fetch("/api/session", { credentials: "include" });
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json().catch(() => null);
          if (refreshData && refreshData.sessionToken) {
            storeToken(refreshData.sessionToken);
            const newToken = getStoredToken();
            if (newToken) {
              const retryHeaders = new Headers(init.headers || {});
              retryHeaders.set("Authorization", `Bearer ${newToken}`);
              const retryInit: RequestInit = {
                ...init,
                headers: retryHeaders,
                credentials: "include",
              };
              console.log("[AUTH] retrying with new token", { url: urlStr.slice(0, 80) });
              response = await fetch(input, retryInit);
            }
          }
        }
      } catch (e) {
        console.error("[AUTH] refresh failed", e);
      }
    }
  }

  return response;
}

/**
 * Handle session response that may contain sessionToken.
 * Stores in memory (required) + window.name (optional) + sessionStorage (optional)
 */
export function handleSessionResponse(data: any): void {
  if (data && typeof data.sessionToken === "string" && data.sessionToken.length > 10) {
    if (process.env.NODE_ENV === "development") {
      console.log("[AUTH] handleSessionResponse storing token", { len: data.sessionToken.length });
    }
    storeToken(data.sessionToken);
  }
}

// --- Diagnostics for dev ---

export function getAuthDiagnostics() {
  if (!isBrowser()) return { browser: false };
  return {
    browser: true,
    cookieAvailable: (() => { try { return document.cookie.length > 0; } catch { return false; } })(),
    memoryToken: !!getMemorySessionToken(),
    windowNameToken: !!getWindowNameToken(),
    sessionStorageAvailable: (() => { try { sessionStorage.getItem("test"); return true; } catch { return false; } })(),
    sessionStorageToken: !!getSessionStorageToken(),
    localStorageAvailable: (() => { try { localStorage.getItem("test"); return true; } catch { return false; } })(),
  };
}
