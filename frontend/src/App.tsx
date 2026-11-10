import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import LoginForm from "./LoginForm";
import Hello from "./Hello";

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
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-slate-900 p-4 text-white">
      <h1 className="text-3xl font-bold">Bluestaq</h1>
      {auth.status === "checking" && <p>Loading...</p>}
      {auth.status === "out" && (
        <LoginForm onLogin={(username) => setAuth({ status: "in", username })} />
      )}
      {auth.status === "in" && <Hello onLogout={logout} onUnauthorized={signedOut} />}
    </main>
  );
}
