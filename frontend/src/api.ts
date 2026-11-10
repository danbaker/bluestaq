export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export interface Team {
  id: number;
  name: string;
  role: "admin" | "member";
  /** The user's private space: only they can see notes in it. */
  personal: boolean;
}

/** A note as shown in the list (no full text). */
export interface NoteListItem {
  id: string;
  teamId: number;
  teamName: string;
  /** In the user's private space. */
  personal: boolean;
  title: string;
  preview: string;
  updatedAt: string;
}

export interface NoteDetail {
  id: string;
  teamId: number;
  title: string;
  updatedAt: string;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const api = {
  me: () => request<{ username: string }>("/api/auth/me"),
  login: (username: string, password: string) =>
    request<{ username: string }>("/api/auth/login", { method: "POST", ...json({ username, password }) }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  teams: () => request<Team[]>("/api/teams"),
  createTeam: (name: string) => request<Team>("/api/teams", { method: "POST", ...json({ name }) }),

  notes: () => request<NoteListItem[]>("/api/notes"),
  note: (id: string) => request<NoteDetail>(`/api/notes/${encodeURIComponent(id)}`),
  createNote: (teamId: number, title?: string) =>
    request<NoteDetail>(`/api/teams/${teamId}/notes`, { method: "POST", ...json(title ? { title } : {}) }),
  renameNote: (id: string, title: string) =>
    request<NoteDetail>(`/api/notes/${encodeURIComponent(id)}`, { method: "PATCH", ...json({ title }) }),
  deleteNote: (id: string) => request<void>(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
