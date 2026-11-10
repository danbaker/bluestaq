import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, it, expect, vi } from "vitest";
import App from "./App";
import { mockApi, team } from "./testUtils";

afterEach(() => vi.unstubAllGlobals());

const renderApp = (path = "/") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

describe("App", () => {
  it("shows the index page with a login form when logged out", async () => {
    mockApi({ "GET /api/auth/me": { status: 401, body: { error: "Unauthorized" } } });
    renderApp();
    expect(screen.getByRole("link", { name: "Bluestaq" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });

  it("a logged-out visitor to a note URL is asked to sign in, not shown the note", async () => {
    const fetchMock = mockApi({ "GET /api/auth/me": { status: 401 } });
    renderApp("/notes/abc");
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([p]) => p)).toEqual(["/api/auth/me"]);
  });

  it("signs in through the form and lands on the notes list", async () => {
    mockApi({
      "GET /api/auth/me": { status: 401 },
      "POST /api/auth/login": { body: { username: "admin" } },
      "GET /api/teams": { body: [team(1, "Alpha")] },
      "GET /api/notes": { body: [] },
    });
    renderApp();
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Your notes" })).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("shows the notes list when already signed in, and logs out back to the form", async () => {
    mockApi({
      "GET /api/auth/me": { body: { username: "admin" } },
      "GET /api/teams": { body: [] },
      "GET /api/notes": { body: [] },
      "POST /api/auth/logout": { status: 204 },
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("an unknown URL goes to the notes list", async () => {
    mockApi({
      "GET /api/auth/me": { body: { username: "admin" } },
      "GET /api/teams": { body: [] },
      "GET /api/notes": { body: [] },
    });
    renderApp("/nonsense/path");
    expect(await screen.findByRole("heading", { name: "Your notes" })).toBeInTheDocument();
  });

  it("goes back to the login form when a page finds the session has ended", async () => {
    mockApi({
      "GET /api/auth/me": { body: { username: "admin" } },
      "GET /api/teams": { status: 401, body: { error: "Unauthorized" } },
      "GET /api/notes": { status: 401, body: { error: "Unauthorized" } },
    });
    renderApp();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
