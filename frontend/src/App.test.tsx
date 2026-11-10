import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, expect, vi } from "vitest";
import App from "./App";

type Handler = (init?: RequestInit) => { status?: number; body?: unknown };

/** Stub fetch with per-path handlers. Unknown paths fail the test loudly. */
function mockApi(routes: Record<string, Handler>) {
  const fn = vi.fn(async (path: string, init?: RequestInit) => {
    const h = routes[path];
    if (!h) throw new Error(`Unexpected fetch ${path}`);
    const { status = 200, body = {} } = h(init);
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("shows the index page with login form when logged out", async () => {
    mockApi({ "/api/auth/me": () => ({ status: 401, body: { error: "Unauthorized" } }) });
    render(<App />);
    expect(screen.getByRole("heading", { name: "Bluestaq" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows hello message when already logged in", async () => {
    mockApi({
      "/api/auth/me": () => ({ body: { username: "admin" } }),
      "/api/hello": () => ({ body: { message: "Hello, admin!" } }),
    });
    render(<App />);
    expect(await screen.findByText("Hello, admin!")).toBeInTheDocument();
  });

  it("logs in through the form and then loads hello", async () => {
    const fetchMock = mockApi({
      "/api/auth/me": () => ({ status: 401 }),
      "/api/auth/login": () => ({ body: { username: "admin" } }),
      "/api/hello": () => ({ body: { message: "Hello, admin!" } }),
    });
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "admin123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Hello, admin!")).toBeInTheDocument();
    const loginCall = fetchMock.mock.calls.find(([p]) => p === "/api/auth/login")!;
    expect(JSON.parse(loginCall[1]!.body as string)).toEqual({ username: "admin", password: "admin123" });
    expect(loginCall[1]).toMatchObject({ method: "POST", credentials: "include" });
  });

  it("shows an error on bad credentials and stays on the form", async () => {
    mockApi({
      "/api/auth/me": () => ({ status: 401 }),
      "/api/auth/login": () => ({ status: 401, body: { error: "Invalid credentials" } }),
    });
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("logs out and returns to the login form", async () => {
    mockApi({
      "/api/auth/me": () => ({ body: { username: "admin" } }),
      "/api/hello": () => ({ body: { message: "Hello, admin!" } }),
      "/api/auth/logout": () => ({ status: 204 }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("returns to login if hello comes back 401 (expired session)", async () => {
    mockApi({
      "/api/auth/me": () => ({ body: { username: "admin" } }),
      "/api/hello": () => ({ status: 401, body: { error: "Unauthorized" } }),
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
