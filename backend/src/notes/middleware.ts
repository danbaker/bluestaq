import type { RequestHandler } from "express";
import type { NoteDetail, NoteRepository } from "../repositories/noteRepository.js";
import type { TeamRepository } from "../repositories/teamRepository.js";
import { userIdOf } from "../teams/middleware.js";

declare module "express-serve-static-core" {
  interface Request {
    note?: NoteDetail;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/**
 * Loads :id as a note and requires the user to be on its team.
 * Malformed ids, missing notes, and notes on other teams all look the same: 404.
 */
export function requireNoteAccess(notes: NoteRepository, teams: TeamRepository): RequestHandler {
  return async (req, res, next) => {
    const note = isUuid(req.params.id) ? await notes.findById(req.params.id) : null;
    const role = note ? await teams.getRole(note.teamId, userIdOf(req)) : null;
    if (!note || !role) {
      res.status(404).json({ error: "Note not found" });
      return;
    }
    req.note = note;
    next();
  };
}
