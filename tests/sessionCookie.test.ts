import { afterEach, describe, expect, it, vi } from "vitest";
import {
  serializeSessionCookie,
  sessionCookieOptions,
  signToken,
  validSignature,
} from "@/lib/session";

const SECRET = "test-secret-value-with-32-bytes!!";
const TOKEN = "a".repeat(64);
const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  SESSION_COOKIE_SECURE: process.env.SESSION_COOKIE_SECURE,
  SESSION_COOKIE_SAMESITE: process.env.SESSION_COOKIE_SAMESITE,
  SESSION_COOKIE_PARTITIONED: process.env.SESSION_COOKIE_PARTITIONED,
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("session cookie signing", () => {
  it("round-trips a valid signature", () => {
    const signature = signToken(TOKEN, SECRET);
    expect(validSignature(TOKEN, signature, SECRET)).toBe(true);
  });

  it("rejects a tampered token", () => {
    const signature = signToken(TOKEN, SECRET);
    const tampered = `b${TOKEN.slice(1)}`;
    expect(validSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const signature = signToken(TOKEN, SECRET);
    const flip = signature.endsWith("A")
      ? `${signature.slice(0, -1)}B`
      : `${signature.slice(0, -1)}A`;
    expect(validSignature(TOKEN, flip, SECRET)).toBe(false);
  });

  it("rejects a signature from a different secret", () => {
    const signature = signToken(TOKEN, "another-secret-32-bytes-xxxxxxx");
    expect(validSignature(TOKEN, signature, SECRET)).toBe(false);
  });

  it("serializes as token.signature", () => {
    const serialized = serializeSessionCookie(TOKEN, SECRET);
    const [token, signature] = serialized.split(".");
    expect(token).toBe(TOKEN);
    expect(signature).toBe(signToken(TOKEN, SECRET));
    expect(validSignature(token!, signature!, SECRET)).toBe(true);
  });

  it("handles length-mismatched comparisons without throwing", () => {
    expect(validSignature(TOKEN, "short", SECRET)).toBe(false);
  });
});

describe("session cookie defaults", () => {
  it("uses Secure + SameSite=Lax without Partitioned for top-level production by default", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SESSION_COOKIE_SECURE;
    delete process.env.SESSION_COOKIE_SAMESITE;
    delete process.env.SESSION_COOKIE_PARTITIONED;

    expect(sessionCookieOptions()).toMatchObject({
      secure: true,
      sameSite: "lax",
      partitioned: false,
      httpOnly: true,
    });
  });

  it("keeps explicit embedded/partitioned cookie overrides available", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SESSION_COOKIE_SECURE = "true";
    process.env.SESSION_COOKIE_SAMESITE = "none";
    process.env.SESSION_COOKIE_PARTITIONED = "true";

    expect(sessionCookieOptions()).toMatchObject({
      secure: true,
      sameSite: "none",
      partitioned: true,
    });
  });
});
