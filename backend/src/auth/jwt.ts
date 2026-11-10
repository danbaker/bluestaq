import jwt from "jsonwebtoken";
import { SESSION_TTL_SECONDS } from "../config.js";

export interface SessionPayload {
  sub: string; // user id
  username: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

export function signSession(secret: string, user: { id: number; username: string }): string {
  return jwt.sign({ username: user.username }, secret, {
    subject: String(user.id),
    expiresIn: SESSION_TTL_SECONDS,
    algorithm: "HS256",
  });
}

/** Returns the payload, or null if the token is invalid or expired. */
export function verifySession(secret: string, token: string): SessionPayload | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (typeof payload === "string" || !payload.sub || typeof payload.username !== "string") return null;
    if (typeof payload.exp !== "number") return null;
    return { sub: payload.sub, username: payload.username, exp: payload.exp };
  } catch {
    return null;
  }
}
