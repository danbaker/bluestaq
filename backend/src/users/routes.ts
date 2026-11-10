import { Router } from "express";
import bcrypt from "bcryptjs";
import type { UserRepository } from "../repositories/userRepository.js";
import { userIdOf } from "../teams/middleware.js";

const isDuplicate = (err: unknown) => (err as { code?: string })?.code === "23505";

/** Mount behind requireAuth. There is no public signup: only a site admin (users.is_admin) creates users. */
export function createUserRouter({ users }: { users: UserRepository }): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const caller = await users.findById(userIdOf(req));
    if (!caller?.isAdmin) {
      res.status(403).json({ error: "Site admin required" });
      return;
    }
    const { username, password } = req.body ?? {};
    if (
      typeof username !== "string" ||
      !/^[A-Za-z0-9_.-]{1,50}$/.test(username) ||
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 200
    ) {
      res.status(400).json({ error: "username (letters, digits, _ . -) and a password of 8+ characters are required" });
      return;
    }
    try {
      const user = await users.create(username, await bcrypt.hash(password, 10));
      res.status(201).json({ id: user.id, username: user.username });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      res.status(409).json({ error: "Username already taken" });
    }
  });

  return router;
}
