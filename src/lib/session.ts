import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, isUsingLocalDb } from "@/db";
import { sessions, users, type UserRow } from "@/db/schema";
import { PRESENCE_COLORS } from "@/lib/validation";

/**
 * Server-managed anonymous sessions.
 *
 * PRIMARY: HttpOnly signed session cookie (first-party SameSite=Lax by default; explicit None+Partitioned only for embedded previews)
 * FALLBACK: Signed bearer token (sessionStorage) for iframe contexts where cookies are blocked
 *
 *  - The server creates the user (random UUID) AND the session token.
 *  - Cookie: `${token}.${HMAC(token)}` HttpOnly
 *  - Bearer: base64url({sid, exp}).HMAC(payload) — opaque, time-limited, signed
 *  - Every privileged route derives the user via `getAuthenticatedSession()`, never from client ids.
 */

export const SESSION_COOKIE = "tandem_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // slide when < 7d left

/* ------------------------------------------------------------------ */
/* Secret management                                                   */
/* ------------------------------------------------------------------ */

let cachedSecret: string | null = null;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  if (isProduction()) {
    throw new Error(
      "SESSION_SECRET is required. Configure it in the platform environment/secrets settings. " +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  cachedSecret = randomBytes(32).toString("hex");
  console.warn(
    "[session] SESSION_SECRET is not set — using an ephemeral secret for local development only. " +
      "Set SESSION_SECRET (>= 16 chars) to keep sessions across restarts. " +
      "In production/preview this would fail fast.",
  );
  return cachedSecret;
}

export function assertSessionSecret(): void {
  const fromEnv = process.env.SESSION_SECRET;
  if (isProduction()) {
    if (!fromEnv || fromEnv.length < 16) {
      throw new Error(
        "SESSION_SECRET is missing. Configure it in the deployment environment. " +
          "Open the platform's environment variables/secrets configuration, add SESSION_SECRET=<long-random-secret>, " +
          "then redeploy/restart. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Signing (pure — unit tested)                                        */
/* ------------------------------------------------------------------ */

export function signToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("base64url");
}

export function validSignature(
  token: string,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signToken(token, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function serializeSessionCookie(token: string, secret?: string): string {
  return `${token}.${signToken(token, secret ?? getSecret())}`;
}

/* ------------------------------------------------------------------ */
/* Bearer token (fallback for cookie-blocked contexts)                 */
/* ------------------------------------------------------------------ */

export const BEARER_TOKEN_TTL_MS = SESSION_TTL_MS; // same 30d, sensible

interface BearerPayload {
  sid: string; // session id
  exp: number; // ms epoch
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, "utf8").toString("base64url");
}

function base64UrlDecode(b64: string): string {
  return Buffer.from(b64, "base64url").toString("utf8");
}

/**
 * Create a signed bearer token containing session id + expiration.
 * Opaque, time-limited, HMAC-signed with SESSION_SECRET.
 */
export function createBearerToken(
  sessionId: string,
  ttlMs: number = BEARER_TOKEN_TTL_MS,
  secret?: string,
): string {
  const payload: BearerPayload = {
    sid: sessionId,
    exp: Date.now() + ttlMs,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = signToken(payloadB64, secret ?? getSecret());
  return `${payloadB64}.${sig}`;
}

/**
 * Verify bearer token signature and expiration, return sid if valid.
 */
export function verifyBearerToken(
  token: string,
  secret?: string,
): { sid: string; exp: number } | null {
  const sep = token.lastIndexOf(".");
  if (sep <= 0) return null;
  const payloadB64 = token.slice(0, sep);
  const signature = token.slice(sep + 1);
  if (!payloadB64 || !signature) return null;

  const sec = secret ?? getSecret();
  if (!validSignature(payloadB64, signature, sec)) return null;

  try {
    const json = base64UrlDecode(payloadB64);
    const payload = JSON.parse(json) as BearerPayload;
    if (!payload.sid || typeof payload.exp !== "number") return null;
    if (payload.exp <= Date.now()) return null; // expired
    if (!/^[a-f0-9]{64}$/.test(payload.sid)) return null; // session id format
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Identity generation (server-side only)                              */
/* ------------------------------------------------------------------ */

const NAME_PARTS: [string[], string[]] = [
  [
    "Crimson",
    "Azure",
    "Amber",
    "Sage",
    "Ivory",
    "Onyx",
    "Violet",
    "Cobalt",
    "Scarlet",
    "Teal",
  ],
  [
    "Falcon",
    "Otter",
    "Lynx",
    "Heron",
    "Badger",
    "Marten",
    "Osprey",
    "Viper",
    "Wolf",
    "Finch",
  ],
];

function randomName(): string {
  const pick = (list: string[]) =>
    list[randomBytes(1)[0]! % list.length]!;
  return `${pick(NAME_PARTS[0])} ${pick(NAME_PARTS[1])}`;
}

function randomColor(): string {
  return PRESENCE_COLORS[randomBytes(1)[0]! % PRESENCE_COLORS.length]!;
}

/* ------------------------------------------------------------------ */
/* Session lifecycle                                                   */
/* ------------------------------------------------------------------ */

export interface SessionUser {
  sessionId: string;
  user: UserRow;
}

export async function createSession(): Promise<SessionUser & { token: string }> {
  const userId = crypto.randomUUID();
  let user: UserRow;
  if (isUsingLocalDb()) {
    user = (db as any).insert(users).values({ id: userId, name: randomName(), color: randomColor() }).returning().get();
  } else {
    const [u] = await (db as any).insert(users).values({ id: userId, name: randomName(), color: randomColor() }).returning();
    user = u;
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  if (isUsingLocalDb()) {
    (db as any).insert(sessions).values({ id: token, userId: user.id, expiresAt }).run();
  } else {
    await (db as any).insert(sessions).values({ id: token, userId: user.id, expiresAt });
  }

  return { sessionId: token, token, user: user! };
}

/**
 * Load session by id from DB, with sliding renewal.
 */
async function loadSessionById(sessionId: string): Promise<SessionUser | null> {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return null;

  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (row.session.expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    try {
      if (isUsingLocalDb()) {
        (db as any).update(sessions).set({ expiresAt }).where(eq(sessions.id, sessionId)).run();
      } else {
        await (db as any).update(sessions).set({ expiresAt }).where(eq(sessions.id, sessionId));
      }
    } catch {
      // ignore
    }
  }

  return { sessionId, user: row.user };
}

async function getSessionUserFromCookieValue(raw: string | undefined): Promise<SessionUser | null> {
  if (!raw) return null;
  const sep = raw.indexOf(".");
  if (sep <= 0) return null;
  const token = raw.slice(0, sep);
  const signature = raw.slice(sep + 1);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  if (!validSignature(token, signature, getSecret())) return null;
  return loadSessionById(token);
}

async function getSessionUserFromBearerTokenValue(raw: string | undefined): Promise<SessionUser | null> {
  if (!raw) return null;
  // Accept both "Bearer <token>" and raw token
  let token = raw.trim();
  if (token.toLowerCase().startsWith("bearer ")) {
    token = token.slice(7).trim();
  }
  const verified = verifyBearerToken(token);
  if (!verified) return null;
  return loadSessionById(verified.sid);
}

/**
 * Original cookie-only resolver (for server components that can't access Authorization header).
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  return getSessionUserFromCookieValue(raw);
}

/**
 * Centralized auth: cookie first, then bearer fallback.
 * Returns session and how it was authenticated.
 */
export interface AuthResult {
  session: SessionUser | null;
  via: "cookie" | "bearer" | null;
  cookieValid: boolean;
}

export async function getAuthenticatedSessionFromRequest(
  request: NextRequest,
): Promise<AuthResult> {
  // 1. Try cookie
  const cookieRaw = request.cookies.get(SESSION_COOKIE)?.value;
  const cookieSession = await getSessionUserFromCookieValue(cookieRaw);
  if (cookieSession) {
    return { session: cookieSession, via: "cookie", cookieValid: true };
  }

  // 2. Try Authorization: Bearer <token>
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
  if (authHeader) {
    const bearerSession = await getSessionUserFromBearerTokenValue(authHeader);
    if (bearerSession) {
      return { session: bearerSession, via: "bearer", cookieValid: false };
    }
  }

  return { session: null, via: null, cookieValid: false };
}

/**
 * Simplified helper for routes that just need SessionUser | null, trying cookie then bearer.
 */
export async function getAuthenticatedSession(
  request?: NextRequest,
): Promise<SessionUser | null> {
  if (request) {
    const res = await getAuthenticatedSessionFromRequest(request);
    return res.session;
  }
  // No request: fallback to cookie-only (server components)
  return getSessionUser();
}

/* ------------------------------------------------------------------ */
/* Cookie configuration — explicit env-aware, no header inference      */
/* ------------------------------------------------------------------ */

type SameSiteValue = "lax" | "strict" | "none";

interface CookieConfig {
  secure: boolean;
  sameSite: SameSiteValue;
  partitioned: boolean;
}

function getCookieConfig(): CookieConfig {
  const secureEnv = process.env.SESSION_COOKIE_SECURE;
  const sameSiteEnv = process.env.SESSION_COOKIE_SAMESITE;
  const partitionedEnv = process.env.SESSION_COOKIE_PARTITIONED;

  let secure: boolean;
  let sameSite: SameSiteValue;
  let partitioned: boolean;

  if (secureEnv !== undefined) {
    secure = secureEnv.toLowerCase() === "true";
  } else {
    secure = isProduction();
  }

  if (sameSiteEnv !== undefined) {
    const v = sameSiteEnv.toLowerCase();
    if (v === "none" || v === "lax" || v === "strict") {
      sameSite = v as SameSiteValue;
    } else {
      sameSite = secure ? "none" : "lax";
    }
  } else {
    sameSite = "lax";
  }

  if (sameSite === "none") {
    secure = true;
  }

  if (partitionedEnv !== undefined) {
    partitioned = partitionedEnv.toLowerCase() === "true";
  } else {
    partitioned = false;
  }

  if (partitioned) {
    secure = true;
    sameSite = "none";
  }

  return { secure, sameSite, partitioned };
}

export function sessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSiteValue;
  partitioned: boolean;
  path: string;
  maxAge: number;
} {
  const cfg = getCookieConfig();
  return {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: cfg.sameSite,
    partitioned: cfg.partitioned,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export function appUrl(): string {
  return process.env.APP_URL ?? "http://localhost:3000";
}

/* ------------------------------------------------------------------ */
/* Diagnostics (dev-only, no cookie value exposure)                    */
/* ------------------------------------------------------------------ */

export function getSessionDiagnostics() {
  const cfg = getCookieConfig();
  const hasSecret = Boolean(
    process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16,
  );
  return {
    hasSecret,
    isProduction: isProduction(),
    cookie: {
      secure: cfg.secure,
      sameSite: cfg.sameSite,
      partitioned: cfg.partitioned,
      httpOnly: true,
      path: "/",
    },
  };
}
