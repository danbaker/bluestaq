import { Router } from "express";
import type { NoteRepository } from "../repositories/noteRepository.js";
import type { TeamRepository } from "../repositories/teamRepository.js";
import type { RealtimeControl } from "../realtime/control.js";
import { userIdOf } from "../teams/middleware.js";
import { requireNoteAccess } from "./middleware.js";

const MAX_TITLE = 200;

/** Returns a trimmed title, "Untitled" if omitted, or null if invalid. */
function parseTitle(value: unknown, { required }: { required: boolean }): string | null {
  if (value === undefined && !required) return "Untitled";
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (Array.from(title).length > MAX_TITLE || (required && !title)) return null;
  return title || "Untitled";
}

const TITLE_ERROR = `title must be a string of at most ${MAX_TITLE} characters`;

/** Mount at /api/teams/:id/notes, behind requireAuth + requireTeamMember. */
export function createTeamNotesRouter({ notes }: { notes: NoteRepository }): Router {
  const router = Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    res.json(await notes.listByTeam(req.membership!.teamId));
  });

  router.post("/", async (req, res) => {
    const title = parseTitle(req.body?.title, { required: false });
    if (title === null) {
      res.status(400).json({ error: TITLE_ERROR });
      return;
    }
    res.status(201).json(await notes.create(req.membership!.teamId, title, userIdOf(req)));
  });

  return router;
}

/** Mount at /api/notes, behind requireAuth. */
export function createNoteRouter({
  notes,
  teams,
  realtime,
}: {
  notes: NoteRepository;
  teams: TeamRepository;
  realtime: RealtimeControl;
}): Router {
  const router = Router();
  const access = requireNoteAccess(notes, teams);

  // Everything the user can see, across all their teams (for a "my notes" page).
  router.get("/", async (req, res) => {
    res.json(await notes.listForUser(userIdOf(req)));
  });

  router.get("/:id", access, (req, res) => {
    res.json(req.note);
  });

  // Who has the note open right now (one entry per user, with their tab count).
  router.get("/:id/presence", access, (req, res) => {
    res.json(realtime.presence(req.note!.id));
  });

  router.patch("/:id", access, async (req, res) => {
    const title = parseTitle(req.body?.title, { required: true });
    if (title === null) {
      res.status(400).json({ error: TITLE_ERROR });
      return;
    }
    const updated = await notes.rename(req.note!.id, title);
    if (!updated) {
      res.status(404).json({ error: "Note not found" }); // deleted since we loaded it
      return;
    }
    res.json(updated);
  });

  // Any team member may delete a note.
  router.delete("/:id", access, async (req, res) => {
    if (!(await notes.delete(req.note!.id))) {
      res.status(404).json({ error: "Note not found" }); // someone else deleted it first
      return;
    }
    realtime.closeNote(req.note!.id); // everyone editing it is disconnected
    res.status(204).end();
  });

  return router;
}
