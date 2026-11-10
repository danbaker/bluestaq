import { Router } from "express";
import bcrypt from "bcryptjs";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "../config.js";
import type { UserRepository } from "../repositories/userRepository.js";
import { signSession } from "./jwt.js";
import { requireAuth } from "./middleware.js";

// Compared against when the user doesn't exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10);

export interface AuthOptions {
  users: UserRepository;
  jwtSecret: string;
  secureCookie: boolean;
}

export function createAuthRouter({ users, jwtSecret, secureCookie }: AuthOptions): Router {
  const router = Router();

  router.post("/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }
    const user = await users.findByUsername(username);
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    res.cookie(SESSION_COOKIE, signSession(jwtSecret, user), {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie,
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
    res.json({ username: user.username });
  });

  router.post("/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: secureCookie });
    res.status(204).end();
  });

  router.get("/me", requireAuth(jwtSecret), (req, res) => {
    res.json({ username: req.session!.username });
  });

  return router;
}
