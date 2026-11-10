import { vi } from "vitest";

export interface Reply {
  status?: number;
  body?: unknown;
}
type Handler = Reply | ((req: { body: unknown }) => Reply);

/**
 * Fakes fetch. Routes are keyed "METHOD /path". Any request without a route fails the test loudly,
 * so a page can't quietly call an endpoint the test didn't expect. Returns the mock to inspect calls.
 */
export function mockApi(routes: Record<string, Handler>) {
  const fn = vi.fn(async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${path}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected request: ${key}`);
    const { status = 200, body = {} } = typeof handler === "function" ? handler({ body: init?.body ? JSON.parse(String(init.body)) : undefined }) : handler;
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The parsed JSON bodies of every call to "METHOD /path". */
export function bodiesOf(fn: ReturnType<typeof mockApi>, key: string): unknown[] {
  return fn.mock.calls
    .filter(([path, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${path}` === key)
    .map(([, init]) => ((init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined));
}

export const calledWith = (fn: ReturnType<typeof mockApi>, key: string) => bodiesOf(fn, key).length > 0;

export const team = (id: number, name: string, role: "admin" | "member" = "member", personal = false) => ({ id, name, role, personal });
export const privateSpace = (id: number) => team(id, "Private", "admin", true);
export const listNote = (id: string, teamId: number, teamName: string, title: string, preview = "", personal = false) => ({
  id,
  teamId,
  teamName,
  personal,
  title,
  preview,
  updatedAt: "2026-11-10T12:00:00.000Z",
});
