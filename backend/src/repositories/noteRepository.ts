import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";

export interface Note {
  id: string;
  teamId: number;
  title: string;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface NoteSummary extends Note {
  preview: string;
}
export interface NoteDetail extends Note {
  text: string;
}

interface NoteRow {
  id: string;
  team_id: number;
  title: string;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  preview?: string;
  text?: string;
}

export const PREVIEW_LENGTH = 200;

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  teamId: r.team_id,
  title: r.title,
  createdBy: r.created_by,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

const BASE = "id, team_id, title, created_by, created_at, updated_at";

export function createNoteRepository(db: Db) {
  return {
    async create(teamId: number, title: string, createdBy: number): Promise<NoteDetail> {
      const { rows } = await db.query<NoteRow>(
        `INSERT INTO notes (id, team_id, title, created_by) VALUES ($1, $2, $3, $4) RETURNING ${BASE}, text`,
        [randomUUID(), teamId, title, createdBy],
      );
      return { ...toNote(rows[0]), text: rows[0].text ?? "" };
    },

    /** Newest-updated first. */
    async listByTeam(teamId: number): Promise<NoteSummary[]> {
      const { rows } = await db.query<NoteRow>(
        `SELECT ${BASE}, substring(text from 1 for ${PREVIEW_LENGTH}) AS preview
           FROM notes WHERE team_id = $1
          ORDER BY updated_at DESC, id`,
        [teamId],
      );
      return rows.map((r) => ({ ...toNote(r), preview: r.preview ?? "" }));
    },

    async findById(id: string): Promise<NoteDetail | null> {
      const { rows } = await db.query<NoteRow>(`SELECT ${BASE}, text FROM notes WHERE id = $1`, [id]);
      return rows[0] ? { ...toNote(rows[0]), text: rows[0].text ?? "" } : null;
    },

    async rename(id: string, title: string): Promise<NoteDetail | null> {
      const { rows } = await db.query<NoteRow>(
        `UPDATE notes SET title = $2, updated_at = now() WHERE id = $1 RETURNING ${BASE}, text`,
        [id, title],
      );
      return rows[0] ? { ...toNote(rows[0]), text: rows[0].text ?? "" } : null;
    },

    /** Returns true if a note was deleted. */
    async delete(id: string): Promise<boolean> {
      const { rowCount } = await db.query("DELETE FROM notes WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },
  };
}

export type NoteRepository = ReturnType<typeof createNoteRepository>;
