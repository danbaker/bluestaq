import type { RequestHandler } from "express";
import { SESSION_COOKIE } from "../config.js";
import { verifySession, type SessionPayload } from "./jwt.js";

declare module "express-serve-static-core" {
  interface Request {
    session?: SessionPayload;
  }
}

export function requireAuth(secret: string): RequestHandler {
  return (req, res, next) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const session = typeof token === "string" ? verifySession(secret, token) : null;
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.session = session;
    next();
  };
}
