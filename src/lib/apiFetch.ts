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
let lastSessionData: any = null;

function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 10;
}

function makeSessionHeaders(token?: string | null): Headers {
  const headers = new Headers({ Accept: "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function finalizeSessionBootstrap(data: any): Promise<any> {
  if (!data || !data.user?.id) return data;

  const bootstrapToken = isSessionToken(data.sessionToken) ? data.sessionToken : null;
  const existingToken = getStoredToken();

  // Existing valid bearer sessions are intentionally kept as a fallback. The
  // server is cookie-first, so if a valid cookie is also present this response
  // will not contain a bearer token and handleSessionResponse() will clear the
  // stale stored one. If an old bearer was invalid and the server created a
  // fresh bootstrap session, still verify cookie persistence before storing it.
  if (existingToken && data.authMode === "bearer") {
    handleSessionResponse(data, { allowBearerFallback: true });
    return { ...data, bearerFallback: true };
  }

  if (!bootstrapToken) {
    handleSessionResponse(data);
    return { ...data, bearerFallback: Boolean(getStoredToken()) };
  }

  // A fresh bootstrap response includes a bearer token only so cookie-blocked
  // browsers can recover. Verify whether the HttpOnly cookie persisted before
  // storing that token; the verification sends the token too, avoiding a second
  // anonymous session when cookies really are blocked.
  const verifyRes = await fetch("/api/session", {
    credentials: "include",
    headers: makeSessionHeaders(bootstrapToken),
  });
  if (!verifyRes.ok) {
    throw new Error(`session verify ${verifyRes.status}`);
  }
  const verified = await verifyRes.json();
  if (!verified?.user?.id) {
    throw new Error("Invalid session verification response: missing user");
  }

  if (verified.user.id === data.user.id && isSessionToken(verified.sessionToken)) {
    handleSessionResponse(verified, { allowBearerFallback: true });
    return { ...verified, bearerFallback: true };
  }

  // Cookie auth is working (or the server preferred an existing cookie). Do not
  // retain the bootstrap bearer token in top-level first-party production.
  handleSessionResponse(verified);
  return { ...verified, bearerFallback: false };
}

export async function ensureClientSession(): Promise<any> {
  if (sessionBootstrapDone && lastSessionData) {
    console.log("[SESSION] SESSION_BOOTSTRAP_CACHE_HIT", { id: lastSessionData.user?.id?.slice(0, 8), bearer: !!getStoredToken() });
    return lastSessionData;
  }
  if (sessionBootstrapPromise) {
    console.log("[SESSION] SESSION_BOOTSTRAP_AWAIT_EXISTING");
    return sessionBootstrapPromise;
  }

  console.log("[SESSION] SESSION_BOOTSTRAP_START");
  sessionBootstrapPromise = (async () => {
    try {
      const existingToken = getStoredToken();
      console.log("[SESSION] SESSION_BOOTSTRAP_REQUEST /api/session", { hasExistingToken: !!existingToken });
      // Use raw fetch to avoid recursion — skipSessionBootstrap. Include an
      // existing bearer only to prevent duplicate sessions in cookie-blocked
      // contexts; cookie auth remains primary on the server.
      const res = await fetch("/api/session", {
        credentials: "include",
        headers: makeSessionHeaders(existingToken),
      });
      console.log("[SESSION] SESSION_BOOTSTRAP_RESPONSE", { status: res.status });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error("[SESSION] bootstrap failed", { status: res.status, body: txt.slice(0, 100) });
        throw new Error(`session ${res.status}`);
      }
      const data = await res.json();
      if (!data || !data.user) {
        console.error("[SESSION] bootstrap invalid response", { data });
        throw new Error("Invalid session response: missing user");
      }
      console.log("[SESSION] SESSION_BOOTSTRAP_COMPLETE", { hasToken: !!data.sessionToken, fresh: data.fresh, id: data.user?.id?.slice(0, 8) });
      const resolved = await finalizeSessionBootstrap(data);
      console.log("[SESSION] SESSION_TOKEN_READY", { present: !!getStoredToken(), bearerFallback: !!resolved?.bearerFallback });
      lastSessionData = resolved;
      sessionBootstrapDone = true;
      return resolved;
    } catch (e) {
      console.error("[SESSION] SESSION_BOOTSTRAP_ERROR", e);
      sessionBootstrapPromise = null;
      sessionBootstrapDone = false;
      lastSessionData = null;
      throw e;
    }
  })();

  return sessionBootstrapPromise;
}

export function resetSessionBootstrap(): void {
  sessionBootstrapPromise = null;
  sessionBootstrapDone = false;
  lastSessionData = null;
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

  // One-shot 401 recovery for expired/missing cookie or bearer state.
  if (response.status === 401 && !isSessionRequest) {
    console.warn("[AUTH] 401, attempting session refresh", { url: urlStr.slice(0, 80), hadToken: !!token });
    if (token) clearStoredToken();
    resetSessionBootstrap();
    try {
      const refreshRes = await fetch("/api/session", {
        credentials: "include",
        headers: makeSessionHeaders(),
      });
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json().catch(() => null);
        if (refreshData?.user) {
          const resolved = await finalizeSessionBootstrap(refreshData);
          sessionBootstrapDone = true;
          lastSessionData = resolved;
          const newToken = getStoredToken();
          const retryHeaders = new Headers(init.headers || {});
          if (newToken) retryHeaders.set("Authorization", `Bearer ${newToken}`);
          else retryHeaders.delete("Authorization");
          const retryInit: RequestInit = {
            ...restInit,
            headers: retryHeaders,
            credentials: "include",
          };
          console.log("[AUTH] retrying after session refresh", { url: urlStr.slice(0, 80), hasToken: !!newToken });
          response = await fetch(input, retryInit);
        }
      }
    } catch (e) {
      console.error("[AUTH] refresh failed", e);
    }
  }

  return response;
}

export function handleSessionResponse(
  data: any,
  options: { allowBearerFallback?: boolean; clearBearerOnCookieAuth?: boolean } = {},
): void {
  if (data?.user?.id) {
    lastSessionData = { ...(lastSessionData ?? {}), ...data, user: data.user };
    sessionBootstrapDone = true;
  }

  const token = isSessionToken(data?.sessionToken) ? data.sessionToken : null;
  const shouldStoreBearer =
    token &&
    (options.allowBearerFallback ||
      Boolean(getStoredToken()) ||
      data?.bearerFallback === true ||
      data?.authMode === "bearer");

  if (shouldStoreBearer) {
    if (process.env.NODE_ENV === "development") {
      console.log("[AUTH] handleSessionResponse storing bearer fallback token", { len: token.length });
    }
    storeToken(token);
    return;
  }

  if (data?.user?.id && options.clearBearerOnCookieAuth !== false) {
    clearStoredToken();
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
