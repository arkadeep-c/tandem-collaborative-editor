import { describe, expect, it } from "vitest";
import {
  serializeSessionCookie,
  signToken,
  validSignature,
} from "@/lib/session";

const SECRET = "test-secret-value-with-32-bytes!!";
const TOKEN = "a".repeat(64);

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
