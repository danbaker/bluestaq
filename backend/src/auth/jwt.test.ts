import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { signSession, verifySession } from "./jwt.js";

describe("jwt", () => {
  it("round-trips a session", () => {
    const token = signSession("s", { id: 7, username: "dan" });
    const session = verifySession("s", token);
    expect(session).toEqual({ sub: "7", username: "dan", exp: expect.any(Number) });
    expect(session!.exp * 1000).toBeGreaterThan(Date.now() + 23 * 3600 * 1000); // ~24h from now
  });

  it("expires after 24 hours", () => {
    const token = signSession("s", { id: 1, username: "a" });
    const p = jwt.decode(token) as { iat: number; exp: number };
    expect(p.exp - p.iat).toBe(24 * 60 * 60);
  });

  it("rejects wrong secret, garbage, and expired tokens", () => {
    const token = signSession("s", { id: 1, username: "a" });
    expect(verifySession("other", token)).toBeNull();
    expect(verifySession("s", "garbage")).toBeNull();
    const expired = jwt.sign({ username: "a" }, "s", { subject: "1", expiresIn: -10 });
    expect(verifySession("s", expired)).toBeNull();
  });
});
