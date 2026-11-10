import { Router } from "express";
import type { TeamRepository, Role } from "../repositories/teamRepository.js";
import type { UserRepository } from "../repositories/userRepository.js";
import { parseId, requireTeamAdmin, requireTeamMember, userIdOf } from "./middleware.js";

const isDuplicate = (err: unknown) => (err as { code?: string })?.code === "23505";

/** Mount behind requireAuth. */
export function createTeamRouter({ teams, users }: { teams: TeamRepository; users: UserRepository }): Router {
  const router = Router();
  const member = requireTeamMember(teams);

  router.get("/", async (req, res) => {
    res.json(await teams.listForUser(userIdOf(req)));
  });

  router.post("/", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 100) {
      res.status(400).json({ error: "name is required (max 100 characters)" });
      return;
    }
    res.status(201).json(await teams.create(name, userIdOf(req)));
  });

  router.get("/:id/members", member, async (req, res) => {
    res.json(await teams.listMembers(req.membership!.teamId));
  });

  router.post("/:id/members", member, requireTeamAdmin, async (req, res) => {
    const { username, role = "member" } = req.body ?? {};
    if (typeof username !== "string" || !username || (role !== "member" && role !== "admin")) {
      res.status(400).json({ error: "username and a role of 'member' or 'admin' are required" });
      return;
    }
    const user = await users.findByUsername(username);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    try {
      await teams.addMember(req.membership!.teamId, user.id, role as Role);
    } catch (err) {
      if (isDuplicate(err)) {
        res.status(409).json({ error: "User is already a member" });
        return;
      }
      throw err;
    }
    res.status(201).json({ userId: user.id, username: user.username, role });
  });

  router.patch("/:id/members/:userId", member, requireTeamAdmin, async (req, res) => {
    const targetId = parseId(req.params.userId);
    const role = req.body?.role;
    if (role !== "member" && role !== "admin") {
      res.status(400).json({ error: "role must be 'member' or 'admin'" });
      return;
    }
    const result = targetId ? await teams.setRole(req.membership!.teamId, targetId, role) : "not_found";
    if (result === "not_found") {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (result === "last_admin") {
      res.status(409).json({ error: "Cannot demote the last admin" });
      return;
    }
    res.json({ userId: targetId, role });
  });

  // Admins can remove anyone; any member can remove themselves (leave).
  router.delete("/:id/members/:userId", member, async (req, res) => {
    const { teamId, role } = req.membership!;
    const targetId = parseId(req.params.userId);
    if (!targetId) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (targetId !== userIdOf(req) && role !== "admin") {
      res.status(403).json({ error: "Team admin required" });
      return;
    }
    const result = await teams.removeMember(teamId, targetId);
    if (result === "not_found") {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (result === "last_admin") {
      res.status(409).json({ error: "Cannot remove the last admin" });
      return;
    }
    res.status(204).end();
  });

  return router;
}
