import { useState, type FormEvent } from "react";
import { api } from "./api";

export default function LoginForm({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api.login(username, password);
      onLogin(user.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg bg-slate-800 p-6 shadow-lg">
      <h2 className="text-xl font-semibold">Sign in</h2>
      <label className="block text-sm">
        Username
        <input
          className="mt-1 w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-sky-500"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
      </label>
      <label className="block text-sm">
        Password
        <input
          type="password"
          className="mt-1 w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-sky-500"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-sky-600 px-4 py-2 font-medium hover:bg-sky-500 disabled:opacity-50"
      >
        {busy ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
