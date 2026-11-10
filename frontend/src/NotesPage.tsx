import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, type NoteListItem, type Team } from "./api";

export default function NotesPage({ onSessionEnded }: { onSessionEnded: () => void }) {
  const navigate = useNavigate();
  const [data, setData] = useState<{ teams: Team[]; notes: NoteListItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState("");
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return onSessionEnded();
      setError(err instanceof Error ? err.message : "Something went wrong");
    },
    [onSessionEnded],
  );

  const refresh = useCallback(async () => {
    try {
      const [teams, notes] = await Promise.all([api.teams(), api.notes()]);
      setData({ teams, notes });
      setError(null);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addNote(teamId: number) {
    setBusy(true);
    try {
      const note = await api.createNote(teamId);
      navigate(`/notes/${note.id}`);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  async function addTeam(e: FormEvent) {
    e.preventDefault();
    const name = newTeam.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.createTeam(name);
      setNewTeam("");
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return error ? (
      <div className="space-y-3">
        <p role="alert" className="text-red-400">
          {error}
        </p>
        <button onClick={() => void refresh()} className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600">
          Try again
        </button>
      </div>
    ) : (
      <p>Loading…</p>
    );
  }

  const teams = [...data.teams].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return (
    <div className="space-y-8">
      <h2 className="text-2xl font-semibold">Your notes</h2>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      {teams.length === 0 && <p className="text-slate-300">You are not on a team yet. Create one below to start taking notes.</p>}

      {teams.map((team) => {
        const notes = data.notes.filter((n) => n.teamId === team.id);
        return (
          <section key={team.id} aria-label={team.name} className="space-y-2">
            <div className="flex items-center justify-between border-b border-slate-700 pb-1">
              <h3 className="text-lg font-medium">{team.name}</h3>
              <button
                onClick={() => addNote(team.id)}
                disabled={busy}
                className="rounded bg-sky-600 px-3 py-1 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
              >
                New note
              </button>
            </div>
            {notes.length === 0 ? (
              <p className="text-sm text-slate-400">No notes yet.</p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {notes.map((note) => (
                  <li key={note.id}>
                    <Link to={`/notes/${note.id}`} className="block rounded px-2 py-2 hover:bg-slate-800">
                      <span className="font-medium">{note.title}</span>
                      {note.preview && <span className="mt-0.5 block truncate text-sm text-slate-400">{note.preview}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <form onSubmit={addTeam} className="flex gap-2 border-t border-slate-700 pt-4">
        <input
          aria-label="New team name"
          placeholder="New team name"
          value={newTeam}
          maxLength={100}
          onChange={(e) => setNewTeam(e.target.value)}
          className="flex-1 rounded bg-slate-800 px-3 py-2 outline-none focus:ring-2 focus:ring-sky-500"
        />
        <button type="submit" disabled={busy || !newTeam.trim()} className="rounded bg-slate-700 px-4 py-2 hover:bg-slate-600 disabled:opacity-50">
          Create team
        </button>
      </form>
    </div>
  );
}
