import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import LoginForm from "./LoginForm";
import NotesPage from "./NotesPage";
import NotePage from "./NotePage";

type AuthState = { status: "checking" } | { status: "out" } | { status: "in"; username: string };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });

  useEffect(() => {
    api
      .me()
      .then((u) => setAuth({ status: "in", username: u.username }))
      .catch(() => setAuth({ status: "out" }));
  }, []);

  const signedOut = useCallback(() => setAuth({ status: "out" }), []);
  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setAuth({ status: "out" });
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="border-b border-slate-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-xl font-bold">
            Bluestaq
          </Link>
          {auth.status === "in" && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-slate-400">{auth.username}</span>
              <button onClick={logout} className="rounded bg-slate-700 px-3 py-1 hover:bg-slate-600">
                Log out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        {auth.status === "checking" && <p>Loading…</p>}
        {auth.status === "out" && (
          <div className="flex justify-center">
            <LoginForm onLogin={(username) => setAuth({ status: "in", username })} />
          </div>
        )}
        {auth.status === "in" && (
          <Routes>
            <Route path="/" element={<NotesPage onSessionEnded={signedOut} />} />
            <Route path="/notes/:id" element={<NotePage onSessionEnded={signedOut} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
