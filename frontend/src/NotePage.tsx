import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type NoteDetail, type Team } from "./api";
import NoteEditor from "./NoteEditor";

type Load =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; message: string }
  | { state: "ready"; note: NoteDetail; teamName: string; personal: boolean };

export default function NotePage({ onSessionEnded }: { onSessionEnded: () => void }) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [title, setTitle] = useState("");
  const [savedTitle, setSavedTitle] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    setLost(false);
    setConfirmingDelete(false); // never carry a half-finished delete (or an old error) over to a different note
    setProblem(null);
    // The team name is only a label: if looking it up fails, the note should still open.
    Promise.all([api.note(id), api.teams().catch((): Team[] => [])])
      .then(([note, teams]: [NoteDetail, Team[]]) => {
        if (cancelled) return;
        setTitle(note.title);
        setSavedTitle(note.title);
        const owner = teams.find((t) => t.id === note.teamId);
        setLoad({ state: "ready", note, teamName: owner?.name ?? "", personal: owner?.personal ?? false });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return onSessionEnded();
        if (err instanceof ApiError && err.status === 404) return setLoad({ state: "missing" });
        setLoad({ state: "error", message: err instanceof Error ? err.message : "Could not load the note" });
      });
    return () => {
      cancelled = true;
    };
  }, [id, onSessionEnded]);

  const saveTitle = useCallback(async () => {
    const next = title.trim();
    if (!next || next === savedTitle) {
      setTitle(savedTitle); // an empty title is not allowed: put the old one back
      return;
    }
    try {
      const updated = await api.renameNote(id, next);
      setSavedTitle(updated.title);
      setTitle(updated.title);
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not rename the note");
      setTitle(savedTitle);
    }
  }, [id, title, savedTitle]);

  async function remove() {
    try {
      await api.deleteNote(id);
      navigate("/");
    } catch (err) {
      setConfirmingDelete(false);
      setProblem(err instanceof Error ? err.message : "Could not delete the note");
    }
  }

  const back = (
    <Link to="/" className="text-sm text-sky-400 hover:underline">
      ← All notes
    </Link>
  );

  if (load.state === "loading") return <p>Loading…</p>;
  if (load.state === "missing" || lost) {
    return (
      <div className="space-y-3">
        {back}
        <p role="alert" className="text-slate-300">
          This note was deleted, or you no longer have access to it.
        </p>
      </div>
    );
  }
  if (load.state === "error") {
    return (
      <div className="space-y-3">
        {back}
        <p role="alert" className="text-red-400">
          {load.message}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        {back}
        <span className="text-sm text-slate-400">{load.personal ? "🔒 Private: only you" : load.teamName}</span>
      </div>

      <input
        aria-label="Note title"
        className="w-full rounded bg-transparent text-2xl font-semibold outline-none focus:bg-slate-800 focus:ring-2 focus:ring-sky-500"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          // Enter while composing text (e.g. Japanese or Chinese input) only confirms the characters.
          if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
        }}
      />
      {problem && (
        <p role="alert" className="text-sm text-red-400">
          {problem}
        </p>
      )}

      <NoteEditor noteId={id} onAccessLost={() => setLost(true)} onSessionEnded={onSessionEnded} />

      <div className="border-t border-slate-700 pt-4">
        {confirmingDelete ? (
          <div className="flex items-center gap-3 text-sm">
            <span>{load.personal ? "Delete this private note?" : `Delete this note for everyone on ${load.teamName || "the team"}?`}</span>
            <button onClick={remove} className="rounded bg-red-600 px-3 py-1 hover:bg-red-500">
              Yes, delete
            </button>
            <button onClick={() => setConfirmingDelete(false)} className="rounded bg-slate-700 px-3 py-1 hover:bg-slate-600">
              Cancel
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmingDelete(true)} className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-red-700">
            Delete note
          </button>
        )}
      </div>
    </div>
  );
}
