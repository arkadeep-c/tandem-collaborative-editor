import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users, type UserRow } from "@/db/schema";
import { PRESENCE_COLORS } from "@/lib/validation";

/**
 * Server-managed anonymous sessions.
 *
 *  - The server creates the user (random UUID) AND the session token.
 *  - The browser receives only `${token}.${HMAC(token)}` in an HttpOnly,
 *    SameSite=Lax cookie (Secure in production) — it cannot read, choose,
 *    or forge the identity inside it.
 *  - Every privileged route derives the user via `requireSessionUser()`,
 *    never from client-supplied ids.
 */

export const SESSION_COOKIE = "tandem_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // slide when < 7d left

/* ------------------------------------------------------------------ */
/* Secret management                                                   */
/* ------------------------------------------------------------------ */

let cachedSecret: string | null = null;

function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  // No hardcoded fallback: per-process random secret. Sessions do not
  // survive a restart in this mode — correct for dev, and production
  // deployments set SESSION_SECRET explicitly.
  cachedSecret = randomBytes(32).toString("hex");
  console.warn(
    "[session] SESSION_SECRET is not set — using an ephemeral secret. " +
      "Set SESSION_SECRET (>= 16 chars) to keep sessions across restarts.",
  );
  return cachedSecret;
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
/* Identity generation (server-side only)                              */
/* ------------------------------------------------------------------ */

const NAME_PARTS: [string[], string[]] = [
  [
    "Crimson", "Azure", "Amber", "Sage", "Ivory",
    "Onyx", "Violet", "Cobalt", "Scarlet", "Teal",
  ],
  [
    "Falcon", "Otter", "Lynx", "Heron", "Badger",
    "Marten", "Osprey", "Viper", "Wolf", "Finch",
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

/** Create a fresh anonymous user + session (called by route handlers). */
export async function createSession(): Promise<SessionUser & { token: string }> {
  const userId = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({ id: userId, name: randomName(), color: randomColor() })
    .returning();

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: token, userId: user.id, expiresAt });

  return { sessionId: token, token, user: user! };
}

/**
 * Resolve the cookie to a verified user. Returns null for missing,
 * tampered, or expired sessions — callers decide 401 vs. auto-provision.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  const sep = raw.indexOf(".");
  if (sep <= 0) return null;
  const token = raw.slice(0, sep);
  const signature = raw.slice(sep + 1);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  if (!validSignature(token, signature, getSecret())) return null;

  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Sliding renewal keeps active collaborators logged in.
  if (row.session.expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db
      .update(sessions)
      .set({ expiresAt })
      .where(eq(sessions.id, token))
      .catch(() => undefined);
  }

  return { sessionId: token, user: row.user };
}

/** Cookie attributes applied by route handlers when issuing a session. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export function appUrl(): string {
  return process.env.APP_URL ?? "http://localhost:3000";
}
