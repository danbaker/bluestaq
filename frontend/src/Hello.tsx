import { useEffect, useState } from "react";
import { api } from "./api";

/** Protected content: calls the auth-required /api/hello endpoint. */
export default function Hello({ onLogout, onUnauthorized }: { onLogout: () => void; onUnauthorized: () => void }) {
  const [message, setMessage] = useState("Loading...");

  useEffect(() => {
    api
      .hello()
      .then((d) => setMessage(d.message))
      .catch((err) => {
        if (err?.status === 401) onUnauthorized();
        else setMessage("Backend unavailable");
      });
  }, [onUnauthorized]);

  return (
    <div className="space-y-4 text-center">
      <p className="text-2xl font-semibold">{message}</p>
      <button onClick={onLogout} className="rounded bg-slate-700 px-4 py-2 hover:bg-slate-600">
        Log out
      </button>
    </div>
  );
}
