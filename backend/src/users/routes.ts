import { Router } from "express";
import bcrypt from "bcryptjs";
import type { TeamRepository } from "../repositories/teamRepository.js";
import type { UserRepository } from "../repositories/userRepository.js";
import { userIdOf } from "../teams/middleware.js";

const isDuplicate = (err: unknown) => (err as { code?: string })?.code === "23505";

/** Mount behind requireAuth. There is no public signup: only a site admin (users.is_admin) creates users. */
export function createUserRouter({ users, teams }: { users: UserRepository; teams: TeamRepository }): Router {
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
    let user;
    try {
      user = await users.create(username, await bcrypt.hash(password, 10));
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      res.status(409).json({ error: "Username already taken" });
      return;
    }
    try {
      await teams.ensurePersonalTeam(user.id); // their private space for private notes
    } catch (err) {
      // The account exists, so report success; the space is created at their first login or the next start.
      console.error(`Could not create the private space for new user ${user.id}`, err);
    }
    res.status(201).json({ id: user.id, username: user.username });
  });

  return router;
}
