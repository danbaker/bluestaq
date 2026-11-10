import type { RequestHandler } from "express";
import type { Role, TeamRepository } from "../repositories/teamRepository.js";

declare module "express-serve-static-core" {
  interface Request {
    membership?: { teamId: number; role: Role; personal: boolean };
  }
}

/** Parses a positive integer id from a route param; returns null if malformed. */
export function parseId(value: unknown): number | null {
  return typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null;
}

export function userIdOf(req: { session?: { sub: string } }): number {
  return Number(req.session!.sub);
}

/** Requires the logged-in user to be on :id's team. Non-members get 404 so team ids don't leak. */
export function requireTeamMember(teams: TeamRepository): RequestHandler {
  return async (req, res, next) => {
    const teamId = parseId(req.params.id);
    const membership = teamId ? await teams.getMembership(teamId, userIdOf(req)) : null;
    if (!teamId || !membership) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    req.membership = { teamId, role: membership.role, personal: membership.personal };
    next();
  };
}

/** Use after requireTeamMember. */
export const requireTeamAdmin: RequestHandler = (req, res, next) => {
  if (req.membership?.role !== "admin") {
    res.status(403).json({ error: "Team admin required" });
    return;
  }
  next();
};

/** Use after requireTeamMember. A private space can't be shared or changed. */
export const rejectPrivateSpace: RequestHandler = (req, res, next) => {
  if (req.membership?.personal) {
    res.status(403).json({ error: "This is your private space; it can't be shared or changed" });
    return;
  }
  next();
};
