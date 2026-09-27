"use client";

/**
 * Centralized authenticated fetch helper with zero-storage fallback.
 * PRIMARY: HttpOnly cookie (credentials: include)
 * FALLBACK: Signed bearer token in memory (zero-storage) + optional window.name + optional sessionStorage
 * 
 * FIX: Eliminate bootstrap race — ensureClientSession() singleton ensures GET /api/rooms/mine never races GET /api/session
 */

const TOKEN_KEY = "tandem_session_token";
const WINDOW_NAME_KEY = "tandemSessionToken";

// Zero-storage in-memory token
let memorySessionToken: string | null = null;
let inMemoryToken: string | null = null;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

// --- Memory token API ---

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

// --- window.name fallback ---

function getWindowNameToken(): string | null {
  if (!isBrowser()) return null;
  try {
    const name = window.name;
    if (!name) return null;
    try {
      const parsed = JSON.parse(name);
      if (parsed && typeof parsed[WINDOW_NAME_KEY] === "string" && parsed[WINDOW_NAME_KEY].length > 10) {
        return parsed[WINDOW_NAME_KEY];
      }
    } catch {
      // ignore
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
      obj = {};
    }
    if (token) {
      obj[WINDOW_NAME_KEY] = token;
    } else {
      delete obj[WINDOW_NAME_KEY];
    }
    if (Object.keys(obj).length > 0) {
      window.name = JSON.stringify(obj);
    } else {
      try {
        const current = window.name ? JSON.parse(window.name) : {};
        if (current && Object.keys(current).length === 1 && current[WINDOW_NAME_KEY]) {
          window.name = "";
        }
      } catch {}
    }
  } catch {}
}

function clearWindowNameToken(): void {
  setWindowNameToken(null);
}

// --- sessionStorage optional ---

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
  } catch {}
}

// --- Unified token access ---

export function getStoredToken(): string | null {
  const mem = getMemorySessionToken();
  if (mem) return mem;
  const win = getWindowNameToken();
  if (win) {
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
  setMemorySessionToken(token);
  setWindowNameToken(token);
  setSessionStorageToken(token);
  if (process.env.NODE_ENV === "development") {
    console.log("[AUTH] TOKEN_STORED", { memory: true });
  }
}

export function clearStoredToken(): void {
  storeToken(null);
}

// Bootstrap restore on module load
if (isBrowser()) {
  try {
    const existing = getStoredToken();
    if (existing && process.env.NODE_ENV === "development") {
      console.log("[AUTH] SESSION_BOOTSTRAP restored token from storage", {
        memory: !!getMemorySessionToken(),
        windowName: !!getWindowNameToken(),
        sessionStorage: !!getSessionStorageToken(),
      });
    }
  } catch {}
}

// --- SINGLETON SESSION BOOTSTRAP (FIXES RACE) ---

let sessionBootstrapPromise: Promise<any> | null = null;
let sessionBootstrapDone = false;

export async function ensureClientSession(): Promise<any> {
  if (sessionBootstrapDone && getStoredToken()) {
    return;
  }
  if (sessionBootstrapPromise) {
    return sessionBootstrapPromise;
  }

  console.log("[SESSION] SESSION_BOOTSTRAP_START");
  sessionBootstrapPromise = (async () => {
    try {
      console.log("[SESSION] SESSION_BOOTSTRAP_REQUEST /api/session");
      // Use raw fetch to avoid recursion — skipSessionBootstrap
      const res = await fetch("/api/session", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      console.log("[SESSION] SESSION_BOOTSTRAP_RESPONSE", { status: res.status });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error("[SESSION] bootstrap failed", { status: res.status, body: txt.slice(0, 100) });
        throw new Error(`session ${res.status}`);
      }
      const data = await res.json();
      console.log("[SESSION] SESSION_BOOTSTRAP_COMPLETE", { hasToken: !!data.sessionToken, fresh: data.fresh, id: data.user?.id?.slice(0, 8) });
      handleSessionResponse(data);
      console.log("[SESSION] SESSION_TOKEN_READY", { present: !!getStoredToken() });
      sessionBootstrapDone = true;
      return data;
    } catch (e) {
      console.error("[SESSION] SESSION_BOOTSTRAP_ERROR", e);
      sessionBootstrapPromise = null;
      sessionBootstrapDone = false;
      throw e;
    }
  })();

  return sessionBootstrapPromise;
}

export function resetSessionBootstrap(): void {
  sessionBootstrapPromise = null;
  sessionBootstrapDone = false;
}

// --- apiFetch with bootstrap wait ---

interface ApiFetchOptions extends RequestInit {
  skipSessionBootstrap?: boolean;
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: ApiFetchOptions = {},
): Promise<Response> {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.pathname : (input as Request).url;
  const isSessionRequest = urlStr.includes("/api/session");
  const skipBootstrap = !!init.skipSessionBootstrap;

  // For all protected requests, wait for session bootstrap first (except /api/session itself)
  if (!isSessionRequest && !skipBootstrap) {
    console.log("[AUTH] PROTECTED_REQUEST_WAITING_FOR_SESSION", { url: urlStr.slice(0, 80) });
    try {
      await ensureClientSession();
      console.log("[AUTH] PROTECTED_REQUEST_AUTH_READY", { url: urlStr.slice(0, 80), hasToken: !!getStoredToken() });
    } catch (e) {
      console.warn("[AUTH] session bootstrap failed, proceeding anyway", { url: urlStr.slice(0, 80), error: (e as Error).message });
      // Continue — server will return 401 if truly no session, and we have 401 recovery below
    }
  }

  let token = getStoredToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const { skipSessionBootstrap: _skip, ...restInit } = init;
  const mergedInit: RequestInit = {
    ...restInit,
    headers,
    credentials: "include",
  };

  console.log("[AUTH] PROTECTED_REQUEST_START", { url: urlStr.slice(0, 80), hasToken: !!token, method: init.method || "GET" });

  let response = await fetch(input, mergedInit);

  // 401 recovery for expired token (not for initial bootstrap race)
  if (response.status === 401 && token && !isSessionRequest) {
    console.warn("[AUTH] 401 with token, attempting refresh", { url: urlStr.slice(0, 80) });
    clearStoredToken();
    resetSessionBootstrap();
    try {
      const refreshRes = await fetch("/api/session", { credentials: "include" });
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json().catch(() => null);
        if (refreshData?.sessionToken) {
          storeToken(refreshData.sessionToken);
          sessionBootstrapDone = true;
          const newToken = getStoredToken();
          if (newToken) {
            const retryHeaders = new Headers(init.headers || {});
            retryHeaders.set("Authorization", `Bearer ${newToken}`);
            const retryInit: RequestInit = {
              ...restInit,
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

  return response;
}

export function handleSessionResponse(data: any): void {
  if (data && typeof data.sessionToken === "string" && data.sessionToken.length > 10) {
    if (process.env.NODE_ENV === "development") {
      console.log("[AUTH] handleSessionResponse storing token", { len: data.sessionToken.length });
    }
    storeToken(data.sessionToken);
  }
}

export function getAuthDiagnostics() {
  if (!isBrowser()) return { browser: false } as any;
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
